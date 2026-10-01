import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  isAllowedApi,
  isAllowedExternal,
  isAllowedLoginRequest,
  isAllowedNavigation,
  isAllowedUiRequest,
} from '../src/allowlist.js';

test('навігація: лише https на *.human.ua (і Microsoft для входу)', () => {
  for (const ok of [
    'https://lms.human.ua/app',
    'https://id.human.ua/auth/login',
    'https://api.human.ua/v1/1/x',
    'https://login.microsoftonline.com/x',
  ])
    assert.equal(isAllowedNavigation(ok), true, ok);
  for (const bad of [
    'http://lms.human.ua',
    'https://human.ua.evil.example',
    'https://evilhuman.ua',
    'https://example.com',
    'file:///c:/x',
    'javascript:alert(1)',
    'not a url',
    '',
    'https://google-analytics.com/collect',
    'https://o1.ingest.sentry.io/api',
  ])
    assert.equal(isAllowedNavigation(bad), false, bad);
});

test('вікно входу: додатково лише скрипти Firebase; реклама й аналітика заблоковані', () => {
  assert.equal(
    isAllowedLoginRequest('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js'),
    true,
  );
  assert.equal(isAllowedLoginRequest('https://www.gstatic.com/other.js'), false);
  assert.equal(isAllowedLoginRequest('https://www.googletagmanager.com/gtm.js'), false);
});

test('API: лише api.human.ua; локальні вікна: лише file/devtools', () => {
  assert.equal(isAllowedApi('https://api.human.ua/v1/1/calendar'), true);
  assert.equal(isAllowedApi('https://lms.human.ua/'), false);
  assert.equal(isAllowedApi('http://api.human.ua/'), false);
  assert.equal(isAllowedUiRequest('file:///app/src/index.html'), true);
  assert.equal(isAllowedUiRequest('https://human.ua/'), false);
  assert.equal(isAllowedUiRequest('http://localhost/'), false);
});

test('зовнішні посилання: allowlist доменів і https', () => {
  assert.equal(isAllowedExternal('https://us02web.zoom.us/j/123'), true);
  assert.equal(isAllowedExternal('https://lms.human.ua/lesson/1'), true);
  assert.equal(isAllowedExternal('http://zoom.us/j/1'), false);
  assert.equal(isAllowedExternal('https://zoom.us.evil.example/'), false);
  assert.equal(isAllowedExternal('javascript:alert(1)'), false);
  assert.equal(isAllowedExternal('file:///c:/windows/system32/calc.exe'), false);
});

// Статична перевірка: у коді та CSP немає звернень до сторонніх доменів.
test('у джерелах немає URL-літералів на сторонні домени, а CSP забороняє мережу', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    'main.js',
    'preload.cjs',
    ...fs.readdirSync(path.join(root, 'src')).map((f) => 'src/' + f),
  ].filter((f) => /\.(js|cjs|html|css)$/.test(f));
  const allowed =
    /^(([a-z0-9-]+\.)*human\.ua|zoom\.us|www\.gstatic\.com|meet\.google\.com|teams\.microsoft\.com|www\.w3\.org|login\.microsoftonline\.com|(www\.)?example\.org)$/;
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))
      assert.match(m[1], allowed, `${f}: ${m[0]}`);
  }
  for (const page of ['index.html']) {
    const html = fs.readFileSync(path.join(root, 'src', page), 'utf8');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  }
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const flag of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    'webviewTag: false',
    'allowRunningInsecureContent: false',
  ])
    assert.ok(main.includes(flag), flag);
  assert.doesNotMatch(
    main + fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'),
    /\beval\(|new Function\(/,
  );
});
