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

  // --- пустая распорка между нами и кнопкой ------------------------------
  // В живой строке плеера перед нашим блоком стоит <span class="ytp-volume-area">:
  // после скрытия громкости он пустой и нулевой ширины, но в DOM остаётся.
  // Считать отступ по «ближайшему отрисованному соседу» из-за него нельзя —
  // нужно идти до первого, кто реально занимает место.
  {
    const page = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    // Ставим распорку вплотную перед блоком — так она и стоит в живой
    // строке — и просим пересчитать раскладку.
    await page.evaluate(() => {
      const box = document.querySelector('.ytev-box');
      const spacer = document.createElement('span');
      spacer.className = 'ytp-volume-area';
      spacer.style.display = 'flex';
      box.before(spacer);
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(300);
    const gap = await page.evaluate(() => {
      const box = document.querySelector('.ytev-box');
      let prev = box.previousElementSibling;
      while (prev && prev.getBoundingClientRect().width <= 0.5) {
        prev = prev.previousElementSibling;
      }
      return {
        value: +(box.getBoundingClientRect().left - prev.getBoundingClientRect().right).toFixed(1),
        spacerIsSibling: !!box.previousElementSibling &&
          box.previousElementSibling.classList.contains('ytp-volume-area'),
        ours: getComputedStyle(box).marginLeft,
      };
    });
    await page.close();
    check(
      'пустая распорка перед блоком не удваивает зазор',
      Math.abs(gap.value - EXPECTED) <= 1,
      `${gap.value}px, распорка ${gap.spacerIsSibling ? 'на месте' : 'не встала'}, мы ${gap.ours}`
    );
  }

  // --- таймкод справа -----------------------------------------------------
  // В живой строке `.ytp-time-display` фона не рисует: таймкод лежит во
  // вложенной плашке с собственным отступом. Зазор до неё складывался из
  // нашего поля и этого отступа — до таймкода выходило заметно больше, чем
  // у самого YouTube.
  {
    const page = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const gap = await page.evaluate(async () => {
      const display = document.querySelector('.ytp-time-display');
      const pill = display.querySelector('.tpill');
      // Как в бою: у обёртки фона нет, отступ до плашки задаёт она сама.
      display.style.background = 'transparent';
      display.style.paddingLeft = '12px';
      window.dispatchEvent(new Event('resize'));
      await new Promise((done) => setTimeout(done, 250));
      const box = document.querySelector('.ytev-box').getBoundingClientRect();
      return {
        toPill: +(pill.getBoundingClientRect().left - box.right).toFixed(1),
        toBox: +(display.getBoundingClientRect().left - box.right).toFixed(1),
        ours: getComputedStyle(document.querySelector('.ytev-box')).marginRight,
      };
    });
    await page.close();
    check(
      'до видимого таймкода — ритм YouTube, а не поле плюс его отступ',
      Math.abs(gap.toPill - EXPECTED) <= 1,
      `до плашки ${gap.toPill}px, до коробки ${gap.toBox}px, мы ${gap.ours}`
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

  // --- тень как у штатных контролов --------------------------------------
  // Светлый значок на светлом кадре без тени теряется, у YouTube она есть
  // и на значках, и на дорожке, и на подписи времени.
  {
    const page = await openPage(browser, { withMain: { autoCollapse: false }, errors });
    const shadow = await page.evaluate(() => ({
      icon: getComputedStyle(document.querySelector('.ytev-mute svg')).filter,
      slider: getComputedStyle(document.querySelector('.ytev-slider')).filter,
      label: getComputedStyle(document.querySelector('.ytev-label')).textShadow,
    }));
    await page.close();
    check(
      'у значка и шкалы есть тень',
      /drop-shadow/.test(shadow.icon) && /drop-shadow/.test(shadow.slider),
      `значок «${shadow.icon}», шкала «${shadow.slider}»`
    );
    check(
      'у процентов тень тоже есть',
      /rgba?\(/.test(shadow.label) && shadow.label !== 'none',
      `«${shadow.label}»`
    );
  }

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

  // --- якорь остался в строке ---------------------------------------------
  // Снято с живой строки Shorts: скрыты оказались только потомки
  // <volume-controls>, а сам он остался элементом flex-строки. Ширины у него
  // нет, но gap строки он собирает с обеих сторон — 8 + 0 + 8. Неотрицательным
  // полем это не убрать, поэтому поле умеет и вычитать.
  {
    const page = await openPage(browser, {
      page: 'shorts',
      withMain: { autoCollapse: true },
      errors,
    });
    const gap = await page.evaluate(async () => {
      const anchor = document.querySelector('volume-controls');
      // Возвращаем узел в поток, оставив его пустым, — ровно как в бою.
      anchor.style.display = 'flex';
      anchor.style.width = '0px';
      for (const child of anchor.querySelectorAll('*')) child.style.display = 'none';
      window.dispatchEvent(new Event('resize'));
      await new Promise((done) => setTimeout(done, 250));
      const play = document.querySelector('#play-pause-button-shape');
      const box = document.querySelector('.ytev-box');
      return {
        value: +(box.getBoundingClientRect().left - play.getBoundingClientRect().right).toFixed(1),
        anchorInFlow: anchor.getClientRects().length > 0,
        ours: getComputedStyle(box).marginLeft,
      };
    });
    await page.close();
    check(
      'якорь в потоке: лишний gap гасится отрицательным полем',
      Math.abs(gap.value - EXPECTED) <= 1,
      `${gap.value}px, якорь ${gap.anchorInFlow ? 'в потоке' : 'вне потока'}, мы ${gap.ours}`
    );
  }
});
