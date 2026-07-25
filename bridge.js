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

  function grantVolumeIntent(duration = INTENT_WINDOW_MS) {
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
  }

  function grantMutedIntent(duration = INTENT_WINDOW_MS) {
    mutedIntentUntil = Date.now() + duration;
    mutedIntentBudget = 1;
  }

  // Кастомный ползунок меняет сразу два независимых состояния:
  // громкость и, при значении выше нуля, mute. Оба последующих сообщения
  // main.js должны быть авторизованы одним и тем же жестом пользователя.
  function grantSliderIntent(duration = INTENT_WINDOW_MS) {
    grantVolumeIntent(duration);
    grantMutedIntent(duration);
  }

  function consumeVolumeIntent() {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return false;
    volumeIntentBudget -= 1;
    return true;
  }

  function consumeMutedIntent() {
    if (Date.now() > mutedIntentUntil || mutedIntentBudget < 1) return false;
    mutedIntentBudget -= 1;
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

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const ownSlider = matches(e.target, '.ytev-slider');
      const muteControl = closest(e.target, '.ytp-mute-button, .ytev-mute');
      if (
        !e.repeat &&
        muteControl &&
        (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')
      ) {
        grantMutedIntent(5000);
      }
      if (isEditable(e.target)) {
        if (ownSlider && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          grantSliderIntent();
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (closest(e.target, '#movie_player, .html5-video-player')) {
          grantVolumeIntent();
        }
      } else if (!e.repeat && String(e.key).toLowerCase() === 'm') {
        grantMutedIntent();
      }
    },
    true
  );

  window.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && matches(e.target, '.ytev-slider')) grantSliderIntent();
    },
    true
  );

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.isTrusted) return;
      if (closest(e.target, '.ytev-box')) grantSliderIntent();
      else if (closest(e.target, '#movie_player, .html5-video-player')) grantVolumeIntent();
    },
    true
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      if (closest(e.target, '.ytp-mute-button, .ytev-mute')) grantMutedIntent(5000);
      if (closest(e.target, '.ytev-slider')) {
        // Само trusted input ниже выдаст оба разрешения. До фактического
        // изменения не открываем лишнее окно для записи mute.
        grantVolumeIntent(5000);
      } else if (closest(e.target, '.ytp-volume-area, .ytp-volume-panel')) {
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
        grantMutedIntent(5000);
      }
    },
    true
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!e.isTrusted || !(e.buttons & 1)) return;
      if (closest(e.target, '.ytev-slider')) grantVolumeIntent();
      else if (closest(e.target, '.ytp-volume-area, .ytp-volume-panel')) {
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
        !consumeVolumeIntent()
      ) {
        return;
      }
      queueWrite({ savedVolume: volume });
      return;
    }
    if (e.data.type === 'YTEV_SAVE_MUTED') {
      if (typeof e.data.muted !== 'boolean' || !consumeMutedIntent()) return;
      queueWrite({ savedMuted: e.data.muted });
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') load();
    });
  } catch {}
})();
