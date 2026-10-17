// Головний процес: єдине вікно, сесія persist:human, меню/трей, IPC, кеш. Перевірка ролі — у src/service.js.
// Додаткових вікон немає: вхід у HUMAN відкривається всередині головного вікна (WebContentsView),
// а міні-режим «Що задано на завтра» — це стан того самого вікна.
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  Notification,
  Tray,
  WebContentsView,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isAllowedExternal,
  isAllowedLoginRequest,
  isAllowedNavigation,
  isAllowedUiRequest,
  isSafeLink,
} from './src/allowlist.js';
import { LMS_ORIGIN, UID_COOKIE, buildUserAgent, createClient } from './src/api.js';
import { badgeBitmap } from './src/badge.js';
import { createDemo } from './src/demo.js';
import { deadlinesOn, pendingCount } from './src/model.js';
import { createFileCache, createService } from './src/service.js';
import { DEFAULTS, validateSettings } from './src/settings.js';
import { addDays, dayStart, plural } from './src/time.js';
import { createAssistant } from './src/ai/agent.js';
import { AiError } from './src/ai/errors.js';
import { PROVIDERS, createKeyStore, redactSecrets } from './src/ai/keys.js';
import { createDemoProvider } from './src/ai/providers/demo.js';
import { createProvider } from './src/ai/providers/index.js';
import { createTools } from './src/ai/tools.js';
import { createLibrary } from './src/books/library.js';
import { decodeText } from './src/books/extract.js';
import { parseRef } from './src/books/locate.js';
import { docxToHtml, parseCsv, pptxSlides, xlsxToSheets, zipList } from './src/files/office.js';
import { rangeResponse } from './src/files/range.js';
import { createFileStore } from './src/files/store.js';
import { STREAMABLE, classifyFile, safeName } from './src/files/types.js';
import { AI_CONSENT_VERSION } from './src/settings.js';
import { uk } from './src/uk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const UA = buildUserAgent(pkg.version);
const DEMO = process.argv.includes('--demo');
const PROBE = process.argv.includes('--probe');
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.slice(8);
const UI_BASE = pathToFileURL(path.join(here, 'src') + path.sep).href;
const REFRESH_MS = 12 * 60 * 1000;
const TITLE_H = 44;
// Mica/Acrylic як backgroundMaterial є з Windows 11 22H2 (збірка 22621). Для скриншотів не вмикаємо: вони мають бути відтворюваними.
const WIN_BUILD = Number(process.getSystemVersion().split('.')[2]) || 0;
const HAS_MATERIAL =
  process.platform === 'win32' && WIN_BUILD >= 22621 && !SHOTS && !process.env.HP_NO_MATERIAL;

// UA вікон без імені застосунку: сторінка входу HUMAN шифрує UA через btoa(), який падає на не-Latin1 символах
// (з назвою кирилицею кнопки на id.human.ua мовчки не працювали). Запити до API йдуть із прозорим HumanPlus/… (src/api.js).
const OS_UA =
  { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7' }[
    process.platform
  ] ?? 'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${OS_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36 Electron/${process.versions.electron}`;

app.setAppUserModelId(app.isPackaged ? 'com.humanplus.app' : 'com.humanplus.app.dev'); // значок і група на панелі завдань Windows, сповіщення
if (DEMO) app.setPath('userData', app.getPath('userData') + '-demo'); // демо не торкається справжнього кешу й сесії
if (!app.requestSingleInstanceLock()) app.quit();
// Власний протокол для потокового відтворення відео/аудіо й показу зображень з файлів учня (з підтримкою Range).
protocol.registerSchemesAsPrivileged([
  { scheme: 'hp-file', privileges: { standard: true, secure: true, stream: true } },
]);

let humanSession,
  service,
  settings,
  tray,
  mainWin,
  loginView,
  client,
  keys,
  assistant,
  library,
  files;
let quitting = false;
let gpuOk = true;
let miniSaved = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return {
      ...DEFAULTS,
      ...validateSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))),
    };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings));
}

/** Скло: «авто» вимикається, якщо в ОС вимкнені ефекти прозорості або немає GPU-композитингу; «увімк.» і «вимк.» — вручну. */
function envState() {
  const glass =
    settings.glass === 'on'
      ? true
      : settings.glass === 'off'
        ? false
        : !(nativeTheme.prefersReducedTransparency || !gpuOk);
  return { glass, material: HAS_MATERIAL && glass };
}
const settingsPayload = () => ({ ...settings, _env: envState() });
const solidBg = () => (nativeTheme.shouldUseDarkColors ? '#0d1016' : '#edf0f6');

async function getUid() {
  const [c] = await humanSession.cookies.get({ url: LMS_ORIGIN, name: UID_COOKIE });
  return c && /^\d+$/.test(c.value) ? Number(c.value) : null;
}

/** Підлаштовує вікно під тему, матеріал і міні-режим (ОС-матеріал, колір кнопок вікна, фон). */
function applyEnv() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const env = envState();
  const dark = nativeTheme.shouldUseDarkColors;
  mainWin.setTitleBarOverlay?.({
    color: '#00000000',
    symbolColor: dark ? '#eef1f6' : '#131a26',
    height: TITLE_H,
  });
  mainWin.setBackgroundColor(env.material ? '#00000000' : solidBg());
  if (process.platform === 'win32' && HAS_MATERIAL)
    mainWin.setBackgroundMaterial(env.material ? (settings.mini ? 'acrylic' : 'mica') : 'none');
  broadcast('settings:changed', settingsPayload());
}

function createMain() {
  const env = envState();
  mainWin = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: uk.appName,
    icon: path.join(here, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#eef1f6' : '#131a26',
      height: TITLE_H,
    },
    backgroundColor: env.material ? '#00000000' : solidBg(),
    ...(env.material ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  if (process.platform === 'win32')
    mainWin.setIcon(nativeImage.createFromPath(path.join(here, 'build', 'icon.ico'))); // значок кнопки на панелі завдань = той самий, що в шапці й треї
  mainWin.loadFile(path.join(here, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('resize', layoutLogin);
  mainWin.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

/** Міні-режим: те саме вікно стає малим, поверх інших, із регульованою прозорістю. */
function applyMini(on) {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (on) {
    if (mainWin.isFullScreen()) mainWin.setFullScreen(false);
    if (mainWin.isMaximized()) mainWin.unmaximize();
    miniSaved ??= mainWin.getBounds();
    mainWin.setMinimumSize(300, 240);
    mainWin.setSize(380, 560);
    mainWin.setAlwaysOnTop(true, 'floating');
    mainWin.setOpacity(settings.miniOpacity);
  } else {
    mainWin.setAlwaysOnTop(false);
    mainWin.setOpacity(1);
    mainWin.setMinimumSize(360, 480);
    if (miniSaved) mainWin.setBounds(miniSaved);
    else mainWin.setSize(1000, 760);
    miniSaved = null;
  }
  applyEnv();
}

function patchSettings(patch) {
  const clean = validateSettings(patch);
  settings = { ...settings, ...clean };
  saveSettings();
  if ('theme' in clean) nativeTheme.themeSource = settings.theme;
  if ('mini' in clean) applyMini(settings.mini);
  else if ('miniOpacity' in clean && settings.mini) mainWin?.setOpacity(settings.miniOpacity);
  if ('glass' in clean || 'theme' in clean) applyEnv();
  else broadcast('settings:changed', settingsPayload());
  return settingsPayload();
}

const broadcast = (channel, data) => {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed())
    mainWin.webContents.send(channel, data);
};

/* ---------- Вхід усередині головного вікна ---------- */
function layoutLogin() {
  if (!loginView || !mainWin || mainWin.isDestroyed()) return;
  const [width, height] = mainWin.getContentSize();
  loginView.setBounds({ x: 0, y: TITLE_H, width, height: Math.max(0, height - TITLE_H) });
}

function openLogin() {
  if (DEMO || loginView) return;
  if (settings.mini) patchSettings({ mini: false });
  loginView = new WebContentsView({
    webPreferences: {
      session: humanSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  mainWin.contentView.addChildView(loginView);
  layoutLogin();
  service.setLoggingIn(true);
  const check = async (_e, url) => {
    const u = new URL(url);
    if (
      loginView &&
      u.hostname === 'lms.human.ua' &&
      u.pathname.startsWith('/app') &&
      (await getUid()) != null
    ) {
      closeLogin();
      service.refresh();
    }
  };
  loginView.webContents.on('did-navigate', check);
  loginView.webContents.on('did-navigate-in-page', check);
  loginView.webContents.loadURL(LMS_ORIGIN);
}

function closeLogin() {
  if (!loginView) return;
  const v = loginView;
  loginView = null;
  mainWin.contentView.removeChildView(v);
  v.webContents.close();
  service.setLoggingIn(false);
}

async function logout() {
  closeLogin();
  if (!DEMO) {
    await humanSession.clearStorageData();
    await humanSession.clearCache();
    await humanSession.clearAuthCache();
  }
  service.wipe();
  assistant?.reset();
}

const DANGEROUS = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|hta|jar|lnk|reg|dll)$/i;

/** Зберігає файл із ДЗ у «Завантаження» (лише після явного кліку), ніколи не запускає його. */
async function saveFile(taskId, index) {
  const r = await service.getFile(taskId, index);
  if (!r.ok) return { ok: false, reason: r.reason };
  const clean =
    Array.from(r.name, (c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
      .join('')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'файл';
  if (DANGEROUS.test(clean)) return { ok: false, reason: 'blocked' };
  const dir = app.getPath('downloads');
  const { name: base, ext } = path.parse(clean);
  let target = path.join(dir, clean);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  fs.writeFileSync(target, r.buffer);
  shell.showItemInFolder(target);
  return { ok: true, name: path.basename(target) };
}

function diagnostics() {
  const st = service.getState();
  const lines = [
    `${uk.appName} ${pkg.version}`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform} ${os.release()}`,
    `Стан: ${st.status}; офлайн: ${st.offline}; пауза: ${st.paused}; демо: ${st.demo}`,
    `Скло: ${JSON.stringify(envState())}`,
    `Нерозпізнані секції: ${st.snapshot?.partial.join(', ') || 'немає'}`,
    `Нерозпізнані типи блоків: ${service.unsupportedTypes().join(', ') || 'немає'}`,
    `Запитів за останнє оновлення: ${client?.stats.total ?? 0}`,
  ];
  for (const [name, e] of Object.entries(client?.stats.byEndpoint ?? {}))
    lines.push(`  ${name}: ${e.count}× ${JSON.stringify(e.statuses)}`);
  if (keys) {
    const k = keys.status();
    lines.push(
      `Асистент: ${settings.aiProvider}; ключі: ${PROVIDERS.map((p) => `${p}=${k[p].has ? 'є' : 'немає'}`).join(', ')}; шифрування: ${k.encryption}`,
    );
  }
  // Ключі в діагностику не потрапляють навіть випадково.
  return redactSecrets(lines.join('\n'), keys ? PROVIDERS.map((p) => keys.get(p)) : []);
}

function updateBadge(st) {
  const n = st.status === 'ready' && st.snapshot ? pendingCount(st.snapshot) : 0;
  tray?.setToolTip(uk.tray.tooltip(n));
  if (process.platform === 'win32' && mainWin && !mainWin.isDestroyed())
    mainWin.setOverlayIcon(
      n ? nativeImage.createFromBitmap(badgeBitmap(n), { width: 16, height: 16 }) : null,
      n ? uk.tray.tooltip(n) : '',
    );
}

function maybeNotify(st) {
  if (
    !settings.notify ||
    DEMO ||
    st.status !== 'ready' ||
    st.stale ||
    !st.snapshot ||
    !Notification.isSupported()
  )
    return;
  const today = dayStart(st.now);
  if (settings.lastNotifiedDay === today) return;
  const due = deadlinesOn(st.snapshot, addDays(today, 1));
  if (!due.length) return;
  patchSettings({ lastNotifiedDay: today });
  new Notification({
    title: uk.notify.title,
    body: uk.notify.body(
      plural(due.length, uk.plural.task),
      [...new Set(due.map((t) => t.subject))].join(', '),
    ),
  }).show();
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  mainWin.show();
  mainWin.focus();
}

function buildMenu() {
  const m = uk.menu;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: m.file,
        submenu: [
          { label: m.reload, accelerator: 'CmdOrCtrl+R', click: () => service.refresh() },
          {
            label: m.toggleMini,
            accelerator: 'CmdOrCtrl+Shift+H',
            click: () => patchSettings({ mini: !settings.mini }),
          },
          { type: 'separator' },
          { label: m.quit, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: m.edit,
        submenu: [
          { role: 'undo', label: m.undo },
          { role: 'redo', label: m.redo },
          { type: 'separator' },
          { role: 'cut', label: m.cut },
          { role: 'copy', label: m.copy },
          { role: 'paste', label: m.paste },
          { role: 'selectAll', label: m.selectAll },
        ],
      },
      {
        label: m.view,
        submenu: [
          { role: 'zoomIn', label: m.zoomIn },
          { role: 'zoomOut', label: m.zoomOut },
          { role: 'resetZoom', label: m.zoomReset },
          { type: 'separator' },
          { role: 'togglefullscreen', label: m.fullscreen },
        ],
      },
      {
        label: m.help,
        submenu: [
          { label: uk.buttons.about, click: () => mainWin?.webContents.send('ui:about') },
          { label: uk.buttons.report, click: () => clipboard.writeText(diagnostics()) },
        ],
      },
    ]),
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'build', 'tray.png')); // 16 px; tray@2x.png і tray@3x.png підхоплюються за масштабом екрана
  tray = new Tray(icon);
  tray.setToolTip(uk.tray.tooltip(0));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: uk.menu.showWindow, click: showMain },
      { label: uk.menu.toggleMini, click: () => patchSettings({ mini: !settings.mini }) },
      { label: uk.menu.reload, click: () => service.refresh() },
      { type: 'separator' },
      { label: uk.menu.quit, click: () => app.quit() },
    ]),
  );
  tray.on('click', showMain);
}

/** Захисні рубежі: жодних сторонніх хостів, дозволів, нових вікон і webview. */
function hardenSessions() {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !isAllowedUiRequest(d.url) }),
  );
  humanSession.webRequest.onBeforeRequest((d, cb) => {
    const cancel =
      DEMO ||
      !(isAllowedLoginRequest(d.url) || isAllowedUiRequest(d.url) || /^(data|blob):/.test(d.url));
    if (cancel && process.env.HD_LOG_BLOCKED)
      console.log('BLOCKED', d.url.split('?')[0].slice(0, 120));
    cb({ cancel });
  });
  for (const s of [session.defaultSession, humanSession]) {
    s.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
  }
  try {
    session.defaultSession.setSpellCheckerLanguages(['uk']);
  } catch {
    /* словник недоступний */
  }
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // Нових вікон не створюємо. Сторінка входу, що «відкриває вкладку» на *.human.ua (вибір закладу), переходить у тому ж вигляді.
    wc.setWindowOpenHandler(({ url }) => {
      if (process.env.HD_LOG_BLOCKED) console.log('OPEN', url.split('?')[0].slice(0, 120));
      if (!wc.getURL().startsWith(UI_BASE) && isAllowedNavigation(url))
        setImmediate(() => wc.loadURL(url));
      else if (isAllowedExternal(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      const own = wc.getURL().startsWith(UI_BASE);
      if (own ? !url.startsWith(UI_BASE) : !isAllowedNavigation(url)) {
        if (process.env.HD_LOG_BLOCKED)
          console.log('WILL-NAV BLOCKED', url.split('?')[0].slice(0, 120));
        e.preventDefault();
      }
    });
  });
}

/* ---------- Асистент (src/ai/) ---------- */
function jsonStore(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    },
  };
}

function aiStatus() {
  const k = keys.status();
  return {
    keys: k,
    provider: settings.aiProvider,
    ready: DEMO || !!k[settings.aiProvider]?.has,
    consent: settings.aiConsent === AI_CONSENT_VERSION,
    demo: DEMO,
    busy: assistant.busy(),
  };
}

/* ---------- Книги (src/books/) ---------- */
const renders = new Map(); // reqId → resolve: сторінку-скан для моделі малює вікно (pdfjs), main лише чекає
let renderSeq = 0;
function renderPageInWindow(bookId, index) {
  if (!mainWin || mainWin.isDestroyed()) return Promise.resolve(null);
  const reqId = ++renderSeq;
  return new Promise((resolve) => {
    const t = setTimeout(() => (renders.delete(reqId), resolve(null)), 20000);
    renders.set(reqId, (img) => (clearTimeout(t), renders.delete(reqId), resolve(img)));
    broadcast('books:render', { reqId, bookId, index });
  });
}

const PDFJS_DIR = path.join(here, 'node_modules', 'pdfjs-dist');
const PDF_ASSET_DIRS = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts' };

function setupLibrary() {
  library = createLibrary({
    dir: path.join(app.getPath('userData'), 'books'),
    renderPage: renderPageInWindow,
  });
}

/** Фрагменти, які учень виділив у читачі: назву й номер сторінки бере main із бібліотеки, текст обрізається. */
function cleanFragments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 10)
    .map((f) => {
      const b = library.get(f?.bookId);
      if (!b || !Number.isInteger(f.index) || typeof f.text !== 'string' || !f.text.trim())
        return null;
      return {
        title: b.title,
        printed: library.pageText(b.id, f.index)?.printed ?? null,
        text: f.text.slice(0, 4000),
      };
    })
    .filter(Boolean);
}

/* ---------- Файли (src/files/) ---------- */
function setupFiles() {
  files = createFileStore({
    dir: path.join(app.getPath('userData'), 'files'),
    cacheLimit: () => settings.filesCacheMb * 1024 * 1024,
  });
  // hp-file://f/<id>: лише зображення, відео й аудіо, лише відомі id, лише для вікна застосунку.
  protocol.handle('hp-file', async (req) => {
    try {
      const u = new URL(req.url);
      const id = u.pathname.replace(/^\//, '');
      const f = u.hostname === 'f' ? files.get(id) : null;
      const info = f ? classifyFile(f.name) : null;
      if (!f || !STREAMABLE.has(info.kind)) return new Response(null, { status: 404 });
      const file = files.pathOf(id);
      const size = fs.statSync(file).size;
      const r = rangeResponse(size, req.headers.get('range'), info.mime);
      if (r.status === 416) return new Response(null, { status: 416, headers: r.headers });
      const stream = Readable.toWeb(fs.createReadStream(file, { start: r.start, end: r.end }));
      return new Response(stream, { status: r.status, headers: r.headers });
    } catch {
      return new Response(null, { status: 500 });
    }
  });
}

const TEXT_MAX = 2 * 1024 * 1024;
/** Вміст файлу для перегляду у вікні, безпечний за побудовою (текст, таблиці, санітизований далі HTML). */
async function fileContent(id) {
  const f = files.get(id);
  if (!f) return null;
  const read = () => files.read(id);
  try {
    switch (f.kind) {
      case 'text':
      case 'code': {
        const b = files.read(id, 50 * 1024 * 1024);
        if (!b) return { error: 'big' };
        const text = decodeText(b.subarray(0, TEXT_MAX));
        return { text, truncated: b.length > TEXT_MAX };
      }
      case 'docx':
        return { html: await docxToHtml(read()) };
      case 'sheet':
        return { sheets: await xlsxToSheets(read()) };
      case 'csv':
        return { rows: parseCsv(decodeText(files.read(id, 50 * 1024 * 1024) ?? Buffer.alloc(0))) };
      case 'pptx':
        return { slides: await pptxSlides(read()) };
      case 'zip':
        return { entries: await zipList(read()) };
      case 'pdf': {
        const b = read();
        return b ? { bytes: new Uint8Array(b) } : { error: 'big' };
      }
      default:
        return {};
    }
  } catch {
    return { error: 'parse' };
  }
}

/** Копія в «Завантаження» з унікальним ім'ям (файл не запускається). */
function copyToDownloads(id) {
  const f = files.get(id);
  const src = files.pathOf(id);
  if (!f || !src) return null;
  const dir = app.getPath('downloads');
  const { name: base, ext } = path.parse(safeName(f.name));
  let target = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  fs.copyFileSync(src, target);
  return target;
}

function setupAssistant(books = null) {
  keys = createKeyStore({ file: path.join(app.getPath('userData'), 'keys.json'), safeStorage });
  const getProvider = () => {
    const key = keys.get(settings.aiProvider);
    if (DEMO && !key) return createDemoProvider();
    return createProvider({ settings, key, fetch: globalThis.fetch });
  };
  assistant = createAssistant({
    getProvider,
    verifyStudent: () => service.verifyStudent(),
    tools: createTools({ service, books }),
    service,
    store: jsonStore(path.join(app.getPath('userData'), 'assistant.json')),
    hasConsent: () => settings.aiConsent === AI_CONSENT_VERSION,
    emit: (ev) => broadcast('ai:event', ev),
  });
}

/** Ключ вмісту: id завдання (число) або матеріалу уроку («L123»). */
const validKey = (k) => Number.isInteger(k) || (typeof k === 'string' && /^L\d+$/.test(k));

function registerIpc() {
  const guard =
    (fn) =>
    (e, ...a) =>
      e.senderFrame?.url?.startsWith(UI_BASE) ? fn(...a) : null;
  const handle = (ch, fn) => ipcMain.handle(ch, guard(fn));
  handle('state:get', () => service.getState());
  handle('state:refresh', async () => {
    service.resume();
    await service.refresh();
    return service.getState();
  });
  handle('task:text', (key) => (validKey(key) ? service.getTaskText(key) : null));
  handle('week:get', (start) => (Number.isFinite(start) ? service.getWeek(start) : null));
  handle('session:login', openLogin);
  handle('login:cancel', () => {
    closeLogin();
    service.refresh();
  });
  handle('session:logout', logout);
  // Посилання з тексту ДЗ і кнопка Zoom: лише за кліком, лише безпечні https-адреси (src/allowlist.js).
  handle('open:external', (url) =>
    typeof url === 'string' && (isAllowedExternal(url) || isSafeLink(url))
      ? shell.openExternal(url)
      : null,
  );
  handle('media:image', (key, index) =>
    validKey(key) && Number.isInteger(index) ? service.getImage(key, index) : null,
  );
  handle('media:save', (key, index) =>
    validKey(key) && Number.isInteger(index) ? saveFile(key, index) : null,
  );
  handle('link:open', (taskId, index) => {
    const url = validKey(taskId) && Number.isInteger(index) ? service.getLink(taskId, index) : null;
    return url && isSafeLink(url) ? shell.openExternal(url) : null;
  });
  handle('settings:get', () => settingsPayload());
  handle('settings:set', (patch) => patchSettings(patch));
  handle('mini:toggle', () => patchSettings({ mini: !settings.mini }));
  handle('report:copy', () => {
    const t = diagnostics();
    clipboard.writeText(t);
    return t;
  });
  // Асистент: ключ іде лише у вікно → main (зберегти), назад повертається тільки статус «є / немає».
  handle('ai:status', () => aiStatus());
  handle('ai:setKey', (provider, key) => {
    if (!PROVIDERS.includes(provider) || typeof key !== 'string')
      return { ok: false, code: 'bad_request' };
    try {
      keys.set(provider, key);
      return { ok: true, status: aiStatus() };
    } catch (e) {
      return { ok: false, code: e instanceof AiError ? e.code : 'error' };
    }
  });
  handle('ai:clearKey', (provider) => {
    if (PROVIDERS.includes(provider)) keys.clear(provider);
    return aiStatus();
  });
  handle('ai:consent', (yes) => {
    patchSettings({ aiConsent: yes === true ? AI_CONSENT_VERSION : 0 });
    return aiStatus();
  });
  handle('ai:send', (req) => {
    const r = req && typeof req === 'object' ? req : {};
    const text = typeof r.text === 'string' ? r.text.slice(0, 8000) : '';
    const mode = ['chat', 'explain', 'notebook'].includes(r.mode) ? r.mode : 'chat';
    const taskId = Number.isInteger(r.taskId) ? r.taskId : null;
    return assistant.send({ text, mode, taskId, fragments: cleanFragments(r.fragments) });
  });
  // Книги: файли обирає учень у системному діалозі; вікно шляхів не передає.
  // Файли: вікно оперує лише id; шляхи, читання й запис — тут.
  handle('files:list', () => ({
    mine: files.list('mine'),
    cached: files.list('human'),
    attachments: service.listAttachments().map((a) => ({ ...a, kind: classifyFile(a.name).kind })),
    usage: files.usage(),
  }));
  handle('files:import', async () => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: uk.files.importTitle,
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : files.importFiles(res.filePaths);
  });
  /** Файл із завдання HUMAN: з кешу або завантаження з files.human.ua (через service → api.js, allowlist). */
  handle('files:fromTask', async (key, index) => {
    if (!validKey(key) || !Number.isInteger(index)) return { ok: false, reason: 'unknown' };
    const att = service.listAttachments().find((a) => a.taskId === key && a.index === index);
    const cacheKey = `${key}:${index}:${att?.updatedAt ?? 0}`;
    const hit = files.cached(cacheKey);
    if (hit) return { ok: true, file: hit };
    const r = await service.getFile(key, index);
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, file: files.putHuman(cacheKey, r.name, r.buffer) };
  });
  handle('files:content', (id) => fileContent(id));
  handle('files:save', async (id) => {
    const f = files.get(id);
    if (!f) return { ok: false };
    const res = await dialog.showSaveDialog(mainWin, {
      defaultPath: path.join(app.getPath('downloads'), safeName(f.name)),
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.copyFileSync(files.pathOf(id), res.filePath);
    return { ok: true, name: path.basename(res.filePath) };
  });
  handle('files:showInFolder', (id) => {
    const target = copyToDownloads(id);
    if (target) shell.showItemInFolder(target);
    return target ? { ok: true, name: path.basename(target) } : { ok: false };
  });
  /** «Відкрити зовні» — лише для відео й аудіо, які не грає вбудований програвач. */
  handle('files:openExternal', async (id) => {
    const f = files.get(id);
    if (!f || !['video', 'audio'].includes(f.kind)) return { ok: false };
    const dir = path.join(app.getPath('temp'), 'Human Plus media');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${f.id}.${f.ext}`);
    if (!fs.existsSync(target)) fs.copyFileSync(files.pathOf(id), target);
    return { ok: !(await shell.openPath(target)) };
  });
  handle('files:remove', (id) => files.remove(id));
  handle('files:clearCache', () => (files.clearCache(), files.usage()));
  handle('books:list', () => library.list());
  handle('books:import', async (folder) => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: uk.books.importTitle,
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: folder
        ? []
        : [{ name: uk.books.filter, extensions: ['pdf', 'epub', 'docx', 'txt'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const progress = (p) => broadcast('books:progress', p);
    if (folder)
      return {
        ok: true,
        ...(await library.importFolder(res.filePaths[0], { onProgress: progress })),
      };
    const out = { ok: true, added: 0, skipped: 0, failed: 0, total: res.filePaths.length };
    for (const [k, f] of res.filePaths.entries()) {
      progress({ done: k, total: res.filePaths.length, name: path.basename(f) });
      const r = await library.import(f);
      r.ok ? out.added++ : out.failed++;
    }
    return out;
  });
  handle('books:update', (id, patch) => library.update(id, patch));
  handle('books:calibrate', (id, pair) => library.calibrate(id, pair ?? null));
  handle('books:remove', (id) => library.remove(id));
  handle('books:bytes', (id) => {
    const b = library.get(id);
    return b && b.format === 'pdf' ? new Uint8Array(library.bytes(id)) : null;
  });
  handle('books:page', (id, index) =>
    Number.isInteger(index) ? library.pageText(id, index) : null,
  );
  handle('books:search', (query, bookId) =>
    typeof query === 'string'
      ? library.search(query.slice(0, 200), { bookId: bookId ?? null, limit: 20 })
      : [],
  );
  handle('books:forSubject', (subject) =>
    typeof subject === 'string' ? library.findBooks(subject) : [],
  );
  /** Сторінка за текстом домашки («с. 34, № 2») у конкретній книзі. */
  handle('books:locate', async (id, text) => {
    const ref = parseRef(typeof text === 'string' ? text.slice(0, 20000) : '');
    if (ref.page == null) return { ok: false, ref };
    const r = await library.getPage(id, ref.page, { exercise: ref.exercise });
    return r.ok
      ? { ok: true, ref, index: r.index, printed: r.printed, approximate: r.approximate }
      : { ok: false, ref };
  });
  handle('books:pdfAsset', (kind, filename) => {
    const dir = PDF_ASSET_DIRS[kind];
    if (!dir || typeof filename !== 'string' || !/^[\w.-]{1,80}$/.test(filename)) return null;
    try {
      return new Uint8Array(fs.readFileSync(path.join(PDFJS_DIR, dir, filename)));
    } catch {
      return null;
    }
  });
  handle('books:rendered', (reqId, dataUrl) => {
    const done = renders.get(reqId);
    const m =
      typeof dataUrl === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (done) done(m && m[1].length < 6_000_000 ? { mediaType: 'image/jpeg', data: m[1] } : null);
  });
  handle('ai:abort', () => assistant.abort());
  handle('ai:history', () => assistant.history());
  handle('ai:reset', () => assistant.reset());
  handle('app:info', () => ({
    version: pkg.version,
    requests: client?.stats.total ?? 0,
    demo: DEMO,
  }));
}

app.whenReady().then(async () => {
  humanSession = DEMO ? session.fromPartition('demo') : session.fromPartition('persist:human');
  settings = loadSettings();
  nativeTheme.themeSource = settings.theme;
  gpuOk = String(app.getGPUFeatureStatus().gpu_compositing ?? 'enabled').startsWith('enabled');
  hardenSessions();
  if (PROBE)
    return (await import('./scripts/probe.js')).runProbe({
      app,
      humanSession,
      session,
      BrowserWindow,
      here,
      UID_COOKIE,
      LMS_ORIGIN,
    });

  client = DEMO
    ? null
    : createClient((url, init) => humanSession.fetch(url, init), { userAgent: UA });
  const nowSec = () => Math.floor(Date.now() / 1000);
  service = createService({
    client,
    getUid,
    cache: createFileCache(path.join(app.getPath('userData'), 'cache.json')),
    demo: DEMO ? createDemo(nowSec()) : null,
  });
  setupLibrary();
  setupFiles();
  setupAssistant(library);
  service.onChange((st) => {
    if (process.env.HD_LOG_BLOCKED && client?.stats.lastNetworkError)
      console.log('NET-ERR', st.status, client.stats.lastNetworkError);
    broadcast('state:changed', st);
    updateBadge(st);
    maybeNotify(st);
  });
  nativeTheme.on('updated', applyEnv);
  registerIpc();
  buildMenu();
  createMain();
  if (settings.mini) applyMini(true);
  if (!DEMO) createTray();
  globalShortcut.register('CommandOrControl+Shift+H', () =>
    patchSettings({ mini: !settings.mini }),
  );

  await service.loadCached();
  await service.refresh();
  setInterval(() => {
    const visible = mainWin && !mainWin.isDestroyed() && mainWin.isVisible();
    if (visible && service.getState().status === 'ready' && !service.isPaused()) service.refresh();
  }, REFRESH_MS);
  if (SHOTS)
    (await import('./scripts/shots.js')).takeShots({
      app,
      mainWin,
      patchSettings,
      service,
      dir: SHOTS,
    });
});

app.on('second-instance', showMain);
app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (quitting || !tray) app.quit();
});
