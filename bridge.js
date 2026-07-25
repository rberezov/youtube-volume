// Isolated world: мост между chrome.storage и main.js (MAIN world).
// main.js не имеет доступа к chrome.*, поэтому настройки пересылаются
// через window.postMessage.
(() => {
  'use strict';

  const DEFAULTS = { enabled: true, gamma: 3, showPercent: true, autoCollapse: false };

  function send(settings) {
    window.postMessage({ type: 'YTEV_SETTINGS', settings }, '*');
  }

  function load() {
    chrome.storage.sync.get(DEFAULTS, send);
  }

  // main.js запрашивает настройки при старте (порядок загрузки не гарантирован)
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'YTEV_GET_SETTINGS') load();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') load();
  });

  load();
})();
