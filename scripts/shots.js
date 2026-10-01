// Скриншоти для README з демо-даних (npm run shots). Персональних даних учня тут немає за побудовою.
// Знімає: усі вкладки (темна/світла × скло/без прозорості), міні-режим, вузьке вікно, екрани входу/відмови,
// довгі назви, порожні стани та різну кількість завдань (0 / 1 / 25).
import fs from 'node:fs';
import path from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function takeShots({ app, mainWin, patchSettings, service, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const js = (code) => mainWin.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await wait(650);
    fs.writeFileSync(
      path.join(dir, name + '.png'),
      (await mainWin.webContents.capturePage()).toPNG(),
    );
  };
  const tab = async (t) => {
    await js(`document.querySelector('[data-k="tab-${t}"]')?.click()`);
    await wait(300);
  };
  const expandFirst = async (t) => {
    if (t === 'today') {
      await js(
        `[...document.querySelectorAll('.lesson-head')].slice(0, 3).forEach((b) => b.click())`,
      );
      await wait(500);
    } else
      await js(
        `[...document.querySelectorAll('.task-head')].slice(0, 3).forEach((b) => b.click())`,
      );
  };
  const base = JSON.parse(JSON.stringify(service.getState().snapshot));
  const mode = (theme, glass) =>
    patchSettings({
      theme,
      glass,
      preset: 'classic',
      accent: null,
      success: null,
      danger: null,
      mini: false,
    });

  mainWin.setSize(1100, 800);
  await wait(2500);

  // Усі вкладки у чотирьох режимах (для README потрібні not all; вкладки темного скла — повний набір).
  for (const [theme, glass] of [
    ['dark', 'on'],
    ['light', 'on'],
    ['dark', 'off'],
    ['light', 'off'],
  ]) {
    mode(theme, glass);
    const tag = `${theme}-${glass === 'on' ? 'glass' : 'opaque'}`;
    for (const t of glass === 'on' && theme === 'dark'
      ? ['today', 'next', 'tasks', 'schedule', 'grades']
      : ['today', 'tasks']) {
      await tab(t);
      if (t === 'today' || t === 'tasks') await expandFirst(t);
      await shot(`${tag}-${t}`);
      if (t === 'today' && glass === 'on') {
        await js(
          `(() => { const m = document.querySelector('main'); m.scrollTop = m.scrollHeight - m.clientHeight; })()`,
        );
        await shot(`${tag}-today-bottom`);
        await js(`document.querySelector('main').scrollTop = 0`);
      }
    }
  }

  // Панель налаштувань (світла й темна)
  for (const theme of ['dark', 'light']) {
    mode(theme, 'on');
    await tab('today');
    await js(`document.querySelector('[data-k="settings"]')?.click()`);
    await wait(500);
    await shot(`settings-${theme}`);
    await js(`document.querySelector('[data-k="drawer-close"]')?.click()`);
    await wait(400);
  }

  // Кастомний акцент
  patchSettings({ theme: 'dark', glass: 'on', preset: 'forest' });
  await tab('today');
  await shot('dark-glass-forest');

  // Вузьке вікно (мінімальна ширина 360) і довгі рядки
  mode('dark', 'on');
  const long = JSON.parse(JSON.stringify(base));
  long.lessons.forEach((l, i) => {
    if (i % 3 === 0) {
      l.subject = 'Інтегрований курс «Здоров’я, безпека і добробут» (поглиблене вивчення)';
      l.title =
        'Підсумкова тематична робота за розділом «Особливості складносурядного та складнопідрядного речення з різними видами підрядних частин»';
    }
  });
  long.tasks.forEach((t, i) => {
    if (i % 3 === 0) {
      t.subject = 'Інтегрований курс «Здоров’я, безпека і добробут» (поглиблене вивчення)';
      t.themeTitle =
        'Підсумкова тематична робота за розділом «Особливості складносурядного та складнопідрядного речення»';
    }
  });
  service._set({ snapshot: long });
  mainWin.setSize(380, 760);
  await tab('today');
  await shot('narrow-long-today');
  await tab('tasks');
  await shot('narrow-long-tasks');
  mainWin.setSize(1100, 800);

  // 0 / 1 / 25 завдань
  const many = JSON.parse(JSON.stringify(base));
  const src = many.tasks.filter((t) => t.pending);
  many.tasks = Array.from({ length: 25 }, (_, i) => ({
    ...src[i % src.length],
    id: 90000 + i,
    deadline: src[i % src.length].deadline + (i % 7) * 3600,
  }));
  service._set({ snapshot: many });
  await tab('tasks');
  await shot('tasks-25');
  service._set({ snapshot: { ...base, tasks: base.tasks.filter((t) => t.pending).slice(0, 1) } });
  await shot('tasks-1');
  service._set({ snapshot: { ...base, tasks: [] } });
  await shot('tasks-0');
  service._set({ snapshot: { ...base, lessons: [], tasks: [] } });
  await tab('today');
  await shot('today-empty');
  service._set({ snapshot: base });

  // Екрани входу й відмови для не-учня
  service._set({ status: 'login', snapshot: null });
  await shot('login');
  service._set({ status: 'notStudent', snapshot: null });
  await shot('not-student');
  service._set({ status: 'expired', snapshot: null });
  await shot('expired');
  service._set({ status: 'ready', snapshot: base });

  // Міні-режим (те саме вікно)
  patchSettings({ mini: true, miniOpacity: 1 });
  await wait(800);
  await tab('today');
  await shot('mini');
  patchSettings({ mini: false });
  app.quit();
}
