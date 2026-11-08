import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBinance, createPaper, fillOf, filtersOf, signQuery, stepDown } from '../src/binance.js';

test("signature: Binance's documented example", () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(signQuery(query, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('quantities are cut down to the step, never rounded up', () => {
  assert.equal(stepDown(1.23456789, 0.001), '1.234');
  assert.equal(stepDown(0.3, 0.1), '0.3'); // 0.3 / 0.1 is 2.9999999999999996 in floating point
  assert.equal(stepDown(15.9, 1), '15');
  assert.equal(stepDown(0.000012345, 0.00001), '0.00001');
});

test('the pair rules and a market order answer, fees taken from what was received', () => {
  const f = filtersOf({ symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00100000', minQty: '0.00100000' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }] });
  assert.deepEqual([f.step, f.minNotional, f.base], [0.001, 5, 'SOL']);
  const buy = fillOf({ orderId: 1, executedQty: '2.000', cummulativeQuoteQty: '300.00', fills: [{ commission: '0.002', commissionAsset: 'SOL' }] }, 'BUY', 'SOL', 'USDT');
  assert.deepEqual([buy.qty, buy.price, buy.usdt], [1.998, 150, 300]);
  const sell = fillOf({ orderId: 2, executedQty: '2.000', cummulativeQuoteQty: '300.00', fills: [{ commission: '0.3', commissionAsset: 'USDT' }] }, 'SELL', 'SOL', 'USDT');
  assert.deepEqual([sell.qty, sell.usdt], [2, 299.7]);
});

test('signed requests: the server clock, the key header and the signature; an error carries Binance\'s message', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/api/v3/time') return new Response(JSON.stringify({ serverTime: 2000 }));
    if (u.pathname === '/api/v3/account') return new Response(JSON.stringify({ balances: [{ asset: 'USDT', free: '10', locked: '2' }, { asset: 'SOL', free: '0', locked: '0' }] }));
    return new Response(JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }), { status: 401 });
  };
  const b = createBinance({ apiKey: 'K', apiSecret: 'S', testnet: true, fetchFn, now: () => 1000 });
  assert.deepEqual(await b.balances(), { USDT: 12 });
  const acct = new URL(calls[1].url);
  assert.equal(acct.origin, 'https://testnet.binance.vision');
  assert.equal(acct.searchParams.get('timestamp'), '2000'); // our clock + the measured offset
  assert.equal(calls[1].init.headers['X-MBX-APIKEY'], 'K');
  const unsigned = acct.search.slice(1).replace(/&signature=.*$/, '');
  assert.equal(acct.searchParams.get('signature'), signQuery(unsigned, 'S'));
  await assert.rejects(b.ticker24h('XXXUSDT'), /Invalid API-key, IP, or permissions/);
});

test('paper account: real prices, the fee taken from what comes in, never more than it holds', async () => {
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/v3/exchangeInfo') return new Response(JSON.stringify({ symbols: [{ symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] }));
    if (u.pathname === '/api/v3/ticker/price') return new Response(JSON.stringify({ symbol: 'SOLUSDT', price: '100' }));
    throw new Error(`unexpected ${url}`);
  };
  const book = { balances: { USDT: 1000 } };
  const p = createPaper({ book, save() {}, fetchFn });
  const buy = await p.marketBuy('SOLUSDT', 200);
  assert.deepEqual([buy.qty, buy.usdt], [2 * 0.999, 200]);
  assert.deepEqual(book.balances, { USDT: 800, SOL: 1.998 });
  const sell = await p.marketSell('SOLUSDT', 5); // holds 1.998: sells 1.998 cut to the step
  assert.equal(sell.qty, 1.998);
  assert.ok(Math.abs(sell.usdt - 1.998 * 100 * 0.999) < 1e-9);
  await assert.rejects(p.marketBuy('SOLUSDT', 5000), /not enough USDT/);
  await assert.rejects(p.marketBuy('SOLUSDT', 3), /smallest order/);
});
