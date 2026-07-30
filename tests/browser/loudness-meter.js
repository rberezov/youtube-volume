'use strict';

// Измеритель громкости по ITU-R BS.1770-4.
//
// Проверяется не «работает ли», а «верно ли считает». Абсолютным числам из
// памяти доверять нельзя, поэтому калибровка построена на **относительных
// фактах**, каждый из которых можно вывести независимо от самого измерителя:
//
//  - тот же тон тише на 6дБ → ровно 6.02 LU разницы;
//  - один и тот же сигнал в двух каналах вместо одного → ровно +3.01 LU;
//  - 1кГц против 100Гц → разница, посчитанная здесь же из передаточной
//    функции биквадов, а не взятая на веру.
//
// Отдельно сверяется абсолютное значение: оно должно совпасть с формулой
// стандарта, посчитанной в тесте. Совпадение двух независимых путей — это и
// есть подтверждение, что коэффициенты выведены правильно.
//
// Рендер идёт в OfflineAudioContext: десять секунд материала считаются за
// доли секунды, поэтому проверки быстрые и полностью детерминированные.

const fs = require('node:fs');
const path = require('node:path');
const { createReporter, loadPlaywright } = require('./harness');

const ROOT = path.resolve(__dirname, '..', '..');

// Исходник воркле́та живёт в main.js между маркерами — единственный
// экземпляр на расширение и тесты. Тот же приём, что и в
// defaults-consistency: разбор исходника вместо копии.
function meterSource() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = source.indexOf('/* ytev:loudness-worklet:start */');
  const end = source.indexOf('/* ytev:loudness-worklet:end */');
  if (start < 0 || end < 0) throw new Error('в main.js не найдены маркеры воркле́та');
  const block = source.slice(start, end);
  const open = block.indexOf('`');
  const close = block.lastIndexOf('`');
  if (open < 0 || close <= open) throw new Error('не найдено тело воркле́та');
  return block.slice(open + 1, close);
}

// Отклик K-взвешивания на частоте f. Считается здесь независимо: сначала
// коэффициенты из аналоговых прототипов, затем |H(e^jw)| двух биквадов.
function kResponseDb(fs_, freq) {
  const stages = [];
  {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / fs_);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    stages.push({
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    });
  }
  {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / fs_);
    const a0 = 1 + K / Q + K * K;
    stages.push({
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    });
  }
  const w = (2 * Math.PI * freq) / fs_;
  let db = 0;
  for (const c of stages) {
    const cos1 = Math.cos(-w);
    const sin1 = Math.sin(-w);
    const cos2 = Math.cos(-2 * w);
    const sin2 = Math.sin(-2 * w);
    const nre = c.b0 + c.b1 * cos1 + c.b2 * cos2;
    const nim = c.b1 * sin1 + c.b2 * sin2;
    const dre = 1 + c.a1 * cos1 + c.a2 * cos2;
    const dim = c.a1 * sin1 + c.a2 * sin2;
    db += 20 * Math.log10(
      Math.sqrt((nre * nre + nim * nim) / (dre * dre + dim * dim))
    );
  }
  return db;
}

// Рендер одного отрезка материала через измеритель. Уезжает в страницу
// строкой, поэтому замыканий внутри быть не может.
const RENDER = `
async (spec, source) => {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const frames = Math.round(spec.rate * spec.seconds);
  const ctx = new OfflineAudioContext(spec.channels, frames, spec.rate);
  await ctx.audioWorklet.addModule(url);
  // Ноль выходов: в бою измеритель подключён так же и физически не может
  // попасть в звуковой путь.
  const meter = new AudioWorkletNode(ctx, 'ytev-loudness-meter', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: spec.channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  const buffer = ctx.createBuffer(spec.channels, frames, spec.rate);
  for (let ch = 0; ch < spec.channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / spec.rate;
      let value = 0;
      for (const seg of spec.segments) {
        if (t >= seg.from && t < seg.to) {
          value = seg.amp * Math.sin((2 * Math.PI * seg.freq * i) / spec.rate);
        }
      }
      data[i] = value;
    }
  }
  const source_ = ctx.createBufferSource();
  source_.buffer = buffer;
  meter.onprocessorerror = (e) => { window.__meterError = String(e && e.message || e); };
  source_.connect(meter);
  source_.connect(ctx.destination);
  source_.start();
  // Обработчик ставится ПОСЛЕ рендера: во время работы измеритель сам шлёт
  // снимок раз в секунду, и подписка до старта поймала бы первый тик вместо
  // ответа на запрос.
  await ctx.startRendering();
  // Ждём именно ответ на запрос: ежесекундные тики уже лежат в очереди
  // порта, и подписка отдаст сначала самый ранний из них.
  const answer = new Promise((resolve) => {
    meter.port.onmessage = (event) => {
      if (event.data && event.data.type === 'read') resolve(event.data);
    };
  });
  meter.port.postMessage('read');
  const snap = await answer;
  snap.error = window.__meterError || null;
  return snap;
}
`;

const RATE = 48000;
const SECONDS = 10;
const steady = (freq, amp) => [{ from: 0, to: SECONDS, freq, amp }];

const reporter = createReporter('loudness-meter: измеритель по BS.1770');
const { check, section } = reporter;

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const source = meterSource();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // AudioWorklet живёт только в защищённом контексте, about:blank не годится.
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>meter</title>' })
  );
  await page.goto('https://www.youtube.com/watch?v=meter');

  const render = (spec) =>
    page.evaluate(
      ([code, s, src]) => new Function('return (' + code + ')')()(s, src),
      [RENDER, { rate: RATE, seconds: SECONDS, channels: 2, ...spec }, source]
    );

  section('калибровка');
  const full = await render({ segments: steady(1000, 0.5) });
  const quiet = await render({ segments: steady(1000, 0.25) });
  const mono = await render({ channels: 1, segments: steady(1000, 0.5) });
  const low = await render({ segments: steady(100, 0.5) });

  check(
    'измеритель вообще посчитал блоки',
    full.blocks > 90 && full.integrated !== null,
    `блоков ${full.blocks}, интеграл ${full.integrated}`
  );

  const drop = full.integrated - quiet.integrated;
  check(
    'тише на 6дБ — ровно 6.02 LU',
    Math.abs(drop - 6.0206) < 0.02,
    `${drop.toFixed(3)} против 6.021`
  );

  const spread = full.integrated - mono.integrated;
  check(
    'два канала вместо одного — ровно 3.01 LU',
    Math.abs(spread - 3.0103) < 0.02,
    `${spread.toFixed(3)} против 3.010`
  );

  const tilt = full.integrated - low.integrated;
  const expectedTilt = kResponseDb(RATE, 1000) - kResponseDb(RATE, 100);
  check(
    '1кГц против 100Гц — ровно отклик K-фильтра',
    Math.abs(tilt - expectedTilt) < 0.05,
    `${tilt.toFixed(3)} против ${expectedTilt.toFixed(3)}`
  );

  // Абсолютная привязка: два независимых пути должны сойтись.
  const expectedAbsolute =
    -0.691 +
    10 *
      Math.log10(
        2 * ((0.5 * 0.5) / 2) * Math.pow(10, kResponseDb(RATE, 1000) / 10)
      );
  check(
    'абсолютное значение сходится с формулой стандарта',
    Math.abs(full.integrated - expectedAbsolute) < 0.05,
    `${full.integrated.toFixed(3)} против ${expectedAbsolute.toFixed(3)}`
  );

  section('гейтирование и диапазон');
  // Тихий кусок не должен тянуть оценку вниз: ради этого гейт и существует.
  //
  // Уровень тихого куска выбран между порогами намеренно. Цифровая тишина
  // отсекается раньше всяких гейтов (громкость −∞), а −80 dBFS не проходит
  // абсолютный порог −70 LUFS — обе такие проверки молчали бы о главном.
  // Здесь −46 dBFS: примерно −52 LUFS, то есть выше абсолютного порога и на
  // 40 LU ниже громкого куска. Отсекает его именно относительный гейт.
  const withSilence = await render({
    segments: [
      { from: 0, to: 5, freq: 1000, amp: 0.5 },
      { from: 5, to: 10, freq: 1000, amp: 0.005 },
    ],
  });
  // Без гейта половина тишины уронила бы оценку ровно на 3.01 LU: энергия
  // делится надвое. Гейт оставляет только переходные блоки на границе, и
  // сдвиг получается на порядок меньше — это и проверяем, вместе с
  // контрфактом, чтобы проверка не прошла при выключенном гейте.
  const silenceShift = full.integrated - withSilence.integrated;
  check(
    'пять секунд тихого куска почти не сдвигают оценку',
    Math.abs(silenceShift) < 0.3,
    `сдвиг ${silenceShift.toFixed(3)} LU`
  );
  check(
    '  и это не «половина энергии» — относительный гейт работает',
    Math.abs(silenceShift) < 1,
    `${silenceShift.toFixed(3)} против ~3 LU без гейта`
  );

  const flatLra = full.lra;
  check(
    'у ровного тона диапазон нулевой',
    flatLra !== null && flatLra < 0.5,
    `LRA ${flatLra}`
  );

  // Материал с разбросом: половина тише на 12дБ.
  const dynamic = await render({
    seconds: 40,
    segments: [
      { from: 0, to: 20, freq: 1000, amp: 0.5 },
      { from: 20, to: 40, freq: 1000, amp: 0.125 },
    ],
  });
  check(
    'у материала с разбросом 12дБ диапазон это видит',
    dynamic.lra !== null && dynamic.lra > 8,
    `LRA ${dynamic.lra === null ? '—' : dynamic.lra.toFixed(2)}`
  );

  section('снимок');
  check(
    'краткосрочные значения копятся раз в секунду',
    Array.isArray(full.recent) && full.recent.length >= 7,
    `значений ${full.recent ? full.recent.length : 0}`
  );
  check(
    'снимок сообщает частоту дискретизации и длительность',
    full.rate === RATE && Math.abs(full.seconds - SECONDS) < 0.05,
    JSON.stringify({ rate: full.rate, seconds: full.seconds })
  );

  await page.close();
  await browser.close();
  if (errors.length) {
    console.log('pageerrors:', errors);
    for (const error of errors) reporter.fail(`исключение на странице: ${error}`);
  } else {
    console.log('pageerrors: нет');
  }
  process.exit(reporter.finish() ? 1 : 0);
})().catch((error) => {
  console.error('СБОЙ харнесса:', error.message);
  process.exit(1);
});
