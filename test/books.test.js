// Книги: пошук сторінки за номером із домашки, калібрування зсуву, витяг тексту, бібліотека. Лише вигадані дані.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import JSZip from 'jszip';
import {
  chunkText,
  decodeText,
  extractDocx,
  extractEpub,
  extractPdf,
  extractTxt,
} from '../src/books/extract.js';
import { createLibrary } from '../src/books/library.js';
import {
  calibrate,
  edgeNumbers,
  findExercise,
  manualCalibration,
  matchSubject,
  parseRef,
  printedOf,
  resolvePage,
  searchPages,
} from '../src/books/locate.js';
import { createTools } from '../src/ai/tools.js';
import { makePdf } from './fixtures/make-pdf.js';
import { demoService, tmpDir } from './ai-helpers.js';

test('посилання з домашки: сторінка, діапазон, вправа, параграф', () => {
  const cases = [
    ['с. 34, № 2', { page: 34, pageTo: null, exercise: '2', paragraph: null }],
    ['ст.34 №2', { page: 34, pageTo: null, exercise: '2', paragraph: null }],
    ['Стор. 34-35, вправа 5', { page: 34, pageTo: 35, exercise: '5', paragraph: null }],
    ['сторінка 12', { page: 12, pageTo: null, exercise: null, paragraph: null }],
    ['№ 345 (с. 67)', { page: 67, pageTo: null, exercise: '345', paragraph: null }],
    ['впр. 5 на с.40', { page: 40, pageTo: null, exercise: '5', paragraph: null }],
    ['§ 5, задача 3', { page: null, pageTo: null, exercise: '3', paragraph: '5' }],
    ['№ 12.4 с 101', { page: 101, pageTo: null, exercise: '12.4', paragraph: null }],
    ['Прочитати текст', { page: null, pageTo: null, exercise: null, paragraph: null }],
  ];
  for (const [s, want] of cases) assert.deepEqual(parseRef(s), want, s);
  // «с» усередині слова не є сторінкою
  assert.equal(parseRef('вчасно 5 хвилин').page, null);
});

test('номер на краю сторінки: «34», «— 34 —»; текст не рахується', () => {
  assert.deepEqual(edgeNumbers('34'), [34]);
  assert.deepEqual(edgeNumbers('— 34 —'), [34]);
  assert.deepEqual(edgeNumbers('Вправа 34'), []);
});

// Книга: 4 сторінки обкладинки й змісту без номерів, далі друковані 1..40, після с. 20 — вклейка з 2 сторінок без номерів.
function fakeBook() {
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push({ t: 'Обкладинка', e: [] });
  for (let n = 1; n <= 40; n++) {
    pages.push({
      t: `Текст сторінки ${n}.\n${n === 34 ? '1. Обчисліть.\n2. Розв’яжіть рівняння x+2=5.' : ''}`,
      e: n % 7 === 0 ? [] : [n],
    });
    if (n === 20) pages.push({ t: 'Кольорова вклейка', e: [] }, { t: 'Вклейка', e: [] });
  }
  return pages;
}

test('калібрування: зсув друкованих номерів і зміна зсуву після вклейки', () => {
  const pages = fakeBook();
  const c = calibrate(pages);
  assert.equal(c.mode, 'auto');
  assert.equal(c.offset, 3); // більшість сторінок до вклейки: індекс = номер + 3
  const book = { pageCount: pages.length, calib: c };
  assert.deepEqual(resolvePage(book, 10), { index: 13, approximate: false });
  assert.deepEqual(resolvePage(book, 34), { index: 39, approximate: false });
  // с. 14: номера на сторінці немає, але сусіди узгоджені → точно; с. 21 одразу після вклейки → наближено
  assert.equal(resolvePage(book, 21).approximate, true);
  assert.deepEqual(resolvePage(book, 22), { index: 27, approximate: false });
  assert.deepEqual(resolvePage(book, 14), { index: 17, approximate: false });
  assert.equal(printedOf(book, 39), 34);
  assert.equal(resolvePage(book, 500), null);
});

test('калібрування: мітки сторінок PDF важливіші, без номерів — наближено, ручне — точно', () => {
  const labeled = Array.from({ length: 10 }, (_, i) => ({
    t: 'x',
    l: i < 2 ? ['i', 'ii'][i] : String(i - 1),
    e: [],
  }));
  const c = calibrate(labeled);
  assert.equal(c.mode, 'labels');
  assert.deepEqual(resolvePage({ pageCount: 10, calib: c }, 5), { index: 6, approximate: false });
  const none = calibrate(Array.from({ length: 10 }, () => ({ t: 'x', e: [] })));
  assert.equal(none.mode, 'none');
  assert.deepEqual(resolvePage({ pageCount: 10, calib: none }, 5), { index: 5, approximate: true });
  const m = manualCalibration(12, 10); // сторінка PDF 12 = друкована 10
  assert.deepEqual(resolvePage({ pageCount: 50, calib: m }, 10), { index: 11, approximate: false });
  assert.deepEqual(resolvePage({ pageCount: 50, calib: m }, 34), { index: 35, approximate: false });
});

test('вправа: на сторінці, на наступній (умова переходить) або не знайдено', () => {
  const pages = [
    { t: 'вступ' },
    { t: '1. Перше.\n2. Друге завдання.' },
    { t: '№ 3 Третє\n4) Четверте' },
  ];
  assert.deepEqual(findExercise(pages, 1, '2').index, 1);
  assert.equal(findExercise(pages, 1, '3').index, 2);
  assert.equal(findExercise(pages, 1, '4').found, true);
  assert.equal(findExercise(pages, 1, '12').found, false);
  assert.equal(findExercise(pages, 1, '2').snippet.startsWith('2. Друге'), true);
});

test('повнотекстовий пошук з урахуванням закінчень; вибір книги за предметом', () => {
  const pages = [
    { t: 'Квадратні рівняння мають два корені.' },
    { t: 'Дроби й відсотки.' },
    { t: 'Розв’язування квадратного рівняння' },
  ];
  const hits = searchPages(pages, 'квадратне рівняння');
  assert.deepEqual(hits.map((h) => h.index).sort(), [0, 2]);
  assert.ok(hits[0].snippet.length > 0);
  assert.deepEqual(searchPages(pages, ''), []);
  const books = [
    { id: 'a', title: 'Алгебра 8 клас', subject: '' },
    { id: 'b', title: 'Підручник', subject: 'Геометрія' },
    { id: 'c', title: 'Хімія 8', subject: 'Хімія' },
  ];
  assert.deepEqual(
    matchSubject(books, 'Геометрія').map((b) => b.id),
    ['b'],
  );
  assert.deepEqual(
    matchSubject(books, 'Алгебра').map((b) => b.id),
    ['a'],
  );
  assert.deepEqual(matchSubject(books, 'Фізика'), []);
});

test('PDF: текст сторінок, номери з країв і мітки сторінок (PageLabels)', async () => {
  const pdf = makePdf(
    [['Cover'], ['Intro text', '1'], ['Exercise No 5', 'body', '2'], ['3', 'Header']],
    {
      labels: '0 << /S /r >> 1 << /S /D >>',
    },
  );
  const { pages } = await extractPdf(pdf);
  assert.equal(pages.length, 4);
  assert.match(pages[2].t, /Exercise No 5/);
  assert.deepEqual(pages[1].e, [1]);
  assert.deepEqual(pages[3].e, [3]);
  assert.equal(pages[0].l, 'i');
  assert.equal(pages[2].l, '2');
});

test('DOCX: розриви сторінок; EPUB: маркери pagebreak з друкованими номерами; TXT: cp1251', async () => {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<w:document><w:body><w:p><w:r><w:t>Сторінка один &amp; текст</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Сторінка два</w:t></w:r></w:p></w:body></w:document>',
  );
  const docx = await extractDocx(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(docx.pages.length, 2);
  assert.equal(docx.pages[0].t, 'Сторінка один & текст');
  assert.equal(docx.pages[1].t, 'Сторінка два');

  const ep = new JSZip();
  ep.file(
    'META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
  );
  ep.file(
    'OEBPS/book.opf',
    '<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  ep.file(
    'OEBPS/c1.xhtml',
    '<html><body><span epub:type="pagebreak" title="33"/><p>Текст 33</p><script>evil()</script><span epub:type="pagebreak" title="34"/><p>№ 2. Задача</p></body></html>',
  );
  const epub = await extractEpub(await ep.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(
    epub.pages.map((p) => [p.l, p.t]),
    [
      ['33', 'Текст 33'],
      ['34', '№ 2. Задача'],
    ],
  );

  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2]); // «Привіт»
  assert.equal(decodeText(cp1251), 'Привіт');
  assert.equal(extractTxt(Buffer.from('a\fb\fc')).pages.length, 3);
  assert.ok(chunkText('x'.repeat(10000)).every((p) => p.t.length <= 6000));
});

test('бібліотека: імпорт PDF, калібрування, сторінка за номером із домашки, пошук, видалення', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'Algebra 8.pdf');
  const pages = [
    ['Cover of the algebra book for grade eight'],
    ['Contents of the algebra book for grade eight'],
  ];
  for (let n = 1; n <= 12; n++)
    pages.push([
      `Page text ${n} with enough words to look like a real page`,
      n === 7 ? '2. Solve x+1=3' : 'lorem',
      String(n),
    ]);
  pages.push([' ']); // скан без тексту
  fs.writeFileSync(src, makePdf(pages));
  const rendered = [];
  const lib = createLibrary({
    dir: path.join(dir, 'books'),
    renderPage: async (id, index) => (
      rendered.push(index),
      { mediaType: 'image/jpeg', data: 'AAAA' }
    ),
  });
  const r = await lib.import(src, { now: 1 });
  assert.equal(r.ok, true);
  const id = r.book.id;
  assert.equal(r.book.calib.mode, 'auto');
  assert.equal(r.book.calib.offset, 1);
  assert.equal(r.book.scannedPages, 1);
  lib.update(id, { subject: 'Алгебра' });
  assert.equal(lib.findBooks('алгебра')[0].id, id);
  const p = await lib.getPage(id, 7, { exercise: '2' });
  assert.equal(p.ok, true);
  assert.equal(p.index, 8);
  assert.equal(p.exerciseFound, true);
  assert.match(p.text, /Page text 7/);
  assert.equal((await lib.getPage(id, 99)).ok, false);
  assert.equal(lib.search('Solve')[0].printed, 7);
  // ручне калібрування
  lib.calibrate(id, { pdfPage: 5, printed: 3 });
  assert.equal((await lib.getPage(id, 3)).index, 4);
  lib.calibrate(id, null);
  assert.equal(lib.get(id).calib.mode, 'auto');
  // перезапуск: індекс читається з диска
  const again = createLibrary({ dir: path.join(dir, 'books') });
  assert.equal(again.list().length, 1);
  assert.equal(await lib.import(path.join(dir, 'x.exe')).then((x) => x.error), 'format');

  // інструменти асистента над бібліотекою: get_page віддає одну сторінку, скан — зображенням
  const service = await demoService();
  const tools = createTools({ service, books: lib });
  const fb = await tools.run('find_book', { subject: 'Алгебра' });
  assert.equal(fb.result[0].book_id, id);
  const gp = await tools.run('get_page', { book_id: id, page: 7, exercise: '2' });
  assert.equal(gp.result.printed_page, 7);
  assert.equal(gp.card.kind, 'page');
  assert.ok(!JSON.stringify(gp.result).includes('Page text 8'));
  const scan = await tools.run('get_page', { book_id: id, page: 13 });
  assert.deepEqual(scan.image, { mediaType: 'image/jpeg', data: 'AAAA' });
  assert.deepEqual(rendered, [14]);
  const sb = await tools.run('search_book', { query: 'Solve' });
  assert.equal(sb.result[0].page, 7);
  assert.equal(lib.remove(id), true);
  assert.equal(lib.list().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'books')), ['index.json']);
});

test('імпорт папки: рекурсивно, лише книги, повторно не додає', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'Мої книги');
  fs.mkdirSync(path.join(src, '8 клас'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Історія.txt'), 'Розділ перший. '.repeat(50));
  fs.writeFileSync(path.join(src, '8 клас', 'Фізика.txt'), 'Механіка. '.repeat(50));
  fs.writeFileSync(path.join(src, 'virus.exe'), 'MZ');
  fs.writeFileSync(path.join(src, 'notes.html'), '<script>x</script>');
  const lib = createLibrary({ dir: path.join(dir, 'books') });
  const r = await lib.importFolder(src);
  assert.deepEqual([r.added, r.skipped, r.failed], [2, 0, 0]);
  const again = await lib.importFolder(src);
  assert.deepEqual([again.added, again.skipped], [0, 2]);
  assert.deepEqual(lib.list().map((b) => b.title).sort(), ['Історія', 'Фізика']);
});
