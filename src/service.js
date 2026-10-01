// Оркестрація даних: перевірка ролі → календар → нормалізація → кеш. Без залежності від Electron (тестується).
import fs from 'node:fs';
import path from 'node:path';
import {
  ApiError,
  NetworkError,
  SessionExpiredError,
  fetchCalendar,
  fetchStudentTasks,
  fetchSystemInfo,
  fetchTheme,
  isStudent,
  parseThemeTasks,
} from './api.js';
import { toPublic } from './blocks.js';
import { normalizeCalendar } from './normalize.js';
import { addDays, weekStart } from './time.js';

const CACHE_VERSION = 2; // 2: тексти ДЗ зберігаються як блоки (текст, фото, файли, посилання)
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_FILE = 150 * 1024 * 1024;
const PAUSE_AFTER_FAILURES = 3;

/** Кеш одним JSON-файлом; запис через тимчасовий файл. */
export function createFileCache(file) {
  return {
    load() {
      try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        return c?.version === CACHE_VERSION ? c : null;
      } catch {
        return null;
      }
    },
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ version: CACHE_VERSION, ...data }));
      fs.renameSync(file + '.tmp', file);
    },
    clear() {
      fs.rmSync(file, { force: true });
      fs.rmSync(file + '.tmp', { force: true });
    },
  };
}

/**
 * @param {{ client?: any, getUid: () => Promise<number|null>, cache: ReturnType<typeof createFileCache>,
 *   now?: () => number, demo?: ReturnType<import('./demo.js').createDemo>|null }} deps
 */
export function createService({
  client,
  getUid,
  cache,
  now = () => Math.floor(Date.now() / 1000),
  demo = null,
}) {
  const state = {
    status: 'loading',
    snapshot: null,
    updatedAt: null,
    offline: false,
    stale: false,
    paused: false,
    demo: !!demo,
    requests: 0,
    loggingIn: false,
  };
  const listeners = new Set();
  const weekCache = new Map();
  let texts = {};
  let uid = null;
  let failures = 0;
  let running = null;

  const emit = () => listeners.forEach((f) => f(getState()));
  const set = (patch) => {
    Object.assign(state, patch);
    emit();
  };
  const getState = () => ({ ...state, now: now() });
  const windowOf = (t) => ({ from: addDays(weekStart(t), -14), to: addDays(weekStart(t), 35) });

  function fromCache(c) {
    texts = c.texts ?? {};
    // Кеш лишаємо як є: «поточні» поля (pending/overdue) перераховуємо від нині.
    return rederive(c.snapshot, now());
  }

  function rederive(snap, t) {
    for (const x of snap.tasks) {
      if (x.status === 'assigned' || x.status === 'returned') {
        if (x.deadline != null && x.deadline < t) x.status = 'overdue';
      }
      x.pending = ['assigned', 'overdue', 'returned', 'unknown'].includes(x.status);
    }
    return snap;
  }

  /** Миттєвий показ із кешу на старті; роль перевіряється у фоні, дані зникнуть, якщо вона не учнівська. */
  async function loadCached() {
    if (demo) return;
    const c = cache.load();
    const id = await getUid();
    if (c?.studentVerified && id != null && c.uid === id && c.snapshot) {
      uid = id;
      set({ status: 'ready', snapshot: fromCache(c), updatedAt: c.updatedAt, stale: true });
    }
  }

  async function refresh() {
    if (running) return running;
    running = doRefresh().finally(() => (running = null));
    return running;
  }

  async function doRefresh() {
    const t = now();
    if (demo) {
      const w = windowOf(t);
      set({
        status: 'ready',
        snapshot: normalizeCalendar(demo.calendar(w.from, w.to), {
          now: t,
          ...w,
          studentTasks: demo.studentTasks(),
        }),
        updatedAt: t,
        offline: false,
        stale: false,
      });
      return;
    }
    client.resetStats();
    const id = await getUid();
    if (id == null) {
      set({ status: 'login', snapshot: null });
      return;
    }
    const cached = cache.load();
    const cachedOk = cached?.studentVerified && cached.uid === id && cached.snapshot;
    const useCache = (patch) =>
      set({ status: 'ready', snapshot: fromCache(cached), updatedAt: cached.updatedAt, ...patch });
    try {
      const info = await fetchSystemInfo(client, id);
      if (!isStudent(info, id)) {
        cache.clear();
        texts = {};
        weekCache.clear();
        set({
          status: 'notStudent',
          snapshot: null,
          offline: false,
          stale: false,
          requests: client.stats.total,
        });
        return;
      }
      uid = id;
      const w = windowOf(t);
      const [raw, studentTasks] = await Promise.all([
        fetchCalendar(client, id, w.from, w.to),
        fetchStudentTasks(client, id).catch((e) => {
          if (e instanceof SessionExpiredError) throw e;
          return null; // статуси стануть наближеними (з календаря), секція studentTasks потрапить у «нерозпізнані»
        }),
      ]);
      const snapshot = normalizeCalendar(raw, { now: t, ...w, studentTasks });
      pruneTexts(snapshot);
      cache.save({ uid: id, studentVerified: true, updatedAt: t, snapshot, texts });
      weekCache.clear();
      failures = 0;
      set({
        status: 'ready',
        snapshot,
        updatedAt: t,
        offline: false,
        stale: false,
        paused: false,
        requests: client.stats.total,
      });
    } catch (e) {
      const requests = client.stats.total;
      if (e instanceof SessionExpiredError) set({ status: 'expired', snapshot: null, requests });
      else if (e instanceof NetworkError)
        cachedOk
          ? useCache({ offline: true, stale: true, requests })
          : set({ status: 'error', offline: true, snapshot: null, requests });
      else if (e instanceof ApiError && e.status === 422)
        set({ status: 'login', snapshot: null, requests }); // обліковий запис LMS не знайдено
      else {
        failures++;
        const paused = failures >= PAUSE_AFTER_FAILURES;
        cachedOk
          ? useCache({ stale: true, paused, requests })
          : set({ status: 'error', paused, snapshot: null, requests });
      }
    }
  }

  function pruneTexts(snap) {
    const ids = new Set([
      ...snap.tasks.map((x) => String(x.id)),
      ...snap.lessons.flatMap((l) => (l.lessonTasks ?? []).map((x) => x.id)),
    ]);
    for (const k of Object.keys(texts)) if (!ids.has(k)) delete texts[k];
  }

  const publicEntry = (e) => ({ ok: true, blocks: toPublic(e.blocks), stale: e.stale });

  const isLessonKey = (k) => typeof k === 'string' && /^L\d+$/.test(k);
  const lessonTaskByKey = (key) => {
    for (const l of state.snapshot?.lessons ?? []) {
      const lt = l.lessonTasks?.find((x) => x.id === key);
      if (lt) return { lt, themeId: l.themeId };
    }
    return null;
  };

  /**
   * Вміст ДЗ (ключ — число) або матеріалу уроку (ключ «L123»): з кешу, поки updated_at не змінився;
   * інакше один запит на тему (він віддає і ДЗ, і матеріали). Блоки без адрес медіа.
   */
  async function getTaskText(key) {
    const target = isLessonKey(key) ? lessonTaskByKey(key) : null;
    const task = isLessonKey(key)
      ? target
        ? { id: key, themeId: target.themeId, updatedAt: target.lt.updatedAt }
        : null
      : state.snapshot?.tasks.find((x) => x.id === key);
    if (!task) return { ok: false, reason: 'unknown' };
    const hit = texts[key];
    if (hit?.blocks && hit.updatedAt === task.updatedAt) return publicEntry(hit);
    if (demo) return store(task, parseThemeTasks(demo.theme(task.themeId), 0));
    if (state.status !== 'ready' || uid == null)
      return hit?.blocks
        ? publicEntry({ ...hit, stale: true })
        : { ok: false, reason: 'unavailable' };
    try {
      return store(task, parseThemeTasks(await fetchTheme(client, uid, task.themeId), uid));
    } catch (e) {
      if (e instanceof SessionExpiredError) set({ status: 'expired', snapshot: null });
      return hit?.blocks
        ? publicEntry({ ...hit, stale: true })
        : { ok: false, reason: e instanceof NetworkError ? 'offline' : 'error' };
    }
  }

  function store(task, parsed) {
    // Ключ інвалідації — updated_at з календаря: зміниться — перезавантажимо вміст.
    for (const [k, v] of Object.entries(parsed)) {
      const upd = isLessonKey(k)
        ? lessonTaskByKey(k)?.lt.updatedAt
        : state.snapshot.tasks.find((x) => x.id === Number(k))?.updatedAt;
      if (upd !== undefined) texts[k] = { ...v, updatedAt: upd };
    }
    texts[task.id] ??= { updatedAt: task.updatedAt, blocks: [], hash: null };
    if (!demo) {
      const c = cache.load();
      if (c) cache.save({ ...c, texts });
    }
    return publicEntry(texts[task.id]);
  }

  const blockOf = (taskId, index, kind) => {
    const b = texts[taskId]?.blocks?.[index];
    return b?.kind === kind ? b : null;
  };
  const images = new Map(); // «taskId:index:updatedAt» → data: URL (лише в пам'яті)

  /** Зображення з блоку ДЗ як data:-URL (вікно не ходить у мережу саме). */
  async function getImage(taskId, index) {
    const b = blockOf(taskId, index, 'image');
    if (!b) return { ok: false, reason: 'unknown' };
    const key = `${taskId}:${index}:${texts[taskId].updatedAt}`;
    if (images.has(key)) return { ok: true, dataUrl: images.get(key) };
    if (demo) return { ok: true, dataUrl: demo.image(b.url) };
    try {
      const { buffer, type } = await client.getBuffer(b.url, { maxBytes: MAX_IMAGE });
      if (!IMAGE_TYPES.includes(type)) return { ok: false, reason: 'type' };
      const dataUrl = `data:${type};base64,${buffer.toString('base64')}`;
      if (images.size >= 30) images.delete(images.keys().next().value);
      images.set(key, dataUrl);
      return { ok: true, dataUrl };
    } catch (e) {
      if (e instanceof SessionExpiredError) set({ status: 'expired', snapshot: null });
      return { ok: false, reason: e instanceof NetworkError ? 'offline' : 'error' };
    }
  }

  /** Файл із блоку ДЗ: байти й ім'я (запис на диск робить main після явного кліку користувача). */
  async function getFile(taskId, index) {
    const b = blockOf(taskId, index, 'file');
    if (!b) return { ok: false, reason: 'unknown' };
    if (demo) return { ok: false, reason: 'demo' };
    try {
      const { buffer } = await client.getBuffer(b.url, { maxBytes: MAX_FILE });
      return { ok: true, name: b.name, buffer };
    } catch (e) {
      if (e instanceof SessionExpiredError) set({ status: 'expired', snapshot: null });
      return {
        ok: false,
        reason: e instanceof NetworkError ? 'offline' : e?.status === 413 ? 'big' : 'error',
      };
    }
  }

  /** Адреса посилання з блоку (лише безпечна); у вікно не віддається. */
  const getLink = (taskId, index) => blockOf(taskId, index, 'link')?.url ?? null;

  /** Тиждень для вкладки «Розклад»: у межах завантаженого вікна — без запиту. */
  async function getWeek(start) {
    const snap = state.snapshot;
    if (!snap) return null;
    const end = addDays(start, 7);
    const inWin = (l) => l.start >= start && l.start < end;
    if (start >= snap.window.from && end <= snap.window.to)
      return { lessons: snap.lessons.filter(inWin), weekends: snap.weekends };
    const hit = weekCache.get(start);
    if (hit && hit.at > now() - 600) return hit.data;
    const t = now();
    let raw;
    if (demo) raw = demo.calendar(start, end);
    else {
      try {
        raw = await fetchCalendar(client, uid, start, end);
      } catch (e) {
        if (e instanceof SessionExpiredError) set({ status: 'expired', snapshot: null });
        return { lessons: [], weekends: [], error: true };
      }
    }
    const n = normalizeCalendar(raw, { now: t, from: start, to: end });
    const data = { lessons: n.lessons, weekends: n.weekends, partial: n.partial };
    weekCache.set(start, { at: t, data });
    return data;
  }

  function wipe() {
    cache.clear();
    texts = {};
    images.clear();
    weekCache.clear();
    uid = null;
    failures = 0;
    set({
      status: 'login',
      snapshot: null,
      updatedAt: null,
      offline: false,
      stale: false,
      paused: false,
    });
  }

  return {
    getState,
    refresh,
    loadCached,
    getTaskText,
    /** Типи блоків, яких застосунок не розпізнав (лише назви типів, без даних), для діагностики. */
    unsupportedTypes: () =>
      [
        ...new Set(
          Object.values(texts).flatMap((e) =>
            (e.blocks ?? []).filter((b) => b.kind === 'unsupported').map((b) => b.type),
          ),
        ),
      ].sort(),
    getImage,
    getFile,
    getLink,
    getWeek,
    wipe,
    resume: () => {
      failures = 0;
      state.paused = false;
    },
    isPaused: () => state.paused,
    markLoggedOut: () => set({ status: 'login', snapshot: null }),
    setLoggingIn: (v) => set({ loggingIn: !!v }),
    /** Лише для скриншотів (scripts/shots.js): підміняє стан, щоб показати екрани входу, відмови й порожні стани. */
    _set: set,
    onChange: (f) => (listeners.add(f), () => listeners.delete(f)),
  };
}
