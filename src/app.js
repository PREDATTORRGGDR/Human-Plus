// Єдине вікно: заголовок зі склом, вкладки Сьогодні / На наступний урок / Усі завдання / Розклад / Оцінки
// і компактний міні-режим «Що задано на завтра» (те саме вікно, без додаткових).
// Дані приходять готовими зі стану main-процесу; тут лише вибірка (model.js) і відмальовування.
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs';
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
  weekdayShort,
} from './time.js';
import {
  counter,
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
const TABS = ['today', 'next', 'tasks', 'schedule', 'grades'];

let st = null;
let settings = {};
let refreshing = false;
let dialogRefresh = null;
let toast = '';
const ui = {
  tab: 'today',
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
  const inner = document.querySelector(`[data-task="${t.id}"] .inner`);
  if (inner && ui.expanded.has(t.id)) inner.replaceChildren(taskBody(t, tctx));
});

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
  if (ready && !mini)
    top.append(
      h(
        'nav',
        { class: 'tabs', 'aria-label': uk.buttons.tabsAria },
        TABS.map((t, i) =>
          h(
            'button',
            {
              class: 'tab',
              'aria-current': ui.tab === t ? 'page' : null,
              'data-k': `tab-${t}`,
              onclick: () => go({ tab: t }),
            },
            uk.tabs[t],
            t === 'tasks'
              ? counter('pending', st.snapshot.tasks.filter((x) => x.pending).length)
              : null,
            h('kbd', { 'aria-hidden': 'true', text: String(i + 1) }),
          ),
        ),
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
  return h('div', { class: 'shell' }, top, h('main', { id: 'main', tabindex: '-1' }, page));
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
        next: nextTab,
        tasks: tasksTab,
        schedule: scheduleTab,
        grades: gradesTab,
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

function nextTab() {
  const v = nextView(st.snapshot, nowSec());
  if (!v.tomorrow.length && !v.rest.length)
    return h('p', { class: 'empty', text: uk.states.emptyNext });
  return [
    v.tomorrow.length
      ? [h('h2', { class: 'group' }, uk.tomorrowBlock), v.tomorrow.map(nextItem)]
      : null,
    v.rest.length ? [h('h2', { class: 'group' }, uk.nextRest), v.rest.map(nextItem)] : null,
  ];
}

/* ---------- Усі завдання ---------- */
const select = (key, value, options, onchange) =>
  h(
    'select',
    { 'data-k': key, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) =>
      h('option', { value: v, selected: v === value ? true : null }, label),
    ),
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
  const bar = h(
    'div',
    { class: 'bar' },
    pills(
      'f-status',
      f.status,
      [
        ['pending', uk.filters.pending],
        ['all', uk.filters.all],
        ['done', uk.filters.done],
      ],
      set('status'),
    ),
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
  if (!groups.length) return [bar, h('p', { class: 'empty', text: uk.states.empty })];
  return [
    bar,
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
        h(
          'div',
          { class: 'card' },
          h(
            'ul',
            { class: 'tasks' },
            g.tasks.map((t) => taskCard(t, { ...tctx, showSubject: true })),
          ),
        ),
      ];
    }),
  ];
}

/* ---------- Розклад ---------- */
function slot(l, t, isToday, next) {
  const now = isToday && !l.cancelled && l.start <= t && t < l.end;
  const between = isToday && t >= l.end && next && t < next.start;
  return h(
    'div',
    { class: 'slot' + (l.cancelled ? ' cancelled' : '') + (now ? ' now' : '') },
    h('div', { class: 'meta num', text: `${l.period ? l.period + ' · ' : ''}${lessonTime(l)}` }),
    h('div', { class: 'name' }, subjectDot(l.subjectKey), l.subject),
    h('div', { class: 'row' }, lessonBadges(l)),
    now
      ? h('span', {
          class: 'nowline',
          'aria-hidden': 'true',
          style: `top:${(((t - l.start) / (l.end - l.start)) * 100).toFixed(1)}%`,
        })
      : null,
    between
      ? h('span', { class: 'nowline', 'aria-hidden': 'true', style: 'top:calc(100% + 4px)' })
      : null,
  );
}

function scheduleTab() {
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
    { class: 'daynav' },
    iconBtn('chevronLeft', uk.buttons.prevWeek, () => go({ weekOffset: ui.weekOffset - 1 }), {
      'data-k': 'wk-prev',
    }),
    h('strong', { text: `${formatShortDay(start)} – ${formatShortDay(addDays(start, 6))}` }),
    iconBtn('chevronRight', uk.buttons.nextWeek, () => go({ weekOffset: ui.weekOffset + 1 }), {
      'data-k': 'wk-next',
    }),
    btn(uk.buttons.thisWeek, () => go({ weekOffset: 0 }), {
      disabled: ui.weekOffset === 0 || null,
      'data-k': 'wk-now',
    }),
  );
  if (!entry) return [nav, skeleton()];
  const { lessons, weekends = [] } = entry.data;
  const days = [0, 1, 2, 3, 4, 5, 6]
    .map((i) => addDays(start, i))
    .filter((d, i) => i < 5 || lessons.some((l) => l.start >= d && l.start < addDays(d, 1)));
  return [
    nav,
    h(
      'div',
      { class: 'week' },
      days.map((d) => {
        const list = lessons.filter((l) => l.start >= d && l.start < addDays(d, 1));
        return h(
          'section',
          { class: 'card col' + (d === today ? ' today' : ''), 'aria-label': formatDay(d) },
          h('h3', { text: `${weekdayShort(d)}, ${formatShortDay(d).replace(/^[^,]*,\s*/, '')}` }),
          list.length
            ? list.map((l, i) => slot(l, t, d === today, list[i + 1]))
            : h('div', {
                class: 'meta',
                text: weekends.includes(d) ? uk.lesson.weekend : uk.lesson.noLessons,
              }),
        );
      }),
    ),
  ];
}

/* ---------- Оцінки ---------- */
function gradesTab() {
  const list = gradesBySubject(st.snapshot);
  if (!list.length) return h('p', { class: 'empty', text: uk.states.noGrades });
  return [
    h('p', { class: 'meta', text: uk.states.gradesNote }),
    list.map((g) =>
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'cardhead' },
          h('h2', { class: 'name' }, subjectDot(g.grades[0].subjectKey), g.subject),
        ),
        h(
          'div',
          { class: 'grades' },
          g.grades.map((x) =>
            h(
              'span',
              { class: 'chip', title: x.kind },
              h('span', { class: 'grade', text: x.value ?? '—' }),
              ` · ${x.kind} · ${formatShortDay(x.date)}`,
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
