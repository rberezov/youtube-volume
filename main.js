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
      min-width: 0;
      margin-left: 6px;
    }
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
      margin-left: .7em;
      min-width: 3.4em;
      text-align: left;
      white-space: nowrap;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  const MIN_SLIDER = 48; // короче — бесполезно, лучше спрятать
  const SAFETY_GAP = 16; // запас, чтобы панель не «поехала»

  let ui = null; // { box, slider, label }
  let boundVideo = null;
  let observedPlayer = null;

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
    player.classList.remove('ytev-fallback');
    ui.box.style.display = '';
    ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
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
    const tooSmall = ui.slider.getBoundingClientRect().width < MIN_SLIDER - 1;
    ui.box.style.display = tooSmall ? 'none' : '';
    player.classList.toggle('ytev-fallback', tooSmall);
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
      bindVideo();
      layout();
      return;
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

    // встаём точно на место штатного ползунка — внутрь его контейнера.
    // В новом интерфейсе YouTube кнопки слева обёрнуты в скруглённую
    // «пилюлю»; если вставить блок снаружи, штатная рамка не охватит его
    const anchor =
      controls.querySelector('.ytp-volume-panel') ||
      controls.querySelector('.ytp-volume-area') ||
      controls.querySelector('.ytp-mute-button');
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
