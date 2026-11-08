// The swing plan, as plain functions (no exchange, no clock): the bot asks nextAction() at the
// price now, sends the order it names, and records the fill with the apply* function.
//
// One position per coin:
//   - base: the dollar value the holding is kept at. When the holding is worth swingPct more
//     than the base, the part above the base is sold: one "lot", waiting for its buy-back.
//   - a lot is bought back when the price is swingPct under the price it was sold at, with all
//     the USDT its sale brought: more coins come back than were sold. One sale and its buy-back
//     make one cycle, and the coins gained are its profit.
//   - re-base: after rebaseCycles cycles, once nothing waits for a buy-back and the holding is
//     worth at least the base plus those cycles' profit, the base becomes the holding's value
//     now, so the swings that follow trade the bigger holding.
//   - stop-loss: a fall of stopLossPct within stopLossHours sells the whole holding (bot.js).

// The settings the program runs with. Only swingPct (Trading plan) and rebaseCycles (Settings)
// can be changed; the panel shows the rest as they are.
export const DEFAULTS = Object.freeze({
  swingPct: 15,
  swingChoices: [10, 12, 15, 20, 25],
  rankSwings: [10, 12, 15], // the swings the test wallet's coins are compared at
  rebaseCycles: 2,
  stopLossPct: 50,
  stopLossHours: 2,
  stopLossChecks: 3, // looks in a row below the line before the stop-loss sells (one odd price does not)
  tickSec: 10,
  quote: 'USDT',
  paperStartUsdt: 1000,
  paperFeePct: 0.1, // Binance's spot fee
});

let lotSeq = 0;
const lotId = (now) => `${now.toString(36)}-${(lotSeq++).toString(36)}`;

export function newPosition(asset, qty, price, now) {
  const base = qty * price;
  return {
    asset, pair: `${asset}${DEFAULTS.quote}`, qty, base, startBase: base, startedAt: now,
    lots: [], cycles: 0, totalCycles: 0, profitSinceRebase: 0, profitUsd: 0, rebases: 0, rebasedAt: null,
    stopped: null, stopStrikes: 0,
  };
}

// The next order the plan wants at `price`, or null. One at a time: buy-backs first (they finish
// cycles), then a sale, then a re-base (which sends no order).
const EPS = 1e-9; // a level reached exactly counts, whatever the floating point does to it
export function nextAction(pos, price, { swingPct, rebaseCycles, minNotional = 5 }) {
  if (pos.stopped || !(price > 0)) return null;
  const due = pos.lots.filter((l) => price <= l.buyAt * (1 + EPS)).sort((a, b) => b.buyAt - a.buyAt)[0];
  if (due) return { type: 'buyback', lotId: due.id, usdt: due.proceeds };
  const value = pos.qty * price;
  if (value >= pos.base * (1 + swingPct / 100) * (1 - EPS)) {
    const qty = pos.qty - pos.base / price;
    if (qty * price >= minNotional) return { type: 'sell', qty };
  }
  if (!pos.lots.length && pos.cycles >= rebaseCycles && value >= pos.base + pos.profitSinceRebase) return { type: 'rebase', base: value };
  return null;
}

// fill: { qty: coins sold, price, usdt: USDT received after the fee }
export function applySell(pos, fill, swingPct, now) {
  pos.qty = Math.max(0, pos.qty - fill.qty);
  const lot = { id: lotId(now), qty: fill.qty, sellPrice: fill.price, buyAt: fill.price * (1 - swingPct / 100), proceeds: fill.usdt, at: now };
  pos.lots.push(lot);
  return lot;
}

// fill: { qty: coins received after the fee, price, usdt: USDT spent }. Returns the cycle's profit in dollars.
export function applyBuyback(pos, lotId, fill, now) {
  const lot = pos.lots.find((l) => l.id === lotId);
  if (!lot) return null;
  pos.lots = pos.lots.filter((l) => l !== lot);
  pos.qty += fill.qty;
  const profitUsd = (fill.qty - lot.qty) * fill.price;
  pos.cycles += 1;
  pos.totalCycles += 1;
  pos.profitSinceRebase += profitUsd;
  pos.profitUsd += profitUsd;
  pos.lastCycleAt = now;
  return { profitUsd, lot };
}

export function applyRebase(pos, base, now) {
  const was = pos.base;
  pos.base = base;
  pos.cycles = 0;
  pos.profitSinceRebase = 0;
  pos.rebases += 1;
  pos.rebasedAt = now;
  return was;
}

// The stop-loss: the price now against the first price of the last stopLossHours (samples: [[time, price]], oldest first).
export function stopLossLine(samples, now, { stopLossPct, stopLossHours }) {
  const from = now - stopLossHours * 3_600_000;
  const ref = samples.find(([t]) => t >= from)?.[1];
  return ref > 0 ? { ref, line: ref * (1 - stopLossPct / 100) } : null;
}

// One price a minute is kept, for stopLossHours and a little more.
export function addSample(samples, price, now, hours) {
  const out = samples.filter(([t]) => t >= now - hours * 3_600_000 - 10 * 60_000);
  if (!out.length || now - out.at(-1)[0] >= 60_000) out.push([now, price]);
  return out;
}

// The levels shown in the panel: where the next sale fires, and each buy-back.
export function levels(pos, price, swingPct) {
  const sellAt = pos.qty > 0 ? (pos.base * (1 + swingPct / 100)) / pos.qty : null;
  return { value: pos.qty * price, sellAt, sellInPct: sellAt && price ? (sellAt / price - 1) * 100 : null, buyBacks: pos.lots.map((l) => ({ ...l, inPct: price ? (l.buyAt / price - 1) * 100 : null })) };
}
