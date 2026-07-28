'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class EventTargetMock {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener)
    );
  }
}

class ElementMock extends EventTargetMock {
  querySelectorAll() {
    return [];
  }
}

class HTMLMediaElementMock extends ElementMock {
  constructor() {
    super();
    this._volume = 1;
    this._muted = false;
    this.volumeAtPlay = null;
  }

  play() {
    this.volumeAtPlay = this._volume;
    return Promise.resolve();
  }
}

Object.defineProperty(HTMLMediaElementMock.prototype, 'volume', {
  configurable: true,
  enumerable: true,
  get() {
    return this._volume;
  },
  set(value) {
    this._volume = Number(value);
  },
});

Object.defineProperty(HTMLMediaElementMock.prototype, 'muted', {
  configurable: true,
  enumerable: true,
  get() {
    return this._muted;
  },
  set(value) {
    this._muted = !!value;
  },
});

let observer;
class MutationObserverMock {
  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    observer = this;
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }
}

const document = new EventTargetMock();
const rootClasses = new Set();
const earlyStyles = [];
document.documentElement = {
  classList: {
    add(value) {
      rootClasses.add(value);
    },
    remove(value) {
      rootClasses.delete(value);
    },
    contains(value) {
      return rootClasses.has(value);
    },
  },
  appendChild(node) {
    earlyStyles.push(node);
  },
};
document.createElement = () => ({ id: '', textContent: '' });
document.getElementById = (id) =>
  earlyStyles.find((style) => style.id === id) || null;
document.querySelector = () => null;
document.querySelectorAll = () => [];
const localStorage = {
  getItem(key) {
    assert.equal(key, 'ytev-volume-state-v1');
    return JSON.stringify({
      volume: 0.4,
      muted: false,
      enabled: true,
      gamma: 3,
      useNativeSlider: false,
    });
  },
};
const window = new EventTargetMock();
const nativeVolume = Object.getOwnPropertyDescriptor(
  HTMLMediaElementMock.prototype,
  'volume'
);
const nativePlay = HTMLMediaElementMock.prototype.play;
const timers = [];
const context = vm.createContext({
  console,
  document,
  Element: ElementMock,
  HTMLMediaElement: HTMLMediaElementMock,
  localStorage,
  MutationObserver: MutationObserverMock,
  Promise,
  clearTimeout() {},
  setTimeout(callback, delay) {
    timers.push({ callback, delay });
    return timers.length;
  },
  Symbol,
  window,
});
const source = fs.readFileSync(require.resolve('../preload.js'), 'utf8');
vm.runInContext(source, context, { filename: 'preload.js' });

assert.equal(
  rootClasses.has('ytev-native-volume-hidden'),
  false,
  'page-writable cache must not decide whether native controls are hidden'
);
assert.equal(earlyStyles.length, 0, 'trusted bridge code owns early control hiding');

const video = new HTMLMediaElementMock();
video.volume = 1;
assert.equal(video.volume, 1, 'YouTube must see the logical value it requested');
assert.ok(
  Math.abs(video._volume - Math.pow(0.4, 3)) < 1e-9,
  'physical output must stay at the cached exponential level'
);

video._volume = 1;
video.play();
assert.ok(
  Math.abs(video.volumeAtPlay - Math.pow(0.4, 3)) < 1e-9,
  'cached output must be applied synchronously before native play()'
);

const nativeShortsControl = {
  closest(selector) {
    if (selector === 'volume-controls, .ytdVolumeControlsHost') return this;
    if (selector === 'ytd-reel-video-renderer') return {};
    return null;
  },
};
window.listeners.get('pointerdown')[0]({
  isTrusted: true,
  target: nativeShortsControl,
});
video.volume = 0.7;
assert.ok(
  Math.abs(video._volume - Math.pow(0.7, 3)) < 1e-9,
  'trusted native control input must change output while preload is active'
);
const api = window[Symbol.for('ytev.preload.instance.v1')];
assert.equal(api.version, 1);
const takeoverState = api.takeover();
assert.equal(takeoverState.volume, 0.7);
// Жест открыл окно, но само значение им не подтверждено: штатный контрол
// показывает другое (в этих моках его вообще не видно). Уровень применяется
// к текущей сессии и НЕ уходит в сохранение — иначе скрипт страницы,
// попавший в чужой жест, диктовал бы сохранённый уровень. Ровно эту дыру
// до того закрыли в bridge.js, и preload не должен открывать её заново.
assert.equal(
  takeoverState.volumeDirty,
  false,
  'a value the native control does not corroborate must not reach storage'
);
assert.equal(observer.connected, false);
assert.equal(
  Object.getOwnPropertyDescriptor(HTMLMediaElementMock.prototype, 'volume').get,
  nativeVolume.get,
  'main takeover must restore the native volume descriptor'
);
assert.equal(
  HTMLMediaElementMock.prototype.play,
  nativePlay,
  'main takeover must restore native play()'
);
assert.equal(api.takeover(), false, 'takeover must be idempotent');

console.log('early preload volume test passed');
