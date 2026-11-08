import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './strategy.js';

// JSON files in the data folder, written whole through a temporary file so that a crash
// mid-write never leaves half a file.
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The owner's settings: the keys, and the two rules that can be changed.
// testMode: the pretend balance at real prices, also when Binance keys are saved (the switch at the top)
const SETTINGS_DEFAULTS = { binanceKey: '', binanceSecret: '', testnet: true, testMode: true, anthropicKey: '', swingPct: DEFAULTS.swingPct, rebaseCycles: DEFAULTS.rebaseCycles };

export function createSettings(file) {
  let data = { ...SETTINGS_DEFAULTS, ...readJson(file, {}) };
  const save = () => writeJson(file, data);
  return {
    get: () => ({ ...data }),
    // only known fields; an empty secret field in the form keeps the saved one
    update(patch) {
      const next = { ...data };
      for (const k of ['binanceKey', 'binanceSecret', 'anthropicKey']) if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim();
      // saving Binance keys means using them: test mode goes off (the switch at the top turns it back on)
      if ((patch.binanceKey?.trim() || patch.binanceSecret?.trim()) && next.binanceKey && next.binanceSecret) next.testMode = false;
      if (typeof patch.testMode === 'boolean') next.testMode = patch.testMode;
      if (patch.clearBinance) Object.assign(next, { binanceKey: '', binanceSecret: '', testMode: true });
      if (patch.clearAnthropic) next.anthropicKey = '';
      if (typeof patch.testnet === 'boolean') next.testnet = patch.testnet;
      if (patch.swingPct != null) {
        if (!DEFAULTS.swingChoices.includes(Number(patch.swingPct))) throw new Error(`Swing must be one of ${DEFAULTS.swingChoices.join(', ')}%`);
        next.swingPct = Number(patch.swingPct);
      }
      if (patch.rebaseCycles != null) {
        const n = Number(patch.rebaseCycles);
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('Re-base cycles must be a whole number from 1 to 20');
        next.rebaseCycles = n;
      }
      data = next;
      save();
      return this.get();
    },
    // what the panel may see: never a key, only whether one is saved and its last characters
    view() {
      const tail = (s) => (s ? `••••${s.slice(-4)}` : '');
      return {
        binanceKey: tail(data.binanceKey), binanceSecret: data.binanceSecret ? '••••••••' : '', testnet: data.testnet,
        anthropicKey: tail(data.anthropicKey), swingPct: data.swingPct, rebaseCycles: data.rebaseCycles,
        mode: modeOf(data), hasBinance: Boolean(data.binanceKey && data.binanceSecret),
      };
    },
  };
}

// "paper" is test mode (the pretend balance): always without keys, and with them while the switch says so;
// else Binance's testnet or the live exchange, as the owner ticked
export const modeOf = (s) => (s.binanceKey && s.binanceSecret && !s.testMode ? (s.testnet ? 'testnet' : 'live') : 'paper');

// The bot's memory: positions, trades, the paper account, price samples for the stop-loss.
export function createState(file) {
  const data = readJson(file, null) ?? {};
  data.positions ??= {};
  data.trades ??= [];
  data.samples ??= {};
  data.paper ??= null;
  data.paused ??= false;
  return { data, save: () => writeJson(file, data) };
}

// The total balance over time, one line every few minutes.
export function createHistory(file) {
  return {
    add(point) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(point)}\n`);
    },
    since(t) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((p) => p && p.t >= t);
    },
  };
}
