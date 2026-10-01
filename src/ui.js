// Спільні UI-примітиви. Дані з API потрапляють у DOM лише через textContent
// або через санітизований HTML (текст ДЗ).
import { STATUS_ICON, icon } from './icons.js';
import { formatDateTime, formatDay, formatTime, plural } from './time.js';
import { uk } from './uk.js';

/**
 * Створює елемент. props: class, text, style (рядок: через CSSOM, бо CSP забороняє inline-атрибут style),
 * on<Event>, решта — атрибути. Діти: вузли, рядки, масиви довільної вкладеності.
 */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const badge = (status) =>
  h('span', { class: 'badge', 'data-s': status }, icon(STATUS_ICON[status], 12), uk.status[status]);

export const lessonTime = (l) => `${formatTime(l.start)}–${formatTime(l.end)}`;

/** Підпис дедлайну: «Здати до 3 жовт., 08:30». */
export const deadlineText = (t) =>
  t.deadline == null ? '' : `${uk.lesson.deadline} ${formatDateTime(t.deadline)}`;

export const countText = (n) => plural(n, uk.plural.task);

/** Підпис дня: «Сьогодні», «Завтра» або «четвер, 1 жовтня». */
export function dayLabel(day, today) {
  const diff = Math.round((day - today) / 86400);
  const full = formatDay(day);
  if (diff === 0) return { main: uk.days.today, sub: full };
  if (diff === 1) return { main: uk.days.tomorrow, sub: full };
  return { main: full, sub: '' };
}

/** Колір-позначка предмета: стабільний відтінок за ключем (лише декор, тексту на ньому немає). */
/** Колір предмета (стабільний відтінок за ключем). */
export function subjectColor(key) {
  let n = 0;
  for (const ch of String(key)) n = Math.imul(n ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return `hsl(${(n >>> 7) % 360} 62% 62%)`;
}

export function subjectDot(key) {
  let n = 0;
  for (const ch of String(key)) n = Math.imul(n ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return h('span', {
    class: 'subj',
    style: `--sj: hsl(${(n >>> 7) % 360} 55% 62%)`,
    'aria-hidden': 'true',
  });
}

const prevCounts = new Map();
/** Лічильник з м'яким «перекатом» цифр, коли значення змінилося (лише transform/opacity). */
export function counter(key, n) {
  const old = prevCounts.get(key);
  prevCounts.set(key, n);
  const el = h('span', { class: 'count' }, h('span', { class: 'count-new', text: String(n) }));
  if (old !== undefined && old !== n) {
    el.classList.add('roll');
    el.prepend(h('span', { class: 'count-old', 'aria-hidden': 'true', text: String(old) }));
  }
  return el;
}

/** Каскадна поява дітей контейнера (до 8 перших). */
export function stagger(container) {
  [...container.children].slice(0, 8).forEach((c, i) => c.style.setProperty('--i', String(i)));
  container.classList.add('enter');
  return container;
}

/** «Вогник» під курсором на `.card.hover`: радіальний градієнт за позицією миші (CSS-змінні, rAF). */
export function initSpotlight(root = document) {
  let raf = 0;
  root.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card.hover');
    if (!card || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}

/**
 * Сховище вмісту ДЗ у вікні: запитує main лише для розгорнутих завдань; ключ — id + updatedAt.
 * Зберігає блоки як є (HTML санітизується під час відмальовування).
 * @param {{ getTaskText: Function }} api
 */
export function createTexts(api, onUpdate) {
  const cache = new Map();
  const pending = new Set();
  const key = (t) => `${t.id}:${t.updatedAt}`;
  return {
    get: (t) => cache.get(key(t)),
    ensure(t) {
      const k = key(t);
      if (cache.has(k) || pending.has(k)) return;
      pending.add(k);
      api.getTaskText(t.id).then((r) => {
        pending.delete(k);
        cache.set(k, r?.ok ? { blocks: r.blocks } : { error: r?.reason ?? 'error' });
        onUpdate(t);
      });
    },
  };
}

const sizeFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
/** «2,3 МБ» / «480 КБ». */
export const formatSize = (b) =>
  b >= 1048576
    ? `${sizeFmt.format(b / 1048576)} ${uk.units.mb}`
    : `${sizeFmt.format(Math.max(1, Math.round(b / 1024)))} ${uk.units.kb}`;

/** Санітизований HTML у контейнері; посилання з нього відкриваються лише за кліком у браузері. */
function richHtml(html, ctx, opts) {
  const div = h('div', { class: 'rich' });
  div.innerHTML = ctx.sanitize(html, opts); // безпечно: білий список тегів, лише https-посилання
  div.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (a) {
      e.preventDefault();
      ctx.api.openExternal(a.getAttribute('href'));
    }
  });
  return div;
}

/** Один блок вмісту ДЗ. Зображення й файли просять у main за індексом (адрес вікно не бачить). */
function renderBlock(b, t, ctx) {
  switch (b.kind) {
    case 'heading':
      return h('h3', { class: 'blk-h', text: b.text });
    case 'html':
      return b.note
        ? h('div', { class: 'note' }, icon('info', 16), richHtml(b.html, ctx))
        : richHtml(b.html, ctx);
    case 'text':
      return h(
        'div',
        { class: 'rich' },
        b.title ? h('p', { class: 'name', text: b.title }) : null,
        h('p', { class: 'pre', text: b.text }),
      );
    case 'table':
      return richHtml(b.html, ctx, { tables: true });
    case 'formula':
      return h('pre', { class: 'formula', 'aria-label': uk.blocks.formula, text: b.text });
    case 'divider':
      return h('hr', { class: 'blk-hr' });
    case 'image': {
      const img = h('img', {
        class: 'blk-img',
        alt: b.caption || uk.blocks.image,
        loading: 'lazy',
      });
      const fig = h(
        'figure',
        { class: 'blk-fig' },
        h('div', { class: 'blk-img-wait skeleton', 'aria-hidden': 'true' }),
        b.caption ? h('figcaption', { class: 'meta', text: b.caption }) : null,
      );
      ctx.api.getImage(t.id, b.index).then((r) => {
        if (r?.ok) {
          img.src = r.dataUrl;
          fig.firstChild.replaceWith(img);
        } else fig.firstChild.replaceWith(h('p', { class: 'meta', text: uk.blocks.imageError }));
      });
      return fig;
    }
    case 'file': {
      const msg = h('span', { class: 'meta', role: 'status' });
      const save = h(
        'button',
        {
          class: 'btn small',
          'data-k': `file-${t.id}-${b.index}`,
          onclick: async () => {
            save.disabled = true;
            msg.textContent = uk.states.loading;
            const r = await ctx.api.saveFile(t.id, b.index);
            msg.textContent = r?.ok
              ? uk.blocks.saved(r.name)
              : (uk.blocks.fileErrors[r?.reason] ?? uk.blocks.fileErrors.error);
            save.disabled = false;
          },
        },
        icon('download', 12),
        uk.buttons.download,
      );
      return h(
        'div',
        { class: 'blk-card' },
        icon('file', 20),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name', text: b.name }),
          h('div', { class: 'meta num', text: b.size ? formatSize(b.size) : '' }),
        ),
        save,
        msg,
      );
    }
    case 'link': {
      const body = [
        h('div', { class: 'name', text: b.title || b.domain }),
        b.description ? h('div', { class: 'meta', text: b.description }) : null,
        h('div', {
          class: 'meta',
          text: b.openable ? `${b.domain} · ${uk.blocks.opensInBrowser}` : uk.blocks.linkBlocked,
        }),
      ];
      return b.openable
        ? h(
            'button',
            {
              class: 'blk-card blk-link',
              'data-k': `link-${t.id}-${b.index}`,
              onclick: () => ctx.api.openLink(t.id, b.index),
            },
            icon('external', 20),
            h('div', { class: 'grow' }, body),
          )
        : h('div', { class: 'blk-card' }, icon('alert', 20), h('div', { class: 'grow' }, body));
    }
    default:
      return h('p', { class: 'meta', text: uk.states.unsupportedBlock });
  }
}

/** Тіло розгорнутого завдання: увесь вміст прямо в застосунку. */
export function taskBody(t, ctx) {
  const r = ctx.texts.get(t);
  const body = h('div', { class: 'task-body' });
  if (!r) body.append(h('p', { class: 'meta', text: uk.states.loading }));
  else if (r.error)
    body.append(
      h('p', {
        class: 'meta',
        text: r.error === 'offline' ? uk.states.offline : uk.states.errorText,
      }),
    );
  else if (!r.blocks.length) body.append(h('p', { class: 'meta', text: uk.states.noContent }));
  else for (const b of r.blocks) body.append(renderBlock(b, t, ctx));
  return body;
}

/**
 * Картка завдання. Розгортання плавне (grid-template-rows 0fr→1fr) і без перемальовування сторінки.
 * @param {import('./normalize.js').Task} t
 * @param {{ expanded: Set<number>, texts: ReturnType<typeof createTexts>, api: any, sanitize: Function, showSubject?: boolean }} ctx
 */
export function taskCard(t, ctx) {
  const open = ctx.expanded.has(t.id);
  const late = t.status === 'overdue';
  const li = h('li', { class: 'task' + (late ? ' late' : ''), 'data-task': t.id });
  const inner = h('div', { class: 'inner' });
  const wrap = h('div', { class: 'collapse', 'data-open': String(open) }, inner);
  wrap.inert = !open;
  const fill = () => inner.replaceChildren(taskBody(t, ctx));
  if (open) {
    ctx.texts.ensure(t);
    fill();
  }
  const head = h(
    'button',
    {
      class: 'task-head',
      'aria-expanded': String(open),
      'data-k': `task-${t.id}`,
      onclick: () => {
        const now = !ctx.expanded.has(t.id);
        now ? ctx.expanded.add(t.id) : ctx.expanded.delete(t.id);
        if (now) {
          ctx.texts.ensure(t);
          fill();
        }
        head.setAttribute('aria-expanded', String(now));
        wrap.inert = !now;
        wrap.dataset.open = String(now);
      },
    },
    t.kind === 'lesson'
      ? h('span', { class: 'badge', 'data-s': 'unknown' }, icon('file', 12), t.typeName)
      : badge(t.status),
    h(
      'span',
      { class: 'name' },
      t.kind === 'lesson'
        ? t.title || t.typeName
        : ctx.showSubject
          ? [subjectDot(t.subjectKey), t.subject]
          : t.typeName,
    ),
    ctx.showSubject && t.themeTitle ? h('span', { class: 'meta', text: t.themeTitle }) : null,
    t.kind === 'lesson' ? null : h('span', { class: 'meta deadline', text: deadlineText(t) }),
    t.grade != null
      ? h('span', { class: 'grade', 'aria-label': `Оцінка ${t.grade}`, text: String(t.grade) })
      : null,
    h('span', { class: 'grow' }),
    h('span', { class: 'chev' }, icon('chevronDown', 16)),
  );
  li.append(head, wrap);
  return li;
}

/** Після перемальовування повертає фокус і прокрутку. */
export function keepFocus(render) {
  const key = document.activeElement?.dataset?.k;
  const main = document.querySelector('main');
  const top = main?.scrollTop ?? 0;
  render();
  if (key) document.querySelector(`[data-k="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  const m2 = document.querySelector('main');
  if (m2) m2.scrollTop = top;
}

export { formatDay };
