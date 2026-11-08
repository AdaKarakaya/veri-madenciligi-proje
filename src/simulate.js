import { DEFAULTS, addSample, applyBuyback, applyRebase, applySell, newPosition, nextAction, stopLossLine } from './strategy.js';

// The plan run on past prices, in a moment: what it would have done with `usdt` of a coin over a
// period, at Binance's real prices then, with the pretend account's 0.1% fee. The same rules
// (strategy.js) as the bot, on the candles' closing prices.
//   prices: [[time, price], ...] oldest first
export function simulate(prices, { usdt, swingPct, rebaseCycles, feePct = DEFAULTS.paperFeePct, minNotional = 5 }) {
  if (prices.length < 2) throw new Error('Not enough prices for that period.');
  const keep = 1 - feePct / 100;
  const [t0, p0] = prices[0];
  const startQty = (usdt / p0) * keep;
  const pos = newPosition('X', startQty, p0, t0);
  let cash = 0; // the USDT the plan's sales bring, kept for their buy-backs
  const trades = [{ t: t0, side: 'buy', kind: 'start', qty: startQty, price: p0, usdt }];
  let samples = [];
  let stopped = null;
  for (const [t, p] of prices) {
    samples = addSample(samples, p, t, DEFAULTS.stopLossHours);
    const sl = stopLossLine(samples, t, DEFAULTS);
    if (sl && p <= sl.line) {
      // a candle's close is already a quarter or a full hour: one is enough here
      const got = pos.qty * p * keep;
      trades.push({ t, side: 'sell', kind: 'stop-loss', qty: pos.qty, price: p, usdt: got });
      cash += got;
      pos.qty = 0;
      pos.lots = [];
      stopped = { t, price: p, ref: sl.ref };
      break;
    }
    for (let i = 0; i < 5; i++) {
      const a = nextAction(pos, p, { swingPct, rebaseCycles, minNotional });
      if (!a) break;
      if (a.type === 'sell') {
        const got = a.qty * p * keep;
        cash += got;
        applySell(pos, { qty: a.qty, price: p, usdt: got }, swingPct, t);
        trades.push({ t, side: 'sell', kind: 'swing', qty: a.qty, price: p, usdt: got });
      } else if (a.type === 'buyback') {
        const spend = Math.min(a.usdt, cash);
        if (spend < minNotional) break;
        cash -= spend;
        const qty = (spend / p) * keep;
        const r = applyBuyback(pos, a.lotId, { qty, price: p, usdt: spend }, t);
        trades.push({ t, side: 'buy', kind: 'buy-back', qty, price: p, usdt: spend, profitUsd: r.profitUsd });
      } else if (a.type === 'rebase') {
        const was = applyRebase(pos, a.base, t);
        trades.push({ t, side: 'rebase', kind: 'rebase', price: p, from: was, to: a.base });
      }
    }
  }
  const [tEnd, pEnd] = prices.at(-1);
  const end = pos.qty * pEnd + cash;
  const hold = startQty * pEnd;
  // the price line, thinned to ~400 points for the chart
  const step = Math.max(1, Math.ceil(prices.length / 400));
  const series = prices.filter((_, i) => i % step === 0 || i === prices.length - 1);
  return {
    from: t0, to: tEnd, startPrice: p0, endPrice: pEnd, start: usdt,
    end, endPct: (end / usdt - 1) * 100, hold, holdPct: (hold / usdt - 1) * 100,
    coinsEnd: pos.qty, cashEnd: cash, cycles: pos.totalCycles, rebases: pos.rebases, profitUsd: pos.profitUsd,
    waiting: pos.lots.length, stopped, trades, series,
  };
}

// Which swing, and which coins at it, did best. rows: [{ asset, swingPct, endPct, cycles, profitUsd }].
// A coin counts only when the plan ended in profit with it AND completed at least one cycle (sale +
// buy-back); at each swing the counting coins are ranked by what their cycles earned, and the swing whose
// best `n` made the most in all wins (one with `n` counting coins before one with fewer).
export function bestSwing(rows, swings, n = 3) {
  const by = swings.map((swingPct) => {
    const list = rows.filter((r) => r.swingPct === swingPct).sort((a, b) => b.profitUsd - a.profitUsd || b.endPct - a.endPct);
    const top = list.filter((r) => r.endPct > 0 && r.cycles >= 1).slice(0, n);
    return { swingPct, list, top, totalPct: top.reduce((a, r) => a + r.endPct, 0) };
  });
  const best = [...by].sort((a, b) => (b.top.length >= n) - (a.top.length >= n) || b.totalPct - a.totalPct)[0];
  return { best, by };
}

// The candles a period is read in: a quarter of an hour up to 30 days, an hour beyond.
export const periodOf = (days) => (days <= 30 ? { interval: '15m', label: '15-minute' } : { interval: '1h', label: '1-hour' });
