// Вкладка «Файли»: файли з уже відкритих завдань HUMAN і власні файли учня. Відкриваються у вбудованому переглядачі.
import { icon } from './icons.js';
import { formatSize, h } from './ui.js';
import { uk } from './uk.js';
import { openViewer } from './viewer.js';

const t = uk.files;
const KIND_ICON = {
  image: 'image',
  video: 'video',
  audio: 'music',
  pdf: 'file',
  docx: 'file',
  sheet: 'table',
  csv: 'table',
  pptx: 'file',
  text: 'file',
  code: 'code',
  zip: 'archive',
  other: 'alert',
};

/** @param {{ api: any, sanitize: Function, rerender: () => void }} ctx */
export function createFilesUI(ctx) {
  const { api } = ctx;
  const state = { data: null, msg: '', busy: null };

  const load = async () => {
    state.data = await api.files.list();
    ctx.rerender();
  };

  /** Файл із завдання: кешується в userData і відкривається в переглядачі. */
  async function openFromTask(taskId, index) {
    state.busy = `${taskId}:${index}`;
    state.msg = '';
    ctx.rerender();
    const r = await api.files.fromTask(taskId, index);
    state.busy = null;
    if (r?.ok) {
      await load();
      openViewer(r.file, ctx);
    } else {
      state.msg = uk.blocks.fileErrors[r?.reason] ?? uk.blocks.fileErrors.error;
      ctx.rerender();
    }
  }

  const kindIcon = (kind) =>
    h(
      'span',
      { class: 'file-ico', 'data-kind': kind, 'aria-hidden': 'true' },
      icon(KIND_ICON[kind] ?? 'file', 18),
    );

  function fileRow(f, { removable }) {
    return h(
      'li',
      { class: 'file-row' },
      kindIcon(f.kind),
      h(
        'button',
        { class: 'file-open', 'data-k': `f-${f.id}`, onclick: () => openViewer(f, ctx) },
        h('span', { class: 'name', text: f.name }),
        h('span', {
          class: 'meta',
          text: `${t.kinds[f.kind] ?? t.kinds.other} · ${formatSize(f.size)}`,
        }),
      ),
      removable
        ? h(
            'button',
            {
              class: 'btn icon ghost',
              'aria-label': `${uk.buttons.remove}: ${f.name}`,
              title: uk.buttons.remove,
              onclick: async () => {
                if (confirm(t.confirmRemove(f.name))) {
                  await api.files.remove(f.id);
                  load();
                }
              },
            },
            icon('trash', 16),
          )
        : null,
    );
  }

  function view() {
    if (!state.data) {
      load();
      return h('p', { class: 'meta', text: uk.states.loading });
    }
    const { mine, attachments, usage } = state.data;
    return [
      h(
        'div',
        { class: 'bar' },
        h(
          'button',
          {
            class: 'btn primary',
            'data-k': 'files-import',
            onclick: async () => {
              const added = await api.files.import();
              if (added.length) {
                await load();
              }
            },
          },
          icon('upload', 14),
          t.add,
        ),
        h('span', {
          class: 'meta',
          text: t.usage(
            formatSize(usage.mine || 0),
            formatSize(usage.cache || 0),
            formatSize(usage.limit),
          ),
        }),
      ),
      state.msg ? h('p', { class: 'meta', role: 'status', text: state.msg }) : null,
      h('h2', { class: 'group', text: t.fromHuman }),
      attachments.length
        ? h(
            'ul',
            { class: 'files card' },
            attachments.map((a) =>
              h(
                'li',
                { class: 'file-row' },
                kindIcon(a.kind),
                h(
                  'button',
                  {
                    class: 'file-open',
                    'data-k': `att-${a.taskId}-${a.index}`,
                    disabled: state.busy === `${a.taskId}:${a.index}` || null,
                    onclick: () => openFromTask(a.taskId, a.index),
                  },
                  h('span', { class: 'name', text: a.name }),
                  h('span', {
                    class: 'meta',
                    text: `${a.subject}${a.theme ? ' · ' + a.theme : ''}${a.size ? ' · ' + formatSize(a.size) : ''}`,
                  }),
                ),
                state.busy === `${a.taskId}:${a.index}`
                  ? h('span', { class: 'meta', text: uk.states.loading })
                  : null,
              ),
            ),
          )
        : h('p', { class: 'card pad meta', text: t.noAttachments }),
      h('h2', { class: 'group', text: t.mine }),
      mine.length
        ? h(
            'ul',
            { class: 'files card' },
            mine.map((f) => fileRow(f, { removable: true })),
          )
        : h('p', { class: 'card pad meta', text: t.noMine }),
      h('p', { class: 'meta', text: t.privacy }),
    ];
  }

  return { view, reload: load, openFromTask };
}
