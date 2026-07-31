'use strict';

// Измеритель на настоящем расширении, а не на кусках исходников.
//
// Этот харнесс появился после полевой проверки: на живом youtube.com
// `loudness().live` оставался `null`. Причина оказалась не в измерителе —
// в доставке его кода. Воркле́т грузился строкой через `blob:`, а CSP
// страницы такой модуль отклоняет: `AbortError, Unable to load a worklet's
// module`. Ни одна прежняя проверка этого поймать не могла, потому что все
// они рендерят воркле́т сами, минуя и манифест, и CSP.
//
// Поэтому здесь поднимается настоящее расширение (`--load-extension` на
// корень репозитория), а страница отдаётся с заголовком CSP, при котором
// blob-модуль заведомо не грузится. Проверяется сквозной путь целиком:
// манифест → service worker → доверенная посылка → `chrome-extension://`
// → подключение к графу → снимок в диагностике.
//
// Нужен полноценный Chromium (`channel: 'chromium'`): headless shell, на
// котором работают остальные харнессы, расширения не поддерживает вовсе —
// контент-скрипты в нём просто не запускаются.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReporter, loadPlaywright } = require('./harness');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'watch.html'),
  'utf8'
);

// Инлайн в макете разрешён, blob — нет. Ровно та комбинация, на которой
// прежний путь молча отказывал.
const CSP = "script-src 'self' 'unsafe-inline'; object-src 'none'";

// Настоящий звук: 30 секунд тона в WAV. Измерителю нужно не меньше трёх
// секунд материала, прежде чем появится первое краткосрочное значение.
const PLAY = `
() => {
  const rate = 48000, seconds = 30, frames = rate * seconds;
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const str = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 2, Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 1000 * i / rate)), true);
  }
  const el = document.querySelector('video');
  el.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  // Смена громкости — то событие, на котором расширение строит звуковой
  // граф; без неё измерителю не к чему подключаться.
  el.volume = 0.6;
  return el.play().then(() => true, (e) => String(e && e.message || e));
}
`;

const reporter = createReporter('meter-attach: измеритель на настоящем расширении');
const { check } = reporter;

const readLive = (page) =>
  page.evaluate(() => {
    const api = window[Symbol.for('ytev.main.instance.v2')];
    if (!api) return { missing: true };
    const report = api.loudness();
    return { enabled: report.enabled, live: report.live };
  });

(async () => {
  const { chromium } = loadPlaywright();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytev-meter-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    // Выравнивание по умолчанию выключено, а измеритель работает только при
    // нём. Ставим настройку изнутри расширения — тем же способом, что и popup.
    const worker =
      context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    await worker.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.storage.sync.set({ normalizeLoudness: true }, resolve);
        })
    );

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const blocked = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/Content Security Policy|worklet/i.test(text)) blocked.push(text);
    });
    await page.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': CSP },
        body: FIXTURE,
      })
    );
    await page.goto('https://www.youtube.com/watch?v=meter');
    await page.waitForTimeout(1500);

    const booted = await page.evaluate(
      () => !!window[Symbol.for('ytev.main.instance.v2')]
    );
    check('расширение поднялось на странице', booted, booted ? '' : 'нет instance API');

    const played = await page.evaluate((code) => new Function('return (' + code + ')')()(), PLAY);
    check('звук пошёл', played === true, played === true ? '' : String(played));

    // Первое краткосрочное значение появляется через 3 секунды звука; ждём с
    // запасом, но не фиксированной паузой — иначе харнесс либо тормозит, либо
    // мигает на нагруженной машине.
    let live = null;
    const deadline = Date.now() + 20000;
    for (;;) {
      const snapshot = await readLive(page);
      if (snapshot.live) {
        live = snapshot.live;
        break;
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }

    check(
      'измеритель подключился и отдал снимок',
      !!live,
      live ? `${live.blocks} блоков за ${live.seconds.toFixed(1)}с` : 'live остался null'
    );

    if (live) {
      // Тон 0.5 в одном канале: −9.02 LUFS. Точное число здесь не главное —
      // важно, что меряется реальный сигнал, а не ноль и не мусор.
      check(
        'снимок про настоящий сигнал, а не про тишину',
        Number.isFinite(live.integrated) && live.integrated > -20 && live.integrated < 0,
        `интеграл ${live.integrated.toFixed(2)} LUFS`
      );
      check(
        'частота дискретизации разумная',
        live.rate >= 8000 && live.rate <= 192000,
        `${live.rate} Гц`
      );
    }

    // Контроль отрицательного: под этим CSP blob-модуль не грузится — именно
    // так и выглядел отказ на живом youtube.com.
    const blobResult = await page.evaluate(async () => {
      const ctx = new AudioContext();
      const url = URL.createObjectURL(
        new Blob(
          ['registerProcessor("ytev-probe", class extends AudioWorkletProcessor { process(){ return true } })'],
          { type: 'text/javascript' }
        )
      );
      try {
        await ctx.audioWorklet.addModule(url);
        ctx.close();
        return 'загрузился';
      } catch (e) {
        ctx.close();
        return e.name;
      }
    });
    check(
      'CSP макета действительно отвергает blob-модуль',
      blobResult !== 'загрузился',
      `blob: ${blobResult}`
    );

    if (errors.length) {
      console.log('pageerrors:', errors);
      for (const error of errors) reporter.fail(`исключение на странице: ${error}`);
    } else {
      console.log('pageerrors: нет');
    }
  } finally {
    await context.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }

  process.exit(reporter.finish() ? 1 : 0);
})().catch((error) => {
  console.error('СБОЙ харнесса:', error.message);
  process.exit(1);
});
