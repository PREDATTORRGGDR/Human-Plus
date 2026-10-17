// Класифікація файлів за розширенням: що з файлом робити у вікні. Файли з HUMAN і від учня недовірені:
// усе, що не в білому списку, — «other» (лише зберегти або показати в папці, з попередженням).

const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus'],
  pdf: ['pdf'],
  docx: ['docx'],
  sheet: ['xlsx'],
  csv: ['csv'],
  pptx: ['pptx'],
  text: ['txt', 'md', 'json', 'log', 'ini', 'yaml', 'yml', 'xml', 'tex'],
  code: [
    'py',
    'java',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'ts',
    'go',
    'rs',
    'kt',
    'swift',
    'rb',
    'php',
    'sql',
    'pas',
    'css',
    'scss',
    'lua',
    'r',
  ],
  zip: ['zip'],
};

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
};

/** Мова підсвітки для коду й тексту (лише для вибору правил коментарів). */
const LANG = {
  py: 'hash',
  rb: 'hash',
  yaml: 'hash',
  yml: 'hash',
  r: 'hash',
  ini: 'semi',
  sql: 'dash',
  lua: 'dash',
  json: 'json',
  md: 'plain',
  txt: 'plain',
  log: 'plain',
  tex: 'percent',
  pas: 'pascal',
};

export const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim());
  return m ? m[1].toLowerCase() : '';
};

/**
 * @returns {{ kind: 'image'|'video'|'audio'|'pdf'|'docx'|'sheet'|'csv'|'pptx'|'text'|'code'|'zip'|'other', ext: string, mime: string, lang: string }}
 */
export function classifyFile(name) {
  const ext = extOf(name);
  // Подвійні розширення на кшталт «звіт.pdf.exe» визначаються за останнім: це програма, а не PDF.
  const kind = Object.entries(KINDS).find(([, list]) => list.includes(ext))?.[0] ?? 'other';
  return {
    kind,
    ext,
    mime: MIME[ext] ?? 'application/octet-stream',
    lang: LANG[ext] ?? (kind === 'code' ? 'c' : 'plain'),
  };
}

/** Що можна віддавати вікну через протокол hp-file (потокове відтворення й зображення). */
export const STREAMABLE = new Set(['image', 'video', 'audio']);

/** Безпечне ім'я файлу для диска: без керівних символів і символів, заборонених у Windows. */
export function safeName(name, fallback = 'файл') {
  const clean = Array.from(String(name ?? ''), (c) =>
    c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c,
  )
    .join('')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean) || !clean ? fallback : clean;
}
