// Работает в MAIN-мире страницы: перехватывает установку громкости у
// HTMLMediaElement и применяет экспоненциальную кривую, а также добавляет
// в панель плеера длинный точный ползунок вместо стандартного.
(() => {
  'use strict';

  const SETTINGS = {
    enabled: true,     // применять экспоненциальную кривую
    gamma: 3,          // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderWidth: 220,  // длина ползунка в px
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
    applySliderSettings();
    updateUI();
  });
  window.postMessage({ type: 'YTEV_GET_SETTINGS' }, '*');

  /* ------------------------------------------------------------------ *
   * 3. Длинный точный ползунок в панели плеера
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    #movie_player .ytp-volume-panel { display: none !important; }
    .ytev-box {
      display: flex;
      align-items: center;
      margin-left: 6px;
      max-width: 45%;
    }
    .ytev-slider {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, .3);
      outline: none;
      cursor: pointer;
      margin: 0;
    }
    .ytev-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      border: none;
    }
    .ytev-label {
      color: #eee;
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      line-height: 1;
      margin-left: 8px;
      min-width: 42px;
      text-align: left;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  let ui = null; // { box, slider, label }
  let boundVideo = null;

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

  function applySliderSettings() {
    if (ui) ui.slider.style.width = SETTINGS.sliderWidth + 'px';
  }

  function bindVideo() {
    const video = getVideo();
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('volumechange', updateUI);
    updateUI();
  }

  function ensureUI() {
    const controls = document.querySelector('#movie_player .ytp-left-controls');
    if (!controls) return;
    if (ui && controls.contains(ui.box)) {
      bindVideo();
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

    const anchor =
      controls.querySelector('.ytp-volume-panel') ||
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
    applySliderSettings();
    bindVideo();
    updateUI();
  }

  // YouTube — SPA: плеер может появляться/пересоздаваться при навигации
  setInterval(ensureUI, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(ensureUI, 0));
  document.addEventListener('DOMContentLoaded', ensureUI);
})();
