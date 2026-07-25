// Работает в MAIN-мире страницы: перехватывает установку громкости у
// HTMLMediaElement и применяет экспоненциальную кривую, а также добавляет
// в панель плеера длинный точный ползунок вместо стандартного.
(() => {
  'use strict';

  const SETTINGS = {
    enabled: true,       // применять экспоненциальную кривую
    gamma: 3,            // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderScale: 20,     // длина ползунка в % от ширины плеера
    showPercent: true,   // подпись с процентами рядом с ползунком
    autoCollapse: false, // сворачивать шкалу, когда курсор не на ней
  };

  /* ------------------------------------------------------------------ *
   * 1. Экспоненциальная кривая громкости
   *
   * YouTube выставляет video.volume линейно (позиция ползунка / 100),
   * но восприятие громкости логарифмическое, поэтому внизу шкалы шаги
   * слишком грубые. Подменяем сеттер volume: сохраняем «логическое»
   * значение (то, что видит YouTube) и отдаём в аудиотракт value^gamma.
   * Геттер возвращает логическое значение, так что для YouTube ничего
   * не меняется.
   * ------------------------------------------------------------------ */

  const mediaProto = HTMLMediaElement.prototype;
  const nativeDesc = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const logicalVolume = new WeakMap();

  const toReal = (v) => (SETTINGS.enabled ? Math.pow(v, SETTINGS.gamma) : v);

  Object.defineProperty(mediaProto, 'volume', {
    configurable: true,
    enumerable: nativeDesc.enumerable,
    get() {
      return logicalVolume.has(this)
        ? logicalVolume.get(this)
        : nativeDesc.get.call(this);
    },
    set(value) {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        // нативный сеттер сам бросит корректную ошибку
        nativeDesc.set.call(this, value);
        return;
      }
      logicalVolume.set(this, v);
      const real = toReal(v);
      // не трогаем аудиотракт, если фактическое значение не меняется:
      // повторные записи того же уровня не должны давать даже шанса на щелчки
      if (Math.abs(nativeDesc.get.call(this) - real) > 1e-6) {
        nativeDesc.set.call(this, real);
      }
    },
  });

  // Применить кривую заново (после смены настроек)
  function reapplyCurve() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (logicalVolume.has(el)) {
        nativeDesc.set.call(el, toReal(logicalVolume.get(el)));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Настройки из popup (приходят через bridge.js, isolated world)
   * ------------------------------------------------------------------ */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'YTEV_SETTINGS') return;
    Object.assign(SETTINGS, e.data.settings);
    reapplyCurve();
    layout();
    updateUI();
    updateCollapsed();
  });
  window.postMessage({ type: 'YTEV_GET_SETTINGS' }, '*');

  /* ------------------------------------------------------------------ *
   * 3. Длинный точный ползунок в панели плеера
   *
   * Размеры задаются относительно плеера: толщина ползунка, бегунок и
   * подпись масштабируются через CSS-переменные (в полноэкранном режиме
   * YouTube ставит на плеер класс ytp-big-mode), а длина считается в JS —
   * доля ширины плеера, ограниченная реально свободным местом в панели.
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    /* Штатные ползунок и кнопка звука скрываются ТОЛЬКО при классе
       ytev-active — он ставится после успешного монтирования нашего
       блока и снимается в режиме отката. Если код расширения упадёт,
       класса не будет и штатная громкость останется на месте. */
    #movie_player.ytev-active .ytp-volume-panel,
    #movie_player.ytev-active .ytp-mute-button {
      display: none !important;
    }
    /* при наведении YouTube резервирует ширину под выезжающий штатный
       ползунок — он скрыт, поэтому рамка раздувалась бы впустую; пока
       работает наш ползунок, запрещаем области громкости менять ширину */
    #movie_player.ytev-active .ytp-volume-area {
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      transition: none !important;
    }
    .ytev-box {
      --ytev-track: 4px;
      --ytev-thumb: 13px;
      --ytev-font: 12px;
      display: flex;
      align-items: center;
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      margin: 0 8px;
      position: relative;
    }
    /* содержимое поверх слоя подсветки */
    .ytev-box > * { position: relative; z-index: 1; }
    /* геометрия рамки: справа поле --ytev-pad, слева меньше — значок
       YouTube (viewBox 36×36) несёт собственные внутренние поля */
    .ytev-box.ytev-framed {
      padding: 0 var(--ytev-pad, 10px) 0 calc(var(--ytev-pad, 10px) * .25);
      gap: calc(var(--ytev-pad, 10px) * .5);
    }
    .ytev-box:not(.ytev-framed) { gap: 6px; }
    /* своя кнопка звука с оригинальным значком YouTube: почти на всю
       высоту рамки, как у штатной, — сам глиф имеет поля внутри viewBox */
    .ytev-mute {
      flex: none;
      height: calc(100% - 4px);
      aspect-ratio: 1 / 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      padding: 0;
      margin: 0;
      color: #fff;
      cursor: pointer;
    }
    .ytev-box:not(.ytev-framed) .ytev-mute { height: 36px; }
    .ytev-mute svg { width: 100%; height: 100%; display: block; }
    /* состояния значка как у YouTube: тихо — без волн, до 50% — одна
       волна, громче — две, выключен — перечёркнут; волны плавно
       появляются/уходят от «рупора» */
    .ytev-i-w1, .ytev-i-w2 {
      opacity: 0;
      transform: scale(.4);
      transform-box: fill-box;
      transform-origin: left center;
      transition: opacity .18s ease, transform .18s ease;
    }
    .ytev-i-off {
      opacity: 0;
      transition: opacity .15s ease;
    }
    .ytev-box[data-vol="low"] .ytev-i-w1 { opacity: 1; transform: none; }
    .ytev-box[data-vol="high"] .ytev-i-w1,
    .ytev-box[data-vol="high"] .ytev-i-w2 { opacity: 1; transform: none; }
    .ytev-box[data-vol="muted"] .ytev-i-off { opacity: 1; }
    /* автосворачивание: без курсора остаётся только кнопка; переходы
       включаются лишь на время переключения (.ytev-animating), чтобы
       не мешать замерам layout() */
    .ytev-box.ytev-animating { transition: gap .25s ease; }
    .ytev-box.ytev-animating .ytev-slider { transition: width .25s ease, opacity .2s ease; }
    .ytev-box.ytev-animating .ytev-label { transition: max-width .25s ease, opacity .2s ease; }
    .ytev-box.ytev-collapsed { gap: 0; }
    .ytev-box.ytev-collapsed .ytev-slider {
      width: 0 !important;
      min-width: 0 !important;
      opacity: 0;
    }
    .ytev-box.ytev-collapsed .ytev-label {
      max-width: 0;
      min-width: 0;
      opacity: 0;
    }
    /* подсветка при наведении — внутренний скруглённый слой с одинаковым
       пиксельным зазором со всех четырёх сторон, как у штатных «пилюль»
       YouTube; скругление уменьшено на величину зазора, чтобы контуры
       были концентричными; на раскладку не влияет */
    .ytev-box.ytev-framed::after {
      content: '';
      position: absolute;
      inset: var(--ytev-hl-inset, 4px);
      border-radius: var(--ytev-hl-radius, 16px);
      background: rgba(255, 255, 255, .12);
      opacity: 0;
      transition: opacity .1s;
      pointer-events: none;
      z-index: 0;
    }
    .ytev-box.ytev-framed:hover::after { opacity: 1; }
    #movie_player.ytp-big-mode .ytev-box {
      --ytev-track: 5px;
      --ytev-thumb: 18px;
      --ytev-font: 15px;
      margin-left: 10px;
    }
    .ytev-slider {
      -webkit-appearance: none;
      appearance: none;
      min-width: 0;
      height: var(--ytev-track);
      border-radius: calc(var(--ytev-track) / 2);
      background: rgba(255, 255, 255, .3);
      outline: none;
      cursor: pointer;
      margin: 0;
    }
    .ytev-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: var(--ytev-thumb);
      height: var(--ytev-thumb);
      border-radius: 50%;
      background: #fff;
      border: none;
    }
    .ytev-label {
      color: #eee;
      font-family: Roboto, Arial, sans-serif;
      font-size: var(--ytev-font);
      line-height: 1;
      min-width: 2.5em; /* ровно под «100%», чтобы рамка не гуляла по ширине */
      max-width: 5em;
      overflow: hidden;
      text-align: center; /* запас ширины делится поровну на обе стороны */
      white-space: nowrap;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  const MIN_SLIDER = 48; // короче — бесполезно, лучше спрятать
  const SAFETY_GAP = 4;  // запас на округления, чтобы панель не «поехала»

  // фиксированные константы, вычисляются ОДИН раз из размеров плашки при
  // первом измерении и дальше не меняются:
  let edgeGap = 0; // отступ по краям рамки (снаружи)
  let hlInset = 0; // зазор слоя подсветки от рамки, одинаковый со всех сторон

  // { box, slider, label, muteBtn, hiddenPill }
  let ui = null;
  let boundVideo = null;
  let observedPlayer = null;
  let observedPill = null;

  const getPlayer = () => document.getElementById('movie_player');
  const getVideo = () => {
    const p = getPlayer();
    return p ? p.querySelector('video') : null;
  };

  const fmt = (pct) => (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';

  function paint(pct) {
    ui.slider.style.background =
      `linear-gradient(to right, #fff 0% ${pct}%, rgba(255,255,255,.3) ${pct}% 100%)`;
  }

  function updateUI() {
    if (!ui) return;
    const video = getVideo();
    if (!video) return;
    const pct = video.volume * 100; // логическая громкость
    ui.slider.value = pct;
    paint(pct);
    ui.label.textContent = fmt(pct);
    const muted = video.muted || pct === 0;
    ui.box.classList.toggle('ytev-muted', muted);
    ui.box.dataset.vol = muted ? 'muted' : pct < 50 ? 'low' : 'high';
    if (ui.muteBtn) {
      ui.muteBtn.title = muted ? 'Включить звук (m)' : 'Отключить звук (m)';
    }
    const real = toReal(pct / 100) * 100;
    ui.slider.title = SETTINGS.enabled
      ? `Громкость: ${fmt(pct)} (на выходе ≈ ${fmt(real)})`
      : `Громкость: ${fmt(pct)}`;
  }

  const num = (v) => parseFloat(v) || 0;

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
    player.classList.add('ytev-active');
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = 'none';
    }
    ui.box.style.display = '';
  }

  // Откат (узкий плеер): наш блок спрятан, снятие класса возвращает
  // штатные кнопку и ползунок
  function enterFallback(player) {
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
  function syncFrameStyle() {
    const player = getPlayer();
    const surfaces = [];
    collectSurfaces(player && player.querySelector('.ytp-time-display'), surfaces);
    collectSurfaces(player && player.querySelector('.ytp-right-controls'), surfaces);
    collectSurfaces(findPill(), surfaces);
    let surface = null;
    for (const sf of surfaces) {
      if (!surface || sf.h < surface.h) surface = sf;
    }
    if (resizeObserver && surface && surface.el !== observedPill) {
      resizeObserver.observe(surface.el); // плашка меняет высоту в big-mode
      observedPill = surface.el;
    }
    const st = ui.box.style;
    ui.box.classList.toggle('ytev-framed', !!surface);
    if (!surface) {
      st.background = '';
      st.borderRadius = '';
      st.height = '';
      st.backdropFilter = '';
      st.removeProperty('--ytev-pad');
      st.removeProperty('--ytev-hl-inset');
      st.removeProperty('--ytev-hl-radius');
      return;
    }
    const s = surface.style;
    const h = Math.round(surface.h);
    if (!edgeGap) edgeGap = Math.max(6, Math.round(h * 0.2));
    st.margin = '0 ' + edgeGap + 'px';
    st.background = s.backgroundColor;
    st.borderRadius = s.borderRadius;
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
    ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
    syncFrameStyle(); // поля рамки влияют на замер — обновляем до него
    if (innerWidth(row) <= 0) {
      if (wasCollapsed) updateCollapsed(false);
      return;
    }

    // Меряем, сжав ползунок до минимума: соседи (название главы) тоже
    // умеют сжиматься, и замер при текущей длине зависел бы от неё самой —
    // размер бы «дрожал» между двумя значениями. От минимума результат
    // один и тот же независимо от предыдущего состояния.
    ui.slider.style.width = MIN_SLIDER + 'px';

    let free = freeSpace(row);
    if (free < MIN_SLIDER && SETTINGS.showPercent) {
      ui.label.style.display = 'none';
      free = freeSpace(row);
    }

    // длина — настраиваемая доля ширины плеера, ограниченная свободным
    // местом (защита от нечисловой настройки — старый формат записи)
    const scale = num(SETTINGS.sliderScale) || 20;
    const desired = player.clientWidth * (scale / 100);
    ui.slider.style.width =
      Math.round(Math.max(MIN_SLIDER, Math.min(desired, free))) + 'px';

    // подстраховка на случай неточного замера: если flex всё-таки сжал
    // ползунок до бесполезной длины — отдаём место штатному
    if (ui.slider.getBoundingClientRect().width < MIN_SLIDER - 1) {
      enterFallback(player);
    } else if (wasCollapsed) {
      updateCollapsed(false); // вернуть свёрнутое состояние без анимации
    }
  }

  // Автосворачивание: класс ytev-collapsed ставится, когда включена
  // настройка и на блоке нет ни курсора, ни фокуса. Переходы включаются
  // только на время переключения, чтобы не мешать замерам layout().
  let collapseTimer = 0;
  let animTimer = 0;
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
    ui.box.classList.add('ytev-animating');
    ui.box.classList.toggle('ytev-collapsed', want);
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      if (ui) ui.box.classList.remove('ytev-animating');
      scheduleLayout();
    }, 350);
  }

  function bindVideo() {
    const video = getVideo();
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('volumechange', updateUI);
    updateUI();
  }

  // Пересчёт по любому изменению размеров откладываем до следующего
  // кадра: layout() сам меняет ширину ползунка, и синхронный вызов из
  // ResizeObserver зациклил бы наблюдатель. Повторные вызовы схлопываются.
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  // Плеер меняет размер при разворачивании, режиме театра, ресайзе окна;
  // рамка вокруг ползунка — ещё и при наведении и перестройках интерфейса
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;

  function observePlayer() {
    const player = getPlayer();
    if (!resizeObserver || !player || player === observedPlayer) return;
    if (observedPlayer) resizeObserver.unobserve(observedPlayer);
    resizeObserver.observe(player);
    observedPlayer = player;
  }

  // Следим за всеми контейнерами от ползунка до плеера: если рамка (или
  // любая обёртка) изменит размер, длина пересчитается сразу, а не по
  // секундному таймеру
  function observeChain() {
    if (!resizeObserver || !ui) return;
    const player = getPlayer();
    for (let el = ui.box.parentElement; el && el !== player; el = el.parentElement) {
      resizeObserver.observe(el); // повторный observe того же узла — no-op
    }
  }

  function ensureUI() {
    const controls = document.querySelector('#movie_player .ytp-left-controls');
    if (!controls) return;
    observePlayer();
    if (ui && controls.contains(ui.box)) {
      if (ui.hiddenPill && !ui.hiddenPill.isConnected) markDonorPill(controls);
      bindVideo();
      layout();
      return;
    }

    // блоки, оставшиеся от прежней загрузки расширения (после обновления);
    // живую штатную кнопку из такого блока возвращаем в панель, не удаляем
    for (const stale of document.querySelectorAll('.ytev-box')) {
      if (ui && stale === ui.box) continue;
      const orphanMute = stale.querySelector('.ytp-mute-button');
      if (orphanMute) stale.before(orphanMute);
      stale.remove();
    }

    const box = document.createElement('div');
    box.className = 'ytev-box';

    // Своя кнопка звука: значок предсказуемо центрирован при любом
    // размере. SVG строится через DOM API — на youtube.com действует
    // Trusted Types CSP, и присваивание строки в innerHTML бросает
    // исключение.
    const muteBtn = document.createElement('button');
    muteBtn.className = 'ytev-mute';
    muteBtn.type = 'button';
    {
      // оригинальные пути значка громкости из плеера YouTube (36×36)
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 36 36');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');
      const paths = [
        ['', 'M8,21 L12,21 L17,26 L17,10 L12,15 L8,15 L8,21 Z'],
        ['ytev-i-w1', 'M19,14 L19,22 C20.48,21.32 21.5,19.77 21.5,18 C21.5,16.26 20.48,14.74 19,14 Z'],
        ['ytev-i-w2', 'M19,11.29 C21.89,12.15 24,14.83 24,18 C24,21.17 21.89,23.85 19,24.71 L19,26.77 C23.01,25.86 26,22.28 26,18 C26,13.72 23.01,10.14 19,9.23 L19,11.29 Z'],
        ['ytev-i-off', 'M9.25,9 L7.98,10.27 L24.71,27 L25.98,25.73 L9.25,9 Z'],
      ];
      for (const [cls, d] of paths) {
        const path = document.createElementNS(NS, 'path');
        if (cls) path.setAttribute('class', cls);
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      muteBtn.appendChild(svg);
    }
    muteBtn.addEventListener('click', () => {
      const player = getPlayer();
      const video = getVideo();
      if (!video) return;
      if (video.muted || video.volume === 0) {
        if (player && typeof player.unMute === 'function') player.unMute();
        video.muted = false;
      } else {
        if (player && typeof player.mute === 'function') player.mute();
        else video.muted = true;
      }
    });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.1';
    slider.className = 'ytev-slider';

    const label = document.createElement('span');
    label.className = 'ytev-label';

    box.append(muteBtn, slider, label);

    // встаём после «пилюли» с кнопками, а не внутрь неё: YouTube управляет
    // её шириной из скриптов под собственное содержимое, и вставленный
    // внутрь ползунок вылезал за фон. Рамку блок рисует сам (syncFrameStyle)
    let anchor = controls.querySelector('.ytp-volume-area, .ytp-mute-button');
    while (anchor && anchor.parentElement !== controls) anchor = anchor.parentElement;
    if (anchor) anchor.after(box);
    else controls.appendChild(box);

    slider.addEventListener('input', applySliderValue);
    // стрелки должны двигать ползунок (шаг 0.1%), а не перематывать видео
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    // автосворачивание: следим за курсором и фокусом на блоке
    box.addEventListener('mouseenter', () => {
      if (!ui) return;
      ui.hover = true;
      clearTimeout(collapseTimer);
      updateCollapsed();
    });
    box.addEventListener('mouseleave', () => {
      if (!ui) return;
      ui.hover = false;
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(updateCollapsed, 500);
    });
    box.addEventListener('focusin', () => updateCollapsed());
    box.addEventListener('focusout', () => setTimeout(updateCollapsed, 0));
    // колесо мыши над ползунком: ±1%, с Shift ±0.1%
    box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 0.1 : 1;
        const cur = Number(slider.value);
        slider.value = Math.min(100, Math.max(0, cur + (e.deltaY < 0 ? step : -step)));
        applySliderValue();
      },
      { passive: false }
    );

    ui = { box, slider, label, muteBtn, hover: false };
    markDonorPill(controls);
    observeChain();
    bindVideo();
    updateUI();
    layout();
    updateCollapsed(false);
  }

  // Во время регулировки громкость пишется ТОЛЬКО напрямую в
  // video.volume — одно точное значение на событие. Вызов
  // player.setVolume на каждом событии давал по две быстрые записи
  // чуть разных значений (округлённое YouTube + наше точное) — слышимый
  // треск; а дробное число в setVolume YouTube мог переокруглять сам и
  // потрескивать даже без движения ползунка. Сохранение громкости в
  // настройках YouTube делаем отложенно, один раз после конца движения
  // и только целым числом.
  let persistTimer = 0;
  function applySliderValue() {
    const video = getVideo();
    const player = getPlayer();
    if (!video || !ui) return;
    const pct = Math.min(100, Math.max(0, Number(ui.slider.value)));
    if (video.muted && pct > 0) {
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    video.volume = pct / 100;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const p = getPlayer();
      const v = getVideo();
      if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(pct));
      if (v) v.volume = pct / 100; // вернуть точное значение после округления
    }, 250);
  }

  // YouTube — SPA: плеер может появляться/пересоздаваться при навигации
  setInterval(ensureUI, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(ensureUI, 0));
  document.addEventListener('DOMContentLoaded', ensureUI);
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 0));
  window.addEventListener('resize', layout);
})();
