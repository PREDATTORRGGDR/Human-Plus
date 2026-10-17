// Налаштування користувача: значення за замовчуванням і сувора валідація (невідоме відкидаємо).
import { HEX, PRESETS } from './theme.js';

export const DEFAULTS = {
  theme: 'system',
  preset: 'classic',
  accent: null,
  success: null,
  danger: null,
  notify: true,
  mini: false,
  miniOpacity: 1,
  glass: 'auto',
  lastNotifiedDay: 0,
  aiProvider: 'anthropic',
  aiModelAnthropic: 'claude-sonnet-5-5',
  aiModelOpenai: 'gpt-5-mini',
  aiModelGemini: 'gemini-flash-latest',
  aiOpenaiBase: 'https://api.openai.com/v1',
  aiConsent: 0,
  aiPanel: false,
  filesCacheMb: 500,
};

/** Версія тексту згоди: зміниться текст — згоду запитаємо знову. */
export const AI_CONSENT_VERSION = 1;
const MODEL_ID = /^[A-Za-z0-9][\w.:/-]{0,79}$/;
const modelId = (v) => (typeof v === 'string' && MODEL_ID.test(v) ? v : undefined);
/** Адреса OpenAI-сумісного сервісу: лише https, без логіна/пароля, без query. */
export function validBaseUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      v.length <= 200
      ? u.href.replace(/\/+$/, '')
      : undefined;
  } catch {
    return undefined;
  }
}

const hexOrNull = (v) => (v === null || (typeof v === 'string' && HEX.test(v)) ? v : undefined);
const RULES = {
  theme: (v) => (['system', 'light', 'dark'].includes(v) ? v : undefined),
  preset: (v) => (v in PRESETS ? v : undefined),
  accent: hexOrNull,
  success: hexOrNull,
  danger: hexOrNull,
  notify: (v) => (typeof v === 'boolean' ? v : undefined),
  mini: (v) => (typeof v === 'boolean' ? v : undefined),
  miniOpacity: (v) => (typeof v === 'number' && v >= 0.5 && v <= 1 ? v : undefined),
  glass: (v) => (['auto', 'on', 'off'].includes(v) ? v : undefined),
  lastNotifiedDay: (v) => (Number.isFinite(v) ? v : undefined),
  aiProvider: (v) => (['anthropic', 'openai', 'gemini'].includes(v) ? v : undefined),
  aiModelAnthropic: modelId,
  aiModelOpenai: modelId,
  aiModelGemini: modelId,
  aiOpenaiBase: (v) => (typeof v === 'string' ? validBaseUrl(v.trim()) : undefined),
  aiConsent: (v) => (v === 0 || v === AI_CONSENT_VERSION ? v : undefined),
  aiPanel: (v) => (typeof v === 'boolean' ? v : undefined),
  filesCacheMb: (v) => (Number.isInteger(v) && v >= 50 && v <= 5000 ? v : undefined),
};

/** Повертає лише коректні поля з `patch`. */
export function validateSettings(patch) {
  const out = {};
  if (patch && typeof patch === 'object')
    for (const [k, rule] of Object.entries(RULES)) {
      const v = k in patch ? rule(patch[k]) : undefined;
      if (v !== undefined) out[k] = v;
    }
  return out;
}
