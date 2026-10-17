// Мінімальний PDF без залежностей для тестів: кожна сторінка — кілька рядків ASCII-тексту (вигадані дані).
// labels — вміст масиву /PageLabels /Nums (наприклад '0 << /S /D /St 5 >>'), щоб перевірити друковані номери.
export function makePdf(pages, { labels = null } = {}) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const esc = (s) => String(s).replace(/[()\\]/g, (c) => '\\' + c);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const lines of pages) {
    const body = (Array.isArray(lines) ? lines : [lines])
      .map((l, i) => `BT /F1 14 Tf 50 ${780 - i * 20} Td (${esc(l)}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent @PAGES@ 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  const pagesObj = add(
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  const labelsPart = labels ? ` /PageLabels << /Nums [${labels}] >>` : '';
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R${labelsPart} >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o.replace('@PAGES@', String(pagesObj))}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
