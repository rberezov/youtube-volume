'use strict';

// Анимация сворачивания.
//
// Блок с включённым автосворачиванием без курсора превращается в круг со
// значком. Форму и длительность снаружи видно только через вычисленные
// стили, поэтому проверяем именно их — и именно в середине анимации, где
// прежняя версия и выглядела странно.

const { openPage, run, waitFor } = require('./harness');

run('collapse: форма и длительность сворачивания', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  const page = await openPage(browser, {
    withMain: { autoCollapse: true },
    errors,
  });

  const boxState = () =>
    page.evaluate(() => {
      const box = document.querySelector('.ytev-box');
      if (!box) return null;
      const style = getComputedStyle(box);
      const label = document.querySelector('.ytev-label');
      const rect = box.getBoundingClientRect();
      return {
        radius: style.borderTopLeftRadius,
        animating: box.classList.contains('ytev-animating'),
        collapsed: box.classList.contains('ytev-collapsed'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        labelWidth: label ? Math.round(label.getBoundingClientRect().width) : null,
      };
    });

  const hover = () => page.hover('.ytev-box');
  const leave = () => page.mouse.move(10, 10);

  await hover();
  await waitFor(
    async () => {
      const state = await boxState();
      return !state.collapsed && !state.animating;
    },
    { what: 'разворачивания' }
  );
  const open = await boxState();
  check('с курсором блок развёрнут', !open.collapsed && open.width > open.height * 2);

  // --- сворачивание -----------------------------------------------------
  await leave();
  // курсор ушёл — сворачивание начинается через 500мс; ловим середину.
  await page.waitForTimeout(620);
  const mid = await boxState();
  check(
    'в середине сворачивания идёт анимация',
    mid.animating && mid.collapsed,
    JSON.stringify(mid)
  );
  // Главная находка: border-radius: 50% на ещё широком блоке — эллипс, и
  // рамка заметно вспухала по бокам. В пикселях радиус один и тот же по
  // обеим осям, и вычисленное значение не содержит ни процентов, ни второй
  // величины через дробь.
  check(
    'рамка не превращается в эллипс: радиус в пикселях',
    /^\d+(\.\d+)?px$/.test(mid.radius),
    `border-radius = ${mid.radius} при ширине ${mid.width} и высоте ${mid.height}`
  );

  await waitFor(async () => !(await boxState()).animating, {
    timeout: 1500,
    what: 'конца анимации',
  });
  const closed = await boxState();
  check(
    'свёрнутый блок — круг: ширина равна высоте',
    Math.abs(closed.width - closed.height) <= 2,
    `${closed.width}×${closed.height}`
  );
  check(
    'радиус круга — половина высоты',
    Math.abs(parseFloat(closed.radius) - closed.height / 2) <= 1,
    `${closed.radius} при высоте ${closed.height}`
  );

  // --- разворачивание ---------------------------------------------------
  // Подпись с процентами имеет min-width 2.5em. Пока min-width не был в
  // переходе, он перебивал max-width, и подпись выпрыгивала на полную
  // ширину в первом же кадре — раньше, чем успевала вырасти шкала.
  const early = await page.evaluate(async () => {
    const box = document.querySelector('.ytev-box');
    const label = document.querySelector('.ytev-label');
    box.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return {
      labelWidth: Math.round(label.getBoundingClientRect().width),
      boxWidth: Math.round(box.getBoundingClientRect().width),
      animating: box.classList.contains('ytev-animating'),
    };
  });
  check(
    'подпись не выпрыгивает в первом кадре разворачивания',
    early.labelWidth <= 6,
    `ширина подписи ${early.labelWidth}px через два кадра после начала`
  );

  await waitFor(async () => !(await boxState()).animating, {
    timeout: 1500,
    what: 'конца разворачивания',
  });
  const reopened = await boxState();
  check(
    'после разворачивания блок снова широкий, а подпись видна',
    !reopened.collapsed && reopened.width > reopened.height * 2 && reopened.labelWidth > 10,
    JSON.stringify(reopened)
  );

  await page.close();
});
