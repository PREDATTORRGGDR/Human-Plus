// «Claude за підпискою»: запуск Claude Code CLI на підробленому spawn (справжній CLI тут не запускається).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import {
  classifyCliError,
  cleanEnv,
  createClaudeCodeProvider,
  findClaudeExe,
  replySchema,
  transcript,
} from '../src/ai/providers/claude-code.js';
import { TOOL_DEFS } from '../src/ai/tools.js';
import { tmpDir } from './ai-helpers.js';

/** Підроблений процес: віддає stdout і код виходу, запам'ятовує аргументи, stdin і оточення. */
function fakeSpawn(reply, { code = 0, stderr = '', hang = false } = {}) {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end: (s) => (input = s) };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    calls.push({ exe, args, opts, child, input: () => input });
    if (!hang)
      setImmediate(() => {
        child.stdout.emit('data', typeof reply === 'string' ? reply : JSON.stringify(reply));
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', code);
      });
    return child;
  };
  return { spawn, calls };
}

const req = (over = {}) => ({
  system: 'sys',
  tools: TOOL_DEFS.slice(0, 3),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Що задано?' }] }],
  maxTokens: 100,
  ...over,
});
const ok = (structured) => ({
  type: 'result',
  is_error: false,
  result: '',
  structured_output: structured,
  usage: { input_tokens: 7, output_tokens: 3 },
});

test('Claude Code: безпечний запуск CLI — без інструментів CLI, налаштувань, MCP і сесії; без чужих ключів в оточенні', async () => {
  const { spawn, calls } = fakeSpawn(ok({ reply: 'Привіт!', tool: 'none', tool_args: '{}' }));
  const p = createClaudeCodeProvider({
    exe: 'C:/x/claude.exe',
    spawn,
    tmpDir: tmpDir(),
    env: {
      PATH: 'p',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_BASE_URL: 'https://evil.example.org',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  });
  let streamed = '';
  const r = await p.turn({ ...req(), onText: (d) => (streamed += d) });
  assert.equal(streamed, 'Привіт!');
  assert.deepEqual(r.blocks, [{ type: 'text', text: 'Привіт!' }]);
  assert.equal(r.stopReason, 'end');
  const { args, opts, input } = calls[0];
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(args[0], '-p');
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--model'), 'sonnet');
  assert.ok(
    args.includes('--no-session-persistence') &&
      args.includes('--strict-mcp-config') &&
      args.includes('--disable-slash-commands'),
  );
  assert.match(flag('--system-prompt'), /^sys\n\n.*get_homework/s);
  assert.deepEqual(JSON.parse(flag('--json-schema')).properties.tool.enum, [
    'none',
    'get_schedule',
    'get_homework',
    'get_grades',
  ]);
  assert.deepEqual(Object.keys(opts.env), ['PATH']);
  assert.equal(opts.windowsHide, true);
  assert.ok(opts.cwd.endsWith('human-plus-claude'));
  assert.match(input(), /Учень:\nЩо задано\?/);
});

test('Claude Code: виклик інструмента через структуровану відповідь; зламані аргументи позначено некоректними', async () => {
  const { spawn } = fakeSpawn(
    ok({ reply: 'Дивлюсь', tool: 'get_homework', tool_args: '{"status":"all"}' }),
  );
  const r = await createClaudeCodeProvider({ exe: 'c', spawn, tmpDir: tmpDir() }).turn(req());
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.blocks[1].name, 'get_homework');
  assert.deepEqual(r.blocks[1].input, { status: 'all' });
  const bad = fakeSpawn(ok({ reply: '', tool: 'get_grades', tool_args: '{oops' }));
  const r2 = await createClaudeCodeProvider({ exe: 'c', spawn: bad.spawn, tmpDir: tmpDir() }).turn(
    req(),
  );
  assert.deepEqual(r2.blocks, [
    { type: 'tool_use', id: r2.blocks[0].id, name: 'get_grades', input: { __invalid: true } },
  ]);
});

test('Claude Code: історія з інструментами й зображенням передається текстом', () => {
  const t = transcript([
    { role: 'user', content: [{ type: 'text', text: 'с. 34' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Шукаю' },
        { type: 'tool_use', id: '1', name: 'get_page', input: { book_id: 'b', page: 34 } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: '1',
          name: 'get_page',
          text: '{"text":"..."}',
          image: { mediaType: 'image/jpeg', data: 'AAA' },
        },
      ],
    },
  ]);
  assert.match(
    t,
    /Асистент викликав інструмент get_page з аргументами \{"book_id":"b","page":34\}/,
  );
  assert.match(t, /Результат інструмента get_page:/);
  assert.match(t, /зображення сторінки в режимі підписки недоступне/);
  assert.ok(!t.includes('AAA'));
  assert.equal(replySchema(['a']).additionalProperties, false);
});

test('Claude Code: помилки CLI → коди (не увійшов, ліміт підписки, збій), зупинка вбиває процес', async () => {
  assert.equal(classifyCliError('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyCliError('Claude AI usage limit reached|1760000000'), 'rate_limit');
  assert.equal(classifyCliError('API Error: 529 Overloaded'), 'overloaded');
  assert.equal(classifyCliError('something odd'), 'error');
  const notLogged = fakeSpawn(
    { type: 'result', is_error: true, result: 'Not logged in · Please run /login' },
    { code: 1 },
  );
  await assert.rejects(
    createClaudeCodeProvider({ exe: 'c', spawn: notLogged.spawn, tmpDir: tmpDir() }).turn(req()),
    (e) => e.code === 'auth',
  );
  const garbage = fakeSpawn('not json', { code: 1, stderr: 'usage limit reached' });
  await assert.rejects(
    createClaudeCodeProvider({ exe: 'c', spawn: garbage.spawn, tmpDir: tmpDir() }).turn(req()),
    (e) => e.code === 'rate_limit',
  );
  const hang = fakeSpawn('', { hang: true });
  const ac = new AbortController();
  const pr = createClaudeCodeProvider({ exe: 'c', spawn: hang.spawn, tmpDir: tmpDir() }).turn({
    ...req(),
    signal: ac.signal,
  });
  ac.abort();
  await assert.rejects(pr, (e) => e.code === 'aborted');
  assert.equal(hang.calls[0].child.killed, true);
  assert.throws(
    () => createClaudeCodeProvider({ exe: null, spawn: hang.spawn }),
    (e) => e.code === 'no_key',
  );
  assert.deepEqual(cleanEnv({ a: '1', Anthropic_X: '2', CLAUDECODE: '3' }), { a: '1' });
});

test('пошук claude.exe: нативне встановлення, застосунок Claude (MSIX), PATH', () => {
  const home = 'C:/Users/u';
  const files = new Set();
  const dirs = {};
  const env = {
    USERPROFILE: home,
    APPDATA: 'C:/A',
    LOCALAPPDATA: 'C:/L',
    PATH: ['C:/bin', 'C:/tools'].join(path.delimiter),
  };
  const opts = { env, exists: (p) => files.has(p), readdir: (p) => dirs[p] ?? [] };
  assert.equal(findClaudeExe(opts), null);
  const msix = path.join(
    'C:/L',
    'Packages',
    'Claude_abc',
    'LocalCache',
    'Roaming',
    'Claude',
    'claude-code',
  );
  dirs[path.join('C:/L', 'Packages')] = ['Claude_abc', 'Other'];
  dirs[msix] = ['2.1.0'];
  dirs[path.join(msix, '2.1.0')] = ['x64'];
  files.add(path.join(msix, '2.1.0', 'x64', 'claude.exe'));
  assert.equal(findClaudeExe(opts), path.join(msix, '2.1.0', 'x64', 'claude.exe'));
  const data = path.join('C:/L', 'Claude-Data', 'claude_abc', 'claude-code');
  dirs[path.join('C:/L', 'Claude-Data')] = ['claude_abc'];
  dirs[data] = ['2.1.299'];
  dirs[path.join(data, '2.1.299')] = ['f0'];
  files.add(path.join(data, '2.1.299', 'f0', 'claude.exe'));
  assert.equal(findClaudeExe(opts), path.join(data, '2.1.299', 'f0', 'claude.exe'));
  const native = path.join(
    home,
    '.local',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  files.add(native);
  assert.equal(findClaudeExe(opts), native);
});
