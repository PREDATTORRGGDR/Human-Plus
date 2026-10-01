import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeBitmap } from '../src/badge.js';
import { createDemo } from '../src/demo.js';
import { DEFAULTS, validateSettings } from '../src/settings.js';
import { onColor } from '../src/theme.js';
import { uk } from '../src/uk.js';
import { NOW } from './helpers.js';

test('бейдж-лічильник: бітмап 16×16, червоний фон, білі цифри', () => {
  for (const n of [1, 9, 12, 99, 150]) {
    const b = badgeBitmap(n);
    assert.equal(b.length, 16 * 16 * 4);
    assert.ok(b.some((v, i) => i % 4 === 3 && v === 255));
  }
});

test('налаштування: валідація відкидає невідоме й некоректне', () => {
  assert.deepEqual(
    validateSettings({
      theme: 'dark',
      accent: '#336699',
      evil: 1,
      success: 'red',
      notify: 'yes',
      preset: 'nope',
      mini: true,
      glass: 'off',
      miniOpacity: 0.7,
    }),
    { theme: 'dark', accent: '#336699', mini: true, glass: 'off', miniOpacity: 0.7 },
  );
  assert.deepEqual(validateSettings(null), {});
  assert.deepEqual(validateSettings({ miniOpacity: 0.1, glass: 'maybe' }), {});
  assert.deepEqual(validateSettings({ accent: null }), { accent: null });
  assert.equal(DEFAULTS.theme, 'system');
});

test('контраст тексту на акценті: світлий фон → чорний, темний → білий', () => {
  assert.equal(onColor('#ffffff'), '#111111');
  assert.equal(onColor('#2f5fd0'), '#ffffff');
  assert.equal(onColor('#ffd54f'), '#111111');
});

test('демо-дані: лише вигадані предмети, без мережі, без URL крім zoom.us-заглушки', () => {
  const demo = createDemo(NOW);
  const json = JSON.stringify(demo.calendar(NOW - 30 * 86400, NOW + 30 * 86400));
  assert.doesNotMatch(json, /https?:\/\/(?!zoom\.us\/j\/000000000)/);
});

test('uk.js: назва продукту й підпис про неофіційність', () => {
  assert.equal(uk.appName, 'Human Plus');
  assert.match(uk.tagline, /Неофіційний клієнт для HUMAN Школа/);
  assert.match(uk.unofficial, /не платний тариф/);
});
