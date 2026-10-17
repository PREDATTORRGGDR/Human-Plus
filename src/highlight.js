// Проста підсвітка коду й тексту: коментарі, рядки, числа, ключові слова. Лише textContent у <span>, HTML не інтерпретується.
const KEYWORDS = new Set(
  (
    'if else for while do return function def class import from export const let var new public private protected static void int ' +
    'float double bool boolean char string true false null None True False nil and or not in is try catch except finally throw raise ' +
    'switch case break continue struct enum interface package namespace using include with as lambda yield async await begin end then ' +
    'procedure program uses select where insert update delete create table'
  ).split(' '),
);
const COMMENT = {
  c: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`,
  hash: String.raw`#[^\n]*`,
  dash: String.raw`--[^\n]*`,
  semi: String.raw`[;#][^\n]*`,
  percent: String.raw`%[^\n]*`,
  pascal: String.raw`\/\/[^\n]*|\{[^}]*\}|\(\*[\s\S]*?\*\)`,
  json: null,
  plain: null,
};
const MAX = 200_000;

/** @returns {Node[]} */
export function highlight(code, lang = 'plain', doc = document) {
  const src = String(code ?? '');
  const head = src.slice(0, MAX);
  const out = [];
  if (lang === 'plain') {
    out.push(doc.createTextNode(src));
    return out;
  }
  const parts = [
    COMMENT[lang] ? `(${COMMENT[lang]})` : '(\\u0000(?!))',
    String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`)',
    String.raw`(\b\d+(?:\.\d+)?\b)`,
    String.raw`([A-Za-z_][A-Za-z0-9_]*)`,
  ];
  const re = new RegExp(parts.join('|'), 'g');
  let last = 0;
  const span = (cls, text) => {
    const s = doc.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  for (let m; (m = re.exec(head));) {
    if (m.index > last) out.push(doc.createTextNode(head.slice(last, m.index)));
    if (m[1]) out.push(span('hl-c', m[1]));
    else if (m[2]) out.push(span('hl-s', m[2]));
    else if (m[3]) out.push(span('hl-n', m[3]));
    else if (m[4])
      out.push(
        KEYWORDS.has(m[4]) && lang !== 'json' ? span('hl-k', m[4]) : doc.createTextNode(m[4]),
      );
    last = re.lastIndex;
  }
  out.push(doc.createTextNode(head.slice(last) + src.slice(MAX)));
  return out;
}
