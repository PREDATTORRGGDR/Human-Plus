// HTTP Range для протоколу hp-file (потокове відтворення відео й аудіо). Чиста функція, тестується окремо.

/**
 * Розбирає заголовок Range для файлу розміром size. Підтримує один діапазон: «bytes=a-b», «bytes=a-», «bytes=-n».
 * @returns {{ status: 200|206|416, start: number, end: number, headers: Record<string,string> }}
 */
export function rangeResponse(size, header, mime = 'application/octet-stream') {
  const base = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const full = {
    status: 200,
    start: 0,
    end: size - 1,
    headers: { ...base, 'Content-Length': String(size) },
  };
  if (!header) return full;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return full; // кілька діапазонів чи інший формат — віддаємо весь файл
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end ||
    size === 0
  )
    return {
      status: 416,
      start: 0,
      end: -1,
      headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
    };
  return {
    status: 206,
    start,
    end,
    headers: {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  };
}
