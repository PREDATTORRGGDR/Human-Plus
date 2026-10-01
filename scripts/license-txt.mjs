// LICENSE → build/license.txt з BOM: NSIS показує кирилицю лише в UTF-8 з BOM. Запускається перед `npm run dist`.
import fs from 'node:fs';

fs.writeFileSync('build/license.txt', '\uFEFF' + fs.readFileSync('LICENSE', 'utf8'));
