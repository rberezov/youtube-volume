'use strict';

// Выравнивание громкости: YouTube кладёт в ответ плеера loudnessDb —
// насколько ролик громче своей цели. Громкие он глушит сам, тихие оставляет
// как есть, и расширение добирает недостающее усилителем Web Audio.
//
// Решение принимается только по согласованному снимку: уровень из ответа
// плеера и тип дорожки из статистики должны описывать один и тот же ролик.
// Поэтому макет плеера здесь полнее, чем «один loudnessDb»: у него есть
// videoDetails, streamingData.adaptiveFormats и правдоподобная строка
// громкости — ровно те три места, откуда расширение и читает.
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

// Запись всего, что уходит в GainNode. Уезжает в страницу через evaluate,
// поэтому ссылаться на замыкание внутри нельзя.
function recordGains() {
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
}

// Макет плеера в той форме, в какой данные приходят от настоящего YouTube.
// spec: { id, db, offersDrc, drcNow, drcWhen, statsDb, statsSilent, responseId }
// drcWhen — выражение строкой: спек уезжает в страницу как JSON, функции в
// нём не переживают сериализацию.
function installPlayer(spec, tone) {
  window.__started = Date.now();
  const player = document.getElementById('movie_player');
  const drcWhen = spec.drcWhen ? new Function('return (' + spec.drcWhen + ')') : null;
  const audio = (itag, drc) => ({
    itag,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 130000,
    audioQuality: 'AUDIO_QUALITY_MEDIUM',
    audioTrack: drc ? { id: 'en.4', displayName: 'English original' } : undefined,
    isDrc: drc ? true : undefined,
    url: 'https://rr3---sn-x.googlevideo.com/videoplayback?expire=1&sig=' + 'A'.repeat(200),
  });
  const formats = [audio(251, false)];
  if (spec.offersDrc) formats.push(audio('251-drc', true));
  player.getVideoData = () => ({ video_id: spec.id });
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: spec.responseId || spec.id },
    playerConfig: { audioConfig: { loudnessDb: spec.db } },
    streamingData: { adaptiveFormats: formats },
  });
  player.getStatsForNerds = () => {
    if (spec.drcNow === true || (drcWhen && drcWhen())) {
      return { volume: 'DRC (cont.-14.0 dB / tgt.-14.0 dB)' };
    }
    // statsSilent — статистика ещё не отдала уровень (или отдала чужой):
    // сверять не с чем, и снимок считается неполным.
    if (spec.statsSilent) return { volume: '100% / 100%' };
    const shown = spec.statsDb != null ? spec.statsDb : spec.db;
    return { volume: `100% / 100% (content loudness ${shown.toFixed(1)}dB)` };
  };
  const video = document.querySelector('video');
  video.src = tone;
  video.loop = true;
}

run('loudness: компенсация тихих роликов', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  // Поднимает страницу с макетом плеера и запущенным тоном.
  async function play(spec, { normalize = true } = {}) {
    const page = await openPage(browser, {
      withMain: { normalizeLoudness: normalize },
      errors,
      before: async (target) => {
        await target.evaluate(
          ([install, record, s, tone]) => {
            new Function('return ' + record)()();
            new Function('return ' + install)()(s, tone);
          },
          [installPlayer.toString(), recordGains.toString(), spec, TONE]
        );
      },
    });
    await page.evaluate(() => document.querySelector('video').play());
    return page;
  }

  const readAll = (page) =>
    page.evaluate(() => ({
      gains: window.__gains.slice(),
      report: window[Symbol.for('ytev.main.instance.v2')].loudness(),
    }));

  // Возвращает последнее усиление, доехавшее до GainNode.
  async function measure(spec, options) {
    const page = await play(spec, options);
    // Решение больше не ждёт окна определения дорожки: снимок согласован уже
    // на старте, и хватает одного секундного тика с запасом.
    await page.waitForTimeout(1200);
    const { gains, report } = await readAll(page);
    await page.close();
    return { last: gains.length ? gains[gains.length - 1] : null, gains, report };
  }

  const quiet = await measure({ id: 'quiet', db: -6 });
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

  const off = await measure({ id: 'off', db: -6 }, { normalize: false });
  check(
    'с выключенной настройкой компенсации нет',
    off.last !== null && Math.abs(off.last - BASE_GAIN) < 1e-6,
    `${off.last} против ожидаемого ${BASE_GAIN}`
  );

  const loud = await measure({ id: 'loud', db: 4 });
  check(
    'громкий ролик не трогаем — его YouTube приглушил сам',
    loud.last !== null && Math.abs(loud.last - BASE_GAIN) < 1e-6,
    `${loud.last} против ожидаемого ${BASE_GAIN}`
  );

  const veryQuiet = await measure({ id: 'very', db: -20 });
  check(
    'усиление ограничено 6дБ даже для очень тихого',
    veryQuiet.last !== null && Math.abs(veryQuiet.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${veryQuiet.last} против потолка ${BASE_GAIN * boostOf(6)}`
  );

  // Диагностика должна показывать то же, что реально ушло в усилитель:
  // ею пользователь сверяет наш вывод со «Статистикой для сисадминов».
  check(
    'диагностика показывает прочитанный уровень',
    quiet.report && quiet.report.db === -6 && quiet.report.complete === true,
    JSON.stringify(quiet.report)
  );
  check(
    'диагностика показывает применённое усиление',
    quiet.report && Math.abs(quiet.report.boostDb - 6) < 0.01,
    JSON.stringify(quiet.report)
  );

  // Находка полевой проверки на Cmp99FbMSqY: YouTube отдал DRC-дорожку,
  // уже сведённую к −14 LKFS, а playerConfig.audioConfig.loudnessDb остался
  // от исходной (−12.7дБ). Усиление поверх этого — двойная нормализация.
  const drcQuiet = await measure({
    id: 'drc',
    db: -12.7,
    offersDrc: true,
    drcNow: true,
  });
  check(
    'при активной DRC-дорожке усиления нет',
    drcQuiet.last !== null && Math.abs(drcQuiet.last - BASE_GAIN) < 1e-6,
    `${drcQuiet.last} против ожидаемого ${BASE_GAIN}`
  );
  check(
    'диагностика сообщает про DRC',
    drcQuiet.report && drcQuiet.report.drc === true && drcQuiet.report.boostDb === 0,
    JSON.stringify(drcQuiet.report)
  );

  // Второй путь к решению: статистика молчит, но в ответе плеера нет ни одной
  // DRC-дорожки — играть ей неоткуда, и ждать нечего.
  const byFormats = await measure({ id: 'formats', db: -6, statsSilent: true });
  check(
    'без DRC-дорожки в ответе решение принимается без статистики',
    byFormats.last !== null && Math.abs(byFormats.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${byFormats.last} при источнике «${byFormats.report && byFormats.report.source}»`
  );

  // Главная проверка: DRC-дорожка предлагается, а статистика ещё не про этот
  // ролик (показывает чужой уровень). Снимок не согласован — усиления нет
  // ни на миг, и это не зависит ни от какого времени.
  const ambiguous = await measure({
    id: 'ambiguous',
    db: -6,
    offersDrc: true,
    statsSilent: true,
  });
  check(
    'несогласованный снимок: усиление не поднимается',
    ambiguous.gains.length > 0 && Math.max(...ambiguous.gains) <= BASE_GAIN + 1e-6,
    `максимум в графе ${Math.max(...ambiguous.gains)} при базовом ${BASE_GAIN}`
  );
  check(
    'несогласованный снимок: диагностика честно говорит «неизвестно»',
    ambiguous.report && ambiguous.report.complete === false,
    JSON.stringify(ambiguous.report)
  );

  // Ответ плеера от предыдущего ролика (так бывает сразу после перехода)
  // решением не считается, даже если статистика подтверждает его уровень.
  const stale = await measure({
    id: 'current',
    responseId: 'previous',
    db: -6,
  });
  check(
    'ответ плеера от чужого ролика не применяется',
    stale.last !== null && Math.abs(stale.last - BASE_GAIN) < 1e-6,
    `${stale.last} против ожидаемого ${BASE_GAIN}`
  );

  // «Стабильную громкость» можно включить прямо во время ролика: решение
  // должно пересчитаться, а не залипнуть на прежнем усилении.
  {
    const page = await play({
      id: 'toggle',
      db: -6,
      offersDrc: true,
      drcWhen: 'window.__drc === true',
    });
    await page.waitForTimeout(1200);
    const before = (await readAll(page)).report.boostDb;
    await page.evaluate(() => (window.__drc = true));
    await page.waitForTimeout(1600); // решение обновляет секундный тик
    const after = (await readAll(page)).report.boostDb;
    await page.close();
    check(
      'включение DRC во время ролика снимает усиление',
      Math.abs(before - 6) < 0.01 && after === 0,
      `${before}дБ → ${after}дБ`
    );
  }

  // Страховка от прежней гонки: при переходе Shorts → обычное видео
  // loudnessDb приходил раньше признака DRC, и расширение успевало включить
  // усиление на ~0.9с. Теперь признак может опоздать на сколько угодно —
  // до него снимок несогласован, и усиления не бывает вовсе.
  {
    const page = await play({
      id: 'race',
      db: -1.57,
      offersDrc: true,
      statsSilent: true,
      drcWhen: 'Date.now() - window.__started > 600',
    });
    await page.waitForTimeout(2200);
    const { gains, report } = await readAll(page);
    await page.close();
    const loudest = gains.length ? Math.max(...gains) : 0;
    check(
      'поздний признак DRC: усиление не включалось ни на миг',
      loudest <= BASE_GAIN + 1e-6,
      `максимум в графе ${loudest} при базовом ${BASE_GAIN}`
    );
    check(
      'поздний признак DRC: итог — без усиления',
      report.drc === true && report.boostDb === 0,
      JSON.stringify(report)
    );
  }

  const missing = await measure({ id: 'missing', db: null, statsSilent: true });
  check(
    'без данных о громкости усиление не меняем',
    missing.last !== null && Math.abs(missing.last - BASE_GAIN) < 1e-6,
    `${missing.last} против ожидаемого ${BASE_GAIN}`
  );
});
