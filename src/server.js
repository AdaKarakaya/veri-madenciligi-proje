import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// The panel: one page (panel.html, read on every request) and a small JSON API, on this computer
// only (127.0.0.1). Requests that change something must carry the header "x-panel: 1", which a
// page from another site cannot add, so no other site can press the bot's buttons.

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch {
        reject(new Error('the request is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ bot, settings, history, assistant, srcDir, log = console }) {
  const ranges = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Infinity };
  const routes = {
    'GET /api/status': () => bot.status(),
    'GET /api/history': (req) => {
      const range = new URL(req.url, 'http://x').searchParams.get('range') ?? '7d';
      const mode = bot.status().mode;
      const pts = history.since(Date.now() - (ranges[range] ?? ranges['7d'])).filter((p) => p.mode === mode);
      const step = Math.max(1, Math.ceil(pts.length / 400)); // at most ~400 points to draw
      return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    },
    'POST /api/plan/add': async (req) => bot.addCoin(await readBody(req)),
    'POST /api/plan/remove': async (req) => bot.removeCoin(await readBody(req)),
    'POST /api/plan/swing': async (req) => settings.update({ swingPct: (await readBody(req)).swingPct }).swingPct,
    'POST /api/pause': async (req) => bot.setPaused((await readBody(req)).paused),
    'POST /api/settings': async (req) => {
      const body = await readBody(req);
      settings.update(body);
      if (['binanceKey', 'binanceSecret', 'testnet', 'clearBinance'].some((k) => k in body)) await bot.reconnect();
      return settings.view();
    },
    'POST /api/settings/test': () => bot.testConnection(),
    // the switch at the top: test mode (pretend balance, real prices) or the Binance account
    'POST /api/mode': async (req) => {
      const test = Boolean((await readBody(req)).test);
      if (!test && !settings.get().binanceKey) throw new Error('Add your Binance API key under Settings first.');
      settings.update({ testMode: test });
      await bot.reconnect();
      return settings.view();
    },
    'POST /api/simulate': async (req) => bot.simulate(await readBody(req)),
    'GET /api/ranking': () => bot.ranking(),
    'POST /api/paper/reset': () => bot.resetPaper(),
    'POST /api/assistant': async (req) => {
      const body = await readBody(req);
      return assistant.ask(String(body.chatId ?? 'default').slice(0, 64), body.text);
    },
    'POST /api/assistant/reset': async (req) => assistant.reset(String((await readBody(req)).chatId ?? 'default').slice(0, 64)),
  };

  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      try {
        return send(200, fs.readFileSync(path.join(srcDir, 'panel.html'), 'utf8'), 'text/html');
      } catch (e) {
        return send(500, e.message, 'text/plain');
      }
    }
    const handler = routes[route];
    if (!handler) return send(404, { error: 'not found' });
    if (req.method !== 'GET' && req.headers['x-panel'] !== '1') return send(403, { error: 'refused' });
    try {
      send(200, (await handler(req)) ?? null);
    } catch (e) {
      if (!e.userFacing) log.warn?.(`${route}: ${e.message}`);
      send(400, { error: e.message });
    }
  });
}
