// Файли на пристрої: «Мої файли» (учень додав сам) і кеш файлів із завдань HUMAN з обмеженням розміру.
// Вікно бачить лише id, ім'я, розмір і тип; шляхи на диску знає тільки main.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFile, safeName } from './types.js';

const ID = /^[a-f0-9]{16}$/;
export const MAX_FILE = 2 * 1024 * 1024 * 1024; // 2 ГБ на один файл учня

/**
 * @param {{ dir: string, cacheLimit: () => number }} deps cacheLimit — ліміт кешу HUMAN у байтах
 */
export function createFileStore({ dir, cacheLimit }) {
  const indexFile = path.join(dir, 'index.json');
  let items = load();

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return Array.isArray(j)
        ? j.filter((x) => ID.test(x?.id) && fs.existsSync(path.join(dir, x.file)))
        : [];
    } catch {
      return [];
    }
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify(items));
    fs.renameSync(indexFile + '.tmp', indexFile);
  }
  const pub = (x) => ({
    id: x.id,
    name: x.name,
    size: x.size,
    kind: classifyFile(x.name).kind,
    ext: classifyFile(x.name).ext,
    source: x.source,
    addedAt: x.addedAt,
    key: x.key ?? null,
  });
  const get = (id) =>
    typeof id === 'string' && ID.test(id) ? items.find((x) => x.id === id) : null;
  const newId = () => crypto.randomBytes(8).toString('hex');
  // на диску файл зберігається з нейтральним розширенням: Windows не запустить його подвійним кліком
  const diskName = (id) => `${id}.bin`;

  function evict() {
    const limit = cacheLimit();
    let total = items.filter((x) => x.source === 'human').reduce((n, x) => n + x.size, 0);
    const old = items.filter((x) => x.source === 'human').sort((a, b) => a.usedAt - b.usedAt);
    for (const x of old) {
      if (total <= limit) break;
      fs.rmSync(path.join(dir, x.file), { force: true });
      items = items.filter((y) => y.id !== x.id);
      total -= x.size;
    }
  }

  return {
    list: (source) => items.filter((x) => !source || x.source === source).map(pub),
    get: (id) => (get(id) ? pub(get(id)) : null),
    /** Шлях на диску (лише для main: потік, «зберегти як», «показати в папці»). */
    pathOf: (id) => (get(id) ? path.join(dir, get(id).file) : null),
    read(id, max = 600 * 1024 * 1024) {
      const x = get(id);
      if (!x || x.size > max) return null;
      return fs.readFileSync(path.join(dir, x.file));
    },

    /** Файли, які учень обрав у системному діалозі: копіюються в папку застосунку. */
    importFiles(paths, now = Date.now()) {
      const added = [];
      for (const p of paths) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size > MAX_FILE) continue;
        const id = newId();
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(p, path.join(dir, diskName(id)));
        const x = {
          id,
          name: safeName(path.basename(p)),
          size: st.size,
          file: diskName(id),
          source: 'mine',
          addedAt: now,
          usedAt: now,
        };
        items.push(x);
        added.push(pub(x));
      }
      save();
      return added;
    },

    /** Файл із завдання HUMAN у кеші (ключ «taskId:index:updatedAt»): повторно не завантажується. */
    cached(key) {
      const x = items.find((y) => y.source === 'human' && y.key === key);
      if (!x) return null;
      x.usedAt = Date.now();
      save();
      return pub(x);
    },
    putHuman(key, name, buffer, now = Date.now()) {
      const id = newId();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, diskName(id)), buffer);
      const x = {
        id,
        name: safeName(name),
        size: buffer.length,
        file: diskName(id),
        source: 'human',
        key,
        addedAt: now,
        usedAt: now,
      };
      items = items.filter((y) => !(y.source === 'human' && y.key === key));
      items.push(x);
      evict();
      save();
      return pub(x);
    },

    remove(id) {
      const x = get(id);
      if (!x) return false;
      fs.rmSync(path.join(dir, x.file), { force: true });
      items = items.filter((y) => y.id !== id);
      save();
      return true;
    },
    clearCache() {
      for (const x of items.filter((y) => y.source === 'human'))
        fs.rmSync(path.join(dir, x.file), { force: true });
      items = items.filter((y) => y.source !== 'human');
      save();
    },
    usage: () => ({
      cache: items.filter((x) => x.source === 'human').reduce((n, x) => n + x.size, 0),
      mine: items.filter((x) => x.source === 'mine').reduce((n, x) => n + x.size, 0),
      limit: cacheLimit(),
    }),
  };
}
