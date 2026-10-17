// Заготовки для тестів асистента: підроблений safeStorage, SSE-відповіді провайдерів, сервіс на демо-даних.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDemo } from '../src/demo.js';
import { createFileCache, createService } from '../src/service.js';
import { NOW } from './helpers.js';

/** «Шифрування» для тестів: оборотне, але не відкритий текст (перевіряємо, що на диску немає ключа). */
export const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
});

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ai-'));

/** Сервіс у демо-режимі (вигадані дані, без мережі), уже в стані ready. */
export async function demoService() {
  const service = createService({
    getUid: async () => 1,
    cache: createFileCache(path.join(tmpDir(), 'c.json')),
    now: () => NOW,
    demo: createDemo(NOW),
  });
  await service.refresh();
  return service;
}

/** Response із потоком server-sent events. */
export function sse(events, { status = 200, headers = {} } = {}) {
  const body = events
    .map(
      (e) =>
        (e.event ? `event: ${e.event}\n` : '') +
        `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test', ...headers },
  });
}

export const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'retry-after-ms': '0',
      'retry-after': '0',
      ...headers,
    },
  });

/** Потік Messages API: текст і (необов'язково) виклик інструмента. */
export function anthropicStream({
  text = '',
  tool = null,
  stop = 'end_turn',
  model = 'claude-sonnet-5-5',
}) {
  const ev = (event, data) => ({ event, data: { type: event, ...data } });
  const out = [
    ev('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }),
  ];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }));
    for (const part of text.match(/.{1,5}/gsu))
      out.push(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: part } }));
    out.push(ev('content_block_stop', { index: i }));
    i++;
  }
  if (tool) {
    out.push(
      ev('content_block_start', {
        index: i,
        content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
      }),
    );
    out.push(
      ev('content_block_delta', {
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) },
      }),
    );
    out.push(ev('content_block_stop', { index: i }));
  }
  out.push(
    ev('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
  );
  out.push(ev('message_stop', {}));
  return sse(out);
}

/** Підроблений провайдер для циклу агента: відповіді за чергою, запам'ятовує запити. */
export function scriptedProvider(script) {
  const calls = [];
  return {
    id: 'fake',
    model: 'fake',
    calls,
    async turn(req) {
      calls.push(
        structuredClone({
          system: req.system,
          messages: req.messages,
          tools: req.tools.map((t) => t.name),
        }),
      );
      const step = script[calls.length - 1] ?? { text: 'ok' };
      if (step.throw) throw step.throw;
      for (const ch of step.text ?? '') req.onText?.(ch);
      const blocks = [
        ...(step.text ? [{ type: 'text', text: step.text }] : []),
        ...(step.tools ?? []).map((t, k) => ({
          type: 'tool_use',
          id: `t${calls.length}-${k}`,
          name: t.name,
          input: t.input ?? {},
        })),
      ];
      return {
        blocks,
        raw: {
          provider: 'fake',
          model: 'fake',
          blocks: [{ type: 'thinking', thinking: 'secret' }, ...blocks],
        },
        stopReason: step.stop ?? (step.tools?.length ? 'tool_use' : 'end'),
        usage: { input: 1, output: 1 },
      };
    },
  };
}
