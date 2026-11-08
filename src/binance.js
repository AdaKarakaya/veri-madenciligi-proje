import crypto from 'node:crypto';

// Binance spot, through its REST API: prices, the account's balances, market orders.
// Signed requests carry an HMAC-SHA256 of the query, made with the API secret.
// Three modes share one interface (createExchange):
//   live     api.binance.com with the owner's key
//   testnet  testnet.binance.vision with a testnet key (practice money, real order book of the testnet)
//   paper    no key: real prices from api.binance.com, a pretend account kept in the state file

export const LIVE_URL = 'https://api.binance.com';
export const TESTNET_URL = 'https://testnet.binance.vision';

export const signQuery = (query, secret) => crypto.createHmac('sha256', secret).update(query).digest('hex');

// A quantity cut down to the exchange's step (never rounded up: the wallet may not have more), as a plain decimal string.
export function stepDown(qty, step) {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const units = Math.floor(qty / step + 1e-9);
  return (units * step).toFixed(decimals);
}

// The rules of a pair that matter for a market order: the quantity's step and the smallest order in USDT.
export function filtersOf(symbolInfo) {
  const f = (type) => symbolInfo?.filters?.find((x) => x.filterType === type) ?? {};
  return {
    pair: symbolInfo?.symbol, base: symbolInfo?.baseAsset, quote: symbolInfo?.quoteAsset, status: symbolInfo?.status,
    step: Number(f('LOT_SIZE').stepSize) || 1e-8, minQty: Number(f('LOT_SIZE').minQty) || 0,
    minNotional: Number(f('NOTIONAL').minNotional ?? f('MIN_NOTIONAL').minNotional) || 5,
  };
}

// A market order's answer (newOrderRespType FULL) as what the plan needs: coins and USDT that moved, after fees.
export function fillOf(order, side, baseAsset, quoteAsset) {
  const qty = Number(order.executedQty);
  const quoteQty = Number(order.cummulativeQuoteQty);
  const fee = (asset) => (order.fills ?? []).filter((x) => x.commissionAsset === asset).reduce((a, x) => a + Number(x.commission), 0);
  const price = qty > 0 ? quoteQty / qty : 0;
  return side === 'BUY'
    ? { qty: qty - fee(baseAsset), price, usdt: quoteQty + fee(quoteAsset), orderId: order.orderId }
    : { qty, price, usdt: quoteQty - fee(quoteAsset), orderId: order.orderId };
}

export function createBinance({ apiKey, apiSecret, testnet = false, fetchFn = fetch, now = () => Date.now() }) {
  const baseUrl = testnet ? TESTNET_URL : LIVE_URL;
  let offset = null; // the exchange's clock minus ours
  const infos = new Map();

  async function call(method, path, params = {}, signed = false) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    const headers = {};
    if (signed) {
      if (!apiKey || !apiSecret) throw new Error('Binance API key and secret are missing (Settings)');
      if (offset == null) offset = Number((await call('GET', '/api/v3/time')).serverTime) - now();
      q.set('recvWindow', '5000');
      q.set('timestamp', String(now() + offset));
      q.set('signature', signQuery(q.toString(), apiSecret));
      headers['X-MBX-APIKEY'] = apiKey;
    }
    const url = `${baseUrl}${path}${q.size ? `?${q}` : ''}`;
    const r = await fetchFn(url, { method, headers, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) {
      const err = new Error(`Binance ${path}: ${j?.msg ?? `HTTP ${r.status}`}${j?.code ? ` (${j.code})` : ''}`);
      err.status = r.status;
      err.code = j?.code;
      // 429: too many requests; 418: banned for a while after them
      if (r.status === 429 || r.status === 418) err.retryAfterSec = Number(r.headers.get('retry-after')) || 60;
      if (j?.code === -1021) offset = null; // the clocks drifted apart: measured again on the next call
      throw err;
    }
    return j;
  }

  async function info(pair) {
    if (!infos.has(pair)) {
      const j = await call('GET', '/api/v3/exchangeInfo', { symbol: pair });
      const s = j.symbols?.[0];
      if (!s) throw new Error(`Binance has no pair ${pair}`);
      infos.set(pair, filtersOf(s));
    }
    return infos.get(pair);
  }

  async function order(pair, side, params) {
    const f = await info(pair);
    const o = await call('POST', '/api/v3/order', { symbol: pair, side, type: 'MARKET', newOrderRespType: 'FULL', ...params }, true);
    return fillOf(o, side, f.base, f.quote);
  }

  return {
    mode: testnet ? 'testnet' : 'live',
    info,
    async price(pair) { return Number((await call('GET', '/api/v3/ticker/price', { symbol: pair })).price); },
    // every pair's price in one request: { BTCUSDT: 97000, ... }
    async prices() { return Object.fromEntries((await call('GET', '/api/v3/ticker/price')).map((x) => [x.symbol, Number(x.price)])); },
    async ticker24h(pair) { return call('GET', '/api/v3/ticker/24hr', { symbol: pair }); },
    // past prices: [[close time, close price], ...] oldest first, from `from` to `to` (ms), 1000 candles a request
    async closes(pair, interval, from, to) {
      const out = [];
      let start = from;
      for (let i = 0; i < 20 && start < to; i++) {
        const rows = await call('GET', '/api/v3/klines', { symbol: pair, interval, startTime: start, endTime: to, limit: 1000 });
        if (!rows.length) break;
        for (const k of rows) out.push([Number(k[6]), Number(k[4])]);
        start = Number(rows.at(-1)[6]) + 1;
        if (rows.length < 1000) break;
      }
      return out;
    },
    // { ASSET: amount } of everything the account holds (free and in orders)
    async balances() {
      const j = await call('GET', '/api/v3/account', { omitZeroBalances: true }, true);
      return Object.fromEntries((j.balances ?? []).map((b) => [b.asset, Number(b.free) + Number(b.locked)]).filter(([, v]) => v > 0));
    },
    // buys `usdt` worth of the coin
    async marketBuy(pair, usdt) { return order(pair, 'BUY', { quoteOrderQty: usdt.toFixed(2) }); },
    // sells `qty` coins (cut to the pair's step)
    async marketSell(pair, qty) {
      const f = await info(pair);
      const amount = stepDown(qty, f.step);
      if (!(Number(amount) > 0)) throw new Error(`${pair}: ${qty} is under the smallest amount Binance sells`);
      return order(pair, 'SELL', { quantity: amount });
    },
  };
}

// The pretend account: Binance's real prices (no key needed), balances in `book` (the state file),
// fills at the price now with Binance's 0.1% fee taken from what is received.
export function createPaper({ book, save, fetchFn = fetch, feePct = 0.1 }) {
  const market = createBinance({ fetchFn });
  const fee = 1 - feePct / 100;
  const bal = () => (book.balances ??= {});
  const add = (asset, v) => {
    bal()[asset] = (bal()[asset] ?? 0) + v;
    if (Math.abs(bal()[asset]) < 1e-12) delete bal()[asset];
  };
  let seq = 0;
  return {
    mode: 'paper',
    info: market.info,
    price: market.price,
    prices: market.prices,
    ticker24h: market.ticker24h,
    async balances() { return { ...bal() }; },
    async marketBuy(pair, usdt) {
      const f = await market.info(pair);
      if (usdt < f.minNotional) throw new Error(`${pair}: ${usdt.toFixed(2)} USDT is under Binance's smallest order (${f.minNotional} USDT)`);
      if ((bal()[f.quote] ?? 0) + 1e-9 < usdt) throw new Error(`not enough ${f.quote} in the test balance (${(bal()[f.quote] ?? 0).toFixed(2)})`);
      const price = await market.price(pair);
      const qty = Number(stepDown(usdt / price, f.step));
      const spent = qty * price;
      add(f.quote, -spent);
      add(f.base, qty * fee);
      save();
      return { qty: qty * fee, price, usdt: spent, orderId: `paper-${++seq}` };
    },
    async marketSell(pair, qty) {
      const f = await market.info(pair);
      const amount = Number(stepDown(Math.min(qty, bal()[f.base] ?? 0), f.step));
      if (!(amount > 0)) throw new Error(`no ${f.base} to sell in the test balance`);
      const price = await market.price(pair);
      if (amount * price < f.minNotional) throw new Error(`${pair}: under Binance's smallest order (${f.minNotional} USDT)`);
      add(f.base, -amount);
      add(f.quote, amount * price * fee);
      save();
      return { qty: amount, price, usdt: amount * price * fee, orderId: `paper-${++seq}` };
    },
  };
}
