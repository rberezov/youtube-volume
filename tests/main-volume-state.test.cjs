'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class NodeMock {}
class ElementMock extends NodeMock {
  contains(node) {
    return node === this;
  }
  closest() {
    return null;
  }
}
class HTMLElementMock extends ElementMock {
  constructor() {
    super();
    this.classList = {
      contains() {
        return false;
      },
    };
    this.isContentEditable = false;
  }
}
class HTMLInputElementMock extends HTMLElementMock {}
class HTMLTextAreaElementMock extends HTMLElementMock {}
class HTMLSelectElementMock extends HTMLElementMock {}
class EventMock {
  constructor(type) {
    this.type = type;
  }
}

class HTMLMediaElementMock extends HTMLElementMock {
  constructor(volume = 1, muted = false) {
    super();
    this._volume = volume;
    this._muted = muted;
    // Что реально дошло до нативного сеттера. Проверять итоговое значение
    // мало: сверка в onVolumeChange всё равно доводит состояние до
    // preferredMuted, и подавленная запись выглядела бы как пропущенная.
    this.mutedWrites = [];
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
    this.currentSrc = '';
    this.isConnected = true;
    this.mediaKeys = null;
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
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener.call(this, event);
    }
  }
  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
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
    this.dispatchEvent(new EventMock('volumechange'));
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
    this.mutedWrites.push(this._muted);
    this.dispatchEvent(new EventMock('volumechange'));
  },
});

const videoA = new HTMLMediaElementMock(0.2, false);
const videoB = new HTMLMediaElementMock(0.9, true);
const directVideo = new HTMLMediaElementMock(1, false);
directVideo.mediaKeys = {};
let currentVideo = videoA;
let clock = 1000;
const posted = [];
const windowListeners = new Map();
const documentListeners = new Map();
const intervals = [];
const storage = new Map();
const rootClasses = new Set();
let nativeShortsSlider = null;
const activeReel = {
  querySelectorAll(selector) {
    return selector === 'volume-controls input#volume-input' &&
      nativeShortsSlider
      ? [nativeShortsSlider]
      : [];
  },
};

const player = new HTMLElementMock();
player.querySelector = (selector) => (selector === 'video' ? currentVideo : null);
player.contains = () => true;
player.mute = () => {
  currentVideo.muted = true;
};
player.unMute = () => {
  currentVideo.muted = false;
};

function addListener(map, type, listener) {
  const values = map.get(type) || [];
  values.push(listener);
  map.set(type, values);
}

function removeListener(map, type, listener) {
  const values = map.get(type) || [];
  map.set(
    type,
    values.filter((value) => value !== listener)
  );
}

const windowMock = {
  crypto: {
    getRandomValues(values) {
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index + 1;
      }
      return values;
    },
  },
  addEventListener(type, listener) {
    addListener(windowListeners, type, listener);
  },
  removeEventListener(type, listener) {
    removeListener(windowListeners, type, listener);
  },
  postMessage(message, targetOrigin) {
    posted.push({ ...message, targetOrigin });
  },
};

const documentMock = {
  hidden: true,
  documentElement: {
    classList: {
      add(value) {
        rootClasses.add(value);
      },
      remove(...values) {
        for (const value of values) rootClasses.delete(value);
      },
      toggle(value, force) {
        if (force) rootClasses.add(value);
        else rootClasses.delete(value);
      },
    },
    appendChild() {},
  },
  addEventListener(type, listener) {
    addListener(documentListeners, type, listener);
  },
  removeEventListener(type, listener) {
    removeListener(documentListeners, type, listener);
  },
  createElement() {
    return { textContent: '' };
  },
  getElementById(id) {
    return id === 'movie_player' ? player : null;
  },
  querySelector(selector) {
    return selector === 'ytd-reel-video-renderer[is-active]' &&
      nativeShortsSlider
      ? activeReel
      : null;
  },
  querySelectorAll(selector) {
    return selector === 'video, audio' ? [currentVideo] : [];
  },
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mediaSources = new WeakMap();
class AudioNodeMock {
  constructor() {
    this.connections = new Set();
  }
  connect(target) {
    this.connections.add(target);
    return target;
  }
  disconnect(target) {
    if (target) this.connections.delete(target);
    else this.connections.clear();
  }
}

class GainNodeMock extends AudioNodeMock {
  constructor() {
    super();
    this.gain = {
      value: 1,
      setTargetAtTime: (value) => {
        this.gain.value = value;
      },
    };
  }
}

class AnalyserNodeMock extends AudioNodeMock {
  constructor() {
    super();
    this.fftSize = 256;
  }
  getByteTimeDomainData(values) {
    values.fill(129);
  }
}

class AudioContextMock {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = new AudioNodeMock();
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  createMediaElementSource(element) {
    if (mediaSources.has(element)) {
      throw new Error('HTMLMediaElement already has a MediaElementAudioSourceNode');
    }
    const source = new AudioNodeMock();
    mediaSources.set(element, source);
    return source;
  }
  createGain() {
    return new GainNodeMock();
  }
  createAnalyser() {
    return new AnalyserNodeMock();
  }
}
windowMock.AudioContext = AudioContextMock;

const context = vm.createContext({
  Date: { now: () => clock },
  Element: ElementMock,
  Event: EventMock,
  HTMLInputElement: HTMLInputElementMock,
  HTMLMediaElement: HTMLMediaElementMock,
  HTMLSelectElement: HTMLSelectElementMock,
  HTMLTextAreaElement: HTMLTextAreaElementMock,
  HTMLElement: HTMLElementMock,
  Node: NodeMock,
  ResizeObserver: ResizeObserverMock,
  clearInterval(id) {
    if (intervals[id - 1]) intervals[id - 1].active = false;
  },
  clearTimeout() {},
  document: documentMock,
  getComputedStyle() {
    return {};
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  },
  location: { origin: 'https://www.youtube.com', pathname: '/watch' },
  navigator: { userActivation: { hasBeenActive: false } },
  performance: { now: () => clock },
  requestAnimationFrame(callback) {
    callback();
  },
  setInterval(callback, delay) {
    intervals.push({ callback, delay, active: true });
    return intervals.length;
  },
  setTimeout(callback) {
    callback();
    return 1;
  },
  window: windowMock,
});
windowMock.window = windowMock;
let preloadTakeovers = 0;
windowMock[Symbol.for('ytev.preload.instance.v1')] = {
  version: 1,
  takeover() {
    preloadTakeovers += 1;
    return preloadTakeovers === 1
      ? { volume: 0.45, volumeDirty: true }
      : false;
  },
};

function runMainTick() {
  const timer = intervals.find((entry) => entry.active && entry.delay === 1000);
  assert.ok(timer, 'the active MAIN instance must own a maintenance tick');
  timer.callback();
}

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
vm.runInContext(source, context, { filename: 'main.js' });
const channel = '0123456789abcdef0123456789abcdef';
const secret = '0123456789abcdef'.repeat(4);
assert.equal(
  context.youtubeVolumeMain(
    {
      channel,
      settings: { useNativeSlider: true },
      state: { savedVolume: 0.4, savedMuted: false },
    },
    secret
  ),
  true
);
assert.equal(
  videoA.volume,
  0.45,
  'trusted native input during preload must win over stale stored state'
);
assert.equal(preloadTakeovers, 1, 'the full instance must take over preload once');
assert.equal(
  windowListeners.has('message'),
  false,
  'MAIN world must not accept settings through page-visible messages'
);

const nativeControl = new HTMLElementMock();
nativeControl.closest = (selector) =>
  selector === 'ytd-reel-video-renderer' ? activeReel : null;
nativeShortsSlider = new HTMLInputElementMock();
nativeShortsSlider.value = '73';
nativeShortsSlider.closest = (selector) =>
  selector === 'volume-controls, .ytdVolumeControlsHost'
    ? nativeControl
    : null;
windowListeners.get('input')[0]({
  isTrusted: true,
  target: nativeShortsSlider,
});
assert.equal(
  videoA.volume,
  0.73,
  'trusted input from the real native Shorts slider must set volume directly'
);
nativeShortsSlider = null;

const instance = windowMock[Symbol.for('ytev.main.instance.v2')];
assert.equal(instance.version, 2);
assert.equal(
  instance.update('f'.repeat(64), { settings: { enabled: false } }),
  false,
  'an update without the isolated-world secret must be rejected'
);

const onKeyDown = windowListeners.get('keydown')[0];
onKeyDown({
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  key: 'ArrowUp',
  metaKey: false,
  target: new HTMLElementMock(),
});
videoA.volume = 0.6;
assert.equal(videoA.volume, 0.6, 'keyboard volume should become the preferred value');

assert.equal(
  instance.update(secret, {
    settings: { useNativeSlider: true },
    state: { savedVolume: 0.4, savedMuted: false },
  }),
  true
);
assert.equal(videoA.volume, 0.6, 'repeated settings delivery must not restore stale state');

clock = 5000;
videoA.volume = 0.2;
assert.equal(videoA.volume, 0.6, 'an automatic reset should restore the preferred value');

currentVideo = videoB;
runMainTick();
assert.equal(videoB.volume, 0.6, 'a replacement video should inherit the preferred value');

// A wheel over the Shorts player scrolls to the next item; it is not a
// volume gesture. Previously it opened the same intent window as a wheel over
// the slider, so YouTube's 100% reset was accepted as the user's preference.
windowListeners.get('wheel')[0]({ target: videoB });
videoB.currentSrc = 'https://example.test/next-short';
videoB.volume = 1;
assert.equal(
  videoB.volume,
  0.6,
  'Shorts navigation by wheel must not turn an automatic 100% reset into user intent'
);

// YouTube can also reset the native output directly while reusing the same
// element. The logical getter still returns 0.6, so restoration must compare
// the physical output as well.
currentVideo = directVideo;
runMainTick();
assert.ok(
  Math.abs(directVideo._volume - Math.pow(0.6, 3)) < 1e-9,
  'direct fallback should initially apply the exponential output'
);
directVideo._volume = 1;
directVideo.dispatchEvent(new EventMock('volumechange'));
assert.ok(
  Math.abs(directVideo._volume - Math.pow(0.6, 3)) < 1e-9,
  'a native 100% reset must be corrected even when logical volume is unchanged'
);

currentVideo = videoA;
runMainTick();
assert.equal(
  videoA.listenerCount('volumechange'),
  2,
  'returning to an earlier Shorts video must keep one state and one Web Audio listener'
);

assert.ok(
  posted.some((message) => message.type === 'YTEV_SAVE_VOLUME' && message.volume === 0.6),
  'accepted user volume should be persisted'
);

// --- подавление autoplay-mute: узкое окно вместо «навсегда» ---
// Раньше сеттер держал preferredMuted бессрочно, и video.muted = true не
// срабатывал никогда. Для muted-autoplay это фатально: без активации
// документа браузер отклоняет play() у незаглушённого элемента.
assert.equal(
  instance.update(secret, { settings: { useNativeSlider: false } }),
  true,
  'switching to the extension slider must be accepted'
);
assert.equal(
  JSON.parse(storage.get('ytev-volume-state-v1')).useNativeSlider,
  false,
  'the custom-slider choice must be cached for the next document_start'
);
currentVideo = videoA;
runMainTick();

videoA.mutedWrites.length = 0;
context.navigator.userActivation.hasBeenActive = false;
videoA.muted = true;
assert.equal(
  videoA.mutedWrites[0],
  true,
  'without user activation muted autoplay must reach the element'
);

videoA.muted = false;
clock = 6000; // всё ещё внутри окна, открытого привязкой videoA
videoA.mutedWrites.length = 0;
context.navigator.userActivation.hasBeenActive = true;
videoA.muted = true;
assert.equal(
  videoA.mutedWrites[0],
  false,
  "YouTube's autoplay mute must be suppressed inside the guard window"
);

clock = 20000;
videoA.mutedWrites.length = 0;
videoA.muted = true;
assert.equal(
  videoA.mutedWrites[0],
  true,
  'after the guard window expires muted writes must pass through'
);

// --- смена поколений ---
// Тот же bridge (тот же канал) не должен разворачивать второй экземпляр,
// а перезагрузка расширения (новый канал и секрет) обязана его сменить:
// раньше старый экземпляр оставался навсегда, и настройки из popup не
// доходили до страницы до перезагрузки вкладки.
assert.equal(
  context.youtubeVolumeMain(
    { channel, settings: {}, state: { savedVolume: 0.4, savedMuted: false } },
    secret
  ),
  false,
  'the same bridge must not install a second instance'
);
assert.equal(
  windowMock[Symbol.for('ytev.main.instance.v2')],
  instance,
  'the registry must still hold the first instance'
);

const nextChannel = 'fedcba9876543210fedcba9876543210';
const nextSecret = 'fedcba9876543210'.repeat(4);
assert.equal(
  context.youtubeVolumeMain(
    {
      channel: nextChannel,
      settings: { useNativeSlider: true },
      state: { savedVolume: 0.4, savedMuted: false },
    },
    nextSecret
  ),
  true,
  'a reloaded extension must take over the page'
);
const nextInstance = windowMock[Symbol.for('ytev.main.instance.v2')];
assert.notEqual(nextInstance, instance, 'the registry must hold the new generation');
assert.equal(nextInstance.channel, nextChannel);
assert.equal(
  videoA.listenerCount('volumechange'),
  1,
  'takeover must remove the previous Web Audio listener from the active video'
);
assert.equal(
  videoB.listenerCount('volumechange'),
  0,
  'takeover must remove Web Audio listeners from every graph, not only the active video'
);
assert.equal(
  nextInstance.update(secret, { settings: { gamma: 2 } }),
  false,
  'the dead secret of the previous generation must be rejected'
);
assert.equal(
  nextInstance.update(nextSecret, { settings: { gamma: 2 } }),
  true,
  'the new secret must deliver settings'
);

// Страница может заранее занять ключ глобального реестра символов — это
// не повод выключаться: раньше такой захват молча отключал расширение.
windowMock[Symbol.for('ytev.main.instance.v2')] = { squatted: true };
assert.equal(
  context.youtubeVolumeMain(
    {
      channel: '00112233445566778899aabbccddeeff',
      settings: { useNativeSlider: true },
      state: { savedVolume: 0.4, savedMuted: false },
    },
    '0011223344556677'.repeat(4)
  ),
  true,
  'a squatted registry key must not disable the extension'
);

console.log('main volume state regression test passed');
