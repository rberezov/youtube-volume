'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let onMessage;
const injections = [];
const localWrites = [];
const mainFunction = function youtubeVolumeMain() {};

const chromeMock = {
  runtime: {
    lastError: null,
    onMessage: {
      addListener(listener) {
        onMessage = listener;
      },
    },
  },
  i18n: {
    getMessage(key) {
      return key === 'playerMute' ? 'Mute (m)' : `msg:${key}`;
    },
  },
  scripting: {
    async executeScript(details) {
      injections.push(details);
      return [{ frameId: 0, result: true }];
    },
  },
  storage: {
    sync: {
      get(defaults, callback) {
        callback({ ...defaults, gamma: 2.5, shortsScale: 60 });
      },
    },
    local: {
      get(defaults, callback) {
        callback({ ...defaults, savedVolume: 0.42, savedMuted: false });
      },
      set(value, callback) {
        localWrites.push(value);
        callback();
      },
    },
  },
};

const context = vm.createContext({
  URL,
  chrome: chromeMock,
  importScripts(path) {
    assert.equal(path, 'main.js');
  },
  youtubeVolumeMain: mainFunction,
});
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
vm.runInContext(source, context, { filename: 'background.js' });

async function run() {
  assert.equal(typeof onMessage, 'function');

  const channel = '0123456789abcdef0123456789abcdef';
  const secret = '0123456789abcdef'.repeat(4);
  let publicSlotCalled = false;
  const brokerCalls = [];
  context.window = {
    [Symbol.for('ytev.main.instance.v2')]: {
      version: 2,
      update() {
        publicSlotCalled = true;
        return true;
      },
      drcRestoreState() {
        publicSlotCalled = true;
        return false;
      },
    },
    [Symbol.for('ytev.preload.instance.v1')]: Object.freeze({
      version: 1,
      invokeControl(candidateSecret, operation, payload) {
        brokerCalls.push({ candidateSecret, operation, payload });
        return operation === 'update' ? true : true;
      },
    }),
  };
  assert.equal(
    context.updateYouTubeVolumeMain(secret, { settings: { gamma: 2 } }),
    true
  );
  assert.equal(context.readYouTubeVolumeDrcRestoreState(secret), true);
  assert.equal(publicSlotCalled, false, 'a replaced public MAIN slot must never receive the secret');
  assert.deepEqual(
    brokerCalls.map((call) => call.operation),
    ['update', 'drcRestoreState']
  );

  const sender = {
    frameId: 0,
    tab: { id: 17 },
    url: 'https://www.youtube.com/shorts/example',
  };

  let invalidResponse;
  assert.equal(
    onMessage(
      { type: 'YTEV_INIT', channel, secret },
      { ...sender, url: 'https://evil.example/' },
      (value) => {
        invalidResponse = value;
      }
    ),
    false
  );
  assert.equal(invalidResponse, undefined);
  assert.equal(injections.length, 0);

  assert.equal(
    onMessage(
      { type: 'YTEV_INIT', channel, secret },
      { ...sender, url: 'https://music.youtube.com/watch/example' },
      () => {}
    ),
    false,
    'YouTube Music must stay outside the extension scope'
  );
  assert.equal(injections.length, 0);

  let initResponse;
  assert.equal(
    onMessage({ type: 'YTEV_INIT', channel, secret }, sender, (value) => {
      initResponse = value;
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initResponse.ok, true);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].world, 'MAIN');
  assert.equal(injections[0].target.tabId, 17);
  assert.equal(injections[0].target.frameIds.length, 1);
  assert.equal(injections[0].target.frameIds[0], 0);
  assert.equal(injections[0].func, mainFunction);
  assert.equal(injections[0].args[0].channel, channel);
  assert.equal(injections[0].args[0].settings.gamma, 2.5);
  assert.equal(injections[0].args[0].state.savedVolume, 0.42);
  assert.equal(injections[0].args[0].state.restoreYoutubeDrc, null);
  // main.js работает в MAIN-мире, где chrome.i18n недоступен: подписи обязаны
  // уехать готовыми вместе с настройками, иначе кнопка останется без текста.
  assert.equal(
    injections[0].args[0].strings.playerMute,
    'Mute (m)',
    'localized strings must travel in the injection payload'
  );
  assert.equal(injections[0].args[0].strings.playerSliderLabel, 'msg:playerSliderLabel');
  assert.equal(injections[0].args[1], secret);

  let updateResponse;
  assert.equal(
    onMessage({ type: 'YTEV_UPDATE_SETTINGS', channel, secret }, sender, (value) => {
      updateResponse = value;
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updateResponse.ok, true);
  assert.equal(injections.length, 2);
  assert.equal(injections[1].world, 'MAIN');
  assert.equal(injections[1].func.name, 'updateYouTubeVolumeMain');
  assert.equal(injections[1].args[0], secret);
  assert.equal(injections[1].args[1].settings.shortsScale, 60);
  assert.equal('state' in injections[1].args[1], false);

  let drcSyncResponse;
  assert.equal(
    onMessage({ type: 'YTEV_SYNC_DRC_STATE', channel, secret }, sender, (value) => {
      drcSyncResponse = value;
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drcSyncResponse.ok, true);
  assert.equal(injections.length, 3);
  assert.equal(injections[2].world, 'MAIN');
  assert.equal(injections[2].func.name, 'readYouTubeVolumeDrcRestoreState');
  assert.equal(injections[2].args[0], secret);
  assert.equal(localWrites.length, 1);
  assert.equal(localWrites[0].restoreYoutubeDrc, true);

  const manifest = JSON.parse(
    fs.readFileSync(require.resolve('../manifest.json'), 'utf8')
  );
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('scripting'));
  assert.deepEqual(manifest.host_permissions, ['https://www.youtube.com/*']);
  assert.equal(
    manifest.content_scripts.some((entry) => entry.js.includes('main.js')),
    false,
    'main.js must only be injected with trusted executeScript arguments'
  );
  const preloadEntry = manifest.content_scripts.find((entry) =>
    entry.js.includes('preload.js')
  );
  assert.ok(preloadEntry, 'early MAIN-world preload must be registered');
  assert.equal(preloadEntry.world, 'MAIN');
  assert.equal(preloadEntry.run_at, 'document_start');
  assert.equal(
    manifest.content_scripts.some((entry) =>
      entry.matches.includes('https://music.youtube.com/*')
    ),
    false,
    'YouTube Music must not load any extension content script'
  );

  console.log('background trusted injection test passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
