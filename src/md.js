// Мінімальний Markdown відповіді моделі → DOM. Лише textContent і створення елементів: HTML з відповіді не інтерпретується.
// Підтримка: абзаци, заголовки (#), списки (-, *, •, 1.), **жирний**, *курсив*, `код`, блоки ``` ```.

/** Рядок з інлайн-розміткою → масив вузлів. */
export function inline(text, doc = document) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|__([^_]+)__)/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) out.push(doc.createTextNode(text.slice(last, m.index)));
    const el = doc.createElement(m[2] || m[5] ? 'strong' : m[3] ? 'code' : 'em');
    el.textContent = m[2] ?? m[3] ?? m[4] ?? m[5];
    out.push(el);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(doc.createTextNode(text.slice(last)));
  return out;
}

/** Увесь текст → фрагмент документа. */
export function renderMarkdown(text, doc = document) {
  const frag = doc.createDocumentFragment();
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let list = null;
  let para = null;
  const el = (tag, kids = []) => {
    const e = doc.createElement(tag);
    e.append(...kids);
    return e;
  };
  const flush = () => {
    list = null;
    para = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = el('pre', [el('code', [doc.createTextNode(code.join('\n'))])]);
      pre.className = 'md-code';
      frag.append(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      flush();
      frag.append(el(`h${Math.min(4, hd[1].length + 2)}`, inline(hd[2], doc)));
      continue;
    }
    const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      para = null;
      const tag = li[2] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el(tag);
        if (li[2] && li[2] !== '1') list.setAttribute('start', li[2]);
        frag.append(list);
      }
      list.append(el('li', inline(li[3], doc)));
      continue;
    }
    list = null;
    if (para) para.append(el('br'), ...inline(line, doc));
    else {
      para = el('p', inline(line, doc));
      frag.append(para);
    }
  }
  return frag;
}
