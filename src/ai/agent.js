// Цикл асистента: згода → ключ → перевірка ролі «учень» перед КОЖНИМ запитом до моделі (fail closed) →
// потокова відповідь → інструменти → наступний крок. Без залежності від Electron (тестується з підробленим провайдером).
import { AiError } from './errors.js';
import {
  LIMITS,
  buildRequest,
  buildUserTurn,
  stripForStorage,
  toolResultText,
  trimHistory,
} from './context.js';

const KEEP_UI = 200;
const KEEP_MODEL = 60;

/** Сховище розмови: { ui: записи для вікна, model: нейтральна історія для моделі }. */
export function createMemoryStore(initial = null) {
  let data = initial ?? { ui: [], model: [] };
  return { load: () => data, save: (d) => (data = d) };
}

/**
 * @param {{
 *   getProvider: () => any,
 *   verifyStudent: () => Promise<boolean>,
 *   tools: ReturnType<import('./tools.js').createTools>,
 *   service: { getState(): any, getTaskText(id: any): Promise<any> },
 *   store: { load(): any, save(d: any): void },
 *   hasConsent: () => boolean,
 *   emit: (ev: any) => void,
 *   now?: () => number,
 * }} deps
 */
export function createAssistant({
  getProvider,
  verifyStudent,
  tools,
  service,
  store,
  hasConsent,
  emit,
  now = () => Math.floor(Date.now() / 1000),
}) {
  let data = normalize(store.load());
  let controller = null;
  let seq = 0;
  const id = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

  function normalize(d) {
    return {
      ui: Array.isArray(d?.ui) ? d.ui : [],
      model: Array.isArray(d?.model) ? d.model : [],
    };
  }
  const persist = () => {
    data.ui = data.ui.slice(-KEEP_UI);
    data.model = trimHistory(data.model, KEEP_MODEL);
    store.save(data);
  };

  async function studentOk() {
    try {
      return (await verifyStudent()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Хід учня. mode: chat | explain | notebook; taskId — ДЗ, з яким працюємо (кнопки «Пояснити» / «Відповідь для зошита»).
   * @returns {Promise<{ ok: boolean, code?: string }>}
   */
  async function send({ text = '', mode = 'chat', taskId = null } = {}) {
    if (controller) return { ok: false, code: 'busy' };
    if (!String(text).trim() && taskId == null) return { ok: false, code: 'empty' };
    controller = new AbortController();
    const signal = controller.signal;
    const task =
      taskId != null ? service.getState().snapshot?.tasks.find((t) => t.id === taskId) : null;
    const userEntry = {
      id: id(),
      role: 'user',
      text: String(text).trim(),
      mode,
      task: task ? { id: task.id, subject: task.subject, theme: task.themeTitle } : null,
      at: now(),
    };
    const entry = { id: id(), role: 'assistant', text: '', cards: [], at: now(), tools: [] };
    data.ui.push(userEntry);
    emit({ type: 'user', entry: userEntry });
    emit({ type: 'start', id: entry.id });
    const turnMsgs = [];
    try {
      if (!hasConsent()) throw new AiError('consent');
      const provider = getProvider(); // AiError('no_key'), якщо ключа немає
      if (!(await studentOk())) throw new AiError('not_student');
      let taskBlocks = null;
      if (task) {
        const r = await service.getTaskText(task.id);
        taskBlocks = r?.ok ? r.blocks : null;
      }
      const userMsg = buildUserTurn({ text, now: now(), mode, task, taskBlocks });
      const history = [...trimHistory(data.model), userMsg];
      turnMsgs.push(userMsg);
      let images = 0;
      for (let step = 0; step < LIMITS.steps; step++) {
        if (step > 0 && !(await studentOk())) throw new AiError('not_student');
        if (signal.aborted) throw new AiError('aborted');
        if (step > 0 && entry.text && !entry.text.endsWith('\n')) {
          entry.text += '\n\n';
          emit({ type: 'text', id: entry.id, delta: '\n\n' });
        }
        const res = await provider.turn({
          ...buildRequest({ history, tools: tools.defs }),
          signal,
          onText: (delta) => {
            entry.text += delta;
            emit({ type: 'text', id: entry.id, delta });
          },
        });
        if (res.stopReason === 'refusal') throw new AiError('refusal');
        const aMsg = { role: 'assistant', content: res.blocks, raw: res.raw };
        history.push(aMsg);
        turnMsgs.push(aMsg);
        const uses = res.blocks.filter((b) => b.type === 'tool_use');
        if (res.stopReason === 'max_tokens') {
          entry.truncated = true; // обрізаний виклик інструмента не виконуємо
          break;
        }
        if (!uses.length) break;
        const results = await Promise.all(
          uses.map(async (u) => {
            entry.tools.push(u.name);
            emit({ type: 'tool', id: entry.id, name: u.name });
            const out = await tools.run(u.name, u.input);
            if (out.card) {
              entry.cards.push(out.card);
              emit({ type: 'card', id: entry.id, card: out.card });
            }
            const image = out.image && images < LIMITS.imagesPerTurn ? out.image : null;
            if (image) images++;
            return {
              type: 'tool_result',
              id: u.id,
              name: u.name,
              text: toolResultText(out.result),
              image,
              isError: !!out.isError,
            };
          }),
        );
        const rMsg = { role: 'user', content: results };
        history.push(rMsg);
        turnMsgs.push(rMsg);
        if (step === LIMITS.steps - 1) entry.stepLimit = true;
      }
      data.model.push(...turnMsgs.map(stripForStorage)); // без блоків міркувань і зображень
      data.ui.push(entry);
      persist();
      emit({ type: 'done', entry });
      return { ok: true };
    } catch (e) {
      const code = e instanceof AiError ? e.code : 'error';
      // Відмову чи помилку в історію моделі не пишемо: наступний хід почнеться з чистого стану.
      if (code === 'refusal') entry.text = '';
      entry.error = code;
      data.ui.push(entry);
      persist();
      emit({ type: 'error', id: entry.id, code, entry });
      return { ok: false, code };
    } finally {
      controller = null;
    }
  }

  return {
    send,
    abort: () => controller?.abort(),
    busy: () => !!controller,
    /** Записи для вікна (без історії моделі). */
    history: () => data.ui,
    reset() {
      controller?.abort();
      data = { ui: [], model: [] };
      store.save(data);
    },
    /** Для тестів: що збережено для моделі. */
    _model: () => data.model,
  };
}
