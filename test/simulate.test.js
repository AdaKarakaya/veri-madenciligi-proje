import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bestSwing, simulate } from '../src/simulate.js';
import { createSettings, modeOf } from '../src/store.js';
import { createBot } from '../src/bot.js';

const H = 3_600_000;
// a price that swings 1 → 1.16 → 0.95 → 1 again and again, one point every 15 minutes
// (after the first cycle the holding is bigger, so the next sale comes a little under 1.16,
// and its buy-back a little under 0.986)
function swings(n) {
  const out = [];
  let t = 0;
  const leg = (from, to) => { for (let i = 1; i <= 8; i++) out.push([(t += H / 4), from + ((to - from) * i) / 8]); };
  out.push([t, 1]);
  for (let i = 0; i < n; i++) { leg(1, 1.16); leg(1.16, 0.95); leg(0.95, 1); }
  return out;
}

test('a swinging price: the plan sells up, buys back down, raises its base, and ends with more than holding', () => {
  const r = simulate(swings(4), { usdt: 1000, swingPct: 15, rebaseCycles: 2 });
  assert.ok(r.cycles >= 4, `cycles ${r.cycles}`);
  assert.ok(r.rebases >= 1, `rebases ${r.rebases}`);
  assert.ok(r.end > r.hold, `${r.end} vs ${r.hold}`); // the price ends where it began: holding only lost the fee
  assert.equal(r.trades[0].kind, 'start');
  assert.ok(r.trades.some((t) => t.kind === 'swing') && r.trades.some((t) => t.kind === 'buy-back') && r.trades.some((t) => t.kind === 'rebase'));
  assert.ok(r.series.length >= 2 && r.series.length <= 401);
});

test('a crash of more than 50% within 2 hours: the stop-loss sells everything and the run stops there', () => {
  const prices = [[0, 100], [H / 2, 90], [H, 60], [1.5 * H, 45], [2 * H, 44], [3 * H, 80]];
  const r = simulate(prices, { usdt: 1000, swingPct: 15, rebaseCycles: 2 });
  assert.ok(r.stopped);
  assert.equal(r.stopped.price, 45);
  assert.equal(r.coinsEnd, 0);
  assert.ok(r.end < 500 && r.end > 400);
});

test('test mode: always without keys; with keys the switch picks test mode or the Binance account; saving keys picks Binance', () => {
  assert.equal(modeOf({}), 'paper');
  assert.equal(modeOf({ binanceKey: 'k', binanceSecret: 's', testMode: true }), 'paper');
  assert.equal(modeOf({ binanceKey: 'k', binanceSecret: 's', testMode: false, testnet: true }), 'testnet');
  assert.equal(modeOf({ binanceKey: 'k', binanceSecret: 's', testMode: false, testnet: false }), 'live');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltb-'));
  const s = createSettings(path.join(dir, 'settings.json'));
  assert.equal(s.view().mode, 'paper');
  s.update({ binanceKey: 'key1234', binanceSecret: 'secret', testnet: true });
  assert.deepEqual([s.view().mode, s.view().binanceKey, s.view().hasBinance], ['testnet', '••••1234', true]);
  s.update({ testMode: true });
  assert.equal(s.view().mode, 'paper');
  s.update({ clearBinance: true });
  assert.deepEqual([s.view().mode, s.view().hasBinance], ['paper', false]);
  assert.throws(() => s.update({ swingPct: 13 }), /Swing must be one of/);
  assert.equal(s.update({ swingPct: 12 }).swingPct, 12);
  assert.throws(() => s.update({ rebaseCycles: 0 }), /whole number from 1 to 20/);
});

test('best swing: only coins in profit that completed cycles count; the swing whose best 3 made the most in all wins', () => {
  const row = (asset, swingPct, endPct, cycles, profitUsd) => ({ asset, swingPct, endPct, cycles, profitUsd });
  const rows = [
    // at 12%: ADA has the most cycle profit but barely ends up (+0.4%); at 10% and 15% it ends down
    row('ADA', 10, -2.2, 6, 72.9), row('ADA', 12, 0.4, 6, 101.9), row('ADA', 15, -1.6, 3, 74.9),
    row('DOT', 10, 20.4, 8, 100.7), row('DOT', 12, 20.5, 6, 100.9), row('DOT', 15, 19.1, 3, 83.7),
    row('XRP', 10, 17.5, 6, 72.8), row('XRP', 12, 17.7, 3, 59.4), row('XRP', 15, 18.5, 3, 74.1),
    row('DOGE', 10, 6.6, 4, 48.2), row('DOGE', 12, 7.0, 3, 47.3), row('DOGE', 15, 10.7, 3, 76.6),
    row('LINK', 10, 32.5, 4, 46.2), row('LINK', 12, 33.6, 3, 51.9), row('LINK', 15, 36.2, 3, 75.2),
    row('BTC', 10, 15.9, 0, 0), row('BTC', 12, 16.5, 0, 0), row('BTC', 15, 17.8, 0, 0), // no cycle: never counts
  ];
  const { best, by } = bestSwing(rows, [10, 12, 15], 3);
  assert.equal(best.swingPct, 15);
  assert.deepEqual(best.top.map((r) => r.asset), ['DOT', 'DOGE', 'LINK']); // ADA ends down at 15%: out
  assert.deepEqual(by.map((x) => [x.swingPct, x.top.map((r) => r.asset)]), [[10, ['DOT', 'XRP', 'DOGE']], [12, ['ADA', 'DOT', 'XRP']], [15, ['DOT', 'DOGE', 'LINK']]]);
  assert.ok(Math.abs(best.totalPct - (19.1 + 10.7 + 36.2)) < 1e-9);
});

test('the test wallet: the plan swing becomes the best of 10/12/15% and the 3 coins in profit with the most cycle earnings go in, 300 USDT each, once', async () => {
  // DOGE, SOL and XRP swing (DOGE the most); the others stay flat
  const swingsOf = { DOGE: 6, SOL: 4, XRP: 2 };
  const flat = () => Array.from({ length: 200 }, (_, i) => [i * (H / 4), 1]);
  const pub = { info: async (pair) => ({ pair, minNotional: 5 }), closes: async (pair) => (swingsOf[pair.replace('USDT', '')] ? swings(swingsOf[pair.replace('USDT', '')]) : flat()) };
  const bought = [];
  const balances = { USDT: 1000 };
  const ex = {
    info: async (pair) => ({ pair, base: pair.replace('USDT', ''), quote: 'USDT', step: 0.0001, minNotional: 5, status: 'TRADING' }),
    price: async () => 1, prices: async () => ({ DOGEUSDT: 1, SOLUSDT: 1, XRPUSDT: 1 }), balances: async () => ({ ...balances }),
    async marketBuy(pair, usdt) { bought.push([pair, usdt]); balances.USDT -= usdt; balances[pair.replace('USDT', '')] = usdt; return { qty: usdt, price: 1, usdt }; },
  };
  const cfg = { binanceKey: '', binanceSecret: '', swingPct: 25, rebaseCycles: 2 };
  const settings = { get: () => ({ ...cfg }), view: () => ({}), update: (p) => Object.assign(cfg, p) };
  // a test book from before the test wallet existed, with a coin in it: it starts over once
  const state = { data: { paused: false, books: { paper: { positions: { BTC: { asset: 'BTC', pair: 'BTCUSDT', qty: 1, lots: [] } }, trades: [{}], samples: {}, events: [], paper: { balances: { USDT: 1000 } } } } }, save() {} };
  let t = 1_800_000_000_000;
  const bot = createBot({ settings, state, history: null, log: { info() {}, warn() {} }, now: () => t, makeExchange: () => ex, makePublic: () => pub });
  await bot.tick();
  assert.deepEqual(bought, [['DOGEUSDT', 300], ['SOLUSDT', 300], ['XRPUSDT', 300]]);
  const s = bot.status();
  assert.deepEqual(s.positions.map((p) => p.asset).sort(), ['DOGE', 'SOL', 'XRP']); // BTC from before is gone
  const r = await bot.ranking();
  assert.ok([10, 12, 15].includes(r.swingPct));
  assert.equal(cfg.swingPct, r.swingPct); // the plan's swing (25% before) is now the best one
  assert.ok(s.events.some((e) => new RegExp(`Test wallet ready at swing ${r.swingPct}%.*DOGE .*SOL .*XRP`).test(e.text)));
  assert.deepEqual(r.top.map((c) => c.asset), ['DOGE', 'SOL', 'XRP']);
  assert.ok(r.top.every((c) => c.endPct > 0 && c.cycles >= 1));
  assert.equal(r.list.length, 12);
  assert.deepEqual(r.bySwing.map((x) => x.swingPct), [10, 12, 15]);
  t += 60_000;
  await bot.tick();
  assert.equal(bought.length, 3); // once
});

test("the bot's simulation: the coin's past prices from Binance, the plan's swing unless another is picked", async () => {
  const asked = [];
  const pub = {
    info: async (pair) => { if (pair !== 'SOLUSDT') throw new Error('no pair'); return { pair, minNotional: 5 }; },
    closes: async (pair, interval, from, to) => { asked.push({ pair, interval, days: Math.round((to - from) / 86_400_000) }); return swings(3); },
  };
  const settings = { get: () => ({ binanceKey: '', binanceSecret: '', swingPct: 15, rebaseCycles: 2 }), view: () => ({}) };
  const bot = createBot({ settings, state: { data: {}, save() {} }, history: null, log: { info() {}, warn() {} }, makeExchange: () => ({}), makePublic: () => pub });
  const r = await bot.simulate({ asset: 'sol', usdt: 500, days: 90, swingPct: 20 });
  assert.deepEqual(asked, [{ pair: 'SOLUSDT', interval: '1h', days: 90 }]);
  assert.deepEqual([r.asset, r.swingPct, r.start, r.days], ['SOL', 20, 500, 90]);
  await bot.simulate({ days: 7 });
  assert.equal(asked[1].interval, '15m');
  await assert.rejects(bot.simulate({ asset: 'NOPE' }), /no NOPEUSDT pair/);
  await assert.rejects(bot.simulate({ usdt: 1 }), /10 to 10,000,000/);
});
