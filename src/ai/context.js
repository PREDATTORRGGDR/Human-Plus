// ЄДИНЕ місце, де формується все, що йде в модель: системний промпт, контекст ходу, обрізання історії,
// обрізання результатів інструментів і сторінок книг. Провайдери лише перекладають готовий запит у свій формат.
// Цілу книгу, увесь кеш чи всю історію в модель не відправляємо ніколи.
import { formatDateTime, formatDay, formatTime } from '../time.js';

export const LIMITS = {
  historyMessages: 12, // останні N повідомлень (обрізаємо по межі ходу учня)
  userChars: 4000, // одне повідомлення учня
  taskChars: 4000, // текст поточного ДЗ
  toolChars: 6000, // результат одного інструмента
  pageChars: 6000, // текст однієї сторінки книги
  imagesPerTurn: 2, // зображень сторінок за один хід
  steps: 6, // запитів до моделі за один хід (цикл інструментів)
  maxTokens: 8000, // відповідь моделі
};

/** Незмінний упродовж розмови (кеш промпту і перевірка історії провайдером): дата й завдання йдуть у хід учня. */
export const SYSTEM_PROMPT = `Ти помічник учня української школи в застосунку Human Plus. Відповідай українською.
Ти бачиш розклад, домашні завдання й оцінки учня лише через інструменти get_schedule, get_homework, get_grades,
а підручники, які учень сам завантажив, через find_book, get_page і search_book. Не вигадуй даних: якщо чогось немає в результатах інструментів, так і скажи.
Номер сторінки з домашки («с. 34, № 2») — це друкований номер; передавай його в get_page як є, застосунок сам перерахує сторінку PDF.
Якщо get_page повідомляє, що номер неточний, попроси учня перевірити сторінку.
За замовчуванням пояснюй і веди до відповіді кроками, щоб учень зрозумів тему. Готову відповідь для зошита давай, коли учень просить саме її.
Ти лише читаєш дані: здавати завдання, змінювати оцінки чи писати вчителю не можеш і не пропонуй.
Пиши коротко й структуровано: короткі абзаци, нумеровані кроки, формули звичайним текстом.`;

export const MODES = {
  chat: '',
  explain:
    'Поясни, як виконати це завдання: що потрібно знати, план розв’язання кроками. Готової відповіді не давай, якщо учень її не просить.',
  notebook:
    'Дай відповідь для запису в зошит: акуратно й коротко, з розв’язанням так, як прийнято записувати в зошиті. Після неї одним-двома реченнями поясни головну ідею.',
};

export const clip = (s, max) => {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) + '…[обрізано]' : t;
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HTML учителя → простий текст (main-процес, без DOM). Теги й атрибути відкидаються повністю. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/tr|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
      e[0] === '#'
        ? String.fromCodePoint(
            e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1),
          )
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Блоки вмісту ДЗ (src/blocks.js, публічна форма) → текст для моделі. Адрес файлів і зображень у ньому немає. */
export function blocksToText(blocks) {
  return (blocks ?? [])
    .map((b) => {
      switch (b.kind) {
        case 'heading':
          return b.text;
        case 'html':
        case 'table':
          return htmlToText(b.html);
        case 'text':
          return [b.title, b.text].filter(Boolean).join('\n');
        case 'formula':
          return `Формула: ${b.text}`;
        case 'image':
          return `[зображення${b.caption ? ': ' + b.caption : ''}]`;
        case 'file':
          return `[файл: ${b.name}]`;
        case 'link':
          return `[посилання: ${b.title || b.domain}]`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

/** Короткий опис завдання (без вмісту) — для списків у результатах інструментів і контексту ходу. */
export const taskSummary = (t) => ({
  task_id: t.id,
  subject: t.subject,
  theme: t.themeTitle || '',
  type: t.typeName || '',
  status: t.status,
  deadline: t.deadline == null ? null : formatDateTime(t.deadline),
  grade: t.grade ?? null,
});

/**
 * Текст ходу учня: дата (тут, а не в системному промпті, щоб той лишався незмінним), режим кнопки й поточне ДЗ.
 * @param {{ text: string, now: number, mode?: keyof MODES, task?: any, taskBlocks?: any[] }} p
 */
export function buildUserTurn({ text, now, mode = 'chat', task = null, taskBlocks = null }) {
  const lines = [`[Зараз: ${formatDay(now)}, ${formatTime(now)} (Київ)]`];
  if (task) {
    const s = taskSummary(task);
    lines.push(
      `[Поточне завдання #${s.task_id}: ${s.subject}${s.theme ? ', тема «' + s.theme + '»' : ''}${s.deadline ? ', здати до ' + s.deadline : ''}, статус ${s.status}]`,
    );
    const body = taskBlocks ? blocksToText(taskBlocks) : '';
    if (body) lines.push(`[Текст завдання]\n${clip(body, LIMITS.taskChars)}`);
  }
  if (MODES[mode]) lines.push(`[Що потрібно] ${MODES[mode]}`);
  const t = clip(String(text ?? '').trim(), LIMITS.userChars);
  if (t) lines.push(t);
  return { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] };
}

/** Хід учня — повідомлення user з текстом (не з результатами інструментів). */
const isUserTurn = (m) => m?.role === 'user' && m.content?.some((b) => b.type === 'text');

/**
 * Останні N повідомлень. Обрізаємо лише по межі ходу учня, щоб пари tool_use/tool_result не розривались.
 * Блоків міркувань (raw) у збереженій історії немає: попередні ходи йдуть без них.
 */
export function trimHistory(messages, n = LIMITS.historyMessages) {
  const list = (messages ?? []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
  let start = Math.max(0, list.length - n);
  while (start < list.length && !isUserTurn(list[start])) start++;
  return list.slice(start).map(({ role, content }) => ({ role, content }));
}

/** Результат інструмента → текст для моделі (JSON, обрізаний). */
export function toolResultText(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return clip(s, LIMITS.toolChars);
}

/** Текст сторінки книги для моделі. */
export const pageText = (text) => clip(String(text ?? ''), LIMITS.pageChars);

/** Для збереження: зображення замінюємо позначкою (дані сторінки на диску в історії не лежать). */
export function stripForStorage(msg) {
  return {
    role: msg.role,
    content: msg.content.map((b) =>
      b.type === 'tool_result' && b.image
        ? { ...b, image: undefined, text: b.text + '\n[зображення сторінки]' }
        : b,
    ),
  };
}

/**
 * Повний запит до провайдера. Порядок: системний промпт (незмінний) → інструменти (незмінні) → історія → новий хід.
 * @returns {{ system: string, tools: any[], messages: any[], maxTokens: number }}
 */
export function buildRequest({ history, tools }) {
  return { system: SYSTEM_PROMPT, tools, messages: history, maxTokens: LIMITS.maxTokens };
}
