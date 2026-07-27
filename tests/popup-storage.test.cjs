'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    checked: false,
    value: '',
    min: '1',
    max: '100',
    textContent: '',
    listeners,
    style: {
      setProperty() {},
    },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
}

const ids = [
  'enabled',
  'gamma',
  'gammaValue',
  'curveExample',
  'sliderScale',
  'scaleValue',
  'shortsScale',
  'shortsValue',
  'useNativeSlider',
  'showPercent',
  'autoCollapse',
  'normalizeLoudness',
  'saveStatus',
  'saveStatusText',
  'resetSettings',
];
const elements = new Map(ids.map((id) => [id, element()]));
elements.get('gamma').min = '1';
elements.get('gamma').max = '6';
elements.get('sliderScale').min = '2';
elements.get('sliderScale').max = '70';
elements.get('shortsScale').min = '2';
elements.get('shortsScale').max = '70';
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

assert.equal(elements.get('gamma').value, 3);
assert.equal(
  elements.get('curveExample').textContent,
  'При положении 50% звук будет ≈ 13% от максимума.',
);
assert.equal(elements.get('sliderScale').value, 7);
assert.equal(elements.get('shortsScale').value, 11);
assert.equal(elements.get('autoCollapse').checked, true);

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

elements.get('resetSettings').listeners.get('click')();
assert.equal(writes.length, 3, 'reset should persist immediately');
assert.equal(writes[2].gamma, 3);
assert.equal(writes[2].sliderScale, 7);
assert.equal(writes[2].shortsScale, 11);
assert.equal(writes[2].autoCollapse, true);

console.log('popup storage flush test passed');
