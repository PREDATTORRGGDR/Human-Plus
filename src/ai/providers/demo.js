// Демо-провайдер для `npm run demo` і скриншотів: без мережі й ключа, відповідає за сценарієм і викликає інструменти,
// щоб було видно потік, картки й кнопки. Справжньої моделі тут немає.
const pause = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      'abort',
      () => (clearTimeout(t), rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
    );
  });

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].content.find((b) => b.type === 'text');
    if (messages[i].role === 'user' && t) return t.text;
  }
  return '';
}

export function createDemoProvider() {
  return {
    id: 'demo',
    model: 'demo',
    vision: false,
    async turn({ messages, signal, onText }) {
      const last = messages[messages.length - 1];
      const afterTools = last.content.some((b) => b.type === 'tool_result');
      const q = lastUserText(messages).toLocaleLowerCase('uk');
      if (!afterTools) {
        const name = /оцінк/.test(q)
          ? 'get_grades'
          : /розклад|урок/.test(q)
            ? 'get_schedule'
            : 'get_homework';
        const input =
          name === 'get_homework' && /#(\d+)/.test(q) ? { task_id: +/#(\d+)/.exec(q)[1] } : {};
        return {
          blocks: [{ type: 'tool_use', id: 'demo-' + Date.now(), name, input }],
          raw: null,
          stopReason: 'tool_use',
          usage: { input: 0, output: 0 },
        };
      }
      const text = /для запису в зошит/.test(q)
        ? 'Ось як це можна записати в зошит (демо-відповідь):\n\n1. Умова: коротко переписати, що дано.\n2. Розв’язання: кроки з поясненням.\n3. Відповідь: підсумок одним рядком.\n\n**Головна ідея:** спершу визначаємо, що шукаємо, і лише потім рахуємо.'
        : 'Це демо-асистент: справжньої моделі тут немає. У картці вище — дані з демо-розкладу.\n\nЩоб розібратися із завданням:\n1. Прочитай умову й випиши, що дано.\n2. Знайди правило в підручнику (вкладка «Книги»).\n3. Спробуй перший крок сам, а я підкажу далі.';
      for (const part of text.match(/.{1,12}/gsu)) {
        await pause(25, signal);
        onText?.(part);
      }
      return {
        blocks: [{ type: 'text', text }],
        raw: null,
        stopReason: 'end',
        usage: { input: 0, output: 0 },
      };
    },
  };
}
