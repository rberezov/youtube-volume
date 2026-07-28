'use strict';

// preload.js на чистом профиле не должен ничего удерживать.
//
// В 1.14.2 уровень читался как Number(cached && cached.volume), а при
// отсутствующем кэше это даёт Number(null) === 0: preload считал ноль
// валидным уровнем и прижимал к нему физическую громкость до прихода
// main.js. На первой загрузке нового профиля ролик играл беззвучно.

const fs = require('node:fs');
const path = require('node:path');
const { createReporter, loadPlaywright, readSource } = require('./harness');

const WATCH = fs.readFileSync(path.join(__dirname, 'fixtures', 'watch.html'), 'utf8');

const { chromium } = loadPlaywright();
const reporter = createReporter('preload-silence: чистый профиль не даёт тишину');
const { check } = reporter;

async function probe(browser, { cache }) {
  const page = await browser.newPage();
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: WATCH })
  );
  await page.goto('https://www.youtube.com/watch?v=x');
  await page.evaluate((value) => {
    localStorage.clear();
    if (value) localStorage.setItem('ytev-volume-state-v1', value);
    // Нативный дескриптор запоминаем ДО инъекции: после неё «фактическую»
    // громкость прочитал бы уже подменённый геттер, и замер был бы ложным.
    window.__native = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'volume'
    );
  }, cache);
  await page.addScriptTag({ content: readSource('preload.js') });
  const result = await page.evaluate(() => {
    const video = document.querySelector('video');
    video.volume = 0.8; // YouTube восстанавливает свой уровень
    const current = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    return {
      patched: current.set !== window.__native.set,
      logical: video.volume,
      physical: window.__native.get.call(video),
      slotClaimed: !!window[Symbol.for('ytev.preload.instance.v1')],
    };
  });
  await page.close();
  return result;
}

(async () => {
  const browser = await chromium.launch();

  const empty = await probe(browser, { cache: null });
  check('без кэша перехват не ставится', empty.patched === false, JSON.stringify(empty));
  check('без кэша звук не пропадает', empty.physical === 0.8, `фактическая=${empty.physical}`);
  check('слот реестра всё равно занят', empty.slotClaimed === true);

  const broken = await probe(browser, { cache: '{oops' });
  check('битый кэш: перехват не ставится', broken.patched === false);
  check('битый кэш: звук не пропадает', broken.physical === 0.8);
  check('битый кэш: слот занят', broken.slotClaimed === true);

  const held = await probe(browser, {
    cache: JSON.stringify({ volume: 0.25, muted: false, enabled: true, gamma: 3 }),
  });
  check('с кэшем перехват ставится', held.patched === true);
  check(
    'с кэшем удерживается сохранённый уровень',
    Math.abs(held.physical - Math.pow(0.25, 3)) < 1e-9,
    `фактическая=${held.physical}`
  );

  const forged = await probe(browser, {
    cache: JSON.stringify({ volume: 1, muted: false, enabled: false, gamma: 1 }),
  });
  check(
    'поддельный кэш не поднимает ранний звук выше безопасного потолка',
    Math.abs(forged.physical - 0.5) < 1e-9,
    `фактическая=${forged.physical}`
  );

  await browser.close();
  process.exit(reporter.finish() ? 1 : 0);
})().catch((error) => {
  console.error('СБОЙ харнесса:', error.message);
  process.exit(1);
});
