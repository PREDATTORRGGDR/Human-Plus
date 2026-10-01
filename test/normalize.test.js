import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemo } from '../src/demo.js';
import { dayView, nextView, tasksView } from '../src/model.js';
import { normalizeCalendar } from '../src/normalize.js';
import { addDays, dayStart, isoWeek, kyivMidnight } from '../src/time.js';
import { NOW } from './helpers.js';

const today = dayStart(NOW);
const win = { from: addDays(today, -14), to: addDays(today, 35) };
const norm = (demo) =>
  normalizeCalendar(demo.calendar(win.from, win.to), {
    now: NOW,
    ...win,
    studentTasks: demo.studentTasks(),
  });

test('демо-календар нормалізується без пропущених секцій', () => {
  const snap = norm(createDemo(NOW));
  assert.deepEqual(snap.partial, []);
  assert.ok(snap.lessons.length > 40);
  assert.ok(snap.tasks.length > 10);
  assert.ok(snap.lessons.every((l) => l.subject !== '—' && l.end > l.start));
  assert.ok(
    snap.tasks.some((t) => t.status === 'accepted') &&
      snap.tasks.some((t) => t.status === 'overdue'),
  );
});

test('майбутні уроки добудовуються з розкладу з урахуванням чисельника/знаменника', () => {
  const snap = norm(createDemo(NOW));
  const future = snap.lessons.filter((l) => l.projected);
  assert.ok(
    future.length > 20 && future.every((l) => l.start >= addDays(today, 2) && l.themeId === null),
  );
  // інформатика (week=1) — лише у непарні ISO-тижні
  const inf = future.filter((l) => l.subject === 'Інформатика');
  assert.ok(inf.length > 0 && inf.every((l) => isoWeek(l.start) % 2 === 1));
});

test('«Сьогодні»: ДЗ, задані на уроках дня (збіг theme_id), а не ті, що здавати сьогодні', () => {
  const raw = {
    groups: [{ id: 1, subject_id: 1, subject: { i18n: { name: 'Алгебра' } } }],
    lessonEvents: [
      { id: 1, date: today + 30600, date_end: today + 33300, theme_id: 10, group_id: 1 },
    ],
    themes: [{ id: 10, title: 'Тема' }],
    homeTasks: [
      { id: 100, theme_id: 10, group_id: 1, expire_date: today + 5 * 86400, updated_at: 1 }, // задане сьогодні, здати через 5 днів
      { id: 101, theme_id: 99, group_id: 1, expire_date: today + 36000, updated_at: 1 }, // здавати сьогодні, але задане на іншому уроці
    ],
    userHomeTasks: [
      {
        id: 100,
        theme_id: 10,
        expire_date: today + 5 * 86400,
        homeTasksUsers: [{ home_task_id: 100, status: 0 }],
      },
      {
        id: 101,
        theme_id: 99,
        expire_date: today + 36000,
        homeTasksUsers: [{ home_task_id: 101, status: 0 }],
      },
    ],
  };
  const snap = normalizeCalendar(raw, { now: NOW, ...win });
  const v = dayView(snap, today);
  assert.equal(v.lessons.length, 1);
  assert.deepEqual(
    v.lessons[0].tasks.map((t) => t.id),
    [100],
  );
});

test('статуси: 0 видане, 1 відправлено, 2 прийнято, 3 повернуто; прострочення; невідомий статус', () => {
  const mk = (id, status, deadline) => ({
    id,
    theme_id: id,
    group_id: 1,
    expire_date: deadline,
    homeTasks: 0,
    updated_at: 1,
    _s: status,
  });
  const hts = [
    mk(1, 0, NOW + 1000),
    mk(2, 1, NOW - 1000),
    mk(3, 2, NOW - 1000),
    mk(4, 3, NOW + 1000),
    mk(5, 0, NOW - 1000),
    mk(6, 3, NOW - 1000),
    mk(7, 9, NOW + 1000),
  ];
  const raw = {
    groups: [{ id: 1, subject_id: 1, subject: { i18n: { name: 'Хімія' } } }],
    homeTasks: [...hts, { id: 8, theme_id: 8, group_id: 1, expire_date: NOW + 1000 }],
    userHomeTasks: hts.map((h) => ({
      id: h.id,
      theme_id: h.id,
      expire_date: h.expire_date,
      homeTasksUsers: [
        { home_task_id: h.id, status: h._s, date_submission: h._s === 1 ? NOW - 5000 : null },
      ],
    })),
  };
  const by = Object.fromEntries(
    normalizeCalendar(raw, { now: NOW, ...win }).tasks.map((t) => [t.id, t]),
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => by[i].status),
    ['assigned', 'submitted', 'accepted', 'returned', 'overdue', 'overdue', 'unknown', 'unknown'],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => by[i].pending),
    [true, false, false, true, true, true, true, true],
  );
  assert.equal(by[8].statusKnown, false);
  assert.equal(by[2].late, false);
});

test('скасований урок, заміна й вихідний', () => {
  const day = addDays(today, 1); // п'ятниця (сьогодні четвер)
  const raw = {
    periods: [{ number: 1, start_at: 30600, finish_at: 33300, group_number: 99 }],
    groups: [{ id: 1, subject_id: 1, subject: { i18n: { name: 'Фізика' } } }],
    scheduleHelpers: [
      { id: 5, group_id: 1, period: 1, day_of_week: 5, week: 2, container_id: 1, event_type: 0 },
      { id: 6, group_id: 1, period: 1, day_of_week: 1, week: 2, container_id: 1, event_type: 0 },
    ],
    scheduleHelperContainers: [{ id: 1 }],
    cancellationLessons: [{ id: 1, date: day, schedule_helper_id: 5 }],
    weekends: [{ date: addDays(today, 4) }],
  };
  const snap = normalizeCalendar(raw, { now: NOW, ...win });
  const fri = snap.lessons.find((l) => l.start === day + 30600);
  assert.equal(fri.cancelled, true);
  assert.ok(
    !snap.lessons.some((l) => dayStart(l.start) === addDays(today, 4)),
    'у вихідний уроки з розкладу не добудовуються',
  );
  assert.equal(dayView(snap, addDays(today, 4)).weekend, true);
  assert.equal(
    nextView(snap, NOW).rest.every((i) => !i.lesson.cancelled),
    true,
  );
});

test('порожній день і сміття на вході не валять застосунок', () => {
  const empty = normalizeCalendar({}, { now: NOW, ...win });
  assert.deepEqual([empty.lessons.length, empty.tasks.length], [0, 0]);
  assert.deepEqual(
    empty.partial,
    ['studentTasks'],
    'без students-tasks статуси наближені, і про це сказано',
  );
  assert.equal(dayView(empty, today).lessons.length, 0);
  for (const junk of [
    null,
    undefined,
    'x',
    5,
    [],
    {
      lessonEvents: 'x',
      homeTasks: { a: 1 },
      userHomeTasks: [null, 5, { homeTasksUsers: 'z' }],
      periods: [{}],
      assessments: [null],
    },
  ]) {
    const s = normalizeCalendar(junk, { now: NOW, ...win });
    assert.ok(Array.isArray(s.lessons) && Array.isArray(s.tasks) && Array.isArray(s.grades));
  }
});

test('«На наступний урок»: найближчий урок предмета й невиконане ДЗ до нього; блок «На завтра»', () => {
  const snap = norm(createDemo(NOW));
  const v = nextView(snap, NOW);
  const all = [...v.tomorrow, ...v.rest];
  assert.equal(
    new Set(all.map((i) => i.lesson.subjectKey)).size,
    all.length,
    'по одному уроку на предмет',
  );
  assert.ok(all.every((i) => i.lesson.end > NOW && i.tasks.every((t) => t.pending)));
  assert.ok(v.tomorrow.every((i) => dayStart(i.lesson.start) === addDays(today, 1)));
});

test('«Усі завдання»: фільтри статусу й предмета, групування, сортування за дедлайном', () => {
  const snap = norm(createDemo(NOW));
  const label = (g, t) => (g === 'subject' ? t.subject : String(t.deadline));
  const pending = tasksView(snap, { status: 'pending' }, label).flatMap((g) => g.tasks);
  assert.ok(pending.length && pending.every((t) => t.pending));
  assert.deepEqual(
    pending.map((t) => t.deadline),
    [...pending.map((t) => t.deadline)].sort((a, b) => a - b),
  );
  const done = tasksView(snap, { status: 'done' }, label).flatMap((g) => g.tasks);
  assert.ok(done.every((t) => ['submitted', 'accepted'].includes(t.status)));
  const subj = snap.tasks[0].subjectKey;
  assert.ok(
    tasksView(snap, { status: 'all', subject: subj, group: 'subject' }, label).every((g) =>
      g.tasks.every((t) => t.subjectKey === subj),
    ),
  );
});

test('межа дня: урок о 23:50 за Києвом належить своєму дню', () => {
  const d = kyivMidnight(2026, 10, 25); // день із переходом на зимовий час
  const raw = {
    groups: [{ id: 1, subject_id: 1, subject: { i18n: { name: 'Х' } } }],
    lessonEvents: [
      { id: 1, date: d + 23 * 3600 + 3000, date_end: d + 24 * 3600 + 600, group_id: 1 },
    ],
  };
  const snap = normalizeCalendar(raw, { now: NOW, from: addDays(d, -1), to: addDays(d, 2) });
  assert.equal(dayView(snap, d).lessons.length, 1);
  assert.equal(dayView(snap, addDays(d, 1)).lessons.length, 0);
});

test('students-tasks: статус за категорією, а не за числом; «прийнято» зі status=0; прострочення лише для «received»', () => {
  const item = (id, status, deadline, extra = {}) => ({
    id,
    expire_date: deadline,
    published_at: 5,
    theme: { id: id * 10, title: 'Тема ' + id },
    group: { id: 1, subject_id: 1, subject: { i18n: { name: 'Хімія' } } },
    home_tasks_user: { status, date_submission: null, assessment: null },
    ...extra,
  });
  const lists = {
    received: [item(1, 0, NOW + 1000), item(2, 0, NOW - 1000), item(3, 0, null)],
    review: [
      item(4, 1, NOW - 5000, {
        home_tasks_user: { status: 1, date_submission: NOW - 6000, assessment: null },
      }),
    ],
    approved: [
      item(5, 0, NOW - 9000, {
        home_tasks_user: { status: 0, date_submission: null, assessment: { int_value: 11 } },
      }),
      item(6, 2, NOW - 9000),
    ],
    rejected: [item(7, 3, NOW + 5000), item(8, 3, NOW - 5000)],
  };
  const by = Object.fromEntries(
    normalizeCalendar({}, { now: NOW, ...win, studentTasks: lists }).tasks.map((t) => [t.id, t]),
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => by[i].status),
    ['assigned', 'overdue', 'assigned', 'submitted', 'accepted', 'accepted', 'returned', 'overdue'],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => by[i].pending),
    [true, true, true, false, false, false, true, true],
  );
  assert.equal(by[5].grade, 11);
  assert.equal(by[3].deadline, null);
  assert.equal(by[1].themeTitle, 'Тема 1');
  assert.equal(by[1].subject, 'Хімія');
  assert.equal(by[4].late, false);
  assert.ok(Object.values(by).every((t) => t.statusKnown));
});

test('students-tasks: дублі між категоріями й сміття не ламають розбір', () => {
  const dup = {
    id: 1,
    expire_date: NOW - 1,
    theme: { id: 1, title: 'x' },
    home_tasks_user: { status: 0 },
  };
  const snap = normalizeCalendar(
    {},
    {
      now: NOW,
      ...win,
      studentTasks: {
        received: [dup, null, 5, { id: 'x' }],
        review: [dup],
        approved: 'x',
        rejected: undefined,
      },
    },
  );
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].status, 'overdue');
});
