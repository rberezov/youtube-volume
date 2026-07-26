// MAIN world, document_start: удерживает последний проверенный уровень до
// пробуждения service worker и запуска полного main.js.
(() => {
  'use strict';

  const INSTANCE_KEY = Symbol.for('ytev.preload.instance.v1');
  const STATE_CACHE_KEY = 'ytev-volume-state-v1';
  const existing = window[INSTANCE_KEY];
  if (existing && existing.version === 1) return;

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

  const volume = Number(cached && cached.volume);
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
    if (consumeVolumeIntent(this, requested)) {
      heldVolume = requested;
      volumeDirty = true;
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
  const activeVideo = () =>
    (activeReel() && activeReel().querySelector('video')) ||
    document.querySelector('#movie_player video') ||
    document.querySelector('video');
  const mediaSource = (media) =>
    media ? String(media.currentSrc || media.src || '') : '';
  const grantVolumeIntent = (duration = 5000, expected) => {
    volumeIntentVideo = activeVideo();
    volumeIntentSource = mediaSource(volumeIntentVideo);
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
    expectedVolume = expected;
  };
  const consumeVolumeIntent = (media, requested) => {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return false;
    if (volumeIntentVideo && media !== volumeIntentVideo) return false;
    const source = mediaSource(media);
    if (
      volumeIntentSource &&
      source &&
      volumeIntentSource !== source
    ) {
      return false;
    }
    if (
      expectedVolume !== undefined &&
      Math.abs(requested - expectedVolume) > 1e-6
    ) {
      return false;
    }
    volumeIntentBudget = 0;
    expectedVolume = undefined;
    return true;
  };
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
    grantVolumeIntent(5000, pct / 100);
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

  const api = Object.freeze({
    version: 1,
    takeover() {
      if (!active) return false;
      active = false;
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
    },
  });

  try {
    Object.defineProperty(window, INSTANCE_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
  } catch {
    api.takeover();
  }
})();
