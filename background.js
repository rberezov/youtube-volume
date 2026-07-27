'use strict';

importScripts('main.js');

const CHANNEL_PATTERN = /^[a-f0-9]{32}$/;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULTS = {
  enabled: true,
  gamma: 3,
  sliderScale: 7,
  shortsScale: 11,
  showPercent: true,
  autoCollapse: true,
  useNativeSlider: false,
  normalizeLoudness: false,
};

function allowedSender(sender) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  try {
    const url = new URL(sender.url || '');
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com';
  } catch {
    return false;
  }
}

function storageGet(area, defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].get(defaults, (value) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(value);
    });
  });
}

function targetFrom(sender) {
  return {
    tabId: sender.tab.id,
    frameIds: [Number.isInteger(sender.frameId) ? sender.frameId : 0],
  };
}

function updateYouTubeVolumeMain(secret, payload) {
  const instance = window[Symbol.for('ytev.main.instance.v2')];
  if (!instance || instance.version !== 2 || typeof instance.update !== 'function') {
    return false;
  }
  return instance.update(secret, payload);
}

// main.js работает в MAIN-мире страницы, где chrome.i18n недоступен, поэтому
// подписи собираются здесь и уезжают готовыми в том же payload, что настройки.
const STRING_KEYS = [
  'playerSliderLabel',
  'playerUnmute',
  'playerMute',
];

function uiStrings() {
  const strings = {};
  for (const key of STRING_KEYS) {
    try {
      const value = chrome.i18n.getMessage(key);
      if (value) strings[key] = value;
    } catch {}
  }
  return strings;
}

async function initialize(sender, channel, secret) {
  const [settings, state] = await Promise.all([
    storageGet('sync', DEFAULTS),
    storageGet('local', { savedVolume: null, savedMuted: null }),
  ]);
  const results = await chrome.scripting.executeScript({
    target: targetFrom(sender),
    world: 'MAIN',
    func: youtubeVolumeMain,
    args: [{ channel, settings, state, strings: uiStrings() }, secret],
  });
  return results.some((result) => result && result.result === true);
}

async function updateSettings(sender, secret) {
  const settings = await storageGet('sync', DEFAULTS);
  const results = await chrome.scripting.executeScript({
    target: targetFrom(sender),
    world: 'MAIN',
    func: updateYouTubeVolumeMain,
    args: [secret, { settings, strings: uiStrings() }],
  });
  return results.some((result) => result && result.result === true);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !allowedSender(sender) ||
    !message ||
    !CHANNEL_PATTERN.test(message.channel) ||
    !SECRET_PATTERN.test(message.secret)
  ) {
    return false;
  }

  let operation;
  if (message.type === 'YTEV_INIT') {
    operation = initialize(sender, message.channel, message.secret);
  } else if (message.type === 'YTEV_UPDATE_SETTINGS') {
    operation = updateSettings(sender, message.secret);
  } else {
    return false;
  }

  operation
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
