// Єдине вікно: заголовок зі склом, вкладки Сьогодні / На наступний урок / Усі завдання / Розклад / Оцінки
// і компактний міні-режим «Що задано на завтра» (те саме вікно, без додаткових).
// Дані приходять готовими зі стану main-процесу; тут лише вибірка (model.js) і відмальовування.
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs';
import { createAssistantUI } from './assistant-ui.js';
import { createBooksUI } from './books-ui.js';
import { createFilesUI } from './files-ui.js';
import { icon, logo } from './icons.js';
import { dayView, gradesBySubject, nextView, subjectsOf, tasksView } from './model.js';
import { createSanitizer } from './sanitize.js';
import { DEFAULT_COLORS, PRESETS, applyTheme } from './theme.js';
import {
  addDays,
  dayStart,
  formatDay,
  formatShortDay,
  formatTime,
  kyivParts,
  plural,
  weekStart,
} from './time.js';
import {
  badge,
  counter,
  deadlineText,
  countText,
  createTexts,
  dayLabel,
  h,
  initSpotlight,
  keepFocus,
  lessonTime,
  subjectColor,
  subjectDot,
  taskBody,
  taskCard,
} from './ui.js';
import { uk } from './uk.js';

const api = window.hd;
const root = document.getElementById('app');
const nowSec = () => Math.floor(Date.now() / 1000);
const TABS = ['assistant', 'calendar', 'today', 'tasks', 'grades', 'books', 'files'];

let st = null;
let settings = {};
let refreshing = false;
let dialogRefresh = null;
let toast = '';
const ui = {
  tab: 'calendar',
  lesson: null,
  dayOffset: 0,
  weekOffset: 0,
  animate: true,
  filter: { status: 'pending', subject: '', group: 'date', range: '2w' },
  expanded: new Set(),
  expandedLessons: new Set(),
  autoOpened: new Set(),
  schedule: new Map(),
  fetching: new Set(),
};

const tctx = { expanded: ui.expanded, api, sanitize: createSanitizer(DOMPurify), texts: null };
tctx.texts = createTexts(api, (t) => {
  for (const inner of document.querySelectorAll(`[data-task="${t.id}"] .inner`))
    if (ui.expanded.has(t.id)) inner.replaceChildren(taskBody(t, tctx));
});
const assistant = createAssistantUI({
  api,
  tctx,
  getSnapshot: () => st?.snapshot,
  rerender: () => render(),
  // картка «сторінка підручника» в чаті відкриває читач на цій сторінці
  openPage: (c) => books.openAt(c.bookId, c.index).then(() => go({ tab: 'books' })),
});
const books = createBooksUI({
  api,
  rerender: () => render(),
  subjects: () => (st?.snapshot ? subjectsOf(st.snapshot) : []),
  // «Показати асистенту»: лише виділені фрагменти, чат відкривається поруч із читачем
  onSend: ({ fragments, text }) => {
    if (!settings.aiPanel) api.setSettings({ aiPanel: true });
    assistant.ask({ text, fragments });
  },
});
/** Текст блоків ДЗ (для пошуку «с. 34, № 2»): HTML розбирається у від'єднаному документі, нічого не виконується. */
const blocksText = (blocks) => {
  const doc = document.implementation.createHTMLDocument('');
  return blocks
    .map((b) => {
      if (b.kind !== 'html' && b.kind !== 'table') return b.text ?? b.title ?? '';
      doc.body.innerHTML = tctx.sanitize(b.html);
      return doc.body.textContent;
    })
    .join('\n');
};
/** Кнопка «Підручник» у завданні: книга предмета на сторінці з домашки. */
tctx.onBook = async (task, blocks) => {
  const ok = await books.openFor(task.subject, `${task.themeTitle ?? ''}\n${blocksText(blocks)}`);
  if (ok) go({ tab: 'books' });
  else alert(uk.books.noTextbook);
};
const filesUI = createFilesUI({ api, sanitize: tctx.sanitize, rerender: () => render() });
/** «Відкрити» у файлі завдання: кеш + вбудований переглядач. */
tctx.onOpenFile = (taskId, index) => filesUI.openFromTask(taskId, index);
/** Кнопки «Пояснити» / «Дай відповідь для зошита»: чат відкривається поруч із контентом. */
tctx.onAsk = (mode, task) => {
  if (ui.tab !== 'assistant' && !settings.aiPanel) api.setSettings({ aiPanel: true });
  assistant.ask({ mode, taskId: task.id });
};

const btn = (label, onclick, props = {}) => h('button', { class: 'btn', onclick, ...props }, label);
const iconBtn = (name, label, onclick, props = {}) =>
  h(
    'button',
    { class: 'btn icon', onclick, 'aria-label': label, title: label, ...props },
    icon(name, 16),
  );
/** Заголовок розділу в картці уроку: значок, назва, кількість і лінія-розділювач. */
const sectHead = (name, label, count) =>
  h(
    'div',
    { class: 'sect' },
    icon(name, 14),
    h('span', { text: label }),
    count ? h('span', { class: 'sect-n num', text: String(count) }) : null,
  );
/** Кнопка-значок у заголовку вікна: без рамки, підсвічується при наведенні. */
const tbtn = (name, label, onclick, props = {}) =>
  h(
    'button',
    { class: 'tbtn', onclick, 'aria-label': label, title: label, ...props },
    icon(name, 18),
  );
/** Завдання, що відкриваються самі при першому показі (щоб читати без другого кліку); далі стан за користувачем. */
const autoOpen = (ids) => {
  for (const id of ids)
    if (!ui.autoOpened.has(id)) {
      ui.autoOpened.add(id);
      ui.expanded.add(id);
    }
};
const pills = (key, value, options, onchange) =>
  h(
    'div',
    { class: 'pills', role: 'group' },
    options.map(([v, label]) =>
      h(
        'button',
        {
          class: 'pill',
          'aria-pressed': String(v === value),
          'data-k': `${key}-${v}`,
          onclick: () => onchange(v),
        },
        label,
      ),
    ),
  );
const lessonBadges = (l) => [
  l.cancelled && h('span', { class: 'badge bad' }, icon('x', 12), uk.lesson.cancelled),
  l.replacement && h('span', { class: 'badge warn' }, uk.lesson.replacement),
  l.rescheduled && h('span', { class: 'badge warn' }, uk.lesson.rescheduled),
];
const go = (patch) => {
  Object.assign(ui, patch, { animate: true });
  render();
};

function render() {
  keepFocus(() => {
    root.replaceChildren(shell());
    ui.animate = false;
  });
}

/* ---------- Каркас ---------- */
function shell() {
  const ready = st?.status === 'ready' && st.snapshot;
  const mini = !!settings.mini;
  const tools = h('div', { class: 'tools' });
  if (st?.updatedAt && !mini)
    tools.append(
      h('span', {
        class: 'updated',
        'aria-live': 'polite',
        text: uk.updatedAt(formatTime(st.updatedAt)),
      }),
    );
  if (st?.loggingIn)
    tools.append(
      btn(uk.buttons.cancelLogin, () => api.cancelLogin(), { 'data-k': 'cancel-login' }),
    );
  if (ready)
    tools.append(
      tbtn('refresh', uk.buttons.refresh, doRefresh, {
        'data-k': 'refresh',
        disabled: refreshing || null,
      }),
    );
  tools.append(
    tbtn(
      mini ? 'maximize' : 'minimize',
      mini ? uk.buttons.fullMode : uk.buttons.mini,
      () => api.toggleMini(),
      { 'data-k': 'mini' },
    ),
  );
  if (ready && !mini && ui.tab !== 'assistant')
    tools.append(
      tbtn(
        'panel',
        uk.buttons.assistantPanel,
        () => api.setSettings({ aiPanel: !settings.aiPanel }),
        {
          'data-k': 'ai-panel',
          'aria-pressed': String(!!settings.aiPanel),
        },
      ),
    );
  if (!mini)
    tools.append(tbtn('settings', uk.buttons.settings, openSettings, { 'data-k': 'settings' }));
  const top = h(
    'header',
    { class: 'top' },
    h(
      'div',
      { class: 'titlebar' },
      h('h1', { class: 'brand', title: uk.tagline }, logo(28), uk.appName),
      tools,
    ),
  );
  const body = mini && ready ? miniView() : screen();
  const page = h(
    'div',
    { class: 'page' + (ui.animate ? ' enter' : '') },
    banners(),
    Array.isArray(body) ? body : [body],
  );
  if (ui.animate)
    page.querySelectorAll(':scope > *').forEach((c, i) => c.style.setProperty('--i', String(i)));
  const main = h('main', { id: 'main', tabindex: '-1' }, page);
  const side =
    ready && !mini && settings.aiPanel && ui.tab !== 'assistant'
      ? h(
          'aside',
          { class: 'side-chat', 'aria-label': uk.ai.title },
          assistant.view({ compact: true, onClose: () => api.setSettings({ aiPanel: false }) }),
        )
      : null;
  const content = side ? h('div', { class: 'split' }, main, side) : main;
  return h(
    'div',
    { class: 'shell' + (ui.tab === 'assistant' ? ' full-chat' : '') },
    top,
    ready && !mini ? h('div', { class: 'body' }, sidenav(), content) : content,
  );
}

/** Вертикальна панель навігації зліва (структура як у щоденнику HUMAN; іконки й кольори свої). */
const NAV_ICON = {
  assistant: 'sparkles',
  calendar: 'calendar',
  today: 'list',
  tasks: 'clipboard',
  grades: 'chart',
  books: 'book',
  files: 'folder',
};
function sidenav() {
  const pending = st.snapshot.tasks.filter((x) => x.pending).length;
  const item = (t, i) =>
    h(
      'button',
      {
        class: 'nav-btn' + (t === 'assistant' ? ' ai' : ''),
        'aria-current': ui.tab === t ? 'page' : null,
        'aria-label': `${uk.tabs[t]} (${i + 1})`,
        title: `${uk.tabs[t]} · ${i + 1}`,
        'data-k': `tab-${t}`,
        onclick: () => go({ tab: t, lesson: null }),
      },
      icon(NAV_ICON[t], 22),
      h('span', { class: 'nav-label', text: uk.tabs[t] }),
      t === 'tasks' && pending
        ? h('span', { class: 'nav-badge num', text: String(pending) })
        : null,
    );
  return h(
    'nav',
    { class: 'sidenav', 'aria-label': uk.buttons.tabsAria },
    h('div', { class: 'nav-group' }, item('assistant', 0)),
    h(
      'div',
      { class: 'nav-group grow-nav' },
      TABS.slice(1).map((t, i) => item(t, i + 1)),
    ),
    h(
      'div',
      { class: 'nav-group' },
      h(
        'button',
        {
          class: 'nav-btn',
          'aria-label': uk.buttons.settings,
          title: uk.buttons.settings,
          'data-k': 'nav-settings',
          onclick: openSettings,
        },
        icon('settings', 22),
        h('span', { class: 'nav-label', text: uk.buttons.settings }),
      ),
    ),
  );
}

function banners() {
  const out = [];
  if (st?.demo) out.push(h('div', { class: 'banner demo', role: 'note', text: uk.states.demo }));
  if (st?.offline)
    out.push(h('div', { class: 'banner warn', role: 'status', text: uk.states.offline }));
  if (st?.paused)
    out.push(h('div', { class: 'banner warn', role: 'status', text: uk.states.paused }));
  if (st?.snapshot?.partial.length)
    out.push(h('div', { class: 'banner warn', role: 'status', text: uk.states.partial }));
  return out;
}

function center(title, text, ...actions) {
  return h(
    'section',
    { class: 'card pad center' },
    logo(56, 'logo'),
    h('p', { class: 'tagline', text: `${uk.appName} · ${uk.tagline}` }),
    h('h1', { text: title }),
    text ? h('p', { text }) : null,
    h('div', { class: 'row' }, actions),
    h('p', { class: 'foot', text: uk.loginFootnote }),
  );
}

const skeleton = () => [
  h('p', { class: 'sr', role: 'status', text: uk.states.loading }),
  ...[0, 1, 2, 3].map(() => h('div', { class: 'skeleton', 'aria-hidden': 'true' })),
];

function screen() {
  if (!st || (st.status === 'loading' && !st.snapshot)) return skeleton();
  switch (st.status) {
    case 'login':
      return center(
        uk.states.loginTitle,
        uk.states.loginText,
        btn(uk.buttons.login, () => api.login(), { class: 'btn primary', 'data-k': 'login' }),
      );
    case 'expired':
      return center(
        uk.states.sessionExpiredTitle,
        uk.states.sessionExpiredText,
        btn(uk.buttons.login, () => api.login(), { class: 'btn primary', 'data-k': 'login' }),
      );
    case 'notStudent':
      return center(
        uk.states.notStudentTitle,
        uk.states.notStudentText,
        btn(uk.buttons.logout, () => api.logout(), { class: 'btn primary', 'data-k': 'logout' }),
      );
    case 'error':
      return center(
        uk.states.errorTitle,
        st.offline ? uk.states.offline : uk.states.errorText,
        btn(uk.buttons.retry, doRefresh, { class: 'btn primary', 'data-k': 'retry' }),
      );
    default:
      return {
        today: todayTab,
        calendar: () => (ui.lesson ? lessonPage() : calendarTab()),
        tasks: tasksTab,
        grades: gradesTab,
        assistant: () => assistant.view(),
        books: () => books.view(),
        files: () => filesUI.view(),
      }[ui.tab]();
  }
}

async function doRefresh() {
  refreshing = true;
  render();
  try {
    st = await api.refresh();
  } finally {
    refreshing = false;
    render();
  }
}

/* ---------- Сьогодні ---------- */
function leftText(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return plural(m, uk.plural.minute);
  const hh = Math.floor(m / 60);
  return m % 60
    ? `${plural(hh, uk.plural.hour)} ${plural(m % 60, uk.plural.minute)}`
    : plural(hh, uk.plural.hour);
}

function greeting(t) {
  const hour = kyivParts(t).h;
  return hour < 5
    ? uk.greet.night
    : hour < 12
      ? uk.greet.morning
      : hour < 18
        ? uk.greet.day
        : uk.greet.evening;
}

/** Урок у таймлайні: клік розгортає картку (тема й ДЗ цього уроку з повним вмістом) без перемальовування сторінки. */
function timelineItem(l, tasks, t, isToday) {
  const open = ui.expandedLessons.has(l.id);
  const now = isToday && !l.cancelled && l.start <= t && t < l.end;
  const past = isToday && l.end <= t;
  const inner = h('div', { class: 'inner' });
  const wrap = h('div', { class: 'collapse', 'data-open': String(open) }, inner);
  wrap.inert = !open;
  const fill = () =>
    inner.replaceChildren(
      h(
        'div',
        { class: 'lesson-detail' },
        l.lessonTasks.length
          ? [
              sectHead('file', uk.lesson.materials, l.lessonTasks.length),
              h(
                'ul',
                { class: 'tasks' },
                l.lessonTasks.map((lt) =>
                  taskCard({ ...lt, kind: 'lesson' }, { ...tctx, showSubject: false }),
                ),
              ),
            ]
          : null,
        sectHead('check', uk.assigned, tasks.length),
        tasks.length
          ? h(
              'ul',
              { class: 'tasks' },
              (autoOpen(tasks.map((x) => x.id)), tasks).map((x) =>
                taskCard(x, { ...tctx, showSubject: false }),
              ),
            )
          : h('p', {
              class: 'meta pad',
              text: l.projected ? uk.lesson.projectedNote : uk.states.noHomework,
            }),
      ),
    );
  if (open) fill();
  const head = h(
    'button',
    {
      class: 'lesson-head',
      'aria-expanded': String(open),
      'data-k': `lesson-${l.id}`,
      onclick: () => {
        const nowOpen = !ui.expandedLessons.has(l.id);
        nowOpen ? ui.expandedLessons.add(l.id) : ui.expandedLessons.delete(l.id);
        if (nowOpen) fill();
        head.setAttribute('aria-expanded', String(nowOpen));
        wrap.inert = !nowOpen;
        wrap.dataset.open = String(nowOpen);
      },
    },
    h('span', { class: 'name' }, subjectDot(l.subjectKey), l.subject),
    h('span', {
      class: 'meta num',
      text: `${l.period ? l.period + ' ' + uk.lesson.lessonWord + ' · ' : ''}${lessonTime(l)}`,
    }),
    lessonBadges(l),
    l.lessonTasks.length
      ? h('span', { class: 'meta', text: plural(l.lessonTasks.length, uk.plural.material) })
      : null,
    tasks.length ? h('span', { class: 'meta', text: countText(tasks.length) }) : null,
    h('span', { class: 'grow' }),
    h('span', { class: 'chev' }, icon('chevronDown', 16)),
    l.title ? h('span', { class: 'theme', text: l.title }) : null,
  );
  const zoom =
    l.zoomUrl && !l.cancelled
      ? h(
          'button',
          {
            class: 'btn small lesson-zoom',
            'data-k': `zoom-${l.id}`,
            'aria-label': `${uk.buttons.zoom}: ${l.subject}`,
            onclick: () => api.openExternal(l.zoomUrl),
          },
          icon('video', 12),
          uk.buttons.zoom,
        )
      : null;
  return h(
    'li',
    {
      class: 'tl' + (now ? ' now' : '') + (past ? ' past' : '') + (l.cancelled ? ' cancelled' : ''),
    },
    h('span', { class: 't num', text: formatTime(l.start) }),
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h(
      'article',
      {
        class: 'card hover',
        style: `--sj:${subjectColor(l.subjectKey)}`,
        'aria-current': now ? 'time' : null,
      },
      h('div', { class: 'lesson-bar' }, head, zoom),
      wrap,
    ),
  );
}

function todayTab() {
  const t = nowSec();
  const today = dayStart(t);
  const day = addDays(today, ui.dayOffset);
  const isToday = ui.dayOffset === 0;
  const v = dayView(st.snapshot, day);
  const pending = st.snapshot.tasks.filter((x) => x.pending).length;
  const lab = dayLabel(day, today);
  const out = [];
  out.push(
    h(
      'div',
      { class: 'hello' },
      isToday ? h('h1', { text: greeting(t) }) : h('h1', { text: lab.main }),
      h('p', { text: isToday ? formatDay(day) : lab.sub }),
      h('p', { class: 'sub' }, `${uk.timeline.pendingTotal}: `, counter('pending-hello', pending)),
    ),
    h(
      'div',
      { class: 'daynav' },
      iconBtn('chevronLeft', uk.buttons.prevDay, () => go({ dayOffset: ui.dayOffset - 1 }), {
        'data-k': 'day-prev',
      }),
      iconBtn('chevronRight', uk.buttons.nextDay, () => go({ dayOffset: ui.dayOffset + 1 }), {
        'data-k': 'day-next',
      }),
      btn(uk.today, () => go({ dayOffset: 0 }), {
        disabled: isToday || null,
        'data-k': 'day-today',
      }),
    ),
  );
  if (!v.lessons.length) {
    out.push(h('p', { class: 'empty', text: v.weekend ? uk.lesson.weekend : uk.states.emptyDay }));
    if (isToday) out.push(tomorrowSection());
    return out;
  }
  if (isToday) {
    const cur = v.lessons.find(
      (x) => !x.lesson.cancelled && x.lesson.start <= t && t < x.lesson.end,
    );
    const nxt = v.lessons.find((x) => !x.lesson.cancelled && x.lesson.start > t);
    out.push(
      h('p', {
        class: 'countdown',
        'aria-live': 'polite',
        text: cur
          ? uk.timeline.now(cur.lesson.subject, leftText(cur.lesson.end - t))
          : nxt
            ? uk.timeline.next(leftText(nxt.lesson.start - t))
            : uk.timeline.dayOver,
      }),
    );
  }
  out.push(
    h(
      'ol',
      { class: 'timeline', 'aria-label': plural(v.lessons.length, uk.plural.lesson) },
      v.lessons.map((x) => timelineItem(x.lesson, x.tasks, t, isToday)),
    ),
  );
  const tasks = [...new Map(v.lessons.flatMap((x) => x.tasks).map((x) => [x.id, x])).values()];
  out.push(
    h(
      'section',
      { class: 'assigned', 'aria-labelledby': 'assigned-h' },
      h(
        'div',
        { class: 'assigned-head' },
        h('h2', { id: 'assigned-h', text: uk.assigned }),
        tasks.length ? h('span', { class: 'sect-n num', text: String(tasks.length) }) : null,
      ),
      tasks.length
        ? h(
            'ul',
            { class: 'tasks inset' },
            (autoOpen(tasks.map((x) => x.id)), tasks).map((x) =>
              taskCard(x, { ...tctx, showSubject: true }),
            ),
          )
        : h('p', { class: 'card pad meta', text: uk.states.noHomework }),
    ),
  );
  if (isToday) out.push(tomorrowSection());
  return out;
}

/* ---------- На наступний урок ---------- */
function nextItem({ lesson: l, tasks }) {
  const lab = dayLabel(dayStart(l.start), dayStart(nowSec()));
  return h(
    'article',
    { class: 'card hover' },
    h(
      'div',
      { class: 'row', style: 'padding:var(--sp-3) var(--sp-4) var(--sp-1)' },
      h('span', { class: 'name' }, subjectDot(l.subjectKey), l.subject),
      h('span', { class: 'meta num', text: `${lab.main}, ${formatTime(l.start)}` }),
      h('span', { class: 'grow' }),
    ),
    tasks.length
      ? h(
          'ul',
          { class: 'tasks' },
          tasks.map((t) => taskCard(t, tctx)),
        )
      : h('p', {
          class: 'meta',
          style: 'margin:0;padding:0 var(--sp-4) var(--sp-3)',
          text: uk.states.noHomework,
        }),
  );
}

/** Блок «На завтра» внизу вкладки «Сьогодні»: найближчі уроки завтра й невиконане до них. */
function tomorrowSection() {
  const v = nextView(st.snapshot, nowSec());
  if (!v.tomorrow.length) return null;
  return h(
    'section',
    { class: 'tomorrow', 'aria-labelledby': 'tomorrow-h' },
    h('h2', { class: 'group', id: 'tomorrow-h' }, uk.tomorrowBlock),
    v.tomorrow.map(nextItem),
  );
}

/* ---------- Завдання: картки зі статусом і дедлайном, категорії як у щоденнику ---------- */
const select = (key, value, options, onchange) =>
  h(
    'select',
    { 'data-k': key, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) =>
      h('option', { value: v, selected: v === value ? true : null }, label),
    ),
  );

/** Картка завдання в сітці: предмет, тема, статус, дедлайн; розгортання показує повний вміст і кнопки асистента. */
const taskTile = (t) =>
  h(
    'article',
    {
      class: 'card hover tile' + (t.status === 'overdue' ? ' late' : ''),
      style: `--sj:${subjectColor(t.subjectKey)}`,
    },
    h('ul', { class: 'tasks' }, taskCard(t, { ...tctx, showSubject: true })),
  );

function tasksTab() {
  const f = ui.filter;
  const today = dayStart(nowSec());
  const range = f.range === '2w' ? { from: addDays(today, -14), to: addDays(today, 15) } : {};
  const groups = tasksView(st.snapshot, { ...f, ...range }, (g, t) =>
    g === 'subject'
      ? t.subject
      : t.deadline == null
        ? uk.filters.noDeadline
        : formatDay(dayStart(t.deadline)),
  );
  const set = (k) => (v) => go({ filter: { ...f, [k]: v } });
  const count = (s) =>
    tasksView(st.snapshot, { ...f, ...range, status: s }, () => '').reduce(
      (n, g) => n + g.tasks.length,
      0,
    );
  const bar = h(
    'div',
    { class: 'bar' },
    pills(
      'f-status',
      f.status,
      [
        ['pending', uk.filters.pending],
        ['assigned', uk.status.assigned],
        ['overdue', uk.status.overdue],
        ['submitted', uk.status.submitted],
        ['accepted', uk.status.accepted],
        ['returned', uk.status.returned],
        ['all', uk.filters.all],
      ].map(([v, label]) => [
        v,
        [label, h('span', { class: 'pill-n num', text: String(count(v)) })],
      ]),
      set('status'),
    ),
  );
  const bar2 = h(
    'div',
    { class: 'bar' },
    pills(
      'f-group',
      f.group,
      [
        ['date', uk.filters.byDate],
        ['subject', uk.filters.bySubject],
      ],
      set('group'),
    ),
    h(
      'label',
      {},
      uk.filters.subject,
      select(
        'f-subject',
        f.subject,
        [['', uk.filters.allSubjects], ...subjectsOf(st.snapshot).map((s) => [s.key, s.name])],
        set('subject'),
      ),
    ),
    h(
      'label',
      {},
      uk.filters.period,
      select(
        'f-range',
        f.range,
        [
          ['2w', uk.filters.range2w],
          ['all', uk.filters.rangeAll],
        ],
        set('range'),
      ),
    ),
  );
  if (!groups.length) return [bar, bar2, h('p', { class: 'empty', text: uk.states.empty })];
  return [
    bar,
    bar2,
    groups.map((g) => {
      const late =
        f.group === 'date' &&
        g.key !== 'none' &&
        Number(g.key) < today &&
        g.tasks.some((t) => t.pending);
      return [
        h(
          'h2',
          { class: 'group' + (late ? ' late' : '') },
          g.label,
          h('small', { text: countText(g.tasks.length) }),
        ),
        h('div', { class: 'tiles' }, g.tasks.map(taskTile)),
      ];
    }),
  ];
}

/* ---------- Сторінка уроку (відкривається з календаря) ---------- */
/** Блок завдання чи матеріалу з одразу розгорнутим вмістом (текст підвантажується й оновлюється на місці). */
function lessonItem(t0, kind) {
  const t = kind === 'lesson' ? { ...t0, kind: 'lesson' } : t0;
  tctx.texts.ensure(t);
  ui.expanded.add(t.id);
  const late = t.status === 'overdue';
  return h(
    'article',
    { class: 'card litem' + (late ? ' late' : ''), 'data-task': t.id },
    h(
      'header',
      { class: 'litem-head' },
      kind === 'lesson'
        ? h('span', { class: 'badge', 'data-s': 'unknown' }, icon('file', 12), t.typeName)
        : badge(t.status),
      h('h3', {
        class: 'litem-title',
        text: kind === 'lesson' ? t.title || t.typeName : t.typeName || uk.assigned,
      }),
      kind === 'lesson'
        ? null
        : h('span', { class: 'meta deadline' + (late ? ' late' : ''), text: deadlineText(t) }),
      t.grade != null ? h('span', { class: 'grade', text: String(t.grade) }) : null,
    ),
    h('div', { class: 'inner' }, taskBody(t, tctx)),
  );
}

function lessonPage() {
  const l = ui.lesson;
  const t = nowSec();
  const tasks = l.themeId == null ? [] : st.snapshot.tasks.filter((x) => x.themeId === l.themeId);
  const grades = st.snapshot.grades.filter(
    (g) =>
      g.subjectKey === l.subjectKey && dayStart(g.date) === dayStart(l.start) && g.value != null,
  );
  const now = !l.cancelled && l.start <= t && t < l.end;
  const back = () => go({ lesson: null });
  return [
    h(
      'div',
      { class: 'weeknav' },
      h(
        'button',
        { class: 'btn', 'data-k': 'lesson-back', onclick: back },
        icon('chevronLeft', 14),
        uk.tabs.calendar,
      ),
    ),
    h(
      'section',
      { class: 'card lhero', style: `--sj:${subjectColor(l.subjectKey)}` },
      h(
        'div',
        { class: 'lhero-top' },
        h('span', { class: 'lhero-subj' }, subjectDot(l.subjectKey), l.subject),
        now ? h('span', { class: 'badge ok', text: uk.lessonPage.now }) : null,
        lessonBadges(l),
        h('span', { class: 'grow' }),
        grades.map((g) =>
          h('span', { class: 'lhero-grade num', title: g.kind, text: String(g.value) }),
        ),
      ),
      h('h1', { class: 'lhero-theme', text: l.title || uk.lesson.noTheme }),
      h(
        'p',
        { class: 'meta num' },
        `${formatDay(dayStart(l.start))} · ${l.period ? l.period + ' ' + uk.lesson.lessonWord + ' · ' : ''}${lessonTime(l)}`,
      ),
      h(
        'div',
        { class: 'row lhero-actions' },
        l.zoomUrl && !l.cancelled
          ? h(
              'button',
              {
                class: 'btn primary',
                'data-k': 'lesson-zoom',
                onclick: () => api.openExternal(l.zoomUrl),
              },
              icon('video', 14),
              uk.lessonPage.join,
            )
          : null,
        tasks[0]
          ? h(
              'button',
              {
                class: 'btn',
                'data-k': 'lesson-ask',
                onclick: () => tctx.onAsk('explain', tasks[0]),
              },
              icon('sparkles', 14),
              uk.lessonPage.ask,
            )
          : null,
        h(
          'button',
          {
            class: 'btn',
            'data-k': 'lesson-book',
            onclick: () =>
              tasks[0]
                ? tctx.onBook(tasks[0], tctx.texts.get(tasks[0])?.blocks ?? [])
                : books
                    .openFor(l.subject, l.title)
                    .then((ok) =>
                      ok ? go({ tab: 'books', lesson: null }) : alert(uk.books.noTextbook),
                    ),
          },
          icon('book', 14),
          uk.books.openTextbook,
        ),
      ),
    ),
    h(
      'h2',
      { class: 'group' },
      uk.lessonPage.homework,
      tasks.length ? h('small', { text: countText(tasks.length) }) : null,
    ),
    tasks.length
      ? tasks.map((x) => lessonItem(x, 'task'))
      : h('p', {
          class: 'card pad meta',
          text: l.projected ? uk.lesson.projectedNote : uk.states.noHomework,
        }),
    l.lessonTasks.length
      ? [
          h(
            'h2',
            { class: 'group' },
            uk.lessonPage.materials,
            h('small', { text: plural(l.lessonTasks.length, uk.plural.material) }),
          ),
          l.lessonTasks.map((x) => lessonItem(x, 'lesson')),
        ]
      : null,
  ];
}

/* ---------- Календар: тиждень із 7 днів (структура як у щоденнику HUMAN, оформлення своє) ---------- */
const WEEKDAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'];
const dmy = (d) => {
  const p = kyivParts(d);
  return `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}`;
};

/** Урок відкривається окремою сторінкою (як у щоденнику), а не в бічній панелі. */
const openLesson = (l) => go({ lesson: l });

/** Список завдань із дедлайном дня або оцінок дня в бічній панелі (смужки над колонкою дня). */
function openDayTasks(d) {
  const due = st.snapshot.tasks.filter(
    (x) => x.deadline != null && x.deadline >= d && x.deadline < addDays(d, 1),
  );
  autoOpen([]);
  drawer(`${uk.calendar.tasks} · ${formatDay(d)}`, () =>
    due.length
      ? h(
          'ul',
          { class: 'tasks card' },
          due.map((x) => taskCard(x, { ...tctx, showSubject: true })),
        )
      : h('p', { class: 'meta', text: uk.states.noHomework }),
  );
}
function openDayGrades(d) {
  const list = st.snapshot.grades.filter((g) => dayStart(g.date) === d);
  drawer(`${uk.calendar.grades} · ${formatDay(d)}`, () =>
    list.length
      ? h(
          'table',
          { class: 'gtable' },
          h(
            'tbody',
            {},
            list.map((g) =>
              h(
                'tr',
                {},
                h('td', {}, subjectDot(g.subjectKey), g.subject),
                h('td', { class: 'meta', text: g.kind }),
                h('td', {}, h('span', { class: 'grade', text: g.value ?? '—' })),
              ),
            ),
          ),
        )
      : h('p', { class: 'meta', text: uk.states.noGrades }),
  );
}

function lessonCard(l, t, isToday, gradesOfDay) {
  const tasks = l.themeId == null ? [] : st.snapshot.tasks.filter((x) => x.themeId === l.themeId);
  const left = tasks.filter((x) => x.pending).length;
  const state = l.cancelled ? 'cancelled' : tasks.length ? (left ? 'pending' : 'done') : 'none';
  const now = isToday && !l.cancelled && l.start <= t && t < l.end;
  const grade = gradesOfDay.find((g) => g.subjectKey === l.subjectKey && g.value != null);
  return h(
    'div',
    {
      class: 'lcard' + (now ? ' now' : '') + (l.cancelled ? ' cancelled' : ''),
      'data-state': state,
    },
    h(
      'button',
      { class: 'lcard-main', 'data-k': `slot-${l.id}`, onclick: () => openLesson(l) },
      h('span', { class: 'lcard-subj', text: l.subject }),
      l.title ? h('span', { class: 'lcard-theme', text: l.title }) : null,
      h(
        'span',
        { class: 'lcard-time' },
        l.period
          ? h('span', { class: 'lcard-n', text: `${l.period} ${uk.lesson.lessonWord}` })
          : null,
        h('span', { class: 'num', text: lessonTime(l) }),
      ),
      lessonBadges(l).filter(Boolean).length ? h('span', { class: 'row' }, lessonBadges(l)) : null,
    ),
    h(
      'div',
      { class: 'lcard-foot' },
      l.lessonTasks.length || tasks.length
        ? h(
            'span',
            {
              class: 'lcard-ico',
              title: uk.calendar.hasMaterials(l.lessonTasks.length, tasks.length),
            },
            icon('paperclip', 16),
            tasks.length
              ? h('span', { class: 'num', text: `${tasks.length - left}/${tasks.length}` })
              : null,
          )
        : null,
      l.zoomUrl && !l.cancelled
        ? h(
            'button',
            {
              class: 'lcard-zoom on',
              'aria-label': `${uk.buttons.zoom}: ${l.subject}`,
              title: uk.buttons.zoom,
              onclick: () => api.openExternal(l.zoomUrl),
            },
            icon('video', 16),
          )
        : h('span', { class: 'lcard-zoom', 'aria-hidden': 'true' }, icon('video', 16)),
      grade
        ? h('span', {
            class: 'lcard-grade num',
            title: `${uk.grades.grade}: ${grade.kind}`,
            text: String(grade.value),
          })
        : null,
    ),
  );
}

function calendarTab() {
  const t = nowSec();
  const today = dayStart(t);
  const start = addDays(weekStart(t), ui.weekOffset * 7);
  const entry = ui.schedule.get(start);
  if (!entry || (entry.stamp !== st.updatedAt && !ui.fetching.has(start))) {
    ui.fetching.add(start);
    api.getSchedule(start).then((data) => {
      ui.fetching.delete(start);
      ui.schedule.set(start, { stamp: st?.updatedAt, data: data ?? { lessons: [], weekends: [] } });
      render();
    });
  }
  const nav = h(
    'div',
    { class: 'weeknav' },
    iconBtn('chevronLeft', uk.buttons.prevWeek, () => go({ weekOffset: ui.weekOffset - 1 }), {
      class: 'btn icon ghost',
      'data-k': 'wk-prev',
    }),
    h('strong', {
      class: 'num',
      text: `${formatShortDay(start).replace(/^[^,]*,\s*/, '')} – ${formatShortDay(addDays(start, 6)).replace(/^[^,]*,\s*/, '')}`,
    }),
    iconBtn('chevronRight', uk.buttons.nextWeek, () => go({ weekOffset: ui.weekOffset + 1 }), {
      class: 'btn icon ghost',
      'data-k': 'wk-next',
    }),
    ui.weekOffset
      ? btn(uk.buttons.thisWeek, () => go({ weekOffset: 0 }), {
          class: 'btn small',
          'data-k': 'wk-now',
        })
      : null,
  );
  if (!entry) return [nav, skeleton()];
  const { lessons, weekends = [] } = entry.data;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  return [
    nav,
    h(
      'div',
      { class: 'week7' },
      days.map((d, i) => {
        const list = lessons.filter((l) => l.start >= d && l.start < addDays(d, 1));
        const due = st.snapshot.tasks.filter(
          (x) => x.deadline != null && x.deadline >= d && x.deadline < addDays(d, 1),
        );
        const done = due.filter((x) => !x.pending).length;
        const gradesOfDay = st.snapshot.grades.filter((g) => dayStart(g.date) === d);
        const isWeekend = i >= 5;
        return h(
          'section',
          {
            class: 'daycol' + (d === today ? ' today' : '') + (isWeekend ? ' weekend' : ''),
            'aria-label': formatDay(d),
          },
          h(
            'header',
            { class: 'dayhead' },
            h('div', { class: 'dayname', text: WEEKDAYS[i] }),
            h('div', { class: 'daydate num', text: dmy(d) }),
          ),
          list.length || due.length
            ? [
                h(
                  'button',
                  {
                    class: 'daybar tasks-bar',
                    'data-k': `dt-${i}`,
                    onclick: () => openDayTasks(d),
                  },
                  icon('clipboard', 14),
                  h('span', { class: 'grow', text: uk.calendar.tasks }),
                  h('span', { class: 'num', text: `${done}/${due.length}` }),
                ),
                h(
                  'button',
                  {
                    class: 'daybar grades-bar',
                    'data-k': `dg-${i}`,
                    onclick: () => openDayGrades(d),
                  },
                  icon('award', 14),
                  h('span', { class: 'grow', text: uk.calendar.grades }),
                  h('span', {
                    class: 'num',
                    text: String(gradesOfDay.filter((g) => g.value != null).length),
                  }),
                ),
              ]
            : null,
          list.length
            ? list.map((l) => lessonCard(l, t, d === today, gradesOfDay))
            : isWeekend || weekends.includes(d)
              ? null
              : h('p', { class: 'meta daynone', text: uk.lesson.noLessons }),
        );
      }),
    ),
  ];
}

/* ---------- Оцінки: таблиця «предмет × дата» ---------- */
const dm = (d) => {
  const p = kyivParts(d);
  return `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}`;
};
function gradesTab() {
  const list = gradesBySubject(st.snapshot);
  if (!list.length) return h('p', { class: 'empty', text: uk.states.noGrades });
  const dates = [...new Set(st.snapshot.grades.map((g) => dayStart(g.date)))].sort((a, b) => a - b);
  return [
    h('p', { class: 'meta', text: uk.states.gradesNote }),
    h(
      'div',
      { class: 'card grades-wrap' },
      h(
        'table',
        { class: 'gtable journal' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { class: 'subj-col', scope: 'col', text: uk.grades.subject }),
            dates.map((d) =>
              h('th', {
                class: 'num',
                scope: 'col',
                title: formatDay(d),
                text: dm(d),
              }),
            ),
            h('th', { class: 'num', scope: 'col', text: uk.grades.count }),
          ),
        ),
        h(
          'tbody',
          {},
          list.map((g) =>
            h(
              'tr',
              {},
              h(
                'th',
                { class: 'subj-col', scope: 'row' },
                subjectDot(g.grades[0].subjectKey),
                g.subject,
              ),
              dates.map((d) => {
                const cell = g.grades.filter((x) => dayStart(x.date) === d);
                return h(
                  'td',
                  { class: 'num' },
                  cell.map((x) =>
                    h('span', {
                      class: 'grade',
                      title: `${x.kind} · ${formatDay(d)}`,
                      text: x.value ?? '—',
                    }),
                  ),
                );
              }),
              h('td', { class: 'num meta', text: String(g.grades.length) }),
            ),
          ),
        ),
      ),
    ),
  ];
}

/* ---------- Міні-режим: «Завтра задано» ---------- */
function miniView() {
  const items = nextView(st.snapshot, nowSec()).tomorrow;
  const tasks = items.flatMap((i) => i.tasks).slice(0, 4);
  const total = items.reduce((n, i) => n + i.tasks.length, 0);
  return [
    h('h1', { class: 'minititle' }, uk.widget.title),
    h('p', { class: 'meta' }, uk.widget.tomorrowCount(''), counter('mini-total', total)),
    tasks.length
      ? h(
          'div',
          { class: 'card' },
          h(
            'ul',
            { class: 'tasks' },
            tasks.map((t) => taskCard(t, { ...tctx, showSubject: true })),
          ),
        )
      : h('p', { class: 'empty', text: uk.widget.nothing }),
    total > tasks.length ? h('p', { class: 'meta', text: `+ ${total - tasks.length}` }) : null,
  ];
}

/* ---------- Бічна панель: налаштування й «Про застосунок» ---------- */
let drawerEl = null;

/** Панель справа зі склом у тому самому вікні. Кнопка «закрити» зліва вгорі, Esc і клік по затемненню теж закривають. */
function drawer(title, build) {
  closeDrawer(true);
  const panel = h('aside', {
    class: 'drawer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'drawer-title',
  });
  const fill = () => {
    const key = document.activeElement?.dataset?.k;
    panel.replaceChildren(
      h(
        'header',
        { class: 'drawer-head' },
        h(
          'button',
          {
            class: 'btn icon ghost',
            'data-k': 'drawer-close',
            'aria-label': uk.buttons.close,
            title: uk.buttons.close,
            onclick: () => closeDrawer(),
          },
          icon('x', 18),
        ),
        h('h2', { id: 'drawer-title', text: title }),
      ),
      h('div', { class: 'drawer-body' }, build()),
    );
    if (key) panel.querySelector(`[data-k="${CSS.escape(key)}"]`)?.focus();
  };
  drawerEl = h(
    'div',
    { class: 'drawer-root' },
    h('div', { class: 'scrim', onclick: () => closeDrawer() }),
    panel,
  );
  document.body.append(drawerEl);
  root.inert = true;
  fill();
  requestAnimationFrame(() => drawerEl?.classList.add('open'));
  panel.querySelector('[data-k="drawer-close"]').focus();
  dialogRefresh = fill;
}

function closeDrawer(immediate = false) {
  if (!drawerEl) return;
  const el = drawerEl;
  drawerEl = null;
  dialogRefresh = null;
  toast = '';
  root.inert = false;
  if (immediate) el.remove();
  else {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 220);
    document.querySelector('[data-k="settings"]')?.focus();
  }
}

const accentNow = () => settings.accent ?? (PRESETS[settings.preset] ?? PRESETS.classic).accent;

const group = (title, ...rows) =>
  h('section', { class: 'sgroup' }, h('h3', { text: title }), h('div', { class: 'sbox' }, rows));
const row = (label, control, hint, stacked = false) =>
  h(
    'div',
    { class: 'srow' + (stacked ? ' col' : '') },
    h(
      'div',
      { class: 'sl' },
      h('div', { class: 'sname', text: label }),
      hint ? h('div', { class: 'meta', text: hint }) : null,
    ),
    control,
  );
const toggle = (key, checked, label, onchange) =>
  h(
    'button',
    {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(!!checked),
      'aria-label': label,
      'data-k': key,
      onclick: () => onchange(!checked),
    },
    h('span', { class: 'knob' }),
  );

function openSettings() {
  const set = (patch) => api.setSettings(patch);
  const customAccent = !!settings.accent;
  const swatches = h(
    'div',
    { class: 'sw-grid', role: 'group', 'aria-label': uk.settings.colors },
    Object.entries(PRESETS).map(([id, p]) =>
      h(
        'button',
        {
          class: 'sw',
          style: `--sw:${p.accent}`,
          'aria-pressed': String(!customAccent && settings.preset === id),
          'aria-label': p.name,
          title: p.name,
          'data-k': `preset-${id}`,
          onclick: () => set({ preset: id, accent: null }),
        },
        icon('check', 16),
      ),
    ),
    h(
      'label',
      {
        class: 'sw sw-custom',
        'aria-pressed': String(customAccent),
        title: uk.settings.accentCustom,
        'data-pressed': String(customAccent),
      },
      h('span', { class: 'sr', text: uk.settings.accentCustom }),
      h('input', {
        type: 'color',
        value: accentNow(),
        'data-k': 'c-accent',
        onchange: (e) => set({ accent: e.target.value }),
      }),
      icon('plus', 16),
    ),
  );
  const chip = (key, label, value) =>
    row(
      label,
      h('input', {
        type: 'color',
        class: 'chip-color',
        value,
        'aria-label': label,
        'data-k': `c-${key}`,
        onchange: (e) => set({ [key]: e.target.value }),
      }),
    );
  drawer(uk.settings.title, () =>
    h(
      'div',
      {},
      group(
        uk.settings.glassTitle,
        row(
          uk.settings.theme,
          pills(
            'theme',
            settings.theme,
            [
              ['system', uk.settings.themeSystem],
              ['light', uk.settings.themeLight],
              ['dark', uk.settings.themeDark],
            ],
            (v) => set({ theme: v }),
          ),
        ),
        row(
          uk.settings.glass,
          pills(
            'glass',
            settings.glass,
            [
              ['auto', uk.settings.glassAuto],
              ['on', uk.settings.glassOn],
              ['off', uk.settings.glassOff],
            ],
            (v) => set({ glass: v }),
          ),
          uk.settings.glassNote,
          true,
        ),
      ),
      group(
        uk.settings.colors,
        h('div', { class: 'srow col' }, swatches),
        chip('success', uk.settings.successColor, settings.success ?? DEFAULT_COLORS.success),
        chip('danger', uk.settings.dangerColor, settings.danger ?? DEFAULT_COLORS.danger),
        h(
          'div',
          { class: 'srow' },
          h('span'),
          btn(
            uk.settings.resetColors,
            () => set({ preset: 'classic', accent: null, success: null, danger: null }),
            { class: 'btn small', 'data-k': 'reset-colors' },
          ),
        ),
      ),
      group(
        uk.settings.miniTitle,
        row(
          uk.settings.mini,
          toggle('mini-cb', settings.mini, uk.settings.mini, (v) => set({ mini: v })),
          uk.settings.miniHint,
        ),
        row(
          uk.settings.miniOpacity,
          h('input', {
            type: 'range',
            min: '0.5',
            max: '1',
            step: '0.05',
            value: String(settings.miniOpacity ?? 1),
            'aria-label': uk.settings.miniOpacity,
            'data-k': 'mini-op',
            onchange: (e) => set({ miniOpacity: Number(e.target.value) }),
          }),
        ),
      ),
      assistantSettings(set),
      group(
        uk.files.cacheTitle,
        row(
          uk.files.cacheLimit,
          select(
            'files-limit',
            String(settings.filesCacheMb),
            [100, 500, 1000, 2000, 5000].map((n) => [
              String(n),
              n >= 1000 ? `${n / 1000} ГБ` : `${n} МБ`,
            ]),
            (v) => set({ filesCacheMb: Number(v) }),
          ),
        ),
        h(
          'div',
          { class: 'srow' },
          h('span'),
          btn(
            uk.files.clearCache,
            async () => {
              await api.files.clearCache();
              filesUI.reload();
              toast = uk.files.cleared;
              dialogRefresh?.();
            },
            { class: 'btn small', 'data-k': 'files-clear' },
          ),
        ),
      ),
      group(
        uk.settings.notifyTitle,
        row(
          uk.settings.notify,
          toggle('notify', settings.notify, uk.settings.notify, (v) => set({ notify: v })),
        ),
      ),
      group(
        uk.settings.data,
        h(
          'div',
          { class: 'srow col stack' },
          btn(uk.buttons.about, () => openAbout(), { 'data-k': 'about' }),
          btn(
            uk.buttons.report,
            async () => {
              await api.copyDiagnostics();
              toast = uk.report.copied;
              dialogRefresh?.();
            },
            { 'data-k': 'report' },
          ),
          toast ? h('p', { class: 'toast', role: 'status', text: toast }) : null,
          btn(
            uk.buttons.logoutWipe,
            async () => {
              await api.logout();
              closeDrawer();
            },
            { class: 'btn danger', 'data-k': 'wipe' },
          ),
        ),
      ),
    ),
  );
}

function assistantSettings(set) {
  const s = assistant.status();
  const a = uk.ai.settings;
  const modelKey = {
    claudecode: 'aiModelClaudeCode',
    anthropic: 'aiModelAnthropic',
    openai: 'aiModelOpenai',
    gemini: 'aiModelGemini',
  }[settings.aiProvider];
  const text = (key, label, value, hint) =>
    row(
      label,
      h('input', {
        type: 'text',
        class: 'text-in',
        value: value ?? '',
        spellcheck: 'false',
        'aria-label': label,
        'data-k': key,
        onchange: (e) => set({ [key]: e.target.value.trim() }),
      }),
      hint,
      true,
    );
  return group(
    a.title,
    row(
      a.provider,
      select(
        'aiProvider',
        settings.aiProvider,
        Object.entries(uk.ai.providers),
        async (v) => (await set({ aiProvider: v }), assistant.refreshStatus()),
      ),
    ),
    text(modelKey, a.model, settings[modelKey]),
    settings.aiProvider === 'openai'
      ? text('aiOpenaiBase', a.base, settings.aiOpenaiBase, a.baseHint)
      : null,
    h('div', { class: 'srow col' }, assistant.keyForm(settings.aiProvider)),
    row(
      a.consent,
      s?.consent
        ? btn(a.revoke, async () => (await api.ai.consent(false), assistant.refreshStatus()), {
            class: 'btn small',
            'data-k': 'ai-revoke',
          })
        : h('span', { class: 'meta', text: a.notGiven }),
    ),
  );
}

async function openAbout() {
  const info = await api.getAppInfo();
  drawer(uk.about.title, () =>
    h(
      'div',
      { class: 'about' },
      logo(56, 'logo'),
      h('p', { class: 'name', text: `${uk.appName} · ${uk.tagline}` }),
      h('p', { text: uk.about.text }),
      h('p', { text: uk.about.privacy }),
      h('p', {
        class: 'meta',
        text: `${uk.about.version}: ${info.version}${info.demo ? ' · ' + uk.states.demo : ''} · ${uk.debug.requests(info.requests)}`,
      }),
    ),
  );
}

/* ---------- Налаштування середовища, клавіші, запуск ---------- */
function applySettings(s) {
  settings = s;
  applyTheme(s);
  const el = document.documentElement;
  el.classList.toggle('glass', !!s._env?.glass);
  el.classList.toggle('opaque', !s._env?.glass);
  el.classList.toggle('material', !!s._env?.material);
  document.body.classList.toggle('mini', !!s.mini);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (drawerEl) return closeDrawer();
    if (st?.loggingIn) return api.cancelLogin();
  }
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    drawerEl ||
    /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)
  )
    return;
  const i = Number(e.key) - 1;
  if (st?.status === 'ready' && !settings.mini && TABS[i]) go({ tab: TABS[i] });
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(settings));
initSpotlight();

document.title = uk.appName;
[st, settings] = await Promise.all([api.getState(), api.getSettings()]);
applySettings(settings);
await Promise.all([assistant.init(), books.init()]);
api.onState((s) => {
  st = s;
  render();
});
api.onSettings((s) => {
  applySettings(s);
  dialogRefresh?.();
  render();
});
api.onAbout(openAbout);
setInterval(() => {
  if (
    !document.hidden &&
    st?.status === 'ready' &&
    ui.tab === 'today' &&
    ui.dayOffset === 0 &&
    !settings.mini
  )
    render(); // оновлює відлік і підсвітку поточного уроку
}, 60000);
render();
