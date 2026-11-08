import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, addSample, applyBuyback, applyRebase, applySell, newPosition, nextAction, stopLossLine } from '../src/strategy.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const cfg = { swingPct: 15, rebaseCycles: 2, minNotional: 5 };

test('a holding worth 15% over its base sells the part above the base; under that, nothing', () => {
  const pos = newPosition('SOL', 100, 1, 0); // $100 base
  assert.equal(nextAction(pos, 1.14, cfg), null);
  const a = nextAction(pos, 1.15, cfg);
  assert.equal(a.type, 'sell');
  near(a.qty, 100 - 100 / 1.15); // what is left is worth the base again
  assert.equal(nextAction(newPosition('SOL', 3, 1, 0), 1.2, cfg), null); // $0.60 above the base: under Binance's smallest order
});

test('a sale is bought back 15% under its price with all its USDT: more coins come back, one cycle, its profit', () => {
  const pos = newPosition('SOL', 100, 1, 0);
  const qty = 100 - 100 / 1.15;
  const lot = applySell(pos, { qty, price: 1.15, usdt: qty * 1.15 }, 15, 1);
  near(lot.buyAt, 1.15 * 0.85);
  assert.equal(nextAction(pos, 0.98, cfg), null); // not low enough yet
  const a = nextAction(pos, 0.9775, cfg);
  assert.deepEqual([a.type, a.lotId], ['buyback', lot.id]);
  near(a.usdt, 15);
  const back = 15 / 0.9775;
  const r = applyBuyback(pos, lot.id, { qty: back, price: 0.9775, usdt: 15 }, 2);
  near(r.profitUsd, (back - qty) * 0.9775);
  assert.equal(pos.cycles, 1);
  assert.equal(pos.lots.length, 0);
  near(pos.qty, 100 - qty + back);
});

test('a higher sale waits for its own buy-back; the next sale comes another 15% up', () => {
  const pos = newPosition('ETH', 10, 100, 0); // $1000
  const q1 = 10 - 1000 / 115;
  applySell(pos, { qty: q1, price: 115, usdt: q1 * 115 }, 15, 1);
  assert.equal(nextAction(pos, 120, cfg), null);
  const a = nextAction(pos, 132.25, cfg); // 115 × 1.15
  assert.equal(a.type, 'sell');
  near(a.qty * 132.25, 150, 1e-6); // the holding is worth $1150 again: $150 above the $1000 base
});

test('re-base: after the set cycles, nothing waiting, and the holding worth the base plus their profit, the base becomes its value', () => {
  const pos = newPosition('SOL', 100, 1, 0);
  let profit = 0;
  for (let i = 0; i < 2; i++) {
    const a = nextAction(pos, 1.15, cfg);
    const lot = applySell(pos, { qty: a.qty, price: 1.15, usdt: a.qty * 1.15 }, 15, i);
    const b = nextAction(pos, lot.buyAt, cfg);
    profit += applyBuyback(pos, b.lotId, { qty: b.usdt / lot.buyAt, price: lot.buyAt, usdt: b.usdt }, i).profitUsd;
  }
  assert.equal(pos.cycles, 2);
  // at the buy-back's price the holding is worth less than base + profit: no re-base yet
  assert.equal(nextAction(pos, 0.9775, cfg), null);
  const needs = (100 + profit) / pos.qty; // the price where it is worth the base plus the profit
  const r = nextAction(pos, needs * 1.001, cfg);
  assert.equal(r.type, 'rebase');
  near(r.base, pos.qty * needs * 1.001);
  applyRebase(pos, r.base, 9);
  assert.deepEqual([pos.cycles, pos.rebases, pos.profitSinceRebase], [0, 1, 0]);
  assert.ok(pos.base > 100);
  // one cycle is not enough with the setting at 2
  assert.equal(nextAction(pos, needs * 1.002, cfg), null);
});

test('no re-base while a sale waits for its buy-back', () => {
  const pos = newPosition('SOL', 100, 1, 0);
  pos.cycles = 5;
  applySell(pos, { qty: 10, price: 1.15, usdt: 11.5 }, 15, 1);
  assert.equal(nextAction(pos, 1.1, cfg), null);
});

test('stop-loss line: the first price of the last 2 hours, less 50%; one price a minute is kept', () => {
  let s = [];
  for (let m = 0; m <= 150; m++) s = addSample(s, 100 - m * 0.1, m * 60_000, 2);
  const now = 150 * 60_000;
  const sl = stopLossLine(s, now, DEFAULTS);
  near(sl.ref, 100 - 30 * 0.1, 1e-9); // the sample 120 minutes back
  near(sl.line, sl.ref * 0.5);
  assert.deepEqual(addSample(s, 1, now + 10_000, 2).at(-1), s.at(-1)); // a second price within the minute is not kept
  assert.deepEqual(addSample(s, 1, now + 60_000, 2).at(-1), [now + 60_000, 1]);
});
