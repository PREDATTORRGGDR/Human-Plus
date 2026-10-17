// Санітизація HTML від учителів. Білий список тегів; посилання лише https:.
const ALLOWED_TAGS = [
  'p',
  'br',
  'b',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'a',
  'strong',
  'em',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
];
// Для блоку «Таблиця» (ct01) додатково дозволяємо табличні теги; атрибутів у таблиць немає.
const TABLE_TAGS = ['table', 'thead', 'tbody', 'tr', 'th', 'td'];
// Для DOCX (mammoth): ще кілька тегів тексту й <img> лише з data:-зображеннями (SVG тільки так — скрипти в <img> не виконуються).
const DOC_TAGS = ['img', 'sup', 'sub', 's', 'blockquote', 'pre', 'h5', 'h6'];
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

/**
 * @param {{ sanitize: Function, addHook: Function }} purify екземпляр DOMPurify, прив'язаний до window
 * @returns {(html: unknown, opts?: { tables?: boolean }) => string}
 */
export function createSanitizer(purify) {
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (!DATA_IMG.test(src)) node.remove();
      return;
    }
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') || '';
    if (!/^https:\/\//i.test(href)) node.removeAttribute('href');
    node.setAttribute('rel', 'noopener noreferrer');
    node.removeAttribute('target');
  });
  return (html, { tables = false, doc = false } = {}) =>
    purify.sanitize(String(html ?? ''), {
      ALLOWED_TAGS: doc
        ? [...ALLOWED_TAGS, ...TABLE_TAGS, ...DOC_TAGS]
        : tables
          ? [...ALLOWED_TAGS, ...TABLE_TAGS]
          : ALLOWED_TAGS,
      ALLOWED_ATTR: doc ? ['href', 'src', 'alt'] : ['href'],
      ALLOW_DATA_ATTR: false,
      ADD_DATA_URI_TAGS: doc ? ['img'] : [],
    });
}
