import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  clock,
  dayStart,
  isoWeek,
  isoWeekday,
  kyivMidnight,
  plural,
  weekStart,
} from '../src/time.js';
import { uk } from '../src/uk.js';

const utc = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000;

test('межі дня за Europe/Kyiv: літо (UTC+3) і зима (UTC+2)', () => {
  assert.equal(kyivMidnight(2026, 10, 1), utc(2026, 9, 30, 21));
  assert.equal(kyivMidnight(2026, 1, 15), utc(2026, 1, 14, 22));
  assert.equal(dayStart(utc(2026, 10, 1, 12)), utc(2026, 9, 30, 21));
});

test('перехід на літній час (29.03.2026): доба 23 години', () => {
  const d = kyivMidnight(2026, 3, 29);
  assert.equal(d, utc(2026, 3, 28, 22)); // ще UTC+2
  assert.equal(addDays(d, 1) - d, 23 * 3600);
  assert.equal(addDays(d, 1), utc(2026, 3, 29, 21)); // вже UTC+3
});

test('перехід на зимовий час (25.10.2026): доба 25 годин', () => {
  const d = kyivMidnight(2026, 10, 25);
  assert.equal(addDays(d, 1) - d, 25 * 3600);
  assert.equal(addDays(d, 1), utc(2026, 10, 25, 22)); // вже UTC+2
});

test('weekStart повертає понеділок, isoWeek/isoWeekday', () => {
  const thu = utc(2026, 10, 1, 12);
  assert.equal(weekStart(thu), kyivMidnight(2026, 9, 28));
  assert.equal(isoWeekday(thu), 4);
  assert.equal(isoWeek(thu), 40);
  assert.equal(isoWeekday(utc(2026, 10, 4, 12)), 7);
  assert.equal(isoWeek(utc(2026, 1, 1, 12)), 1);
});

test('23:30 за Києвом належить своєму дню, а 00:00 — наступному', () => {
  assert.equal(dayStart(utc(2026, 10, 1, 20, 30)), kyivMidnight(2026, 10, 1)); // 23:30 EEST
  assert.equal(dayStart(utc(2026, 10, 1, 21)), kyivMidnight(2026, 10, 2));
});

test('clock форматує секунди від півночі', () => {
  assert.equal(clock(30600), '08:30');
  assert.equal(clock(53700), '14:55');
});

test('множина через Intl.PluralRules(uk)', () => {
  const t = (n) => plural(n, uk.plural.task);
  assert.equal(t(0), '0 завдань');
  assert.equal(t(1), '1 завдання');
  assert.equal(t(2), '2 завдання');
  assert.equal(t(4), '4 завдання');
  assert.equal(t(5), '5 завдань');
  assert.equal(t(11), '11 завдань');
  assert.equal(t(12), '12 завдань');
  assert.equal(t(21), '21 завдання');
  assert.equal(t(22), '22 завдання');
  assert.equal(t(25), '25 завдань');
  assert.equal(plural(3, uk.plural.lesson), '3 уроки');
  assert.equal(plural(7, uk.plural.lesson), '7 уроків');
});
