import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, createAssistant } from '../src/assistant.js';

// A stand-in for the Anthropic SDK: answers from a script and keeps what it was sent.
function fakeSdk(script) {
  const sent = [];
  class APIError extends Error {
    constructor(status, message, type) { super(message); this.status = status; this.type = type; }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  class Anthropic {
    constructor({ apiKey }) {
      this.apiKey = apiKey;
      this.beta = { messages: { create: async (params) => {
        sent.push(structuredClone(params));
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next;
      } } };
    }
  }
  Object.assign(Anthropic, { APIError, AuthenticationError, PermissionDeniedError, RateLimitError, APIConnectionError });
  return { sdk: async () => ({ default: Anthropic }), sent, Anthropic };
}

const settings = (key = 'sk-ant-test') => ({ get: () => ({ anthropicKey: key }) });
const bot = {
  market: async (symbol) => ({ pair: `${symbol}USDT`, price: 150.5, change24hPct: -2.1 }),
  status: () => ({ mode: 'paper', paused: false, total: 1000, profitUsd: 3, assets: [], positions: [], rules: { swingPct: 15, rebaseCycles: 2, stopLossPct: 50, stopLossHours: 2 }, trades: [] }),
};

test('a question: the model asks for a price, gets it, and answers with its sources; the chat is kept whole', async () => {
  const { sdk, sent } = fakeSdk([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'get_price', input: { symbol: 'SOL' } }] },
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'solana news' } }] },
    { stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', tool_use_id: 'st1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A' }] },
      { type: 'text', text: 'SOL is at $150.50, ', citations: [{ type: 'web_search_result_location', url: 'https://news.example/sol', title: 'SOL news' }] },
      { type: 'text', text: 'down 2.1% today.' },
    ] },
  ]);
  const a = createAssistant({ settings: settings(), bot, log: { warn() {} }, loadSdk: sdk, now: () => Date.parse('2026-11-07T10:00:00Z') });
  const r = await a.ask('c1', 'Solana ne durumda?');
  assert.equal(r.text, 'SOL is at $150.50, down 2.1% today.');
  assert.deepEqual(r.sources, [{ url: 'https://news.example/sol', title: 'SOL news' }]); // the citation, not every search hit
  assert.equal(sent.length, 3);
  assert.equal(sent[0].model, 'claude-opus-5-5');
  assert.equal(sent[0].fallbacks, 'default');
  assert.ok(sent[0].tools.some((t) => t.type === 'web_search_20260209'));
  assert.match(sent[0].messages[0].content, /Today is 2026-11-07[\s\S]*Solana ne durumda\?/);
  // the price went back as the tool's result, and the paused search was sent back as it was
  const toolResult = sent[1].messages[2].content[0];
  assert.deepEqual([toolResult.type, toolResult.tool_use_id, JSON.parse(toolResult.content).price], ['tool_result', 'tu1', 150.5]);
  assert.equal(sent[2].messages.at(-1).role, 'assistant');
  // the system prompt never changes between requests (the date goes with the question)
  assert.equal(sent[0].system, sent[2].system);
});

test('a follow-up goes after the whole earlier exchange; a failed question comes off again, so the chat goes on from where it stood', async () => {
  const script = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi!' }] }];
  const { sdk, sent, Anthropic } = fakeSdk(script);
  const a = createAssistant({ settings: settings(), bot, log: { warn() {} }, loadSdk: sdk });
  await a.ask('c2', 'hello');
  script.push(new Anthropic.AuthenticationError(401, 'invalid x-api-key', 'authentication_error'));
  await assert.rejects(a.ask('c2', 'second'), /was refused: check it under Settings/);
  script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Again.' }] });
  assert.equal((await a.ask('c2', 'third')).text, 'Again.');
  const last = sent.at(-1).messages;
  assert.deepEqual(last.map((m) => m.role), ['user', 'assistant', 'user']); // "second" is not in it
  assert.deepEqual(last[1].content, [{ type: 'text', text: 'Hi!' }]); // the earlier turn as it came back
  assert.match(last[2].content, /third/);
  // another chat starts empty
  script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'New.' }] });
  await a.ask('other', 'x');
  assert.equal(sent.at(-1).messages.length, 1);
});

test('without a key, or without the library, it says what to do', async () => {
  await assert.rejects(createAssistant({ settings: settings(''), bot, loadSdk: async () => ({}) }).ask('x', 'hi'), /needs an Anthropic API key/);
  await assert.rejects(createAssistant({ settings: settings(), bot, loadSdk: async () => { throw new Error('Cannot find package'); } }).ask('x', 'hi'), /npm install/);
});

test('answer text and sources: search hits stand in when nothing is cited; a failed search is not a list', () => {
  const r = answerOf({ content: [
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_search_tool_result', content: [{ url: 'https://a.example', title: 'A' }, { url: 'https://a.example', title: 'A again' }] },
    { type: 'text', text: ' Answer ' },
  ] });
  assert.deepEqual(r, { text: 'Answer', sources: [{ url: 'https://a.example', title: 'A' }] });
});
