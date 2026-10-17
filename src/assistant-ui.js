// Вкладка й бічна панель «Асистент»: чат із потоковою відповіддю, картки з даними інструментів, екран згоди, ключ API.
// Ключ вводиться тут, але одразу йде в main (safeStorage); назад вікно отримує лише «є / немає» і маску.
import { icon } from './icons.js';
import { renderMarkdown } from './md.js';
import { formatShortDay } from './time.js';
import { h, subjectDot, taskCard } from './ui.js';
import { uk } from './uk.js';

const t = uk.ai;

/**
 * @param {{ api: any, tctx: any, getSnapshot: () => any, openPage?: (card: any) => void, openBooks?: () => void, rerender: () => void }} ctx
 */
export function createAssistantUI(ctx) {
  const { api } = ctx;
  const state = { status: null, entries: [], live: null, tool: '', keyMsg: '', keyProvider: null };
  const log = h('div', {
    class: 'chat-log',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': t.logAria,
  });
  const input = h('textarea', {
    class: 'chat-input',
    rows: '2',
    placeholder: t.placeholder,
    'aria-label': t.placeholder,
    'data-k': 'chat-input',
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    },
  });
  let liveText = null;
  let raf = 0;

  const busy = () => !!state.live;
  const scrollDown = () => requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));

  async function init() {
    [state.status, state.entries] = await Promise.all([api.ai.status(), api.ai.history()]);
    api.ai.onEvent(onEvent);
    fillLog();
  }

  function onEvent(ev) {
    if (ev.type === 'user') {
      state.entries.push(ev.entry);
      log.append(bubble(ev.entry));
    } else if (ev.type === 'start') {
      state.live = { id: ev.id, role: 'assistant', text: '', cards: [] };
      state.tool = '';
      const b = bubble(state.live, true);
      log.append(b);
      liveText = b.querySelector('.md');
      ctx.rerender();
    } else if (ev.type === 'text' && state.live?.id === ev.id) {
      state.live.text += ev.delta;
      state.tool = '';
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (liveText) liveText.replaceChildren(renderMarkdown(state.live?.text ?? ''));
          setStatusLine();
        });
    } else if (ev.type === 'tool' && state.live?.id === ev.id) {
      state.tool = t.toolNames[ev.name] ?? ev.name;
      setStatusLine();
    } else if (ev.type === 'card' && state.live?.id === ev.id) {
      state.live.cards.push(ev.card);
      log.querySelector('.bubble.live .cards')?.append(card(ev.card));
    } else if (ev.type === 'done' || ev.type === 'error') {
      state.entries.push(ev.entry);
      state.live = null;
      liveText = null;
      fillLog();
      api.ai.status().then((s) => ((state.status = s), ctx.rerender()));
      ctx.rerender();
    }
    scrollDown();
  }

  function setStatusLine() {
    const el = log.querySelector('.bubble.live .typing');
    if (el)
      el.textContent = state.tool ? t.usingTool(state.tool) : state.live?.text ? '' : t.thinking;
  }

  function fillLog() {
    log.replaceChildren(
      ...(state.entries.length ? state.entries.map((e) => bubble(e)) : [emptyHint()]),
      ...(state.live ? [bubble(state.live, true)] : []),
    );
    liveText = log.querySelector('.bubble.live .md');
    scrollDown();
  }

  function emptyHint() {
    return h(
      'div',
      { class: 'chat-empty' },
      icon('sparkles', 28),
      h('p', { text: t.emptyTitle }),
      h('p', { class: 'meta', text: t.emptyText }),
      h(
        'div',
        { class: 'row chips' },
        t.quick.map((q) => h('button', { class: 'pill', onclick: () => send({ text: q }) }, q)),
      ),
    );
  }

  function bubble(e, live = false) {
    if (e.role === 'user')
      return h(
        'div',
        { class: 'bubble user' },
        e.task
          ? h('div', {
              class: 'meta',
              text: `${t.modes[e.mode] ?? ''} · ${e.task.subject}${e.task.theme ? ': ' + e.task.theme : ''}`,
            })
          : null,
        e.text ? h('div', { class: 'md' }, renderMarkdown(e.text)) : null,
      );
    return h(
      'div',
      { class: 'bubble bot' + (live ? ' live' : '') + (e.error ? ' err' : '') },
      h('div', { class: 'cards' }, (e.cards ?? []).map(card)),
      h('div', { class: 'md' }, renderMarkdown(e.text ?? '')),
      live ? h('div', { class: 'typing meta', role: 'status', text: t.thinking }) : null,
      e.truncated ? h('p', { class: 'meta', text: t.truncated }) : null,
      e.stepLimit ? h('p', { class: 'meta', text: t.stepLimit }) : null,
      e.error
        ? h('p', { class: 'chat-error', role: 'alert', text: t.errors[e.error] ?? t.errors.error })
        : null,
      e.error === 'no_key' || e.error === 'auth'
        ? h('button', { class: 'btn small', onclick: () => keyFocus() }, t.enterKey)
        : null,
    );
  }

  /* ---------- Картки з результатів інструментів (дані беремо зі стану застосунку, не з тексту моделі) ---------- */
  function card(c) {
    const snap = ctx.getSnapshot();
    switch (c?.kind) {
      case 'homework': {
        const tasks = (c.ids ?? [])
          .map((id) => snap?.tasks.find((x) => x.id === id))
          .filter(Boolean);
        if (!tasks.length) return h('div', { class: 'ccard meta', text: t.cards.noTasks });
        return h(
          'div',
          { class: 'ccard' },
          h(
            'div',
            { class: 'ccard-h' },
            icon('check', 14),
            t.cards.homework,
            c.total > tasks.length
              ? h('span', { class: 'meta', text: ` · ${tasks.length} / ${c.total}` })
              : null,
          ),
          h(
            'ul',
            { class: 'tasks' },
            tasks.map((x) => taskCard(x, { ...ctx.tctx, showSubject: true })),
          ),
        );
      }
      case 'schedule':
        return h(
          'div',
          { class: 'ccard' },
          h('div', { class: 'ccard-h' }, icon('calendar', 14), t.cards.schedule),
          c.days.map((d) =>
            h(
              'div',
              { class: 'cday' },
              h('div', { class: 'name', text: formatShortDay(d.day) }),
              d.lessons.length
                ? h(
                    'ol',
                    { class: 'clessons' },
                    d.lessons.map((l) =>
                      h(
                        'li',
                        { class: l.cancelled ? 'cancelled' : '' },
                        h('span', { class: 'meta num', text: l.time }),
                        h('span', { class: 'name' }, subjectDot(l.subjectKey), l.subject),
                        l.cancelled
                          ? h('span', { class: 'badge bad', text: uk.lesson.cancelled })
                          : null,
                      ),
                    ),
                  )
                : h('div', { class: 'meta', text: uk.lesson.noLessons }),
            ),
          ),
        );
      case 'grades':
        return h(
          'div',
          { class: 'ccard' },
          h('div', { class: 'ccard-h' }, icon('award', 14), t.cards.grades),
          c.grades.length
            ? h(
                'table',
                { class: 'gtable compact' },
                h(
                  'tbody',
                  {},
                  c.grades
                    .slice(0, 12)
                    .map((g) =>
                      h(
                        'tr',
                        {},
                        h('td', { class: 'num', text: formatShortDay(g.date) }),
                        h('td', {}, subjectDot(g.subjectKey), g.subject),
                        h('td', { class: 'meta', text: g.kind }),
                        h('td', {}, h('span', { class: 'grade', text: g.value ?? '—' })),
                      ),
                    ),
                ),
              )
            : h('div', { class: 'meta', text: uk.states.noGrades }),
        );
      case 'books':
        return h(
          'div',
          { class: 'ccard' },
          h('div', { class: 'ccard-h' }, icon('book', 14), t.cards.books),
          c.books.map((b) =>
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'name', text: b.title }),
              h('span', { class: 'meta', text: b.subject || '' }),
            ),
          ),
        );
      case 'page':
        return h(
          'div',
          { class: 'ccard row' },
          icon('book', 16),
          h('span', {
            class: 'name grow',
            text: `${c.title}: ${t.cards.page(c.printed)}${c.approximate ? ' ' + t.cards.approx : ''}`,
          }),
          ctx.openPage
            ? h('button', { class: 'btn small', onclick: () => ctx.openPage(c) }, t.cards.open)
            : null,
        );
      case 'search':
        return h(
          'div',
          { class: 'ccard' },
          h('div', { class: 'ccard-h' }, icon('search', 14), t.cards.search),
          c.hits.map((x) =>
            h(
              'button',
              {
                class: 'hit',
                onclick: () =>
                  ctx.openPage?.({
                    bookId: x.bookId,
                    index: x.index,
                    printed: x.printed,
                    title: x.title,
                  }),
              },
              h('span', { class: 'name', text: `${x.title}, ${t.cards.page(x.printed)}` }),
              h('span', { class: 'meta', text: x.snippet }),
            ),
          ),
        );
      default:
        return h('span');
    }
  }

  /* ---------- Згода, ключ ---------- */
  function consentView() {
    return h(
      'section',
      { class: 'card pad consent', 'aria-labelledby': 'consent-h' },
      h('h2', { id: 'consent-h' }, icon('shield', 18), t.consent.title),
      h('p', { text: t.consent.intro }),
      h(
        'ul',
        {},
        t.consent.sends.map((s) => h('li', { text: s })),
      ),
      h('p', { class: 'meta', text: t.consent.never }),
      h('p', { class: 'meta', text: t.consent.provider }),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            'data-k': 'consent-yes',
            onclick: async () => ((state.status = await api.ai.consent(true)), ctx.rerender()),
          },
          t.consent.agree,
        ),
      ),
    );
  }

  function keyFocus() {
    state.keyProvider = state.status?.provider;
    ctx.rerender();
    requestAnimationFrame(() => document.querySelector('[data-k="ai-key"]')?.focus());
  }

  /** Поле ключа (вкладка і налаштування). Значення не зберігається у вікні: після відправки поле очищується. */
  function keyForm(provider = state.status?.provider ?? 'anthropic') {
    const st = state.status?.keys?.[provider];
    const field = h('input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'data-k': 'ai-key',
      'aria-label': t.key.label(t.providers[provider]),
      placeholder: st?.has ? st.masked : t.key.placeholder,
    });
    const msg = h('span', { class: 'meta', role: 'status', text: state.keyMsg });
    const save = async () => {
      const r = await api.ai.setKey(provider, field.value.trim());
      field.value = '';
      state.keyMsg = r.ok ? t.key.saved : (t.errors[r.code] ?? t.key.bad);
      if (r.ok) state.status = r.status;
      ctx.rerender();
    };
    return h(
      'div',
      { class: 'keyform' },
      h('label', { class: 'sname', text: t.key.label(t.providers[provider]) }),
      h(
        'div',
        { class: 'row' },
        field,
        h(
          'button',
          { class: 'btn primary small', 'data-k': 'ai-key-save', onclick: save },
          uk.buttons.save,
        ),
      ),
      st?.has
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'meta', text: t.key.has(st.masked) }),
            h(
              'button',
              {
                class: 'btn small',
                onclick: async () => (
                  (state.status = await api.ai.clearKey(provider)),
                  (state.keyMsg = ''),
                  ctx.rerender()
                ),
              },
              t.key.remove,
            ),
          )
        : h('p', { class: 'meta', text: t.key.where[provider] }),
      state.status?.keys && !state.status.keys.encryption
        ? h('p', { class: 'chat-error', text: t.errors.storage })
        : null,
      msg,
    );
  }

  /* ---------- Відправка ---------- */
  async function send({ text = '', mode = 'chat', taskId = null }) {
    if (busy()) return;
    await api.ai.send({ text, mode, taskId });
  }
  function submit() {
    const text = input.value.trim();
    if (!text || busy()) return;
    input.value = '';
    send({ text });
  }

  function composer() {
    return h(
      'div',
      { class: 'composer' },
      input,
      busy()
        ? h(
            'button',
            {
              class: 'btn',
              'data-k': 'chat-stop',
              onclick: () => api.ai.abort(),
              'aria-label': t.stop,
              title: t.stop,
            },
            icon('square', 16),
          )
        : h(
            'button',
            {
              class: 'btn primary',
              'data-k': 'chat-send',
              onclick: submit,
              'aria-label': t.send,
              title: t.send,
            },
            icon('send', 16),
          ),
    );
  }

  /** Повний вигляд (вкладка) або компактний (бічна панель поруч із контентом). */
  function view({ compact = false, onClose = null } = {}) {
    const s = state.status;
    const head = h(
      'div',
      { class: 'chat-head' },
      h('h2', {}, icon('sparkles', 18), t.title),
      h('span', {
        class: 'meta',
        text: s
          ? s.demo && !s.keys?.[s.provider]?.has
            ? t.demoModel
            : t.providers[s.provider]
          : '',
      }),
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'btn small',
          'data-k': 'chat-new',
          disabled: busy() || null,
          onclick: async () => (
            await api.ai.reset(),
            (state.entries = []),
            fillLog(),
            ctx.rerender()
          ),
        },
        icon('plus', 12),
        t.newChat,
      ),
      onClose
        ? h(
            'button',
            {
              class: 'btn icon ghost',
              'aria-label': uk.buttons.close,
              title: uk.buttons.close,
              onclick: onClose,
            },
            icon('x', 16),
          )
        : null,
    );
    let body;
    if (!s) body = h('p', { class: 'meta', text: uk.states.loading });
    else if (!s.consent) body = consentView();
    else if (!s.ready || state.keyProvider)
      body = h(
        'div',
        { class: 'card pad' },
        keyForm(),
        s.ready
          ? h(
              'button',
              { class: 'btn small', onclick: () => ((state.keyProvider = null), ctx.rerender()) },
              uk.buttons.close,
            )
          : null,
      );
    else body = log;
    return h(
      'section',
      { class: 'chat' + (compact ? ' compact' : ''), 'aria-label': t.title },
      head,
      body,
      s?.consent && s.ready ? composer() : null,
    );
  }

  return {
    init,
    view,
    keyForm,
    ask: (p) => send(p),
    status: () => state.status,
    refreshStatus: async () => ((state.status = await api.ai.status()), ctx.rerender()),
  };
}
