// Демо-режим: синтетичні дані у сирому форматі API Human (проходять через той самий normalize.js).
// Вигадані предмети й теми; імен реальних людей немає. Мережі не торкається.
import { addDays, dayStart, isoWeek, isoWeekday } from './time.js';

const SUBJECTS = {
  1: 'Українська мова',
  2: 'Українська література',
  3: 'Алгебра',
  4: 'Геометрія',
  5: 'Фізика',
  6: 'Хімія',
  7: 'Біологія',
  8: 'Історія України',
  9: 'Іноземна мова (англійська)',
  10: 'Фізична культура',
  11: 'Інформатика',
  12: 'Географія',
};
const TOPICS = [
  'Повторення вивченого',
  'Нова тема: вступ',
  'Практична робота',
  'Узагальнення розділу',
  'Лабораторне заняття',
  'Робота з текстом',
  'Розв’язування задач',
  'Тематичне оцінювання',
];
// розклад: день тижня (1–5) → предмети за номерами уроків 1–6
const WEEK = {
  1: [1, 3, 9, 5, 10, 2],
  2: [3, 6, 1, 7, 12, 10],
  3: [2, 4, 9, 11, 5, 8],
  4: [1, 4, 3, 6, 9, 8],
  5: [7, 2, 5, 12, 11, 3],
};
const PERIOD_START = [30600, 33900, 37200, 40500, 43800, 47100, 50400, 53700];
const TEXTS = [
  '<p>Опрацювати конспект і виконати вправи <b>3–5</b> зі сторінки підручника.</p><ul><li>Повторити правило</li><li>Підготувати приклади</li></ul>',
  '<h3>Завдання</h3><p>Прочитати текст і скласти план із п’яти пунктів. Матеріали: <a href="https://zoom.us/j/000000000">приклад посилання</a>.</p>',
  '<p>Розв’язати задачі №12, №14. <img src="x" onerror="alert(1)"><script>alert(2)</script></p>',
  '<p>Підготувати коротке повідомлення (до 1 хвилини) за темою уроку.</p>',
];

const hash = (n) => ((n * 2654435761) >>> 0) % 1000;

/** @param {number} now unix, секунди */
export function createDemo(now) {
  const today = dayStart(now);
  const helpers = [];
  let hid = 1;
  for (const [dow, list] of Object.entries(WEEK))
    list.forEach((sid, i) => {
      // інформатика — через тиждень (чисельник/знаменник), решта — щотижня
      helpers.push({
        id: hid++,
        group_id: 100 + sid,
        group: group(sid),
        period: i + 1,
        day_of_week: +dow,
        week: sid === 11 ? 1 : 2,
        container_id: 1,
        event_type: 0,
      });
    });
  const events = [];
  const themes = [];
  const homeTasks = [];
  const userHomeTasks = [];
  const assessments = [];
  const themeBlocks = new Map();
  const lessonTasks = [];
  const lessonBlocks = new Map();
  let seq = 1;
  const from = addDays(today, -21);
  const created = addDays(today, 1); // записи про уроки є лише до завтра включно
  const nextLessonDay = (sid, after) => {
    for (let d = addDays(after, 1), n = 0; n < 21; d = addDays(d, 1), n++)
      if (
        helpers.some(
          (h) =>
            h.group_id === 100 + sid &&
            h.day_of_week === isoWeekday(d) &&
            (h.week === 2 || h.week === isoWeek(d) % 2),
        )
      )
        return d;
    return addDays(after, 7);
  };
  for (let d = from; d <= created; d = addDays(d, 1)) {
    for (const h of helpers) {
      if (h.day_of_week !== isoWeekday(d) || (h.week !== 2 && h.week !== isoWeek(d) % 2)) continue;
      const sid = h.group_id - 100;
      const n = seq++;
      const start = d + PERIOD_START[h.period - 1];
      events.push({
        id: n,
        date: start,
        date_end: start + 2700,
        theme_id: 5000 + n,
        group_id: h.group_id,
        group: group(sid),
        schedule_helper_id: h.id,
        status: 0,
        webConference: n % 5 === 0 ? { url: 'https://zoom.us/j/000000000' } : undefined,
      });
      themes.push({
        id: 5000 + n,
        title: `${TOPICS[n % TOPICS.length]} (${SUBJECTS[sid]})`,
        container_id: 1,
      });
      if (n % 3 !== 1) {
        const typeName = ['Заняття', 'Зошит', 'Тест'][n % 3];
        lessonTasks.push({
          id: 7000 + n,
          theme_id: 5000 + n,
          title: `${typeName}: ${SUBJECTS[sid]}`,
          type: { name: typeName },
          content_id: `lt${n}`,
          exists_mongo_content: 1,
          updated_at: start,
          published: 2,
        });
        lessonBlocks.set(5000 + n, {
          id: 7000 + n,
          updated_at: start,
          blocks: demoLessonBlocks(n, SUBJECTS[sid]),
        });
      }
      if (n % 4 === 3) continue; // не на кожному уроці є ДЗ
      const deadline = nextLessonDay(sid, d) + 8 * 3600;
      const htId = 9000 + n;
      const past = deadline < now;
      const roll = hash(n);
      const status = past ? (roll < 700 ? 2 : roll < 850 ? 1 : 0) : roll < 150 ? 1 : 0;
      homeTasks.push({
        id: htId,
        theme_id: 5000 + n,
        group_id: h.group_id,
        group: group(sid),
        expire_date: deadline,
        content_id: `demo${n}`,
        exists_mongo_content: 1,
        updated_at: start,
        published: 2,
        type: { name: 'Завдання' },
      });
      userHomeTasks.push({
        id: htId,
        theme_id: 5000 + n,
        group_id: h.group_id,
        expire_date: deadline,
        homeTasksUsers: [
          { home_task_id: htId, status, date_submission: status ? deadline - 3600 : null },
        ],
      });
      themeBlocks.set(5000 + n, { id: htId, updated_at: start, blocks: demoBlocks(n), status });
      if (status === 2)
        assessments.push({
          id: 20000 + n,
          home_task_id: htId,
          entity_type: 1,
          int_value: 7 + (roll % 6),
          created_at: deadline,
          group: group(sid),
        });
    }
  }
  const cancelDay = addDays(today, 8);
  const holiday = addDays(today, 15);
  const cancelHelper = helpers.find((h) => h.day_of_week === isoWeekday(cancelDay) && h.week === 2);
  const calendar = (fromSec, toSec) => ({
    periods: PERIOD_START.map((s, i) => ({
      id: i + 1,
      number: i + 1,
      start_at: s,
      finish_at: s + 2700,
      group_number: 99,
    })),
    lessonEvents: events.filter((e) => e.date >= fromSec && e.date < toSec),
    homeTasks: homeTasks.filter((t) =>
      events.some((e) => e.theme_id === t.theme_id && e.date >= fromSec && e.date < toSec),
    ),
    userHomeTasks: userHomeTasks.filter((u) => u.expire_date >= fromSec && u.expire_date < toSec),
    lessonTasks: lessonTasks.filter((x) =>
      events.some((e) => e.theme_id === x.theme_id && e.date >= fromSec && e.date < toSec),
    ),
    themes,
    assessments: assessments.filter((a) => a.created_at >= fromSec && a.created_at < toSec),
    groups: Object.keys(SUBJECTS).map((sid) => group(+sid)),
    subjects: Object.entries(SUBJECTS).map(([id, name]) => ({ id: +id, i18n: { name } })),
    scheduleHelpers: helpers,
    scheduleHelperContainers: [
      { id: 1, date_start: addDays(today, -60), date_finish: addDays(today, 120) },
    ],
    weekends: [{ date: holiday }],
    cancellationLessons: cancelHelper
      ? [{ id: 1, date: cancelDay, schedule_helper_id: cancelHelper.id }]
      : [],
    lessonReschedules: [],
    replacementTeachers:
      events.length > 30 ? [{ lesson_event_id: events[events.length - 3].id, type: 1 }] : [],
    attendances: [],
  });
  const theme = (themeId) => {
    const b = themeBlocks.get(themeId);
    const lb = lessonBlocks.get(themeId);
    const lesson_tasks = lb
      ? [
          {
            id: lb.id,
            updated_at: lb.updated_at,
            content: { hash: `l${lb.id}`, blocks: lb.blocks },
          },
        ]
      : [];
    if (!b) return { id: themeId, home_tasks: [], lesson_tasks };
    return {
      id: themeId,
      lesson_tasks,
      home_tasks: [
        {
          id: b.id,
          updated_at: b.updated_at,
          content: { hash: `d${b.id}`, blocks: b.blocks },
          home_tasks_users: [{ status: b.status }],
        },
      ],
    };
  };
  /** Імітація students-tasks: усі завдання за категоріями (received / review / approved / rejected). */
  const studentTasks = () => {
    const lists = { received: [], review: [], approved: [], rejected: [] };
    for (const u of userHomeTasks) {
      const hu = u.homeTasksUsers[0];
      const ht = homeTasks.find((x) => x.id === u.id);
      const item = {
        id: u.id,
        expire_date: u.expire_date,
        published_at: ht?.updated_at,
        theme: { id: u.theme_id, title: themes.find((t) => t.id === u.theme_id)?.title ?? '' },
        group: ht?.group,
        home_tasks_user: {
          status: hu.status,
          date_submission: hu.date_submission,
          assessment: assessments.find((a) => a.home_task_id === u.id)
            ? { int_value: assessments.find((a) => a.home_task_id === u.id).int_value }
            : null,
        },
      };
      (hu.status === 2 ? lists.approved : hu.status === 1 ? lists.review : lists.received).push(
        item,
      );
    }
    return lists;
  };
  return { calendar, theme, image: demoImage, studentTasks };
}

/** Блоки ДЗ у форматі Human: різні типи, щоб у демо було видно все, що вміє показувати застосунок. */
function demoBlocks(n) {
  const out = [];
  if (n % 6 === 3) out.push({ type: 'tl01', data: { title: 'Що потрібно зробити' } });
  out.push({ type: 'tx01', data: { text: TEXTS[n % TEXTS.length] } });
  if (n % 6 === 3)
    out.push(
      { type: 'ip01', data: { text: 'Роботу варто надіслати до початку наступного уроку.' } },
      { type: 'dv01', data: {} },
    );
  if (n % 5 === 0)
    out.push({
      type: 'lk01',
      data: {
        url: 'https://www.example.org/trainer',
        link: {
          url: 'https://www.example.org/trainer',
          title: 'Онлайн-тренажер із теми',
          image: '',
          description: 'Інтерактивні вправи для самоперевірки (демо-посилання).',
        },
      },
    });
  if (n % 5 === 1)
    out.push({
      type: 'im01',
      data: {
        url: `https://files.human.ua/images/demo-${n}.png`,
        text: 'Схема до завдання (демо-зображення)',
      },
    });
  if (n % 7 === 2)
    out.push({
      type: 'fl01',
      data: { file: { name: 'Конспект_уроку', extension: 'pdf', size: 2457600, hash: `demo${n}` } },
    });
  if (n % 8 === 4) out.push({ type: 'cf01', data: { text: 'x^2 + 5x + 6 = 0' } });
  if (n % 8 === 5)
    out.push({
      type: 'ct01',
      data: {
        text: '<table><thead><tr><th>Слово</th><th>Переклад</th></tr></thead><tbody><tr><td>journey</td><td>подорож</td></tr><tr><td>luggage</td><td>багаж</td></tr></tbody></table>',
      },
    });
  if (n % 9 === 0) out.push({ type: 'qn01', data: {} });
  return out;
}

/** Матеріали уроку («Заняття» / «Зошит» / «Тест») у форматі Human. */
function demoLessonBlocks(n, subject) {
  const out = [
    { type: 'tl01', data: { title: `Матеріали з предмета «${subject}»` } },
    {
      type: 'tx01',
      data: {
        text: '<p>Конспект уроку: основні поняття, приклади та запитання для самоперевірки.</p><ul><li>Ключова ідея теми</li><li>Приклад із розв’язанням</li></ul>',
      },
    },
  ];
  if (n % 2 === 0)
    out.push({
      type: 'im01',
      data: {
        url: `https://files.human.ua/images/lesson-${n}.png`,
        text: 'Ілюстрація до теми (демо-зображення)',
      },
    });
  if (n % 4 === 0)
    out.push({
      type: 'lk01',
      data: {
        url: 'https://www.example.org/video',
        link: {
          url: 'https://www.example.org/video',
          title: 'Відео до уроку',
          image: '',
          description: 'Додатковий матеріал (демо-посилання).',
        },
      },
    });
  if (n % 5 === 0)
    out.push({
      type: 'fl01',
      data: {
        file: { name: 'Презентація', extension: 'pptx', size: 5242880, hash: `lessondemo${n}` },
      },
    });
  return out;
}

/** Демо-зображення: згенерований SVG (як <img> скрипти не виконує). */
function demoImage(url) {
  const hue = (String(url).length * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 38%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360} 60% 52%)"/></linearGradient></defs><rect width="640" height="320" rx="24" fill="url(#g)"/><circle cx="500" cy="90" r="46" fill="rgba(255,255,255,.25)"/><path d="M0 250 Q160 170 320 230 T640 200 V320 H0Z" fill="rgba(255,255,255,.18)"/><text x="32" y="64" font-family="Segoe UI, sans-serif" font-size="30" font-weight="600" fill="#fff">Демо-зображення</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function group(sid) {
  return { id: 100 + sid, subject_id: sid, subject: { id: sid, i18n: { name: SUBJECTS[sid] } } };
}
