// OpenAI-сумісний провайдер (Chat Completions зі стрімінгом). Адреса — api.openai.com або https-хост,
// який учень указав сам (перевіряє guardFetch / isAllowedAi). Лише main-процес.
import { AiError } from '../errors.js';
import { parseArgs, postJson, sseEvents } from './http.js';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';

/** Нейтральні повідомлення → messages Chat Completions. Зображення з результатів інструментів ідуть окремим user-повідомленням. */
export function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const calls = m.content.filter((b) => b.type === 'tool_use');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    const images = [];
    const texts = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.id, content: b.text || '(порожньо)' });
        if (b.image) images.push(b.image);
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    if (images.length)
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Зображення сторінки до результату інструмента.' },
          ...images.map((i) => ({
            type: 'image_url',
            image_url: { url: `data:${i.mediaType};base64,${i.data}` },
          })),
        ],
      });
  }
  return out;
}

const FINISH = {
  stop: 'end',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/**
 * @param {{ apiKey: string, model?: string, baseUrl?: string, fetch: typeof fetch, sleep?: Function }} opts
 */
export function createOpenAiProvider({
  apiKey,
  model = OPENAI_DEFAULT_MODEL,
  baseUrl = OPENAI_DEFAULT_BASE,
  fetch,
  sleep,
}) {
  const base = String(baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const official = /^https:\/\/api\.openai\.com\//.test(base + '/');
  return {
    id: 'openai',
    model,
    vision: true,
    async turn({ system, tools, messages, maxTokens, signal, onText }) {
      const res = await postJson({
        fetch,
        sleep,
        signal,
        url: `${base}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          model,
          stream: true,
          ...(official
            ? { stream_options: { include_usage: true }, max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens }),
          messages: toOpenAiMessages(system, messages),
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          tool_choice: 'auto',
        },
      });
      let text = '';
      let finish = null;
      let refused = false;
      const calls = [];
      const usage = { input: 0, output: 0 };
      for await (const ev of sseEvents(res, signal)) {
        if (ev.error) throw new AiError('server');
        if (ev.usage) {
          usage.input = ev.usage.prompt_tokens ?? 0;
          usage.output = ev.usage.completion_tokens ?? 0;
        }
        const ch = ev.choices?.[0];
        if (!ch) continue;
        const d = ch.delta ?? {};
        if (d.refusal) refused = true;
        if (typeof d.content === 'string' && d.content) {
          text += d.content;
          onText?.(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
      const toolBlocks = calls
        .filter(Boolean)
        .map((c, k) => ({
          type: 'tool_use',
          id: c.id || `call_${k}`,
          name: c.name,
          input: parseArgs(c.args),
        }));
      const stopReason = refused
        ? 'refusal'
        : (FINISH[finish] ?? (toolBlocks.length ? 'tool_use' : 'end'));
      return {
        blocks: [...(text ? [{ type: 'text', text }] : []), ...toolBlocks],
        raw: null,
        stopReason,
        usage,
      };
    },
  };
}
