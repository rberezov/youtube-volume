'use strict';

// Значения по умолчанию объявлены в четырёх местах: service worker раздаёт их
// странице, popup показывает их в интерфейсе, main.js использует как
// стартовые до прихода payload, браузерные тесты поднимают с ними страницу.
// Разъезжались они уже дважды — при смене sliderScale 20 → 7 и autoCollapse
// false → true, и каждый раз это выглядело как «настройка не применяется».

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Достаём литерал объекта из исходника: `const ИМЯ = { ... };` до строки,
// где закрывающая скобка стоит на том же отступе, что и объявление.
function readDefaults(file, name) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\n\\s*\\});`)
  );
  assert.ok(match, `в ${file} не найден объект ${name}`);
  // Литерал содержит построчные комментарии — их переживёт обычный разбор JS.
  return new Function(`return ${match[1]}`)();
}

const sources = {
  'background.js': readDefaults('background.js', 'DEFAULTS'),
  'popup.js': readDefaults('popup.js', 'DEFAULTS'),
  'main.js': readDefaults('main.js', 'SETTINGS'),
  'tests/browser/harness.js': readDefaults(
    'tests/browser/harness.js',
    'DEFAULT_SETTINGS'
  ),
};

const reference = sources['background.js'];
const keys = Object.keys(reference).sort();

assert.deepEqual(
  keys,
  [
    'autoCollapse',
    'enabled',
    'gamma',
    'normalizeLoudness',
    'shortsScale',
    'showPercent',
    'sliderScale',
    'useNativeSlider',
  ],
  'набор настроек в background.js изменился — обновите остальные объявления'
);

for (const [file, values] of Object.entries(sources)) {
  assert.deepEqual(
    Object.keys(values).sort(),
    keys,
    `${file}: набор ключей разошёлся с background.js`
  );
  for (const key of keys) {
    assert.equal(
      values[key],
      reference[key],
      `${file}: ${key} = ${values[key]}, а в background.js ${reference[key]}`
    );
  }
}

// Диапазоны ползунков в popup должны вмещать значения по умолчанию, иначе
// браузер молча подрежет их при первом открытии настроек.
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
for (const [id, value] of [
  ['gamma', reference.gamma],
  ['sliderScale', reference.sliderScale],
  ['shortsScale', reference.shortsScale],
]) {
  const input = popupHtml.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  assert.ok(input, `в popup.html не найден ползунок ${id}`);
  const min = Number((input[0].match(/min="([^"]+)"/) || [])[1]);
  const max = Number((input[0].match(/max="([^"]+)"/) || [])[1]);
  assert.ok(
    value >= min && value <= max,
    `popup.html: ${id} по умолчанию ${value} вне диапазона ${min}..${max}`
  );
}

// Версия объявлена в манифесте и в package.json; сборщик пакета откажется
// работать при расхождении, но поймать его лучше на тестах, а не при выкладке.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.equal(
  manifest.version,
  pkg.version,
  `версии разошлись: manifest.json ${manifest.version}, package.json ${pkg.version}`
);

// Файлы, которые перечислены в манифесте, обязаны существовать: опечатка в
// имени скрипта ломает расширение только при установке.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  ...Object.values(manifest.icons),
];
for (const file of referenced) {
  assert.ok(
    fs.existsSync(path.join(ROOT, file)),
    `manifest.json ссылается на несуществующий файл ${file}`
  );
}

console.log('defaults consistency test passed');
