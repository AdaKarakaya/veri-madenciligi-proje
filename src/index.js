import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistant } from './assistant.js';
import { createBot } from './bot.js';
import { createServer } from './server.js';
import { createHistory, createSettings, createState } from './store.js';

// Load Trading Bot: starts the bot and its panel at http://127.0.0.1:8790 (PORT changes it).
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const PORT = Number(process.env.PORT) || 8790;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

const settings = createSettings(path.join(DATA_DIR, 'settings.json'));
const state = createState(path.join(DATA_DIR, 'state.json'));
const history = createHistory(path.join(DATA_DIR, 'history.jsonl'));
const bot = createBot({ settings, state, history, log });
const assistant = createAssistant({ settings, bot, log });
const server = createServer({ bot, settings, history, assistant, srcDir: here, log });

server.on('error', (e) => {
  log.error(e.code === 'EADDRINUSE' ? `port ${PORT} is in use: is Load Trading Bot already running? Close it, or set PORT.` : e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  log.info(`Load Trading Bot is running: ${url} (${settings.view().mode} mode)`);
  if (process.argv.includes('--open')) exec(process.platform === 'win32' ? `start "" ${url}` : `open ${url}`);
  bot.start();
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    bot.stop();
    state.save();
    process.exit(0);
  });
}
