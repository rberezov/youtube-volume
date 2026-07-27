'use strict';

// В живом интерфейсе Shorts строка кнопок отключает указатель целиком, а
// каждая кнопка включает его себе сама. Наш блок наследовал запрет, и клики
// проваливались в видео. Макет по умолчанию этого условия не воспроизводит,
// поэтому доводим его здесь — иначе проверка бессмысленна.
//
// Вторая половина файла — про две точки монтирования. В штатной строке блок
// обязан жить по её правилам (он заменил штатный регулятор и должен вести
// себя как соседи), а на накладном слое — прятаться вместе с уходом
// указателя с ролика.

const path = require('node:path');
const { bootScript, createReporter, loadPlaywright } = require('./harness');

const SHORTS = require(path.join(__dirname, 'fixtures', 'shorts.js'));

const withDeadPointerEvents = SHORTS.replace(
  '.player-controls { position: absolute; top: 12px; left: 12px; z-index: 10; }',
  '.player-controls { position: absolute; top: 12px; left: 12px; z-index: 10;\n' +
    '    pointer-events: none; }\n' +
    '  #play-pause-button-shape button, .ytdVolumeControlsMuteIconButton {\n' +
    '    pointer-events: auto; }'
);

const bare = withDeadPointerEvents.replace(
  /<ytd-shorts-player-controls[\s\S]*?<\/ytd-shorts-player-controls>/,
  ''
);

const { chromium } = loadPlaywright();
const reporter = createReporter('shorts-clicks: нажатия и обе точки монтирования');
const { check } = reporter;
const errors = [];

async function openShorts(browser, html) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html })
  );
  await page.goto('https://www.youtube.com/shorts/abc');
  await page.addScriptTag({ content: bootScript({ settings: { shortsScale: 50 } }) });
  await page.mouse.move(700, 400);
  await page.waitForTimeout(1000);
  return page;
}

(async () => {
  const browser = await chromium.launch();

  const page = await openShorts(browser, withDeadPointerEvents);
  check('блок построен', await page.evaluate(() => !!document.querySelector('.ytev-box')));

  const hit = await page.evaluate(() => {
    const button = document.querySelector('.ytev-mute');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const element = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return {
      ours: !!(element && element.closest('.ytev-box')),
      pointerEvents: getComputedStyle(button).pointerEvents,
    };
  });
  check('указатель попадает в наш блок, а не в видео', hit && hit.ours, JSON.stringify(hit));
  check('кнопка принимает указатель', hit && hit.pointerEvents === 'auto');

  const before = await page.evaluate(() => document.querySelector('video').volume);
  await page.click('.ytev-mute');
  await page.waitForTimeout(300);
  check(
    'клик по кнопке глушит звук',
    await page.evaluate(() => document.querySelector('video').muted === true)
  );
  await page.click('.ytev-mute');
  await page.waitForTimeout(300);
  check(
    'повторный клик возвращает звук',
    await page.evaluate(() => document.querySelector('video').muted === false)
  );

  const box = await page.locator('.ytev-slider').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await page.evaluate(() => document.querySelector('video').volume);
  check('протяжка ползунка меняет громкость', afterDrag > before + 0.1, `${before} → ${afterDrag}`);

  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(250);
  check(
    'колесо над блоком работает',
    (await page.evaluate(() => Number(document.querySelector('.ytev-slider').value))) >
      afterDrag * 100
  );

  await page.mouse.move(20, 880);
  await page.waitForTimeout(700);
  const inRow = await page.evaluate(() => {
    const box = document.querySelector('.ytev-box');
    const sibling = document.querySelector('#play-pause-button-shape');
    return {
      mountedInRow: !!(box && box.closest('ytd-shorts-player-controls')),
      boxOpacity: box ? getComputedStyle(box).opacity : null,
      siblingOpacity: sibling ? getComputedStyle(sibling).opacity : null,
    };
  });
  check('блок встал в штатную строку', inRow.mountedInRow);
  check(
    'в строке видимость совпадает с соседней кнопкой',
    inRow.boxOpacity === inRow.siblingOpacity,
    JSON.stringify(inRow)
  );
  await page.close();

  const overlayPage = await openShorts(browser, bare);
  const mounted = await overlayPage.evaluate(() => {
    const box = document.querySelector('.ytev-box');
    return {
      overlay: !!document.querySelector('.ytev-overlay .ytev-box'),
      opacity: box ? getComputedStyle(box).opacity : null,
    };
  });
  check('без строки кнопок используется накладной слой', mounted.overlay, JSON.stringify(mounted));
  check('на слое блок виден при указателе на ролике', Number(mounted.opacity) === 1);

  await overlayPage.mouse.move(20, 880);
  await overlayPage.waitForTimeout(900);
  const hidden = await overlayPage.evaluate(() => {
    const box = document.querySelector('.ytev-box');
    if (!box) return { gone: true };
    return { opacity: getComputedStyle(box).opacity };
  });
  check(
    'на слое указатель ушёл — блок скрыт',
    hidden.gone || Number(hidden.opacity) === 0,
    JSON.stringify(hidden)
  );
  await overlayPage.close();

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
