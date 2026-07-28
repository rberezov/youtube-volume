'use strict';

// Выравнивание громкости: YouTube кладёт в ответ плеера loudnessDb —
// насколько ролик громче своей цели. Громкие он глушит сам, тихие оставляет
// как есть, и расширение добирает недостающее усилителем Web Audio.
//
// Когда наша нормализация включена, расширение сначала вызывает
// setDrcUserPreference(0), чтобы YouTube выбрал исходную дорожку. Состояние
// всё равно проверяется: getDrcState() возвращает 0 при активном DRC и 1 без
// него. Из streamingData текущий выбор вычислить нельзя — там лежат все
// доступные варианты (на ролике с DRC под itag 251 их сразу три).
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
// spec: { id, db, offersDrc, drcState, drcStateWhen, preference, preferenceWhen,
//         noPreference, drcNow, drcWhen, statsDb, statsSilent, responseId,
//         noDrcState, noDrcSetter }
// *When — выражения строкой: спек уезжает в страницу как JSON, функции в нём
// не переживают сериализацию.
function installPlayer(spec, tone) {
  window.__started = Date.now();
  const player =
    document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  const expr = (code) => (code ? new Function('return (' + code + ')') : null);
  const drcWhen = expr(spec.drcWhen);
  const drcStateWhen = expr(spec.drcStateWhen);
  const preferenceWhen = expr(spec.preferenceWhen);
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
  // Оба значения можно подменить на лету: YouTube переиспользует один
  // <video> для следующего ролика, и тест это воспроизводит.
  player.getVideoData = () => ({ video_id: window.__id != null ? window.__id : spec.id });
  player.getPlayerResponse = () => ({
    videoDetails: {
      videoId: spec.responseId || (window.__id != null ? window.__id : spec.id),
    },
    playerConfig: {
      audioConfig: { loudnessDb: spec.db, enablePerFormatLoudness: true },
    },
    streamingData: { adaptiveFormats: formats },
  });
  // 0 — играет DRC, 1 — исходная дорожка. Любое другое значение расширение
  // обязано считать неизвестным.
  if (!spec.noDrcState) {
    player.getDrcState = () => {
      if (window.__state != null) return window.__state;
      if (drcStateWhen) return drcStateWhen() ? 0 : 1;
      return spec.drcState != null ? spec.drcState : spec.offersDrc && spec.drcNow ? 0 : 1;
    };
  }
  // Предпочтение «стабильной громкости»: 1 — включена, 0 — выключена. Именно
  // оно меняется при ручном переключении, тогда как getDrcState() залипает.
  if (!spec.noPreference) {
    window.__drcPreferenceReads = 0;
    player.getDrcUserPreference = () => {
      window.__drcPreferenceReads += 1;
      if (window.__pref !== undefined) return Number(window.__pref) === 1 ? 1 : 0;
      if (preferenceWhen) return preferenceWhen() ? 1 : 0;
      return spec.preference != null ? spec.preference : 1;
    };
  }
  window.__drcPreferenceCalls = [];
  if (!spec.noDrcSetter) {
    player.setDrcUserPreference = (value) => {
      const preference = Number(value) === 1 ? 1 : 0;
      window.__drcPreferenceCalls.push(preference);
      window.__pref = preference;
    };
  }
  window.__statsReads = 0;
  player.getStatsForNerds = () => {
    window.__statsReads += 1;
    if (spec.drcNow === true || (drcWhen && drcWhen())) {
      return { volume: '100% / 100% (DRC (cont.-14.0 dB / tgt.-14.0 dB))' };
    }
    // statsSilent — статистика ещё не отдала уровень (или отдала чужой):
    // сверять не с чем, и снимок считается неполным.
    if (spec.statsSilent) return { volume: '100% / 100%' };
    const shown = spec.statsDb != null ? spec.statsDb : spec.db;
    // Старая форма печатала сам loudnessDb, нынешняя — абсолютный уровень и
    // цель нормализации, а loudnessDb в ней это их разность.
    if (spec.statsLegacy) {
      return { volume: `100% / 100% (content loudness ${shown.toFixed(1)}dB)` };
    }
    const target = -14;
    return {
      volume: `100% / 100% (cont.${(target + shown).toFixed(1)} dB / tgt.${target.toFixed(
        1
      )} dB)`,
    };
  };
  const video = document.querySelector('video');
  video.src = tone;
  video.loop = true;
}

run('loudness: компенсация тихих роликов', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  // Поднимает страницу с макетом плеера и запущенным тоном.
  async function play(
    spec,
    { normalize = true, maxBoostDb, state, withBridge = false, page: kind = 'watch' } = {}
  ) {
    const settings = { normalizeLoudness: normalize };
    if (maxBoostDb !== undefined) settings.maxBoostDb = maxBoostDb;
    const page = await openPage(browser, {
      page: kind,
      withMain: settings,
      withBridge,
      state,
      errors,
      before: async (target) => {
        await target.evaluate(
          ([install, record, s, tone]) => {
            window.__pageMessages = [];
            window.addEventListener('message', (event) => {
              if (event.source === window) window.__pageMessages.push(event.data);
            });
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
      drcPreferenceCalls: window.__drcPreferenceCalls.slice(),
      drcPreferenceReads: window.__drcPreferenceReads,
      statsReads: window.__statsReads,
      report: window[Symbol.for('ytev.main.instance.v2')].loudness(),
    }));

  // Возвращает последнее усиление, доехавшее до GainNode.
  async function measure(spec, options) {
    const page = await play(spec, options);
    // Даём настоящему media-элементу запуститься и завершить очередь событий.
    // Корректность расширения от этой паузы не зависит: пересчёт событийный.
    await page.waitForTimeout(1200);
    const { gains, report, drcPreferenceCalls } = await readAll(page);
    await page.close();
    return {
      last: gains.length ? gains[gains.length - 1] : null,
      gains,
      report,
      drcPreferenceCalls,
    };
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

  // Раньше здесь стояло «громкий ролик не трогаем — его YouTube приглушил
  // сам». Допущение оказалось неверным: приглушение плеер применяет записью
  // в video.volume, а мы такие записи откатываем к сохранённому уровню, и до
  // звука оно не доезжает. Полевой случай — Shorts с loudnessDb +3.48: играл
  // на 3.5дБ громче, чем без расширения. Раз громкость перехватываем мы,
  // приглушать тоже нам.
  const loud = await measure({ id: 'loud', db: 4 });
  check(
    'громкий ролик приглушается на свои 4дБ',
    loud.last !== null && Math.abs(loud.last - BASE_GAIN * boostOf(-4)) < 1e-6,
    `${loud.last} против ожидаемого ${BASE_GAIN * boostOf(-4)}`
  );
  check(
    'диагностика показывает приглушение отрицательным усилением',
    loud.report && Math.abs(loud.report.boostDb + 4) < 0.01,
    JSON.stringify(loud.report)
  );

  // Приглушение — возврат к поведению YouTube, а не наша добавка, поэтому
  // настройка на него не влияет. Подъём тихих — влияет.
  const loudOff = await measure({ id: 'loud', db: 4 }, { normalize: false });
  check(
    'приглушение работает и с выключенной настройкой',
    loudOff.last !== null && Math.abs(loudOff.last - BASE_GAIN * boostOf(-4)) < 1e-6,
    `${loudOff.last} против ожидаемого ${BASE_GAIN * boostOf(-4)}`
  );

  // При нашей нормализации DRC сначала выключается, затем к исходной дорожке
  // применяется наше приглушение.
  const loudDrc = await measure({
    id: 'louddrc',
    db: 4,
    offersDrc: true,
    drcNow: true,
  });
  check(
    'YouTube DRC выключен, громкий ролик приглушён расширением',
    loudDrc.last !== null &&
      Math.abs(loudDrc.last - BASE_GAIN * boostOf(-4)) < 1e-6 &&
      loudDrc.drcPreferenceCalls.includes(0),
    `${loudDrc.last} против ожидаемого ${BASE_GAIN * boostOf(-4)}`
  );

  const veryQuiet = await measure({ id: 'very', db: -20 });
  check(
    'усиление ограничено 6дБ даже для очень тихого',
    veryQuiet.last !== null && Math.abs(veryQuiet.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${veryQuiet.last} против потолка ${BASE_GAIN * boostOf(6)}`
  );

  // Потолок — настройка «Предел подъёма». Шесть децибел остаются значением по
  // умолчанию, но выбирает его пользователь.
  for (const cap of [1, 3, 10, 15]) {
    const capped = await measure({ id: 'cap' + cap, db: -20 }, { maxBoostDb: cap });
    check(
      `предел подъёма ${cap}дБ соблюдается`,
      capped.last !== null && Math.abs(capped.last - BASE_GAIN * boostOf(cap)) < 1e-6,
      `${capped.last} против ${BASE_GAIN * boostOf(cap)}`
    );
    check(
      `  диагностика показывает предел ${cap}дБ`,
      capped.report && capped.report.maxBoostDb === cap,
      JSON.stringify(capped.report && capped.report.maxBoostDb)
    );
  }

  // Значение приходит из хранилища, то есть может быть каким угодно: чужое
  // расширение, ручная правка, старая версия настроек.
  const wild = await measure({ id: 'wild', db: -20 }, { maxBoostDb: 99 });
  check(
    'значение вне диапазона подрезается до 15дБ',
    wild.last !== null && Math.abs(wild.last - BASE_GAIN * boostOf(15)) < 1e-6,
    `${wild.last} против ${BASE_GAIN * boostOf(15)}`
  );
  const negative = await measure({ id: 'neg', db: -20 }, { maxBoostDb: -5 });
  check(
    'отрицательный предел подъёма не переворачивает решение',
    negative.last !== null && Math.abs(negative.last - BASE_GAIN * boostOf(1)) < 1e-6,
    `${negative.last} против ${BASE_GAIN * boostOf(1)}`
  );

  // Предел меняют прямо в попапе, при играющем ролике: решение обязано
  // пересчитаться, а не остаться прежним до следующего перехода.
  {
    const page = await play({ id: 'live', db: -20 });
    await page.waitForTimeout(1200);
    const before = await page.evaluate(
      () => window[Symbol.for('ytev.main.instance.v2')].loudness().boostDb
    );
    const after = await page.evaluate(() => {
      window.__update({ normalizeLoudness: true, maxBoostDb: 15 });
      return window[Symbol.for('ytev.main.instance.v2')].loudness().boostDb;
    });
    await page.close();
    check(
      'смена предела применяется на лету',
      Math.abs(before - 6) < 0.01 && Math.abs(after - 15) < 0.01,
      `${before}дБ → ${after}дБ`
    );
  }

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
  // уже сведённую к −14 LKFS. Теперь расширение выключает её и применяет
  // собственный предел к исходной дорожке.
  const drcQuiet = await measure({
    id: 'drc',
    db: -12.7,
    offersDrc: true,
    drcNow: true,
  });
  check(
    'DRC-дорожка заменена исходной и усилена расширением',
    drcQuiet.last !== null &&
      Math.abs(drcQuiet.last - BASE_GAIN * boostOf(6)) < 1e-6 &&
      drcQuiet.drcPreferenceCalls.includes(0),
    `${drcQuiet.last} против ожидаемого ${BASE_GAIN * boostOf(6)}`
  );
  check(
    'диагностика подтверждает отключённую нормализацию YouTube',
    drcQuiet.report &&
      drcQuiet.report.drc === false &&
      drcQuiet.report.boostDb === 6 &&
      drcQuiet.report.youtubeNormalizationDisabled === true,
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
    noDrcSetter: true,
    statsSilent: true,
  });
  check(
    'неизвестное значение getDrcState: усиление не поднимается',
    strange.gains.length > 0 && Math.max(...strange.gains) <= BASE_GAIN + 1e-6,
    `максимум в графе ${Math.max(...strange.gains)} при базовом ${BASE_GAIN}`
  );
  // Без предпочтения решить, играет ли DRC, нельзя: одного залипающего
  // состояния мало.
  const noPref = await measure({
    id: 'nopref',
    db: -6,
    offersDrc: true,
    drcState: 0,
    noPreference: true,
    statsSilent: true,
  });
  check(
    'состояние 0 без getDrcUserPreference: усиление не поднимается',
    noPref.gains.length > 0 && Math.max(...noPref.gains) <= BASE_GAIN + 1e-6,
    `максимум в графе ${Math.max(...noPref.gains)} при базовом ${BASE_GAIN}`
  );
  check(
    'неизвестное значение getDrcState: диагностика говорит «неизвестно»',
    strange.report && strange.report.complete === false,
    JSON.stringify(strange.report)
  );

  // Если внутренние методы однажды исчезнут, остаётся запасной путь: решение
  // по статистике, но только когда её уровень совпал с ответом плеера.
  // Нынешняя форма строки печатает абсолютный уровень и цель, loudnessDb в
  // ней — их разность.
  const fallback = await measure({
    id: 'fallback',
    db: -6,
    noDrcState: true,
    noPreference: true,
  });
  check(
    'без методов плеера решение берётся из подтверждённой статистики',
    fallback.last !== null &&
      Math.abs(fallback.last - BASE_GAIN * boostOf(6)) < 1e-6 &&
      fallback.report.source === 'stats',
    `${fallback.last} при источнике «${fallback.report && fallback.report.source}»`
  );

  const legacyStats = await measure({
    id: 'legacy',
    db: -6,
    noDrcState: true,
    noPreference: true,
    statsLegacy: true,
  });
  check(
    'старая форма строки громкости тоже подтверждает уровень',
    legacyStats.last !== null &&
      Math.abs(legacyStats.last - BASE_GAIN * boostOf(6)) < 1e-6,
    `${legacyStats.last} против ожидаемого ${BASE_GAIN * boostOf(6)}`
  );

  const unconfirmed = await measure({
    id: 'unconfirmed',
    db: -6,
    noDrcState: true,
    noPreference: true,
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

  // При включённой нашей нормализации Stable Volume должна быть выключена
  // независимо от сохранённого предпочтения YouTube. Постоянного секундного
  // опроса больше нет: пользовательский вызов setter перехватывается сразу,
  // а переходы плеера перепроверяются по событиям.
  {
    const page = await play({
      id: 'preference',
      db: -12.7,
      offersDrc: true,
      drcState: 0, // залипает, как в поле
      drcNow: true,
      preference: 1,
    });
    await page.waitForTimeout(1200);
    const initial = await readAll(page);
    check(
      'на старте Stable Volume выключается и работает наша нормализация',
      initial.drcPreferenceCalls.includes(0) &&
        initial.report.preference === 0 &&
        initial.report.drc === false &&
        Math.abs(initial.report.boostDb - 6) < 0.01,
      JSON.stringify(initial)
    );

    const readsBeforeIdle = await page.evaluate(() => window.__drcPreferenceReads);
    await page.waitForTimeout(1200);
    const readsAfterIdle = await page.evaluate(() => window.__drcPreferenceReads);
    check(
      'после подтверждения DRC нет постоянного секундного опроса',
      readsAfterIdle === readsBeforeIdle,
      `${readsBeforeIdle} → ${readsAfterIdle} чтений`
    );

    const restored = await page.evaluate(() => {
      document.getElementById('movie_player').setDrcUserPreference(1);
      return {
        calls: window.__drcPreferenceCalls.slice(),
        preference: window.__pref,
        report: window[Symbol.for('ytev.main.instance.v2')].loudness(),
      };
    });
    await page.close();
    check(
      'пользовательское включение Stable Volume сразу отменяется и запоминается',
      restored.calls.filter((value) => value === 0).length >= 2 &&
        restored.preference === 0 &&
        restored.report.youtubeDrcRestoreNeeded === true &&
        restored.report.preference === 0 &&
        restored.report.drc === false &&
        Math.abs(restored.report.boostDb - 6) < 0.01,
      JSON.stringify(restored)
    );

    const nativePage = await play(
      {
        id: 'native-preference',
        db: -12.7,
        offersDrc: true,
        drcState: 0,
        drcNow: true,
        preference: 1,
      },
      { normalize: false }
    );
    await nativePage.waitForTimeout(1200);
    const native = await readAll(nativePage);
    await nativePage.close();
    check(
      'при выключенной нашей нормализации предпочтение YouTube не меняется',
      native.drcPreferenceCalls.length === 0 &&
        native.report.preference === 1 &&
        native.report.drc === true &&
        native.report.boostDb === 0,
      JSON.stringify(native)
    );

    const restoredPage = await play(
      {
        id: 'restore-preference',
        db: -12.7,
        offersDrc: true,
        drcState: 0,
        drcNow: true,
        preference: 1,
      },
      { withBridge: true }
    );
    await restoredPage.waitForTimeout(1200);
    await restoredPage.evaluate(() => {
      window.__update({ normalizeLoudness: false });
    });
    await restoredPage.waitForTimeout(400);
    const restoredNative = await restoredPage.evaluate(() => ({
      calls: window.__drcPreferenceCalls.slice(),
      runtimeMessages: window.__runtimeMessages.slice(),
      pageMessages: window.__pageMessages.slice(),
      report: window[Symbol.for('ytev.main.instance.v2')].loudness(),
    }));
    await restoredPage.close();
    check(
      'выключение нашей нормализации возвращает ранее включённую Stable Volume',
      restoredNative.calls.includes(0) &&
        restoredNative.calls.at(-1) === 1 &&
        restoredNative.report.enabled === false &&
        restoredNative.report.preference === 1 &&
        restoredNative.report.drc === true &&
        restoredNative.report.youtubeDrcRestoreNeeded === false &&
        restoredNative.runtimeMessages.filter(
          (message) => message.type === 'YTEV_SYNC_DRC_STATE'
        ).length >= 2 &&
        restoredNative.pageMessages
          .filter((message) => message && message.type === 'YTEV_DRC_STATE_DIRTY')
          .every((message) => !('secret' in message) && !('needed' in message)),
      JSON.stringify(restoredNative)
    );

    const stayedOffPage = await play(
      {
        id: 'keep-native-off',
        db: -6,
        offersDrc: true,
        drcState: 1,
        preference: 0,
      },
      { normalize: false }
    );
    await stayedOffPage.evaluate(() => {
      window.__update({ normalizeLoudness: true });
    });
    await stayedOffPage.waitForTimeout(1200);
    await stayedOffPage.evaluate(() => {
      window.__update({ normalizeLoudness: false });
    });
    await stayedOffPage.waitForTimeout(200);
    const stayedOff = await readAll(stayedOffPage);
    await stayedOffPage.close();
    check(
      'если Stable Volume была выключена пользователем, расширение не включает её',
      stayedOff.drcPreferenceCalls.length === 0 &&
        stayedOff.report.preference === 0 &&
        stayedOff.report.youtubeDrcRestoreNeeded === false,
      JSON.stringify(stayedOff)
    );

    const migratedPage = await play({
      id: 'legacy-guard-migration',
      db: -12.7,
      offersDrc: true,
      drcState: 0,
      drcNow: true,
      preference: 0,
    });
    await migratedPage.waitForTimeout(200);
    await migratedPage.evaluate(() => {
      window.__update({ normalizeLoudness: false });
    });
    await migratedPage.waitForTimeout(200);
    const migrated = await readAll(migratedPage);
    await migratedPage.close();
    check(
      'после обновления с 1.31.0 ранее отключённая расширением DRC возвращается',
      migrated.drcPreferenceCalls.includes(1) &&
        migrated.report.preference === 1 &&
        migrated.report.youtubeDrcRestoreNeeded === false,
      JSON.stringify(migrated)
    );

    const recoveredPage = await play(
      {
        id: 'restore-after-restart',
        db: -12.7,
        offersDrc: true,
        drcState: 0,
        drcNow: true,
        preference: 0,
      },
      {
        normalize: false,
        state: { restoreYoutubeDrc: true },
      }
    );
    await recoveredPage.waitForTimeout(200);
    const recovered = await readAll(recoveredPage);
    await recoveredPage.close();
    check(
      'незавершённое восстановление DRC продолжается после перезапуска',
      recovered.drcPreferenceCalls.length === 1 &&
        recovered.drcPreferenceCalls[0] === 1 &&
        recovered.report.preference === 1 &&
        recovered.report.youtubeDrcRestoreNeeded === false,
      JSON.stringify(recovered)
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
      noDrcSetter: true,
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

  // Смена ролика на том же <video>: bindVideo() выходит первой строкой, если
  // элемент тот же, а yt-navigate-start бывает не при каждом переходе. Пока
  // снимок нового ролика неполон, усиление прежнего продолжало действовать —
  // ровно тот исход «громче, чем нужно», ради которого всё и делалось.
  {
    const page = await play({ id: 'first', db: -6, statsSilent: true });
    await page.waitForTimeout(1200);
    const before = await page.evaluate(
      () => window[Symbol.for('ytev.main.instance.v2')].loudness().boostDb
    );
    check('на первом ролике усиление есть', Math.abs(before - 6) < 0.01, `${before}дБ`);

    const after = await page.evaluate(() => {
      window.__id = 'second'; // тот же элемент, другой ролик
      window.__state = 2; // снимок неполон: состояние дорожки неизвестно
      window.__pref = 1;
      document.getElementById('movie_player').setDrcUserPreference = undefined;
      document.querySelector('video').dispatchEvent(new Event('durationchange'));
      return window[Symbol.for('ytev.main.instance.v2')].loudness();
    });
    await page.close();
    check(
      'смена ролика на том же <video> снимает усиление сразу',
      after.boostDb === 0 && after.complete === false,
      JSON.stringify(after)
    );
  }

  // Watch и Shorts имеют разные последовательности перехода, но оба могут
  // переиспользовать один <video>. Проверяем каждую поверхность отдельно:
  // yt-player-updated должен снять старое решение сразу, а пачка media-событий
  // обязана дать один склеенный тяжёлый пересчёт.
  for (const kind of ['watch', 'shorts']) {
    const page = await play(
      { id: `${kind}-first`, db: -6, preference: 0, drcState: 1 },
      { page: kind }
    );
    const transition = await page.evaluate(async (surface) => {
      window.__statsReads = 0;
      window.__id = `${surface}-second`;
      document.dispatchEvent(new Event('yt-player-updated'));
      const video = document.querySelector('video');
      for (const type of [
        'emptied',
        'durationchange',
        'loadedmetadata',
        'loadeddata',
        'canplay',
        'playing',
      ]) {
        video.dispatchEvent(new Event(type));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const statsReads = window.__statsReads;
      return {
        statsReads,
        report: window[Symbol.for('ytev.main.instance.v2')].loudness(),
      };
    }, kind);
    await page.close();
    check(
      `${kind}: переход на том же <video> склеивает пачку событий`,
      transition.statsReads >= 1 &&
        transition.statsReads <= 2 &&
        transition.report.complete === true &&
        Math.abs(transition.report.boostDb - 6) < 0.01,
      JSON.stringify(transition)
    );
  }

  const missing = await measure({ id: 'missing', db: null, statsSilent: true });
  check(
    'без данных о громкости усиление не меняем',
    missing.last !== null && Math.abs(missing.last - BASE_GAIN) < 1e-6,
    `${missing.last} против ожидаемого ${BASE_GAIN}`
  );
});
