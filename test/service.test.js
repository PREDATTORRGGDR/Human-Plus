import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createClient } from '../src/api.js';
import { createFileCache, createService } from '../src/service.js';
import { NOW, fakeApi, res } from './helpers.js';

function setup(opts = {}, uid = 42) {
  const api = fakeApi(opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  const cache = createFileCache(path.join(dir, 'cache.json'));
  const client = createClient(api.fn, {
    userAgent: 'HumanPlus/test',
    wait: async () => {},
    retries: 1,
  });
  const holder = { uid };
  const service = createService({ client, getUid: async () => holder.uid, cache, now: () => NOW });
  return { api, cache, client, service, holder };
}

test('учень: роль перевірено → дані показано, кеш записано, 6 запитів за оновлення (інфо, календар, 4 категорії завдань)', async () => {
  const { service, cache, client } = setup();
  await service.refresh();
  const st = service.getState();
  assert.equal(st.status, 'ready');
  assert.ok(st.snapshot.lessons.length > 0 && st.snapshot.tasks.length > 0);
  assert.equal(client.stats.total, 6);
  assert.deepEqual(st.snapshot.partial, []);
  assert.equal(cache.load().studentVerified, true);
});

test('вчитель, порожня відповідь, невідома роль → екран відмови без даних і кешу', async () => {
  for (const info of [
    { lmsUser: { id: 42, role_id: 3, status: 1 } },
    {},
    null,
    { lmsUser: { id: 42, role_id: 99, status: 1 } },
  ]) {
    const { service, cache, api } = setup({ info });
    await service.refresh();
    assert.equal(service.getState().status, 'notStudent');
    assert.equal(service.getState().snapshot, null);
    assert.equal(cache.load(), null);
    assert.ok(
      !api.calls.some((c) => c.url.includes('/calendar')),
      'календар вчителя не запитується',
    );
  }
});

test('учень, що став «не учнем», втрачає кеш', async () => {
  const teacher = setup({ info: { lmsUser: { id: 42, role_id: 3, status: 1 } } });
  teacher.cache.save({
    uid: 42,
    studentVerified: true,
    snapshot: { tasks: [], lessons: [] },
    texts: {},
  });
  await teacher.service.refresh();
  assert.equal(teacher.cache.load(), null);
});

test('без куки uid → екран входу', async () => {
  const { service } = setup({}, null);
  await service.refresh();
  assert.equal(service.getState().status, 'login');
});

test('протухла сесія (401) → «увійдіть знову», кеш лишається', async () => {
  const { service, cache } = setup();
  await service.refresh();
  const bad = setup({ override: () => res(401, { name: 'Unauthorized' }) });
  bad.cache.save(cache.load());
  await bad.service.refresh();
  assert.equal(bad.service.getState().status, 'expired');
  assert.ok(bad.cache.load(), 'кеш не втрачено');
});

test('офлайн: показано кеш із позначкою; без кешу — помилка', async () => {
  const ok = setup();
  await ok.service.refresh();
  const off = setup({
    override: () => () => {
      throw new TypeError('offline');
    },
  });
  off.cache.save(ok.cache.load());
  await off.service.refresh();
  assert.equal(off.service.getState().status, 'ready');
  assert.equal(off.service.getState().offline, true);
  assert.ok(off.service.getState().snapshot.tasks.length > 0);
  const none = setup({
    override: () => () => {
      throw new TypeError('offline');
    },
  });
  await none.service.refresh();
  assert.equal(none.service.getState().status, 'error');
});

test('кеш іншого користувача не показується', async () => {
  const a = setup();
  await a.service.refresh();
  const other = setup(
    {
      override: () => () => {
        throw new TypeError('offline');
      },
    },
    777,
  );
  other.cache.save(a.cache.load()); // кеш uid=42, поточний uid=777
  await other.service.refresh();
  assert.equal(other.service.getState().status, 'error');
});

test('три збої сервера поспіль → автооновлення призупиняється, успіх знімає паузу', async () => {
  let fail = true;
  const { service } = setup({
    override: (u) => (fail && u.includes('/calendar') ? res(500, {}) : null),
  });
  for (let i = 0; i < 3; i++) await service.refresh();
  assert.equal(service.isPaused(), true);
  fail = false;
  service.resume();
  await service.refresh();
  assert.equal(service.getState().status, 'ready');
  assert.equal(service.isPaused(), false);
});

test('текст ДЗ: один запит на тему, далі з кешу; інвалідація за updated_at', async () => {
  const { service, api } = setup();
  await service.refresh();
  const task = service.getState().snapshot.tasks.find((t) => t.contentId);
  const themeCalls = () => api.calls.filter((c) => c.url.includes('/plan/theme/')).length;
  const a = await service.getTaskText(task.id);
  assert.equal(a.ok, true);
  assert.equal(themeCalls(), 1);
  await service.getTaskText(task.id);
  assert.equal(themeCalls(), 1, 'повторний показ — з кешу');
  task.updatedAt += 1; // завдання змінили на сервері
  await service.getTaskText(task.id);
  assert.equal(themeCalls(), 2);
});

test('усі запити — GET', async () => {
  const { service, api } = setup();
  await service.refresh();
  await service.getWeek(NOW - 90 * 86400);
  assert.ok(api.calls.length >= 3 && api.calls.every((c) => c.method === 'GET'));
});

test('вихід стирає кеш і повертає на екран входу', async () => {
  const { service, cache } = setup();
  await service.refresh();
  service.wipe();
  assert.equal(cache.load(), null);
  assert.equal(service.getState().status, 'login');
  assert.equal(service.getState().snapshot, null);
});
