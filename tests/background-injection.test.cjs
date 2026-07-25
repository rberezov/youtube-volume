'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let onMessage;
const injections = [];
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

  const manifest = JSON.parse(
    fs.readFileSync(require.resolve('../manifest.json'), 'utf8')
  );
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(
    manifest.content_scripts.some((entry) => entry.js.includes('main.js')),
    false,
    'main.js must only be injected with trusted executeScript arguments'
  );

  console.log('background trusted injection test passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
