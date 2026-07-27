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
      const label = document.querySelector('.ytev-label-slot');
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
    const label = document.querySelector('.ytev-label-slot');
    const scope = () => document.querySelector('.ytp-left-controls');
    document.querySelector('.ytev-box').dispatchEvent(new MouseEvent('mouseenter'));
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
    const scope = () => document.querySelector('.ytp-left-controls');
    const slider = document.querySelector('.ytev-slot');
    const width = () => slider.getBoundingClientRect().width;
    const frame = () => new Promise((done) => requestAnimationFrame(done));

    scope().dispatchEvent(new MouseEvent('mouseleave'));
    while (box.classList.contains('ytev-animating')) await frame();

    const opening = [];
    document.querySelector('.ytev-box').dispatchEvent(new MouseEvent('mouseenter'));
    for (let i = 0; i < 6; i += 1) {
      await frame();
      opening.push(width());
    }
    const atLeave = width();
    scope().dispatchEvent(new MouseEvent('mouseleave'));
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

  // --- шкала выезжает, а не растягивается --------------------------------
  // Раньше анимировалась ширина самого <input>: он появлялся целиком, но
  // сжатым, и на глазах растягивался — бегунок ползёт, заливка тянется.
  // Теперь ширину меняет обрезающая обёртка, а <input> внутри постоянного
  // размера, как у штатной шкалы YouTube.
  {
    const curtain = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const widths = await curtain.evaluate(async () => {
      const scope = document.querySelector('.ytp-left-controls');
      const box = document.querySelector('.ytev-box');
      const slot = document.querySelector('.ytev-slot');
      const input = document.querySelector('.ytev-slider');
      const frame = () => new Promise((done) => requestAnimationFrame(done));

      scope.dispatchEvent(new MouseEvent('mouseleave'));
      while (box.classList.contains('ytev-animating')) await frame();
      const full = input.getBoundingClientRect().width;

      document.querySelector('.ytev-box').dispatchEvent(new MouseEvent('mouseenter'));
      const samples = [];
      for (let i = 0; i < 8; i += 1) {
        await frame();
        samples.push({
          slot: slot.getBoundingClientRect().width,
          input: input.getBoundingClientRect().width,
        });
      }
      return { full, samples };
    });
    await curtain.close();

    const mid = widths.samples.filter((s) => s.slot > 1 && s.slot < widths.full - 1);
    check(
      'в середине разворота обёртка уже, чем сама шкала',
      mid.length > 0,
      `замеров в середине: ${mid.length} из ${widths.samples.length}`
    );
    check(
      'сама шкала при этом своего размера не меняет',
      mid.every((s) => Math.abs(s.input - widths.full) < 1),
      mid.map((s) => `${Math.round(s.slot)}/${Math.round(s.input)}`).join(' ')
    );
  }

  // --- после клика по кнопке звука блок сворачивается целиком ------------
  // Обрезка снималась по :focus-within, а после клика фокус остаётся на
  // кнопке — свёрнутый блок превращался в кружок, из которого торчала шкала
  // во всю длину поверх соседей. Снимать обрезку можно только под
  // клавиатурным фокусом.
  {
    const clicked = await openPage(browser, {
      withMain: { autoCollapse: true },
      errors,
    });
    await clicked.hover('.ytev-box');
    await waitFor(
      async () => {
        const state = await clicked.evaluate(() => {
          const box = document.querySelector('.ytev-box');
          return {
            collapsed: box.classList.contains('ytev-collapsed'),
            animating: box.classList.contains('ytev-animating'),
          };
        });
        return !state.collapsed && !state.animating;
      },
      { what: 'разворачивания' }
    );
    await clicked.click('.ytev-mute');
    await clicked.mouse.move(10, 10);
    await waitFor(
      async () =>
        await clicked.evaluate(() => {
          const box = document.querySelector('.ytev-box');
          return (
            box.classList.contains('ytev-collapsed') &&
            !box.classList.contains('ytev-animating')
          );
        }),
      { timeout: 2000, what: 'сворачивания после клика по кнопке звука' }
    );
    const shape = await clicked.evaluate(() => {
      const boxEl = document.querySelector('.ytev-box');
      const box = boxEl.getBoundingClientRect();
      const slot = document.querySelector('.ytev-slot').getBoundingClientRect();
      // Прямоугольник самого <input> остаётся прежним даже под обрезкой —
      // он просто не рисуется. Видимую часть показывают ширина шторки и
      // попадание указателя: hit-test обрезку учитывает.
      const outside = document.elementFromPoint(box.right + 20, box.top + box.height / 2);
      return {
        boxW: Math.round(box.width),
        boxH: Math.round(box.height),
        slotW: Math.round(slot.width),
        ourElementOutside: !!(outside && outside.closest('.ytev-box')),
        clip: getComputedStyle(document.querySelector('.ytev-slot')).overflow,
      };
    });
    await clicked.close();
    check(
      'после клика по кнопке звука блок сворачивается в круг',
      Math.abs(shape.boxW - shape.boxH) <= 2,
      `${shape.boxW}×${shape.boxH}`
    );
    check(
      'шкала не торчит из свёрнутого блока',
      shape.slotW === 0 && !shape.ourElementOutside && shape.clip === 'hidden',
      `шторка ${shape.slotW}px, обрезка «${shape.clip}», ` +
        `за рамкой ${shape.ourElementOutside ? 'наш элемент' : 'ничего нашего'}`
    );
  }

  // --- начало шкалы стоит на месте ---------------------------------------
  // Пока промежуток между значком и шкалой был gap самой рамки, он менялся
  // вместе со сворачиванием — и левый край дорожки уезжал вправо на эти же
  // пиксели, пока шторка открывалась. Отступ перенесён внутрь шторки, и
  // край обязан стоять неподвижно от первого кадра до последнего.
  {
    const anchored = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const lefts = await anchored.evaluate(async () => {
      const box = document.querySelector('.ytev-box');
      const input = document.querySelector('.ytev-slider');
      const frame = () => new Promise((done) => requestAnimationFrame(done));

      document.querySelector('.ytp-left-controls').dispatchEvent(new MouseEvent('mouseleave'));
      while (box.classList.contains('ytev-animating')) await frame();

      box.dispatchEvent(new MouseEvent('mouseenter'));
      const samples = [];
      for (let i = 0; i < 20; i += 1) {
        await frame();
        const slot = document.querySelector('.ytev-slot').getBoundingClientRect();
        // Пока шторка ещё нулевой ширины, края дорожки на экране нет —
        // такие кадры в сравнение не берём.
        if (slot.width > 0.5) samples.push(input.getBoundingClientRect().left);
      }
      return samples;
    });
    await anchored.close();
    const spread = Math.max(...lefts) - Math.min(...lefts);
    check(
      'левый край шкалы не двигается при разворачивании',
      lefts.length > 3 && spread < 0.5,
      `разброс ${spread.toFixed(2)}px по ${lefts.length} кадрам`
    );
  }

  // --- бегунок не должен обрезаться обёрткой -----------------------------
  // Дорожка 4px, а бегунок 13px и торчит за её пределы. Пока обёртка была
  // высотой по содержимому, overflow: hidden срезал его сверху и снизу —
  // «пимпочка» пропадала совсем.
  {
    const thumb = await openPage(browser, { withMain: { autoCollapse: false }, errors });
    const room = await thumb.evaluate(() => {
      const slot = document.querySelector('.ytev-slot');
      const box = document.querySelector('.ytev-box');
      return {
        slotH: Math.round(slot.getBoundingClientRect().height),
        boxH: Math.round(box.getBoundingClientRect().height),
        thumb: parseFloat(getComputedStyle(box).getPropertyValue('--ytev-thumb')),
      };
    });
    await thumb.close();
    check(
      'обёртка выше бегунка — он не обрезается',
      room.slotH >= room.thumb,
      `обёртка ${room.slotH}px при бегунке ${room.thumb}px и рамке ${room.boxH}px`
    );
  }

  // --- кнопка не должна дёргаться при наведении --------------------------
  // Поле со стороны значка обязано совпадать в обоих состояниях, иначе
  // кнопка съезжает на доли пикселя туда-обратно при каждом наведении.
  {
    const still = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const shift = await still.evaluate(async () => {
      const box = document.querySelector('.ytev-box');
      const btn = document.querySelector('.ytev-mute');
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const left = () => btn.getBoundingClientRect().left - box.getBoundingClientRect().left;

      document.querySelector('.ytp-left-controls').dispatchEvent(new MouseEvent('mouseleave'));
      while (box.classList.contains('ytev-animating')) await frame();
      const collapsed = left();

      box.dispatchEvent(new MouseEvent('mouseenter'));
      while (box.classList.contains('ytev-animating')) await frame();
      return { collapsed, expanded: left() };
    });
    await still.close();
    check(
      'кнопка не смещается при раскрытии',
      Math.abs(shift.collapsed - shift.expanded) < 0.01,
      `свёрнуто ${shift.collapsed}px, раскрыто ${shift.expanded}px от края рамки`
    );
  }

  // --- проценты появляются вслед за шкалой -------------------------------
  {
    const follow = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const order = await follow.evaluate(async () => {
      const box = document.querySelector('.ytev-box');
      const slot = document.querySelector('.ytev-slot');
      const labelSlot = document.querySelector('.ytev-label-slot');
      const frame = () => new Promise((done) => requestAnimationFrame(done));

      document.querySelector('.ytp-left-controls').dispatchEvent(new MouseEvent('mouseleave'));
      while (box.classList.contains('ytev-animating')) await frame();

      box.dispatchEvent(new MouseEvent('mouseenter'));
      const samples = [];
      for (let i = 0; i < 20; i += 1) {
        await frame();
        samples.push({
          slider: slot.getBoundingClientRect().width,
          label: labelSlot.getBoundingClientRect().width,
        });
      }
      return samples;
    });
    await follow.close();

    const sliderStart = order.findIndex((s) => s.slider > 0.5);
    const labelStart = order.findIndex((s) => s.label > 0.5);
    check(
      'проценты трогаются позже шкалы',
      sliderStart >= 0 && labelStart > sliderStart,
      `шкала с кадра ${sliderStart}, проценты с кадра ${labelStart}`
    );
    const midLabel = order.filter((s) => s.label > 0.5 && s.label < order.at(-1).label - 0.5);
    check(
      'проценты открываются постепенно, а не разом',
      midLabel.length > 0,
      `промежуточных замеров подписи: ${midLabel.length}`
    );
  }

  // --- наведение считается по строке управления, а не по блоку -----------
  // Штатный регулятор не схлопывается, когда ведёшь мышь к соседней кнопке.
  {
    const row = await openPage(browser, { withMain: { autoCollapse: true }, errors });
    const collapsed = () =>
      row.evaluate(() =>
        document.querySelector('.ytev-box').classList.contains('ytev-collapsed')
      );

    await row.hover('.ytev-box');
    await waitFor(async () => !(await collapsed()), { what: 'разворачивания' });

    // Указатель на соседней кнопке той же строки — блок обязан остаться
    // раскрытым, хотя курсор уже не над ним.
    await row.hover('.ytp-time-display');
    await row.waitForTimeout(400);
    check('курсор на соседнем элементе строки — блок раскрыт', !(await collapsed()));

    // Ушли из строки целиком — сворачивается.
    await row.mouse.move(10, 10);
    await waitFor(async () => await collapsed(), {
      timeout: 1500,
      what: 'сворачивания после ухода из строки',
    });
    check('уход из строки управления сворачивает блок', true);
    await row.close();
  }

  // --- старый режим: задержка перед сворачиванием ------------------------
  // С длинной шкалой мелкое движение мышью легко выводит курсор за рамку, и
  // мгновенное сворачивание мешает. Настройка возвращает прежнее поведение:
  // полсекунды на возврат, за которые разворот успевает дойти до конца.
  {
    const delayed = await openPage(browser, {
      withMain: { autoCollapse: true, collapseDelay: true },
      errors,
    });
    const state = () =>
      delayed.evaluate(() => {
        const box = document.querySelector('.ytev-box');
        return {
          collapsed: box.classList.contains('ytev-collapsed'),
          width: Math.round(box.getBoundingClientRect().width),
        };
      });

    await delayed.hover('.ytev-box');
    await waitFor(async () => !(await state()).collapsed, { what: 'разворачивания' });
    await delayed.mouse.move(10, 10);

    await delayed.waitForTimeout(200); // раньше здесь уже было бы свёрнуто
    const during = await state();
    check(
      'с задержкой шкала ещё открыта через 200мс после ухода',
      !during.collapsed,
      JSON.stringify(during)
    );

    await waitFor(async () => (await state()).collapsed, {
      timeout: 2000,
      what: 'сворачивания по истечении задержки',
    });
    check('по истечении задержки блок всё же сворачивается', true);

    // Вернулся до истечения — сворачивания не происходит вовсе.
    await delayed.hover('.ytev-box');
    await waitFor(async () => !(await state()).collapsed, { what: 'повторного разворота' });
    await delayed.evaluate(() => {
      const scope = document.querySelector('.ytp-left-controls');
      scope.dispatchEvent(new MouseEvent('mouseleave'));
      document.querySelector('.ytev-box').dispatchEvent(new MouseEvent('mouseenter'));
    });
    await delayed.waitForTimeout(700);
    const returned = await state();
    check(
      'возврат курсора до истечения задержки отменяет сворачивание',
      !returned.collapsed,
      JSON.stringify(returned)
    );
    await delayed.close();
  }

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
    'с подписью поле — среднее промежутка и обычного поля',
    Math.abs(withLabel.right - (withLabel.pad + withLabel.pad / 2) / 2) <= 1,
    `${withLabel.right}px при поле ${withLabel.pad}px`
  );

  // --- проценты стоят посередине -----------------------------------------
  // Раньше подпись липла к шкале: слева от неё был промежуток в половину
  // поля рамки, справа — целое поле. Просвет должен быть одинаковым.
  {
    const centred = await openPage(browser, {
      withMain: { autoCollapse: false, showPercent: true },
      errors,
    });
    // Меряем сам текст, а не его коробку, и на «100%» — это самая широкая
    // подпись, на ней и вылезала подрезка последнего знака.
    const measureGaps = (fontSize) =>
      centred.evaluate((size) => {
        // YouTube задаёт своей строке управления собственный размер шрифта;
        // от него зависели em внутри блока.
        document.querySelector('.ytp-chrome-controls').style.fontSize = size + 'px';
        const label = document.querySelector('.ytev-label');
        label.textContent = '100%';
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const box = document.querySelector('.ytev-box').getBoundingClientRect();
        const track = document.querySelector('.ytev-slider').getBoundingClientRect();
        return { before: text.left - track.right, after: box.right - text.right };
      }, fontSize);

    const normal = await measureGaps(16);
    check(
      'проценты посередине между шкалой и краем рамки',
      Math.abs(normal.before - normal.after) <= 0.5,
      `слева ${normal.before.toFixed(1)}px, справа ${normal.after.toFixed(1)}px`
    );

    // Раньше шторка процентов считала свои em от шрифта строки YouTube, а
    // подпись — от своего: на мелком шрифте строки шторка выходила уже
    // содержимого и срезала подпись справа.
    const tiny = await measureGaps(9);
    check(
      'мелкий шрифт строки YouTube не сдвигает и не режет проценты',
      Math.abs(tiny.before - tiny.after) <= 0.5 && tiny.after > 1,
      `слева ${tiny.before.toFixed(1)}px, справа ${tiny.after.toFixed(1)}px`
    );
    await centred.close();
  }

  // --- значок звука не должен быть крупным -------------------------------
  {
    const icon = await openPage(browser, { withMain: { autoCollapse: false }, errors });
    const size = await icon.evaluate(() => {
      const btn = document.querySelector('.ytev-mute').getBoundingClientRect();
      const svg = document.querySelector('.ytev-mute svg').getBoundingClientRect();
      return { ratio: svg.width / btn.width, btn: Math.round(btn.width) };
    });
    await icon.close();
    check(
      'значок занимает 47.4% кнопки',
      Math.abs(size.ratio - 0.474) < 0.02,
      `${(size.ratio * 100).toFixed(1)}% при кнопке ${size.btn}px`
    );
  }
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
