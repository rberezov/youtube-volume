'use strict';

// Окно настроек должно помещаться целиком.
//
// Chrome обрезает попап на 600px и добавляет полосу прокрутки. Проверки на
// это не было, и высота успела уехать за предел незаметно: к моменту, когда
// это заметили, попап был уже 606px и прокручивался. Здесь меряется худший
// случай — все строки видимы, подписи на русском (они длиннее английских).

const path = require('node:path');
const { createReporter, loadPlaywright } = require('./harness');

// Предел Chrome для попапа расширения.
const MAX_HEIGHT = 600;
const POPUP = 'file://' + path.resolve(__dirname, '..', '..', 'popup.html');

// chrome.* в попапе: настройки отдаём как есть, запись глотаем. i18n
// возвращает пустую строку — тогда остаются запасные подписи из разметки,
// то есть русские, и меряется именно длинный вариант.
function chromeStub(settings) {
  window.chrome = {
    i18n: { getMessage: () => '' },
    storage: {
      sync: {
        get: (defaults, cb) => cb({ ...defaults, ...settings }),
        set: (value, cb) => cb && cb(),
      },
    },
    runtime: { lastError: null },
  };
}

const { chromium } = loadPlaywright();
const reporter = createReporter('popup-fit: окно настроек помещается целиком');
const { check } = reporter;
const errors = [];

async function open(browser, settings) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(chromeStub, settings);
  await page.goto(POPUP);
  await page.waitForTimeout(200);
  return page;
}

const measure = (page) =>
  page.evaluate(() => ({
    height: document.body.scrollHeight,
    delayRow: !document.getElementById('collapseDelayRow').hidden,
    ownRows: [...document.querySelectorAll('.own-only')].filter((el) => !el.hidden).length,
  }));

(async () => {
  const browser = await chromium.launch();

  // Худший случай: своя шкала и включённое автосворачивание — видны все
  // строки, включая подчинённую «Задержка перед сворачиванием».
  const full = await open(browser, { autoCollapse: true, useNativeSlider: false });
  const widest = await measure(full);
  check(
    'попап помещается в предел Chrome',
    widest.height <= MAX_HEIGHT,
    `${widest.height}px при пределе ${MAX_HEIGHT}px`
  );
  check(
    'в худшем случае видны все строки',
    widest.delayRow && widest.ownRows >= 3,
    JSON.stringify(widest)
  );
  await full.close();

  // Задержка уточняет автосворачивание: без него строка не нужна.
  const noCollapse = await open(browser, { autoCollapse: false, useNativeSlider: false });
  const withoutCollapse = await measure(noCollapse);
  check(
    'без автосворачивания строка задержки скрыта',
    !withoutCollapse.delayRow,
    JSON.stringify(withoutCollapse)
  );
  await noCollapse.close();

  const native = await open(browser, { autoCollapse: true, useNativeSlider: true });
  const withNative = await measure(native);
  check(
    'в режиме штатной шкалы строка задержки тоже скрыта',
    !withNative.delayRow && withNative.ownRows === 0,
    JSON.stringify(withNative)
  );
  check(
    'в режиме штатной шкалы попап только ниже',
    withNative.height < widest.height,
    `${withNative.height}px против ${widest.height}px`
  );
  await native.close();

  // Переключение прямо в попапе тоже должно прятать строку, а не только
  // начальная отрисовка.
  const live = await open(browser, { autoCollapse: true, useNativeSlider: false });
  // Сам <input> накрыт декоративной дорожкой переключателя, поэтому
  // нажимаем на подпись — как это делает пользователь.
  await live.click('label[for="autoCollapse"]');
  await live.waitForTimeout(100);
  const afterToggle = await measure(live);
  check(
    'выключение автосворачивания прячет строку сразу',
    !afterToggle.delayRow,
    JSON.stringify(afterToggle)
  );
  await live.close();

  await browser.close();
  if (errors.length) {
    console.log('pageerrors:', errors);
    for (const error of errors) reporter.fail(`исключение на странице: ${error}`);
  } else {
    console.log('pageerrors: нет');
  }
  process.exit(reporter.finish() ? 1 : 0);
})().catch((error) => {
  console.error('СБОЙ харнесса:', error.message);
  process.exit(1);
});
