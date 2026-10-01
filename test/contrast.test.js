// Автоматична перевірка WCAG AA (≥ 4.5:1) ключових пар кольорів. Токени читаються прямо з style.css.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PRESETS, contrast, ensureContrast, onColor, over } from '../src/theme.js';

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/style.css'), 'utf8');
const parse = (block) =>
  Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  );
const dark = parse(/:root\s*{([^}]*)}/.exec(css)[1]);
const light = {
  ...dark,
  ...parse(/@media \(prefers-color-scheme: light\)\s*{\s*:root\s*{([^}]*)}/.exec(css)[1]),
};
const STATUSES = ['assigned', 'overdue', 'submitted', 'accepted', 'returned', 'unknown'];

for (const [name, t] of Object.entries({ dark, light })) {
  // Найгірший випадок: скло над найсвітлішою (для темної теми) / найтемнішою (для світлої) плямою градієнта.
  const l1 = over('#ffffff', Number(t['glass-a1']), t['bg-hot']);
  const l2 = over('#ffffff', Number(t['glass-a2']), t['bg-hot']);
  const surfaces = {
    'скло L1': l1,
    'скло L2': l2,
    фон: t['bg-0'],
    'суцільна картка': t['solid-1'],
    'суцільна картка 2': t['solid-2'],
  };

  test(`контраст (${name}): основний, другорядний і допоміжний текст ≥ 4.5`, () => {
    for (const [label, bg] of Object.entries(surfaces))
      for (const k of ['text-1', 'text-2', 'text-3'])
        assert.ok(
          contrast(t[k], bg) >= 4.5,
          `${k} на «${label}» ${bg}: ${contrast(t[k], bg).toFixed(2)}`,
        );
  });

  test(`контраст (${name}): текст статусів на їхніх плашках ≥ 4.5`, () => {
    for (const s of STATUSES)
      for (const [label, bg] of Object.entries({ 'скло L1': l1, суцільна: t['solid-1'] })) {
        const badgeBg = over(t[`st-${s}`], 0.16, bg);
        assert.ok(
          contrast(t[`st-${s}-text`], badgeBg) >= 4.5,
          `${s} на «${label}»: ${contrast(t[`st-${s}-text`], badgeBg).toFixed(2)}`,
        );
      }
  });

  test(`контраст (${name}): акцентний текст і посилання ≥ 4.5`, () => {
    for (const [label, bg] of Object.entries(surfaces))
      assert.ok(
        contrast(t['accent-text'], bg) >= 4.5,
        `accent-text на «${label}»: ${contrast(t['accent-text'], bg).toFixed(2)}`,
      );
  });
}

test('текст на акцентних кнопках і вкладках ≥ 4.5 для всіх пресетів', () => {
  for (const [id, p] of Object.entries(PRESETS))
    assert.ok(
      contrast(onColor(p.accent), p.accent) >= 4.5,
      `${id}: ${contrast(onColor(p.accent), p.accent).toFixed(2)}`,
    );
  assert.ok(contrast(dark['on-accent'], dark.accent) >= 4.5);
});

test('довільний акцент: ensureContrast гарантує AA на темному й світлому тлі', () => {
  const panels = ['#3a3d44', '#e8eaee'];
  for (const accent of [
    '#000000',
    '#ffffff',
    '#ffd54f',
    '#2f5fd0',
    '#ff0000',
    '#00ff00',
    '#7c3aed',
    '#808080',
  ])
    for (const bg of panels)
      assert.ok(contrast(ensureContrast(accent, bg), bg) >= 4.5, `${accent} на ${bg}`);
  for (const accent of ['#000000', '#ffffff', '#ffd54f', '#808080'])
    assert.ok(contrast(onColor(accent), accent) >= 4.5, accent);
});

test('contrast(): еталонні значення', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
});
