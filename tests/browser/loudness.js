'use strict';

// Выравнивание громкости: YouTube кладёт в ответ плеера loudnessDb —
// насколько ролик громче своей цели. Громкие он глушит сам, тихие оставляет
// как есть, и расширение добирает недостающее усилителем Web Audio.
//
// Выбранную дорожку знает сам плеер: getDrcState() возвращает 0 при активном
// DRC и 1 без него. Из streamingData её вычислить нельзя — там лежат все
// доступные варианты (на ролике с DRC под itag 251 их сразу три), а не
// текущий выбор. Поэтому макет плеера здесь полнее, чем «один loudnessDb»:
// у него есть getDrcState, videoDetails, три варианта формата и
// правдоподобная строка громкости.
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
// spec: { id, db, offersDrc, drcState, drcStateWhen, drcNow, drcWhen,
//         statsDb, statsSilent, responseId, noDrcState }
// drcStateWhen/drcWhen — выражения строкой: спек уезжает в страницу как JSON,
// функции в нём не переживают сериализацию.
function installPlayer(spec, tone) {
  window.__started = Date.now();
  const player = document.getElementById('movie_player');
  const expr = (code) => (code ? new Function('return (' + code + ')') : null);
  const drcWhen = expr(spec.drcWhen);
  const drcStateWhen = expr(spec.drcStateWhen);
  // Как в полевом дампе Cmp99FbMSqY: три варианта под одним itag 251,
  // audioTrack: null у всех, признака «выбран» нет ни у одного.
  const variant = (extra) =>
    Object.assign(
      {
        itag: 251,
        mimeType: 'audio/webm; codecs="opus"',
        bitrate: 130000,
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        audioTrack: null,
      },
      extra
    );
  const formats = [variant({ loudnessDb: spec.db })];
  if (spec.offersDrc) {
    formats.push(variant({ isDrc: true, loudnessDb: 0 }));
    formats.push(variant({ isVb: true, loudnessDb: -4.24 }));
  }
  player.getVideoData = () => ({ video_id: spec.id });
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: spec.responseId || spec.id },
    playerConfig: {
      audioConfig: { loudnessDb: spec.db, enablePerFormatLoudness: true },
    },
    streamingData: { adaptiveFormats: formats },
  });
  // 0 — играет DRC, 1 — исходная дорожка. Любое другое значение расширение
  // обязано считать неизвестным.
  if (!spec.noDrcState) {
    player.getDrcState = () => {
      if (drcStateWhen) return drcStateWhen() ? 0 : 1;
      return spec.drcState != null ? spec.drcState : spec.offersDrc && spec.drcNow ? 0 : 1;
    };
  }
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

  // Статистика ещё молчит, но плеер уже знает выбранную дорожку — ждать
  // нечего. Это и есть выигрыш перед прежним разбором строки громкости.
  const byState = await measure({ id: 'state', db: -6, statsSilent: true });
  check(
    'решение принимается по состоянию плеера, без статистики',
    byState.last !== null &&
      Math.abs(byState.last - BASE_GAIN * boostOf(6)) < 1e-6 &&
      byState.report.source === 'drcState',
    `${byState.last} при источнике «${byState.report && byState.report.source}»`
  );

  // Наличие DRC-варианта в streamingData — это доступность, а не выбор: под
  // одним itag лежат сразу три варианта. Решать по нему нельзя.
  const offered = await measure({
    id: 'offered',
    db: -6,
    offersDrc: true,
    drcState: 1,
    statsSilent: true,
  });
  check(
    'наличие DRC-варианта в ответе само по себе усиление не отменяет',
    offered.last !== null && Math.abs(offered.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${offered.last} против ожидаемого ${BASE_GAIN * boostOf(6)}`
  );

  // getDrcState() — внутренний API. Неизвестное значение считаем «неизвестно»,
  // и усиление тогда не поднимается.
  const strange = await measure({
    id: 'strange',
    db: -6,
    offersDrc: true,
    drcState: 2,
    statsSilent: true,
  });
  check(
    'неизвестное значение getDrcState: усиление не поднимается',
    strange.gains.length > 0 && Math.max(...strange.gains) <= BASE_GAIN + 1e-6,
    `максимум в графе ${Math.max(...strange.gains)} при базовом ${BASE_GAIN}`
  );
  check(
    'неизвестное значение getDrcState: диагностика говорит «неизвестно»',
    strange.report && strange.report.complete === false,
    JSON.stringify(strange.report)
  );

  // Если внутренний метод однажды исчезнет, остаётся запасной путь: решение
  // по статистике, но только когда её уровень совпал с ответом плеера.
  const fallback = await measure({ id: 'fallback', db: -6, noDrcState: true });
  check(
    'без getDrcState решение берётся из подтверждённой статистики',
    fallback.last !== null &&
      Math.abs(fallback.last - BASE_GAIN * boostOf(6)) < 1e-6 &&
      fallback.report.source === 'stats',
    `${fallback.last} при источнике «${fallback.report && fallback.report.source}»`
  );

  const unconfirmed = await measure({
    id: 'unconfirmed',
    db: -6,
    noDrcState: true,
    statsSilent: true,
  });
  check(
    'без getDrcState и без подтверждения усиление не поднимается',
    unconfirmed.gains.length > 0 && Math.max(...unconfirmed.gains) <= BASE_GAIN + 1e-6,
    `максимум в графе ${Math.max(...unconfirmed.gains)} при базовом ${BASE_GAIN}`
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
      drcStateWhen: 'window.__drc === true',
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

  // Точная реконструкция пойманной гонки: при переходе Shorts → обычное видео
  // loudnessDb приходил раньше признака DRC в статистике, и расширение
  // успевало включить усиление на ~0.9с. В том же замере getDrcState() уже
  // отдавал 0 — значит опаздывала именно статистика, а не сам выбор дорожки.
  // Теперь она может опаздывать на сколько угодно.
  {
    const page = await play({
      id: 'race',
      db: -1.57,
      offersDrc: true,
      statsSilent: true,
      drcState: 0,
      drcWhen: 'Date.now() - window.__started > 600',
    });
    await page.waitForTimeout(2200);
    const { gains, report } = await readAll(page);
    await page.close();
    const loudest = gains.length ? Math.max(...gains) : 0;
    check(
      'поздняя статистика: усиление не включалось ни на миг',
      loudest <= BASE_GAIN + 1e-6,
      `максимум в графе ${loudest} при базовом ${BASE_GAIN}`
    );
    check(
      'поздняя статистика: решение сразу взято у плеера',
      report.drc === true && report.boostDb === 0 && report.source === 'drcState',
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
