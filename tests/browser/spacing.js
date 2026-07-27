'use strict';

// Зазор между нашим блоком и соседней кнопкой.
//
// Полевой замер строки Shorts: у YouTube 48px кнопка воспроизведения, 8px
// промежуток и 60px штатный регулятор — строка 116px. У нас выходило
// 48 + 16 + 48 = 112: свой отступ ложился поверх чужого. Оба источника
// лишних пикселей проверяются здесь.

const { openPage, run } = require('./harness');

// Ритм YouTube между соседними контролами.
const EXPECTED = 8;

run('spacing: зазор до соседней кнопки', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  // --- обычное видео -----------------------------------------------------
  // Слева от нас «пилюля» с кнопками, у неё собственный margin-right: 8px.
  // Наши восемь прибавлялись к ним, и между контролами выходило шестнадцать.
  {
    const page = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const gap = await page.evaluate(() => {
      const box = document.querySelector('.ytev-box');
      let prev = box.previousElementSibling;
      while (prev && !prev.getClientRects().length) prev = prev.previousElementSibling;
      return {
        value: +(box.getBoundingClientRect().left - prev.getBoundingClientRect().right).toFixed(1),
        neighbour: String(prev.className),
        theirs: getComputedStyle(prev).marginRight,
        ours: getComputedStyle(box).marginLeft,
      };
    });
    await page.close();
    check(
      'на видео зазор до соседа — ритм YouTube, а не двойной',
      Math.abs(gap.value - EXPECTED) <= 1,
      `${gap.value}px (сосед «${gap.neighbour}» даёт ${gap.theirs}, мы ${gap.ours})`
    );
  }

  // --- Shorts ------------------------------------------------------------
  // Штатный блок громкости, на место которого мы встаём, обязан уйти из
  // потока целиком. Нулевой по размеру, но видимый элемент остаётся
  // элементом flex-строки и собирает промежуток с обеих сторон.
  const shortsGap = async (squash) => {
    const page = await openPage(browser, {
      page: 'shorts',
      withMain: { autoCollapse: true },
      errors,
      before: squash
        ? async (target) => {
            await target.evaluate(() => {
              // Так это и выглядело в бою: к моменту скрытия узел уже
              // схлопнут, и прежний фильтр по размеру его пропускал.
              const el = document.querySelector('volume-controls');
              el.style.width = '0px';
              el.style.height = '0px';
              el.style.overflow = 'hidden';
            });
          }
        : undefined,
    });
    const result = await page.evaluate(() => {
      const play = document.querySelector('#play-pause-button-shape');
      const box = document.querySelector('.ytev-box');
      const anchor = document.querySelector('volume-controls');
      return {
        value: +(box.getBoundingClientRect().left - play.getBoundingClientRect().right).toFixed(1),
        anchorInFlow: anchor ? anchor.getClientRects().length > 0 : false,
        rowWidth: Math.round(document.querySelector('#left-controls').getBoundingClientRect().width),
      };
    });
    await page.close();
    return result;
  };

  const plain = await shortsGap(false);
  check(
    'в Shorts зазор до кнопки воспроизведения — ритм YouTube',
    Math.abs(plain.value - EXPECTED) <= 1,
    `${plain.value}px, строка ${plain.rowWidth}px`
  );

  const squashed = await shortsGap(true);
  check(
    'схлопнутый штатный блок уходит из потока, а не удваивает зазор',
    Math.abs(squashed.value - EXPECTED) <= 1 && !squashed.anchorInFlow,
    `${squashed.value}px, якорь ${squashed.anchorInFlow ? 'в потоке' : 'вне потока'}`
  );
});
