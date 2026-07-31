'use strict';

// Собирает ZIP для загрузки в Chrome Web Store. Кладём только то, что нужно
// расширению: тесты, CI и материалы разработки в пакет попадать не должны —
// они увеличивают вес и попадают в ревью магазина.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

// Ровно те файлы, что перечислены в манифесте, плюс ресурсы, на которые они
// ссылаются. Список явный, а не «всё кроме»: так забытый служебный файл не
// уедет в магазин молча.
const INCLUDE = [
  'manifest.json',
  'background.js',
  'bridge.js',
  'main.js',
  'preload.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'worklets',
  '_locales',
  'icons',
];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(
    `версии разошлись: manifest.json ${manifest.version}, package.json ${pkg.version}`
  );
  process.exit(1);
}

// В пакет уезжает собранный main.js. Если он разошёлся с частями в src/main,
// то в магазин ушёл бы код, которого нет в исходнике, — отказываемся.
const { build } = require('./build-main.js');
if (fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8') !== build()) {
  console.error(
    'main.js разошёлся с src/main — выполните npm run build:main перед упаковкой'
  );
  process.exit(1);
}

const missing = INCLUDE.filter((entry) => !fs.existsSync(path.join(ROOT, entry)));
if (missing.length) {
  console.error(`нет файлов: ${missing.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const zipName = `youtube-exponential-volume-${manifest.version}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
fs.rmSync(zipPath, { force: true });

try {
  execFileSync('zip', ['-r', '-q', '-X', zipPath, ...INCLUDE], { cwd: ROOT });
} catch (error) {
  // В Windows утилита zip обычно отсутствует, зато системный bsdtar умеет
  // выбирать ZIP по расширению через -a. Ошибки самого zip не маскируем:
  // fallback нужен только когда исполняемый файл действительно не найден.
  if (process.platform !== 'win32' || error.code !== 'ENOENT') throw error;
  execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, ...INCLUDE], { cwd: ROOT });
}

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`собрано: dist/${zipName} (${size} КБ)`);
console.log('в пакете:', INCLUDE.join(', '));
