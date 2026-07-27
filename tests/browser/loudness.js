'use strict';

// Выравнивание громкости: YouTube кладёт в ответ плеера loudnessDb —
// насколько ролик громче своей цели. Громкие он глушит сам, тихие оставляет
// как есть, и расширение добирает недостающее усилителем Web Audio.
//
// Наблюдать компенсацию снаружи можно только по фактическому усилению в
// графе, поэтому тест подменяет AudioContext и записывает всё, что уходит в
// GainNode. Подмена живёт на стороне теста — в расширении отладочных
// крючков для этого нет.

const { openPage, run } = require('./harness');

// Короткий тон: без реально играющего элемента граф Web Audio не строится,
// а значит и компенсации не будет видно.
function wavDataUri({ seconds = 3, freq = 220, amplitude = 0.2, rate = 8000 } = {}) {
  const samples = Math.floor(seconds * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * freq * index) / rate) * amplitude * 32767;
    buffer.writeInt16LE(Math.round(value), 44 + index * 2);
  }
  return 'data:audio/wav;base64,' + buffer.toString('base64');
}

const TONE = wavDataUri();

// Ожидаемое усиление без компенсации: логический уровень 0.5 в кубе.
const BASE_GAIN = Math.pow(0.5, 3);
const boostOf = (db) => Math.pow(10, db / 20);

run('loudness: компенсация тихих роликов', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  // Возвращает последнее усиление, доехавшее до GainNode.
  async function measure({ loudnessDb, normalize, withReport = false }) {
    const page = await openPage(browser, {
      withMain: { normalizeLoudness: normalize },
      errors,
      before: async (target) => {
        await target.evaluate(
          ([db, tone]) => {
            // 1. Записываем всё, что уходит в усиление.
            window.__gains = [];
            const Ctx = window.AudioContext;
            window.AudioContext = class extends Ctx {
              createGain() {
                const node = super.createGain();
                const proto = Object.getPrototypeOf(node.gain);
                const value = Object.getOwnPropertyDescriptor(proto, 'value');
                Object.defineProperty(node.gain, 'value', {
                  get: () => value.get.call(node.gain),
                  set: (next) => {
                    window.__gains.push(next);
                    value.set.call(node.gain, next);
                  },
                });
                const setTarget = node.gain.setTargetAtTime.bind(node.gain);
                node.gain.setTargetAtTime = (next, ...rest) => {
                  window.__gains.push(next);
                  return setTarget(next, ...rest);
                };
                return node;
              }
            };
            // 2. Плеер отдаёт уровень ролика так же, как настоящий YouTube.
            const player = document.getElementById('movie_player');
            player.getPlayerResponse = () => ({
              playerConfig: { audioConfig: { loudnessDb: db } },
            });
            player.getVideoData = () => ({ video_id: 'test' + db });
            // 3. Реально играющий элемент — иначе граф не построится.
            const video = document.querySelector('video');
            video.src = tone;
            video.loop = true;
          },
          [loudnessDb, TONE]
        );
      },
    });

    await page.evaluate(() => document.querySelector('video').play());
    // граф строится на playing, компенсация приезжает секундным тиком
    await page.waitForTimeout(2200);
    const gains = await page.evaluate(() => window.__gains.slice());
    const built = await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'volume'
      );
      // при работающем графе элемент держится на максимуме
      return descriptor.get.call(document.querySelector('video')) !== null;
    });
    const report = withReport
      ? await page.evaluate(() =>
          window[Symbol.for('ytev.main.instance.v2')].loudness()
        )
      : null;
    await page.close();
    return { last: gains.length ? gains[gains.length - 1] : null, gains, built, report };
  }

  const quiet = await measure({ loudnessDb: -6, normalize: true });
  check(
    'граф Web Audio построился и усиление наблюдаемо',
    quiet.last !== null,
    `записей усиления: ${quiet.gains.length}`
  );
  check(
    'тихий ролик (-6дБ) подтянут ровно на 6дБ',
    quiet.last !== null && Math.abs(quiet.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${quiet.last} против ожидаемого ${BASE_GAIN * boostOf(6)}`
  );

  const off = await measure({ loudnessDb: -6, normalize: false });
  check(
    'с выключенной настройкой компенсации нет',
    off.last !== null && Math.abs(off.last - BASE_GAIN) < 1e-6,
    `${off.last} против ожидаемого ${BASE_GAIN}`
  );

  const loud = await measure({ loudnessDb: 4, normalize: true });
  check(
    'громкий ролик не трогаем — его YouTube приглушил сам',
    loud.last !== null && Math.abs(loud.last - BASE_GAIN) < 1e-6,
    `${loud.last} против ожидаемого ${BASE_GAIN}`
  );

  const veryQuiet = await measure({ loudnessDb: -20, normalize: true });
  check(
    'усиление ограничено 6дБ даже для очень тихого',
    veryQuiet.last !== null && Math.abs(veryQuiet.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${veryQuiet.last} против потолка ${BASE_GAIN * boostOf(6)}`
  );

  // Диагностика должна показывать то же, что реально ушло в усилитель:
  // ею пользователь сверяет наш вывод со «Статистикой для сисадминов».
  const reported = await measure({ loudnessDb: -6, normalize: true, withReport: true });
  check(
    'диагностика показывает прочитанный уровень',
    reported.report && reported.report.db === -6,
    JSON.stringify(reported.report)
  );
  check(
    'диагностика показывает применённое усиление',
    reported.report && Math.abs(reported.report.boostDb - 6) < 0.01,
    JSON.stringify(reported.report)
  );

  const missing = await measure({ loudnessDb: null, normalize: true });
  check(
    'без данных о громкости усиление не меняем',
    missing.last !== null && Math.abs(missing.last - BASE_GAIN) < 1e-6,
    `${missing.last} против ожидаемого ${BASE_GAIN}`
  );
});
