import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createAssistant, createMemoryStore } from '../src/ai/agent.js';
import {
  LIMITS,
  SYSTEM_PROMPT,
  buildUserTurn,
  htmlToText,
  stripForStorage,
  toolResultText,
  trimHistory,
} from '../src/ai/context.js';
import { AiError, codeForStatus, retryAfterSec } from '../src/ai/errors.js';
import { createKeyStore, maskKey, redactSecrets, validKey } from '../src/ai/keys.js';
import { createTools, validateInput } from '../src/ai/tools.js';
import { NOW } from './helpers.js';
import { demoService, fakeSafeStorage, scriptedProvider, tmpDir } from './ai-helpers.js';

const KEY = 'sk-ant-api03-TESTKEYabcdefghijklmnopqrstuvwxyz0123456789';

/* ---------- Ключі ---------- */
test('маскування ключа: видно лише 4 перші й 4 останні символи; короткі — повністю', () => {
  assert.equal(maskKey(KEY), 'sk-a…6789');
  assert.ok(!maskKey(KEY).includes('TESTKEY'));
  assert.equal(maskKey('short'), '•••••');
  assert.equal(maskKey(''), '');
});

test('redactSecrets прибирає ключі з тексту діагностики й помилок', () => {
  const text = `error for ${KEY} and AIzaSyA1234567890abcdefghijklmnop and sk-proj-abcdefghijklmnopqrstu`;
  const out = redactSecrets(text, [KEY]);
  assert.ok(!out.includes('TESTKEY'));
  assert.ok(!out.includes('1234567890abcdefghij'));
  assert.ok(!out.includes('abcdefghijklmnopqrstu'));
});

test('сховище ключів: на диску лише шифротекст, status() не віддає ключа, без шифрування — відмова', () => {
  const file = path.join(tmpDir(), 'keys.json');
  const keys = createKeyStore({ file, safeStorage: fakeSafeStorage() });
  keys.set('anthropic', KEY);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(KEY) && !disk.includes('TESTKEY'));
  assert.equal(keys.get('anthropic'), KEY);
  const st = keys.status();
  assert.deepEqual(st.anthropic, { has: true, masked: maskKey(KEY) });
  assert.equal(st.openai.has, false);
  assert.ok(!JSON.stringify(st).includes('TESTKEY'));
  keys.clear('anthropic');
  assert.equal(keys.get('anthropic'), null);

  const noEnc = createKeyStore({
    file: path.join(tmpDir(), 'k.json'),
    safeStorage: fakeSafeStorage(false),
  });
  assert.throws(
    () => noEnc.set('anthropic', KEY),
    (e) => e instanceof AiError && e.code === 'storage',
  );
  assert.throws(
    () => keys.set('anthropic', 'bad key with spaces'),
    (e) => e.code === 'bad_request',
  );
  assert.throws(
    () => keys.set('evil', KEY),
    (e) => e.code === 'bad_request',
  );
  assert.equal(validKey('x'.repeat(600)), false);
});

/* ---------- Помилки ---------- */
test('коди помилок провайдерів за HTTP-статусом і retry-after', () => {
  assert.equal(codeForStatus(401), 'auth');
  assert.equal(codeForStatus(403), 'auth');
  assert.equal(codeForStatus(429), 'rate_limit');
  assert.equal(codeForStatus(529), 'overloaded');
  assert.equal(codeForStatus(503), 'overloaded');
  assert.equal(codeForStatus(500), 'server');
  assert.equal(codeForStatus(404), 'bad_request');
  assert.equal(retryAfterSec('5'), 5);
  assert.equal(retryAfterSec('600'), 30);
  assert.equal(retryAfterSec(null), null);
});

/* ---------- Контекст ---------- */
const userText = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] });
const asst = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const toolTurn = () => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'get_grades', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', id: 'x', name: 'get_grades', text: '[]' }] },
];

test('обрізання історії: останні N повідомлень, початок завжди на ході учня, пари tool_use/tool_result цілі', () => {
  const h = [];
  for (let i = 0; i < 10; i++) h.push(userText('q' + i), ...toolTurn(), asst('a' + i));
  const out = trimHistory(h, 12);
  assert.ok(out.length <= 12);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content[0].type, 'text');
  assert.equal(out.at(-1).content[0].text, 'a9');
  for (let i = 0; i < out.length; i++)
    if (out[i].content.some((b) => b.type === 'tool_result'))
      assert.equal(out[i - 1].content[0].type, 'tool_use');
  assert.deepEqual(trimHistory([], 12), []);
  // блоки міркувань (raw) не переносяться в наступні ходи
  assert.equal(trimHistory([{ ...userText('q'), raw: { x: 1 } }])[0].raw, undefined);
});

test('хід учня: дата й поточне ДЗ у тексті ходу, системний промпт незмінний, довгий текст обрізано', () => {
  const task = {
    id: 7,
    subject: 'Алгебра',
    themeTitle: 'Дроби',
    deadline: NOW + 86400,
    status: 'assigned',
  };
  const long = '<p>' + 'x'.repeat(LIMITS.taskChars * 2) + '</p><script>alert(1)</script>';
  const turn = buildUserTurn({
    text: 'Допоможи',
    now: NOW,
    mode: 'explain',
    task,
    taskBlocks: [{ kind: 'html', html: long }],
  });
  const t = turn.content[0].text;
  assert.match(t, /Поточне завдання #7: Алгебра, тема «Дроби»/);
  assert.match(t, /Поясни/);
  assert.match(t, /Допоможи$/);
  assert.ok(t.length < LIMITS.taskChars + 1000);
  assert.ok(!t.includes('<script') && !t.includes('alert'));
  assert.ok(!SYSTEM_PROMPT.includes(String(new Date().getFullYear() + 1)));
});

test('HTML → текст без тегів і скриптів; результат інструмента обрізано', () => {
  assert.equal(
    htmlToText('<p>Вправа <b>3</b>&nbsp;&amp; 4</p><script>x()</script><ul><li>a</li></ul>'),
    'Вправа 3 & 4\n• a',
  );
  const big = toolResultText({ s: 'y'.repeat(LIMITS.toolChars * 3) });
  assert.ok(big.length <= LIMITS.toolChars + 20 && big.endsWith('[обрізано]'));
});

test('збереження історії: зображення сторінки на диск не потрапляє', () => {
  const m = {
    role: 'user',
    content: [
      { type: 'tool_result', id: '1', text: 'p', image: { mediaType: 'image/jpeg', data: 'AAAA' } },
    ],
  };
  const s = stripForStorage(m);
  assert.equal(s.content[0].image, undefined);
  assert.match(s.content[0].text, /зображення сторінки/);
});

/* ---------- Інструменти (обгортки над service.js) ---------- */
test('інструменти: аргументи перевіряються за схемою', () => {
  assert.equal(validateInput('get_homework', { status: 'pending' }), null);
  assert.match(validateInput('get_homework', { status: 'bad' }), /one of/);
  assert.match(validateInput('get_homework', { task_id: '5' }), /integer/);
  assert.match(validateInput('get_homework', { evil: 1 }), /unexpected/);
  assert.match(validateInput('get_page', { book_id: 'b' }), /missing page/);
  assert.match(validateInput('nope', {}), /unknown/);
  assert.match(validateInput('get_grades', 'str'), /object/);
});

test('get_schedule / get_homework / get_grades працюють на даних сервісу й віддають картки', async () => {
  const service = await demoService();
  const tools = createTools({ service, now: () => NOW });
  assert.deepEqual(
    tools.defs.map((d) => d.name),
    ['get_schedule', 'get_homework', 'get_grades'],
  );
  const sch = await tools.run('get_schedule', {});
  assert.equal(sch.card.kind, 'schedule');
  assert.ok(sch.result[0].lessons.length > 0);
  const hw = await tools.run('get_homework', {});
  assert.equal(hw.card.kind, 'homework');
  assert.ok(
    hw.result.tasks.every((t) => ['assigned', 'overdue', 'returned', 'unknown'].includes(t.status)),
  );
  const one = await tools.run('get_homework', { task_id: hw.result.tasks[0].task_id });
  assert.equal(typeof one.result.text, 'string');
  const gr = await tools.run('get_grades', { subject: 'алгебра' });
  assert.ok(gr.result.every((g) => /Алгебра/.test(g.subject)));
  const bad = await tools.run('get_schedule', { date: '17.10.2026' });
  assert.ok(bad.isError);
  const week = await tools.run('get_schedule', { date: '2026-10-05', days: 7 });
  assert.equal(week.result.length, 7);
});

/* ---------- Цикл асистента ---------- */
async function setupAgent(script, { student = true, consent = true, provider } = {}) {
  const service = await demoService();
  const p = provider ?? scriptedProvider(script);
  const events = [];
  let checks = 0;
  const assistant = createAssistant({
    getProvider: () => p,
    verifyStudent: async () => (
      checks++,
      typeof student === 'function' ? student(checks) : student
    ),
    tools: createTools({ service, now: () => NOW }),
    service,
    store: createMemoryStore(),
    hasConsent: () => consent,
    emit: (e) => events.push(e),
    now: () => NOW,
  });
  return { assistant, p, events, checks: () => checks, service };
}

test('асистент: виклик інструмента → картка → фінальна відповідь; роль перевіряється перед кожним запитом', async () => {
  const { assistant, p, events, checks } = await setupAgent([
    { text: 'Дивлюсь…', tools: [{ name: 'get_homework', input: {} }] },
    { text: 'Ось що задано.' },
  ]);
  const r = await assistant.send({ text: 'Що задано?' });
  assert.deepEqual(r, { ok: true });
  assert.equal(p.calls.length, 2);
  assert.equal(checks(), 2);
  const second = p.calls[1].messages;
  assert.equal(second.at(-1).content[0].type, 'tool_result');
  assert.ok(events.some((e) => e.type === 'card' && e.card.kind === 'homework'));
  assert.ok(events.filter((e) => e.type === 'text').length > 5);
  const done = events.find((e) => e.type === 'done').entry;
  assert.match(done.text, /Ось що задано/);
  // у збереженій історії немає блоків міркувань
  assert.ok(!JSON.stringify(assistant._model()).includes('secret'));
  assert.equal(assistant.history().length, 2);
});

test('асистент: роль не підтверджено (або перевірка впала) → запит до моделі не йде', async () => {
  for (const student of [
    false,
    () => {
      throw new Error('net');
    },
  ]) {
    const { assistant, p } = await setupAgent([{ text: 'x' }], { student });
    const r = await assistant.send({ text: 'привіт' });
    assert.deepEqual(r, { ok: false, code: 'not_student' });
    assert.equal(p.calls.length, 0);
  }
  // роль «зникла» посеред циклу інструментів → другий запит не відправляється
  const { assistant, p } = await setupAgent([{ tools: [{ name: 'get_grades' }] }, { text: 'x' }], {
    student: (n) => n === 1,
  });
  assert.equal((await assistant.send({ text: 'оцінки' })).code, 'not_student');
  assert.equal(p.calls.length, 1);
});

test('асистент: без згоди й без ключа нічого не відправляється', async () => {
  const a = await setupAgent([{ text: 'x' }], { consent: false });
  assert.equal((await a.assistant.send({ text: 'q' })).code, 'consent');
  assert.equal(a.p.calls.length, 0);
  const service = await demoService();
  const b = createAssistant({
    getProvider: () => {
      throw new AiError('no_key');
    },
    verifyStudent: async () => true,
    tools: createTools({ service }),
    service,
    store: createMemoryStore(),
    hasConsent: () => true,
    emit: () => {},
  });
  assert.equal((await b.send({ text: 'q' })).code, 'no_key');
});

test('асистент: відмова моделі й помилки провайдера не потрапляють в історію моделі', async () => {
  const { assistant } = await setupAgent([{ text: 'part', stop: 'refusal' }]);
  const r = await assistant.send({ text: 'q' });
  assert.equal(r.code, 'refusal');
  assert.deepEqual(assistant._model(), []);
  assert.equal(assistant.history().at(-1).text, '');
  for (const code of ['rate_limit', 'overloaded', 'auth', 'network']) {
    const x = await setupAgent([{ throw: new AiError(code) }]);
    assert.equal((await x.assistant.send({ text: 'q' })).code, code);
    assert.deepEqual(x.assistant._model(), []);
  }
});

test('асистент: кнопка «Пояснити» додає текст поточного ДЗ; цикл обмежено кроками; обрізаний виклик не виконується', async () => {
  const { assistant, p, service } = await setupAgent([{ text: 'Крок 1' }]);
  const task = service.getState().snapshot.tasks[0];
  await assistant.send({ mode: 'explain', taskId: task.id });
  const t = p.calls[0].messages.at(-1).content[0].text;
  assert.match(t, new RegExp(`Поточне завдання #${task.id}`));
  assert.match(t, /Текст завдання/);

  const loop = await setupAgent(
    Array.from({ length: 10 }, () => ({ tools: [{ name: 'get_grades' }] })),
  );
  await loop.assistant.send({ text: 'q' });
  assert.equal(loop.p.calls.length, LIMITS.steps);
  assert.equal(loop.assistant.history().at(-1).stepLimit, true);

  const cut = await setupAgent([{ tools: [{ name: 'get_grades' }], stop: 'max_tokens' }]);
  await cut.assistant.send({ text: 'q' });
  assert.equal(cut.p.calls.length, 1);
  assert.equal(
    cut.events.some((e) => e.type === 'tool'),
    false,
  );
});

test('асистент: історія для моделі обрізається до останніх N повідомлень', async () => {
  const { assistant, p } = await setupAgent(
    Array.from({ length: 30 }, (_, i) => ({ text: 'a' + i })),
  );
  for (let i = 0; i < 20; i++) await assistant.send({ text: 'q' + i });
  assert.ok(p.calls.at(-1).messages.length <= LIMITS.historyMessages + 1);
  assert.equal(p.calls.at(-1).system, SYSTEM_PROMPT);
});

test('фрагменти з читача: у хід потрапляє лише виділене, з обмеженням довжини й кількості', () => {
  const fragments = Array.from({ length: 15 }, (_, i) => ({
    title: 'Алгебра 8',
    printed: 30 + i,
    text: 'ф'.repeat(2000),
  }));
  const t = buildUserTurn({ text: 'Поясни', now: NOW, fragments }).content[0].text;
  assert.match(t, /Фрагменти з підручника, які виділив учень/);
  assert.match(t, /«Алгебра 8», с\. 30:/);
  assert.ok(t.length < LIMITS.fragmentChars + 1500);
  assert.ok(!t.includes('с. 44'));
});
