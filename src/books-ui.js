// Вкладка «Книги»: бібліотека підручників учня (лише на пристрої) і вбудований читач.
// У читачі учень виділяє потрібні фрагменти (або всю сторінку) і кнопкою «Показати асистенту» відправляє лише їх.
import { icon } from './icons.js';
import { openPdf, pageJpeg, renderPage } from './pdfview.js';
import { formatSize, h } from './ui.js';
import { uk } from './uk.js';

const t = uk.books;

/**
 * @param {{ api: any, rerender: () => void, subjects: () => {key:string,name:string}[], onSend: (p: {fragments: any[], text: string}) => void }} ctx
 */
export function createBooksUI(ctx) {
  const { api } = ctx;
  const state = {
    books: [],
    progress: null,
    msg: '',
    query: '',
    hits: null,
    open: null, // { book, index, text, printed }
    basket: [],
  };
  const docs = new Map(); // bookId → Promise<PDFDocumentProxy>
  const getDoc = (id) => {
    if (!docs.has(id)) {
      docs.set(
        id,
        api.books.bytes(id).then((bytes) => (bytes ? openPdf(bytes) : null)),
      );
      if (docs.size > 2) {
        const [old] = docs.keys();
        docs.get(old)?.then((d) => d?.destroy());
        docs.delete(old);
      }
    }
    return docs.get(id);
  };

  async function init() {
    state.books = await api.books.list();
    api.books.onProgress((p) => {
      state.progress = p;
      ctx.rerender();
    });
    // Сторінка-скан для асистента: main просить вікно намалювати її через pdfjs.
    api.books.onRender(async ({ reqId, bookId, index }) => {
      try {
        const doc = await getDoc(bookId);
        api.books.rendered(reqId, doc ? await pageJpeg(doc, index) : null);
      } catch {
        api.books.rendered(reqId, null);
      }
    });
  }

  const reload = async () => {
    state.books = await api.books.list();
    ctx.rerender();
  };

  async function importBooks(folder) {
    state.msg = '';
    const r = await api.books.import(folder);
    state.progress = null;
    if (!r.canceled) state.msg = t.imported(r.added, r.skipped, r.failed);
    await reload();
  }

  /* ---------- Читач ---------- */
  const canvas = h('canvas', { class: 'reader-canvas', 'aria-label': t.pageImage });
  const textPane = h('div', { class: 'reader-text', tabindex: '0', 'aria-label': t.pageText });
  let renderToken = 0;

  async function openBook(book, index = 0) {
    state.open = {
      book,
      index: Math.max(0, Math.min(index, book.pageCount - 1)),
      text: '',
      printed: null,
    };
    await showPage();
  }

  async function showPage() {
    const o = state.open;
    if (!o) return;
    const token = ++renderToken;
    const p = await api.books.page(o.book.id, o.index);
    if (token !== renderToken) return;
    o.text = p?.text ?? '';
    o.printed = p?.printed ?? null;
    textPane.replaceChildren(
      o.text.trim()
        ? h('pre', { class: 'reader-pre', text: o.text })
        : h('p', { class: 'meta', text: t.noText }),
    );
    ctx.rerender();
    if (o.book.format === 'pdf') {
      try {
        const doc = await getDoc(o.book.id);
        if (doc && token === renderToken) await renderPage(doc, o.index, canvas, { maxWidth: 760 });
      } catch {
        /* сторінка не намалювалась: лишається текст */
      }
    }
  }

  const go = (d) => {
    if (!state.open) return;
    state.open.index = Math.max(0, Math.min(state.open.index + d, state.open.book.pageCount - 1));
    showPage();
  };

  /** «34», «с. 34, № 2» → сторінка з урахуванням калібрування. */
  async function jump(value) {
    const o = state.open;
    const v = String(value ?? '').trim();
    if (!o || !v) return;
    const r = await api.books.locate(o.book.id, /^\d+$/.test(v) ? `с. ${v}` : v);
    if (r?.ok) {
      o.index = r.index;
      state.msg = r.approximate ? t.approx : '';
      showPage();
    } else {
      state.msg = t.notFound;
      ctx.rerender();
    }
  }

  function addFragment(text) {
    const o = state.open;
    const s = String(text ?? '').trim();
    if (!o || !s) {
      state.msg = t.selectFirst;
      ctx.rerender();
      return;
    }
    if (state.basket.length >= 10) state.basket.shift();
    state.basket.push({
      bookId: o.book.id,
      index: o.index,
      title: o.book.title,
      printed: o.printed,
      text: s.slice(0, 4000),
    });
    state.msg = '';
    ctx.rerender();
  }

  const selectionText = () => {
    const sel = window.getSelection();
    return sel && textPane.contains(sel.anchorNode) ? sel.toString() : '';
  };

  function basketView() {
    if (!state.basket.length) return h('p', { class: 'meta', text: t.basketEmpty });
    const q = h('input', {
      type: 'text',
      class: 'text-in',
      placeholder: t.question,
      'aria-label': t.question,
      'data-k': 'basket-q',
    });
    return h(
      'div',
      { class: 'basket' },
      h(
        'ul',
        { class: 'frags' },
        state.basket.map((f, i) =>
          h(
            'li',
            { class: 'frag' },
            h('span', {
              class: 'name',
              text: `${f.title}${f.printed != null ? ', с. ' + f.printed : ''}`,
            }),
            h('span', {
              class: 'meta',
              text: f.text.slice(0, 90) + (f.text.length > 90 ? '…' : ''),
            }),
            h(
              'button',
              {
                class: 'btn icon ghost',
                'aria-label': uk.buttons.remove,
                title: uk.buttons.remove,
                onclick: () => (state.basket.splice(i, 1), ctx.rerender()),
              },
              icon('x', 14),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        q,
        h(
          'button',
          {
            class: 'btn primary',
            'data-k': 'basket-send',
            onclick: () => {
              ctx.onSend({
                fragments: state.basket.map(({ bookId, index, text }) => ({ bookId, index, text })),
                text: q.value.trim() || t.defaultQuestion,
              });
              state.basket = [];
              ctx.rerender();
            },
          },
          icon('sparkles', 14),
          t.showAssistant,
        ),
      ),
    );
  }

  function reader() {
    const o = state.open;
    const b = o.book;
    const jumpIn = h('input', {
      type: 'text',
      class: 'text-in page-in',
      placeholder: t.jumpPlaceholder,
      'aria-label': t.jumpPlaceholder,
      'data-k': 'jump',
      onkeydown: (e) => e.key === 'Enter' && jump(e.target.value),
    });
    const calibIn = h('input', {
      type: 'number',
      min: '0',
      class: 'text-in num-in',
      'aria-label': t.calibLabel,
      placeholder: '№',
      'data-k': 'calib',
    });
    return h(
      'section',
      { class: 'reader' },
      h(
        'div',
        { class: 'reader-bar' },
        h(
          'button',
          {
            class: 'btn',
            'data-k': 'reader-back',
            onclick: () => ((state.open = null), ctx.rerender()),
          },
          icon('chevronLeft', 14),
          t.library,
        ),
        h('strong', { class: 'grow ellipsis', text: b.title }),
        h(
          'button',
          {
            class: 'btn icon',
            'aria-label': t.prev,
            title: t.prev,
            'data-k': 'pg-prev',
            onclick: () => go(-1),
            disabled: o.index === 0 || null,
          },
          icon('chevronLeft', 16),
        ),
        h('span', {
          class: 'meta num',
          text: `${o.printed != null ? 'с. ' + o.printed + ' · ' : ''}${b.format === 'pdf' ? 'PDF ' : ''}${o.index + 1} / ${b.pageCount}`,
        }),
        h(
          'button',
          {
            class: 'btn icon',
            'aria-label': t.next,
            title: t.next,
            'data-k': 'pg-next',
            onclick: () => go(1),
            disabled: o.index >= b.pageCount - 1 || null,
          },
          icon('chevronRight', 16),
        ),
        jumpIn,
      ),
      state.msg ? h('p', { class: 'meta', role: 'status', text: state.msg }) : null,
      h(
        'div',
        { class: 'reader-body' + (b.format === 'pdf' ? ' with-image' : '') },
        b.format === 'pdf' ? h('div', { class: 'reader-page card' }, canvas) : null,
        h(
          'div',
          { class: 'reader-side' },
          h('div', { class: 'sect' }, icon('file', 14), h('span', { text: t.pageText })),
          textPane,
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'btn small',
                'data-k': 'add-sel',
                onmousedown: (e) => e.preventDefault(),
                onclick: () => addFragment(selectionText()),
              },
              icon('plus', 12),
              t.addSelection,
            ),
            h(
              'button',
              { class: 'btn small', 'data-k': 'add-page', onclick: () => addFragment(o.text) },
              icon('file', 12),
              t.addPage,
            ),
          ),
          h('div', { class: 'sect' }, icon('sparkles', 14), h('span', { text: t.basket })),
          basketView(),
          b.format === 'pdf'
            ? h(
                'details',
                { class: 'calib' },
                h('summary', { text: t.calibTitle }),
                h('p', { class: 'meta', text: t.calibHint(o.index + 1) }),
                h(
                  'div',
                  { class: 'row' },
                  calibIn,
                  h(
                    'button',
                    {
                      class: 'btn small',
                      onclick: async () => {
                        const n = Number(calibIn.value);
                        if (Number.isInteger(n) && n >= 0) {
                          const nb = await api.books.calibrate(b.id, {
                            pdfPage: o.index + 1,
                            printed: n,
                          });
                          if (nb) state.open.book = nb;
                          state.msg = t.calibrated;
                          await reload();
                          showPage();
                        }
                      },
                    },
                    uk.buttons.save,
                  ),
                  h(
                    'button',
                    {
                      class: 'btn small ghost',
                      onclick: async () => {
                        const nb = await api.books.calibrate(b.id, null);
                        if (nb) state.open.book = nb;
                        await reload();
                        showPage();
                      },
                    },
                    t.calibAuto,
                  ),
                ),
              )
            : null,
        ),
      ),
    );
  }

  /* ---------- Бібліотека ---------- */
  const calibText = (b) =>
    b.format !== 'pdf' ? t.calib.text : (t.calib[b.calib.mode] ?? t.calib.none);

  function bookRow(b) {
    const subjects = ctx.subjects();
    const opts = [['', t.noSubject], ...subjects.map((s) => [s.name, s.name])];
    if (b.subject && !subjects.some((s) => s.name === b.subject)) opts.push([b.subject, b.subject]);
    return h(
      'li',
      { class: 'book card' },
      h('div', { class: 'book-ico', 'aria-hidden': 'true' }, icon('book', 22)),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'name', text: b.title }),
        h('div', {
          class: 'meta',
          text: `${b.format.toUpperCase()} · ${t.pages(b.pageCount)} · ${formatSize(b.size)} · ${calibText(b)}${b.scannedPages ? ' · ' + t.scans(b.scannedPages) : ''}`,
        }),
      ),
      h(
        'label',
        { class: 'meta subj-sel' },
        t.subject,
        h(
          'select',
          {
            'data-k': `bs-${b.id}`,
            onchange: async (e) => (
              await api.books.update(b.id, { subject: e.target.value }),
              reload()
            ),
          },
          opts.map(([v, l]) =>
            h('option', { value: v, selected: v === (b.subject ?? '') || null }, l),
          ),
        ),
      ),
      h(
        'button',
        { class: 'btn small primary', 'data-k': `bo-${b.id}`, onclick: () => openBook(b) },
        uk.buttons.open,
      ),
      h(
        'button',
        {
          class: 'btn icon ghost',
          'aria-label': `${uk.buttons.remove}: ${b.title}`,
          title: uk.buttons.remove,
          onclick: async () => {
            if (confirm(t.confirmRemove(b.title))) {
              await api.books.remove(b.id);
              docs.delete(b.id);
              reload();
            }
          },
        },
        icon('trash', 16),
      ),
    );
  }

  function library() {
    const search = h('input', {
      type: 'search',
      class: 'text-in',
      placeholder: t.searchPlaceholder,
      'aria-label': t.searchPlaceholder,
      value: state.query,
      'data-k': 'book-search',
      onkeydown: async (e) => {
        if (e.key !== 'Enter') return;
        state.query = e.target.value;
        state.hits = state.query.trim() ? await api.books.search(state.query) : null;
        ctx.rerender();
      },
    });
    return [
      h(
        'div',
        { class: 'bar' },
        h(
          'button',
          { class: 'btn primary', 'data-k': 'import-files', onclick: () => importBooks(false) },
          icon('upload', 14),
          t.addFiles,
        ),
        h(
          'button',
          { class: 'btn', 'data-k': 'import-folder', onclick: () => importBooks(true) },
          icon('folder', 14),
          t.addFolder,
        ),
        search,
      ),
      state.progress
        ? h('p', {
            class: 'meta',
            role: 'status',
            text: t.progress(state.progress.done + 1, state.progress.total, state.progress.name),
          })
        : null,
      state.msg ? h('p', { class: 'meta', role: 'status', text: state.msg }) : null,
      state.hits
        ? h(
            'section',
            { class: 'card pad' },
            h('h2', { text: t.found(state.hits.length) }),
            state.hits.map((x) =>
              h(
                'button',
                {
                  class: 'hit',
                  onclick: () => {
                    const b = state.books.find((y) => y.id === x.bookId);
                    if (b) openBook(b, x.index);
                  },
                },
                h('span', { class: 'name', text: `${x.title}, с. ${x.printed}` }),
                h('span', { class: 'meta', text: x.snippet }),
              ),
            ),
          )
        : null,
      state.books.length
        ? h('ul', { class: 'books' }, state.books.map(bookRow))
        : h(
            'div',
            { class: 'card pad center-text' },
            icon('book', 32),
            h('p', { text: t.empty }),
            h('p', { class: 'meta', text: t.emptyHint }),
          ),
      h('p', { class: 'meta', text: t.privacy }),
    ];
  }

  return {
    init,
    view: () => (state.open ? reader() : library()),
    /** Відкрити книгу предмета на сторінці з тексту домашки (кнопка «Підручник» у завданні). */
    async openFor(subject, text) {
      const list = await api.books.forSubject(subject);
      if (!list.length) return false;
      const b = list[0];
      const r = text ? await api.books.locate(b.id, text) : null;
      await openBook(b, r?.ok ? r.index : 0);
      state.msg = r?.ok && r.approximate ? t.approx : '';
      return true;
    },
    openAt: async (bookId, index) => {
      const b = (await api.books.list()).find((x) => x.id === bookId);
      if (b) await openBook(b, index ?? 0);
    },
    hasBooks: () => state.books.length > 0,
    bookFor: (subject) => state.books.some((b) => b.subject && b.subject === subject),
  };
}
