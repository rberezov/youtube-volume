// Isolated world: мост между chrome.storage и main.js (MAIN world).
// main.js не имеет доступа к chrome.*, поэтому настройки пересылаются
// через window.postMessage.
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    gamma: 3,
    sliderScale: 20,
    shortsScale: 50,
    showPercent: true,
    autoCollapse: false,
    useNativeSlider: false,
  };

  function send(settings, state) {
    window.postMessage({ type: 'YTEV_SETTINGS', settings, state }, '*');
  }

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
    if (!alive()) return;
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

  // main.js запрашивает настройки при старте (порядок загрузки не гарантирован)
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'YTEV_GET_SETTINGS') {
      load();
      return;
    }
    if (e.data.type === 'YTEV_SAVE_VOLUME') {
      const volume = Number(e.data.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1 || !alive()) return;
      try {
        chrome.storage.local.set({ savedVolume: volume }, () => void chrome.runtime.lastError);
      } catch {}
      return;
    }
    if (e.data.type === 'YTEV_SAVE_MUTED') {
      if (typeof e.data.muted !== 'boolean' || !alive()) return;
      try {
        chrome.storage.local.set(
          { savedMuted: e.data.muted },
          () => void chrome.runtime.lastError
        );
      } catch {}
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') load();
    });
  } catch {}

  load();
})();
