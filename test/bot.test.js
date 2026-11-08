import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';

const quiet = { info() {}, warn() {}, error() {} };

// A bot on a stand-in exchange: fills at the price set in the test, no fee.
function setup({ rebaseCycles = 2, usdt = 1000 } = {}) {
  let t = 1_800_000_000_000;
  const market = { price: 1 };
  const balances = { USDT: usdt };
  const orders = [];
  const exchange = {
    mode: 'paper',
    info: async (pair) => ({ pair, base: pair.replace(/USDT$/, ''), quote: 'USDT', step: 0.0001, minNotional: 5, status: 'TRADING' }),
    price: async () => market.price,
    prices: async () => ({ SOLUSDT: market.price }),
    ticker24h: async (pair) => ({ symbol: pair, lastPrice: String(market.price), priceChangePercent: '1.5', highPrice: '1', lowPrice: '1', quoteVolume: '1' }),
    balances: async () => ({ ...balances }),
    async marketBuy(pair, spend) {
      const qty = spend / market.price;
      balances.USDT -= spend;
      balances.SOL = (balances.SOL ?? 0) + qty;
      orders.push(['buy', qty, market.price]);
      return { qty, price: market.price, usdt: spend };
    },
    async marketSell(pair, qty) {
      balances.SOL -= qty;
      balances.USDT += qty * market.price;
      orders.push(['sell', qty, market.price]);
      return { qty, price: market.price, usdt: qty * market.price };
    },
  };
  const cfg = { binanceKey: '', binanceSecret: '', testnet: true, anthropicKey: '', swingPct: 15, rebaseCycles };
  const settings = { get: () => ({ ...cfg }), view: () => ({ mode: 'paper' }) };
  const state = { data: { paused: false }, save() {} };
  const points = [];
  const bot = createBot({ settings, state, history: { add: (p) => points.push(p) }, log: quiet, now: () => t, makeExchange: () => exchange });
  const at = async (price, minutes = 1) => {
    market.price = price;
    t += minutes * 60_000;
    await bot.tick();
  };
  return { bot, market, balances, orders, state, points, at, cfg };
}

test('a coin joins with USDT, sells 15% up, buys back 15% under the sale, and re-bases after two cycles', async () => {
  const { bot, orders, at } = setup();
  const pos = await bot.addCoin({ asset: 'sol', usdt: 100 });
  assert.deepEqual([pos.asset, pos.qty, pos.base], ['SOL', 100, 100]);

  await at(1.1);
  assert.equal(orders.length, 1); // only the starting buy
  await at(1.15);
  assert.equal(orders.at(-1)[0], 'sell');
  assert.equal(bot.status().positions[0].buyBacks.length, 1);
  await at(0.98);
  assert.equal(orders.length, 2); // not 15% under the sale yet
  await at(0.9775);
  assert.equal(orders.at(-1)[0], 'buy');
  let p = bot.status().positions[0];
  assert.deepEqual([p.cycles, p.buyBacks.length], [1, 0]);
  assert.ok(p.qty > 100 && p.profitUsd > 0);

  // the second cycle
  await at(1.15);
  await at(1.15 * 0.85);
  p = bot.status().positions[0];
  assert.equal(p.cycles, 2);
  const needs = p.rebaseAt / p.qty; // the price where the holding is worth base + the two cycles' profit
  await at(needs * 0.999);
  assert.equal(bot.status().positions[0].rebases, 0);
  await at(needs * 1.001);
  p = bot.status().positions[0];
  assert.deepEqual([p.rebases, p.cycles], [1, 0]);
  assert.ok(Math.abs(p.base - p.qty * needs * 1.001) < 1e-9);
  assert.ok(bot.status().events.some((e) => e.kind === 'rebase'));
  assert.ok(bot.status().trades.some((tr) => tr.kind === 'buy-back' && tr.profitUsd > 0));
});

test('stop-loss: a fall of 50% within 2 hours, seen three times in a row, sells everything and stops the coin', async () => {
  const { bot, orders, at } = setup();
  await bot.addCoin({ asset: 'SOL', usdt: 100 });
  for (let m = 0; m < 30; m++) await at(1);
  await at(0.45);
  await at(0.45);
  assert.equal(orders.length, 1); // twice is not enough
  await at(0.45);
  assert.equal(orders.at(-1)[0], 'sell');
  assert.equal(orders.at(-1)[1], 100);
  const p = bot.status().positions[0];
  assert.ok(p.stopped);
  await at(2); // stopped: nothing more for it
  assert.equal(orders.length, 2);
  assert.ok(bot.status().events.some((e) => e.kind === 'stop'));
});

test('paused: prices are read, no order is sent; the plan goes on after Resume', async () => {
  const { bot, orders, at } = setup();
  await bot.addCoin({ asset: 'SOL', usdt: 100 });
  bot.setPaused(true);
  await at(1.2);
  assert.equal(orders.length, 1);
  bot.setPaused(false);
  await at(1.2);
  assert.equal(orders.at(-1)[0], 'sell');
});

test('a coin the account holds joins without a buy; Sell all sells it and takes it out; errors in words', async () => {
  const { bot, orders, balances } = setup();
  balances.SOL = 40;
  await assert.rejects(bot.addCoin({ asset: 'SOL' }).then(() => bot.addCoin({ asset: 'SOL' })), /in the plan already/);
  assert.equal(orders.length, 0); // no buy: the 40 SOL held are the plan's
  assert.equal(bot.status().positions[0].base, 40);
  await bot.removeCoin({ asset: 'SOL', sell: true });
  assert.deepEqual(orders.at(-1), ['sell', 40, 1]);
  assert.equal(bot.status().positions.length, 0);
  await assert.rejects(bot.addCoin({ asset: 'BTC', usdt: 2 }), /smallest order/);
  await assert.rejects(bot.addCoin({ asset: 'ETH' }), /holds no ETH/);
  await assert.rejects(bot.addCoin({ asset: '' }), /coin symbol/);
});

test('the balance: every asset in dollars, its share, a history point every 5 minutes', async () => {
  const { bot, at, points } = setup();
  await bot.addCoin({ asset: 'SOL', usdt: 250 });
  await at(1.2, 6);
  const s = bot.status();
  assert.equal(Math.round(s.total), 750 + 250 * 1.2);
  assert.deepEqual(s.assets.map((a) => a.asset), ['USDT', 'SOL']);
  assert.ok(points.length >= 1 && points.at(-1).mode === 'paper');
});
