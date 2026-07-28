'use strict';

// Слот реестра и подтверждение значения — две границы preload.js, которые
// проверяются только на свежем контексте: ключ регистрируется
// неперезаписываемым, поэтому в одном окне preload поднимается ровно раз.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(require.resolve('../preload.js'), 'utf8');
const INSTANCE_KEY = Symbol.for('ytev.preload.instance.v1');

class EventTargetMock {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) || [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    const values = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      values.filter((value) => value !== listener)
    );
  }
  emit(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

class ElementMock extends EventTargetMock {
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}

// Каждый сценарий получает собственный HTMLMediaElement: preload подменяет
// дескриптор на прототипе, и общий класс тянул бы состояние между прогонами.
function scenario({ cache, shortsSliderValue = null }) {
  class MediaMock extends ElementMock {
    constructor() {
      super();
      this._volume = 1;
      this._muted = false;
    }
    play() {
      return Promise.resolve();
    }
  }
  Object.defineProperty(MediaMock.prototype, 'volume', {
    configurable: true,
    enumerable: true,
    get() {
      return this._volume;
    },
    set(value) {
      this._volume = Number(value);
    },
  });
  Object.defineProperty(MediaMock.prototype, 'muted', {
    configurable: true,
    enumerable: true,
    get() {
      return this._muted;
    },
    set(value) {
      this._muted = !!value;
    },
  });
  const nativeVolume = Object.getOwnPropertyDescriptor(
    MediaMock.prototype,
    'volume'
  );

  const shortsSlider =
    shortsSliderValue == null ? null : { value: String(shortsSliderValue) };
  const reel = {
    querySelectorAll(selector) {
      return selector === 'volume-controls input#volume-input' && shortsSlider
        ? [shortsSlider]
        : [];
    },
    querySelector() {
      return null;
    },
  };

  const document = new EventTargetMock();
  document.documentElement = {
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {},
  };
  document.createElement = () => ({ id: '', textContent: '' });
  document.getElementById = () => null;
  document.querySelector = (selector) =>
    selector === 'ytd-reel-video-renderer[is-active]' && shortsSlider
      ? reel
      : null;
  document.querySelectorAll = () => [];

  const window = new EventTargetMock();
  const context = vm.createContext({
    document,
    Element: ElementMock,
    HTMLMediaElement: MediaMock,
    localStorage: { getItem: () => cache },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Promise,
    clearTimeout() {},
    setTimeout() {
      return 1;
    },
    Symbol,
    window,
  });
  vm.runInContext(SOURCE, context, { filename: 'preload.js' });
  return { window, document, MediaMock, nativeVolume, reel };
}

// 1. Кэша нет вовсе — preload удерживать нечего, но слот обязан быть занят.
//    Иначе ключ объявит скрипт страницы, и main.js примет его объект за наш.
{
  const { window, MediaMock, nativeVolume } = scenario({ cache: null });
  const api = window[INSTANCE_KEY];
  assert.ok(api, 'the registry slot must be claimed even with no cached state');
  assert.equal(api.version, 1);
  assert.equal(api.takeover(), false, 'an idle preload must hand over nothing');
  assert.equal(
    Object.getOwnPropertyDescriptor(MediaMock.prototype, 'volume').set,
    nativeVolume.set,
    'an idle preload must leave the native volume descriptor alone'
  );
  assert.throws(
    () => {
      Object.defineProperty(window, INSTANCE_KEY, { value: { version: 1 } });
    },
    'the claimed slot must not be replaceable by the page'
  );

  const channel = 'a'.repeat(32);
  const secret = 'b'.repeat(64);
  let updates = 0;
  assert.equal(api.beginControl(channel, secret), true);
  assert.equal(
    api.commitControl(secret, {
      dispose() {},
      update(payload) {
        updates += payload.step;
        return true;
      },
      drcRestoreState() {
        return true;
      },
    }),
    true
  );
  assert.equal(api.invokeControl('c'.repeat(64), 'update', { step: 1 }), null);
  assert.equal(updates, 0, 'a caller without the isolated secret must do nothing');
  assert.equal(api.invokeControl(secret, 'update', { step: 2 }), true);
  assert.equal(updates, 2);
  assert.equal(api.invokeControl(secret, 'drcRestoreState'), true);
}

// 2. Битый кэш — страница может испортить ytev-volume-state-v1, это обычный
//    page-writable ключ. Ранний выход не должен освобождать слот.
{
  const { window, MediaMock, nativeVolume } = scenario({ cache: '{oops' });
  const api = window[INSTANCE_KEY];
  assert.ok(api, 'a malformed cache must not leave the registry slot free');
  assert.equal(api.takeover(), false);
  assert.equal(
    Object.getOwnPropertyDescriptor(MediaMock.prototype, 'volume').set,
    nativeVolume.set
  );
}

// 3. Значение вне допустимого диапазона — тот же ранний выход.
{
  const { window } = scenario({ cache: JSON.stringify({ volume: 'x' }) });
  assert.ok(window[INSTANCE_KEY], 'an out-of-range cache must still claim the slot');
  assert.equal(window[INSTANCE_KEY].takeover(), false);
}

// 4. Значение, подтверждённое положением штатного ползунка Shorts, доверенное
//    и уходит в сохранение — в отличие от неподтверждённого (см.
//    preload-volume.test.cjs).
{
  const { window, MediaMock, reel } = scenario({
    cache: JSON.stringify({ volume: 0.4, muted: false, enabled: true, gamma: 3 }),
    shortsSliderValue: 55,
  });
  const control = {
    closest(selector) {
      if (selector === 'volume-controls, .ytdVolumeControlsHost') return this;
      if (selector === 'ytd-reel-video-renderer') return reel;
      return null;
    },
  };
  window.emit('pointerdown', { isTrusted: true, target: control });
  const media = new MediaMock();
  media.volume = 0.55;
  const state = window[INSTANCE_KEY].takeover();
  assert.equal(state.volume, 0.55);
  assert.equal(
    state.volumeDirty,
    true,
    'a value the native control shows must be trusted for storage'
  );
}

// 5. Значения из localStorage принадлежат странице. Даже корректно
//    сформированный поддельный кэш не должен дать раннему коду полный уровень.
{
  const { window, MediaMock, nativeVolume } = scenario({
    cache: JSON.stringify({
      volume: 1,
      muted: false,
      enabled: false,
      gamma: 1,
      useNativeSlider: false,
    }),
  });
  const media = new MediaMock();
  media.volume = 1;
  assert.equal(
    nativeVolume.get.call(media),
    0.5,
    'untrusted early cache must be capped at the fail-safe output level'
  );
  assert.equal(
    window[INSTANCE_KEY].takeover().volume,
    0.5,
    'the page-provided full-volume value must not enter trusted takeover state'
  );
}

console.log('preload registry slot test passed');
