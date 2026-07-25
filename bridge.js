// Isolated world: мост между chrome.storage и main.js (MAIN world).
// main.js не имеет доступа к chrome.*, поэтому настройки пересылаются
// через window.postMessage.
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    gamma: 3,
    sliderScale: 20,
    showPercent: true,
    autoCollapse: false,
  };

  function send(settings) {
    window.postMessage({ type: 'YTEV_SETTINGS', settings }, '*');
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
        send(settings);
      });
    } catch {}
  }

  // main.js запрашивает настройки при старте (порядок загрузки не гарантирован)
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'YTEV_GET_SETTINGS') load();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') load();
    });
  } catch {}

  load();
})();
