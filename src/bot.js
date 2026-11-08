import { createBinance, createPaper } from './binance.js';
import { bestSwing, periodOf, simulate } from './simulate.js';
import { modeOf } from './store.js';
import { DEFAULTS, addSample, applyBuyback, applyRebase, applySell, levels, newPosition, nextAction, stopLossLine } from './strategy.js';

// The bot: every few seconds it reads the prices, asks the plan (strategy.js) what to do for each
// coin and sends that order to Binance (or the paper account). Each mode (paper / testnet / live)
// keeps its own positions and trades, so trying things on paper never touches the real plan.

const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD']);
// the well-known coins the test wallet and "the best of the last 3 months" are picked from
export const KNOWN_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX', 'LTC', 'DOT'];
// over 3 months, not 1: a month of a falling market has every coin losing, and the ranking would name no earner
const RANK_DAYS = 90;
const SEED_VERSION = 4; // a test wallet seeded by an earlier rule is seeded again once (4: profit + cycles, best of 10/12/15%)
const RANK_MS = 6 * 3_600_000; // the ranking is worked out again after this
const CLOSES_MS = 15 * 60_000; // past prices are asked for again after this
// the test wallet: the 3 coins the plan did best with over the last 3 months, 300 USDT each; 100 USDT stays spare
export const TEST_WALLET = Object.freeze({ coins: 3, usdtEach: 300 });
const SEED_RETRY_MS = 5 * 60_000;
const BALANCE_MS = 30_000;
const HISTORY_MS = 5 * 60_000;
const BLOCKED_RETRY_MS = 5 * 60_000; // a buy-back that could not be paid for is tried again after this
const KEEP_TRADES = 500;
const KEEP_EVENTS = 60;

export function createBot({ settings, state, history, log = console, now = () => Date.now(), makeExchange = null, makePublic = null }) {
  let publicMarket = null; // Binance's live prices for simulations, whatever the mode
  const pub = () => (publicMarket ??= makePublic ? makePublic() : createBinance({}));
  const closesKept = new Map(); // `${pair}|${days}` -> { at, prices }
  let rank = null; // { at, days, swingPct, rebaseCycles, list: [{ asset, endPct, holdPct, cycles }] }
  let ranking = null; // the ranking being worked out
  let seeding = false;
  let seedError = null;
  let seedRetryAt = 0;
  const book = (mode = modeOf(settings.get())) => {
    const b = (state.data.books ??= {});
    return (b[mode] ??= { positions: {}, trades: [], samples: {}, events: [] });
  };
  let exchange = null;
  let exchangeKey = null;
  let prices = {};
  let balances = {};
  let balancesAt = 0;
  let historyAt = 0;
  let lastTickAt = null;
  let lastError = null;
  let waitUntil = 0;
  let timer = null;
  let queue = Promise.resolve();

  // one thing at a time: the loop and the panel's buttons never send orders over each other
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function ex() {
    const s = settings.get();
    const key = `${modeOf(s)}|${s.binanceKey}|${s.testnet}`;
    if (key !== exchangeKey) {
      exchangeKey = key;
      const mode = modeOf(s);
      if (makeExchange) exchange = makeExchange(mode, s);
      else if (mode === 'paper') {
        const b = book('paper');
        b.paper ??= { balances: { [DEFAULTS.quote]: DEFAULTS.paperStartUsdt } };
        exchange = createPaper({ book: b.paper, save: state.save, feePct: DEFAULTS.paperFeePct });
      } else exchange = createBinance({ apiKey: s.binanceKey, apiSecret: s.binanceSecret, testnet: s.testnet });
      prices = {};
      balances = {};
      balancesAt = 0;
    }
    return exchange;
  }

  function event(kind, text) {
    const b = book();
    b.events = [{ t: now(), kind, text }, ...(b.events ?? [])].slice(0, KEEP_EVENTS);
    log.info?.(`[${kind}] ${text}`);
  }
  function trade(t) {
    const b = book();
    b.trades = [{ t: now(), mode: modeOf(settings.get()), ...t }, ...b.trades].slice(0, KEEP_TRADES);
  }
  const fmt = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });

  async function refreshBalances(force = false) {
    if (!force && now() - balancesAt < BALANCE_MS) return;
    balances = await ex().balances();
    balancesAt = now();
  }

  function usdOf(asset, amount) {
    if (asset === DEFAULTS.quote) return amount;
    const p = prices[`${asset}${DEFAULTS.quote}`];
    if (p > 0) return amount * p;
    return STABLE.has(asset) ? amount : null;
  }
  function totals() {
    const assets = Object.entries(balances).map(([asset, amount]) => ({ asset, amount, price: asset === DEFAULTS.quote ? 1 : prices[`${asset}${DEFAULTS.quote}`] ?? null, usd: usdOf(asset, amount) }));
    const total = assets.reduce((a, x) => a + (x.usd ?? 0), 0);
    for (const x of assets) x.pct = total > 0 && x.usd != null ? (x.usd / total) * 100 : null;
    assets.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    return { total, assets };
  }

  // the plan's step for one coin at the price now; at most a few orders a look
  async function step(pos, price) {
    const s = settings.get();
    const b = book();
    // the stop-loss first: a fall of stopLossPct within stopLossHours, seen on stopLossChecks looks in a row
    b.samples[pos.asset] = addSample(b.samples[pos.asset] ?? [], price, now(), DEFAULTS.stopLossHours);
    const sl = stopLossLine(b.samples[pos.asset], now(), DEFAULTS);
    pos.stopStrikes = sl && price <= sl.line ? (pos.stopStrikes ?? 0) + 1 : 0;
    if (pos.stopStrikes >= DEFAULTS.stopLossChecks && pos.qty > 0) {
      await refreshBalances(true);
      const fill = await ex().marketSell(pos.pair, Math.min(pos.qty, balances[pos.asset] ?? pos.qty));
      pos.qty = Math.max(0, pos.qty - fill.qty);
      pos.stopped = { at: now(), price: fill.price, ref: sl.ref, usdt: fill.usdt };
      pos.lots = [];
      trade({ asset: pos.asset, side: 'sell', kind: 'stop-loss', qty: fill.qty, price: fill.price, usdt: fill.usdt });
      event('stop', `Stop-loss: ${pos.asset} fell ${DEFAULTS.stopLossPct}% within ${DEFAULTS.stopLossHours} h ($${fmt(sl.ref, 6)} → $${fmt(price, 6)}). Sold ${fmt(fill.qty, 6)} ${pos.asset} for ${fmt(fill.usdt)} USDT; the plan stopped for it.`);
      return;
    }
    const f = await ex().info(pos.pair);
    for (let i = 0; i < 3; i++) {
      const a = nextAction(pos, price, { swingPct: s.swingPct, rebaseCycles: s.rebaseCycles, minNotional: f.minNotional });
      if (!a) return;
      if (a.type === 'sell') {
        await refreshBalances(true);
        const fill = await ex().marketSell(pos.pair, Math.min(a.qty, balances[pos.asset] ?? a.qty));
        const lot = applySell(pos, fill, s.swingPct, now());
        trade({ asset: pos.asset, side: 'sell', kind: 'swing', qty: fill.qty, price: fill.price, usdt: fill.usdt });
        event('sell', `Sold ${fmt(fill.qty, 6)} ${pos.asset} at $${fmt(fill.price, 6)} (+${s.swingPct}% over the base) for ${fmt(fill.usdt)} USDT; buys back at $${fmt(lot.buyAt, 6)}.`);
      } else if (a.type === 'buyback') {
        const lot = pos.lots.find((l) => l.id === a.lotId);
        if (lot.blockedAt && now() - lot.blockedAt < BLOCKED_RETRY_MS) return;
        await refreshBalances(true);
        const usdt = Math.min(a.usdt, balances[DEFAULTS.quote] ?? 0);
        if (usdt < f.minNotional) {
          lot.blockedAt = now();
          event('error', `${pos.asset}: the buy-back needs ${fmt(a.usdt)} USDT, the account has ${fmt(balances[DEFAULTS.quote] ?? 0)}. Tried again in 5 minutes.`);
          return;
        }
        const fill = await ex().marketBuy(pos.pair, usdt);
        const r = applyBuyback(pos, a.lotId, fill, now());
        trade({ asset: pos.asset, side: 'buy', kind: 'buy-back', qty: fill.qty, price: fill.price, usdt: fill.usdt, profitUsd: r.profitUsd });
        event('buy', `Bought back ${fmt(fill.qty, 6)} ${pos.asset} at $${fmt(fill.price, 6)} with ${fmt(fill.usdt)} USDT: ${fmt(fill.qty - r.lot.qty, 6)} more than were sold (+$${fmt(r.profitUsd)}). Cycle ${pos.cycles} of ${s.rebaseCycles}.`);
      } else if (a.type === 'rebase') {
        const was = applyRebase(pos, a.base, now());
        event('rebase', `${pos.asset}: ${s.rebaseCycles} cycles done and the holding is worth $${fmt(a.base)}: the base goes from $${fmt(was)} to $${fmt(a.base)}.`);
      }
      state.save();
    }
  }

  const symbolOf = (raw) => String(raw ?? '').trim().toUpperCase().replace(new RegExp(`${DEFAULTS.quote}$`), '');
  async function addCoinNow(body = {}) {
    const asset = symbolOf(body.asset);
    if (!/^[A-Z0-9]{2,15}$/.test(asset) || asset === DEFAULTS.quote) throw new Error('Write a coin symbol, e.g. BTC, ETH or SOL.');
    const b = book();
    if (b.positions[asset] && !b.positions[asset].stopped) throw new Error(`${asset} is in the plan already.`);
    const pair = `${asset}${DEFAULTS.quote}`;
    const f = await ex().info(pair).catch(() => { throw new Error(`Binance has no ${pair} pair.`); });
    if (f.status && f.status !== 'TRADING') throw new Error(`${pair} is not trading on Binance right now.`);
    const usdt = Number(body.usdt) || 0;
    let qty;
    let price = await ex().price(pair);
    if (usdt > 0) {
      if (usdt < f.minNotional) throw new Error(`Binance's smallest order for ${pair} is ${f.minNotional} USDT.`);
      const fill = await ex().marketBuy(pair, usdt);
      qty = fill.qty;
      price = fill.price;
      trade({ asset, side: 'buy', kind: 'start', qty: fill.qty, price: fill.price, usdt: fill.usdt });
    } else {
      await refreshBalances(true);
      qty = balances[asset] ?? 0;
      if (qty * price < f.minNotional) throw new Error(`The account holds no ${asset} worth trading: write how many USDT to buy it with.`);
    }
    const pos = newPosition(asset, qty, price, now());
    b.positions[asset] = pos;
    delete b.samples[asset];
    if (!body.quiet) event('start', `${asset} joined the plan: ${fmt(qty, 6)} ${asset} worth $${fmt(pos.base)} is the base. It sells the part above the base at +${settings.get().swingPct}%.`);
    await refreshBalances(true);
    state.save();
    return pos;
  }

  // a coin's past closing prices from Binance (live, whatever the mode), kept a few minutes
  async function pastPrices(pair, days) {
    const k = `${pair}|${days}`;
    const kept = closesKept.get(k);
    if (kept && now() - kept.at < CLOSES_MS) return kept.prices;
    const out = await pub().closes(pair, periodOf(days).interval, now() - days * 86_400_000, now());
    closesKept.set(k, { at: now(), prices: out });
    return out;
  }
  async function simulateCoin({ asset, usdt = 1000, days = RANK_DAYS, swingPct }) {
    const s = settings.get();
    const pair = `${asset}${DEFAULTS.quote}`;
    const f = await pub().info(pair).catch(() => { throw new Error(`Binance has no ${pair} pair.`); });
    const prices = await pastPrices(pair, days);
    return { asset, pair, days, swingPct, rebaseCycles: s.rebaseCycles, candles: `${prices.length} ${periodOf(days).label} candles`, ...simulate(prices, { usdt, swingPct, rebaseCycles: s.rebaseCycles, minNotional: f.minNotional }) };
  }

  // The well-known coins over the last RANK_DAYS at each of the swings compared (10, 12 and 15%): the
  // swing whose best coins made the most, and those coins: each ended in profit AND completed cycles,
  // ranked by what their cycles (sale + buy-back) earned (see bestSwing).
  async function getRanking() {
    const s = settings.get();
    if (rank && now() - rank.at < RANK_MS && rank.rebaseCycles === s.rebaseCycles) return rank;
    ranking ??= (async () => {
      const rows = [];
      for (const asset of KNOWN_COINS) {
        for (const swingPct of DEFAULTS.rankSwings) {
          try {
            const r = await simulateCoin({ asset, days: RANK_DAYS, swingPct });
            rows.push({ asset, swingPct, profitUsd: r.profitUsd, cycles: r.cycles, endPct: r.endPct, holdPct: r.holdPct });
          } catch (e) {
            log.warn?.(`ranking ${asset}: ${e.message}`);
            break; // its prices did not come: its other swings would not either
          }
        }
      }
      if (!rows.length) throw new Error('Binance did not answer: the ranking is tried again later.');
      const { best, by } = bestSwing(rows, DEFAULTS.rankSwings, TEST_WALLET.coins);
      rank = {
        at: now(), days: RANK_DAYS, rebaseCycles: s.rebaseCycles, swingPct: best.swingPct, top: best.top, list: best.list,
        bySwing: by.map((x) => ({ swingPct: x.swingPct, totalPct: x.totalPct, coins: x.top.map((r) => r.asset) })),
      };
      return rank;
    })().finally(() => { ranking = null; });
    return ranking;
  }

  // The test wallet, the first time (and after a reset): the plan's swing becomes the best of 10, 12
  // and 15%, and the 3 coins that ended in profit with the most cycle earnings at it go into the plan,
  // TEST_WALLET.usdtEach each, from the 1,000 test USDT.
  async function seedTestWallet() {
    const b = book('paper');
    seeding = true;
    try {
      const r = await getRanking();
      const top = r.top.slice(0, TEST_WALLET.coins);
      if (!top.length) throw new Error('no coin ended in profit with cycles over the last 3 months');
      settings.update({ swingPct: r.swingPct });
      for (const c of top) if (!b.positions[c.asset]) await addCoinNow({ asset: c.asset, usdt: TEST_WALLET.usdtEach, quiet: true });
      b.paper.seeded = SEED_VERSION;
      seedError = null;
      event('start', `Test wallet ready at swing ${r.swingPct}%, the best of ${DEFAULTS.rankSwings.join(', ')}% over the last 3 months: ${top.map((c) => `${c.asset} (+${c.endPct.toFixed(1)}%, ${c.cycles} cycles)`).join(', ')}, ${TEST_WALLET.usdtEach} USDT each. Each ended in profit with this plan and completed its cycles. ${DEFAULTS.paperStartUsdt - top.length * TEST_WALLET.usdtEach} USDT stays spare.`);
      state.save();
    } catch (e) {
      seedError = e.message;
      seedRetryAt = now() + SEED_RETRY_MS;
      log.warn?.(`test wallet: ${e.message}`);
    } finally {
      seeding = false;
    }
  }
  // a test book made before the test wallet existed starts over once, with the 3 coins
  function freshTestBook() {
    (state.data.books ??= {}).paper = { positions: {}, trades: [], samples: {}, events: [], paper: { balances: { [DEFAULTS.quote]: DEFAULTS.paperStartUsdt } } };
    exchangeKey = null;
    balances = {};
  }

  async function tick() {
    if (now() < waitUntil) return;
    // the test wallet's 3 coins, once (a stand-in exchange in the tests seeds only when given a test book)
    const tb = book('paper');
    if (modeOf(settings.get()) === 'paper' && (!makeExchange || tb.paper) && tb.paper?.seeded !== SEED_VERSION && now() >= seedRetryAt) {
      if (Object.keys(tb.positions).length || tb.trades.length) freshTestBook();
      ex();
      await seedTestWallet();
    }
    const b = book();
    const active = Object.values(b.positions).filter((p) => !p.stopped);
    try {
      prices = await ex().prices();
      await refreshBalances();
      if (!state.data.paused) {
        for (const pos of active) {
          const price = prices[pos.pair];
          if (!(price > 0)) continue;
          try {
            await step(pos, price);
          } catch (e) {
            if (e.retryAfterSec) throw e;
            lastError = `${pos.asset}: ${e.message}`;
            event('error', lastError);
          }
        }
      }
      if (now() - historyAt >= HISTORY_MS) {
        historyAt = now();
        const t = totals();
        if (t.total > 0) history?.add({ t: now(), mode: modeOf(settings.get()), total: Number(t.total.toFixed(2)) });
      }
      lastTickAt = now();
      state.save();
    } catch (e) {
      lastError = e.message;
      if (e.retryAfterSec) {
        waitUntil = now() + e.retryAfterSec * 1000;
        event('error', `Binance asks to slow down: the bot waits ${e.retryAfterSec} s.`);
      } else log.warn?.(`tick: ${e.message}`);
    }
  }

  return {
    tick: () => serial(tick),
    start() {
      const loop = async () => {
        await serial(tick);
        timer = setTimeout(loop, DEFAULTS.tickSec * 1000);
        timer.unref?.();
      };
      loop();
    },
    stop: () => clearTimeout(timer),

    // starts the plan for a coin: with `usdt` it is bought now, else what the account holds of it is used
    addCoin: (body = {}) => serial(() => addCoinNow(body)),

    // out of the plan; with sell, its coins are sold for USDT first
    removeCoin: (body = {}) => serial(async () => {
      const b = book();
      const pos = b.positions[String(body.asset ?? '').toUpperCase()];
      if (!pos) throw new Error('That coin is not in the plan.');
      if (body.sell && pos.qty > 0) {
        await refreshBalances(true);
        const fill = await ex().marketSell(pos.pair, Math.min(pos.qty, balances[pos.asset] ?? pos.qty));
        trade({ asset: pos.asset, side: 'sell', kind: 'sell-all', qty: fill.qty, price: fill.price, usdt: fill.usdt });
        event('sell', `${pos.asset}: all ${fmt(fill.qty, 6)} sold for ${fmt(fill.usdt)} USDT; it left the plan.`);
      } else event('stop', `${pos.asset} left the plan; its coins stay in the account.`);
      delete b.positions[pos.asset];
      delete b.samples[pos.asset];
      await refreshBalances(true);
      state.save();
      return true;
    }),

    setPaused(paused) {
      state.data.paused = Boolean(paused);
      event(paused ? 'stop' : 'start', paused ? 'Paused: no orders until Resume.' : 'Resumed.');
      state.save();
      return state.data.paused;
    },

    // the paper account back to its starting USDT, its plan and trades cleared
    resetPaper: () => serial(async () => {
      if (modeOf(settings.get()) !== 'paper') throw new Error('Only the test balance can be reset: switch to Test mode at the top.');
      freshTestBook();
      ex();
      await seedTestWallet(); // the 3 coins again
      await refreshBalances(true).catch(() => {});
      state.save();
      return true;
    }),

    // asked again after the keys change, so the panel shows the new account at once
    async reconnect() {
      exchangeKey = null;
      await serial(tick);
      return lastError;
    },

    async testConnection() {
      exchangeKey = null;
      const b = await ex().balances();
      return { ok: true, assets: Object.keys(b).length };
    },

    status() {
      const s = settings.get();
      const b = book();
      const t = totals();
      const positions = Object.values(b.positions).map((p) => {
        const price = prices[p.pair] ?? null;
        const lv = levels(p, price ?? 0, s.swingPct);
        const sl = stopLossLine(b.samples[p.asset] ?? [], now(), DEFAULTS);
        return {
          asset: p.asset, pair: p.pair, qty: p.qty, price, value: price ? lv.value : null, base: p.base, startBase: p.startBase, startedAt: p.startedAt,
          sellAt: lv.sellAt, sellInPct: price ? lv.sellInPct : null, buyBacks: lv.buyBacks.map((l) => ({ qty: l.qty, sellPrice: l.sellPrice, buyAt: l.buyAt, inPct: l.inPct, proceeds: l.proceeds, at: l.at })),
          cycles: p.cycles, totalCycles: p.totalCycles, profitUsd: p.profitUsd, profitSinceRebase: p.profitSinceRebase, rebases: p.rebases, rebasedAt: p.rebasedAt,
          rebaseAt: p.base + p.profitSinceRebase, stopped: p.stopped, stopLossLine: sl?.line ?? null,
        };
      });
      return {
        mode: modeOf(s), paused: state.data.paused, lastTickAt, lastError, keys: settings.view(),
        testWallet: { seeding, error: seedError, coins: TEST_WALLET.coins, usdtEach: TEST_WALLET.usdtEach },
        total: t.total, assets: t.assets, positions,
        profitUsd: positions.reduce((a, p) => a + (p.profitUsd ?? 0), 0),
        trades: b.trades.slice(0, 60), events: (b.events ?? []).slice(0, 30),
        rules: { ...DEFAULTS, swingPct: s.swingPct, rebaseCycles: s.rebaseCycles },
      };
    },

    // the plan on a coin's real past prices (Binance, no key needed), in a moment: nothing is traded
    async simulate(body = {}) {
      const s = settings.get();
      const asset = symbolOf(body.asset || 'SOL');
      if (!/^[A-Z0-9]{2,15}$/.test(asset) || asset === DEFAULTS.quote) throw new Error('Write a coin symbol, e.g. BTC, ETH or SOL.');
      const usdt = Number(body.usdt) || 1000;
      if (!(usdt >= 10 && usdt <= 10_000_000)) throw new Error('Start with 10 to 10,000,000 USDT.');
      const days = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 90; // the panel's simulation: 90; Add a coin's check: 30
      const swingPct = DEFAULTS.swingChoices.includes(Number(body.swingPct)) ? Number(body.swingPct) : s.swingPct;
      return simulateCoin({ asset, usdt, days, swingPct });
    },

    // the well-known coins ranked by the last 3 months with this plan (worked out a few times a day)
    ranking: () => getRanking(),

    // for the assistant: a coin's price and its last 24 hours
    async market(symbol) {
      const asset = String(symbol ?? '').trim().toUpperCase().replace(new RegExp(`${DEFAULTS.quote}$`), '');
      const t = await ex().ticker24h(`${asset}${DEFAULTS.quote}`);
      return { pair: t.symbol, price: Number(t.lastPrice), change24hPct: Number(t.priceChangePercent), high24h: Number(t.highPrice), low24h: Number(t.lowPrice), volumeUsdt24h: Number(t.quoteVolume), source: modeOf(settings.get()) === 'testnet' ? 'Binance testnet' : 'Binance' };
    },
  };
}
