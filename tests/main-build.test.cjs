'use strict';

// main.js собирается из src/main/*.js, и артефакт в репозитории обязан
// совпадать со сборкой.
//
// Сторож нужен по двум причинам сразу. Первая скучная: правка «мимо частей»
// потерялась бы при следующей сборке. Вторая важнее — в магазин уезжает
// именно артефакт, и если бы он мог расходиться с исходником, то читающий
// части видел бы одно, а исполнялось бы другое. Здесь это просто невозможно:
// расхождение падает тестом.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { build, parts } = require('../tools/build-main.js');

const built = build();
const current = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

if (built !== current) {
  // Показываем первую разошедшуюся строку: «файлы не совпали» без места
  // ничего не объясняет.
  const a = current.split('\n');
  const b = built.split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
  assert.fail(
    `main.js разошёлся со сборкой из src/main на строке ${line + 1}:\n` +
      `  в main.js: ${JSON.stringify(a[line])}\n` +
      `  в сборке:  ${JSON.stringify(b[line])}\n` +
      'правьте части и выполните npm run build:main'
  );
}

// Части обязаны покрывать функцию целиком: первая начинает объявление,
// последняя закрывает его. Иначе склейка дала бы синтаксически битый файл, и
// понять это по одному только совпадению строк было бы нельзя.
const names = parts();
const first = fs.readFileSync(path.join(ROOT, 'src', 'main', names[0]), 'utf8');
const last = fs.readFileSync(
  path.join(ROOT, 'src', 'main', names[names.length - 1]),
  'utf8'
);
assert.ok(
  first.includes('function youtubeVolumeMain(initialPayload, updateSecret) {'),
  'первая часть должна открывать youtubeVolumeMain'
);
assert.equal(last.trimEnd().endsWith('}'), true, 'последняя часть должна закрывать функцию');

// Сама функция в MAIN-мир уезжает исходником, поэтому ни одна часть не имеет
// права сослаться на модульную систему: require/import там просто нет, а
// ошибка вылезла бы только в бою.
for (const name of names) {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main', name), 'utf8');
  assert.equal(
    /^\s*(?:const .*=\s*)?require\(|^\s*import\s|^\s*export\s/m.test(source),
    false,
    `${name}: в частях main.js не может быть require/import/export`
  );
}

console.log(`main build test passed (${names.length} частей)`);
