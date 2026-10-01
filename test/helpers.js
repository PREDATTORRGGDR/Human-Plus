// Спільні заготовки тестів: підроблений fetch, що віддає демо-календар і system/info.
import { createDemo } from '../src/demo.js';

export const NOW = Date.UTC(2026, 9, 1, 9, 0, 0) / 1000; // чт, 1 жовтня 2026, 12:00 за Києвом
export const STUDENT_INFO = {
  lmsUser: { id: 42, role_id: 2, status: 1 },
  parentUser: null,
  menuSettings: [{ uid: 'student_calendar' }, { uid: 'student_home' }],
};

export const res = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

/** fetch, що імітує api.human.ua. `override(url)` може повернути свою відповідь. */
export function fakeApi({ info = STUDENT_INFO, override } = {}) {
  const demo = createDemo(NOW);
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method });
    const o = override?.(url);
    if (o) return typeof o === 'function' ? o() : o;
    const u = new URL(url);
    if (u.pathname.endsWith('/system/info')) return res(200, info);
    if (u.pathname.endsWith('/calendar'))
      return res(
        200,
        demo.calendar(+u.searchParams.get('dateStart'), +u.searchParams.get('dateFinish')),
      );
    if (u.pathname.endsWith('/students-tasks'))
      return res(200, demo.studentTasks()[u.searchParams.get('filter')] ?? []);
    const m = u.pathname.match(/\/plan\/theme\/(\d+)$/);
    if (m) return res(200, demo.theme(+m[1]));
    return res(404, {});
  };
  return { fn, calls, demo };
}
