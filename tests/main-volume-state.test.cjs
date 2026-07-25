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
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
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
    this.dispatchEvent(new EventMock('volumechange'));
  },
});

const videoA = new HTMLMediaElementMock(0.2, false);
const videoB = new HTMLMediaElementMock(0.9, true);
let currentVideo = videoA;
let clock = 1000;
const posted = [];
const windowListeners = new Map();
const documentListeners = new Map();
const intervals = [];
const storage = new Map();

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
  postMessage(message, targetOrigin) {
    posted.push({ ...message, targetOrigin });
  },
};

const documentMock = {
  hidden: true,
  documentElement: {
    appendChild() {},
  },
  addEventListener(type, listener) {
    addListener(documentListeners, type, listener);
  },
  createElement() {
    return { textContent: '' };
  },
  getElementById(id) {
    return id === 'movie_player' ? player : null;
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
  clearInterval() {},
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
  performance: { now: () => clock },
  requestAnimationFrame(callback) {
    callback();
  },
  setInterval(callback) {
    intervals.push(callback);
    return intervals.length;
  },
  setTimeout(callback) {
    callback();
    return 1;
  },
  window: windowMock,
});
windowMock.window = windowMock;

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
vm.runInContext(source, context, { filename: 'main.js' });

const onMessage = windowListeners.get('message')[0];
const initialRequest = posted.find((message) => message.type === 'YTEV_GET_SETTINGS');
const channel = initialRequest.channel;
assert.match(channel, /^[a-f0-9]{32}$/);
assert.equal(initialRequest.targetOrigin, 'https://www.youtube.com');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: {
    type: 'YTEV_SETTINGS',
    channel: '00000000000000000000000000000000',
    settings: { useNativeSlider: true },
    state: { savedVolume: 0.9, savedMuted: true },
  },
});
assert.equal(videoA.volume, 0.2, 'a forged settings channel must be ignored');

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: {
    type: 'YTEV_SETTINGS',
    channel,
    settings: { useNativeSlider: true },
    state: { savedVolume: 0.4, savedMuted: false },
  },
});
assert.equal(videoA.volume, 0.4, 'saved volume should be restored on first bind');

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

onMessage({
  source: windowMock,
  origin: 'https://www.youtube.com',
  data: {
    type: 'YTEV_SETTINGS',
    channel,
    settings: { useNativeSlider: true },
    state: { savedVolume: 0.4, savedMuted: false },
  },
});
assert.equal(videoA.volume, 0.6, 'repeated settings delivery must not restore stale state');

clock = 5000;
videoA.volume = 0.2;
assert.equal(videoA.volume, 0.6, 'an automatic reset should restore the preferred value');

currentVideo = videoB;
intervals[0]();
assert.equal(videoB.volume, 0.6, 'a replacement video should inherit the preferred value');
currentVideo = videoA;
intervals[0]();
assert.equal(
  videoA.listenerCount('volumechange'),
  1,
  'returning to an earlier Shorts video must not duplicate listeners'
);

assert.ok(
  posted.some((message) => message.type === 'YTEV_SAVE_VOLUME' && message.volume === 0.6),
  'accepted user volume should be persisted'
);

console.log('main volume state regression test passed');
