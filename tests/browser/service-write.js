'use strict';

// Служебная запись громкости плеером против осознанного жеста.
//
// Полевая находка в Shorts: на первой загрузке меняешь громкость — и она сама
// уползает вниз. Причина не в Shorts как таковых, а в окне намерения. Нажатие
// на ползунок открывало его на пять секунд (чтобы пережить долгую протяжку), а
// плеер именно в эти секунды применяет СВОЙ сохранённый уровень. Запись
// попадала в открытое окно, принималась за осознанный выбор — и уровень
// оставался чужим вместо отката.
//
// Отличает их близость к жесту: свою громкость YouTube пишет синхронно в
// обработчике ввода, а отложенное восстановление приходит само по себе.
// Здесь проверяется и то и другое: поздняя чужая запись откатывается, а
// осознанные жесты — в том числе протяжка с остановкой, где запись приходит
// только на отпускании, — по-прежнему принимаются.

const { openPage, dragSlider, run, waitFor } = require('./harness');

const volumeOf = (page) =>
  page.evaluate(() => +Number(document.querySelector('video').volume).toFixed(3));

// Так ведёт себя плеер на первой загрузке: применяет свой сохранённый
// уровень, без всякого участия пользователя.
const serviceWrite = (page, value) =>
  page.evaluate((v) => {
    document.querySelector('video').volume = v;
  }, value);

run('service-write: служебная запись плеера против жеста', async ({ browser, reporter, errors }) => {
  const { check, section } = reporter;

  for (const kind of ['shorts', 'watch']) {
    section(`${kind}: чужая запись после жеста`);
    for (const delay of [700, 1500, 3000]) {
      const page = await openPage(browser, {
        page: kind,
        withBridge: true,
        errors,
        playerWidth: kind === 'watch' ? 1280 : undefined,
        state: { savedVolume: 0.3, savedMuted: false },
      });
      await dragSlider(page, 0.8, '.ytev-slider');
      const chosen = await volumeOf(page);
      await page.waitForTimeout(delay);
      await serviceWrite(page, 0.3);
      await page.waitForTimeout(500);
      const after = await volumeOf(page);
      check(
        `через ${delay}мс после жеста уровень откатывается`,
        after === chosen && chosen > 0.5,
        `выставлено ${chosen}, стало ${after}`
      );
      await page.close();
    }
  }

  section('одиночный клик по ползунку');
  {
    // Худший случай прежнего поведения: нажатие без протяжки открывало окно
    // на пять секунд, и всё это время чужая запись считалась выбором
    // пользователя. Именно так и выглядит поле: ткнул в ползунок Shorts на
    // первой загрузке — и через пару секунд громкость уползла.
    for (const delay of [1200, 3000]) {
      const page = await openPage(browser, {
        page: 'shorts',
        withBridge: true,
        errors,
        state: { savedVolume: 0.3, savedMuted: false },
      });
      const box = await page.locator('.ytev-slider').boundingBox();
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
      await page.waitForTimeout(300);
      const chosen = await volumeOf(page);
      await page.waitForTimeout(delay);
      await serviceWrite(page, 0.3);
      await page.waitForTimeout(500);
      const after = await volumeOf(page);
      check(
        `через ${delay}мс после клика уровень откатывается`,
        after === chosen && chosen > 0.5,
        `выставлено ${chosen}, стало ${after}`
      );
      await page.close();
    }
  }

  section('осознанное не сломано');
  {
    const page = await openPage(browser, {
      page: 'shorts',
      withBridge: true,
      errors,
      state: { savedVolume: 0.3, savedMuted: false },
    });
    await dragSlider(page, 0.8, '.ytev-slider');
    const chosen = await volumeOf(page);
    check('протяжка меняет громкость', chosen > 0.5, `${chosen}`);
    await waitFor(
      async () =>
        page.evaluate(() =>
          (window.__writes || []).some((write) => write.savedVolume > 0.5)
        ),
      { what: 'записи выбранного уровня' }
    );
    check('выбранный уровень сохранён', true);
    await page.close();
  }

  {
    // Протяжка с остановкой: нажал, подержал ползунок неподвижно, отпустил.
    // Запись приходит на отпускании, и без учёта этого жеста правило
    // «запись близко к жесту» отвергло бы её как служебную.
    const page = await openPage(browser, {
      page: 'shorts',
      withBridge: true,
      errors,
      state: { savedVolume: 0.3, savedMuted: false },
    });
    const box = await page.locator('.ytev-slider').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, y, { steps: 10 });
    await page.waitForTimeout(1200); // держим неподвижно дольше окна
    await page.mouse.up();
    // Плеер отвечает на отпускание своей записью того же уровня.
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.volume = Number(video.volume);
    });
    await page.waitForTimeout(400);
    const held = await volumeOf(page);
    check(
      'протяжка с остановкой сохраняет выбранный уровень',
      held > 0.5,
      `${held}`
    );
    await page.close();
  }
});
