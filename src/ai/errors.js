// Помилки асистента: один набір кодів для всіх провайдерів, щоб вікно показувало зрозумілий текст.
export const AI_ERRORS = [
  'no_key', // ключа немає
  'auth', // ключ відхилено (401/403)
  'rate_limit', // 429
  'overloaded', // 529 / 503
  'server', // інші 5xx
  'bad_request', // 400/404/422: модель не існує, запит не прийнято
  'network', // немає зв'язку
  'refusal', // модель відмовилась відповідати
  'consent', // згоди на відправку ще немає
  'not_student', // роль не підтверджено
  'aborted', // зупинено користувачем
  'storage', // safeStorage недоступний
  'error', // інше
];

export class AiError extends Error {
  /** @param {string} code один з AI_ERRORS */
  constructor(code, message = code, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = AI_ERRORS.includes(code) ? code : 'error';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** HTTP-статус провайдера → код помилки. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'error';
}

/** Чи має сенс повторити запит (ліміт, перевантаження, збій сервера, мережа). */
export const retryable = (code) => ['rate_limit', 'overloaded', 'server', 'network'].includes(code);

/** Заголовок retry-after у секундах (число або дата), обмежений 30 с. */
export function retryAfterSec(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  const sec = Number.isFinite(n) ? n : (Date.parse(String(value)) - Date.now()) / 1000;
  return Number.isFinite(sec) ? Math.min(30, Math.max(0, sec)) : null;
}
