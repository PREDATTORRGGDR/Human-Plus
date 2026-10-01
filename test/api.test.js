import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  NetworkError,
  SessionExpiredError,
  backoff,
  buildUserAgent,
  createClient,
  endpointName,
  endpoints,
} from '../src/api.js';
import { res } from './helpers.js';

const URL1 = endpoints.systemInfo(5);
const client = (fn, opts = {}) =>
  createClient(fn, { userAgent: 'HumanPlus/test', wait: async () => {}, ...opts });

test('лише GET, повний набір заголовків і прозорий User-Agent', async () => {
  const seen = [];
  const c = client(async (url, init) => (seen.push(init), res(200, { ok: 1 })), {
    userAgent: buildUserAgent('1.2.3'),
  });
  await c.getJson(URL1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].credentials, 'include');
  assert.match(seen[0].headers['User-Agent'], /^HumanPlus\/1\.2\.3$/);
});

test('User-Agent: лише назва й версія', () => {
  assert.equal(buildUserAgent('1.0.0'), 'HumanPlus/1.0.0');
});

test('чужі хости відхиляються до мережі', async () => {
  let called = false;
  const c = client(async () => ((called = true), res(200, {})));
  for (const u of ['https://example.com/x', 'http://api.human.ua/x', 'https://lms.human.ua/x'])
    await assert.rejects(c.getJson(u));
  assert.equal(called, false);
});

test('401 → SessionExpiredError без повторів', async () => {
  let n = 0;
  const c = client(async () => (n++, res(401, {})));
  await assert.rejects(c.getJson(URL1), SessionExpiredError);
  assert.equal(n, 1);
});

test('429 із Retry-After: чекаємо вказаний час і повторюємо', async () => {
  const waits = [];
  let n = 0;
  const c = client(
    async () => (++n === 1 ? res(429, {}, { 'retry-after': '7' }) : res(200, { ok: 1 })),
    { wait: async (ms) => waits.push(ms) },
  );
  assert.deepEqual(await c.getJson(URL1), { ok: 1 });
  assert.deepEqual(waits, [7000]);
});

test('5xx: експоненційний backoff і здача після ліміту повторів', async () => {
  const waits = [];
  let n = 0;
  const c = client(async () => (n++, res(503, {})), {
    wait: async (ms) => waits.push(ms),
    baseDelay: 1000,
  });
  await assert.rejects(c.getJson(URL1), ApiError);
  assert.equal(n, 4); // 1 + 3 повтори
  assert.equal(waits.length, 3);
  assert.ok(
    waits[0] >= 500 &&
      waits[0] <= 1000 &&
      waits[1] >= 1000 &&
      waits[1] <= 2000 &&
      waits[2] >= 2000 &&
      waits[2] <= 4000,
  );
});

test('4xx (крім 401/429) не повторюється; мережева помилка → NetworkError', async () => {
  let n = 0;
  await assert.rejects(
    client(async () => (n++, res(403, {}))).getJson(URL1),
    (e) => e instanceof ApiError && e.status === 403,
  );
  assert.equal(n, 1);
  await assert.rejects(
    client(async () => {
      throw new TypeError('fetch failed');
    }).getJson(URL1),
    NetworkError,
  );
});

test('не більше 4 одночасних запитів', async () => {
  let active = 0;
  let peak = 0;
  const c = client(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return res(200, {});
  });
  await Promise.all(Array.from({ length: 12 }, () => c.getJson(URL1)));
  assert.equal(peak, 4);
  assert.equal(c.stats.total, 12);
});

test('діагностика: імена ендпоінтів без id користувача', async () => {
  const c = client(async () => res(200, {}));
  await c.getJson(endpoints.systemInfo(123456));
  await c.getJson(endpoints.theme(123456, 77));
  assert.deepEqual(Object.keys(c.stats.byEndpoint), [
    '/v1/{uid}/system/info',
    '/v1/{uid}/plan/theme/{id}',
  ]);
  assert.ok(!JSON.stringify(c.stats).includes('123456'));
  assert.equal(endpointName(endpoints.calendar(1, 2, 3)), '/v1/{uid}/calendar');
});

test('backoff не перевищує 30 с', () => assert.ok(backoff(20, 800) <= 30000));
