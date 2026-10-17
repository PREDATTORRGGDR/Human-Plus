// Спільне для провайдерів без SDK (OpenAI-сумісний, Gemini): POST з повторами й розбір server-sent events.
import { AiError, codeForStatus, retryAfterSec, retryable } from '../errors.js';

const wait = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new AiError('aborted'))), {
      once: true,
    });
  });

/**
 * POST JSON із повторами на 429/5xx/збій мережі (до `retries` разів, з урахуванням retry-after).
 * @param {{ fetch: typeof fetch, url: string, headers: Record<string,string>, body: any, signal?: AbortSignal,
 *   retries?: number, sleep?: (ms:number, signal?:AbortSignal)=>Promise<void>, classify?: (status:number, body:any)=>string }} o
 */
export async function postJson({
  fetch,
  url,
  headers,
  body,
  signal,
  retries = 2,
  sleep = wait,
  classify = null,
}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'aborted')
        throw new AiError('aborted');
      if (e instanceof AiError) throw e;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      throw new AiError('network');
    }
    if (res.ok) return res;
    let errBody = null;
    try {
      errBody = await res.json();
    } catch {
      /* тіло помилки не JSON */
    }
    const code = classify?.(res.status, errBody) ?? codeForStatus(res.status);
    const after = retryAfterSec(res.headers.get('retry-after'));
    if (retryable(code) && attempt < retries) {
      await sleep(after != null ? after * 1000 : 1000 * 2 ** attempt, signal);
      continue;
    }
    // Текст помилки сервісу не показуємо й не логуємо (може містити фрагменти запиту); лише код і статус.
    throw new AiError(code, `http ${res.status}`, { status: res.status, retryAfter: after });
  }
}

/** Події SSE з тіла відповіді: по одному об'єкту на кожен рядок `data:` (рядок `[DONE]` завершує потік). */
export async function* sseEvents(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new AiError('aborted');
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw signal?.aborted ? new AiError('aborted') : new AiError('network');
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          /* пошкоджений рядок пропускаємо */
        }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data && data !== '[DONE]')
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore */
        }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** Аргументи інструмента з JSON-рядка; зіпсований JSON → об'єкт, який відхилить перевірка схеми. */
export function parseArgs(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { __invalid: true };
  } catch {
    return { __invalid: true };
  }
}
