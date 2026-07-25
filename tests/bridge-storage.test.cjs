'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const listeners = new Map();
const posted = [];
const saved = [];
let localVolume = 0.37;
let localMuted = false;

const windowMock = {
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  postMessage(message) {
    posted.push(message);
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
  Number,
  window: windowMock,
});
const source = fs.readFileSync(require.resolve('../bridge.js'), 'utf8');
vm.runInContext(source, context, { filename: 'bridge.js' });

assert.equal(posted.length, 1);
assert.equal(posted[0].type, 'YTEV_SETTINGS');
assert.equal(posted[0].settings.gamma, 2.5);
assert.equal(posted[0].settings.enabled, true);
assert.equal(posted[0].settings.shortsScale, 70);
assert.equal(posted[0].state.savedVolume, 0.37);
assert.equal(posted[0].state.savedMuted, false);

const onMessage = listeners.get('message');
assert.equal(typeof onMessage, 'function');

onMessage({
  source: windowMock,
  data: { type: 'YTEV_SAVE_VOLUME', volume: 0.42 },
});
assert.equal(saved.length, 1);
assert.equal(saved[0].savedVolume, 0.42);

onMessage({
  source: windowMock,
  data: { type: 'YTEV_SAVE_MUTED', muted: true },
});
assert.equal(saved.length, 2);
assert.equal(saved[1].savedMuted, true);

onMessage({
  source: windowMock,
  data: { type: 'YTEV_SAVE_VOLUME', volume: 2 },
});
assert.equal(saved.length, 2);

onMessage({
  source: windowMock,
  data: { type: 'YTEV_SAVE_MUTED', muted: 'yes' },
});
assert.equal(saved.length, 2);

onMessage({
  source: windowMock,
  data: { type: 'YTEV_GET_SETTINGS' },
});
assert.equal(posted.length, 2);
assert.equal(posted[1].state.savedVolume, 0.42);
assert.equal(posted[1].state.savedMuted, true);

console.log('bridge storage smoke test passed');
