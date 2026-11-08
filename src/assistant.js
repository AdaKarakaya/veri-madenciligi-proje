// Borsa Yardımcısı: the chat assistant in the corner of every page. It answers questions about
// markets and coins with Claude, which searches the web for fresh information (web_search, run on
// Anthropic's side), reads live prices from Binance (get_price) and can look at this bot's own
// plan and balance (get_bot_status). Each chat is kept here whole and only ever appended to: the
// model's earlier turns go back to it unchanged.

const MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 8; // model turns per question (tool calls and resumed searches included)
const CHAT_IDLE_MS = 6 * 3_600_000;

// Stable on purpose (no date or balances in it): the date goes with each question instead.
const SYSTEM = `You are "Borsa Yardımcısı" (Market Helper), the assistant built into Load Trading Bot.

Load Trading Bot is a student project: a swing-trading bot for Binance spot. For each coin in its plan it keeps a base value; when the holding is worth the swing percentage (15% by default) more than the base, it sells the part above the base, and when the price falls the same percentage below that sale it buys the coin back with the sale's USDT, so each up-and-down swing leaves more coins. After a set number of such cycles the base is raised to the holding's value. A stop-loss sells a coin that falls 50% within 2 hours. It runs in test mode (a pretend balance at Binance's real prices; its mode is called "paper"), on the Binance testnet, or on a live account, and it can simulate the plan on a coin's real past prices.

You answer the user's questions about markets, coins, stocks and this bot. Answer in the language the user writes in (usually Turkish). For anything that changes over time (prices, news, listings, project updates, regulation) search the web or check the price with your tools rather than answering from memory, and say when the information is from. Use get_price for a coin's live Binance price and 24-hour move, and get_bot_status when the question is about the user's own balance, plan or trades.

Be direct and brief: a few short paragraphs or a short list. You give information, not personal investment advice: you may explain risks, how a coin or strategy works, and what the numbers show, but the decision to buy or sell is the user's; say so in one line when a question asks you to decide for them.`;

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  {
    name: 'get_price',
    description: "Live price of a coin on Binance against USDT, with its 24-hour change, high, low and trading volume. Use it for any question about a coin's current price.",
    input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Coin symbol, e.g. BTC, ETH, SOL' } }, required: ['symbol'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_bot_status',
    description: "The user's own Load Trading Bot: account mode (paper, testnet or live), total balance and what it is in, the coins in the trading plan with their base value, next sell level, waiting buy-backs and profit, and the latest trades.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

// The answer's text, and the web pages it rests on (its citations first, else what the searches found).
export function answerOf(message) {
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const seen = new Map();
  for (const b of message.content) {
    if (b.type !== 'text') continue;
    for (const c of b.citations ?? []) if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
  }
  if (!seen.size) {
    for (const b of message.content) {
      if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue; // an error object instead of a list: nothing found
      for (const r of b.content.slice(0, 5)) if (r.url && !seen.has(r.url)) seen.set(r.url, r.title || r.url);
    }
  }
  return { text, sources: [...seen].map(([url, title]) => ({ url, title })).slice(0, 6) };
}

export function createAssistant({ settings, bot, log = console, loadSdk = () => import('@anthropic-ai/sdk'), now = () => Date.now() }) {
  const chats = new Map(); // chatId -> { messages, at, busy }

  async function runTool(name, input) {
    if (name === 'get_price') return JSON.stringify(await bot.market(input.symbol));
    if (name === 'get_bot_status') {
      const s = bot.status();
      return JSON.stringify({
        mode: s.mode, paused: s.paused, totalUsd: s.total, profitUsd: s.profitUsd,
        assets: s.assets.slice(0, 12).map((a) => ({ asset: a.asset, amount: a.amount, usd: a.usd })),
        plan: s.positions.map((p) => ({ coin: p.asset, qty: p.qty, price: p.price, valueUsd: p.value, baseUsd: p.base, nextSellPrice: p.sellAt, waitingBuyBacks: p.buyBacks.map((l) => ({ qty: l.qty, buyAt: l.buyAt })), cycles: p.cycles, profitUsd: p.profitUsd, stopped: Boolean(p.stopped) })),
        rules: { swingPct: s.rules.swingPct, rebaseCycles: s.rules.rebaseCycles, stopLoss: `${s.rules.stopLossPct}% within ${s.rules.stopLossHours} h` },
        lastTrades: s.trades.slice(0, 10).map((t) => ({ time: new Date(t.t).toISOString(), coin: t.asset, side: t.side, kind: t.kind, qty: t.qty, price: t.price, usdt: t.usdt })),
      });
    }
    throw new Error(`unknown tool ${name}`);
  }

  async function ask(chatId, question) {
    const text = String(question ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('Write a question.');
    const apiKey = settings.get().anthropicKey;
    if (!apiKey) throw Object.assign(new Error('Borsa Yardımcısı needs an Anthropic API key: add it under Settings.'), { userFacing: true });
    let Anthropic;
    try {
      ({ default: Anthropic } = await loadSdk());
    } catch {
      throw Object.assign(new Error("Borsa Yardımcısı's library is not installed: run npm install in the program's folder once."), { userFacing: true });
    }
    for (const [id, c] of chats) if (now() - c.at > CHAT_IDLE_MS) chats.delete(id);
    const chat = chats.get(chatId) ?? { messages: [], at: now(), busy: false };
    chats.set(chatId, chat);
    if (chat.busy) throw Object.assign(new Error('Still answering the last question.'), { userFacing: true });
    chat.busy = true;
    chat.at = now();
    const client = new Anthropic({ apiKey });
    const messages = chat.messages;
    const startLen = messages.length;
    messages.push({ role: 'user', content: `(Today is ${new Date(now()).toISOString().slice(0, 10)}.)\n\n${text}` });
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          output_config: { effort: 'medium' },
          // a declined request is answered by the fallback model the API picks, inside the same call
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        messages.push({ role: 'assistant', content: r.content });
        if (r.stop_reason === 'pause_turn') continue; // a long web search: sent back so the server goes on
        if (r.stop_reason === 'tool_use') {
          const results = [];
          for (const b of r.content.filter((x) => x.type === 'tool_use')) {
            try {
              results.push({ type: 'tool_result', tool_use_id: b.id, content: await runTool(b.name, b.input ?? {}) });
            } catch (e) {
              results.push({ type: 'tool_result', tool_use_id: b.id, content: `Error: ${e.message}`, is_error: true });
            }
          }
          messages.push({ role: 'user', content: results });
          continue;
        }
        if (r.stop_reason === 'refusal') return { text: "I can't help with that question.", sources: [] };
        const answer = answerOf(r);
        if (r.stop_reason === 'max_tokens') answer.text += '\n\n(The answer was cut off: ask for the rest.)';
        return answer;
      }
      return { text: 'That took too many steps: ask a narrower question.', sources: [] };
    } catch (e) {
      // the question and any half-finished turns come off the end, so the chat goes on from where it stood
      messages.length = startLen;
      throw friendly(e, Anthropic);
    } finally {
      chat.busy = false;
    }
  }

  function friendly(e, Anthropic) {
    const say = (m) => Object.assign(new Error(m), { userFacing: true });
    if (e instanceof Anthropic.AuthenticationError) return say('The Anthropic API key was refused: check it under Settings.');
    if (e instanceof Anthropic.PermissionDeniedError) return say('This Anthropic API key may not use this model.');
    if (e instanceof Anthropic.RateLimitError) return say('Too many questions at once for this API key: try again in a minute.');
    if (e instanceof Anthropic.APIConnectionError) return say('Could not reach Anthropic: check the internet connection.');
    if (e instanceof Anthropic.APIError) {
      if (e.status === 402 || e.type === 'billing_error') return say('The Anthropic account has no credit left.');
      if (e.status >= 500) return say('Anthropic is busy right now: try again shortly.');
      log.warn?.(`assistant: ${e.message}`);
      return say(`Anthropic refused the request (${e.status}).`);
    }
    log.warn?.(`assistant: ${e.message}`);
    return e;
  }

  return {
    ask,
    reset(chatId) {
      chats.delete(chatId);
      return true;
    },
  };
}
