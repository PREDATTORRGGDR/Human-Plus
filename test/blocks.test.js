import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedMedia, isSafeLink } from '../src/allowlist.js';
import { parseThemeTasks } from '../src/api.js';
import { normalizeBlock, normalizeBlocks, toPublic } from '../src/blocks.js';
import { createClient } from '../src/api.js';
import { createFileCache, createService } from '../src/service.js';
import { NOW, fakeApi, res } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('isSafeLink: публічні https-домени так, решта ні', () => {
  for (const ok of [
    'https://naurok.com.ua/test/join?gamecode=1',
    'https://www.youtube.com/watch?v=x',
    'https://us02web.zoom.us/j/1',
  ])
    assert.equal(isSafeLink(ok), true, ok);
  for (const bad of [
    'http://naurok.com.ua',
    'https://127.0.0.1/x',
    'https://10.0.0.5/',
    'https://localhost/x',
    'https://intranet/x',
    'https://[::1]/',
    'https://user:pass@site.com/',
    'javascript:alert(1)',
    'file:///c:/x',
    'ftp://a.com',
    '',
    null,
    'https://printer.local/',
  ])
    assert.equal(isSafeLink(bad), false, String(bad));
  assert.equal(isSafeLink('https://a.com/' + 'x'.repeat(3000)), false);
});

test('isAllowedMedia: лише files.human.ua', () => {
  assert.equal(isAllowedMedia('https://files.human.ua/images/a.png'), true);
  assert.equal(isAllowedMedia('https://files.human.ua.evil.example/a.png'), false);
  assert.equal(isAllowedMedia('https://lms.human.ua/a.png'), false);
  assert.equal(isAllowedMedia('http://files.human.ua/a.png'), false);
});

test('блоки: усі відомі типи нормалізуються', () => {
  const uid = 42;
  const raw = [
    { type: 'tl01', data: { title: 'Заголовок' } },
    { type: 'tx01', data: { text: '<p>a</p>' } },
    { type: 'tx02', data: { title: 'Назва', text: 'рядок 1\nрядок 2' } },
    { type: 'tx03', data: { linesEditor: [{ text: 'один' }, { content: [{ text: 'два' }] }] } },
    { type: 'ip01', data: { text: 'увага' } },
    { type: 'im01', data: { url: 'https://files.human.ua/images/x.png', text: 'підпис' } },
    {
      type: 'fl01',
      data: { file: { name: 'Конспект', extension: 'pdf', size: 1000, hash: 'abc' } },
    },
    {
      type: 'lk01',
      data: {
        url: 'https://naurok.com.ua/t',
        link: {
          url: 'https://naurok.com.ua/t',
          title: 'Тест',
          description: 'опис',
          image: 'https://i.ytimg.com/x.jpg',
        },
      },
    },
    { type: 'cf01', data: { text: 'x^2' } },
    { type: 'ct01', data: { text: '<table></table>' } },
    { type: 'dv01', data: {} },
    { type: 'qn01', data: {} },
  ];
  const kinds = normalizeBlocks(raw, uid).map((b) => b.kind);
  assert.deepEqual(kinds, [
    'heading',
    'html',
    'text',
    'text',
    'html',
    'image',
    'file',
    'link',
    'formula',
    'table',
    'divider',
    'unsupported',
  ]);
  const [, , tx02, tx03, , , file] = normalizeBlocks(raw, uid);
  assert.equal(tx02.text, 'рядок 1\nрядок 2');
  assert.match(tx03.text, /один[\s\S]*два/);
  assert.equal(file.url, 'https://files.human.ua/42/file/get/abc');
  assert.equal(file.name, 'Конспект.pdf');
});

test('блоки: небезпечні й сторонні адреси не потрапляють у модель', () => {
  assert.equal(
    normalizeBlock({ type: 'im01', data: { url: 'https://evil.example/a.png' } }).kind,
    'unsupported',
  );
  assert.equal(
    normalizeBlock({ type: 'im01', data: { url: 'javascript:alert(1)' } }).kind,
    'unsupported',
  );
  assert.equal(
    normalizeBlock(
      { type: 'fl01', data: { file: { name: 'a', fullUrl: 'https://evil.example/a', hash: 'x' } } },
      1,
    ).kind,
    'unsupported',
  );
  assert.equal(
    normalizeBlock({ type: 'lk01', data: { link: { url: 'javascript:alert(1)', title: 't' } } })
      .url,
    null,
  );
  assert.equal(
    normalizeBlock({ type: 'lk01', data: { link: { url: 'http://a.com', title: 't' } } }).url,
    null,
  );
  for (const junk of [
    null,
    undefined,
    5,
    'x',
    {},
    { type: 5 },
    { type: 'fl01' },
    { type: 'lk01', data: 5 },
  ])
    assert.doesNotThrow(() => normalizeBlock(junk, 1));
  assert.deepEqual(normalizeBlocks('x', 1), []);
});

test('toPublic: вікно не бачить адрес зображень і файлів, лише індекс і домен посилання', () => {
  const pub = toPublic(
    normalizeBlocks(
      [
        { type: 'im01', data: { url: 'https://files.human.ua/images/x.png', text: 'a' } },
        { type: 'fl01', data: { file: { name: 'f', extension: 'pdf', size: 5, hash: 'h' } } },
        { type: 'lk01', data: { link: { url: 'https://www.naurok.com.ua/t', title: 'Т' } } },
      ],
      7,
    ),
  );
  const json = JSON.stringify(pub);
  assert.doesNotMatch(json, /files\.human\.ua|https?:\/\//);
  assert.deepEqual(
    pub.map((b) => b.index),
    [0, 1, 2],
  );
  assert.equal(pub[2].domain, 'naurok.com.ua');
  assert.equal(pub[2].openable, true);
});

test('parseThemeTasks віддає блоки, хеш, updated_at і статус', () => {
  const out = parseThemeTasks(
    {
      home_tasks: [
        {
          id: 1,
          updated_at: 5,
          content: { hash: 'h', blocks: [{ type: 'tx01', data: { text: '<p>a</p>' } }] },
          home_tasks_users: [{ status: 1 }],
        },
        { id: 2 },
        null,
        { id: 'x' },
      ],
    },
    7,
  );
  assert.equal(out[1].blocks[0].html, '<p>a</p>');
  assert.equal(out[1].rawStatus, 1);
  assert.equal(out[1].hash, 'h');
  assert.deepEqual(out[2].blocks, []);
  assert.deepEqual(parseThemeTasks(null, 1), {});
});

function setup(override) {
  const api = fakeApi({ override });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  const client = createClient(api.fn, {
    userAgent: 'HumanPlus/test',
    wait: async () => {},
    retries: 0,
  });
  const service = createService({
    client,
    getUid: async () => 42,
    cache: createFileCache(path.join(dir, 'c.json')),
    now: () => NOW,
  });
  return { api, service, client };
}

/** Завдання, до якого демо додало вказаний тип блоку. */
async function taskWith(service, kind) {
  for (const t of service.getState().snapshot.tasks) {
    const r = await service.getTaskText(t.id);
    const b = r.ok && r.blocks.find((x) => x.kind === kind);
    if (b) return { task: t, block: b };
  }
  return null;
}

test('сервіс: зображення завантажується через main лише з files.human.ua й віддається як data:-URL', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const { service, api } = setup((url) =>
    url.startsWith('https://files.human.ua/')
      ? res(200, null, { 'content-type': 'image/png' })
      : null,
  );
  api.fn.__png = png;
  const withBuf = setup((url) =>
    url.startsWith('https://files.human.ua/')
      ? {
          status: 200,
          ok: true,
          headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
          arrayBuffer: async () => png,
        }
      : null,
  );
  await withBuf.service.refresh();
  const found = await taskWith(withBuf.service, 'image');
  assert.ok(found, 'у демо є завдання із зображенням');
  const r = await withBuf.service.getImage(found.task.id, found.block.index);
  assert.equal(r.ok, true);
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
  assert.ok(
    withBuf.api.calls
      .filter((c) => c.url.includes('files.human.ua'))
      .every((c) => c.method === 'GET'),
  );
  await withBuf.service.getImage(found.task.id, found.block.index);
  assert.equal(
    withBuf.api.calls.filter((c) => c.url.includes('files.human.ua')).length,
    1,
    'вдруге — з пам’яті',
  );
  void service;
});

test('сервіс: не-зображення (SVG, HTML) не віддаються як зображення; невідомий індекс — відмова', async () => {
  const bad = {
    status: 200,
    ok: true,
    headers: { get: (k) => (k === 'content-type' ? 'image/svg+xml' : null) },
    arrayBuffer: async () => Buffer.from('<svg onload=alert(1)/>'),
  };
  const { service } = setup((url) => (url.startsWith('https://files.human.ua/') ? bad : null));
  await service.refresh();
  const found = await taskWith(service, 'image');
  assert.equal((await service.getImage(found.task.id, found.block.index)).reason, 'type');
  assert.equal((await service.getImage(found.task.id, 999)).ok, false);
  assert.equal((await service.getImage(found.task.id, 0)).ok, false, 'блок 0 — не зображення');
});

test('сервіс: посилання віддається лише для блоку-посилання, а файл — лише для fl01', async () => {
  const { service } = setup();
  await service.refresh();
  const link = await taskWith(service, 'link');
  assert.equal(service.getLink(link.task.id, link.block.index), 'https://www.example.org/trainer');
  assert.equal(service.getLink(link.task.id, 0), null);
  assert.equal((await service.getFile(link.task.id, link.block.index)).ok, false);
});
