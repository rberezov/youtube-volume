'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const listeners = new Map();
const posted = [];
const runtimeMessages = [];
const saved = [];
let now = 1000;
let onStorageChanged;
const activeVideo = {
  muted: false,
  volume: 0.55,
  addEventListener() {},
  removeEventListener() {},
};
const locationMock = {
  origin: 'https://www.youtube.com',
  pathname: '/watch',
};
const rootClasses = new Set();
const earlyStyles = [];
const rootClassList = {
  add(value) {
    rootClasses.add(value);
  },
  remove(value) {
    rootClasses.delete(value);
  },
  contains(value) {
    return rootClasses.has(value);
  },
};

// Что изолированный мир видит в DOM: собственный ползунок расширения и/или
// штатная панель YouTube с процентами. Именно отсюда bridge берёт значение,
// которым подтверждает запись после стрелок, колеса и штатных контролов.
const page = {
  sliders: [],
  shortsSlider: null,
  ariaVolume: 42,
  video: activeVideo,
};
const shortsReel = {
  hidden: false,
  querySelectorAll(selector) {
    return selector === 'volume-controls input#volume-input' &&
      page.shortsSlider
      ? [page.shortsSlider]
      : [];
  },
};
const volumePanel = {
  getAttribute(name) {
    return name === 'aria-valuenow' ? String(page.ariaVolume) : null;
  },
};

const documentMock = {
  documentElement: {
    classList: rootClassList,
    appendChild(node) {
      earlyStyles.push(node);
    },
  },
  createElement() {
    return { id: '', textContent: '' };
  },
  getElementById(id) {
    return earlyStyles.find((style) => style.id === id) || null;
  },
  querySelector(selector) {
    if (selector.includes('ytp-volume-panel')) {
      return page.ariaVolume == null ? null : volumePanel;
    }
    if (
      selector === 'ytd-reel-video-renderer[is-active]' ||
      selector === '#reel-overlay-container ytd-reel-video-renderer' ||
      selector === 'ytd-reel-video-renderer'
    ) {
      return page.shortsSlider ? shortsReel : null;
    }
    return selector.includes(' video') ||
      selector === '#movie_player video' ||
      selector === 'video'
      ? page.video
      : null;
  },
  querySelectorAll(selector) {
    if (selector === '.ytev-slider') return page.sliders;
    if (selector.includes('volume-controls input#volume-input')) {
      return page.shortsSlider ? [page.shortsSlider] : [];
    }
    return [];
  },
};

const windowMock = {
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  postMessage(message, targetOrigin) {
    posted.push({ ...message, targetOrigin });
  },
};

const chromeMock = {
  runtime: {
    id: 'test-extension',
    lastError: null,
    sendMessage(message, callback) {
      runtimeMessages.push(message);
      callback({ ok: true });
    },
  },
  storage: {
    sync: {
      get(defaults, callback) {
        callback({ ...defaults, useNativeSlider: false });
      },
    },
    local: {
      set(value, callback) {
        saved.push(value);
        callback();
      },
    },
    onChanged: {
      addListener(listener) {
        onStorageChanged = listener;
      },
    },
  },
};

const context = vm.createContext({
  chrome: chromeMock,
  clearTimeout() {},
  crypto: {
    getRandomValues(values) {
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index + 1;
      }
      return values;
    },
  },
  Date: { now: () => now },
  document: documentMock,
  location: locationMock,
  window: windowMock,
  setTimeout(callback, delay) {
    if (delay === 8000) return 1;
    callback();
    return 1;
  },
});
const source = fs.readFileSync(require.resolve('../bridge.js'), 'utf8');
vm.runInContext(source, context, { filename: 'bridge.js' });

const onMessage = listeners.get('message');
assert.equal(typeof onMessage, 'function');
assert.equal(runtimeMessages.length, 1);
assert.equal(runtimeMessages[0].type, 'YTEV_INIT');
assert.equal(
  rootClasses.has('ytev-native-volume-hidden'),
  true,
  'the isolated bridge must hide native controls before the service worker responds'
);
assert.equal(earlyStyles.length, 1, 'the early hide style must be injected only once');
assert.match(earlyStyles[0].textContent, /\.ytp-volume-area/);
const channel = runtimeMessages[0].channel;
assert.match(channel, /^[a-f0-9]{32}$/);
assert.match(runtimeMessages[0].secret, /^[a-f0-9]{64}$/);
assert.equal(posted.length, 0, 'bridge must never expose settings to the page');

onMessage({
  source: windowMock,
  origin: 'https://evil.example',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.42 },
});
assert.equal(saved.length, 0, 'messages from another origin must be ignored');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.42 },
});
assert.equal(saved.length, 0, 'a save without trusted user intent must be ignored');

// In Shorts a wheel over the video navigates the feed. It must not authorize
// the 100% value that YouTube applies while activating the next item.
locationMock.pathname = '/shorts/example';
page.ariaVolume = 100;
listeners.get('wheel')({
  isTrusted: true,
  deltaY: 100,
  shiftKey: false,
  target: {
    closest(selector) {
      return selector.includes('#movie_player') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 1 },
});
assert.equal(saved.length, 0, 'Shorts navigation wheel must not authorize a volume save');
locationMock.pathname = '/watch';
page.ariaVolume = 42;

const onKeyDown = listeners.get('keydown');
onKeyDown({
  isTrusted: false,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'ArrowUp',
  target: {
    tagName: 'DIV',
    closest(selector) {
      return selector.includes('#movie_player') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.42 },
});
assert.equal(saved.length, 0, 'a synthetic event must not authorize a save');

onKeyDown({
  isTrusted: true,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'ArrowUp',
  target: {
    tagName: 'DIV',
    closest(selector) {
      return selector.includes('#movie_player') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: {
    type: 'YTEV_SAVE_VOLUME',
    channel: 'ffffffffffffffffffffffffffffffff',
    volume: 0.99,
  },
});
assert.equal(saved.length, 0, 'another channel must not consume trusted intent');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.42 },
});
assert.equal(saved.length, 1);
assert.equal(saved[0].savedVolume, 0.42);

now += 300;
onKeyDown({
  isTrusted: true,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'm',
  target: { tagName: 'DIV' },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: true },
});
assert.equal(saved.length, 2);
assert.equal(saved[1].savedMuted, true);

now += 300;
const ownSlider = {
  tagName: 'INPUT',
  value: '55',
  matches(selector) {
    return selector === '.ytev-slider';
  },
  closest(selector) {
    return selector.includes('.ytev-slider') || selector === '.ytev-box' ? this : null;
  },
};
page.sliders = [ownSlider];
listeners.get('input')({
  isTrusted: true,
  target: ownSlider,
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: true },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.99 },
});
assert.equal(
  saved.length,
  2,
  'forged values must not consume or reuse a trusted slider intent'
);
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: false },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.55 },
});
assert.equal(saved.length, 4, 'one slider input must authorize mute and volume saves');
assert.equal(saved[2].savedMuted, false);
assert.equal(saved[3].savedVolume, 0.55);
page.sliders = [];

// Настоящий input недостаточен сам по себе: страница может подложить range
// с тем же классом. Bridge принимает событие только от единственного
// ползунка внутри блока расширения.
const decoySlider = {
  tagName: 'INPUT',
  value: '100',
  matches(selector) {
    return selector === '.ytev-slider';
  },
  closest() {
    return null;
  },
};
page.sliders = [ownSlider, decoySlider];
listeners.get('input')({
  isTrusted: true,
  target: decoySlider,
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 1 },
});
assert.equal(saved.length, 4, 'a trusted input from a decoy slider must be ignored');
page.sliders = [];

now += 300;
onKeyDown({
  isTrusted: true,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'Enter',
  target: {
    tagName: 'BUTTON',
    closest(selector) {
      return selector.includes('.ytev-mute') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: true },
});
assert.equal(saved.length, 5, 'Enter on the mute button must authorize mute');
assert.equal(saved[4].savedMuted, true);

now += 300;
activeVideo.muted = true;
listeners.get('click')({
  isTrusted: true,
  target: {
    closest(selector) {
      return selector.includes('.ytev-mute') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: false },
});
assert.equal(saved.length, 6, 'a trusted click must authorize mute');
assert.equal(saved[5].savedMuted, false);

listeners.get('click')({
  isTrusted: false,
  target: {
    closest(selector) {
      return selector.includes('.ytev-mute') ? this : null;
    },
  },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: true },
});
assert.equal(saved.length, 6, 'a synthetic click must not authorize mute');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 2 },
});
assert.equal(saved.length, 6);

// Если активного видео нет, результат mute-жеста нельзя предсказать.
// Такое окно не должно разрешать странице записать произвольный boolean.
now += 300;
page.video = null;
onKeyDown({
  isTrusted: true,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'm',
  target: { tagName: 'DIV' },
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: false },
});
assert.equal(saved.length, 6, 'mute without an expected boolean must not be written');
page.video = activeVideo;

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: 'yes' },
});
assert.equal(saved.length, 6);

// Окно доверия открыто настоящей стрелкой, но записать в него можно только
// то значение, которое подтверждает видимый пользователю контрол. Раньше
// стрелки открывали окно вообще без ожидаемого значения, и страница —
// канал ей виден — успевала записать произвольное, заодно съедая бюджет.
const arrowOverPlayer = {
  isTrusted: true,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  key: 'ArrowUp',
  target: {
    tagName: 'DIV',
    closest(selector) {
      return selector.includes('#movie_player') ? this : null;
    },
  },
};

now += 300;
page.ariaVolume = 60;
onKeyDown(arrowOverPlayer);
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.007 },
});
assert.equal(saved.length, 6, 'a value the page invented must not be written');
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.6 },
});
assert.equal(saved.length, 7, 'the value shown by the native panel must be written');
assert.equal(saved[6].savedVolume, 0.6);

// Нечего подтвердить — нечего и писать: уровень применится к сессии, но в
// хранилище не попадёт.
now += 300;
page.ariaVolume = null;
onKeyDown(arrowOverPlayer);
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.6 },
});
assert.equal(saved.length, 7, 'without a corroborating control nothing is written');

// Свой ползунок ровно один. Второй с тем же классом означает подделку на
// странице, и доверять положению «ползунка» больше нельзя.
now += 300;
page.ariaVolume = 60;
page.sliders = [ownSlider, decoySlider];
onKeyDown(arrowOverPlayer);
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 1 },
});
assert.equal(saved.length, 7, 'a decoy slider must disable DOM corroboration');

// Один настоящий ползунок — источник снова есть, и подтверждается ровно
// его положение.
now += 300;
page.sliders = [ownSlider];
onKeyDown(arrowOverPlayer);
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.55 },
});
assert.equal(saved.length, 8, 'the extension slider position must be written');
assert.equal(saved[7].savedVolume, 0.55);
page.sliders = [];

// Новый штатный контрол Shorts находится вне .ytp-volume-panel. Его
// доверенный input должен разрешать ровно показанное на нём значение.
now += 300;
locationMock.pathname = '/shorts/example';
const shortsNativeSlider = {
  tagName: 'INPUT',
  value: '73',
  matches() {
    return false;
  },
  closest(selector) {
    if (selector === 'volume-controls, .ytdVolumeControlsHost') return this;
    if (selector === 'ytd-reel-video-renderer') return shortsReel;
    return null;
  },
};
page.shortsSlider = shortsNativeSlider;
listeners.get('input')({
  isTrusted: true,
  target: shortsNativeSlider,
});
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.73 },
});
assert.equal(saved.length, 9, 'the native Shorts slider value must be written');
assert.equal(saved[8].savedVolume, 0.73);
page.shortsSlider = null;
locationMock.pathname = '/watch';

onStorageChanged({ gamma: { newValue: 2.5 } }, 'sync');
assert.equal(runtimeMessages.length, 2);
assert.equal(runtimeMessages[1].type, 'YTEV_UPDATE_SETTINGS');
assert.equal(runtimeMessages[1].channel, channel);
assert.equal(runtimeMessages[1].secret, runtimeMessages[0].secret);
assert.equal(posted.length, 0, 'settings updates must stay outside window messaging');

onStorageChanged(
  { useNativeSlider: { oldValue: false, newValue: true } },
  'sync'
);
assert.equal(
  rootClasses.has('ytev-native-volume-hidden'),
  false,
  'switching to the YouTube slider must reveal native controls immediately'
);
assert.equal(runtimeMessages.length, 3);

console.log('bridge storage smoke test passed');
