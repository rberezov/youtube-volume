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
  'carryover.js',
  'mute-persist.js',
  'generation.js',
  'preload-silence.js',
];

const only = process.argv.slice(2);
const list = only.length
  ? HARNESSES.filter((name) => only.some((arg) => name.includes(arg)))
  : HARNESSES;

if (!list.length) {
  console.error(`ничего не выбрано; доступны: ${HARNESSES.join(', ')}`);
  process.exit(1);
}

const failed = [];
const started = Date.now();

for (const name of list) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    stdio: 'inherit',
    env: process.env,
  });
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
