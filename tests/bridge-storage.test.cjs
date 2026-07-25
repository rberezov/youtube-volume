'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const listeners = new Map();
const posted = [];
const saved = [];
let localVolume = 0.37;
let localMuted = false;
let now = 1000;
const activeVideo = { muted: false, volume: 0.55 };

const documentMock = {
  querySelector(selector) {
    return selector.includes('video') ? activeVideo : null;
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
  runtime: { id: 'test-extension', lastError: null },
  storage: {
    sync: {
      get(defaults, callback) {
        callback({
          ...defaults,
          enabled: 'invalid',
          gamma: 2.5,
          shortsScale: 999,
        });
      },
    },
    local: {
      get(defaults, callback) {
        callback({
          ...defaults,
          savedVolume: localVolume,
          savedMuted: localMuted,
        });
      },
      set(value, callback) {
        saved.push(value);
        if ('savedVolume' in value) localVolume = value.savedVolume;
        if ('savedMuted' in value) localMuted = value.savedMuted;
        callback();
      },
    },
    onChanged: {
      addListener() {},
    },
  },
};

const context = vm.createContext({
  chrome: chromeMock,
  clearTimeout() {},
  Date: { now: () => now },
  document: documentMock,
  location: { origin: 'https://www.youtube.com' },
  window: windowMock,
  setTimeout(callback) {
    callback();
    return 1;
  },
});
const source = fs.readFileSync(require.resolve('../bridge.js'), 'utf8');
vm.runInContext(source, context, { filename: 'bridge.js' });

assert.equal(posted.length, 0, 'bridge must not expose settings before a channel is bound');

const onMessage = listeners.get('message');
assert.equal(typeof onMessage, 'function');
const channel = '0123456789abcdef0123456789abcdef';

onMessage({
  source: windowMock,
  origin: 'https://evil.example',
  data: { type: 'YTEV_GET_SETTINGS', channel },
});
assert.equal(posted.length, 0, 'messages from another origin must be ignored');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_GET_SETTINGS', channel },
});
assert.equal(posted.length, 1);
assert.equal(posted[0].type, 'YTEV_SETTINGS');
assert.equal(posted[0].channel, channel);
assert.equal(posted[0].targetOrigin, 'https://www.youtube.com');
assert.equal(posted[0].settings.gamma, 2.5);
assert.equal(posted[0].settings.enabled, true);
assert.equal(posted[0].settings.shortsScale, 70);
assert.equal(posted[0].state.savedVolume, 0.37);
assert.equal(posted[0].state.savedMuted, false);

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_VOLUME', channel, volume: 0.42 },
});
assert.equal(saved.length, 0, 'a save without trusted user intent must be ignored');

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

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_SAVE_MUTED', channel, muted: 'yes' },
});
assert.equal(saved.length, 6);

now += 600;
onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: { type: 'YTEV_GET_SETTINGS', channel },
});
assert.equal(posted.length, 2);
assert.equal(posted[1].state.savedVolume, 0.55);
assert.equal(posted[1].state.savedMuted, false);

console.log('bridge storage smoke test passed');
