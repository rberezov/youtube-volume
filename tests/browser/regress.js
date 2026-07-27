'use strict';

// Базовая регрессия: сборка блока, длина от настройки, настоящие жесты,
// три режима отображения и Shorts.

const {
  dragSlider,
  openPage,
  run,
  sliderValue,
  videoVolume,
} = require('./harness');

run('regress: сборка, жесты, режимы, Shorts', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  reporter.section('watch: базовая сборка');
  let page = await openPage(browser, { playerWidth: 1280, errors });
  check('блок построен', await page.evaluate(() => !!document.querySelector('.ytev-box')));
  check('громкость из state применена', Math.abs((await videoVolume(page)) - 0.5) < 0.01);
  check(
    'штатные контролы скрыты классом ytev-active',
    await page.evaluate(() => !!document.querySelector('.ytev-active'))
  );

  const sliderWidth = () =>
    page.evaluate(() => document.querySelector('.ytev-slider').getBoundingClientRect().width);
  const narrow = await sliderWidth();
  await page.evaluate(() => window.__update({ sliderScale: 40 }));
  await page.waitForTimeout(400);
  const wide = await sliderWidth();
  check(
    'длина растёт вместе с настройкой',
    wide > narrow * 1.6,
    `${Math.round(narrow)} → ${Math.round(wide)}`
  );
  await page.evaluate(() => window.__update({ sliderScale: 20 }));
  await page.waitForTimeout(400);

  reporter.section('watch: жесты');
  await dragSlider(page, 0.75);
  const afterDrag = await sliderValue(page);
  check('протяжка меняет уровень', afterDrag > 60 && afterDrag < 90, `${afterDrag}%`);

  const box = await page.locator('.ytev-slider').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(200);
  const afterWheel = await sliderValue(page);
  check('колесо: +1%', Math.abs(afterWheel - afterDrag - 1) < 0.001, `${afterDrag} → ${afterWheel}`);

  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  const afterShift = await sliderValue(page);
  check(
    'колесо с Shift: +0.1%',
    Math.abs(afterShift - afterWheel - 0.1) < 0.001,
    `${afterWheel} → ${afterShift}`
  );

  await page.locator('.ytev-slider').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(200);
  check('стрелка на ползунке работает', (await sliderValue(page)) > afterShift);

  check(
    'логическая громкость = позиция ползунка',
    Math.abs((await videoVolume(page)) * 100 - (await sliderValue(page))) < 0.2
  );

  // Всплывающих подсказок у блока быть не должно: они перекрывают плеер.
  // Доступность держится на aria-label и aria-valuetext, а не на title.
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.ytev-box [title], .ytev-box[title]')].map(
      (node) => `${node.className}="${node.getAttribute('title')}"`
    )
  );
  check('у блока нет всплывающих подсказок', titles.length === 0, titles.join(', '));
  check(
    'кнопка звука подписана для доступности',
    await page.evaluate(() => {
      const button = document.querySelector('.ytev-mute');
      return !!button && !!button.getAttribute('aria-label');
    })
  );
  await page.close();

  reporter.section('режимы');
  page = await openPage(browser, { withMain: { showPercent: false }, errors });
  check(
    'без процентов: подписи нет',
    await page.evaluate(() => {
      // Подпись прячется вместе со своей шторкой, поэтому смотрим на неё.
      const label = document.querySelector('.ytev-label-slot');
      return !label || getComputedStyle(label).display === 'none';
    })
  );
  await page.close();

  page = await openPage(browser, { withMain: { autoCollapse: true }, errors });
  const collapsed = await page.evaluate(() => {
    const rect = document.querySelector('.ytev-box').getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  check(
    'автосворачивание: круг',
    Math.abs(collapsed.w - collapsed.h) <= 2,
    `${collapsed.w}×${collapsed.h}`
  );
  await page.close();

  page = await openPage(browser, { withMain: { useNativeSlider: true }, errors });
  check('штатная шкала: своего блока нет', await page.evaluate(() => !document.querySelector('.ytev-box')));
  check(
    'штатная шкала: штатные контролы на месте',
    await page.evaluate(() => !document.querySelector('.ytev-active'))
  );
  check(
    'штатная шкала: кривая работает',
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.volume = 0.5;
      return Math.abs(video.volume - 0.5) < 1e-6; // логическое значение прозрачно для YouTube
    })
  );
  await page.close();

  reporter.section('Shorts');
  page = await openPage(browser, { page: 'shorts', errors });
  await page.mouse.move(700, 400);
  await page.waitForTimeout(700);
  const shorts = await page.evaluate(() => {
    const native = document.querySelector('volume-controls');
    return {
      box: !!document.querySelector('.ytev-box'),
      boxes: document.querySelectorAll('.ytev-box').length,
      nativeHidden: !native || getComputedStyle(native).visibility === 'hidden' ||
        getComputedStyle(native).display === 'none',
    };
  });
  check('Shorts: блок построен', shorts.box);
  check('Shorts: ровно один блок', shorts.boxes === 1, `${shorts.boxes}`);
  check('Shorts: штатная громкость скрыта', shorts.nativeHidden);

  await page.evaluate(() => window.__update({ useNativeSlider: true }));
  await page.waitForTimeout(700);
  const restored = await page.evaluate(() => {
    const native = document.querySelector('volume-controls');
    const style = native && getComputedStyle(native);
    return {
      ourGone: !document.querySelector('.ytev-box'),
      nativeBack: !!native && style.display !== 'none' && style.visibility !== 'hidden',
      hiddenAttrs: document.querySelectorAll('[data-ytev-hidden]').length,
    };
  });
  check('Shorts: свой блок убран', restored.ourGone);
  check('Shorts: штатная громкость возвращена', restored.nativeBack);
  check(
    'Shorts: следов data-ytev-hidden не осталось',
    restored.hiddenAttrs === 0,
    `${restored.hiddenAttrs}`
  );
  await page.close();
});
