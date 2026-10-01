// Єдине місце, що знає про ендпоінти Human і форму сирих відповідей.
// Зміниться API — правимо лише цей файл і normalize.js.
import { isAllowedApi, isAllowedMedia } from './allowlist.js';
import { normalizeBlocks } from './blocks.js';

export const API_ORIGIN = 'https://api.human.ua';
export const LMS_ORIGIN = 'https://lms.human.ua';
export const UID_COOKIE = 'last-sub-client-id'; // читабельна кука з id користувача (див. NOTES.md)
const LIMIT = '_limit=987654321';

/** Ролі lmsUser.role_id (взято з коду фронтенду Human). */
export const ROLE = { STUDENT: 2, TEACHER: 3, ADMIN: 7, ADMIN_ALT: 100 };

/** Статуси homeTasksUsers[].status (взято з шаблону календаря Human). */
export const HOME_TASK_USER_STATUS = {
  0: 'assigned',
  1: 'submitted',
  2: 'accepted',
  3: 'returned',
};

/** Категорії students-tasks → наш статус. «Прострочено» рахуємо самі: це «received» із дедлайном у минулому. */
export const STUDENT_TASK_FILTERS = {
  received: 'assigned',
  review: 'submitted',
  approved: 'accepted',
  rejected: 'returned',
};

/** Номер групи розкладу дзвінків за замовчуванням. */
export const DEFAULT_PERIOD_GROUP = 99;

/** Чи ця відповідь system/info однозначно належить учневі. Усе інше — відмова (fail closed). */
export function isStudent(info, uid) {
  const u = info?.lmsUser;
  if (!u || typeof u !== 'object') return false;
  if (u.role_id !== ROLE.STUDENT) return false; // лише число 2, не рядок
  if (u.status !== 1) return false; // лише активний запис
  if (info.parentUser) return false; // вхід батьків
  if (uid != null && String(u.id) !== String(uid)) return false;
  const menu = info.menuSettings;
  if (Array.isArray(menu) && menu.length) {
    if (!menu.some((m) => /^student_/.test(m?.uid ?? ''))) return false;
    if (menu.some((m) => /^(teacher|admin|parent|head)/.test(m?.uid ?? ''))) return false;
  }
  return true;
}

/** Прозорий User-Agent запитів до API: назва, версія, «неофіційний, лише читання», контакт. */
export const buildUserAgent = (version, contact) =>
  `HumanPlus/${version} (unofficial; read-only; ${
    String(contact)
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'no-contact'
  })`; // заголовок HTTP — лише ASCII

/** Побудова URL; усі запити — лише GET. */
export const endpoints = {
  systemInfo: (uid) => `${API_ORIGIN}/v1/${uid}/system/info?${LIMIT}`,
  calendar: (uid, from, to) =>
    `${API_ORIGIN}/v1/${uid}/calendar?dateStart=${from}&dateFinish=${to}&expand=group.subject,webConference,classroom&${LIMIT}`,
  // Завдання ученика за категоріями оригінальної вкладки «Завдання». Єдине надійне джерело статусу (див. NOTES.md).
  studentTasks: (uid, filter) =>
    `${API_ORIGIN}/v1/${uid}/home-task/home-task/students-tasks?expand=group.subject,home_tasks_user.assessment&filter=${filter}&${LIMIT}`,
  theme: (uid, themeId) =>
    `${API_ORIGIN}/v1/${uid}/plan/theme/${themeId}?expand=home_tasks.content,home_tasks.type,lesson_tasks.content,lesson_tasks.type&${LIMIT}`,
};

/** Знеособлена назва ендпоінта для діагностики: /v1/{uid}/plan/theme/{id}. */
export function endpointName(url) {
  try {
    return new URL(url).pathname
      .replace(/\/v1\/\d+\//, '/v1/{uid}/')
      .replace(/\/\d+(?=\/|$)/g, '/{id}');
  } catch {
    return '?';
  }
}

export class SessionExpiredError extends Error {}
export class ApiError extends Error {
  constructor(status, name) {
    super(`HTTP ${status}`);
    this.status = status;
    this.endpoint = name;
  }
}
export class NetworkError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Клієнт API: лише GET, до 4 одночасних запитів, експоненційний backoff із джитером на 429/5xx,
 * повага до Retry-After, лічильник запитів для діагностики.
 * @param {(url: string, init: object) => Promise<Response>} fetchFn fetch із сесією persist:human
 */
export function createClient(
  fetchFn,
  { userAgent, maxParallel = 4, retries = 3, baseDelay = 800, wait = sleep } = {},
) {
  let active = 0;
  const queue = [];
  const stats = { total: 0, byEndpoint: {} };

  const acquire = () =>
    active < maxParallel ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r));
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  const record = (name, status) => {
    stats.total++;
    const e = (stats.byEndpoint[name] ??= { count: 0, statuses: {} });
    e.count++;
    e.statuses[status] = (e.statuses[status] ?? 0) + 1;
  };

  /** Запит із перевіркою хоста, лімітом паралельності, backoff і розбором відповіді `read`. */
  async function run(url, hostOk, accept, read) {
    if (!hostOk(url)) throw new Error('Заборонений хост');
    const name = endpointName(url);
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetchFn(url, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: accept, 'User-Agent': userAgent },
          });
        } catch (e) {
          record(name, 'network');
          stats.lastNetworkError = String(e?.message ?? e)
            .replace(/https?:\/\/\S+/g, '<url>')
            .slice(0, 120); // лише код помилки, без адрес і даних
          if (attempt >= retries) throw new NetworkError('Немає зв’язку');
          await wait(backoff(attempt, baseDelay));
          continue;
        }
        record(name, res.status);
        if (res.status === 401) throw new SessionExpiredError();
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= retries) throw new ApiError(res.status, name);
          const ra = Number(res.headers.get('retry-after'));
          await wait(ra > 0 ? Math.min(ra * 1000, 60000) : backoff(attempt, baseDelay));
          continue;
        }
        if (!res.ok) throw new ApiError(res.status, name);
        try {
          return await read(res);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          throw new ApiError(res.status, name + ' (неочікувана відповідь)');
        }
      }
    } finally {
      release();
    }
  }

  /** @returns {Promise<any>} розібраний JSON */
  const getJson = (url) => run(url, isAllowedApi, 'application/json', (res) => res.json());

  /** Зображення й файли ДЗ з files.human.ua; більше за `maxBytes` не читаємо. @returns {Promise<{ buffer: Buffer, type: string }>} */
  const getBuffer = (url, { maxBytes }) =>
    run(url, isAllowedMedia, '*/*', async (res) => {
      if (Number(res.headers.get('content-length')) > maxBytes)
        throw new ApiError(413, endpointName(url));
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) throw new ApiError(413, endpointName(url));
      return {
        buffer,
        type: String(res.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase(),
      };
    });

  return {
    getJson,
    getBuffer,
    stats,
    resetStats() {
      stats.total = 0;
      stats.byEndpoint = {};
    },
  };
}

/** Експоненційна затримка з повним джитером. */
export function backoff(attempt, base) {
  const cap = Math.min(base * 2 ** attempt, 30000);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

export const fetchSystemInfo = (client, uid) => client.getJson(endpoints.systemInfo(uid));
export const fetchCalendar = (client, uid, from, to) =>
  client.getJson(endpoints.calendar(uid, from, to));
/** Чотири запити паралельно (клієнт обмежує паралельність). */
export const fetchStudentTasks = async (client, uid) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(STUDENT_TASK_FILTERS).map(async (f) => [
        f,
        await client.getJson(endpoints.studentTasks(uid, f)),
      ]),
    ),
  );
export const fetchTheme = (client, uid, themeId) => client.getJson(endpoints.theme(uid, themeId));

/**
 * Витягує з відповіді plan/theme вміст ДЗ і матеріалів уроку: ключ → { updatedAt, hash, blocks, rawStatus }.
 * Ключ ДЗ — id числом, ключ матеріалу уроку (lesson_tasks) — «L» + id, щоб не перетинатись.
 * blocks — нормалізовані (src/blocks.js), із адресами зображень і файлів (їх не віддаємо у вікно).
 */
export function parseThemeTasks(raw, uid) {
  const out = {};
  const list = Array.isArray(raw?.home_tasks) ? raw.home_tasks : [];
  for (const ht of list) {
    if (typeof ht?.id !== 'number') continue;
    const mine = Array.isArray(ht.home_tasks_users) ? ht.home_tasks_users[0] : null;
    out[ht.id] = {
      updatedAt: ht.updated_at ?? 0,
      hash: ht.content?.hash ?? null,
      blocks: normalizeBlocks(ht.content?.blocks, uid),
      rawStatus: typeof mine?.status === 'number' ? mine.status : null,
    };
  }
  for (const lt of Array.isArray(raw?.lesson_tasks) ? raw.lesson_tasks : []) {
    if (typeof lt?.id !== 'number') continue;
    out[`L${lt.id}`] = {
      updatedAt: lt.updated_at ?? 0,
      hash: lt.content?.hash ?? null,
      blocks: normalizeBlocks(lt.content?.blocks, uid),
      rawStatus: null,
    };
  }
  return out;
}
