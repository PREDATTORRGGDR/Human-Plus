// PDF у вікні через pdfjs: без мережі (шрифти й CMaps приходять із main через IPC), без eval, без wasm
// (JS-декодери JBIG2/JPEG2000 підвантажуються як локальні модулі). Робоча частина pdfjs працює в цьому ж потоці.
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.mjs';

let workerReady = null;
const ensureWorker = () =>
  (workerReady ??= import('../node_modules/pdfjs-dist/build/pdf.worker.mjs').then((m) => {
    globalThis.pdfjsWorker = m; // pdfjs бачить готовий обробник і не створює окремий Worker
  }));

/** Фабрика даних pdfjs: шрифти й CMaps просимо в main за ім'ям файлу (main перевіряє ім'я й каталог). */
class IpcDataFactory {
  constructor(opts) {
    this.opts = opts;
  }
  async fetch({ kind, filename }) {
    const r = await window.hd.books.pdfAsset(kind, filename);
    if (!r) throw new Error(`asset ${kind}/${filename}`);
    return new Uint8Array(r);
  }
}

const WASM_DIR = new URL('../node_modules/pdfjs-dist/wasm/', import.meta.url).href;

/** @param {Uint8Array} data */
export async function openPdf(data) {
  await ensureWorker();
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    enableXfa: false,
    useWasm: false,
    wasmUrl: WASM_DIR,
    BinaryDataFactory: IpcDataFactory,
    cMapUrl: 'ipc/',
    cMapPacked: true,
    standardFontDataUrl: 'ipc/',
    useWorkerFetch: false,
    verbosity: 0,
  }).promise;
}

/** Малює сторінку (index 0-based) у canvas шириною до maxWidth CSS-пікселів. */
export async function renderPage(doc, index, canvas, { maxWidth = 900, zoom = 1 } = {}) {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = (Math.min(maxWidth, base.width * 2) / base.width) * zoom;
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  return canvas;
}

/** Сторінка як JPEG (для моделі, коли сторінка — скан без тексту): довша сторона до 1600 px. */
export async function pageJpeg(doc, index, maxSide = 1600) {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = maxSide / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return canvas.toDataURL('image/jpeg', 0.82);
}
