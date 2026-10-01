// Єдине місце, де вирішується, куди застосунок може ходити.
const matches = (host, suffixes) => suffixes.some((d) => host === d || host.endsWith('.' + d));
const HUMAN = ['human.ua'];
// Вхід «через Microsoft» вимагає цих доменів; більше нічого стороннього (аналітика, реклама) не пропускаємо.
const MICROSOFT_LOGIN = [
  'microsoftonline.com',
  'live.com',
  'microsoft.com',
  'msauth.net',
  'msftauth.net',
];
const EXTERNAL = ['zoom.us', 'human.ua', 'meet.google.com', 'teams.microsoft.com'];

const parse = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
};

/** Навігація у вікні входу та мережеві запити сесії Human: https на *.human.ua (+ Microsoft для входу). */
export const isAllowedNavigation = (url) => {
  const h = parse(url);
  return h !== null && matches(h, [...HUMAN, ...MICROSOFT_LOGIN]);
};

/**
 * Запити сесії Human (вікно входу). Сторінка id.human.ua не працює без скриптів Firebase (кнопки виходу в LMS
 * мовчки ламаються), тож пропускаємо лише їх; аналітика, реклама й Sentry лишаються заблокованими.
 */
export const isAllowedLoginRequest = (url) =>
  isAllowedNavigation(url) || url.startsWith('https://www.gstatic.com/firebasejs/');

/** Зображення й файли ДЗ: лише files.human.ua по https. */
export const isAllowedMedia = (url) => parse(url) === 'files.human.ua';

/**
 * Посилання з тексту вчителя відкриваємо в системному браузері лише за кліком користувача. Допускаємо будь-який публічний https-домен,
 * але не IP-адреси, localhost, внутрішні імена, адреси з логіном/паролем і занадто довгі рядки.
 */
export function isSafeLink(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (u.protocol !== 'https:' || u.username || u.password || String(url).length > 2048)
      return false;
    if (
      !h.includes('.') ||
      h.includes(':') ||
      /^\d+(\.\d+){3}$/.test(h) ||
      /(^localhost$|\.local$|\.internal$|\.lan$)/i.test(h)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Запити API: лише api.human.ua. */
export const isAllowedApi = (url) => parse(url) === 'api.human.ua';

/** Локальні вікна застосунку: лише власні файли. Мережа заборонена повністю. */
export const isAllowedUiRequest = (url) => /^(file|devtools):/i.test(url);

/** Зовнішні посилання відкриваємо в системному браузері лише для відомих доменів і https. */
export const isAllowedExternal = (url) => {
  const h = parse(url);
  return h !== null && matches(h, EXTERNAL);
};
