// Витяг тексту з книг (main-процес, Node): PDF (pdfjs), EPUB і DOCX (jszip), TXT. Результат — масив сторінок
// { t: текст, l: мітка (друкований номер, якщо відомий), e: числа з країв сторінки для калібрування }.
// Файли недовірені: нічого не виконується, HTML/XML лише розбирається регулярними виразами на текст.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { edgeNumbers } from './locate.js';

const require = createRequire(import.meta.url);
const MAX_PAGES = 3000;
const MAX_PAGE_CHARS = 20000;
const CHUNK = 3000;
export const BOOK_FORMATS = ['pdf', 'epub', 'docx', 'txt'];

let pdfjsPromise = null;
const pdfjsDir = () => path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs = () =>
  (pdfjsPromise ??= import(pathToFileURL(path.join(pdfjsDir(), 'legacy/build/pdf.mjs')).href));

const yieldLoop = () => new Promise((r) => setImmediate(r));
const clip = (s) => (s.length > MAX_PAGE_CHARS ? s.slice(0, MAX_PAGE_CHARS) : s);

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeXml = (s) =>
  String(s).replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === '#'
      ? safeChar(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : (XML_ENT[e.toLowerCase()] ?? m),
  );
const safeChar = (n) =>
  Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';

/** Завдання завантаження PDF у pdfjs для читання тексту (без шрифтів у DOM, без eval). */
export async function openPdfDocument(data) {
  const lib = await pdfjs();
  // pdfjs вимагає адреси з «/» в кінці; у Windows шляхи переводимо на прямі скісні.
  const dir = pdfjsDir().split(path.sep).join('/');
  return lib.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    standardFontDataUrl: `${dir}/standard_fonts/`,
    cMapUrl: `${dir}/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${dir}/wasm/`,
    verbosity: 0,
  });
}

/** Елементи тексту сторінки → рядки згори вниз (групування за y). */
export function itemsToLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    const y = Math.round(it.transform[5] / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, r]) =>
      r
        .sort((a, b) => a.x - b.x)
        .map((c) => c.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export async function extractPdf(data, onProgress) {
  const task = await openPdfDocument(data);
  const doc = await task.promise;
  try {
    const labels = await doc.getPageLabels().catch(() => null);
    const n = Math.min(doc.numPages, MAX_PAGES);
    const pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const lines = itemsToLines(tc.items);
      const edges = [...lines.slice(0, 2), ...lines.slice(-2)].flatMap(edgeNumbers);
      pages.push({ t: clip(lines.join('\n')), l: labels?.[i - 1] ?? null, e: [...new Set(edges)] });
      page.cleanup();
      if (i % 10 === 0) {
        onProgress?.(i / n);
        await yieldLoop();
      }
    }
    return { pages, total: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/** Довгий текст без розбиття на сторінки → «сторінки» по ~3000 символів на межі абзаців. */
export function chunkText(text, size = CHUNK) {
  const paras = String(text).split(/\n+/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + p;
    while (cur.length > size * 2) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) out.push(cur);
  return out.slice(0, MAX_PAGES).map((t) => ({ t: clip(t), l: null, e: [] }));
}

export async function extractDocx(data) {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('docx: no document.xml');
  const pages = [[]];
  for (const [p] of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    let line = '';
    for (const [tok, txt] of p.matchAll(
      /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br [^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\/>/g,
    )) {
      if (txt !== undefined) line += decodeXml(txt);
      else if (tok.startsWith('<w:tab')) line += '\t';
      else {
        pages.at(-1).push(line);
        line = '';
        pages.push([]);
      }
    }
    pages.at(-1).push(line);
  }
  const texts = pages.map((ls) =>
    ls
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  const nonEmpty = texts.filter(Boolean);
  if (nonEmpty.length < 2) return { pages: chunkText(nonEmpty.join('\n')) };
  return {
    pages: texts.slice(0, MAX_PAGES).map((t, i) => ({ t: clip(t), l: String(i + 1), e: [] })),
  };
}

/** XHTML → текст (теги відкидаються, блочні елементи стають новими рядками). */
export const xhtmlToText = (s) =>
  decodeXml(
    String(s)
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\s*(br|\/p|\/div|\/h\d|\/li|\/tr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

const PAGEBREAK = /<[^>]+(?:epub:type="pagebreak"|role="doc-pagebreak")[^>]*>/gi;
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`, 'i').exec(tag)?.[1];

export async function extractEpub(data) {
  const zip = await JSZip.loadAsync(data);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && attr(/<rootfile\s[^>]*>/i.exec(container)?.[0] ?? '', 'full-path');
  const opf = opfPath && (await zip.file(opfPath)?.async('string'));
  if (!opf) throw new Error('epub: no package');
  const base = path.posix.dirname(opfPath);
  const manifest = new Map();
  for (const [tag] of opf.matchAll(/<item\s[^>]*>/gi))
    manifest.set(attr(tag, 'id'), attr(tag, 'href'));
  const spine = [...opf.matchAll(/<itemref\s[^>]*>/gi)]
    .map(([tag]) => manifest.get(attr(tag, 'idref')))
    .filter(Boolean);
  const pages = [];
  let hasMarkers = false;
  let pending = { t: '', l: null };
  for (const href of spine) {
    const file = zip.file(
      path.posix.normalize(path.posix.join(base, decodeURIComponent(href.split('#')[0]))),
    );
    if (!file) continue;
    const html = await file.async('string');
    const body = /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
    let last = 0;
    for (const m of body.matchAll(PAGEBREAK)) {
      hasMarkers = true;
      pending.t += '\n' + xhtmlToText(body.slice(last, m.index));
      if (pending.t.trim() || pending.l != null) pages.push(pending);
      pending = { t: '', l: attr(m[0], 'title') ?? attr(m[0], 'aria-label') ?? null };
      last = m.index + m[0].length;
    }
    pending.t += '\n' + xhtmlToText(body.slice(last));
    if (pages.length >= MAX_PAGES) break;
  }
  if (pending.t.trim()) pages.push(pending);
  if (!hasMarkers) return { pages: chunkText(pages.map((p) => p.t).join('\n')) };
  return { pages: pages.slice(0, MAX_PAGES).map((p) => ({ t: clip(p.t.trim()), l: p.l, e: [] })) };
}

/** Текст: UTF-8 (з BOM чи без), інакше Windows-1251 (старі українські файли). */
export function decodeText(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(b)
      .replace(/^\s/, (c) => (c.charCodeAt(0) === 0xfeff ? '' : c));
  } catch {
    return new TextDecoder('windows-1251').decode(b);
  }
}

export function extractTxt(data) {
  const text = decodeText(data).replace(/\r\n?/g, '\n');
  if (text.includes('\f')) {
    const parts = text.split('\f');
    return {
      pages: parts
        .slice(0, MAX_PAGES)
        .map((t, i) => ({ t: clip(t.trim()), l: String(i + 1), e: [] })),
    };
  }
  return { pages: chunkText(text) };
}

/** @returns {Promise<{ pages: {t:string,l:string|null,e:number[]}[] }>} */
export async function extractBook(data, format, onProgress) {
  switch (format) {
    case 'pdf':
      return extractPdf(data, onProgress);
    case 'docx':
      return extractDocx(data);
    case 'epub':
      return extractEpub(data);
    case 'txt':
      return extractTxt(data);
    default:
      throw new Error('format');
  }
}
