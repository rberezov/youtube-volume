'use strict';

// Общая обвязка браузерных тестов.
//
// Раньше каждый харнесс поднимал страницу сам, и когда main.js сменил
// сигнатуру (стал функцией, которую внедряет service worker, вместо IIFE с
// настройками через postMessage), половина файлов молча перестала что-либо
// проверять: блок просто не строился, а тесты продолжали «проходить».
// Поэтому подъём страницы, boot-строка, дефолты настроек и моки chrome.*
// живут здесь в одном экземпляре.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const readSource = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const WATCH_HTML = fs.readFileSync(path.join(FIXTURES, 'watch.html'), 'utf8');
const SHORTS_HTML = require(path.join(FIXTURES, 'shorts.js'));

// Ровно те же значения, что в background.js, popup.js и main.js. Совпадение
// сторожит tests/defaults-consistency.test.cjs: дефолты уже разъезжались при
// смене sliderScale 20 → 7 и autoCollapse false → true.
const DEFAULT_SETTINGS = {
  enabled: true,
  gamma: 3,
  sliderScale: 7,
  shortsScale: 11,
  showPercent: true,
  autoCollapse: true,
  collapseDelay: false,
  useNativeSlider: false,
  normalizeLoudness: false,
};

// Браузерные тесты меряют и щупают развёрнутый блок, поэтому по умолчанию
// сворачивание выключено. Это единственное расхождение с продакшеном, и оно
// намеренное: со свёрнутым блоком ползунка попросту нет на экране.
const TEST_SETTINGS = { ...DEFAULT_SETTINGS, autoCollapse: false };

const CHANNEL = 'a'.repeat(32);
const SECRET = 'b'.repeat(64);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    // В окружении разработки Playwright может стоять глобально.
    const globalRoot = process.env.NODE_PATH || '/opt/node22/lib/node_modules';
    return require(path.join(globalRoot.split(path.delimiter)[0], 'playwright'));
  }
}

// Счётчик проверок одного файла: печатает результат и копит сбои, чтобы
// раннер увидел ненулевой код возврата.
function createReporter(title) {
  let failures = 0;
  if (title) console.log(`\n=== ${title} ===`);
  return {
    check(name, ok, detail) {
      if (!ok) failures += 1;
      console.log(`${ok ? '  ок  ' : ' СБОЙ '} ${name}${detail ? '  — ' + detail : ''}`);
    },
    section(name) {
      console.log(`--- ${name}`);
    },
    fail(reason) {
      failures += 1;
      console.log(` СБОЙ  ${reason}`);
    },
    finish() {
      console.log(failures ? `\nСБОЕВ: ${failures}` : '\nвсё зелено');
      return failures;
    },
  };
}

// Строка, которую в бою выполняет service worker через
// chrome.scripting.executeScript в MAIN-мире. Здесь она же — единственное
// место, где известна сигнатура youtubeVolumeMain.
function bootScript({ settings, state, channel = CHANNEL, secret = SECRET } = {}) {
  const payload = {
    channel,
    settings: { ...TEST_SETTINGS, ...settings },
    state: { savedVolume: 0.5, savedMuted: false, ...state },
  };
  return `
    ${readSource('main.js')}
    window.__ok = youtubeVolumeMain(${JSON.stringify(payload)}, ${JSON.stringify(secret)});
    window.__update = (patch) =>
      window[Symbol.for('ytev.main.instance.v2')].update(${JSON.stringify(secret)}, {
        settings: { ...${JSON.stringify(TEST_SETTINGS)}, ...patch },
      });
  `;
}

// Мок chrome.* для isolated-мира: bridge.js просит инъекцию через
// sendMessage и пишет состояние в storage.local. Записи копятся в
// window.__writes, канал и секрет — в window.__init.
//
// Функция уезжает в страницу через addInitScript и там сериализуется, так
// что ссылаться на замыкание внутри неё нельзя. Побочные эффекты вешаются
// снаружи: страница зовёт window.__onWrite, если тест его определил
// (например, через page.exposeFunction).
function chromeStub() {
  window.__writes = [];
  window.__init = null;
  window.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      sendMessage: (message) => {
        if (message && message.type === 'YTEV_INIT') window.__init = message;
      },
    },
    storage: {
      sync: { get: (defaults, cb) => cb(defaults) },
      local: {
        set: (value, cb) => {
          window.__writes.push(value);
          if (typeof window.__onWrite === 'function') window.__onWrite(value);
          cb && cb();
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
}

const PAGE_HTML = { watch: WATCH_HTML, shorts: SHORTS_HTML };

const PAGE_URL = {
  watch: 'https://www.youtube.com/watch?v=x',
  shorts: 'https://www.youtube.com/shorts/abc',
};

/**
 * Поднимает страницу-макет по настоящему адресу youtube.com (важно: main.js и
 * bridge.js смотрят на location.hostname и pathname) и внедряет запрошенные
 * куски расширения.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} options
 * @param {'watch'|'shorts'} options.page       какой макет поднять
 * @param {boolean} options.withBridge          внедрить bridge.js и мок chrome.*
 * @param {boolean|object} options.withMain     внедрить main.js (объект — настройки)
 * @param {number} options.playerWidth          ширина плеера в px
 * @param {(page: import('playwright').Page) => Promise<void>} options.before
 */
async function openPage(browser, options = {}) {
  const {
    page: kind = 'watch',
    withBridge = false,
    withMain = true,
    playerWidth = null,
    settings,
    state,
    before,
    errors,
  } = options;

  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  if (errors) {
    page.on('pageerror', (error) => errors.push(error.message));
  }
  if (withBridge) await page.addInitScript(chromeStub);
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE_HTML[kind] })
  );
  await page.goto(PAGE_URL[kind]);
  if (before) await before(page);
  if (withBridge) await page.addScriptTag({ content: readSource('bridge.js') });
  if (withMain) {
    // Когда рядом поднят bridge, канал и секрет берём у него — в бою их
    // выдаёт именно он, а main.js получает их через service worker.
    const init = withBridge ? await page.evaluate(() => window.__init) : null;
    await page.addScriptTag({
      content: bootScript({
        settings: typeof withMain === 'object' ? withMain : settings,
        state,
        channel: init ? init.channel : CHANNEL,
        secret: init ? init.secret : SECRET,
      }),
    });
  }
  if (playerWidth) {
    await page.evaluate((width) => {
      const player = document.getElementById('movie_player');
      if (player) player.style.width = width + 'px';
    }, playerWidth);
  }
  await page.waitForTimeout(900);
  return page;
}

// Настоящая протяжка ползунка мышью: синтетические input расширение
// игнорирует намеренно, поэтому проверять жесты можно только так.
async function dragSlider(page, fraction, selector = '.ytev-slider') {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`не найден ползунок ${selector}`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// Ожидание условия вместо фиксированной паузы. Запись громкости проходит
// через два дебаунса подряд (250мс в main.js и столько же в bridge), и на
// нагруженной машине она приходит позже любого разумного сна.
async function waitFor(condition, { timeout = 5000, step = 50, what = 'условия' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) throw new Error(`не дождались ${what} за ${timeout}мс`);
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

const videoVolume = (page) =>
  page.evaluate(() => +Number(document.querySelector('video').volume).toFixed(3));

const sliderValue = (page) =>
  page.evaluate(() => Number(document.querySelector('.ytev-slider').value));

// Единая точка входа для харнесса: поднимает браузер, ловит исключения и
// завершает процесс кодом, который поймёт раннер.
function run(title, body) {
  const { chromium } = loadPlaywright();
  const reporter = createReporter(title);
  const errors = [];
  (async () => {
    const browser = await chromium.launch();
    try {
      await body({ browser, reporter, errors });
    } finally {
      await browser.close();
    }
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
}

module.exports = {
  TEST_SETTINGS,
  bootScript,
  chromeStub,
  createReporter,
  dragSlider,
  loadPlaywright,
  openPage,
  readSource,
  run,
  sliderValue,
  videoVolume,
  waitFor,
};
