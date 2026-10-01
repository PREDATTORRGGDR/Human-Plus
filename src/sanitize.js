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

/**
 * @param {{ sanitize: Function, addHook: Function }} purify екземпляр DOMPurify, прив'язаний до window
 * @returns {(html: unknown, opts?: { tables?: boolean }) => string}
 */
export function createSanitizer(purify) {
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') || '';
    if (!/^https:\/\//i.test(href)) node.removeAttribute('href');
    node.setAttribute('rel', 'noopener noreferrer');
    node.removeAttribute('target');
  });
  return (html, { tables = false } = {}) =>
    purify.sanitize(String(html ?? ''), {
      ALLOWED_TAGS: tables ? [...ALLOWED_TAGS, ...TABLE_TAGS] : ALLOWED_TAGS,
      ALLOWED_ATTR: ['href'],
      ALLOW_DATA_ATTR: false,
    });
}
