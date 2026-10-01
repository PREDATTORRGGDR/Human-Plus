// Тема й кольори. Світла/темна обирається через nativeTheme (main); тут — акцент, кольори статусів і перевірка контрасту.
export const PRESETS = {
  classic: { name: 'Класична', accent: '#2f5fd0' },
  ocean: { name: 'Океан', accent: '#0b7a8f' },
  forest: { name: 'Ліс', accent: '#2e7d4f' },
  sunset: { name: 'Захід', accent: '#c2410c' },
  grape: { name: 'Виноград', accent: '#7c3aed' },
  graphite: { name: 'Графіт', accent: '#475569' },
};
export const DEFAULT_COLORS = { success: '#2fa66a', danger: '#e5534b' };
export const HEX = /^#[0-9a-f]{6}$/i;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/** Відносна яскравість за WCAG. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Коефіцієнт контрасту двох кольорів (1…21). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Змішування: t — частка кольору `b`. */
export const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

/** Накладає колір із прозорістю `alpha` на непрозорий фон. */
export const over = (fg, alpha, bg) => mix(bg, fg, alpha);

/** Колір тексту на акценті: чорний або білий, що дає більший контраст. */
export const onColor = (hex) =>
  contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111';

/** Підтягує колір до мінімального контрасту (за замовчуванням AA 4.5) із фоном, зсуваючи до білого або чорного. */
export function ensureContrast(fg, bg, min = 4.5) {
  const target = luminance(bg) < 0.4 ? '#ffffff' : '#000000';
  let out = fg;
  for (let i = 0; i < 20 && contrast(out, bg) < min; i++) out = mix(out, target, 0.1);
  return out;
}

// Наближення непрозорого фону під текстом (скло над найсвітлішою плямою градієнта) для підгонки контрасту.
const PANEL = { dark: '#3a3d44', light: '#e8eaee' };

/** Застосовує налаштування кольорів до документа. */
export function applyTheme(settings, root = document.documentElement) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const panel = dark ? PANEL.dark : PANEL.light;
  const accent = HEX.test(settings.accent ?? '')
    ? settings.accent
    : (PRESETS[settings.preset] ?? PRESETS.classic).accent;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--accent', accent);
  set('--on-accent', onColor(accent));
  set('--accent-text', ensureContrast(accent, panel));
  for (const [key, vars] of [
    ['success', ['--st-accepted', '--st-accepted-text']],
    ['danger', ['--st-overdue', '--st-overdue-text', '--st-returned', '--st-returned-text']],
  ]) {
    if (HEX.test(settings[key] ?? '')) {
      const base = settings[key];
      for (const v of vars) set(v, v.endsWith('-text') ? ensureContrast(base, panel) : base);
    } else for (const v of vars) root.style.removeProperty(v);
  }
}
