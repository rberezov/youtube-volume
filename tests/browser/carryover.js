'use strict';

// Перенос громкости: уровень, выставленный на обычной странице, должен
// применяться в Shorts и обратно. YouTube ведёт их состояние порознь,
// поэтому общий уровень держит расширение. Общее хранилище моделируем
// одним объектом на обе вкладки — как chrome.storage.local в бою.

const path = require('node:path');
const {
  bootScript,
  chromeStub,
  createReporter,
  dragSlider,
  loadPlaywright,
  readSource,
  waitFor,
} = require('./harness');

const WATCH = require('node:fs').readFileSync(
  path.join(__dirname, 'fixtures', 'watch.html'),
  'utf8'
);
const SHORTS = require(path.join(__dirname, 'fixtures', 'shorts.js'));

const { chromium } = loadPlaywright();
const reporter = createReporter('carryover: громкость и mute между watch и Shorts');
const { check } = reporter;
const errors = [];
const store = { savedVolume: null, savedMuted: null };

async function openPage(browser, html, url) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('__persist', (value) => Object.assign(store, value));
  await page.exposeFunction('__load', () => store);
  await page.addInitScript(chromeStub);
  await page.addInitScript(() => {
    window.__onWrite = (value) => window.__persist(value);
  });
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html })
  );
  await page.goto(url);
  await page.addScriptTag({ content: readSource('bridge.js') });
  const init = await page.evaluate(() => window.__init);
  const state = await page.evaluate(() => window.__load());
  await page.addScriptTag({
    content: bootScript({
      settings: { sliderScale: 30, shortsScale: 50 },
      state,
      channel: init.channel,
      secret: init.secret,
    }),
  });
  await page.waitForTimeout(900);
  return page;
}

const volumeOf = (page) =>
  page.evaluate(() => +Number(document.querySelector('video').volume).toFixed(3));

(async () => {
  const browser = await chromium.launch();

  let page = await openPage(browser, WATCH, 'https://www.youtube.com/watch?v=x');
  await page.evaluate(() => (document.getElementById('movie_player').style.width = '1280px'));
  await page.waitForTimeout(300);
  await dragSlider(page, 0.7);
  const watchLevel = await volumeOf(page);
  check('уровень выставлен на watch', watchLevel > 0.5, `${watchLevel}`);
  // Запись идёт через дебаунс в main.js и ещё один в bridge — ждём её, а не
  // спим наугад: на нагруженной машине фиксированная пауза не дожидалась.
  await waitFor(() => store.savedVolume !== null, { what: 'записи уровня' });
  check('уровень сохранён в хранилище', store.savedVolume !== null, JSON.stringify(store));
  await page.close();

  page = await openPage(browser, SHORTS, 'https://www.youtube.com/shorts/abc');
  await page.mouse.move(700, 400);
  await page.waitForTimeout(600);
  const shortsLevel = await volumeOf(page);
  check(
    'Shorts подхватил уровень с watch',
    Math.abs(shortsLevel - watchLevel) < 0.01,
    `${watchLevel} → ${shortsLevel}`
  );

  await dragSlider(page, 0.25);
  const shortsChanged = await volumeOf(page);
  check(
    'уровень изменён в Shorts',
    Math.abs(shortsChanged - shortsLevel) > 0.1,
    `${shortsLevel} → ${shortsChanged}`
  );
  await page.click('.ytev-mute');
  await waitFor(() => store.savedMuted === true, { what: 'записи mute' });
  check('mute в Shorts сохранён', store.savedMuted === true, JSON.stringify(store));
  await page.close();

  page = await openPage(browser, WATCH, 'https://www.youtube.com/watch?v=x');
  await page.evaluate(() => (document.getElementById('movie_player').style.width = '1280px'));
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => ({
    volume: +Number(document.querySelector('video').volume).toFixed(3),
    muted: document.querySelector('video').muted,
  }));
  check(
    'watch подхватил уровень из Shorts',
    Math.abs(back.volume - shortsChanged) < 0.01,
    `${shortsChanged} → ${back.volume}`
  );
  check('watch подхватил mute из Shorts', back.muted === true, JSON.stringify(back));
  await page.close();

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
