// Провайдер Anthropic (Claude) через офіційний SDK. Лише main-процес.
// Адреса задана явно: змінні оточення ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN не мають права перенаправити запит чи ключ.
import Anthropic from '@anthropic-ai/sdk';
import { AiError, codeForStatus, retryAfterSec } from '../errors.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
// Відмова класифікатора безпеки → сервер сам повторює запит на рекомендованій моделі (лише Claude API).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const KNOWN = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

/** Нейтральні повідомлення (src/ai/context.js) → формат Messages API. */
export function toAnthropicMessages(messages, model) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.raw?.provider === 'anthropic' && m.raw.model === model)
      return { role: 'assistant', content: m.raw.blocks }; // поточний цикл інструментів: блоки як є (з міркуваннями)
    const content = m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use')
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      if (b.type === 'tool_result')
        return {
          type: 'tool_result',
          tool_use_id: b.id,
          is_error: !!b.isError,
          content: [
            { type: 'text', text: b.text || '(порожньо)' },
            ...(b.image
              ? [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: b.image.mediaType, data: b.image.data },
                  },
                ]
              : []),
          ],
        };
      return { type: 'text', text: '' };
    });
    return { role: m.role, content };
  });
}

/**
 * Блоки відповіді для повторної відправки в тому ж циклі інструментів. Після переходу на запасну модель посеред відповіді
 * блоки до останнього `fallback` лишаються лише текстовими (так вимагає API); невідомі типи відкидаємо.
 */
export function echoBlocks(content) {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  return content
    .filter((b, i) => (i < last ? b.type === 'text' : KNOWN.has(b.type)))
    .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b));
}

const STOP = {
  end_turn: 'end',
  stop_sequence: 'end',
  pause_turn: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

export function mapAnthropicError(e) {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError')
    return new AiError('aborted');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('network');
  if (e instanceof Anthropic.APIError && e.status)
    return new AiError(codeForStatus(e.status), `anthropic ${e.status}`, {
      status: e.status,
      retryAfter: retryAfterSec(e.headers?.get?.('retry-after')),
    });
  // Помилка в потоці (event: error), напр. overloaded_error після початку відповіді.
  const type = e?.error?.type ?? e?.error?.error?.type;
  if (type === 'overloaded_error') return new AiError('overloaded');
  if (type === 'rate_limit_error') return new AiError('rate_limit');
  return new AiError('error');
}

/**
 * @param {{ apiKey: string, model?: string, fetch?: typeof fetch, effort?: string }} opts
 */
export function createAnthropicProvider({
  apiKey,
  model = ANTHROPIC_DEFAULT_MODEL,
  fetch,
  effort = 'medium',
}) {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE,
    maxRetries: 2, // SDK повторює 408/409/429/5xx і збої з'єднання з урахуванням retry-after
    timeout: 120_000,
    ...(fetch ? { fetch } : {}),
  });
  return {
    id: 'anthropic',
    model,
    vision: true,
    /**
     * Один запит до моделі з потоковою відповіддю.
     * @returns {Promise<{ blocks: any[], raw: any, stopReason: string, usage: {input:number, output:number} }>}
     */
    async turn({ system, tools, messages, maxTokens, signal, onText }) {
      try {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
              strict: true,
              eager_input_streaming: true, // аргументи перевіряє src/ai/tools.js (validateInput)
            })),
            messages: toAnthropicMessages(messages, model),
            output_config: { effort },
            cache_control: { type: 'ephemeral' },
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
          },
          { signal },
        );
        for await (const ev of stream)
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
            onText?.(ev.delta.text);
        const msg = await stream.finalMessage();
        const echo = echoBlocks(msg.content ?? []);
        const blocks = echo
          .filter((b) => b.type === 'text' || b.type === 'tool_use')
          .map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text }
              : { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} },
          );
        return {
          blocks,
          raw: { provider: 'anthropic', model, blocks: echo },
          stopReason: STOP[msg.stop_reason] ?? 'end',
          usage: { input: msg.usage?.input_tokens ?? 0, output: msg.usage?.output_tokens ?? 0 },
        };
      } catch (e) {
        throw mapAnthropicError(e);
      }
    },
  };
}
