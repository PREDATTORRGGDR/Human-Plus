import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createClient, parseThemeTasks } from '../src/api.js';
import { normalizeCalendar } from '../src/normalize.js';
import { createFileCache, createService } from '../src/service.js';
import { addDays, dayStart } from '../src/time.js';
import { NOW, fakeApi } from './helpers.js';

const today = dayStart(NOW);

test('урок отримує матеріали («Заняття», «Зошит», «Тест») за theme_id', () => {
  const raw = {
    groups: [{ id: 1, subject_id: 1, subject: { i18n: { name: 'Фізика' } } }],
    lessonEvents: [
      { id: 1, date: today + 30600, date_end: today + 33300, theme_id: 10, group_id: 1 },
      { id: 2, date: today + 34000, date_end: today + 36000, theme_id: 11, group_id: 1 },
    ],
    lessonTasks: [
      { id: 3, theme_id: 10, title: 'Робота', type: { name: 'Зошит' }, updated_at: 7 },
      { id: 4, theme_id: 10, type: {}, updated_at: 8 },
      { id: 'x' },
      null,
    ],
  };
  const snap = normalizeCalendar(raw, {
    now: NOW,
    from: addDays(today, -1),
    to: addDays(today, 2),
  });
  const [a, b] = snap.lessons;
  assert.deepEqual(
    a.lessonTasks.map((x) => [x.id, x.typeName, x.updatedAt]),
    [
      ['L3', 'Зошит', 7],
      ['L4', 'Заняття', 8],
    ],
  );
  assert.deepEqual(b.lessonTasks, []);
});

test('parseThemeTasks: матеріали уроку під ключем «L…», ДЗ — під числовим', () => {
  const out = parseThemeTasks(
    {
      home_tasks: [{ id: 1, content: { blocks: [{ type: 'tx01', data: { text: 'дз' } }] } }],
      lesson_tasks: [
        {
          id: 5,
          updated_at: 3,
          content: { hash: 'h', blocks: [{ type: 'tx01', data: { text: 'урок' } }] },
        },
        { id: 'x' },
      ],
    },
    1,
  );
  assert.deepEqual(Object.keys(out).sort(), ['1', 'L5']);
  assert.equal(out.L5.blocks[0].html, 'урок');
  assert.equal(out.L5.updatedAt, 3);
});

test('сервіс: матеріал уроку й ДЗ тієї ж теми — один запит, далі з кешу', async () => {
  const api = fakeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  const client = createClient(api.fn, {
    userAgent: 'HumanPlus/test',
    wait: async () => {},
    retries: 0,
  });
  const service = createService({
    client,
    getUid: async () => 42,
    cache: createFileCache(path.join(dir, 'c.json')),
    now: () => NOW,
  });
  await service.refresh();
  const lesson = service
    .getState()
    .snapshot.lessons.find(
      (l) =>
        l.lessonTasks.length &&
        service.getState().snapshot.tasks.some((t) => t.themeId === l.themeId),
    );
  assert.ok(lesson, 'у демо є урок із матеріалами й ДЗ');
  const themeCalls = () => api.calls.filter((c) => c.url.includes('/plan/theme/')).length;
  const lt = await service.getTaskText(lesson.lessonTasks[0].id);
  assert.equal(lt.ok, true);
  assert.ok(lt.blocks.length > 0);
  assert.equal(themeCalls(), 1);
  const hw = service.getState().snapshot.tasks.find((t) => t.themeId === lesson.themeId);
  assert.equal((await service.getTaskText(hw.id)).ok, true);
  assert.equal(themeCalls(), 1, 'ДЗ тієї ж теми вже в кеші');
  assert.equal((await service.getTaskText('L999999')).ok, false);
  assert.equal((await service.getTaskText('abc')).ok, false);
});
