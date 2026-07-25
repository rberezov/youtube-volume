'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  const listeners = new Map();
  return {
    checked: false,
    value: '',
    textContent: '',
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
}

const ids = [
  'enabled',
  'gamma',
  'gammaValue',
  'sliderScale',
  'scaleValue',
  'shortsScale',
  'shortsValue',
  'useNativeSlider',
  'showPercent',
  'autoCollapse',
];
const elements = new Map(ids.map((id) => [id, element()]));
const windowListeners = new Map();
const writes = [];

const documentMock = {
  getElementById(id) {
    return elements.get(id);
  },
  querySelectorAll() {
    return [];
  },
};

const windowMock = {
  addEventListener(type, listener) {
    windowListeners.set(type, listener);
  },
};

const chromeMock = {
  runtime: { lastError: null },
  storage: {
    sync: {
      get(defaults, callback) {
        callback(defaults);
      },
      set(value, callback) {
        writes.push(value);
        callback();
      },
    },
  },
};

const context = vm.createContext({
  chrome: chromeMock,
  clearTimeout,
  document: documentMock,
  Number,
  setTimeout,
  window: windowMock,
});
const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
vm.runInContext(source, context, { filename: 'popup.js' });

const gamma = elements.get('gamma');
gamma.value = '4.2';
gamma.listeners.get('input')();
assert.equal(writes.length, 0, 'input should remain debounced');
gamma.listeners.get('change')();
assert.equal(writes.length, 1, 'change should flush before popup can close');
assert.equal(writes[0].gamma, 4.2);

const scale = elements.get('sliderScale');
scale.value = '33';
scale.listeners.get('input')();
windowListeners.get('pagehide')();
assert.equal(writes.length, 2, 'pagehide should flush a pending write');
assert.equal(writes[1].sliderScale, 33);

console.log('popup storage flush test passed');
