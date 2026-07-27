'use strict';

// Раскладка под давлением: сужение плеера, длинное название главы,
// полноэкранный режим, быстрые смены настроек. Ищем разъезд блока за
// пределы строки управления и потерю регулировки громкости.

const { openPage, run } = require('./harness');

// Что видно пользователю: влезает ли блок в строку и есть ли чем крутить
const probe = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('.ytev-box');
    const chrome = document.querySelector('.ytp-chrome-controls');
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
    const rect = box ? box.getBoundingClientRect() : null;
    const chromeRect = chrome ? chrome.getBoundingClientRect() : null;
    const slider = document.querySelector('.ytev-slider');
    const nativePanel = document.querySelector('.ytp-volume-panel');
    return {
      hasBox: !!box,
      overflowRight: rect && chromeRect ? Math.round(rect.right - chromeRect.right) : 0,
      overflowLeft: rect && chromeRect ? Math.round(chromeRect.left - rect.left) : 0,
      sliderW: slider ? Math.round(slider.getBoundingClientRect().width) : 0,
      labelShown: visible(document.querySelector('.ytev-label')),
      nativeBack: visible(nativePanel) || visible(document.querySelector('.ytp-mute-button')),
      controllable: !!slider || visible(nativePanel),
    };
  });

run('layout-stress: сужение, глава, полный экран, смены настроек', async ({
  browser,
  reporter,
  errors,
}) => {
  const { check } = reporter;
  const page = await openPage(browser, { settings: { sliderScale: 20 }, errors });

  const setWidth = async (width) => {
    await page.evaluate((value) => {
      document.getElementById('movie_player').style.width = value + 'px';
    }, width);
    await page.waitForTimeout(450);
  };

  reporter.section('сужение плеера');
  let everBroken = null;
  let labelHiddenAt = null;
  let nativeBackAt = null;
  for (const width of [1280, 1024, 860, 720, 600, 500, 420, 360, 300, 240]) {
    await setWidth(width);
    const state = await probe(page);
    if (state.overflowRight > 1 || state.overflowLeft > 1) {
      everBroken = everBroken || { width, ...state };
    }
    if (labelHiddenAt === null && state.hasBox && !state.labelShown) labelHiddenAt = width;
    if (nativeBackAt === null && state.nativeBack) nativeBackAt = width;
    if (!state.controllable) {
      check(`ширина ${width}: громкость регулируема`, false, JSON.stringify(state));
    }
    console.log(
      `   ${String(width).padStart(4)}px: блок=${state.hasBox ? 'да' : 'нет'}` +
        ` шкала=${String(state.sliderW).padStart(3)}px проценты=${state.labelShown ? 'да' : 'нет'}` +
        ` штатное=${state.nativeBack ? 'вернулось' : 'скрыто'}`
    );
  }
  check(
    'блок нигде не вылезает за строку управления',
    !everBroken,
    everBroken && JSON.stringify(everBroken)
  );
  check('проценты прячутся раньше отката', labelHiddenAt !== null, `при ${labelHiddenAt}px`);
  check(
    'в узком плеере возвращается штатная регулировка',
    nativeBackAt !== null,
    `при ${nativeBackAt}px`
  );
  check(
    'откат наступает позже скрытия процентов',
    labelHiddenAt === null || nativeBackAt === null || nativeBackAt <= labelHiddenAt,
    `проценты ${labelHiddenAt}px, откат ${nativeBackAt}px`
  );

  reporter.section('длинное название главы');
  await setWidth(1024);
  await page.evaluate(() => {
    document.querySelector('.ytp-chapter-container').textContent =
      'Очень длинное название главы, которое съедает всё свободное место в строке управления плеером';
  });
  await page.waitForTimeout(600);
  const chapter = await probe(page);
  check(
    'с длинной главой блок остаётся в строке',
    chapter.overflowRight <= 1 && chapter.overflowLeft <= 1,
    JSON.stringify(chapter)
  );
  check('с длинной главой громкость регулируема', chapter.controllable);
  await page.evaluate(() => (document.querySelector('.ytp-chapter-container').textContent = ''));
  await page.waitForTimeout(500);
  const recovered = await probe(page);
  check(
    'после снятия главы шкала восстановилась',
    recovered.sliderW > chapter.sliderW,
    `${chapter.sliderW} → ${recovered.sliderW}`
  );

  reporter.section('полноэкранный режим');
  await setWidth(1280);
  const normal = await probe(page);
  await page.evaluate(() => document.getElementById('movie_player').classList.add('ytp-big-mode'));
  await page.waitForTimeout(600);
  const big = await probe(page);
  const heights = await page.evaluate(() => ({
    box: Math.round(document.querySelector('.ytev-box').getBoundingClientRect().height),
    row: Math.round(document.querySelector('.ytp-time-display').getBoundingClientRect().height),
  }));
  check(
    'в полноэкранном режиме блок не сжался',
    big.sliderW >= normal.sliderW,
    `${normal.sliderW} → ${big.sliderW}`
  );
  check('высота блока не выше строки', heights.box <= heights.row + 2, JSON.stringify(heights));
  check('в полноэкранном режиме блок в строке', big.overflowRight <= 1 && big.overflowLeft <= 1);
  await page.evaluate(() =>
    document.getElementById('movie_player').classList.remove('ytp-big-mode')
  );
  await page.waitForTimeout(500);

  reporter.section('быстрые смены настроек');
  for (const patch of [
    { sliderScale: 70 },
    { sliderScale: 2 },
    { showPercent: false },
    { autoCollapse: true },
    { useNativeSlider: true },
    { useNativeSlider: false },
    { showPercent: true, autoCollapse: false, sliderScale: 20 },
  ]) {
    await page.evaluate((value) => window.__update(value), patch);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  const settled = await probe(page);
  check('после череды смен настроек блок цел', settled.hasBox && settled.controllable);
  check(
    'после череды смен настроек ровно один блок',
    (await page.evaluate(() => document.querySelectorAll('.ytev-box').length)) === 1
  );

  // Запись в video.volume «из ниоткуда» намеренно откатывается к
  // сохранённому уровню — это защита от служебных сбросов YouTube.
  const programmatic = await page.evaluate(async () => {
    const video = document.querySelector('video');
    const before = video.volume;
    video.volume = 0.33;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { before, settled: video.volume };
  });
  check(
    'запись без жеста откатывается к сохранённому уровню',
    Math.abs(programmatic.settled - programmatic.before) < 1e-6,
    JSON.stringify(programmatic)
  );

  const box = await page.locator('.ytev-slider').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = await page.evaluate(() =>
    +Number(document.querySelector('video').volume).toFixed(3)
  );
  check('после череды смен настроек жест меняет громкость', dragged > 0.7, `${dragged}`);
  await page.close();
});
