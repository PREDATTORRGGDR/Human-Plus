// Провайдери ШІ на підроблених відповідях (мережі немає): потік тексту, виклики інструментів, відмови й помилки.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError } from '../src/ai/errors.js';
import {
  createAnthropicProvider,
  echoBlocks,
  toAnthropicMessages,
} from '../src/ai/providers/anthropic.js';
import { createProvider, guardFetch } from '../src/ai/providers/index.js';
import { TOOL_DEFS } from '../src/ai/tools.js';
import { anthropicStream, jsonResponse } from './ai-helpers.js';

const KEY = 'sk-ant-api03-TESTKEYabcdefghijklmnopqrstuvwxyz0123456789';
const req = (over = {}) => ({
  system: 'sys',
  tools: TOOL_DEFS.slice(0, 3),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'привіт' }] }],
  maxTokens: 100,
  ...over,
});

function recorder(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === 'function' ? r() : r;
  };
  return { fetch, calls };
}

test('Anthropic: потік тексту, явна адреса API, ключ лише в x-api-key, strict-інструменти, fallbacks, кеш промпту', async () => {
  const { fetch, calls } = recorder([() => anthropicStream({ text: 'Привіт! Чим допомогти?' })]);
  const p = createAnthropicProvider({ apiKey: KEY, fetch });
  let streamed = '';
  const r = await p.turn({ ...req(), onText: (d) => (streamed += d) });
  assert.equal(streamed, 'Привіт! Чим допомогти?');
  assert.equal(r.stopReason, 'end');
  assert.deepEqual(r.blocks, [{ type: 'text', text: 'Привіт! Чим допомогти?' }]);
  const c = calls[0];
  assert.ok(c.url.startsWith('https://api.anthropic.com/v1/messages'));
  const hdr = new Headers(c.init.headers);
  assert.equal(hdr.get('x-api-key'), KEY);
  assert.equal(hdr.get('authorization'), null);
  assert.match(hdr.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(c.body.model, 'claude-sonnet-5-5');
  assert.equal(c.body.fallbacks, 'default');
  assert.equal(c.body.stream, true);
  assert.ok(
    c.body.tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false),
  );
  assert.equal(c.body.system[0].cache_control.type, 'ephemeral');
  assert.equal(c.body.thinking, undefined);
});

test('Anthropic: змінні оточення не перенаправляють запит і не підмінюють ключ', async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_BASE_URL = 'https://evil.example.org';
  process.env.ANTHROPIC_AUTH_TOKEN = 'leak-token';
  try {
    const { fetch, calls } = recorder([() => anthropicStream({ text: 'ok' })]);
    await createAnthropicProvider({ apiKey: KEY, fetch }).turn(req());
    assert.ok(calls[0].url.startsWith('https://api.anthropic.com/'));
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), null);
  } finally {
    process.env = saved;
  }
});

test('Anthropic: виклик інструмента повертає tool_use і сирі блоки для наступного кроку', async () => {
  const { fetch } = recorder([
    () =>
      anthropicStream({
        text: 'Дивлюсь',
        tool: { id: 'tu_1', name: 'get_homework', input: { status: 'pending' } },
        stop: 'tool_use',
      }),
  ]);
  const r = await createAnthropicProvider({ apiKey: KEY, fetch }).turn(req());
  assert.equal(r.stopReason, 'tool_use');
  assert.deepEqual(r.blocks[1], {
    type: 'tool_use',
    id: 'tu_1',
    name: 'get_homework',
    input: { status: 'pending' },
  });
  assert.equal(r.raw.provider, 'anthropic');
  // сирі блоки підставляються замість нейтральних лише для тієї ж моделі
  const msgs = toAnthropicMessages(
    [{ role: 'assistant', content: r.blocks, raw: r.raw }],
    'claude-sonnet-5-5',
  );
  assert.equal(msgs[0].content, r.raw.blocks);
  const other = toAnthropicMessages(
    [{ role: 'assistant', content: r.blocks, raw: r.raw }],
    'claude-opus-5-5',
  );
  assert.notEqual(other[0].content, r.raw.blocks);
});

test('Anthropic: результат інструмента зі зображенням сторінки', () => {
  const m = toAnthropicMessages(
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            id: 't',
            text: 'стор.',
            image: { mediaType: 'image/jpeg', data: 'AAA' },
          },
        ],
      },
    ],
    'm',
  );
  assert.equal(m[0].content[0].type, 'tool_result');
  assert.equal(m[0].content[0].content[1].source.media_type, 'image/jpeg');
});

test('Anthropic: відмова (stop_reason refusal) і блоки після переходу на запасну модель', async () => {
  const { fetch } = recorder([() => anthropicStream({ text: 'част', stop: 'refusal' })]);
  const r = await createAnthropicProvider({ apiKey: KEY, fetch }).turn(req());
  assert.equal(r.stopReason, 'refusal');
  const echo = echoBlocks([
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'tool_use', id: 'a', name: 'x', input: {} },
    { type: 'text', text: 'до' },
    { type: 'fallback', from: {}, to: {} },
    { type: 'thinking', thinking: '', signature: 's2' },
    { type: 'text', text: 'після' },
    { type: 'weird_block' },
  ]);
  assert.deepEqual(
    echo.map((b) => b.type),
    ['text', 'thinking', 'text'],
  );
});

test('Anthropic: помилки HTTP → коди (ключ, ліміт, перевантаження, запит), без витоку ключа в повідомленні', async () => {
  const cases = [
    [
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      'auth',
    ],
    [
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'rate_limit',
    ],
    [
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      'overloaded',
    ],
    [
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
      'bad_request',
    ],
    [500, { type: 'error', error: { type: 'api_error', message: 'oops' } }, 'server'],
  ];
  for (const [status, body, code] of cases) {
    const { fetch, calls } = recorder([() => jsonResponse(status, body)]);
    await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch }).turn(req()), (e) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.code, code);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    // 429/5xx SDK повторює (до 2 разів), 400/401 — ні
    assert.equal(calls.length, ['auth', 'bad_request'].includes(code) ? 1 : 3);
  }
  const net = recorder([() => Promise.reject(new TypeError('fetch failed'))]);
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, fetch: net.fetch }).turn(req()),
    (e) => e.code === 'network',
  );
});

test('Anthropic: зупинка користувачем → aborted', async () => {
  const ac = new AbortController();
  const fetch = (url, init) =>
    new Promise((_, rej) =>
      init.signal.addEventListener('abort', () =>
        rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      ),
    );
  const p = createAnthropicProvider({ apiKey: KEY, fetch }).turn({ ...req(), signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
});

test('запити до ШІ лише на дозволені хости; без ключа провайдер не створюється', async () => {
  const f = guardFetch(async () => new Response('ok'), {
    openaiBase: 'https://llm.example.org/v1',
  });
  assert.equal((await f('https://api.anthropic.com/v1/messages')).status, 200);
  assert.equal((await f('https://llm.example.org/v1/chat/completions')).status, 200);
  await assert.rejects(f('https://evil.example.org/'), (e) => e.code === 'bad_request');
  await assert.rejects(f('http://api.anthropic.com/v1/messages'), (e) => e.code === 'bad_request');
  const g = guardFetch(async () => new Response('ok'), { openaiBase: 'https://127.0.0.1/v1' });
  await assert.rejects(g('https://127.0.0.1/v1/chat/completions'), (e) => e.code === 'bad_request');
  assert.throws(
    () => createProvider({ settings: { aiProvider: 'anthropic' }, key: null, fetch }),
    (e) => e.code === 'no_key',
  );
});
