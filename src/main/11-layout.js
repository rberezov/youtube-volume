  /* ------------------------------------------------------------------ *
   * Значок кнопки звука
   *
   * Точные формы актуального плеера YouTube (viewBox 24×24): заполненный
   * рупор с одной/двумя волнами и отдельный контурный mute-значок с
   * крестом. Состояние задаётся data-vol, а CSS повторяет оригинальную
   * 200-миллисекундную анимацию схлопывания и раскрытия волн.
   * ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // формы значка громкости из актуального плеера YouTube (viewBox 24×24)
  const ICON = {
    speaker:
      'M 11.60 2.08 L 11.48 2.14 L 3.91 6.68 C 3.02 7.21 2.28 7.97 1.77 8.87 C 1.26 9.77 1.00 10.79 1 11.83 V 12.16 L 1.01 12.56 C 1.07 13.52 1.37 14.46 1.87 15.29 C 2.38 16.12 3.08 16.81 3.91 17.31 L 11.48 21.85 C 11.63 21.94 11.80 21.99 11.98 21.99 C 12.16 22.00 12.33 21.95 12.49 21.87 C 12.64 21.78 12.77 21.65 12.86 21.50 C 12.95 21.35 13 21.17 13 21 V 3 C 12.99 2.83 12.95 2.67 12.87 2.52 C 12.80 2.37 12.68 2.25 12.54 2.16 C 12.41 2.07 12.25 2.01 12.08 2.00 C 11.92 1.98 11.75 2.01 11.60 2.08 Z',
    wave1:
      'M 15.53 7.05 C 15.35 7.22 15.25 7.45 15.24 7.70 C 15.23 7.95 15.31 8.19 15.46 8.38 L 15.53 8.46 L 15.70 8.64 C 16.09 9.06 16.39 9.55 16.61 10.08 L 16.70 10.31 C 16.90 10.85 17 11.42 17 12 L 16.99 12.24 C 16.96 12.73 16.87 13.22 16.70 13.68 L 16.61 13.91 C 16.36 14.51 15.99 15.07 15.53 15.53 C 15.35 15.72 15.25 15.97 15.26 16.23 C 15.26 16.49 15.37 16.74 15.55 16.92 C 15.73 17.11 15.98 17.21 16.24 17.22 C 16.50 17.22 16.76 17.12 16.95 16.95 C 17.6 16.29 18.11 15.52 18.46 14.67 L 18.59 14.35 C 18.82 13.71 18.95 13.03 18.99 12.34 L 19 12 C 18.99 11.19 18.86 10.39 18.59 9.64 L 18.46 9.32 C 18.15 8.57 17.72 7.89 17.18 7.3 L 16.95 7.05 L 16.87 6.98 C 16.68 6.82 16.43 6.74 16.19 6.75 C 15.94 6.77 15.71 6.87 15.53 7.05 Z',
    wave2:
      'M18.36 4.22 C18.18 4.39 18.08 4.62 18.07 4.87 C18.05 5.12 18.13 5.36 18.29 5.56 L18.36 5.63 L18.66 5.95 C19.36 6.72 19.91 7.60 20.31 8.55 L20.47 8.96 C20.82 9.94 21 10.96 21 11.99 L20.98 12.44 C20.94 13.32 20.77 14.19 20.47 15.03 L20.31 15.44 C19.86 16.53 19.19 17.52 18.36 18.36 C18.17 18.55 18.07 18.80 18.07 19.07 C18.07 19.33 18.17 19.59 18.36 19.77 C18.55 19.96 18.80 20.07 19.07 20.07 C19.33 20.07 19.59 19.96 19.77 19.77 C20.79 18.75 21.61 17.54 22.16 16.20 L22.35 15.70 C22.72 14.68 22.93 13.62 22.98 12.54 L23 12 C22.99 10.73 22.78 9.48 22.35 8.29 L22.16 7.79 C21.67 6.62 20.99 5.54 20.15 4.61 L19.77 4.22 L19.70 4.15 C19.51 3.99 19.26 3.91 19.02 3.93 C18.77 3.94 18.53 4.04 18.36 4.22 Z',
    muted:
      'M11.60 2.08L11.48 2.14L3.91 6.68C3.02 7.21 2.28 7.97 1.77 8.87C1.26 9.77 1.00 10.79 1 11.83V12.16L1.01 12.56C1.07 13.52 1.37 14.46 1.87 15.29C2.38 16.12 3.08 16.81 3.91 17.31L11.48 21.85C11.63 21.94 11.80 21.99 11.98 21.99C12.16 22.00 12.33 21.95 12.49 21.87C12.64 21.78 12.77 21.65 12.86 21.50C12.95 21.35 13 21.17 13 21V3C12.99 2.83 12.95 2.67 12.87 2.52C12.80 2.37 12.68 2.25 12.54 2.16C12.41 2.07 12.25 2.01 12.08 2.00C11.92 1.98 11.75 2.01 11.60 2.08ZM4.94 8.4V8.40L11 4.76V19.23L4.94 15.6C4.38 15.26 3.92 14.80 3.58 14.25C3.24 13.70 3.05 13.07 3.00 12.43L3 12.17V11.83C2.99 11.14 3.17 10.46 3.51 9.86C3.85 9.25 4.34 8.75 4.94 8.4ZM21.29 8.29L19 10.58L16.70 8.29L16.63 8.22C16.43 8.07 16.19 7.99 15.95 8.00C15.70 8.01 15.47 8.12 15.29 8.29C15.12 8.47 15.01 8.70 15.00 8.95C14.99 9.19 15.07 9.43 15.22 9.63L15.29 9.70L17.58 12L15.29 14.29C15.19 14.38 15.12 14.49 15.06 14.61C15.01 14.73 14.98 14.87 14.98 15.00C14.98 15.13 15.01 15.26 15.06 15.39C15.11 15.51 15.18 15.62 15.28 15.71C15.37 15.81 15.48 15.88 15.60 15.93C15.73 15.98 15.86 16.01 15.99 16.01C16.12 16.01 16.26 15.98 16.38 15.93C16.50 15.87 16.61 15.80 16.70 15.70L19 13.41L21.29 15.70L21.36 15.77C21.56 15.93 21.80 16.01 22.05 15.99C22.29 15.98 22.53 15.88 22.70 15.70C22.88 15.53 22.98 15.29 22.99 15.05C23.00 14.80 22.93 14.56 22.77 14.36L22.70 14.29L20.41 12L22.70 9.70C22.80 9.61 22.87 9.50 22.93 9.38C22.98 9.26 23.01 9.12 23.01 8.99C23.01 8.86 22.98 8.73 22.93 8.60C22.88 8.48 22.81 8.37 22.71 8.28C22.62 8.18 22.51 8.11 22.39 8.06C22.26 8.01 22.13 7.98 22.00 7.98C21.87 7.98 21.73 8.01 21.61 8.06C21.49 8.12 21.38 8.19 21.29 8.29Z',
  };

  function buildIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ytev-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = [
      [ICON.speaker, 'ytev-speaker'],
      [ICON.wave1, 'ytev-wave ytev-wave-1'],
      [ICON.wave2, 'ytev-wave ytev-wave-2'],
      [ICON.muted, 'ytev-muted-icon'],
    ];
    for (const [d, cls] of shapes) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  const num = (v) => parseFloat(v) || 0;

  // Доля ширины плеера под шкалу: у Shorts своя настройка, потому что
  // плеер там узкий (значение по умолчанию — на случай старой записи)
  const activeScale = () =>
    isShorts()
      ? num(SETTINGS.shortsScale) || 11
      : num(SETTINGS.sliderScale) || 7;

  const outerWidth = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none') return 0;
    return el.getBoundingClientRect().width + num(s.marginLeft) + num(s.marginRight);
  };

  const innerWidth = (el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - num(s.paddingLeft) - num(s.paddingRight);
  };

  // «Пилюля» со штатными кнопками — элемент, рядом с которым мы вставлены
  // и в котором живёт (скрытая) штатная кнопка звука
  function findPill() {
    const controls = ui.box.parentElement;
    if (!controls) return null;
    let el =
      (ui.hiddenPill && ui.hiddenPill.isConnected ? ui.hiddenPill : null) ||
      controls.querySelector('.ytp-volume-area, .ytp-mute-button');
    if (!el || ui.box.contains(el)) return null;
    while (el && el.parentElement !== controls) el = el.parentElement;
    return el && el !== ui.box ? el : null;
  }

  // Штатная кнопка звука скрыта через CSS; если кроме неё в «пилюле» не
  // осталось видимых кнопок — прячем пилюлю целиком, иначе висел бы
  // пустой кружок фона. В режиме отката пилюля возвращается.
  function markDonorPill(controls) {
    ui.hiddenPill = null;
    const mute = controls.querySelector('.ytp-mute-button');
    if (!mute || ui.box.contains(mute)) return;
    let pill = mute.parentElement;
    while (pill && pill.parentElement !== controls) pill = pill.parentElement;
    if (!pill || pill === ui.box) return;
    const hasOther = [...pill.querySelectorAll('button, [role="button"]')]
      .some((b) => b !== mute && b.offsetWidth > 0);
    if (!hasOther) {
      ui.hiddenPill = pill;
      pill.style.display = 'none';
    }
  }

  // Нормальный режим: наш блок виден и «в ответе» за громкость
  // (класс ytev-active включает CSS-скрытие штатных элементов),
  // опустевшая пилюля спрятана
  function enterNormal(player) {
    setEarlyNativeHidden(true, true);
    player.classList.add('ytev-active');
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = 'none';
    }
    ui.box.style.display = '';
  }

  // Откат (узкий плеер): наш блок спрятан, снятие класса возвращает
  // штатные кнопку и ползунок
  function enterFallback(player) {
    setEarlyNativeHidden(false, true);
    ui.box.style.display = 'none';
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    player.classList.remove('ytev-active');
  }

  const isTransparentBg = (bg) =>
    !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(bg);

  // Элементы, которые реально рисуют фон «плашки»: у обёрток (например,
  // .ytp-time-display) фон часто прозрачный, а видимая плашка — на
  // вложенном элементе; бывает и наоборот — полупрозрачный фон висит на
  // высокой обёртке. Поэтому собираем ВСЕ элементы с непрозрачным фоном
  // правдоподобной высоты, а образцом берём самый низкий: настоящая
  // плашка — самый компактный фоновый элемент строки.
  function collectSurfaces(root, out) {
    if (!root || !root.isConnected) return;
    const queue = [root];
    while (queue.length) {
      const el = queue.shift();
      if (el === ui.box || ui.box.contains(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none') continue;
      if (!isTransparentBg(s.backgroundColor)) {
        const h = el.getBoundingClientRect().height;
        // мелочь (переключатели, бейджи) и растянутые панели отсеиваем
        if (h >= 24 && h <= 80) out.push({ el, style: s, h });
      }
      for (const c of el.children) queue.push(c);
    }
  }

  // Свою рамку рисуем сами, копируя оформление с реально видимой плашки
  // той же строки (время, правые кнопки, пилюля-донор): ширина штатной
  // «пилюли» управляется скриптами YouTube под её собственное содержимое,
  // поэтому вставлять ползунок внутрь неё нельзя — он вылезает за фон.
  // Копирование с живого элемента даёт точное совпадение размеров и
  // оформления в любой версии интерфейса и теме; в старом интерфейсе
  // фоновых плашек нет — блок остаётся прозрачным.
  // Ближайший сосед, который реально занимает место. Спрятанный штатный
  // блок и пустые распорки вроде <span class="ytp-volume-area"> ширины не
  // имеют, но в DOM стоят между нами и настоящей кнопкой.
  function renderedNeighbour(back) {
    let el = back ? ui.box.previousElementSibling : ui.box.nextElementSibling;
    while (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0.5) return paintedEdge(el, rect, back);
      el = back ? el.previousElementSibling : el.nextElementSibling;
    }
    return null;
  }

  // Видимый край соседа. Коробка контрола бывает шире того, что нарисовано:
  // у `.ytp-time-display` таймкод лежит во вложенной плашке с собственным
  // отступом, и зазор до неё складывался из нашего поля и этого отступа —
  // до таймкода выходило заметно больше, чем у самого YouTube. Поэтому
  // ищем крайнюю обращённую к нам грань среди потомков.
  function paintedEdge(el, rect, back) {
    // Если сосед рисует фон сам, его коробка и есть видимая грань.
    if (!isTransparentBg(getComputedStyle(el).backgroundColor)) return rect;
    for (const child of el.children) {
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0.5) continue;
      // Спускаемся только к тому, кто сам рисует плашку. Иначе у прозрачной
      // кнопки (у .ytp-button фон none) мы бы взяли грань её значка: svg 36px
      // внутри кнопки 48px, и блок притягивался бы на шесть пикселей ближе
      // границы кнопки — а равнение идёт по границам объектов, не по глифам.
      if (isTransparentBg(getComputedStyle(child).backgroundColor)) continue;
      // Обращённую к нам грань берём у вложенной плашки, остальное неважно.
      return back
        ? { left: rect.left, right: Math.max(cr.right, rect.left) }
        : { left: Math.min(cr.left, rect.right), right: rect.right };
    }
    return rect;
  }

  /**
   * Приводит зазоры до соседей к ритму YouTube.
   *
   * Считать по чужим полям оказалось нельзя: отступ соседа складывается из
   * его margin, margin пустых распорок между нами и gap самой строки — и
   * промахнуться можно на любом из слагаемых. Поэтому меряем фактический
   * зазор при обнулённых своих полях и добираем ровно недостающее.
   */
  function applyEdgeMargins() {
    if (!ui) return;
    const st = ui.box.style;
    const target = edgeGap || 8; // на плоской вёрстке высота ещё не известна
    st.marginLeft = '0px';
    st.marginRight = '0px';
    const box = ui.box.getBoundingClientRect(); // замер после обнуления
    const before = renderedNeighbour(true);
    const after = renderedNeighbour(false);
    // Поле умеет и вычитать: лишний зазор бывает не только от чужих полей.
    // В строке Shorts штатный <volume-controls> остаётся нулевым по ширине,
    // но всё ещё элементом flex-строки, и собирает её gap с обеих сторон —
    // одним лишь неотрицательным полем эти восемь пикселей не убрать.
    // Ограничиваем одним ритмом, чтобы блок не наехал на соседа.
    const need = (actual) =>
      (actual == null
        ? target
        : Math.max(-target, Math.min(target, Math.round(target - actual)))) + 'px';
    st.marginLeft = need(before && box.left - before.right);
    st.marginRight = need(after && after.left - box.right);
  }

  function syncFrameStyle() {
    const player = getPlayer();
    if (uiResizeObserver && observedPill && isShorts()) {
      uiResizeObserver.unobserve(observedPill);
      observedPill = null;
    }
    // В Shorts копировать не с чего (плашек в плеере нет), поэтому рамку
    // задаём сами — тёмная «пилюля» в стиле кнопок YouTube, размеры от
    // ширины плеера, чтобы вписываться в любой размер окна
    if (ui.overlay) {
      const w = player ? player.clientWidth : 0;
      if (!w) return;
      const h = Math.max(30, Math.min(46, Math.round(w * 0.1)));
      const pad = Math.max(6, Math.round(h * 0.23));
      if (!shortsGap) shortsGap = Math.max(8, Math.round(h * 0.32));
      if (!shortsInset) shortsInset = Math.max(3, Math.round(h * 0.09));
      const st = ui.box.style;
      ui.box.classList.add('ytev-framed');
      st.background = 'rgba(0, 0, 0, .6)';
      st.borderRadius = h / 2 + 'px';
      st.setProperty('--ytev-round', h / 2 + 'px'); // свёрнутый круг
      st.height = h + 'px';
      st.margin = '0'; // положение задаёт слой (positionOverlay)
      st.setProperty('--ytev-pad', pad + 'px');
      st.setProperty('--ytev-hl-inset', shortsInset + 'px');
      st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(h / 2 - shortsInset)) + 'px');
      st.backdropFilter = '';
      return;
    }
    // строка кнопок Shorts: копируем оформление штатного блока громкости
    if (isShorts() && shortsFrame) {
      const st = ui.box.style;
      const h = shortsFrame.height;
      const pad = Math.max(6, Math.round(h * 0.23));
      if (!shortsInset) shortsInset = Math.max(3, Math.round(h * 0.09));
      ui.box.classList.add('ytev-framed');
      st.background = shortsFrame.bg;
      st.borderRadius = shortsFrame.radius;
      st.setProperty('--ytev-round', h / 2 + 'px'); // свёрнутый круг
      st.height = h + 'px';
      st.marginTop = '0';
      st.marginBottom = '0';
      st.setProperty('--ytev-pad', pad + 'px');
      st.setProperty('--ytev-hl-inset', shortsInset + 'px');
      st.setProperty(
        '--ytev-hl-radius',
        Math.max(4, Math.round((parseFloat(shortsFrame.radius) || h / 2) - shortsInset)) + 'px'
      );
      st.backdropFilter = '';
      applyEdgeMargins();
      return;
    }
    const surfaces = [];
    collectSurfaces(player && player.querySelector('.ytp-time-display'), surfaces);
    collectSurfaces(player && player.querySelector('.ytp-right-controls'), surfaces);
    collectSurfaces(findPill(), surfaces);
    let surface = null;
    for (const sf of surfaces) {
      if (!surface || sf.h < surface.h) surface = sf;
    }
    if (uiResizeObserver && (!surface || surface.el !== observedPill)) {
      if (observedPill) uiResizeObserver.unobserve(observedPill);
      observedPill = surface ? surface.el : null;
      if (observedPill) {
        uiResizeObserver.observe(observedPill); // плашка меняет высоту в big-mode
      }
    }
    const st = ui.box.style;
    ui.box.classList.toggle('ytev-framed', !!surface);
    if (!surface) {
      st.marginTop = '0';
      st.marginBottom = '0';
      st.background = '';
      st.borderRadius = '';
      st.height = '';
      st.backdropFilter = '';
      st.removeProperty('--ytev-pad');
      st.removeProperty('--ytev-round');
      st.removeProperty('--ytev-hl-inset');
      st.removeProperty('--ytev-hl-radius');
      applyEdgeMargins();
      return;
    }
    const s = surface.style;
    const h = Math.round(surface.h);
    if (!edgeGap) edgeGap = Math.max(6, Math.round(h * 0.2));
    st.marginTop = '0';
    st.marginBottom = '0';
    st.background = s.backgroundColor;
    st.borderRadius = s.borderRadius;
    st.setProperty('--ytev-round', h / 2 + 'px'); // свёрнутый круг
    st.height = h + 'px';
    // единый отступ со всех сторон: сверху/снизу его задаёт центровка
    // содержимого (кнопка ужата до «высота минус два отступа»), слева и
    // справа — боковые поля рамки той же величины
    const pad = Math.max(6, Math.round(h * 0.23));
    st.setProperty('--ytev-pad', pad + 'px');
    // зазор подсветки: одна пиксельная величина со всех четырёх сторон,
    // скругление слоя уменьшено на неё же — контуры концентричны
    if (!hlInset) hlInset = Math.max(3, Math.round(h * 0.09));
    const radius = parseFloat(s.borderRadius) || h / 2;
    st.setProperty('--ytev-hl-inset', hlInset + 'px');
    st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(radius - hlInset)) + 'px');
    st.backdropFilter = s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : '';
    applyEdgeMargins();
  }

  // Свободное место под ползунок: идём от нашего блока вверх до строки
  // управления (через любое число обёрток — в новом интерфейсе YouTube
  // кнопки вложены в «пилюли») и на каждом уровне вычитаем соседей вместе
  // с отступами, а у промежуточных обёрток — их собственные поля и рамки.
  function freeSpace(row) {
    let free = innerWidth(row);
    if (free <= 0) return 0; // панель скрыта — измерить нечего

    for (let node = ui.box; node && node !== row; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) return 0; // блок оторван от DOM
      for (const sib of parent.children) {
        if (sib !== node) free -= outerWidth(sib);
      }
      if (parent !== row) {
        const s = getComputedStyle(parent);
        free -=
          num(s.paddingLeft) + num(s.paddingRight) +
          num(s.marginLeft) + num(s.marginRight) +
          num(s.borderLeftWidth) + num(s.borderRightWidth);
      }
    }
    // собственные отступы блока и место под подпись с процентами
    free -= outerWidth(ui.box) - ui.slider.getBoundingClientRect().width;
    return free - SAFETY_GAP;
  }

  // Видимость подписи с процентами. Класс на блоке нужен рамке: без
  // подписи за концом шкалы остаётся собственный «хвост», иначе дорожка
  // упирается в край. Подпись прячет и настройка, и нехватка места, поэтому
  // решение живёт в одном месте.
  function showLabel(visible) {
    if (!ui) return;
    // Прячем обёртку, а не саму подпись: скрытая подпись внутри видимой
    // обёртки оставила бы после шкалы лишний промежуток.
    ui.labelSlot.style.display = visible ? '' : 'none';
    ui.box.classList.toggle('ytev-nolabel', !visible);
  }

  // Длина ползунка = настраиваемая доля ширины плеера, ограниченная
  // свободным местом; по краям рамки — постоянный зазор edgeGap. Если
  // места мало, сначала убираем подпись с процентами, а если и это не
  // помогло — прячем ползунок и возвращаем штатный (мини-плеер, узкое
  // окно).
  function layout() {
    if (!ui) return;
    // идёт анимация сворачивания — замеры бессмысленны, вернёмся тиком позже
    if (ui.box.classList.contains('ytev-animating')) return;
    const player = getPlayer();
    if (!player) return;

    // Shorts: блок стоит либо в строке кнопок самого Shorts (она вне
    // элемента плеера, соседей для расчёта нет), либо в своём слое —
    // длину в обоих случаях берём от ширины плеера по своей настройке
    if (ui.overlay || ui.shortsRow) {
      const wasFolded = ui.box.classList.contains('ytev-collapsed');
      ui.box.classList.remove('ytev-collapsed');
      enterNormal(player);
      showLabel(SETTINGS.showPercent);
      // кнопка у правого края — раскрываемся влево
      ui.box.classList.toggle('ytev-mirrored', !!shortsAnchor && shortsAnchor.fx > 0.5);
      syncFrameStyle();
      const pw = player.clientWidth;
      if (!pw) return;
      setSliderWidth(MIN_SLIDER);
      const extra = ui.box.getBoundingClientRect().width - MIN_SLIDER;
      // в строке кнопок место считаем от её левого края до края плеера
      const room = ui.overlay
        ? pw - 2 * shortsGap - extra
        : player.getBoundingClientRect().right -
          ui.box.parentElement.getBoundingClientRect().left -
          extra -
          16;
      const width = Math.max(MIN_SLIDER, Math.min(pw * (activeScale() / 100), room));
      setSliderWidth(width);
      ui.trackW = ui.slider.getBoundingClientRect().width;
      ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
      updateUI();
      if (wasFolded) updateCollapsed(false);
      if (ui.overlay) positionOverlay();
      return;
    }

    // строка управления — ближайший предок, в котором есть и правые кнопки
    const rightControls = player.querySelector('.ytp-right-controls');
    let row = ui.box.parentElement;
    while (row && row !== player && !(rightControls && row.contains(rightControls))) {
      row = row.parentElement;
    }
    if (!row) return;

    // меряем в развёрнутом видимом состоянии и без штатного ползунка,
    // иначе решение зависело бы от предыдущего и режим отката «залипал» бы
    const wasCollapsed = ui.box.classList.contains('ytev-collapsed');
    ui.box.classList.remove('ytev-collapsed');
    enterNormal(player);
    showLabel(SETTINGS.showPercent);
    syncFrameStyle(); // поля рамки влияют на замер — обновляем до него
    if (innerWidth(row) <= 0) {
      if (wasCollapsed) updateCollapsed(false);
      return;
    }

    // Меряем, сжав ползунок до минимума: соседи (название главы) тоже
    // умеют сжиматься, и замер при текущей длине зависел бы от неё самой —
    // размер бы «дрожал» между двумя значениями. От минимума результат
    // один и тот же независимо от предыдущего состояния.
    setSliderWidth(MIN_SLIDER);

    let free = freeSpace(row);
    if (free < MIN_SLIDER && SETTINGS.showPercent) {
      showLabel(false);
      free = freeSpace(row);
    }

    // длина — настраиваемая доля ширины плеера, ограниченная свободным местом
    const desired = player.clientWidth * (activeScale() / 100);
    setSliderWidth(Math.max(MIN_SLIDER, Math.min(desired, free)));

    checkRowOverlap();
    if (!ui) return; // пересобрались в другом месте — раскладку доделает новый цикл

    // размеры дорожки и бегунка для расчёта заливки (см. paint)
    ui.trackW = ui.slider.getBoundingClientRect().width;
    ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
    updateUI();

    // подстраховка на случай неточного замера: если flex всё-таки сжал
    // ползунок до бесполезной длины — отдаём место штатному
    if (ui.slot.getBoundingClientRect().width < MIN_SLIDER - 1) {
      enterFallback(player);
    } else if (wasCollapsed) {
      updateCollapsed(false); // вернуть свёрнутое состояние без анимации
    }
  }

  // Автосворачивание: класс ytev-collapsed ставится, когда включена
  // настройка и на блоке нет ни курсора, ни фокуса. Переходы включаются
  // только на время переключения, чтобы не мешать замерам layout().
  let animTimer = 0;
  let animCleanup = null;
  // Пауза «старого режима»: столько ждём после ухода указателя, если
  // включена настройка «Задержка перед сворачиванием».
  const COLLAPSE_DELAY_MS = 500;
  let collapseTimer = 0;
  function updateCollapsed(animate = true) {
    if (!ui) return;
    // разворот держит только клавиатурный фокус (:focus-visible) — обычный
    // клик по кнопке оставляет фокус внутри блока и не должен мешать
    // сворачиванию
    let keyboardFocus = false;
    try {
      keyboardFocus = !!ui.box.querySelector(':focus-visible');
    } catch {}
    const want = !!SETTINGS.autoCollapse && !ui.hover && !keyboardFocus;
    if (want === ui.box.classList.contains('ytev-collapsed')) return;
    if (!animate) {
      ui.box.classList.toggle('ytev-collapsed', want);
      return;
    }
    const box = ui.box;
    const slider = ui.slider;
    // Быстрое «увёл-вернул курсор» приходит раньше конца прошлой анимации:
    // прибираем за ней, иначе слушатели копились бы на блоке.
    if (animCleanup) animCleanup();
    box.classList.add('ytev-animating');
    box.classList.toggle('ytev-collapsed', want);
    // Конец анимации ловим событием, а не отсчётом: прежние 350мс были
    // взяты с запасом к переходам в 250мс, и лишние 100мс замеры layout()
    // просто простаивали. Таймер остаётся страховкой — переход может не
    // случиться вовсе (нулевая длительность при prefers-reduced-motion,
    // свёрнутый блок вне экрана), и снимать класс всё равно нужно.
    const finish = () => {
      clearTimeout(animTimer);
      animTimer = 0;
      animCleanup = null;
      box.removeEventListener('transitionend', onEnd);
      box.classList.remove('ytev-animating');
      if (ui && ui.box === box) scheduleLayout();
    };
    const onEnd = (e) => {
      // Ширину шкалы меняет самый долгий переход; чужие всплывшие события
      // (например, opacity подсветки) конец анимации не означают.
      if (e.target === slider && e.propertyName === 'width') finish();
    };
    animCleanup = finish;
    box.addEventListener('transitionend', onEnd);
    animTimer = setTimeout(finish, 400);
  }

