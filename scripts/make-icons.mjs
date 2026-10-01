// npm run icons: аватарка продукту → build/icon.png (512), build/icon.ico (16–256), build/tray.png (16) і tray@2x.png (32), src/avatar.png (128).
// Джерело: build/icon.svg: один дизайн для всіх розмірів (світле кільце, щоб значок не губився на темному тлі).
// Якщо є build/avatar.png (оригінал від власника проєкту), він береться як основа, а кільце додається поверх.
// Результат лежить у репозиторії, тож для збирання застосунку sharp не потрібен.
import fs from 'node:fs';
import sharp from 'sharp';

const avatar = fs.existsSync('build/avatar.png') ? fs.readFileSync('build/avatar.png') : null;
const svgBig = fs.readFileSync('build/icon.svg');

/** Квадратне зображення потрібного розміру в колі (кути прозорі). Малі розміри — з кільцем. */
async function render(size) {
  const small = size <= 64; // для растрового оригіналу: кільце товстіше на малих розмірах
  let img;
  if (avatar) {
    const ring = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - size * 0.035}" fill="none" stroke="#f2f4f8" stroke-width="${size * (small ? 0.07 : 0.03)}"/></svg>`,
    );
    img = sharp(avatar)
      .resize(size, size, { fit: 'cover' })
      .composite([{ input: ring }]);
  } else img = sharp(svgBig, { density: 384 }).resize(size, size);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`,
  );
  return img
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** ICO з PNG-зображеннями всередині (підтримується Windows Vista+). */
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const dir = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;
    e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)]);
}

fs.writeFileSync('build/icon.png', await render(512));
fs.writeFileSync(
  'build/icon.ico',
  ico(
    await Promise.all(
      [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, data: await render(size) })),
    ),
  ),
);
fs.writeFileSync('build/tray.png', await render(16));
fs.writeFileSync('build/tray@2x.png', await render(32));
fs.writeFileSync('build/tray@3x.png', await render(48));
fs.writeFileSync(
  'src/avatar.png',
  (await render(64)) &&
    (await sharp(await render(64))
      .resize(128, 128)
      .png()
      .toBuffer()),
);
console.log(`Іконки готові (джерело: ${avatar ? 'build/avatar.png' : 'build/icon.svg'})`);
