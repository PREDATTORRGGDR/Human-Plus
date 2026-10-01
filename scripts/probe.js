// Розвідка (npm run probe): відкриває вікно Human, користувач входить сам; далі лише GET-запити,
// у probe-output/probe.json потрапляють тільки статуси й імена полів — жодних персональних даних.
import fs from 'node:fs';
import path from 'node:path';
import { endpoints, isStudent } from '../src/api.js';

export async function runProbe({ app, humanSession, BrowserWindow, here, UID_COOKIE, LMS_ORIGIN }) {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Probe: увійдіть у HUMAN',
    webPreferences: { session: humanSession, sandbox: true, contextIsolation: true },
  });
  win.loadURL(LMS_ORIGIN);
  const out = { startedAt: new Date().toISOString(), steps: {} };
  const ua = 'HumanPlus/probe (unofficial; read-only)';
  let done = false;
  const run = async () => {
    if (done) return;
    const [c] = await humanSession.cookies.get({ url: LMS_ORIGIN, name: UID_COOKIE });
    if (!c || !win.webContents.getURL().startsWith(LMS_ORIGIN + '/app')) return;
    done = true;
    const uid = Number(c.value);
    out.steps.uidCookie = {
      found: true,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      domain: c.domain,
      session: !c.expirationDate,
    };
    const apiCookies = await humanSession.cookies.get({ url: 'https://api.human.ua' });
    out.steps.cookiesForApi = apiCookies.map((k) => ({
      name: k.name,
      sameSite: k.sameSite,
      httpOnly: k.httpOnly,
      secure: k.secure,
    }));
    const get = async (url, init = {}) => {
      try {
        const r = await humanSession.fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': ua },
          ...init,
        });
        let body = null;
        try {
          body = await r.json();
        } catch {
          /* не JSON */
        }
        return { status: r.status, body };
      } catch (e) {
        return { status: 'network', error: String(e.message).slice(0, 80) };
      }
    };
    const a = await get(endpoints.systemInfo(uid), { credentials: 'include' });
    out.steps.mainProcessFetchInclude = {
      status: a.status,
      isStudent: a.body ? isStudent(a.body, uid) : null,
    };
    const b = await get(endpoints.systemInfo(uid), { credentials: 'omit' });
    out.steps.mainProcessFetchOmit = {
      status: b.status,
      error: b.body ? Object.keys(b.body) : null,
    };
    const now = Math.floor(Date.now() / 1000);
    const cal = await get(endpoints.calendar(uid, now - 86400, now + 86400), {
      credentials: 'include',
    });
    out.steps.calendarMainProcess = {
      status: cal.status,
      sections: cal.body
        ? Object.fromEntries(
            Object.entries(cal.body).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]),
          )
        : null,
    };
    try {
      out.steps.pageContextFetch = await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(endpoints.systemInfo(uid))},{credentials:'include'}).then(r=>({status:r.status}))`,
      );
    } catch (e) {
      out.steps.pageContextFetch = { error: String(e.message).slice(0, 80) };
    }
    fs.mkdirSync(path.join(here, 'probe-output'), { recursive: true });
    fs.writeFileSync(path.join(here, 'probe-output', 'probe.json'), JSON.stringify(out, null, 2));
    console.log('PROBE_DONE');
    app.quit();
  };
  const log = (_e, url) => console.log('NAV', url.split('?')[0]);
  win.webContents.on('did-navigate', log);
  win.webContents.on('did-navigate-in-page', log);
  win.webContents.on('did-navigate', run);
  win.webContents.on('did-navigate-in-page', run);
  win.webContents.on('did-finish-load', run);
  app.on('window-all-closed', () => app.quit());
}
