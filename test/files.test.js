// Файли: класифікація, Range-відповідь протоколу, безпечний рендер DOCX і SVG, офісні формати, кеш. Лише вигадані дані.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { highlight } from '../src/highlight.js';
import {
  docxToHtml,
  parseCsv,
  pptxSlides,
  xlsxToSheets,
  zipList,
  colIndex,
} from '../src/files/office.js';
import { rangeResponse } from '../src/files/range.js';
import { createFileStore } from '../src/files/store.js';
import { classifyFile, safeName, STREAMABLE } from '../src/files/types.js';
import { createSanitizer } from '../src/sanitize.js';
import { tmpDir } from './ai-helpers.js';

const window = new JSDOM('').window;
const sanitize = createSanitizer(createDOMPurify(window));

test('класифікація файлів за таблицею: що відкривати й що лише зберігати', () => {
  const expect = {
    image: ['a.jpg', 'b.JPEG', 'c.png', 'd.gif', 'e.webp', 'f.bmp'],
    video: ['a.mp4', 'b.webm', 'c.mov', 'd.mkv', 'e.avi'],
    audio: ['a.mp3', 'b.m4a', 'c.wav', 'd.ogg', 'e.flac'],
    pdf: ['a.pdf'],
    docx: ['a.docx'],
    sheet: ['a.xlsx'],
    csv: ['a.csv'],
    pptx: ['a.pptx'],
    text: ['a.txt', 'b.md', 'c.json'],
    code: ['a.py', 'b.java', 'c.cpp', 'd.cs'],
    zip: ['a.zip'],
    other: [
      'a.exe',
      'b.msi',
      'c.apk',
      'd.html',
      'e.svg',
      'f.js',
      'g.unknown',
      'noext',
      'звіт.pdf.exe',
      'x.bat',
      'y.lnk',
      'z.htm',
      'w.doc',
    ],
  };
  for (const [kind, names] of Object.entries(expect))
    for (const n of names) assert.equal(classifyFile(n).kind, kind, n);
  assert.equal(classifyFile('a.mp4').mime, 'video/mp4');
  assert.ok(!STREAMABLE.has('other') && !STREAMABLE.has('pdf'));
  assert.equal(safeName('../../evil<>.exe'), '_.._evil__.exe');
  assert.equal(safeName('CON.txt'), 'файл');
  assert.equal(safeName('a\u0000b.txt'), 'a_b.txt');
});

test('Range-відповідь протоколу hp-file: повний файл, діапазони, суфікс, помилки', () => {
  const full = rangeResponse(1000, null, 'video/mp4');
  assert.equal(full.status, 200);
  assert.equal(full.headers['Content-Length'], '1000');
  assert.equal(full.headers['Accept-Ranges'], 'bytes');
  const r = rangeResponse(1000, 'bytes=0-99');
  assert.deepEqual(
    [r.status, r.start, r.end, r.headers['Content-Range'], r.headers['Content-Length']],
    [206, 0, 99, 'bytes 0-99/1000', '100'],
  );
  const open = rangeResponse(1000, 'bytes=900-');
  assert.deepEqual([open.start, open.end, open.headers['Content-Length']], [900, 999, '100']);
  const suffix = rangeResponse(1000, 'bytes=-50');
  assert.deepEqual([suffix.start, suffix.end], [950, 999]);
  const clampEnd = rangeResponse(1000, 'bytes=990-5000');
  assert.equal(clampEnd.end, 999);
  assert.equal(rangeResponse(1000, 'bytes=1000-').status, 416);
  assert.equal(rangeResponse(1000, 'bytes=500-100').status, 416);
  assert.equal(rangeResponse(1000, 'bytes=1000-').headers['Content-Range'], 'bytes */1000');
  assert.equal(rangeResponse(1000, 'bytes=0-1,5-6').status, 200); // кілька діапазонів не підтримуємо → весь файл
  assert.equal(rangeResponse(1000, 'items=0-1').status, 200);
  assert.equal(rangeResponse(0, 'bytes=0-').status, 416);
  assert.equal(full.headers['X-Content-Type-Options'], 'nosniff');
});

test('безпечний рендер DOCX: скрипти й обробники прибрано, зображення лише data:, SVG лише як <img>', () => {
  const svg =
    'data:image/svg+xml;base64,' +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    ).toString('base64');
  const html = sanitize(
    `<p>Текст</p><script>alert(1)</script><img src="x" onerror="alert(1)"><img src="https://evil.example.org/t.png">` +
      `<img src="${svg}" alt="схема" onload="x()"><svg onload="alert(3)"><circle/></svg><a href="javascript:alert(1)">x</a>` +
      `<table><tr><td>1</td></tr></table><img src="data:text/html;base64,PHNjcmlwdD4=">`,
    { doc: true },
  );
  const dom = new JSDOM(`<div>${html}</div>`).window.document;
  assert.ok(!/script|onerror|onload|javascript:|<svg|evil\.example|text\/html/i.test(html), html);
  const imgs = [...dom.querySelectorAll('img')];
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].getAttribute('src').startsWith('data:image/svg+xml;base64,'));
  assert.ok(dom.querySelector('table td'));
  // без режиму doc зображення не пропускаються взагалі
  assert.ok(!/<img/.test(sanitize(`<img src="${svg}">`)));
});

async function makeDocx() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
  );
  zip.file(
    'word/media/a.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Конспект &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>` +
      `<w:p><w:hyperlink r:id="rLink"><w:r><w:t>посилання</w:t></w:r></w:hyperlink></w:p>` +
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('DOCX → HTML (mammoth) → санітизація: текст як текст, картинка data:, javascript-посилання без href', async () => {
  const raw = await docxToHtml(await makeDocx());
  const html = sanitize(raw, { doc: true });
  assert.match(html, /Конспект &lt;script&gt;/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.ok(!/href="javascript/i.test(html));
});

test('XLSX → таблиця; CSV з лапками й крапкою з комою; PPTX → слайди; ZIP → список без розпакування', async () => {
  const x = new JSZip();
  x.file(
    'xl/workbook.xml',
    '<workbook><sheets><sheet name="Оцінки" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  x.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  x.file(
    'xl/sharedStrings.xml',
    '<sst><si><t>Предмет</t></si><si><t>Алгебра &amp; геометрія</t></si></sst>',
  );
  x.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Оцінка</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>11</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
  );
  const sheets = await xlsxToSheets(await x.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(sheets, [
    {
      name: 'Оцінки',
      rows: [
        ['Предмет', '', 'Оцінка'],
        ['Алгебра & геометрія', '', '11', 'TRUE'],
      ],
    },
  ]);
  assert.equal(colIndex('AB12'), 27);

  assert.deepEqual(parseCsv('a;b;c\n1;"x;y";"он ""так"""\n'), [
    ['a', 'b', 'c'],
    ['1', 'x;y', 'он "так"'],
  ]);
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);

  const p = new JSZip();
  p.file(
    'ppt/presentation.xml',
    '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
  );
  p.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
  );
  p.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Другий</a:t></a:r></a:p></p:sld>');
  p.file(
    'ppt/slides/slide2.xml',
    '<p:sld><a:p><a:r><a:t>Тема </a:t></a:r><a:r><a:t>уроку</a:t></a:r></a:p><a:p><a:r><a:t>План</a:t></a:r></a:p></p:sld>',
  );
  const slides = await pptxSlides(await p.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(slides, [
    { index: 1, lines: ['Тема уроку', 'План'] },
    { index: 2, lines: ['Другий'] },
  ]);

  const z = new JSZip();
  z.file('doc/readme.txt', 'x'.repeat(5000));
  z.file('run.exe', 'MZ');
  const list = await zipList(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.deepEqual(
    list.filter((e) => !e.dir).map((e) => [e.name, e.size]),
    [
      ['doc/readme.txt', 5000],
      ['run.exe', 2],
    ],
  );
});

test('сховище файлів: копії з нейтральним розширенням, кеш HUMAN з лімітом (найстаріші видаляються)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'фото дошки.png');
  fs.writeFileSync(src, Buffer.alloc(10));
  let limit = 250;
  const store = createFileStore({ dir: path.join(dir, 'files'), cacheLimit: () => limit });
  const [mine] = store.importFiles([src, path.join(dir, 'нема.png')]);
  assert.equal(mine.kind, 'image');
  assert.ok(store.pathOf(mine.id).endsWith('.bin'));
  assert.equal(store.read(mine.id).length, 10);
  const a = store.putHuman('1:0:5', 'a.pdf', Buffer.alloc(100), 1);
  store.putHuman('1:1:5', 'b.pdf', Buffer.alloc(100), 2);
  assert.ok(store.cached('1:0:5')); // a стає «свіжішим»
  store.putHuman('1:2:5', 'c.pdf', Buffer.alloc(100), 3);
  const cached = store
    .list('human')
    .map((f) => f.name)
    .sort();
  assert.deepEqual(cached, ['a.pdf', 'c.pdf']);
  assert.equal(store.get(a.id).kind, 'pdf');
  assert.equal(store.usage().cache, 200);
  store.clearCache();
  assert.equal(store.list('human').length, 0);
  assert.equal(store.list('mine').length, 1);
  assert.equal(store.get('../../etc'), null);
  limit = 0;
});

test('підсвітка коду: розмітка лише через текстові вузли', () => {
  const doc = window.document;
  const pre = doc.createElement('pre');
  pre.append(
    ...highlight('// <img src=x onerror=alert(1)>\nconst s = "<b>"; return 42;', 'c', doc),
  );
  assert.equal(pre.querySelectorAll('img,b').length, 0);
  assert.equal(pre.querySelector('.hl-c').textContent, '// <img src=x onerror=alert(1)>');
  assert.equal(pre.querySelector('.hl-s').textContent, '"<b>"');
  assert.deepEqual(
    [...pre.querySelectorAll('.hl-k')].map((x) => x.textContent),
    ['const', 'return'],
  );
  assert.equal(pre.querySelector('.hl-n').textContent, '42');
});
