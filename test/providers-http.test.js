// OpenAI-сумісний провайдер і Gemini (сирий HTTP) на підроблених відповідях: потік, інструменти, відмови, помилки, повтори.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProvider } from '../src/ai/providers/index.js';
import { createOpenAiProvider, toOpenAiMessages } from '../src/ai/providers/openai.js';
import {
  classifyGemini,
  createGeminiProvider,
  geminiSchema,
  toGeminiContents,
} from '../src/ai/providers/gemini.js';
import { TOOL_DEFS } from '../src/ai/tools.js';
import { jsonResponse, sse } from './ai-helpers.js';

const noSleep = async () => {};
const OKEY = 'sk-proj-TESTKEYabcdefghijklmnopqrstuvwxyz';
const GKEY = 'AIzaSyTESTKEYabcdefghijklmnopqrstuv';
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
const delta = (d, finish = null) => ({ data: { choices: [{ delta: d, finish_reason: finish }] } });

test('OpenAI: потік тексту, виклики інструментів частинами, ключ лише в Authorization', async () => {
  const { fetch, calls } = recorder([
    () =>
      sse([
        delta({ role: 'assistant', content: 'При' }),
        delta({ content: 'віт' }),
        delta({
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_', arguments: '{"sta' } }],
        }),
        delta({
          tool_calls: [{ index: 0, function: { name: 'homework', arguments: 'tus":"all"}' } }],
        }),
        delta({}, 'tool_calls'),
        { data: { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } } },
        { data: '[DONE]' },
      ]),
  ]);
  let streamed = '';
  const p = createOpenAiProvider({ apiKey: OKEY, fetch, sleep: noSleep });
  const r = await p.turn({ ...req(), onText: (d) => (streamed += d) });
  assert.equal(streamed, 'Привіт');
  assert.equal(r.stopReason, 'tool_use');
  assert.deepEqual(r.blocks[1], {
    type: 'tool_use',
    id: 'call_1',
    name: 'get_homework',
    input: { status: 'all' },
  });
  assert.deepEqual(r.usage, { input: 9, output: 3 });
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.init.headers.authorization, `Bearer ${OKEY}`);
  assert.ok(!c.url.includes(OKEY));
  assert.equal(c.body.max_completion_tokens, 100);
  assert.equal(c.body.tools[0].function.name, 'get_schedule');
  assert.equal(c.body.messages[0].role, 'system');
});

test('OpenAI-сумісний сервіс за власною адресою: max_tokens; зламаний JSON аргументів позначено як некоректний', async () => {
  const { fetch, calls } = recorder([
    () =>
      sse([
        delta(
          {
            tool_calls: [
              { index: 0, id: 'c', function: { name: 'get_grades', arguments: '{bad' } },
            ],
          },
          'tool_calls',
        ),
      ]),
  ]);
  const r = await createOpenAiProvider({
    apiKey: OKEY,
    fetch,
    baseUrl: 'https://llm.example.org/v1/',
    sleep: noSleep,
  }).turn(req());
  assert.equal(calls[0].url, 'https://llm.example.org/v1/chat/completions');
  assert.equal(calls[0].body.max_tokens, 100);
  assert.deepEqual(r.blocks[0].input, { __invalid: true });
});

test('OpenAI: відмова (refusal / content_filter), ліміт довжини, помилки з повторами, без ключа в тексті помилки', async () => {
  for (const events of [
    [delta({ refusal: 'Не можу' }, 'stop')],
    [delta({ content: 'x' }, 'content_filter')],
  ]) {
    const { fetch } = recorder([() => sse(events)]);
    assert.equal(
      (await createOpenAiProvider({ apiKey: OKEY, fetch }).turn(req())).stopReason,
      'refusal',
    );
  }
  const len = recorder([() => sse([delta({ content: 'x' }, 'length')])]);
  assert.equal(
    (await createOpenAiProvider({ apiKey: OKEY, fetch: len.fetch }).turn(req())).stopReason,
    'max_tokens',
  );
  for (const [status, code, tries] of [
    [401, 'auth', 1],
    [429, 'rate_limit', 3],
    [503, 'overloaded', 3],
    [500, 'server', 3],
    [404, 'bad_request', 1],
  ]) {
    const { fetch, calls } = recorder([
      () => jsonResponse(status, { error: { message: `secret ${OKEY}` } }),
    ]);
    await assert.rejects(
      createOpenAiProvider({ apiKey: OKEY, fetch, sleep: noSleep }).turn(req()),
      (e) => {
        assert.equal(e.code, code);
        assert.ok(!e.message.includes(OKEY));
        return true;
      },
    );
    assert.equal(calls.length, tries);
  }
  const flaky = recorder([
    () => jsonResponse(429, {}),
    () => sse([delta({ content: 'ок' }, 'stop')]),
  ]);
  const ok = await createOpenAiProvider({ apiKey: OKEY, fetch: flaky.fetch, sleep: noSleep }).turn(
    req(),
  );
  assert.equal(ok.blocks[0].text, 'ок');
  const net = recorder([() => Promise.reject(new TypeError('fetch failed'))]);
  await assert.rejects(
    createOpenAiProvider({ apiKey: OKEY, fetch: net.fetch, sleep: noSleep }).turn(req()),
    (e) => e.code === 'network',
  );
  assert.equal(net.calls.length, 3);
});

test('OpenAI: результати інструментів і зображення сторінки у форматі Chat Completions', () => {
  const m = toOpenAiMessages('sys', [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'get_page', input: { book_id: 'b', page: 3 } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'c1',
          name: 'get_page',
          text: 'скан',
          image: { mediaType: 'image/jpeg', data: 'AAA' },
        },
      ],
    },
  ]);
  assert.deepEqual(
    m.map((x) => x.role),
    ['system', 'user', 'assistant', 'tool', 'user'],
  );
  assert.equal(m[2].tool_calls[0].function.arguments, '{"book_id":"b","page":3}');
  assert.equal(m[3].tool_call_id, 'c1');
  assert.equal(m[4].content[1].image_url.url, 'data:image/jpeg;base64,AAA');
});

test('Gemini: потік, виклик функції з thoughtSignature повертається в наступному кроці, ключ у заголовку', async () => {
  const { fetch, calls } = recorder([
    () =>
      sse([
        { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Дивлюсь ' }] } }] } },
        {
          data: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'думки', thought: true },
                    {
                      functionCall: { name: 'get_grades', args: { subject: 'Алгебра' } },
                      thoughtSignature: 'sig1',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          },
        },
      ]),
  ]);
  let streamed = '';
  const p = createGeminiProvider({
    apiKey: GKEY,
    model: 'gemini-flash-latest',
    fetch,
    sleep: noSleep,
  });
  const r = await p.turn({ ...req(), onText: (d) => (streamed += d) });
  assert.equal(streamed, 'Дивлюсь ');
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.blocks[1].name, 'get_grades');
  assert.deepEqual(r.blocks[1].input, { subject: 'Алгебра' });
  const c = calls[0];
  assert.equal(
    c.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse',
  );
  assert.equal(c.init.headers['x-goog-api-key'], GKEY);
  assert.ok(!c.url.includes(GKEY));
  assert.equal(c.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(JSON.stringify(c.body.tools).includes('additionalProperties'), false);
  const next = toGeminiContents(
    [
      { role: 'assistant', content: r.blocks, raw: r.raw },
      {
        role: 'user',
        content: [{ type: 'tool_result', id: r.blocks[1].id, name: 'get_grades', text: '[]' }],
      },
    ],
    'gemini-flash-latest',
  );
  assert.equal(next[0].parts.find((x) => x.functionCall).thoughtSignature, 'sig1');
  assert.equal(next[1].parts[0].functionResponse.name, 'get_grades');
});

test('Gemini: блокування безпеки → refusal; MAX_TOKENS; недійсний ключ (400 API_KEY_INVALID) → auth', async () => {
  for (const events of [
    [{ data: { promptFeedback: { blockReason: 'SAFETY' } } }],
    [{ data: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] } }],
    [{ data: { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] } }],
  ]) {
    const { fetch } = recorder([() => sse(events)]);
    assert.equal(
      (await createGeminiProvider({ apiKey: GKEY, fetch }).turn(req())).stopReason,
      'refusal',
    );
  }
  const mt = recorder([
    () =>
      sse([
        {
          data: {
            candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }],
          },
        },
      ]),
  ]);
  assert.equal(
    (await createGeminiProvider({ apiKey: GKEY, fetch: mt.fetch }).turn(req())).stopReason,
    'max_tokens',
  );
  const bad = recorder([
    () =>
      jsonResponse(400, {
        error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
      }),
  ]);
  await assert.rejects(
    createGeminiProvider({ apiKey: GKEY, fetch: bad.fetch, sleep: noSleep }).turn(req()),
    (e) => e.code === 'auth',
  );
  assert.equal(bad.calls.length, 1);
  assert.equal(classifyGemini(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'rate_limit');
  assert.equal(classifyGemini(500, {}), 'server');
  assert.deepEqual(
    geminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'object', additionalProperties: false } },
    }),
    { type: 'object', properties: { a: { type: 'object' } } },
  );
});

test('вибір провайдера за налаштуваннями', () => {
  const fetch = async () => new Response('');
  const s = {
    aiProvider: 'gemini',
    aiModelGemini: 'gemini-x',
    aiModelOpenai: 'm',
    aiOpenaiBase: 'https://api.openai.com/v1',
    aiModelAnthropic: 'claude-sonnet-5-5',
  };
  assert.equal(createProvider({ settings: s, key: GKEY, fetch }).id, 'gemini');
  assert.equal(
    createProvider({ settings: { ...s, aiProvider: 'openai' }, key: OKEY, fetch }).id,
    'openai',
  );
  assert.equal(
    createProvider({ settings: { ...s, aiProvider: 'anthropic' }, key: OKEY, fetch }).model,
    'claude-sonnet-5-5',
  );
  assert.throws(
    () => createProvider({ settings: { ...s, aiProvider: 'evil' }, key: OKEY, fetch }),
    (e) => e.code === 'bad_request',
  );
});
