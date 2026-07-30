'use strict';

// Последовательный прогон браузерных харнессов. Каждый печатает свои
// «ок / СБОЙ» и завершается кодом возврата — раннер только собирает итог.
// Последовательно, а не параллельно: харнессы поднимают браузер и меряют
// вёрстку, и конкуренция за CPU делает замеры плавающими.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HARNESSES = [
  'regress.js',
  'layout-stress.js',
  'shorts-clicks.js',
  'dom-churn.js',
  'collapse.js',
  'spacing.js',
  'preview.js',
  'popup-fit.js',
  'carryover.js',
  'mute-persist.js',
  'generation.js',
  'preload-silence.js',
  'loudness.js',
  'audio-level.js',
  'hotkeys.js',
  'drc-sync.js',
  'loudness-meter.js',
  'meter-attach.js',
];

const only = process.argv.slice(2);
const list = only.length
  ? HARNESSES.filter((name) => only.some((arg) => name.includes(arg)))
  : HARNESSES;

if (!list.length) {
  console.error(`ничего не выбрано; доступны: ${HARNESSES.join(', ')}`);
  process.exit(1);
}

// Предохранитель: харнесс поднимает браузер, и если тот не запустится или
// повиснет на ожидании, прогон без ограничения ждал бы вечно и не показал
// бы даже, на чём именно застрял. Самый долгий харнесс идёт около 20с.
const HARNESS_TIMEOUT_MS = 180000;

const failed = [];
const started = Date.now();

for (const name of list) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    stdio: 'inherit',
    env: process.env,
    timeout: HARNESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.log(`\n СБОЙ  ${name}: не уложился в ${HARNESS_TIMEOUT_MS / 1000}с и был снят`);
    failed.push(name);
    continue;
  }
  if (result.status !== 0) failed.push(name);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
if (failed.length) {
  console.log(`Браузерные тесты: ${list.length - failed.length}/${list.length} за ${seconds}с`);
  console.log(`Со сбоями: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`Браузерные тесты: все ${list.length} прошли за ${seconds}с`);
