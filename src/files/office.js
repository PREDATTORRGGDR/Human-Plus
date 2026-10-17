// Офісні й архівні формати → безпечні структури для вікна (main-процес). Нічого не виконується:
// DOCX → HTML через mammoth (далі вікно ще раз санітизує його), XLSX/CSV → рядки таблиці, PPTX → текст слайдів, ZIP → список.
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { decodeXml } from '../books/extract.js';

const LIMITS = { rows: 1000, cols: 50, sheets: 10, slides: 300, zipEntries: 2000 };
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/** DOCX → HTML. Зображення стають data:-адресами лише для безпечних растрових типів і SVG (у вікні SVG лише як <img>). */
export async function docxToHtml(buffer) {
  const r = await mammoth.convertToHtml(
    { buffer: Buffer.from(buffer) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!IMG_TYPES.includes(image.contentType)) return { src: '' };
        return { src: `data:${image.contentType};base64,${await image.read('base64')}` };
      }),
      externalFileAccess: false,
    },
  );
  return r.value;
}

/** Номер колонки з посилання «AB12» → 27. */
export const colIndex = (ref) => {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** XLSX → аркуші з рядками (лише значення; формули не обчислюються — береться збережений результат). */
export async function xlsxToSheets(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = (p) => zip.file(p)?.async('string') ?? Promise.resolve('');
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    ([, si]) =>
      decodeXml([...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join('')),
  );
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const target = (rid) =>
    new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
  const sheets = [];
  for (const [tag] of [...wb.matchAll(/<sheet\s[^>]*>/g)].slice(0, LIMITS.sheets)) {
    const name = decodeXml(/name="([^"]*)"/.exec(tag)?.[1] ?? '');
    const rid = /r:id="([^"]*)"/.exec(tag)?.[1];
    const t = rid && target(rid);
    const file = t ? 'xl/' + (t[1] ?? t[2]).replace(/^\/?xl\//, '') : null;
    const xml = file ? await read(file) : '';
    const rows = [];
    for (const [, rowXml] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= LIMITS.rows) break;
      const row = [];
      for (const [, attrs, body] of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref ? colIndex(ref) : row.length;
        if (col >= LIMITS.cols) continue;
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(body ?? '')?.[1];
        let val;
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr')
          val = decodeXml(
            [...(body ?? '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join(''),
          );
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else val = v != null ? decodeXml(v) : '';
        row[col] = val;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/** CSV (кома, крапка з комою чи табуляція; лапки за RFC 4180). */
export function parseCsv(text) {
  const s = String(text ?? '');
  const first = s.split('\n', 1)[0];
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length && rows.length < LIMITS.rows; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row.slice(0, LIMITS.cols));
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell].slice(0, LIMITS.cols));
  return rows;
}

/** PPTX → текст слайдів у порядку показу. */
export async function pptxSlides(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = (p) => zip.file(p)?.async('string') ?? Promise.resolve('');
  const pres = await read('ppt/presentation.xml');
  const rels = await read('ppt/_rels/presentation.xml.rels');
  const ids = [...pres.matchAll(/<p:sldId\s[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  let files = ids
    .map((rid) =>
      new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels),
    )
    .filter(Boolean)
    .map((m) => 'ppt/' + (m[1] ?? m[2]).replace(/^\/?ppt\//, ''));
  if (!files.length)
    files = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/\d+/.exec(a)) - Number(/\d+/.exec(b)));
  const slides = [];
  for (const f of files.slice(0, LIMITS.slides)) {
    const xml = await read(f);
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map(([, p]) => decodeXml([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')))
      .filter((x) => x.trim());
    slides.push({ index: slides.length + 1, lines: paras });
  }
  return slides;
}

/** ZIP → список вмісту (без розпакування). */
export async function zipList(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return Object.values(zip.files)
    .slice(0, LIMITS.zipEntries)
    .map((f) => ({
      name: f.name,
      dir: f.dir,
      size: f._data?.uncompressedSize ?? null,
      date: f.date?.getTime?.() ?? null,
    }));
}
