// Isolated world: мост между chrome.storage и main.js (MAIN world).
// main.js не имеет доступа к chrome.*, поэтому настройки пересылаются
// через window.postMessage.
(() => {
  'use strict';

  const PAGE_ORIGIN = location.origin;
  const CHANNEL_PATTERN = /^[a-f0-9]{32}$/;
  const WRITE_INTERVAL_MS = 250;
  const INTENT_WINDOW_MS = 2000;
  const DEFAULTS = {
    enabled: true,
    gamma: 3,
    sliderScale: 20,
    shortsScale: 50,
    showPercent: true,
    autoCollapse: false,
    useNativeSlider: false,
  };

  function normalizeSettings(value) {
    const result = { ...DEFAULTS };
    if (!value || typeof value !== 'object') return result;
    for (const key of ['enabled', 'showPercent', 'autoCollapse', 'useNativeSlider']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    const gamma = Number(value.gamma);
    const sliderScale = Number(value.sliderScale);
    const shortsScale = Number(value.shortsScale);
    if (Number.isFinite(gamma)) result.gamma = Math.min(6, Math.max(1, gamma));
    if (Number.isFinite(sliderScale)) {
      result.sliderScale = Math.min(70, Math.max(2, sliderScale));
    }
    if (Number.isFinite(shortsScale)) {
      result.shortsScale = Math.min(70, Math.max(2, shortsScale));
    }
    return result;
  }

  let activeChannel = null;
  let volumeIntentUntil = 0;
  let mutedIntentUntil = 0;
  let volumeIntentBudget = 0;
  let mutedIntentBudget = 0;
  let expectedVolume;
  let expectedMuted;
  let pendingWrite = {};
  let writeTimer = 0;
  let lastWriteAt = 0;

  function validChannel(value) {
    return typeof value === 'string' && CHANNEL_PATTERN.test(value);
  }

  function send(settings, state) {
    if (!activeChannel) return;
    window.postMessage(
      {
        type: 'YTEV_SETTINGS',
        channel: activeChannel,
        settings: normalizeSettings(settings),
        state,
      },
      PAGE_ORIGIN
    );
  }

  function grantVolumeIntent(duration = INTENT_WINDOW_MS, expected) {
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
    expectedVolume = expected;
  }

  function grantMutedIntent(duration = INTENT_WINDOW_MS, expected) {
    mutedIntentUntil = Date.now() + duration;
    mutedIntentBudget = 1;
    expectedMuted = expected;
  }

  // Кастомный ползунок меняет сразу два независимых состояния:
  // громкость и, при значении выше нуля, mute. Оба последующих сообщения
  // main.js должны быть авторизованы одним и тем же жестом пользователя.
  function grantSliderIntent(
    duration = INTENT_WINDOW_MS,
    expectedVolumeValue,
    expectedMutedValue
  ) {
    grantVolumeIntent(duration, expectedVolumeValue);
    grantMutedIntent(duration, expectedMutedValue);
  }

  function consumeVolumeIntent(value) {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return false;
    if (
      expectedVolume !== undefined &&
      Math.abs(value - expectedVolume) > 1e-6
    ) {
      return false;
    }
    volumeIntentBudget -= 1;
    expectedVolume = undefined;
    return true;
  }

  function consumeMutedIntent(value) {
    if (Date.now() > mutedIntentUntil || mutedIntentBudget < 1) return false;
    if (expectedMuted !== undefined && value !== expectedMuted) return false;
    mutedIntentBudget -= 1;
    expectedMuted = undefined;
    return true;
  }

  function isEditable(target) {
    const tag = String(target && target.tagName).toUpperCase();
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      !!(target && target.isContentEditable)
    );
  }

  function matches(target, selector) {
    return !!(target && typeof target.matches === 'function' && target.matches(selector));
  }

  function closest(target, selector) {
    return target && typeof target.closest === 'function'
      ? target.closest(selector)
      : null;
  }

  function activeVideo() {
    if (typeof document === 'undefined') return null;
    const selectors = [
      'ytd-reel-video-renderer[is-active] video',
      '#shorts-player video',
      '#movie_player video',
    ];
    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video) return video;
    }
    return document.querySelector('video');
  }

  function expectedMuteAfterToggle(target) {
    const video = activeVideo();
    if (!video) return undefined;
    const box = closest(target, '.ytev-box');
    const slider =
      box && typeof box.querySelector === 'function'
        ? box.querySelector('.ytev-slider')
        : null;
    const sliderValue = Number(slider && slider.value);
    const zeroVolume =
      slider && Number.isFinite(sliderValue)
        ? sliderValue === 0
        : Number(video.volume) === 0;
    return video.muted || zeroVolume ? false : true;
  }

  function grantSliderValue(slider, duration = INTENT_WINDOW_MS) {
    const pct = Number(slider && slider.value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    const video = activeVideo();
    const muted = pct > 0 ? false : video ? !!video.muted : undefined;
    grantSliderIntent(duration, pct / 100, muted);
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const muteControl = closest(e.target, '.ytp-mute-button, .ytev-mute');
      if (
        !e.repeat &&
        muteControl &&
        (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')
      ) {
        grantMutedIntent(5000, expectedMuteAfterToggle(e.target));
      }
      if (isEditable(e.target)) {
        // Для range браузер сам отправит trusted input уже с новым значением.
        // До него не открываем окно записи с неизвестным результатом.
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (closest(e.target, '#movie_player, .html5-video-player')) {
          grantVolumeIntent();
        }
      } else if (!e.repeat && String(e.key).toLowerCase() === 'm') {
        const video = activeVideo();
        grantMutedIntent(INTENT_WINDOW_MS, video ? !video.muted : undefined);
      }
    },
    true
  );

  window.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && matches(e.target, '.ytev-slider')) {
        grantSliderValue(e.target);
      }
    },
    true
  );

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.isTrusted) return;
      const box = closest(e.target, '.ytev-box');
      if (box && typeof box.querySelector === 'function') {
        const slider = box.querySelector('.ytev-slider');
        const current = Number(slider && slider.value);
        if (slider && Number.isFinite(current)) {
          const step = e.shiftKey ? 0.1 : 1;
          const next = Math.min(
            100,
            Math.max(0, current + (e.deltaY < 0 ? step : -step))
          );
          const video = activeVideo();
          grantSliderIntent(
            INTENT_WINDOW_MS,
            next / 100,
            next > 0 ? false : video ? !!video.muted : undefined
          );
        }
      } else if (closest(e.target, '#movie_player, .html5-video-player')) {
        grantVolumeIntent();
      }
    },
    true
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      if (closest(e.target, '.ytp-mute-button, .ytev-mute')) {
        grantMutedIntent(5000, expectedMuteAfterToggle(e.target));
      }
      if (
        !closest(e.target, '.ytev-slider') &&
        closest(e.target, '.ytp-volume-area, .ytp-volume-panel')
      ) {
        grantVolumeIntent(5000);
      }
    },
    true
  );

  // Click покрывает мышь и вспомогательные технологии; Enter/Space
  // дополнительно авторизуются выше по trusted keydown, не полагаясь на
  // то, как конкретный браузер пометит порождённый клавиатурой click.
  window.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && closest(e.target, '.ytp-mute-button, .ytev-mute')) {
        grantMutedIntent(5000, expectedMuteAfterToggle(e.target));
      }
    },
    true
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!e.isTrusted || !(e.buttons & 1)) return;
      if (
        !closest(e.target, '.ytev-slider') &&
        closest(e.target, '.ytp-volume-area, .ytp-volume-panel')
      ) {
        grantVolumeIntent();
      }
    },
    true
  );

  // После обновления/перезагрузки расширения старый мост на уже открытой
  // странице остаётся жить, но его chrome.* уже недействительны — любой
  // вызов бросает «Extension context invalidated». Проверяем перед
  // обращением, иначе ошибка сыпалась бы на каждый запрос настроек.
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  function load() {
    if (!activeChannel || !alive()) return;
    try {
      chrome.storage.sync.get(DEFAULTS, (settings) => {
        if (chrome.runtime.lastError) return;
        chrome.storage.local.get({ savedVolume: null, savedMuted: null }, (state) => {
          if (chrome.runtime.lastError) return;
          send(settings, state);
        });
      });
    } catch {}
  }

  function flushWrite() {
    writeTimer = 0;
    if (!alive() || !Object.keys(pendingWrite).length) return;
    const value = pendingWrite;
    pendingWrite = {};
    lastWriteAt = Date.now();
    try {
      chrome.storage.local.set(value, () => void chrome.runtime.lastError);
    } catch {}
  }

  function queueWrite(value) {
    Object.assign(pendingWrite, value);
    clearTimeout(writeTimer);
    const delay = Math.max(0, WRITE_INTERVAL_MS - (Date.now() - lastWriteAt));
    writeTimer = setTimeout(flushWrite, delay);
  }

  // main.js запрашивает настройки при старте (порядок загрузки не гарантирован)
  let lastRequestLoad = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== PAGE_ORIGIN || !e.data) return;
    if (e.data.type === 'YTEV_GET_SETTINGS') {
      if (!validChannel(e.data.channel)) return;
      if (activeChannel && e.data.channel !== activeChannel) return;
      activeChannel = e.data.channel;
      const now = Date.now();
      if (now - lastRequestLoad < 500) return;
      lastRequestLoad = now;
      load();
      return;
    }
    if (!activeChannel || e.data.channel !== activeChannel) return;
    if (e.data.type === 'YTEV_SAVE_VOLUME') {
      const volume = Number(e.data.volume);
      if (
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 1 ||
        !consumeVolumeIntent(volume)
      ) {
        return;
      }
      queueWrite({ savedVolume: volume });
      return;
    }
    if (e.data.type === 'YTEV_SAVE_MUTED') {
      if (
        typeof e.data.muted !== 'boolean' ||
        !consumeMutedIntent(e.data.muted)
      ) {
        return;
      }
      queueWrite({ savedMuted: e.data.muted });
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') load();
    });
  } catch {}
})();
