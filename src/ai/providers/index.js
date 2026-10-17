// Вибір провайдера за налаштуваннями. Усі провайдери мають однаковий інтерфейс turn() (див. anthropic.js).
import { isAllowedAi } from '../../allowlist.js';
import { AiError } from '../errors.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAiProvider } from './openai.js';

/** fetch, що пропускає лише дозволені хости ШІ (src/allowlist.js) і не передає кук. */
export function guardFetch(fetchImpl, { openaiBase } = {}) {
  return (url, init = {}) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (!isAllowedAi(u, { openaiBase }))
      return Promise.reject(new AiError('bad_request', 'host not allowed'));
    return fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error' });
  };
}

/**
 * @param {{ settings: any, key: string|null, fetch: typeof fetch }} p
 */
export function createProvider({ settings, key, fetch }) {
  if (!key) throw new AiError('no_key');
  const f = guardFetch(fetch, { openaiBase: settings.aiOpenaiBase });
  switch (settings.aiProvider) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey: key, model: settings.aiModelAnthropic, fetch: f });
    case 'openai':
      return createOpenAiProvider({
        apiKey: key,
        model: settings.aiModelOpenai,
        baseUrl: settings.aiOpenaiBase,
        fetch: f,
      });
    case 'gemini':
      return createGeminiProvider({ apiKey: key, model: settings.aiModelGemini, fetch: f });
    default:
      throw new AiError('bad_request', 'provider');
  }
}
