// MAIN world, document_start: удерживает последний проверенный уровень до
// пробуждения service worker и запуска полного main.js.
(() => {
  'use strict';

  const INSTANCE_KEY = Symbol.for('ytev.preload.instance.v1');
  const STATE_CACHE_KEY = 'ytev-volume-state-v1';
  const EARLY_HIDE_STYLE_ID = 'ytev-early-native-volume-style';
  const EARLY_HIDE_CLASS = 'ytev-native-volume-hidden';
  const EARLY_HIDE_MANAGED_CLASS = 'ytev-native-volume-managed';
  const EARLY_HIDE_CSS = `
    .${EARLY_HIDE_CLASS} .ytp-volume-area,
    .${EARLY_HIDE_CLASS} .ytp-volume-panel,
    .${EARLY_HIDE_CLASS} .ytp-mute-button,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer volume-controls,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer .ytdVolumeControlsHost,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls volume-controls,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls .ytdVolumeControlsHost {
      visibility: hidden !important;
    }
  `;
  // Окно доверия держим таким же коротким, как в bridge.js: за это время
  // YouTube успевает применить жест, а лишние секунды только расширяют
  // промежуток, в который может вклиниться скрипт страницы.
  const INTENT_WINDOW_MS = 2000;
  // Штатная панель YouTube показывает целые проценты, поэтому сверка с ней
  // огрублённая — как ARIA_TOLERANCE в bridge.js.
  const DOM_TOLERANCE = 0.015;

  const existing = window[INSTANCE_KEY];
  if (existing && existing.version === 1) return;

  // Слот реестра занимаем ПЕРВЫМ делом — до всех ранних выходов. Ключ
  // глобального реестра символов угадывается тривиально, а main.js забирает
  // отсюда удержанный уровень. Если preload выйдет, не заняв слот (кэша нет,
  // битый JSON, чужие дескрипторы), объект объявит скрипт страницы, и main.js
  // примет подставленное значение за выбор пользователя. Наружу отдаём
  // замороженный объект с делегирующим takeover: реализация подставляется
  // ниже и остаётся в замыкании, поэтому странице её не подменить.
  let takeoverImpl = () => false;
  const api = Object.freeze({
    version: 1,
    takeover: () => takeoverImpl(),
  });
  try {
    Object.defineProperty(window, INSTANCE_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
  } catch {
    return;
  }

  const mediaProto = HTMLMediaElement.prototype;
  const nativeVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const nativeMuted = Object.getOwnPropertyDescriptor(mediaProto, 'muted');
  const nativePlay = mediaProto.play;
  if (
    !nativeVolume ||
    typeof nativeVolume.get !== 'function' ||
    typeof nativeVolume.set !== 'function' ||
    !nativeMuted ||
    typeof nativeMuted.set !== 'function' ||
    typeof nativePlay !== 'function'
  ) {
    return;
  }

  let cached;
  try {
    cached = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || 'null');
  } catch {
    return;
  }

  // На повторных загрузках режим своей шкалы уже известен синхронно из кэша.
  // Прячем штатный контрол до построения YouTube: visibility сохраняет его
  // размеры, поэтому основной код всё ещё может снять рамку и точку монтажа.
  if (
    cached &&
    cached.useNativeSlider === false &&
    document.documentElement &&
    document.documentElement.classList
  ) {
    let earlyStyle =
      typeof document.getElementById === 'function'
        ? document.getElementById(EARLY_HIDE_STYLE_ID)
        : null;
    if (!earlyStyle && typeof document.createElement === 'function') {
      earlyStyle = document.createElement('style');
      earlyStyle.id = EARLY_HIDE_STYLE_ID;
      earlyStyle.textContent = EARLY_HIDE_CSS;
      document.documentElement.appendChild(earlyStyle);
    }
    document.documentElement.classList.add(EARLY_HIDE_CLASS);
    setTimeout(() => {
      if (
        !document.documentElement.classList.contains(
          EARLY_HIDE_MANAGED_CLASS
        )
      ) {
        document.documentElement.classList.remove(EARLY_HIDE_CLASS);
      }
    }, 8000);
  }

  // Отсутствие кэша — это именно «удерживать нечего», а не нулевая
  // громкость. Проверять `Number(cached && cached.volume)` нельзя:
  // при отсутствующем кэше выражение даёт Number(null) === 0, и на первой
  // же загрузке нового профиля preload удерживал бы полную тишину до
  // прихода main.js.
  const volume =
    cached && typeof cached === 'object' ? Number(cached.volume) : NaN;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
  const enabled = !cached || cached.enabled !== false;
  const cachedGamma = Number(cached && cached.gamma);
  const gamma = Number.isFinite(cachedGamma)
    ? Math.min(6, Math.max(1, cachedGamma))
    : 3;
  let heldVolume = volume;
  let volumeDirty = false;
  let volumeIntentUntil = 0;
  let volumeIntentBudget = 0;
  let volumeIntentVideo = null;
  let volumeIntentSource = '';
  let expectedVolume;
  const shouldMute = cached && cached.muted === true;
  const logicalVolume = new WeakMap();
  let active = true;

  const closest = (target, selector) =>
    target && typeof target.closest === 'function'
      ? target.closest(selector)
      : null;
  const activeReel = () =>
    document.querySelector('ytd-reel-video-renderer[is-active]') ||
    document.querySelector(
      '#reel-overlay-container ytd-reel-video-renderer'
    ) ||
    document.querySelector('ytd-reel-video-renderer');
  const nativeVolumeControl = (target) => {
    const classic = closest(target, '.ytp-volume-area, .ytp-volume-panel');
    if (classic) return classic;
    const shorts = closest(target, 'volume-controls, .ytdVolumeControlsHost');
    if (!shorts) return null;
    const reel = closest(shorts, 'ytd-reel-video-renderer');
    const active = activeReel();
    if (active) return reel === active ? shorts : null;
    return reel && !reel.hidden ? shorts : null;
  };
  const activeVideo = () => {
    const reel = activeReel();
    return (
      (reel && reel.querySelector('video')) ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  };
  const mediaSource = (media) =>
    media ? String(media.currentSrc || media.src || '') : '';

  // То же, что видит пользователь: положение штатного ползунка Shorts или
  // проценты на панели обычного плеера. Читать video.volume для сверки
  // бессмысленно — именно его и подменяют.
  const nativePercentFromDom = () => {
    const reel = activeReel();
    const sliders =
      reel && typeof reel.querySelectorAll === 'function'
        ? reel.querySelectorAll('volume-controls input#volume-input')
        : null;
    if (sliders && sliders.length === 1) {
      const pct = Number(sliders[0].value);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    const panel = document.querySelector('.ytp-volume-panel[aria-valuenow]');
    if (panel) {
      const pct = Number(panel.getAttribute('aria-valuenow'));
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    return null;
  };
  const corroborated = (requested) => {
    const pct = nativePercentFromDom();
    return pct != null && Math.abs(requested - pct / 100) <= DOM_TOLERANCE;
  };

  const grantVolumeIntent = (duration = INTENT_WINDOW_MS, expected) => {
    volumeIntentVideo = activeVideo();
    volumeIntentSource = mediaSource(volumeIntentVideo);
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
    expectedVolume = expected;
  };
  // Возвращает, насколько значению можно верить: '' — не верим вовсе,
  // 'hold' — применяем к сессии, но в сохранение не пускаем, 'trusted' —
  // подтверждено самим контролом и годится для записи.
  const consumeVolumeIntent = (media, requested) => {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return '';
    if (volumeIntentVideo && media !== volumeIntentVideo) return '';
    const source = mediaSource(media);
    if (
      volumeIntentSource &&
      source &&
      volumeIntentSource !== source
    ) {
      return '';
    }
    if (expectedVolume !== undefined) {
      if (Math.abs(requested - expectedVolume) > 1e-6) return '';
      volumeIntentBudget = 0;
      expectedVolume = undefined;
      return 'trusted';
    }
    // Для стрелок, колеса и протяжки штатной панели результат жеста заранее
    // неизвестен — шаг задаёт YouTube. Раньше окно в этом случае принимало
    // любое значение, и скрипт страницы, попавший в чужой жест, диктовал
    // сохранённый уровень. Теперь неподтверждённое значение живёт только в
    // текущей сессии и до записи в хранилище не доходит.
    volumeIntentBudget = 0;
    return corroborated(requested) ? 'trusted' : 'hold';
  };

  const outputVolume = () =>
    enabled ? Math.pow(heldVolume, gamma) : heldVolume;

  const applyCachedOutput = (media) => {
    if (!active || !(media instanceof HTMLMediaElement)) return;
    try {
      nativeVolume.set.call(media, outputVolume());
      // Включать mute заранее безопасно. Снимать его до основного кода
      // нельзя: на новой вкладке это может нарушить политику autoplay.
      if (shouldMute) nativeMuted.set.call(media, true);
    } catch {}
  };

  const earlyVolumeGet = function () {
    return logicalVolume.has(this) ? logicalVolume.get(this) : heldVolume;
  };
  const earlyVolumeSet = function (value) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested < 0 || requested > 1) {
      nativeVolume.set.call(this, value);
      return;
    }
    // Автоматические записи YouTube пока удерживаем на сохранённом уровне.
    // Доверенный жест над штатным контролом заранее открывает короткое
    // окно, чтобы он работал даже во время холодного запуска service worker.
    const verdict = consumeVolumeIntent(this, requested);
    if (verdict) {
      heldVolume = requested;
      if (verdict === 'trusted') volumeDirty = true;
    }
    logicalVolume.set(this, requested);
    applyCachedOutput(this);
  };

  try {
    Object.defineProperty(mediaProto, 'volume', {
      configurable: true,
      enumerable: nativeVolume.enumerable,
      get: earlyVolumeGet,
      set: earlyVolumeSet,
    });
  } catch {
    return;
  }

  const earlyPlay = function (...args) {
    applyCachedOutput(this);
    return nativePlay.apply(this, args);
  };
  mediaProto.play = earlyPlay;

  const onPointerDown = (event) => {
    if (event.isTrusted && nativeVolumeControl(event.target)) {
      grantVolumeIntent();
    }
  };
  const onPointerMove = (event) => {
    if (
      event.isTrusted &&
      event.buttons & 1 &&
      nativeVolumeControl(event.target)
    ) {
      grantVolumeIntent();
    }
  };
  const onWheel = (event) => {
    if (event.isTrusted && nativeVolumeControl(event.target)) {
      grantVolumeIntent();
    }
  };
  const onKeyDown = (event) => {
    if (
      event.isTrusted &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      nativeVolumeControl(event.target)
    ) {
      grantVolumeIntent();
    }
  };
  const onNativeInput = (event) => {
    if (!event.isTrusted || !nativeVolumeControl(event.target)) return;
    const pct = Number(event.target && event.target.value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    grantVolumeIntent(INTENT_WINDOW_MS, pct / 100);
    heldVolume = pct / 100;
    volumeDirty = true;
    document.querySelectorAll('video, audio').forEach(applyCachedOutput);
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('wheel', onWheel, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('input', onNativeInput, true);

  const onMediaReady = (event) => applyCachedOutput(event.target);
  for (const type of ['loadstart', 'loadedmetadata', 'play']) {
    document.addEventListener(type, onMediaReady, true);
  }

  const applyTree = (node) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLMediaElement) applyCachedOutput(node);
    node.querySelectorAll('video, audio').forEach(applyCachedOutput);
  };
  document.querySelectorAll('video, audio').forEach(applyCachedOutput);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) applyTree(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // Если service worker не проснулся, main.js не придёт вовсе, а наблюдатель
  // за всем деревом и подменённый play() остались бы до конца вкладки. На
  // обороте DOM у YouTube это заметная постоянная нагрузка, поэтому тяжёлую
  // часть снимаем сами; удержание уровня остаётся на дешёвых слушателях.
  let releaseTimer = setTimeout(() => {
    releaseTimer = 0;
    if (!active) return;
    observer.disconnect();
    if (mediaProto.play === earlyPlay) mediaProto.play = nativePlay;
  }, 15000);

  takeoverImpl = () => {
    if (!active) return false;
    active = false;
    clearTimeout(releaseTimer);
    observer.disconnect();
    for (const type of ['loadstart', 'loadedmetadata', 'play']) {
      document.removeEventListener(type, onMediaReady, true);
    }
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('input', onNativeInput, true);
    const currentVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
    if (
      currentVolume &&
      currentVolume.get === earlyVolumeGet &&
      currentVolume.set === earlyVolumeSet
    ) {
      Object.defineProperty(mediaProto, 'volume', nativeVolume);
    }
    if (mediaProto.play === earlyPlay) mediaProto.play = nativePlay;
    return { volume: heldVolume, volumeDirty };
  };
})();
