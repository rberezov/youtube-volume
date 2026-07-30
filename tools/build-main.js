'use strict';

// Сборка main.js из частей в src/main.
//
// Почему вообще сборка, а не обычные модули. main.js — не файл, который
// кто-то подключает: service worker передаёт **саму функцию**
// `youtubeVolumeMain` в `chrome.scripting.executeScript`, а тот сериализует
// её исходник и выполняет в MAIN-мире страницы. В том мире нет ни модулей,
// ни `chrome.runtime`, ни возможности что-то догрузить: CSP youtube.com
// отклоняет и blob-модуль, и любой посторонний скрипт. Значит вся логика
// обязана лежать внутри одной функции — это ограничение платформы, а не
// стиль.
//
// Поэтому разделение сделано там, где оно ничего не стоит: исходник живёт
// частями, а собранный main.js остаётся ровно тем же артефактом, что и
// раньше. Части — это срезы тела функции по границам разделов, поэтому
// сборка это буквально склейка: никаких подстановок, оборачиваний и
// переписывания кода, которые могли бы что-то изменить.
//
// Проверка на расхождение (`--check`) стоит и в тестах, и в сборщике
// пакета: артефакт в репозитории обязан совпадать с тем, что даёт склейка,
// иначе правка «мимо частей» уехала бы в магазин незаметно.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main');
const TARGET = path.join(ROOT, 'main.js');

function parts() {
  const names = fs
    .readdirSync(SRC)
    .filter((name) => /^\d\d-[a-z-]+\.js$/.test(name))
    .sort();
  if (!names.length) throw new Error(`в ${SRC} нет частей`);
  // Номер задаёт порядок и обязан быть сплошным: пропуск почти наверняка
  // означает потерянный при переименовании кусок, а не замысел.
  names.forEach((name, index) => {
    const number = Number(name.slice(0, 2));
    if (number !== index) {
      throw new Error(`нумерация частей разошлась: ожидался ${index}, а это ${name}`);
    }
  });
  return names;
}

function build() {
  return parts()
    .map((name) => fs.readFileSync(path.join(SRC, name), 'utf8'))
    .join('');
}

module.exports = { build, parts, TARGET };

if (require.main === module) {
  const built = build();
  if (process.argv.includes('--check')) {
    const current = fs.readFileSync(TARGET, 'utf8');
    if (current === built) {
      console.log('main.js совпадает со сборкой из src/main');
      process.exit(0);
    }
    console.error(
      'main.js разошёлся с src/main — правьте части и выполните npm run build:main'
    );
    process.exit(1);
  }
  fs.writeFileSync(TARGET, built);
  console.log(`main.js собран из ${parts().length} частей`);
}
