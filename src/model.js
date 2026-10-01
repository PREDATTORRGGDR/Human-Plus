// Чисті функції-селектори над Snapshot. Використовують вікно, віджет і сповіщення.
import { addDays, dayStart } from './time.js';

/** @typedef {import('./normalize.js').Snapshot} Snapshot */

export const byDeadline = (a, b) =>
  (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.id - b.id;

export const lessonsOnDay = (s, day) =>
  s.lessons.filter((l) => l.start >= day && l.start < addDays(day, 1));

/** ДЗ, задане на уроці: збіг theme_id уроку й завдання. */
export const tasksOfLesson = (s, lesson) =>
  lesson.themeId == null ? [] : s.tasks.filter((t) => t.themeId === lesson.themeId);

/** Вкладка «Сьогодні»: уроки дня й ДЗ, задані саме на цих уроках. */
export function dayView(s, day) {
  const lessons = lessonsOnDay(s, day).map((lesson) => ({
    lesson,
    tasks: tasksOfLesson(s, lesson).sort(byDeadline),
  }));
  return { lessons, weekend: s.weekends.includes(day) };
}

/**
 * «На наступний урок»: для кожного предмета найближчий майбутній урок і невиконане ДЗ до нього
 * (дедлайн від початку сьогодні й до кінця дня цього уроку) плюс ДЗ, задане на самому уроці.
 * Давно прострочене тут не показуємо: воно виділене на вкладці «Усі завдання».
 */
export function nextView(s, now) {
  const next = new Map();
  for (const l of s.lessons)
    if (!l.cancelled && l.end > now && !next.has(l.subjectKey)) next.set(l.subjectKey, l);
  const items = [...next.values()].map((lesson) => {
    const endOfDay = addDays(dayStart(lesson.start), 1);
    const startOfToday = dayStart(now);
    const tasks = s.tasks
      .filter(
        (t) =>
          t.subjectKey === lesson.subjectKey &&
          t.pending &&
          ((t.deadline != null && t.deadline >= startOfToday && t.deadline < endOfDay) ||
            t.themeId === lesson.themeId),
      )
      .sort(byDeadline);
    return { lesson, tasks };
  });
  const tomorrow = addDays(dayStart(now), 1);
  const isTomorrow = (i) => dayStart(i.lesson.start) === tomorrow;
  return { tomorrow: items.filter(isTomorrow), rest: items.filter((i) => !isTomorrow(i)) };
}

const DONE = new Set(['submitted', 'accepted']);

/** Фільтри вкладки «Усі завдання»; повертає групи. */
export function tasksView(
  s,
  { status = 'pending', subject = '', group = 'date', from = -Infinity, to = Infinity },
  label,
) {
  const list = s.tasks
    .filter((t) => (status === 'all' ? true : status === 'done' ? DONE.has(t.status) : t.pending))
    .filter((t) => !subject || t.subjectKey === subject)
    .filter((t) => t.deadline == null || (t.deadline >= from && t.deadline < to))
    .sort(byDeadline);
  const groups = new Map();
  for (const t of list) {
    const key =
      group === 'subject'
        ? t.subjectKey
        : t.deadline == null
          ? 'none'
          : String(dayStart(t.deadline));
    if (!groups.has(key)) groups.set(key, { key, label: label(group, t), tasks: [] });
    groups.get(key).tasks.push(t);
  }
  return [...groups.values()];
}

export const subjectsOf = (s) =>
  [...new Map(s.tasks.map((t) => [t.subjectKey, t.subject])).entries()]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));

export const pendingCount = (s) => s.tasks.filter((t) => t.pending).length;

/** Невиконане з дедлайном у календарний день `day`. */
export const deadlinesOn = (s, day) =>
  s.tasks
    .filter(
      (t) => t.pending && t.deadline != null && t.deadline >= day && t.deadline < addDays(day, 1),
    )
    .sort(byDeadline);

export function gradesBySubject(s) {
  const m = new Map();
  for (const g of s.grades) {
    if (!m.has(g.subjectKey)) m.set(g.subjectKey, { subject: g.subject, grades: [] });
    m.get(g.subjectKey).grades.push(g);
  }
  return [...m.values()].sort((a, b) => a.subject.localeCompare(b.subject, 'uk'));
}
