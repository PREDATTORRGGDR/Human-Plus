// Мінімальний міст між вікном і main-процесом. Лише перелічені виклики, жодного доступу до Node.
const { contextBridge, ipcRenderer } = require('electron');

const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('hd', {
  getState: invoke('state:get'),
  refresh: invoke('state:refresh'),
  getTaskText: invoke('task:text'),
  getImage: invoke('media:image'),
  saveFile: invoke('media:save'),
  openLink: invoke('link:open'),
  getSchedule: invoke('week:get'),
  login: invoke('session:login'),
  logout: invoke('session:logout'),
  openExternal: invoke('open:external'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  toggleMini: invoke('mini:toggle'),
  cancelLogin: invoke('login:cancel'),
  copyDiagnostics: invoke('report:copy'),
  getAppInfo: invoke('app:info'),
  ai: {
    status: invoke('ai:status'),
    setKey: invoke('ai:setKey'),
    clearKey: invoke('ai:clearKey'),
    consent: invoke('ai:consent'),
    send: invoke('ai:send'),
    abort: invoke('ai:abort'),
    history: invoke('ai:history'),
    reset: invoke('ai:reset'),
    onEvent: subscribe('ai:event'),
  },
  books: {
    list: invoke('books:list'),
    import: invoke('books:import'),
    update: invoke('books:update'),
    calibrate: invoke('books:calibrate'),
    remove: invoke('books:remove'),
    bytes: invoke('books:bytes'),
    page: invoke('books:page'),
    search: invoke('books:search'),
    forSubject: invoke('books:forSubject'),
    locate: invoke('books:locate'),
    pdfAsset: invoke('books:pdfAsset'),
    rendered: invoke('books:rendered'),
    onProgress: subscribe('books:progress'),
    onRender: subscribe('books:render'),
  },
  onState: subscribe('state:changed'),
  onSettings: subscribe('settings:changed'),
  onAbout: subscribe('ui:about'),
});
