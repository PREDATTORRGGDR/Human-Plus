// Лічильник для оверлея на панелі завдань Windows: червоне коло з цифрами 16×16, піксельний шрифт 3×5.
const DIGITS = {
  '+': '000010111010000',
  0: '111101101101111',
  1: '010110010010111',
  2: '111001111100111',
  3: '111001111001111',
  4: '101101111001001',
  5: '111100111001111',
  6: '111100111101111',
  7: '111001010010010',
  8: '111101111101111',
  9: '111101111001111',
};

/** BGRA-бітмап 16×16 для nativeImage.createFromBitmap. Для n > 99 малює «99+» як «9+». */
export function badgeBitmap(n, size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const put = (x, y, r, g, b) => {
    const i = (y * size + x) * 4;
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = 255;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x - c) ** 2 + (y - c) ** 2 <= (size / 2) ** 2) put(x, y, 0xc6, 0x28, 0x28);
  const text = n > 99 ? '9+' : String(n);
  const glyphs = text.split('').map((ch) => DIGITS[ch] ?? '000000000000000');
  const w = glyphs.length * 4 - 1;
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - 5) / 2);
  glyphs.forEach((g, gi) => {
    for (let i = 0; i < 15; i++)
      if (g[i] === '1') put(x0 + gi * 4 + (i % 3), y0 + Math.floor(i / 3), 255, 255, 255);
  });
  return buf;
}
