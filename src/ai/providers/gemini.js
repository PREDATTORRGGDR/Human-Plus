// Провайдер Gemini (Google, generateContent зі стрімінгом SSE). Лише main-процес, ключ у заголовку x-goog-api-key.
import { AiError, codeForStatus } from '../errors.js';
import { parseArgs, postJson, sseEvents } from './http.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const BLOCKED = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
]);

/** JSON Schema інструмента → підмножина OpenAPI, яку приймає Gemini (без additionalProperties). */
export function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s))
    if (k !== 'additionalProperties') out[k] = geminiSchema(v);
  return out;
}

/** Нейтральні повідомлення → contents. Поточний цикл інструментів іде з сирими частинами (thoughtSignature). */
export function toGeminiContents(messages, model) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      if (m.raw?.provider === 'gemini' && m.raw.model === model)
        return { role: 'model', parts: m.raw.parts };
      return {
        role: 'model',
        parts: m.content.map((b) =>
          b.type === 'text'
            ? { text: b.text }
            : { functionCall: { name: b.name, args: b.input ?? {} } },
        ),
      };
    }
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'tool_result') {
        parts.push({
          functionResponse: {
            ...(String(b.id).startsWith('g-') ? {} : { id: b.id }),
            name: b.name,
            response: { content: b.text || '(порожньо)' },
          },
        });
        if (b.image)
          parts.push({ inlineData: { mimeType: b.image.mediaType, data: b.image.data } });
      }
    }
    return { role: 'user', parts };
  });
}

/** Недійсний ключ Gemini повертає 400 INVALID_ARGUMENT з причиною API_KEY_INVALID. */
export function classifyGemini(status, body) {
  const reasons = JSON.stringify(body?.error?.details ?? '');
  if (
    /API_KEY_INVALID|API_KEY_EXPIRED/.test(reasons) ||
    body?.error?.status === 'PERMISSION_DENIED'
  )
    return 'auth';
  if (body?.error?.status === 'RESOURCE_EXHAUSTED') return 'rate_limit';
  return codeForStatus(status);
}

/**
 * @param {{ apiKey: string, model?: string, fetch: typeof fetch, sleep?: Function }} opts
 */
export function createGeminiProvider({ apiKey, model = GEMINI_DEFAULT_MODEL, fetch, sleep }) {
  return {
    id: 'gemini',
    model,
    vision: true,
    async turn({ system, tools, messages, maxTokens, signal, onText }) {
      const res = await postJson({
        fetch,
        sleep,
        signal,
        classify: classifyGemini,
        url: `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: toGeminiContents(messages, model),
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: geminiSchema(t.input_schema),
              })),
            },
          ],
          generationConfig: { maxOutputTokens: maxTokens },
        },
      });
      const parts = [];
      let text = '';
      let finish = null;
      let blocked = false;
      const usage = { input: 0, output: 0 };
      let n = 0;
      const calls = [];
      for await (const ev of sseEvents(res, signal)) {
        if (ev.error) throw new AiError(classifyGemini(ev.error.code ?? 500, ev));
        if (ev.promptFeedback?.blockReason) blocked = true;
        if (ev.usageMetadata) {
          usage.input = ev.usageMetadata.promptTokenCount ?? 0;
          usage.output = ev.usageMetadata.candidatesTokenCount ?? 0;
        }
        const c = ev.candidates?.[0];
        if (!c) continue;
        for (const p of c.content?.parts ?? []) {
          parts.push(p);
          if (p.thought) continue; // зведення міркувань не показуємо
          if (typeof p.text === 'string' && p.text) {
            text += p.text;
            onText?.(p.text);
          }
          if (p.functionCall)
            calls.push({
              type: 'tool_use',
              id: p.functionCall.id ?? `g-${Date.now().toString(36)}-${n++}`,
              name: p.functionCall.name,
              input:
                typeof p.functionCall.args === 'string'
                  ? parseArgs(p.functionCall.args)
                  : (p.functionCall.args ?? {}),
            });
        }
        if (c.finishReason) finish = c.finishReason;
      }
      const stopReason =
        blocked || BLOCKED.has(finish)
          ? 'refusal'
          : finish === 'MAX_TOKENS'
            ? 'max_tokens'
            : calls.length
              ? 'tool_use'
              : 'end';
      return {
        blocks: [...(text ? [{ type: 'text', text }] : []), ...calls],
        raw: { provider: 'gemini', model, parts },
        stopReason,
        usage,
      };
    },
  };
}
