// Переглядач файлів поверх вікна. Кожен тип має свій безпечний спосіб показу; невідоме й виконуване не рендериться.
import { highlight } from './highlight.js';
import { icon } from './icons.js';
import { openPdf, renderPage } from './pdfview.js';
import { formatSize, h } from './ui.js';
import { uk } from './uk.js';

const t = uk.files;
let rootEl = null;
let onClose = null;

export function closeViewer() {
  if (!rootEl) return;
  rootEl.querySelectorAll('video,audio').forEach((m) => m.pause());
  rootEl.remove();
  rootEl = null;
  document.getElementById('app').inert = false;
  onClose?.();
}

/**
 * @param {{ id: string, name: string, size: number, kind: string, ext: string }} file
 * @param {{ api: any, sanitize: Function, onAsk?: (text: string) => void }} ctx
 */
export async function openViewer(file, ctx) {
  closeViewer();
  const { api } = ctx;
  const body = h(
    'div',
    { class: 'viewer-body', tabindex: '-1' },
    h('p', { class: 'meta', text: uk.states.loading }),
  );
  const status = h('span', { class: 'meta', role: 'status' });
  const actions = h('div', { class: 'row' });
  rootEl = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': file.name },
    h(
      'header',
      { class: 'viewer-head' },
      h(
        'button',
        {
          class: 'btn icon ghost',
          'data-k': 'viewer-close',
          'aria-label': uk.buttons.close,
          title: uk.buttons.close,
          onclick: closeViewer,
        },
        icon('x', 18),
      ),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'name ellipsis', text: file.name }),
        h('div', {
          class: 'meta',
          text: `${t.kinds[file.kind] ?? t.kinds.other} · ${formatSize(file.size)}`,
        }),
      ),
      status,
      actions,
      h(
        'button',
        {
          class: 'btn small',
          'data-k': 'viewer-save',
          onclick: async () => {
            const r = await api.files.save(file.id);
            if (r?.ok) status.textContent = uk.blocks.saved(r.name);
          },
        },
        icon('download', 12),
        t.saveAs,
      ),
    ),
    body,
  );
  document.body.append(rootEl);
  document.getElementById('app').inert = true;
  rootEl.querySelector('[data-k="viewer-close"]').focus();
  const src = `hp-file://f/${file.id}`;

  switch (file.kind) {
    case 'image': {
      let zoom = 1;
      const img = h('img', { class: 'viewer-img', src, alt: file.name, draggable: 'false' });
      const apply = () => (img.style.transform = `scale(${zoom})`);
      const z = (d) => ((zoom = Math.min(8, Math.max(0.1, d === 0 ? 1 : zoom * d))), apply());
      actions.append(
        h(
          'button',
          {
            class: 'btn icon',
            'aria-label': t.zoomOut,
            title: t.zoomOut,
            onclick: () => z(1 / 1.25),
          },
          icon('zoomOut', 16),
        ),
        h('button', { class: 'btn small', onclick: () => z(0) }, '100%'),
        h(
          'button',
          { class: 'btn icon', 'aria-label': t.zoomIn, title: t.zoomIn, onclick: () => z(1.25) },
          icon('zoomIn', 16),
        ),
      );
      body.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        z(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      });
      img.addEventListener('error', () =>
        body.replaceChildren(h('p', { class: 'meta', text: t.cannotShow })),
      );
      body.replaceChildren(h('div', { class: 'viewer-img-wrap' }, img));
      break;
    }
    case 'video':
    case 'audio': {
      const media = h(file.kind, {
        class: 'viewer-' + file.kind,
        controls: true,
        preload: 'metadata',
        src,
      });
      const fallback = () =>
        body.replaceChildren(
          h(
            'div',
            { class: 'card pad center-text' },
            icon('alert', 28),
            h('p', { text: t.codec }),
            h(
              'button',
              {
                class: 'btn primary',
                'data-k': 'open-external',
                onclick: () => api.files.openExternal(file.id),
              },
              icon('external', 14),
              uk.buttons.openExternal,
            ),
          ),
        );
      media.addEventListener('error', fallback);
      body.replaceChildren(media);
      break;
    }
    default:
      await fillContent(file, body, ctx, status);
  }
}

const table = (rows) =>
  h(
    'div',
    { class: 'viewer-table-wrap' },
    h(
      'table',
      { class: 'gtable sheet' },
      h(
        'tbody',
        {},
        rows.map((r, i) =>
          h(
            'tr',
            {},
            h('th', { class: 'num', text: String(i + 1) }),
            r.map((c) => h('td', { text: String(c ?? '') })),
          ),
        ),
      ),
    ),
  );

async function fillContent(file, body, ctx, status) {
  if (file.kind === 'other') {
    body.replaceChildren(
      h(
        'div',
        { class: 'card pad warn-box' },
        icon('shield', 28),
        h('h2', { text: t.otherTitle }),
        h('p', { text: t.otherText }),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn',
              'data-k': 'other-save',
              onclick: async () => {
                const r = await ctx.api.files.save(file.id);
                if (r?.ok) status.textContent = uk.blocks.saved(r.name);
              },
            },
            icon('download', 14),
            t.saveAs,
          ),
          h(
            'button',
            {
              class: 'btn',
              'data-k': 'other-folder',
              onclick: async () => {
                const r = await ctx.api.files.showInFolder(file.id);
                if (r?.ok) status.textContent = uk.blocks.saved(r.name);
              },
            },
            icon('folder', 14),
            uk.buttons.showInFolder,
          ),
        ),
      ),
    );
    return;
  }
  const c = await ctx.api.files.content(file.id);
  if (!c || c.error) {
    body.replaceChildren(
      h('p', { class: 'meta', text: c?.error === 'big' ? t.tooBig : t.cannotShow }),
    );
    return;
  }
  switch (file.kind) {
    case 'text':
    case 'code': {
      const lang =
        {
          py: 'hash',
          rb: 'hash',
          yaml: 'hash',
          yml: 'hash',
          r: 'hash',
          ini: 'semi',
          sql: 'dash',
          lua: 'dash',
          json: 'json',
          tex: 'percent',
          pas: 'pascal',
        }[file.ext] ?? (file.kind === 'code' ? 'c' : 'plain');
      body.replaceChildren(
        ...[
          c.truncated ? h('p', { class: 'meta', text: t.truncated }) : null,
          h('pre', { class: 'viewer-code' }, h('code', {}, highlight(c.text, lang))),
        ].filter(Boolean),
      );
      break;
    }
    case 'docx': {
      const div = h('div', { class: 'rich viewer-doc' });
      div.innerHTML = ctx.sanitize(c.html, { doc: true }); // безпечно: DOMPurify, білий список, зображення лише data:
      div.addEventListener('click', (e) => {
        const a = e.target.closest?.('a[href]');
        if (a) {
          e.preventDefault();
          ctx.api.openExternal(a.getAttribute('href'));
        }
      });
      body.replaceChildren(div);
      break;
    }
    case 'sheet':
      body.replaceChildren(
        ...c.sheets.flatMap((s) => [
          h('h3', { text: s.name }),
          s.rows.length ? table(s.rows) : h('p', { class: 'meta', text: t.emptySheet }),
        ]),
      );
      break;
    case 'csv':
      body.replaceChildren(table(c.rows));
      break;
    case 'pptx':
      body.replaceChildren(
        ...c.slides.map((s) =>
          h(
            'section',
            { class: 'card pad slide' },
            h('div', { class: 'meta', text: t.slide(s.index) }),
            s.lines.map((l, i) => h(i === 0 ? 'h3' : 'p', { text: l })),
          ),
        ),
      );
      break;
    case 'zip':
      body.replaceChildren(
        h('p', { class: 'meta', text: t.zipNote }),
        h(
          'table',
          { class: 'gtable' },
          h('thead', {}, h('tr', {}, h('th', { text: t.name }), h('th', { text: t.size }))),
          h(
            'tbody',
            {},
            c.entries.map((e) =>
              h(
                'tr',
                {},
                h('td', {}, icon(e.dir ? 'folder' : 'file', 12), ' ', e.name),
                h('td', { class: 'num', text: e.dir || e.size == null ? '' : formatSize(e.size) }),
              ),
            ),
          ),
        ),
      );
      break;
    case 'pdf': {
      const doc = await openPdf(c.bytes);
      let index = 0;
      const canvas = h('canvas', { class: 'reader-canvas' });
      const label = h('span', { class: 'meta num' });
      const show = async () => {
        label.textContent = `${index + 1} / ${doc.numPages}`;
        await renderPage(doc, index, canvas, { maxWidth: 900 });
      };
      body.replaceChildren(
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn icon',
              'aria-label': uk.books.prev,
              onclick: () => index > 0 && (index--, show()),
            },
            icon('chevronLeft', 16),
          ),
          label,
          h(
            'button',
            {
              class: 'btn icon',
              'aria-label': uk.books.next,
              onclick: () => index < doc.numPages - 1 && (index++, show()),
            },
            icon('chevronRight', 16),
          ),
        ),
        h('div', { class: 'reader-page card' }, canvas),
      );
      onClose = () => {
        doc.destroy();
        onClose = null;
      };
      await show();
      break;
    }
    default:
      body.replaceChildren(h('p', { class: 'meta', text: t.cannotShow }));
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && rootEl) {
      e.stopPropagation();
      closeViewer();
    }
  },
  true,
);
