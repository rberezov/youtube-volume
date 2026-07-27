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
  // Задержки перед сворачиванием больше нет: через 120мс переход в 250мс
  // обязан уже идти. Раньше здесь были лишние полсекунды ожидания.
  await page.waitForTimeout(120);
  const mid = await boxState();
  check(
    'сворачивание начинается сразу, без задержки',
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

  // --- разворот прерывают на полпути ------------------------------------
  // Штатная шкала YouTube начинает уезжать в тот же момент, когда ушёл
  // указатель, — даже если ещё не выдвинулась целиком. Значит после ухода
  // ширина обязана только уменьшаться: ни доводки до конца, ни скачка.
  const reversal = await page.evaluate(async () => {
    const box = document.querySelector('.ytev-box');
    const slider = document.querySelector('.ytev-slider');
    const width = () => slider.getBoundingClientRect().width;
    const frame = () => new Promise((done) => requestAnimationFrame(done));

    box.dispatchEvent(new MouseEvent('mouseleave'));
    while (box.classList.contains('ytev-animating')) await frame();

    const opening = [];
    box.dispatchEvent(new MouseEvent('mouseenter'));
    for (let i = 0; i < 6; i += 1) {
      await frame();
      opening.push(width());
    }
    const atLeave = width();
    box.dispatchEvent(new MouseEvent('mouseleave'));
    const closing = [];
    for (let i = 0; i < 30; i += 1) {
      await frame();
      closing.push(width());
    }
    return { opening, atLeave, closing, full: opening[opening.length - 1] };
  });
  check(
    'разворот прерван на полпути, а не доведён до конца',
    reversal.atLeave > 1 && Math.max(...reversal.closing) <= reversal.atLeave + 1,
    `на момент ухода ${Math.round(reversal.atLeave)}px, максимум после — ` +
      `${Math.round(Math.max(...reversal.closing))}px`
  );
  check(
    'после ухода указателя шкала едет только в одну сторону',
    reversal.closing.every((w, i) => i === 0 || w <= reversal.closing[i - 1] + 1),
    reversal.closing.map((w) => Math.round(w)).join(' ')
  );
  check(
    'прерванный разворот доезжает до нуля',
    reversal.closing[reversal.closing.length - 1] < 1,
    `итог ${reversal.closing[reversal.closing.length - 1]}px`
  );

  await page.close();

  // --- воздух за концом шкалы, когда процентов нет ----------------------
  const withLabel = await padding(browser, errors, true);
  const noLabel = await padding(browser, errors, false);
  check(
    'без процентов за концом шкалы больше воздуха',
    noLabel.right > withLabel.right + 2,
    `${noLabel.right}px против ${withLabel.right}px с подписью`
  );
  check(
    'хвост — 1.75 обычного поля',
    Math.abs(noLabel.right - noLabel.pad * 1.75) <= 1,
    `${noLabel.right}px при поле ${noLabel.pad}px`
  );
  check(
    'подпись на месте — поле обычное',
    Math.abs(withLabel.right - withLabel.pad) <= 1,
    `${withLabel.right}px при поле ${withLabel.pad}px`
  );
});

// Поля рамки в развёрнутом состоянии при включённых и выключенных процентах.
async function padding(browser, errors, showPercent) {
  const page = await openPage(browser, {
    withMain: { autoCollapse: false, showPercent },
    errors,
  });
  const result = await page.evaluate(() => {
    const box = document.querySelector('.ytev-box');
    const style = getComputedStyle(box);
    return {
      right: Math.round(parseFloat(style.paddingRight)),
      pad: Math.round(parseFloat(style.getPropertyValue('--ytev-pad'))),
      nolabel: box.classList.contains('ytev-nolabel'),
    };
  });
  await page.close();
  return result;
}
