// Сира відповідь calendar → внутрішня модель (Lesson, Task, Grade). UI про формат Human нічого не знає.
// Кожна секція розбирається захисно: збій однієї не валить решту (її назва потрапляє в `partial`).
import { DEFAULT_PERIOD_GROUP, HOME_TASK_USER_STATUS, STUDENT_TASK_FILTERS } from './api.js';
import { addDays, dayStart, isoWeek, isoWeekday } from './time.js';

/**
 * @typedef {Object} Lesson
 * @property {string} id
 * @property {number} start unix, секунди
 * @property {number} end
 * @property {string} subject
 * @property {string} subjectKey
 * @property {number|null} themeId
 * @property {string} title тема уроку
 * @property {number|null} period номер уроку за дзвінками
 * @property {string|null} zoomUrl
 * @property {boolean} cancelled
 * @property {boolean} replacement заміна вчителя
 * @property {boolean} rescheduled
 * @property {boolean} projected урок узято з розкладу (запису про урок ще немає)
 * @property {{id: string, title: string, typeName: string, updatedAt: number}[]} lessonTasks матеріали уроку («Заняття», «Зошит», «Тест»…); id має вигляд «L123»
 *
 * @typedef {'assigned'|'overdue'|'submitted'|'accepted'|'returned'|'unknown'} TaskStatus
 * @typedef {Object} Task
 * @property {number} id
 * @property {number} themeId
 * @property {string} subject
 * @property {string} subjectKey
 * @property {string} themeTitle
 * @property {number|null} deadline unix, секунди
 * @property {number|null} lessonStart початок уроку, на якому задано
 * @property {TaskStatus} status
 * @property {boolean} statusKnown
 * @property {boolean} pending потрібно ще зробити
 * @property {number|null} submittedAt
 * @property {boolean} late
 * @property {string} typeName
 * @property {string|null} contentId
 * @property {number} updatedAt
 * @property {string|number|null} grade
 *
 * @typedef {Object} Grade
 * @property {number} id
 * @property {string} subject
 * @property {string} subjectKey
 * @property {number|null} value
 * @property {string} kind «Заняття», «Зошит», «Тест», «Завдання»…
 * @property {number} date
 *
 * @typedef {Object} Session
 * @property {number} uid
 * @property {boolean} student
 *
 * @typedef {Object} Snapshot
 * @property {{from:number,to:number}} window
 * @property {Lesson[]} lessons
 * @property {Task[]} tasks
 * @property {Grade[]} grades
 * @property {number[]} weekends початки днів, які є вихідними
 * @property {string[]} partial секції, які не вдалося розпізнати
 */

const arr = (x) => (Array.isArray(x) ? x : []);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const PENDING = new Set(['assigned', 'overdue', 'returned', 'unknown']);
const safeHttps = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/**
 * @param {any} raw відповідь calendar
 * @param {{ now: number, from: number, to: number, studentTasks?: Record<string, any[]> | null }} ctx
 * studentTasks — відповіді students-tasks (точні статуси). Якщо їх немає, статуси виводяться з календаря (наближено).
 * @returns {Snapshot}
 */
export function normalizeCalendar(raw, { now, from, to, studentTasks = null }) {
  const partial = [];
  const section = (name, fn, fallback) => {
    try {
      return fn();
    } catch {
      partial.push(name);
      return fallback;
    }
  };
  const r = raw && typeof raw === 'object' ? raw : {};

  const groups = new Map(arr(r.groups).map((g) => [g?.id, g]));
  const subjects = new Map(arr(r.subjects).map((s) => [s?.id, s]));
  const themes = new Map(arr(r.themes).map((t) => [t?.id, t]));
  const subjectOf = (group, groupId) => {
    const g = group ?? groups.get(groupId);
    const s = g?.subject ?? subjects.get(g?.subject_id);
    const name = s?.i18n?.name ?? s?.name;
    return {
      subject: typeof name === 'string' && name ? name : '—',
      subjectKey: String(g?.subject_id ?? name ?? groupId ?? '?'),
    };
  };

  const periods = section(
    'periods',
    () =>
      arr(r.periods)
        .filter((p) => isNum(p?.number) && isNum(p?.start_at) && isNum(p?.finish_at))
        .map((p) => ({
          number: p.number,
          group: p.group_number,
          start: p.start_at,
          end: p.finish_at,
        })),
    [],
  );
  const periodOf = (n) =>
    periods.find((p) => p.number === n && p.group === DEFAULT_PERIOD_GROUP) ??
    periods.find((p) => p.number === n);

  const weekends = section(
    'weekends',
    () => {
      const days = new Set();
      for (const w of arr(r.weekends)) {
        if (isNum(w?.date)) days.add(dayStart(w.date));
        else if (isNum(w?.date_start) && isNum(w?.date_finish ?? w?.date_end))
          for (let d = dayStart(w.date_start); d < (w.date_finish ?? w.date_end); d = addDays(d, 1))
            days.add(d);
      }
      return days;
    },
    new Set(),
  );

  // Скасування: або весь день (schedule_helper_id === null), або конкретний урок розкладу.
  const cancelDays = new Set();
  const cancelHelpers = new Set();
  section(
    'cancellationLessons',
    () => {
      for (const c of arr(r.cancellationLessons)) {
        if (!isNum(c?.date)) continue;
        const d = dayStart(c.date);
        if (c.schedule_helper_id == null) cancelDays.add(d);
        else cancelHelpers.add(`${c.schedule_helper_id}-${d}`);
      }
    },
    null,
  );
  // Форма lessonReschedules не перевірена на живих даних: лише позначаємо збіг за уроком розкладу й днем.
  const rescheduled = new Set();
  section(
    'lessonReschedules',
    () => {
      for (const x of arr(r.lessonReschedules))
        if (isNum(x?.schedule_helper_id) && isNum(x?.date))
          rescheduled.add(`${x.schedule_helper_id}-${dayStart(x.date)}`);
    },
    null,
  );
  const replaced = new Set(
    arr(r.replacementTeachers)
      .map((x) => x?.lesson_event_id)
      .filter(isNum),
  );

  const helpers = new Map(arr(r.scheduleHelpers).map((h) => [h?.id, h]));

  const lessonTasksByTheme = new Map();
  for (const lt of arr(r.lessonTasks)) {
    if (!isNum(lt?.id) || !isNum(lt.theme_id)) continue;
    if (!lessonTasksByTheme.has(lt.theme_id)) lessonTasksByTheme.set(lt.theme_id, []);
    lessonTasksByTheme
      .get(lt.theme_id)
      .push({
        id: `L${lt.id}`,
        title: typeof lt.title === 'string' ? lt.title : '',
        typeName: typeof lt.type?.name === 'string' && lt.type.name ? lt.type.name : 'Заняття',
        updatedAt: isNum(lt.updated_at) ? lt.updated_at : 0,
      });
  }

  /** @type {Lesson[]} */
  const lessons = section(
    'lessonEvents',
    () => {
      const out = [];
      const seen = new Set();
      for (const l of arr(r.lessonEvents)) {
        if (!isNum(l?.id) || !isNum(l?.date)) continue;
        const d = dayStart(l.date);
        const h = helpers.get(l.schedule_helper_id);
        const key = h ? `${h.id}-${d}` : null;
        if (key) seen.add(key);
        const t = themes.get(l.theme_id);
        out.push({
          id: `e${l.id}`,
          start: l.date,
          end: isNum(l.date_end) ? l.date_end : l.date + 2700,
          ...subjectOf(l.group, l.group_id),
          themeId: isNum(l.theme_id) ? l.theme_id : null,
          title: typeof t?.title === 'string' ? t.title : '',
          period: h?.period ?? null,
          zoomUrl: safeHttps(l.webConference?.url),
          cancelled: cancelDays.has(d) || (key ? cancelHelpers.has(key) : false),
          replacement: replaced.has(l.id),
          rescheduled: key ? rescheduled.has(key) : false,
          projected: false,
          lessonTasks: lessonTasksByTheme.get(l.theme_id) ?? [],
        });
      }
      // Майбутні дні: уроки створюються лише коли вчитель їх спланував, тож добудовуємо з розкладу.
      const containers = arr(Object.values(r.scheduleHelperContainers ?? {}));
      const containerOf = new Map(containers.map((c) => [c?.id, c]));
      for (let d = Math.max(dayStart(now), from); d < to; d = addDays(d, 1)) {
        if (weekends.has(d)) continue;
        const dow = isoWeekday(d);
        const parity = isoWeek(d) % 2; // непарний → знаменник (1), парний → чисельник (0)
        for (const h of helpers.values()) {
          if (h?.day_of_week !== dow || (h.event_type ?? 0) !== 0) continue;
          if (h.week !== 2 && h.week !== parity) continue;
          const c = containerOf.get(h.container_id);
          if (
            c &&
            ((isNum(c.date_start) && d < c.date_start) ||
              (isNum(c.date_finish) && d >= c.date_finish))
          )
            continue;
          const key = `${h.id}-${d}`;
          const p = periodOf(h.period);
          if (seen.has(key) || !p) continue;
          out.push({
            id: `h${key}`,
            start: d + p.start,
            end: d + p.end,
            ...subjectOf(h.group, h.group_id),
            themeId: null,
            title: '',
            period: h.period,
            zoomUrl: null,
            cancelled: cancelDays.has(d) || cancelHelpers.has(key),
            replacement: false,
            rescheduled: rescheduled.has(key),
            projected: true,
            lessonTasks: [],
          });
        }
      }
      return out.sort((a, b) => a.start - b.start);
    },
    [],
  );

  const lessonStartByTheme = new Map();
  for (const l of lessons)
    if (l.themeId != null && !l.projected)
      lessonStartByTheme.set(
        l.themeId,
        Math.min(l.start, lessonStartByTheme.get(l.themeId) ?? Infinity),
      );

  const assessments = section(
    'assessments',
    () => arr(r.assessments).filter((a) => isNum(a?.id)),
    [],
  );
  const gradeByTask = new Map();
  for (const a of assessments)
    if (isNum(a.home_task_id) && a.entity_type === 1)
      gradeByTask.set(a.home_task_id, isNum(a.int_value) ? a.int_value : null);

  /** @type {Task[]} */
  const tasks = section(
    'homeTasks',
    () => {
      // Дані календаря: зв'язок із уроками, content_id, updated_at, тип.
      const mine = new Map();
      const due = new Map();
      for (const u of arr(r.userHomeTasks)) {
        for (const hu of arr(u?.homeTasksUsers))
          if (isNum(hu?.home_task_id)) mine.set(hu.home_task_id, hu);
        if (isNum(u?.id)) due.set(u.id, u);
      }
      const cal = new Map();
      for (const ht of arr(r.homeTasks)) if (isNum(ht?.id)) cal.set(ht.id, ht);
      for (const [id, u] of due) if (!cal.has(id)) cal.set(id, u);

      const make = (id, ht, extra) => {
        const deadline = isNum(extra.deadline)
          ? extra.deadline
          : isNum(ht?.expire_date)
            ? ht.expire_date
            : isNum(due.get(id)?.expire_date)
              ? due.get(id).expire_date
              : null;
        const overdue =
          (extra.base === 'assigned' || extra.base === 'returned') &&
          deadline != null &&
          deadline < now;
        const status = extra.known
          ? overdue
            ? 'overdue'
            : extra.base
          : deadline != null && deadline < now
            ? 'overdue'
            : 'unknown';
        const themeId = extra.themeId ?? ht?.theme_id;
        return {
          id,
          themeId,
          ...subjectOf(extra.group ?? ht?.group, extra.group?.id ?? ht?.group_id),
          themeTitle: extra.themeTitle || themes.get(themeId)?.title || '',
          deadline,
          lessonStart: lessonStartByTheme.get(themeId) ?? null,
          status,
          statusKnown: extra.known,
          pending: PENDING.has(status),
          submittedAt: extra.submittedAt ?? null,
          late: extra.submittedAt != null && deadline != null && extra.submittedAt > deadline,
          typeName: typeof ht?.type?.name === 'string' ? ht.type.name : 'Завдання',
          contentId: typeof ht?.content_id === 'string' ? ht.content_id : null,
          updatedAt: isNum(ht?.updated_at)
            ? ht.updated_at
            : isNum(extra.publishedAt)
              ? extra.publishedAt
              : 0,
          grade: extra.grade ?? gradeByTask.get(id) ?? null,
        };
      };

      const out = [];
      if (studentTasks) {
        // Точний шлях: категорії оригінальної вкладки «Завдання».
        const seen = new Set();
        for (const [filter, base] of Object.entries(STUDENT_TASK_FILTERS))
          for (const it of arr(studentTasks[filter])) {
            if (!isNum(it?.id) || seen.has(it.id)) continue;
            seen.add(it.id);
            const hu = it.home_tasks_user;
            out.push(
              make(it.id, cal.get(it.id), {
                base,
                known: true,
                deadline: it.expire_date,
                themeId: it.theme?.id,
                themeTitle: typeof it.theme?.title === 'string' ? it.theme.title : '',
                group: it.group,
                submittedAt: isNum(hu?.date_submission) ? hu.date_submission : null,
                publishedAt: it.published_at,
                grade: isNum(hu?.assessment?.int_value) ? hu.assessment.int_value : null,
              }),
            );
          }
      } else {
        // Запасний шлях (students-tasks недоступний): статус із userHomeTasks календаря, лише для завдань із дедлайном у вікні.
        partial.push('studentTasks');
        for (const [id, ht] of cal) {
          const hu = mine.get(id);
          out.push(
            make(id, ht, {
              base: hu ? (HOME_TASK_USER_STATUS[hu.status] ?? 'unknown') : 'unknown',
              known: !!hu,
              submittedAt: isNum(hu?.date_submission) ? hu.date_submission : null,
            }),
          );
        }
      }
      return out;
    },
    [],
  );

  /** @type {Grade[]} */
  const grades = section(
    'assessments',
    () => {
      const lessonTaskKinds = new Map(arr(r.lessonTasks).map((t) => [t?.id, t?.type?.name]));
      return assessments
        .map((a) => ({
          id: a.id,
          ...subjectOf(a.group, a.group_id),
          value: isNum(a.int_value) ? a.int_value : null,
          kind:
            (isNum(a.lesson_task_id) && lessonTaskKinds.get(a.lesson_task_id)) ||
            (a.entity_type === 1 ? 'Завдання' : 'Заняття'),
          date: isNum(a.created_at) ? a.created_at : 0,
        }))
        .sort((x, y) => y.date - x.date);
    },
    [],
  );

  return {
    window: { from, to },
    lessons,
    tasks,
    grades,
    weekends: [...weekends],
    partial: [...new Set(partial)],
  };
}
