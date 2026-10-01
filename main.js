// Головний процес: єдине вікно, сесія persist:human, меню/трей, IPC, кеш. Перевірка ролі — у src/service.js.
// Додаткових вікон немає: вхід у HUMAN відкривається всередині головного вікна (WebContentsView),
// а міні-режим «Що задано на завтра» — це стан того самого вікна.
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  WebContentsView,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
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

let humanSession, service, settings, tray, mainWin, loginView, client;
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
  return lines.join('\n');
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
