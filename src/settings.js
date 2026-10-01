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
};

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
