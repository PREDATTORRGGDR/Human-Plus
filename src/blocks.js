// Блоки вмісту ДЗ (content.blocks) → безпечна внутрішня модель. Єдине місце, що знає форму блоків Human.
// Типи взято з реєстру редактора Human: tl01 заголовок, tx01/tx02/tx03 текст, ip01 «До уваги», im01 зображення,
// fl01 файл, lk01 посилання, cf01 формула, ct01 таблиця, dv01 лінія; qn01/pl01 (питання, опитування) не показуємо.
import { isAllowedMedia, isSafeLink } from './allowlist.js';

export const FILES_ORIGIN = 'https://files.human.ua';

/**
 * @typedef {{kind:'heading', text:string} | {kind:'html', html:string, note?:boolean} | {kind:'text', title:string, text:string}
 *  | {kind:'image', url:string, caption:string} | {kind:'file', url:string, name:string, size:number}
 *  | {kind:'link', url:string|null, title:string, description:string} | {kind:'formula', text:string}
 *  | {kind:'table', html:string} | {kind:'divider'} | {kind:'unsupported', type:string}} Block
 */

const str = (x) => (typeof x === 'string' ? x : '');

/** Усі рядки з довільної вкладеної структури (для tx03, форма якого не підтверджена на живих даних). */
function textOf(v, depth = 0) {
  if (depth > 6 || v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v))
    return v
      .map((x) => textOf(x, depth + 1))
      .filter(Boolean)
      .join('\n');
  if (typeof v === 'object')
    return ['text', 'content', 'value', 'children']
      .map((k) => textOf(v[k], depth + 1))
      .filter(Boolean)
      .join('');
  return '';
}

/** @returns {Block|null} */
export function normalizeBlock(b, uid) {
  const d = b?.data && typeof b.data === 'object' ? b.data : {};
  switch (b?.type) {
    case 'tl01':
      return str(d.title) ? { kind: 'heading', text: d.title } : null;
    case 'tx01':
      return { kind: 'html', html: str(d.text) };
    case 'ip01':
      return { kind: 'html', html: str(d.text), note: true };
    case 'tx02':
      return { kind: 'text', title: str(d.title), text: str(d.text) };
    case 'tx03': {
      const text = textOf(d.linesEditor).trim();
      return text ? { kind: 'text', title: '', text } : { kind: 'unsupported', type: 'tx03' };
    }
    case 'im01':
      return isAllowedMedia(d.url)
        ? { kind: 'image', url: d.url, caption: str(d.text) }
        : { kind: 'unsupported', type: 'im01' };
    case 'fl01': {
      const f = d.file ?? {};
      const url =
        str(f.fullUrl) ||
        (f.hash && uid != null
          ? `${FILES_ORIGIN}/${uid}/file/get/${encodeURIComponent(f.hash)}`
          : '');
      if (!isAllowedMedia(url)) return { kind: 'unsupported', type: 'fl01' };
      const name = f.extension ? `${str(f.name)}.${f.extension}` : str(f.name);
      return { kind: 'file', url, name: name || 'файл', size: Number(f.size) || 0 };
    }
    case 'lk01': {
      const url = str(d.link?.url) || str(d.url);
      return {
        kind: 'link',
        url: isSafeLink(url) ? url : null,
        title: str(d.link?.title),
        description: str(d.link?.description),
        rawUrl: url,
      };
    }
    case 'cf01':
      return { kind: 'formula', text: str(d.text) };
    case 'ct01':
      return { kind: 'table', html: str(d.text) };
    case 'dv01':
      return { kind: 'divider' };
    default:
      return { kind: 'unsupported', type: String(b?.type ?? '?') };
  }
}

/** Блоки з content.blocks; пусті й некоректні відкидаємо. */
export const normalizeBlocks = (raw, uid) =>
  (Array.isArray(raw) ? raw : []).map((b) => normalizeBlock(b, uid)).filter(Boolean);

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Версія блоків для вікна: без адрес зображень і файлів (їх знає лише main), із індексом,
 * за яким вікно просить зображення, збереження файлу чи відкриття посилання.
 */
export function toPublic(blocks) {
  return blocks.map((b, index) => {
    switch (b.kind) {
      case 'image':
        return { kind: 'image', index, caption: b.caption };
      case 'file':
        return { kind: 'file', index, name: b.name, size: b.size };
      case 'link':
        return {
          kind: 'link',
          index,
          title: b.title,
          description: b.description,
          domain: hostOf(b.url ?? b.rawUrl),
          openable: !!b.url,
        };
      default:
        return { ...b, index };
    }
  });
}
