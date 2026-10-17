// Ключі API провайдерів ШІ. Зберігаються лише зашифрованими через safeStorage (DPAPI у Windows).
// У вікно ключ ніколи не передається: лише статус «є / немає» і замаскований хвіст.
import fs from 'node:fs';
import path from 'node:path';
import { AiError } from './errors.js';

export const PROVIDERS = ['anthropic', 'openai', 'gemini'];
const MAX_KEY = 512;

/** «sk-ant-api03-…» → «sk-a…f9k2»; короткі ключі маскуються повністю. */
export function maskKey(key) {
  const k = String(key ?? '');
  if (k.length < 12) return '•'.repeat(Math.min(k.length, 8));
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Прибирає ключі з тексту (повідомлення про помилки, діагностика), навіть якщо їх туди передали випадково. */
export function redactSecrets(text, keys = []) {
  let s = String(text ?? '');
  for (const k of keys) if (k && k.length >= 8) s = s.split(k).join(maskKey(k));
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, (m) => maskKey(m))
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, (m) => maskKey(m))
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, (m) => maskKey(m));
}

/** Перевірка формату перед збереженням: друковані ASCII без пробілів, розумна довжина. */
export const validKey = (k) =>
  typeof k === 'string' && k.length >= 8 && k.length <= MAX_KEY && /^[\x21-\x7e]+$/.test(k);

/**
 * @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} deps
 */
export function createKeyStore({ file, safeStorage }) {
  const read = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  };
  const available = () => {
    try {
      return !!safeStorage?.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  return {
    available,
    set(provider, key) {
      if (!PROVIDERS.includes(provider)) throw new AiError('bad_request', 'provider');
      const k = String(key ?? '').trim();
      if (!validKey(k)) throw new AiError('bad_request', 'key format');
      if (!available()) throw new AiError('storage'); // відкритим текстом не зберігаємо
      const data = read();
      data[provider] = safeStorage.encryptString(k).toString('base64');
      write(data);
    },
    /** Лише для main-процесу (запит до провайдера). */
    get(provider) {
      const enc = read()[provider];
      if (!enc || !available()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        return null;
      }
    },
    clear(provider) {
      const data = read();
      delete data[provider];
      write(data);
    },
    clearAll() {
      fs.rmSync(file, { force: true });
    },
    /** Для вікна: { anthropic: { has: true, masked: 'sk-a…f9k2' }, … } і чи доступне шифрування. */
    status() {
      const out = { encryption: available() };
      for (const p of PROVIDERS) {
        const k = this.get(p);
        out[p] = { has: !!k, masked: k ? maskKey(k) : '' };
      }
      return out;
    },
  };
}
