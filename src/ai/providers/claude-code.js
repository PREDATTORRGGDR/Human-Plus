// Провайдер «Claude за підпискою»: запускає встановлений у учня Claude Code CLI (`claude -p`) під його власним входом
// (/login у Claude Code), без ключа API. Як у GlowLab Studio: без вбудованих інструментів CLI (--tools ""), без
// налаштувань, хуків і MCP користувача, без збереження сесії, у порожній тимчасовій теці. Наші інструменти
// (розклад, ДЗ, оцінки, книги) модель викликає через структуровану відповідь (--json-schema), цикл веде agent.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiError } from '../errors.js';
import { parseArgs } from './http.js';

export const CLAUDE_CODE_DEFAULT_MODEL = 'sonnet';
const TIMEOUT_MS = 240_000;

/** Де зазвичай лежить claude.exe: нативний інсталятор, десктопний застосунок Claude (MSIX і звичайний), PATH. */
export function findClaudeExe({
  env = process.env,
  exists = fs.existsSync,
  readdir = safeReaddir,
} = {}) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ];
  const nested = (base) =>
    readdir(base)
      .flatMap((v) => readdir(path.join(base, v)).map((a) => path.join(base, v, a, 'claude.exe')))
      .sort()
      .reverse();
  if (env.APPDATA) candidates.push(...nested(path.join(env.APPDATA, 'Claude', 'claude-code')));
  if (env.LOCALAPPDATA)
    // з 17.10.2026 застосунок Claude тримає свій Claude Code у %LOCALAPPDATA%\Claude-Data\claude_*\claude-code
    for (const d of readdir(path.join(env.LOCALAPPDATA, 'Claude-Data')).filter((p) =>
      p.startsWith('claude_'),
    ))
      candidates.push(...nested(path.join(env.LOCALAPPDATA, 'Claude-Data', d, 'claude-code')));
  if (env.LOCALAPPDATA)
    for (const pkg of readdir(path.join(env.LOCALAPPDATA, 'Packages')).filter((p) =>
      p.startsWith('Claude_'),
    ))
      candidates.push(
        ...nested(
          path.join(
            env.LOCALAPPDATA,
            'Packages',
            pkg,
            'LocalCache',
            'Roaming',
            'Claude',
            'claude-code',
          ),
        ),
      );
  for (const dir of String(env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean))
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  return candidates.find((p) => exists(p)) ?? null;
}
function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** Схема відповіді: текст для учня і, за потреби, один виклик нашого інструмента. */
export function replySchema(toolNames) {
  return {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'Текст для учня (може бути порожнім, якщо спершу потрібен інструмент).',
      },
      tool: {
        type: 'string',
        enum: ['none', ...toolNames],
        description: 'Інструмент застосунку або none.',
      },
      tool_args: {
        type: 'string',
        description:
          'Аргументи інструмента як JSON-об’єкт у рядку, напр. {"status":"pending"}; для none — {}.',
      },
    },
    required: ['reply', 'tool', 'tool_args'],
    additionalProperties: false,
  };
}

/** Опис інструментів для системного промпту (у CLI вони не реєструються як справжні інструменти). */
export function toolProtocol(tools) {
  return [
    'Інструменти застосунку викликаються через поля відповіді tool і tool_args (по одному за відповідь).',
    'Коли викликаєш інструмент, reply може бути коротким або порожнім: результат прийде наступним повідомленням.',
    'Коли даних достатньо, постав tool = "none" і дай повну відповідь у reply (Markdown дозволено).',
    'Доступні інструменти:',
    ...tools.map(
      (t) =>
        `- ${t.name}: ${t.description} Аргументи (JSON Schema): ${JSON.stringify(t.input_schema.properties)}; обов’язкові: ${JSON.stringify(t.input_schema.required ?? [])}`,
    ),
  ].join('\n');
}

/** Нейтральна історія → текст для stdin `claude -p` (CLI бачить лише текст, без сирих блоків інших провайдерів). */
export function transcript(messages) {
  const out = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') out.push(`${m.role === 'user' ? 'Учень' : 'Асистент'}:\n${b.text}`);
      else if (b.type === 'tool_use')
        out.push(
          `Асистент викликав інструмент ${b.name} з аргументами ${JSON.stringify(b.input ?? {})}`,
        );
      else if (b.type === 'tool_result')
        out.push(
          `Результат інструмента ${b.name}${b.isError ? ' (помилка)' : ''}:\n${b.text}` +
            (b.image
              ? '\n(зображення сторінки в режимі підписки недоступне: спирайся на текст або попроси учня виділити фрагмент у читачі книг)'
              : ''),
        );
    }
  }
  out.push('Дай наступну відповідь асистента.');
  return out.join('\n\n');
}

/** Помилка CLI → код. Тексти CLI англійською; шукаємо ознаки входу й лімітів. */
export function classifyCliError(text) {
  const s = String(text ?? '').toLowerCase();
  if (/not logged in|please run \/login|invalid api key|oauth|authenticat|login/.test(s))
    return 'auth';
  if (/usage limit|rate limit|limit reached|too many requests|429/.test(s)) return 'rate_limit';
  if (/overloaded|529/.test(s)) return 'overloaded';
  if (/network|econn|enotfound|fetch failed|timed out/.test(s)) return 'network';
  return 'error';
}

/** Змінні оточення без CLAUDE_… та ANTHROPIC_…: CLI має працювати під входом за підпискою, а не з чужими ключами чи адресами. */
export const cleanEnv = (env) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));

/**
 * @param {{ exe: string, model?: string, spawn: typeof import('node:child_process').spawn, tmpDir?: string, env?: Record<string,string> }} opts
 */
export function createClaudeCodeProvider({
  exe,
  model = CLAUDE_CODE_DEFAULT_MODEL,
  spawn,
  tmpDir = os.tmpdir(),
  env = process.env,
}) {
  if (!exe) throw new AiError('no_key', 'claude code not found');
  let seq = 0;
  const workDir = () => {
    const d = path.join(tmpDir, 'human-plus-claude');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  return {
    id: 'claudecode',
    model,
    vision: false,
    async turn({ system, tools, messages, signal, onText }) {
      if (signal?.aborted) throw new AiError('aborted');
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(replySchema(tools.map((t) => t.name))),
        '--model',
        model,
        '--system-prompt',
        `${system}\n\n${toolProtocol(tools)}`,
        '--tools',
        '',
        '--no-session-persistence',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ];
      const { code, stdout, stderr } = await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(exe, args, {
            cwd: workDir(),
            env: cleanEnv(env),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          reject(new AiError('no_key', 'spawn failed'));
          return;
        }
        let out = '';
        let err = '';
        const kill = () => child.kill();
        const timer = setTimeout(
          () => (kill(), reject(new AiError('network', 'timeout'))),
          TIMEOUT_MS,
        );
        signal?.addEventListener(
          'abort',
          () => (kill(), clearTimeout(timer), reject(new AiError('aborted'))),
          { once: true },
        );
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on(
          'error',
          () => (clearTimeout(timer), reject(new AiError('no_key', 'spawn failed'))),
        );
        child.on(
          'close',
          (c) => (clearTimeout(timer), resolve({ code: c, stdout: out, stderr: err })),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(transcript(messages), 'utf8');
      });
      let j;
      try {
        j = JSON.parse(stdout);
      } catch {
        throw new AiError(classifyCliError(stderr || stdout), `cli exit ${code}`);
      }
      if (j.is_error || !j.structured_output)
        throw new AiError(
          classifyCliError(`${j.result ?? ''} ${j.subtype ?? ''} ${stderr}`),
          'cli error',
        );
      const o = j.structured_output;
      const text = typeof o.reply === 'string' ? o.reply : '';
      if (text) onText?.(text);
      const tool = typeof o.tool === 'string' && o.tool !== 'none' ? o.tool : null;
      const blocks = [
        ...(text ? [{ type: 'text', text }] : []),
        ...(tool
          ? [
              {
                type: 'tool_use',
                id: `cc-${Date.now().toString(36)}-${seq++}`,
                name: tool,
                input: parseArgs(o.tool_args),
              },
            ]
          : []),
      ];
      return {
        blocks,
        raw: null,
        stopReason: tool ? 'tool_use' : 'end',
        usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 },
      };
    },
  };
}
