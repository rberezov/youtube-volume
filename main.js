// Работает в MAIN-мире страницы: перехватывает установку громкости у
// HTMLMediaElement и применяет экспоненциальную кривую, а также добавляет
// в панель плеера длинный точный ползунок вместо стандартного.
(() => {
  'use strict';

  const SETTINGS = {
    enabled: true,      // применять экспоненциальную кривую
    gamma: 3,           // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderScale: 20,    // длина ползунка в % от ширины плеера
    showPercent: true,  // подпись с процентами рядом с ползунком
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
      nativeDesc.set.call(this, toReal(v));
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
    /* штатный ползунок скрыт, но возвращается, если для нашего нет места */
    #movie_player:not(.ytev-fallback) .ytp-volume-panel { display: none !important; }
    /* при наведении YouTube резервирует ширину под выезжающий штатный
       ползунок — он скрыт, поэтому рамка раздувалась бы впустую; пока
       работает наш ползунок, запрещаем области громкости менять ширину */
    #movie_player:not(.ytev-fallback) .ytp-volume-area {
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
    /* геометрия рамки: отступ --ytev-pad одинаков со всех сторон.
       Кнопка mute (у YouTube это большая «зона нажатия» с внутренними
       полями под другой размер) ужимается до квадрата высотой
       «рамка минус два отступа» и принудительно центрируется — иконка
       в кнопках YouTube задана в процентах и следует за размером */
    .ytev-box.ytev-framed {
      padding: 0 var(--ytev-pad, 10px);
      gap: calc(var(--ytev-pad, 10px) * .8);
    }
    .ytev-box:not(.ytev-framed) { gap: 6px; }
    .ytev-box.ytev-framed .ytp-mute-button {
      height: calc(100% - 2 * var(--ytev-pad, 10px)) !important;
      width: auto !important;
      aspect-ratio: 1 / 1 !important;
      min-height: 0 !important;
      min-width: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      overflow: visible;
    }
    /* сам значок YouTube размещает внутри кнопки собственной раскладкой
       (абсолютные позиции/поля под другой размер) — принудительно
       растягиваем прямых потомков на кнопку, чтобы значок был по центру */
    .ytev-box.ytev-framed .ytp-mute-button > * {
      position: static !important;
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
    }
    /* подсветка при наведении — скруглённый слой с отступом только по
       бокам, как у штатных элементов YouTube; на раскладку не влияет */
    .ytev-box.ytev-framed::after {
      content: '';
      position: absolute;
      inset: 0 var(--ytev-hl-inset, 4px);
      border-radius: inherit;
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
      text-align: center; /* запас ширины делится поровну на обе стороны */
      white-space: nowrap;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  const MIN_SLIDER = 48; // короче — бесполезно, лучше спрятать
  const SAFETY_GAP = 16; // запас, чтобы панель не «поехала»

  // { box, slider, label, mute, muteHome, muteRef, hiddenPill }
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
      `linear-gradient(to right, #f00 0% ${pct}%, rgba(255,255,255,.3) ${pct}% 100%)`;
  }

  function updateUI() {
    if (!ui) return;
    const video = getVideo();
    if (!video) return;
    const pct = video.volume * 100; // логическая громкость
    ui.slider.value = pct;
    paint(pct);
    ui.label.textContent = fmt(pct);
    ui.box.classList.toggle('ytev-muted', video.muted || pct === 0);
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
  // и в котором изначально жила кнопка звука (сама кнопка теперь может
  // находиться внутри нашего блока)
  function findPill() {
    const controls = ui.box.parentElement;
    if (!controls) return null;
    let el =
      (ui.hiddenPill && ui.hiddenPill.isConnected ? ui.hiddenPill : null) ||
      (ui.muteHome && ui.muteHome.isConnected ? ui.muteHome : null) ||
      controls.querySelector('.ytp-volume-area, .ytp-mute-button');
    if (!el || ui.box.contains(el)) return null;
    while (el && el.parentElement !== controls) el = el.parentElement;
    return el && el !== ui.box ? el : null;
  }

  // Переносим штатную кнопку mute внутрь нашего блока — ползунок и кнопка
  // оказываются в одной рамке. Слушатели YouTube при перемещении узла
  // сохраняются. Если после переноса в «пилюле» не осталось видимых
  // кнопок, прячем её целиком (иначе висел бы пустой кружок фона).
  function adoptMute(controls) {
    const mute = controls.querySelector('.ytp-mute-button');
    if (!mute || ui.box.contains(mute)) return;
    ui.mute = mute;
    ui.muteHome = mute.parentElement;
    ui.muteRef = mute.nextElementSibling;
    ui.box.prepend(mute);
    ui.hiddenPill = null;
    let pill = ui.muteHome;
    while (pill && pill.parentElement !== controls) pill = pill.parentElement;
    if (pill && pill !== ui.box) {
      const hasVisible = [...pill.querySelectorAll('button, [role="button"]')]
        .some((b) => b.offsetWidth > 0);
      if (!hasVisible) {
        ui.hiddenPill = pill;
        pill.style.display = 'none';
      }
    }
  }

  // Нормальный режим: кнопка в нашем блоке, пустая пилюля спрятана
  function enterNormal(player) {
    player.classList.remove('ytev-fallback');
    if (ui.mute && ui.mute.isConnected && ui.mute.parentElement !== ui.box) {
      ui.box.prepend(ui.mute);
    }
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = 'none';
    }
    ui.box.style.display = '';
  }

  // Откат (узкий плеер): наш блок спрятан, кнопка возвращается на родное
  // место рядом со штатным ползунком, пилюля снова видима
  function enterFallback(player) {
    ui.box.style.display = 'none';
    if (
      ui.mute &&
      ui.muteHome &&
      ui.muteHome.isConnected &&
      ui.mute.parentElement === ui.box
    ) {
      const ref =
        ui.muteRef && ui.muteRef.parentElement === ui.muteHome ? ui.muteRef : null;
      ui.muteHome.insertBefore(ui.mute, ref);
    }
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    player.classList.add('ytev-fallback');
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
      return;
    }
    const s = surface.style;
    const h = Math.round(surface.h);
    st.background = s.backgroundColor;
    st.borderRadius = s.borderRadius;
    st.height = h + 'px';
    // единый отступ со всех сторон: сверху/снизу его задаёт центровка
    // содержимого (кнопка ужата до «высота минус два отступа»), слева и
    // справа — боковые поля рамки той же величины
    const pad = Math.max(6, Math.round(h * 0.23));
    st.setProperty('--ytev-pad', pad + 'px');
    st.setProperty('--ytev-hl-inset', Math.max(3, Math.round(pad * 0.45)) + 'px');
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

  // Длина ползунка = доля ширины плеера, ограниченная свободным местом.
  // Если места мало, сначала убираем подпись с процентами, а если и это не
  // помогло — прячем ползунок и возвращаем штатный (мини-плеер, узкое окно).
  function layout() {
    if (!ui) return;
    const player = getPlayer();
    if (!player) return;
    // строка управления — ближайший предок, в котором есть и правые кнопки
    const rightControls = player.querySelector('.ytp-right-controls');
    let row = ui.box.parentElement;
    while (row && row !== player && !(rightControls && row.contains(rightControls))) {
      row = row.parentElement;
    }
    if (!row) return;

    // меряем в видимом состоянии и без штатного ползунка, иначе решение
    // зависело бы от предыдущего и режим отката «залипал» бы
    enterNormal(player);
    ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
    syncFrameStyle(); // поля рамки влияют на замер — обновляем до него
    if (innerWidth(row) <= 0) return;

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

    // защита от нечисловой/отсутствующей настройки (например, осталась
    // запись старого формата) — иначе ширина стала бы NaN и не применилась
    const scale = num(SETTINGS.sliderScale) || 20;
    const desired = player.clientWidth * (scale / 100);
    ui.slider.style.width =
      Math.round(Math.max(MIN_SLIDER, Math.min(desired, free))) + 'px';

    // подстраховка на случай неточного замера: если flex всё-таки сжал
    // ползунок до бесполезной длины — отдаём место штатному
    if (ui.slider.getBoundingClientRect().width < MIN_SLIDER - 1) {
      enterFallback(player);
    }
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
      if (!ui.mute || !ui.mute.isConnected) adoptMute(controls);
      bindVideo();
      layout();
      return;
    }

    // блоки, оставшиеся от прежней загрузки расширения (после обновления);
    // живую кнопку mute из такого блока возвращаем в панель, не удаляем
    for (const stale of document.querySelectorAll('.ytev-box')) {
      if (ui && stale === ui.box) continue;
      const orphanMute = stale.querySelector('.ytp-mute-button');
      if (orphanMute) stale.before(orphanMute);
      stale.remove();
    }

    const box = document.createElement('div');
    box.className = 'ytev-box';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.1';
    slider.className = 'ytev-slider';

    const label = document.createElement('span');
    label.className = 'ytev-label';

    box.append(slider, label);

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

    ui = { box, slider, label };
    adoptMute(controls);
    observeChain();
    bindVideo();
    updateUI();
    layout();
  }

  function applySliderValue() {
    const video = getVideo();
    const player = getPlayer();
    if (!video || !ui) return;
    const pct = Math.min(100, Math.max(0, Number(ui.slider.value)));
    if (video.muted && pct > 0) {
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    // setVolume сохраняет громкость в настройках YouTube, но округляет до
    // целых — поэтому после него выставляем точное значение напрямую.
    if (player && typeof player.setVolume === 'function') player.setVolume(pct);
    video.volume = pct / 100;
  }

  // YouTube — SPA: плеер может появляться/пересоздаваться при навигации
  setInterval(ensureUI, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(ensureUI, 0));
  document.addEventListener('DOMContentLoaded', ensureUI);
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 0));
  window.addEventListener('resize', layout);
})();
