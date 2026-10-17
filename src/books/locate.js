// Пошук сторінки в підручнику: розбір посилання з домашки («с. 34, № 2»), калібрування зсуву друкованих номерів
// відносно сторінок PDF, пошук вправи на сторінці, запасний повнотекстовий пошук, вибір книги за предметом. Чисті функції.

/**
 * @typedef {{ t: string, l?: string|null, e?: number[] }} Page текст, мітка сторінки (PDF PageLabels / EPUB pagebreak), числа з полів сторінки
 * @typedef {{ mode: 'manual'|'labels'|'auto'|'none', offset: number, map?: Record<string, number>, confidence?: number }} Calibration
 */

const NUM = '(\\d{1,4})';
const SEP = '\\s*[-–—]\\s*';

/**
 * Розбирає посилання з тексту домашки. Повертає першу знайдену сторінку (і діапазон), вправу й параграф.
 * Приклади: «с. 34, № 2», «ст.34 №2», «стор. 34-35», «сторінка 12», «№ 345 (с. 67)», «впр. 5 на с. 40», «§ 5».
 * @returns {{ page: number|null, pageTo: number|null, exercise: string|null, paragraph: string|null }}
 */
export function parseRef(text) {
  const s = String(text ?? '')
    .replace(/\s/g, ' ') // \s охоплює й нерозривний пробіл
    .toLocaleLowerCase('uk');
  const page = new RegExp(
    `(?:^|[^\\p{L}])(?:с|ст|стор|сторінк[аиіу]|сторінках|p|pp|page)\\.?\\s*${NUM}(?:${SEP}${NUM})?`,
    'u',
  ).exec(s);
  const ex = new RegExp(
    `(?:№|n°|#|(?:^|[^\\p{L}])(?:вправ[аиуі]?|впр|завдання|завд|задач[аіу]?|зад|ex|exercise)\\.?)\\s*${NUM}(?:[.,]\\s*(\\d{1,3}))?`,
    'u',
  ).exec(s);
  const par = /§\s*(\d{1,3})/u.exec(s) ?? /(?:^|[^\p{L}])(?:параграф|пар)\.?\s*(\d{1,3})/u.exec(s);
  return {
    page: page ? Number(page[1]) : null,
    pageTo: page?.[2] ? Number(page[2]) : null,
    exercise: ex ? ex[1] + (ex[2] ? '.' + ex[2] : '') : null,
    paragraph: par ? par[1] : null,
  };
}

/** Числа, що схожі на друкований номер сторінки, з одного рядка-краю (верх чи низ сторінки). */
export function edgeNumbers(line) {
  const out = [];
  const m = /^\s*(?:[-–—]\s*)?(\d{1,4})(?:\s*[-–—])?\s*$/.exec(String(line ?? ''));
  if (m) out.push(Number(m[1]));
  return out;
}

/**
 * Калібрування: для сторінок, де на краю знайдено номер n, голосуємо за зсув index − n.
 * Підручники можуть мати вклейки (зсув змінюється), тому повертаємо й карту «друкований номер → індекс»
 * для сторінок, де номер узгоджується з локальною більшістю.
 * @param {Page[]} pages
 * @returns {Calibration}
 */
export function calibrate(pages) {
  const n = pages.length;
  // 1) Мітки сторінок PDF (PageLabels) або EPUB pagebreak, якщо вони числові й не тривіальні.
  const labelMap = {};
  let numericLabels = 0;
  pages.forEach((p, i) => {
    if (p.l != null && /^\d{1,4}$/.test(String(p.l).trim())) {
      numericLabels++;
      labelMap[String(Number(p.l))] ??= i;
    }
  });
  if (numericLabels >= Math.max(3, n * 0.5)) {
    const trivial = pages.every((p, i) => p.l == null || String(p.l) === String(i + 1));
    if (!trivial)
      return { mode: 'labels', offset: labelOffset(labelMap), map: labelMap, confidence: 1 };
  }
  // 2) Номери з країв сторінок.
  const votes = new Map();
  const seen = [];
  pages.forEach((p, i) => {
    for (const num of p.e ?? []) {
      if (num < 1 || num > n + 200) continue;
      const off = i - num;
      votes.set(off, (votes.get(off) ?? 0) + 1);
      seen.push({ i, num, off });
    }
  });
  const withNums = new Set(seen.map((x) => x.i)).size;
  if (!withNums) return { mode: 'none', offset: 0, confidence: 0 };
  const [best, count] = [...votes.entries()].sort(
    (a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]),
  )[0];
  // Карта: номер приймається, якщо його зсув збігається зі зсувом сусідньої сторінки з номером (вклейки змінюють зсув).
  const map = {};
  const byPage = new Map();
  for (const x of seen) if (!byPage.has(x.i)) byPage.set(x.i, x);
  const ordered = [...byPage.values()].sort((a, b) => a.i - b.i);
  ordered.forEach((x, k) => {
    const prev = ordered[k - 1];
    const next = ordered[k + 1];
    if (x.off === best || prev?.off === x.off || next?.off === x.off) map[String(x.num)] ??= x.i;
  });
  const confidence = count / withNums;
  const ok = count >= 3 && confidence >= 0.5;
  return {
    mode: ok ? 'auto' : 'none',
    offset: ok ? best : 0,
    map: ok ? map : undefined,
    confidence,
  };
}

function labelOffset(map) {
  const offs = Object.entries(map).map(([num, i]) => i - Number(num));
  const counts = new Map();
  for (const o of offs) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

/**
 * Друкований номер → індекс сторінки (0-based).
 * @param {{ pageCount: number, calib: Calibration }} book
 * @returns {{ index: number, approximate: boolean } | null}
 */
export function resolvePage(book, printed) {
  const { pageCount, calib } = book;
  if (!Number.isInteger(printed) || printed < 1) return null;
  const c = calib ?? { mode: 'none', offset: 0 };
  const clamp = (i) => (i >= 0 && i < pageCount ? i : null);
  if (c.mode === 'manual') {
    const i = clamp(printed + c.offset);
    return i == null ? null : { index: i, approximate: false };
  }
  if (c.map && String(printed) in c.map)
    return { index: c.map[String(printed)], approximate: false };
  if (c.map) {
    // найближчі відомі номери знизу й зверху: якщо зсув однаковий — точно, інакше наближено
    const known = Object.keys(c.map)
      .map(Number)
      .sort((a, b) => a - b);
    const lo = known.filter((k) => k < printed).at(-1);
    const hi = known.find((k) => k > printed);
    const offLo = lo != null ? c.map[String(lo)] - lo : null;
    const offHi = hi != null ? c.map[String(hi)] - hi : null;
    const off = offLo ?? offHi ?? c.offset;
    const i = clamp(printed + off);
    if (i == null) return null;
    return { index: i, approximate: !(offLo != null && offHi != null && offLo === offHi) };
  }
  const i = clamp(printed + c.offset);
  if (i == null) return null;
  return { index: i, approximate: c.mode !== 'auto' };
}

/** Ручне калібрування: «сторінка PDF №pdfPage (1-based) = друкована printed». */
export const manualCalibration = (pdfPage, printed) => ({
  mode: 'manual',
  offset: pdfPage - 1 - printed,
  confidence: 1,
});

/** Індекс сторінки → друкований номер (для підпису «с. 34»). */
export function printedOf(book, index) {
  const c = book.calib ?? { mode: 'none', offset: 0 };
  if (c.map) {
    for (const [num, i] of Object.entries(c.map)) if (i === index) return Number(num);
  }
  return index - c.offset;
}

const exRe = (ex) => {
  const e = String(ex).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:№\\s*${e}(?!\\d))|(?:(?:вправа|впр\\.?|завдання|задача)\\s*${e}(?!\\d))|(?:(?:^|\\n)\\s*${e}[.)](?!\\d))`,
    'iu',
  );
};

/**
 * Шукає вправу на сторінці та сусідніх (умова часто переходить на наступну): спершу сама сторінка, потім +1, −1.
 * @param {Page[]} pages
 * @returns {{ index: number, found: boolean, snippet: string }}
 */
export function findExercise(pages, index, exercise) {
  if (!exercise) return { index, found: false, snippet: '' };
  const re = exRe(exercise);
  for (const i of [index, index + 1, index - 1]) {
    const t = pages[i]?.t ?? '';
    const m = re.exec(t);
    if (m) return { index: i, found: true, snippet: t.slice(m.index, m.index + 400).trim() };
  }
  return { index, found: false, snippet: '' };
}

const words = (s) =>
  String(s ?? '')
    .toLocaleLowerCase('uk')
    .replace(/[’ʼ']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
/** Грубе зведення до основи: українські закінчення змінюються, тож порівнюємо перші 5 літер довгих слів. */
const stem = (w) => (w.length > 6 ? w.slice(0, 5) : w);

/**
 * Повнотекстовий пошук (запасний шлях): сторінки, де трапляються всі (або більшість) слів запиту.
 * @param {Page[]} pages
 * @returns {{ index: number, score: number, snippet: string }[]}
 */
export function searchPages(pages, query, limit = 5) {
  const q = [...new Set(words(query).map(stem))];
  if (!q.length) return [];
  const hits = [];
  pages.forEach((p, index) => {
    const text = p.t ?? '';
    const ws = words(text);
    const set = new Set(ws.map(stem));
    const matched = q.filter((x) => set.has(x));
    if (matched.length < Math.ceil(q.length * 0.6)) return;
    const freq = ws.reduce((n, w) => n + (q.includes(stem(w)) ? 1 : 0), 0);
    const lower = text.toLocaleLowerCase('uk');
    const at = Math.max(0, lower.indexOf(matched[0]));
    hits.push({
      index,
      score: matched.length * 10 + Math.min(freq, 9),
      snippet: text
        .slice(Math.max(0, at - 80), at + 160)
        .replace(/\s+/g, ' ')
        .trim(),
    });
  });
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit);
}

/**
 * Книги, що підходять до предмета: точний збіг предмета (вибраного учнем) → частковий → збіг слів назви.
 * @param {{ id: string, title: string, subject?: string }[]} books
 */
export function matchSubject(books, subject) {
  const s = words(subject).map(stem);
  if (!s.length) return [];
  const norm = (x) => words(x).map(stem).join(' ');
  const scored = books.map((b) => {
    const bs = norm(b.subject);
    const bt = new Set(words(b.title).map(stem));
    let score = 0;
    if (bs && bs === s.join(' ')) score = 3;
    else if (bs && (bs.includes(s.join(' ')) || s.join(' ').includes(bs))) score = 2;
    else if (s.every((w) => bt.has(w))) score = 1.5;
    else if (s.some((w) => w.length > 3 && bt.has(w))) score = 1;
    return { b, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.b);
}
