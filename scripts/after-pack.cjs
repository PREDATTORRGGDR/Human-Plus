// electron-builder afterPack: вшиває наш значок і відомості про версію в Human Plus.exe.
// Власний шаг замість вбудованого (signAndEditExecutable), якому потрібні права на створення симлінків у Windows.
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = require('rcedit');
  const info = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`);
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, 'build', 'icon.ico'),
    'file-version': info.version,
    'product-version': info.version,
    'version-string': {
      ProductName: info.productName,
      FileDescription: `${info.productName} — неофіційний клієнт для HUMAN Школа`,
      InternalName: info.productName,
      OriginalFilename: `${info.productFilename}.exe`,
      LegalCopyright: 'MIT',
    },
  });
};
