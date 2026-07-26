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
  const output = enabled ? Math.pow(volume, gamma) : volume;
  const shouldMute = cached && cached.muted === true;
  const logicalVolume = new WeakMap();
  let active = true;

  const applyCachedOutput = (media) => {
    if (!active || !(media instanceof HTMLMediaElement)) return;
    try {
      nativeVolume.set.call(media, output);
      // Включать mute заранее безопасно. Снимать его до основного кода
      // нельзя: на новой вкладке это может нарушить политику autoplay.
      if (shouldMute) nativeMuted.set.call(media, true);
    } catch {}
  };

  const earlyVolumeGet = function () {
    return logicalVolume.has(this) ? logicalVolume.get(this) : volume;
  };
  const earlyVolumeSet = function (value) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested < 0 || requested > 1) {
      nativeVolume.set.call(this, value);
      return;
    }
    // YouTube может успеть выставить 100% до запуска main.js. Возвращаем
    // странице её логическое значение, но физический выход пока удерживаем
    // на сохранённом уровне, чтобы ни один первый кадр не прозвучал громче.
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
      const currentVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
      if (
        currentVolume &&
        currentVolume.get === earlyVolumeGet &&
        currentVolume.set === earlyVolumeSet
      ) {
        Object.defineProperty(mediaProto, 'volume', nativeVolume);
      }
      if (mediaProto.play === earlyPlay) mediaProto.play = nativePlay;
      return true;
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
