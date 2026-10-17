// Інструменти асистента. Дані HUMAN — лише обгортки над src/service.js (жодних власних HTTP-запитів),
// книги — над src/books/library.js. Кожен інструмент повертає дані для моделі й картку для вікна.
import { dayStart, addDays, formatDay, formatShortDay, formatTime, kyivMidnight } from '../time.js';
import { byDeadline, lessonsOnDay } from '../model.js';
import { blocksToText, clip, pageText, taskSummary, LIMITS } from './context.js';

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Описи інструментів (однакові для всіх провайдерів; strict: аргументи точно за схемою). */
export const TOOL_DEFS = [
  {
    name: 'get_schedule',
    description:
      'Розклад уроків учня. Без аргументів — сьогодні. date у форматі YYYY-MM-DD, days — скільки днів від date (1–7).',
    input_schema: obj({
      date: { type: 'string', description: 'Дата YYYY-MM-DD за київським часом' },
      days: { type: 'integer', description: 'Кількість днів, 1–7' },
    }),
  },
  {
    name: 'get_homework',
    description:
      'Домашні завдання учня. status: pending — невиконані (типово), done — здані, all — усі. subject — частина назви предмета. ' +
      'task_id — повний текст одного завдання.',
    input_schema: obj({
      status: { type: 'string', enum: ['pending', 'done', 'all'] },
      subject: { type: 'string' },
      task_id: { type: 'integer' },
    }),
  },
  {
    name: 'get_grades',
    description:
      'Оцінки учня за завантажений період (приблизно останні два тижні). subject — частина назви предмета.',
    input_schema: obj({ subject: { type: 'string' } }),
  },
  {
    name: 'find_book',
    description:
      'Знайти завантажений учнем підручник за предметом (наприклад «Алгебра»). Повертає book_id.',
    input_schema: obj({ subject: { type: 'string' } }, ['subject']),
  },
  {
    name: 'get_page',
    description:
      'Одна сторінка підручника за друкованим номером із домашки. exercise — номер вправи («2», «345»), щоб знайти її на сторінці або сусідній.',
    input_schema: obj(
      {
        book_id: { type: 'string' },
        page: { type: 'integer', description: 'Друкований номер сторінки' },
        exercise: { type: 'string' },
      },
      ['book_id', 'page'],
    ),
  },
  {
    name: 'search_book',
    description:
      'Повнотекстовий пошук у підручниках учня (запасний шлях, коли номера сторінки немає). Повертає сторінки з уривками.',
    input_schema: obj({ query: { type: 'string' }, book_id: { type: 'string' } }, ['query']),
  },
];

/** Перевірка аргументів за схемою (провайдери без strict або обрізаний потік можуть дати що завгодно). */
export function validateInput(name, input) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) return 'unknown tool';
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const { properties, required } = def.input_schema;
  for (const k of Object.keys(input))
    if (!(k in properties) && input[k] != null) return `unexpected field ${k}`;
  for (const k of required) if (input[k] == null) return `missing ${k}`;
  for (const [k, p] of Object.entries(properties)) {
    const v = input[k];
    if (v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') return `${k} must be a string`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `${k} must be an integer`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`;
    if (typeof v === 'string' && v.length > 300) return `${k} is too long`;
  }
  return null;
}

const norm = (s) =>
  String(s ?? '')
    .toLocaleLowerCase('uk')
    .replace(/\s+/g, ' ')
    .trim();
const subjectMatch = (name, q) => !q || norm(name).includes(norm(q));

function parseDate(s, now) {
  if (!s) return dayStart(now);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? kyivMidnight(+m[1], +m[2], +m[3]) : null;
}

/**
 * @param {{ service: ReturnType<import('../service.js').createService>,
 *   books?: any, now?: () => number }} deps
 */
export function createTools({ service, books = null, now = () => Math.floor(Date.now() / 1000) }) {
  const snap = () => service.getState().snapshot;

  const handlers = {
    async get_schedule({ date, days }) {
      const s = snap();
      if (!s) return { result: { error: 'Дані HUMAN ще не завантажені' } };
      const from = parseDate(date, now());
      if (from == null) return { result: { error: 'date має бути у форматі YYYY-MM-DD' } };
      const n = Math.min(7, Math.max(1, days ?? 1));
      const out = [];
      for (let i = 0; i < n; i++) {
        const day = addDays(from, i);
        const inWindow = day >= s.window.from && day < s.window.to;
        const lessons = inWindow
          ? lessonsOnDay(s, day)
          : ((await service.getWeek(day))?.lessons ?? []).filter(
              (l) => l.start >= day && l.start < addDays(day, 1),
            );
        out.push({
          day,
          label: formatDay(day),
          lessons: lessons.map((l) => ({
            subject: l.subject,
            subjectKey: l.subjectKey,
            period: l.period,
            time: `${formatTime(l.start)}–${formatTime(l.end)}`,
            theme: l.title || '',
            cancelled: !!l.cancelled,
          })),
        });
      }
      return {
        result: out.map((d) => ({
          date: d.label,
          lessons: d.lessons.map((l) => ({
            subject: l.subject,
            period: l.period,
            time: l.time,
            theme: l.theme,
            cancelled: l.cancelled,
          })),
        })),
        card: { kind: 'schedule', days: out },
      };
    },

    async get_homework({ status = 'pending', subject, task_id }) {
      const s = snap();
      if (!s) return { result: { error: 'Дані HUMAN ще не завантажені' } };
      if (task_id != null) {
        const t = s.tasks.find((x) => x.id === task_id);
        if (!t) return { result: { error: `Завдання ${task_id} не знайдено` } };
        const r = await service.getTaskText(t.id);
        return {
          result: {
            ...taskSummary(t),
            text: r?.ok ? clip(blocksToText(r.blocks), LIMITS.taskChars) : '(текст недоступний)',
          },
          card: { kind: 'homework', ids: [t.id] },
        };
      }
      const done = new Set(['submitted', 'accepted']);
      const list = s.tasks
        .filter((t) =>
          status === 'all' ? true : status === 'done' ? done.has(t.status) : t.pending,
        )
        .filter((t) => subjectMatch(t.subject, subject))
        .sort(byDeadline)
        .slice(0, 30);
      return {
        result: { count: list.length, tasks: list.map(taskSummary) },
        card: { kind: 'homework', ids: list.slice(0, 8).map((t) => t.id), total: list.length },
      };
    },

    async get_grades({ subject }) {
      const s = snap();
      if (!s) return { result: { error: 'Дані HUMAN ще не завантажені' } };
      const list = s.grades
        .filter((g) => subjectMatch(g.subject, subject))
        .sort((a, b) => b.date - a.date)
        .slice(0, 60);
      return {
        result: list.map((g) => ({
          subject: g.subject,
          grade: g.value,
          kind: g.kind,
          date: formatShortDay(g.date),
        })),
        card: { kind: 'grades', grades: list },
      };
    },

    async find_book({ subject }) {
      if (!books) return { result: { error: 'Бібліотека недоступна' } };
      const list = books.findBooks(subject);
      return {
        result: list.length
          ? list.map((b) => ({
              book_id: b.id,
              title: b.title,
              subject: b.subject,
              pages: b.pageCount,
            }))
          : {
              error: `Підручника з предмета «${subject}» немає. Попроси учня завантажити його у вкладці «Книги».`,
            },
        card: list.length
          ? {
              kind: 'books',
              books: list.map((b) => ({ id: b.id, title: b.title, subject: b.subject })),
            }
          : null,
      };
    },

    async get_page({ book_id, page, exercise }) {
      if (!books) return { result: { error: 'Бібліотека недоступна' } };
      const r = await books.getPage(book_id, page, { exercise });
      if (!r.ok) return { result: { error: r.error } };
      const result = {
        book: r.title,
        printed_page: r.printed,
        pdf_page: r.index + 1,
        approximate: r.approximate,
        note: r.approximate
          ? 'Зсув друкованих номерів не відкалібровано: сторінка може бути сусідньою, попроси учня перевірити.'
          : undefined,
        exercise_found: exercise ? r.exerciseFound : undefined,
        text: r.scanned ? '(сторінка — скан без тексту, див. зображення)' : pageText(r.text),
      };
      return {
        result,
        image: r.scanned ? await books.pageImage(book_id, r.index).catch(() => null) : null,
        card: {
          kind: 'page',
          bookId: book_id,
          title: r.title,
          printed: r.printed,
          index: r.index,
          approximate: r.approximate,
        },
      };
    },

    async search_book({ query, book_id }) {
      if (!books) return { result: { error: 'Бібліотека недоступна' } };
      const hits = books.search(query, { bookId: book_id, limit: 5 });
      return {
        result: hits.length
          ? hits.map((h) => ({
              book_id: h.bookId,
              book: h.title,
              page: h.printed,
              snippet: h.snippet,
            }))
          : { error: 'Нічого не знайдено' },
        card: hits.length ? { kind: 'search', hits } : null,
      };
    },
  };

  return {
    defs: TOOL_DEFS.filter(
      (d) => books || !['find_book', 'get_page', 'search_book'].includes(d.name),
    ),
    /** @returns {Promise<{ result: any, image?: {mediaType:string,data:string}|null, card?: any, isError?: boolean }>} */
    async run(name, input) {
      const err = validateInput(name, input);
      if (err) return { result: { error: `Некоректні аргументи: ${err}` }, isError: true };
      try {
        const out = await handlers[name](input);
        return { ...out, isError: !!out.result?.error };
      } catch {
        return { result: { error: 'Інструмент не спрацював' }, isError: true };
      }
    },
  };
}
