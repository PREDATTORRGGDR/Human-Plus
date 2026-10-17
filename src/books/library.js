// Бібліотека підручників учня: лише на цьому пристрої (userData/books). Імпорт копіює файл і витягує текст сторінок;
// у модель потім іде тільки одна потрібна сторінка (src/ai/tools.js → get_page), ніколи не вся книга.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_FORMATS, extractBook } from './extract.js';
import {
  calibrate,
  findExercise,
  manualCalibration,
  matchSubject,
  printedOf,
  resolvePage,
  searchPages,
} from './locate.js';

export const MAX_BOOK_BYTES = 400 * 1024 * 1024;
const SCANNED_CHARS = 25; // сторінка з меншою кількістю символів вважається сканом
const ID = /^[a-f0-9]{16}$/;

/**
 * @param {{ dir: string, extract?: typeof extractBook, renderPage?: (id: string, index: number) => Promise<{mediaType:string,data:string}|null> }} deps
 */
export function createLibrary({ dir, extract = extractBook, renderPage = null }) {
  const indexFile = path.join(dir, 'index.json');
  const cache = new Map(); // id → pages (у пам'яті не більше 3 книг)
  let books = load();

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return Array.isArray(j) ? j.filter((b) => ID.test(b?.id)) : [];
    } catch {
      return [];
    }
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify(books));
    fs.renameSync(indexFile + '.tmp', indexFile);
  }
  const get = (id) =>
    typeof id === 'string' && ID.test(id) ? books.find((b) => b.id === id) : null;
  const fileOf = (b) => path.join(dir, `${b.id}.${b.format}`);
  const pagesFile = (b) => path.join(dir, `${b.id}.pages.json`);

  function pages(b) {
    if (cache.has(b.id)) return cache.get(b.id);
    let p;
    try {
      p = JSON.parse(fs.readFileSync(pagesFile(b), 'utf8'));
    } catch {
      p = [];
    }
    cache.set(b.id, p);
    if (cache.size > 3) cache.delete(cache.keys().next().value);
    return p;
  }

  const pub = (b) => ({
    id: b.id,
    title: b.title,
    subject: b.subject ?? '',
    format: b.format,
    pageCount: b.pageCount,
    size: b.size,
    scannedPages: b.scannedPages,
    calib: { mode: b.calib.mode, offset: b.calib.offset, confidence: b.calib.confidence ?? 0 },
    addedAt: b.addedAt,
  });

  return {
    list: () => books.map(pub),
    get: (id) => (get(id) ? pub(get(id)) : null),

    /** Імпорт файлу з диска (шлях обрав учень у системному діалозі). */
    async import(filePath, { now = Date.now(), onProgress } = {}) {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (!BOOK_FORMATS.includes(ext)) return { ok: false, error: 'format' };
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size > MAX_BOOK_BYTES) return { ok: false, error: 'size' };
      const data = fs.readFileSync(filePath);
      let res;
      try {
        res = await extract(data, ext, onProgress);
      } catch {
        return { ok: false, error: 'parse' };
      }
      const p = res.pages;
      if (!p.length) return { ok: false, error: 'empty' };
      const b = {
        id: crypto.randomBytes(8).toString('hex'),
        title: path.basename(filePath, path.extname(filePath)).slice(0, 120),
        subject: '',
        format: ext,
        pageCount: p.length,
        size: st.size,
        scannedPages:
          ext === 'pdf' ? p.filter((x) => x.t.replace(/\s/g, '').length < SCANNED_CHARS).length : 0,
        calib: calibrate(p),
        addedAt: now,
        source: path.basename(filePath),
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileOf(b), data);
      fs.writeFileSync(pagesFile(b), JSON.stringify(p));
      cache.set(b.id, p);
      books.push(b);
      save();
      return { ok: true, book: pub(b) };
    },

    /**
     * Імпорт цілої папки (рекурсивно, до 4 рівнів, до 300 файлів). Уже додані книги (та сама назва й розмір) пропускаються.
     * @returns {Promise<{ added: number, skipped: number, failed: number }>}
     */
    async importFolder(folder, { onProgress } = {}) {
      const found = [];
      const walk = (d, depth) => {
        if (depth > 4 || found.length >= 300) return;
        let entries;
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (found.length >= 300) break;
          const full = path.join(d, e.name);
          if (e.isDirectory() && !e.name.startsWith('.')) walk(full, depth + 1);
          else if (e.isFile() && BOOK_FORMATS.includes(path.extname(e.name).slice(1).toLowerCase()))
            found.push(full);
        }
      };
      walk(folder, 0);
      const res = { added: 0, skipped: 0, failed: 0, total: found.length };
      for (const [k, f] of found.entries()) {
        onProgress?.({ done: k, total: found.length, name: path.basename(f) });
        let size = 0;
        try {
          size = fs.statSync(f).size;
        } catch {
          res.failed++;
          continue;
        }
        if (books.some((b) => b.source === path.basename(f) && b.size === size)) {
          res.skipped++;
          continue;
        }
        const r = await this.import(f);
        r.ok ? res.added++ : res.failed++;
      }
      return res;
    },

    update(id, patch) {
      const b = get(id);
      if (!b) return null;
      if (typeof patch?.title === 'string' && patch.title.trim())
        b.title = patch.title.trim().slice(0, 120);
      if (typeof patch?.subject === 'string') b.subject = patch.subject.trim().slice(0, 80);
      save();
      return pub(b);
    },

    /** Ручне калібрування («сторінка PDF 12 = друкована 10») або скидання до автоматичного (null). */
    calibrate(id, pair) {
      const b = get(id);
      if (!b) return null;
      if (
        pair &&
        Number.isInteger(pair.pdfPage) &&
        Number.isInteger(pair.printed) &&
        pair.pdfPage >= 1 &&
        pair.pdfPage <= b.pageCount &&
        pair.printed >= 0
      )
        b.calib = manualCalibration(pair.pdfPage, pair.printed);
      else b.calib = calibrate(pages(b));
      save();
      return pub(b);
    },

    remove(id) {
      const b = get(id);
      if (!b) return false;
      fs.rmSync(fileOf(b), { force: true });
      fs.rmSync(pagesFile(b), { force: true });
      cache.delete(b.id);
      books = books.filter((x) => x.id !== b.id);
      save();
      return true;
    },

    clearAll() {
      fs.rmSync(dir, { recursive: true, force: true });
      cache.clear();
      books = [];
    },

    /** Оригінальний файл (для перегляду у вікні). */
    bytes(id) {
      const b = get(id);
      return b ? fs.readFileSync(fileOf(b)) : null;
    },
    filePath: (id) => (get(id) ? fileOf(get(id)) : null),

    findBooks: (subject) => matchSubject(books, subject).map(pub),

    pageText(id, index) {
      const b = get(id);
      const p = b ? pages(b)[index] : null;
      return p ? { text: p.t, printed: printedOf(b, index), label: p.l } : null;
    },

    /** Сторінка за друкованим номером (з калібруванням) і, якщо задано, пошук вправи на ній чи сусідній. */
    async getPage(id, printed, { exercise } = {}) {
      const b = get(id);
      if (!b) return { ok: false, error: 'Книгу не знайдено. Спершу виклич find_book.' };
      const r = resolvePage(b, printed);
      if (!r)
        return { ok: false, error: `У книзі немає сторінки ${printed} (усього ${b.pageCount}).` };
      const p = pages(b);
      const ex = exercise ? findExercise(p, r.index, exercise) : { index: r.index, found: false };
      const index = ex.found ? ex.index : r.index;
      const text = p[index]?.t ?? '';
      return {
        ok: true,
        title: b.title,
        printed: index === r.index ? printed : printedOf(b, index),
        index,
        approximate: r.approximate,
        exerciseFound: ex.found,
        scanned: b.format === 'pdf' && text.replace(/\s/g, '').length < SCANNED_CHARS,
        text,
      };
    },

    search(query, { bookId = null, limit = 5 } = {}) {
      const list = bookId ? [get(bookId)].filter(Boolean) : books;
      return list
        .flatMap((b) =>
          searchPages(pages(b), query, limit).map((h) => ({
            ...h,
            bookId: b.id,
            title: b.title,
            printed: printedOf(b, h.index),
          })),
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    /** Зображення сторінки-скану для моделі (рендерить вікно через pdfjs). */
    async pageImage(id, index) {
      const b = get(id);
      if (!b || b.format !== 'pdf' || !renderPage) return null;
      return renderPage(b.id, index);
    },
  };
}
