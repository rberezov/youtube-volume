'use strict';

// Рассинхрон ключей — самая частая поломка локализации: строку добавили в
// разметку и в одну локаль, а во второй её нет, и пользователь видит пустое
// место. Проверяем все три источника ключей сразу.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ru'];

const messages = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(
      fs.readFileSync(path.join(ROOT, '_locales', locale, 'messages.json'), 'utf8')
    ),
  ])
);

// 1. Наборы ключей во всех локалях совпадают.
const reference = Object.keys(messages.en).sort();
for (const locale of LOCALES) {
  assert.deepEqual(
    Object.keys(messages[locale]).sort(),
    reference,
    `_locales/${locale}: набор ключей разошёлся с en`
  );
  for (const [key, entry] of Object.entries(messages[locale])) {
    assert.equal(
      typeof entry.message,
      'string',
      `_locales/${locale}: у ключа ${key} нет строки message`
    );
    assert.ok(entry.message.length, `_locales/${locale}: ключ ${key} пуст`);
  }
}

// 2. Подстановки объявлены одинаково и упомянуты в самом тексте.
for (const key of reference) {
  const placeholders = LOCALES.map((locale) =>
    Object.keys(messages[locale][key].placeholders || {}).sort()
  );
  assert.deepEqual(
    placeholders[0],
    placeholders[1],
    `ключ ${key}: наборы placeholders в локалях не совпадают`
  );
  for (const locale of LOCALES) {
    for (const name of Object.keys(messages[locale][key].placeholders || {})) {
      assert.ok(
        messages[locale][key].message.includes(`$${name.toUpperCase()}$`),
        `_locales/${locale}: ключ ${key} не использует подстановку ${name}`
      );
    }
  }
}

// 3. Каждый data-i18n из popup.html есть в локалях.
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const markup = [...popupHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
assert.ok(markup.length >= 20, `в popup.html размечено подозрительно мало строк: ${markup.length}`);
for (const key of markup) {
  for (const locale of LOCALES) {
    assert.ok(messages[locale][key], `_locales/${locale}: нет ключа ${key} из popup.html`);
  }
}

// 4. В popup.html не осталось неразмеченного русского текста.
const stripped = popupHtml
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]*data-i18n="[^"]*"[^>]*>[^<]*</g, '<')
  .replace(/<[^>]*>/g, '');
const leftovers = stripped.match(/[А-Яа-яЁё][^<>]*/g);
assert.equal(
  leftovers,
  null,
  `в popup.html остался неразмеченный текст: ${JSON.stringify(leftovers)}`
);

// 5. Ключи, которые service worker передаёт в MAIN-мир, существуют в локалях,
//    а main.js знает ровно этот же набор: chrome.i18n там недоступен, и
//    забытый ключ означал бы пустую подпись у кнопки в плеере.
const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const keysBlock = background.match(/const STRING_KEYS = \[([\s\S]*?)\];/);
assert.ok(keysBlock, 'в background.js не найден STRING_KEYS');
const sentKeys = [...keysBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
for (const key of sentKeys) {
  for (const locale of LOCALES) {
    assert.ok(messages[locale][key], `_locales/${locale}: нет ключа ${key} из background.js`);
  }
}

const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const stringsBlock = mainSource.match(/const STRINGS = \{([\s\S]*?)\n  \};/);
assert.ok(stringsBlock, 'в main.js не найден STRINGS');
const knownKeys = [...stringsBlock[1].matchAll(/^\s{4}(\w+):/gm)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  knownKeys,
  sentKeys,
  'наборы строк в main.js и background.js разошлись'
);

// 6. Значения по умолчанию в main.js используют те же подстановки, что локали:
//    иначе при неполном payload подсказка покажет сырой $VALUE$.
for (const key of sentKeys) {
  const fallback = stringsBlock[1].match(new RegExp(`${key}:\\s*'([^']*)'`));
  assert.ok(fallback, `в main.js нет значения по умолчанию для ${key}`);
  const expected = (messages.ru[key].message.match(/\$[A-Z]+\$/g) || []).sort();
  const actual = (fallback[1].match(/\$[A-Z]+\$/g) || []).sort();
  assert.deepEqual(
    actual,
    expected,
    `main.js: подстановки в запасном значении ${key} расходятся с локалью`
  );
}

// 7. Запасные строки popup тоже должны существовать в локалях: они нужны
//    только на случай сбоя chrome.i18n и не должны жить своей жизнью.
const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const fallbackBlock = popupSource.match(/const FALLBACK = \{([\s\S]*?)\n\};/);
assert.ok(fallbackBlock, 'в popup.js не найден FALLBACK');
for (const match of fallbackBlock[1].matchAll(/^\s{2}(\w+):/gm)) {
  const key = match[1];
  for (const locale of LOCALES) {
    assert.ok(messages[locale][key], `_locales/${locale}: нет ключа ${key} из popup.js`);
  }
}

console.log('i18n consistency test passed');
