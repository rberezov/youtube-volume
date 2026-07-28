'use strict';

// Реальный замер громкости.
//
// tests/browser/loudness.js проверяет решение: какое число расширение
// передало в GainNode. Это проверка намерения, а не результата — между
// «записали 0.25» и «в динамики пошёл сигнал вдвое громче» лежит весь
// аудиотракт: перехваченный сеттер, кривая, сам граф Web Audio, откат на
// прямую запись громкости. Здесь измеряется именно результат: страница
// играет тон известного уровня, а тест снимает отсчёты с того самого узла,
// который подключён к destination, и считает по ним пик и СКЗ.
//
// Съём устроен так, чтобы ничего не знать про внутренности расширения:
// подменяется AudioNode.prototype.connect, и всё, что подключается к выходу
// контекста, дополнительно уводится в ScriptProcessorNode. То есть меряется
// сигнал ровно в той точке, откуда он уходит в динамики, — при любом пути,
// который расширение выберет.
//
// Что отсюда видно и не видно из остальных тестов:
//  - кривая real = logical^gamma действует на реальном сигнале, а не только
//    в числах, которыми обмениваются функции;
//  - два ролика, записанных с разницей 6дБ, после выравнивания звучат
//    одинаково — это и есть смысл настройки, и проверяется он замером;
//  - усиление поверх DRC-дорожки не применяется (полевой регресс: двойная
//    нормализация давала +6дБ на уже сведённом материале);
//  - потолок 6дБ и запас до перегрузки: тон с пиком −6dBFS после подъёма
//    упирается ровно в полную шкалу и не переходит её;
//  - смена усиления идёт без щелчка — по отсчётам видно, что скачка нет.

const { dragSlider, openPage, run, waitFor } = require('./harness');

// Тон низкой частоты: при пересчёте частоты дискретизации у него меньше
// всего лишнего, а пик остаётся точным.
const RATE = 44100;
const FREQ = 220;
const TONE_PATH = '/ytev-test-tone.wav';
const TONE_URL = 'https://www.youtube.com' + TONE_PATH;

// Уровень записи: 0.25 — «тихий» материал, 0.5 — ровно на 6дБ громче.
const QUIET_AMP = 0.25;
const LOUD_AMP = 0.5;

const dB = (value, reference) => 20 * Math.log10(value / reference);
const boostOf = (db) => Math.pow(10, db / 20);

// Полевой случай: Shorts с loudnessDb +3.48 и статистикой «100%/67%».
// Запись во столько же раз громче цели, во сколько YouTube собирался её
// приглушить.
const HOT_DB = 3.48;
const HOT_AMP = QUIET_AMP * boostOf(HOT_DB);

const tones = new Map();
function tone(amp) {
  if (tones.has(amp)) return tones.get(amp);
  const frames = RATE * 4;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * FREQ * i) / RATE) * amp * 32767;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const buffer = Buffer.concat([header, data]);
  tones.set(amp, buffer);
  return buffer;
}

// Считалка живёт в аудиопотоке.
//
// Первая версия снимала выход через ScriptProcessorNode, и на холостой машине
// это работало идеально, а в полном прогоне давало ложные срабатывания:
// наибольший шаг подскакивал до 0.15 при естественном 0.008. Диагностика
// показала разрыв всегда на границе кванта (256, 384, 896 — кратно 128) и с
// прыжком фазы, а не со ступенькой уровня. Так глючит сам измеритель:
// ScriptProcessorNode обслуживается главным потоком, и когда тот занят, кусок
// потока теряется. AudioWorklet считает в аудиопотоке и от занятости главного
// не зависит.
const TAP_PROCESSOR = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    // Предыдущий отсчёт переживает сброс намеренно. Ступенька усиления
    // приходится на границу кванта, а сброс приходит примерно туда же:
    // обнуляя last, измеритель ронял разрыв ровно в стык и не видел его.
    this.last = null;
    this.zero();
    this.port.onmessage = (event) => {
      if (event.data === 'reset') this.zero();
      this.port.postMessage(this.stats());
    };
  }
  zero() {
    this.frames = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.maxStep = 0;
  }
  stats() {
    return {
      frames: this.frames,
      peak: this.peak,
      sumSq: this.sumSq,
      maxStep: this.maxStep,
      rate: sampleRate,
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        const sample = channel[i];
        const abs = sample < 0 ? -sample : sample;
        if (abs > this.peak) this.peak = abs;
        this.sumSq += sample * sample;
        if (this.last !== null) {
          const step = Math.abs(sample - this.last);
          if (step > this.maxStep) this.maxStep = step;
        }
        this.last = sample;
      }
      this.frames += channel.length;
    }
    return true;
  }
}
registerProcessor('ytev-tap', Tap);
`;

// Съём выхода. Уезжает в страницу через evaluate, поэтому замыканий внутри
// быть не может.
function installTap(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  window.__tap = { node: null, ready: null, taps: 0 };
  // Модуль ставится на тот самый контекст, который создаст расширение:
  // AudioWorkletNode можно построить только на контексте с этим модулем.
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...args) {
      super(...args);
      window.__tap.ready = this.audioWorklet.addModule(url).catch((error) => {
        window.__tapError = String(error);
      });
    }
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = connect.call(this, destination, ...rest);
    try {
      const ctx = this.context;
      // Интересен только выход контекста: всё остальное (например, сторож
      // тишины самого расширения) до динамиков не доходит.
      if (ctx && destination === ctx.destination && !this.__ytevTapped) {
        this.__ytevTapped = true;
        const source = this;
        // Модуль грузится асинхронно, а connect синхронный — досоединяем, как
        // только модуль готов. Замер всё равно начинается позже, по факту
        // пришедших отсчётов.
        Promise.resolve(window.__tap.ready).then(() => {
          const probe = new AudioWorkletNode(ctx, 'ytev-tap');
          connect.call(source, probe);
          // Свой выход пробник не пишет, то есть подмешивает тишину; на замер
          // это не влияет — меряем то, что пришло на вход.
          connect.call(probe, ctx.destination);
          window.__tap.node = probe;
          window.__tap.taps += 1;
          window.__tap.rate = ctx.sampleRate;
        });
      }
    } catch {}
    return result;
  };
  const ask = (message) =>
    new Promise((resolve) => {
      const probe = window.__tap.node;
      if (!probe) {
        resolve(null);
        return;
      }
      probe.port.onmessage = (event) => resolve(event.data);
      probe.port.postMessage(message);
    });
  window.__tapReset = () => ask('reset');
  window.__tapRead = () => ask('read');
}

// Макет плеера в той же форме, в какой данные приходят от настоящего YouTube.
function installPlayer(spec) {
  const player = document.getElementById('movie_player');
  player.getVideoData = () => ({ video_id: spec.id });
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: spec.id },
    playerConfig: { audioConfig: { loudnessDb: spec.db, enablePerFormatLoudness: true } },
  });
  // 0 — играет DRC-вариант, 1 — исходная дорожка.
  player.getDrcState = () => (spec.drc ? 0 : 1);
  player.getDrcUserPreference = () => 1;
  player.getStatsForNerds = () =>
    spec.drc
      ? { volume: '100% / 100% (DRC (cont.-14.0 dB / tgt.-14.0 dB))' }
      : {
          volume: `100% / 100% (cont.${(-14 + spec.db).toFixed(1)} dB / tgt.-14.0 dB)`,
        };
}

run('audio-level: реальный уровень сигнала на выходе', async ({
  browser,
  reporter,
  errors,
}) => {
  const { check, section } = reporter;

  /**
   * Поднимает страницу, ставит съём выхода и запускает тон.
   * @param {object} spec       ролик: { id, db, drc }
   * @param {object} options    { amp, volume, normalize, maxBoostDb }
   */
  async function playing(
    spec,
    { amp = QUIET_AMP, volume = 0.8, normalize = true, maxBoostDb } = {}
  ) {
    const settings = { normalizeLoudness: normalize };
    if (maxBoostDb !== undefined) settings.maxBoostDb = maxBoostDb;
    const page = await openPage(browser, {
      withMain: settings,
      // Уровень приходит из хранилища: расширение держит именно его, и
      // любая посторонняя запись в video.volume была бы откачена обратно.
      state: { savedVolume: volume, savedMuted: false },
      errors,
      before: async (target) => {
        await target.evaluate(
          ([tap, player, s, processor]) => {
            new Function('return ' + tap)()(processor);
            new Function('return ' + player)()(s);
          },
          [installTap.toString(), installPlayer.toString(), spec, TAP_PROCESSOR]
        );
      },
    });
    // Маршрут ставится последним: у Playwright выигрывает позже
    // зарегистрированный, а макет страницы отвечает на весь youtube.com.
    await page.route(
      (url) => url.hostname === 'www.youtube.com' && url.pathname === TONE_PATH,
      (route, request) => {
        const requested = Number(new URL(request.url()).searchParams.get('amp'));
        route.fulfill({
          contentType: 'audio/wav',
          body: tone(Number.isFinite(requested) ? requested : QUIET_AMP),
        });
      }
    );
    await page.evaluate(async (src) => {
      const video = document.querySelector('video');
      video.loop = true;
      video.src = src;
      await video.play();
    }, `${TONE_URL}?amp=${amp}`);
    // Ждём не «сколько-нибудь», а факта: через граф пошли отсчёты.
    await waitFor(
      async () => {
        const stats = await page.evaluate(() => window.__tapRead());
        return !!stats && stats.frames > 8000;
      },
      { timeout: 8000, what: 'первых отсчётов через граф' }
    );
    return page;
  }

  // Замер окна: пик, СКЗ и наибольший скачок между соседними отсчётами.
  async function level(page, ms = 400) {
    await page.evaluate(() => window.__tapReset());
    await page.waitForTimeout(ms);
    const stats = await page.evaluate(async () => {
      const read = await window.__tapRead();
      return read ? { ...read, taps: window.__tap.taps } : null;
    });
    if (!stats) throw new Error('съём выхода не подключился');
    return {
      ...stats,
      rms: stats.frames ? Math.sqrt(stats.sumSq / stats.frames) : 0,
    };
  }

  const show = (value) => value.toFixed(4);

  // --- 1. Кривая действует на самом сигнале -------------------------------
  // Протяжка мышью, логический уровень читается с элемента, ожидание
  // считается из него же: real = logical^3, и в отсчётах должно быть ровно
  // столько же.
  section('кривая громкости в отсчётах');
  {
    const page = await playing({ id: 'curve', db: 0 }, { normalize: false, volume: 0.8 });

    const first = await level(page, 100);
    check(
      'выход контекста снимается (граф Web Audio действительно построен)',
      first.taps >= 1,
      `подключений к destination: ${first.taps}, частота ${first.rate}Гц`
    );

    for (const fraction of [0.95, 0.7, 0.45, 0.25]) {
      await dragSlider(page, fraction);
      const logical = await page.evaluate(() => document.querySelector('video').volume);
      const measured = await level(page);
      const expected = QUIET_AMP * Math.pow(logical, 3);
      const error = dB(measured.peak, expected);
      check(
        `логический ${logical.toFixed(3)} → пик ${show(measured.peak)} (ожидание ${show(
          expected
        )})`,
        Math.abs(error) < 0.2,
        `расхождение ${error.toFixed(2)}дБ`
      );
      // Синус: СКЗ ровно в √2 раз меньше пика. Если бы мы мерили не наш тон,
      // это соотношение не сошлось бы.
      check(
        `  форма сигнала не искажена (СКЗ = пик/√2)`,
        Math.abs(dB(measured.rms * Math.SQRT2, measured.peak)) < 0.3,
        `СКЗ ${show(measured.rms)} при пике ${show(measured.peak)}`
      );
    }
    await page.close();
  }

  // --- 2. Ради чего всё затевалось ----------------------------------------
  // Два ролика: один записан ровно на 6дБ тише другого и честно сообщает об
  // этом в loudnessDb. Без выравнивания разница слышна, с выравниванием её
  // быть не должно.
  section('выравнивание двух роликов, записанных с разницей 6дБ');
  {
    const measure = async (spec, amp, normalize) => {
      const page = await playing(spec, { amp, normalize });
      const value = await level(page);
      await page.close();
      return value.peak;
    };

    const loudOff = await measure({ id: 'loud', db: 0 }, LOUD_AMP, false);
    const quietOff = await measure({ id: 'quiet', db: -6 }, QUIET_AMP, false);
    const gapOff = dB(quietOff, loudOff);
    check(
      'без выравнивания тихий ролик тише громкого на 6дБ',
      Math.abs(gapOff + 6.02) < 0.2,
      `${gapOff.toFixed(2)}дБ (пики ${show(quietOff)} и ${show(loudOff)})`
    );

    const loudOn = await measure({ id: 'loud', db: 0 }, LOUD_AMP, true);
    const quietOn = await measure({ id: 'quiet', db: -6 }, QUIET_AMP, true);
    const gapOn = dB(quietOn, loudOn);
    check(
      'с выравниванием они звучат одинаково',
      Math.abs(gapOn) < 0.2,
      `${gapOn.toFixed(2)}дБ (пики ${show(quietOn)} и ${show(loudOn)})`
    );
    check(
      'громкий ролик при этом не тронут — его YouTube свёл сам',
      Math.abs(dB(loudOn, loudOff)) < 0.1,
      `${dB(loudOn, loudOff).toFixed(2)}дБ`
    );
  }

  // --- 3. DRC: усиливать нечего -------------------------------------------
  // Полевой регресс на Cmp99FbMSqY: YouTube отдал DRC-дорожку, сведённую к
  // −14 LKFS, а loudnessDb в ответе остался от исходной (−12.7дБ). Подъём
  // поверх этого — двойная нормализация, и слышно её как раз здесь.
  section('DRC-дорожка не усиливается');
  {
    const spec = { id: 'drc', db: -12.7, drc: true };
    const withDrc = await playing(spec, { normalize: true });
    const drcLevel = (await level(withDrc)).peak;
    await withDrc.close();

    const raw = await playing({ id: 'drc', db: -12.7 }, { normalize: false });
    const rawLevel = (await level(raw)).peak;
    await raw.close();

    check(
      'на активной DRC-дорожке уровень такой же, как без выравнивания',
      Math.abs(dB(drcLevel, rawLevel)) < 0.15,
      `${dB(drcLevel, rawLevel).toFixed(2)}дБ (пики ${show(drcLevel)} и ${show(rawLevel)})`
    );
  }

  // --- 4. Потолок и запас до перегрузки -----------------------------------
  // Подъём ограничен 6дБ сознательно: у материала, который на N дБ тише
  // цели, обычно есть примерно столько же запаса до пика, поэтому лимитер не
  // нужен. Проверка ровно этого утверждения: тон с пиком −6dBFS на полной
  // громкости упирается в единицу и не переходит её.
  section('потолок 6дБ и запас до перегрузки');
  {
    const page = await playing(
      { id: 'verysilent', db: -20 },
      { amp: QUIET_AMP, volume: 0.8, normalize: true }
    );
    const capped = await level(page);
    await page.close();
    const expected = QUIET_AMP * Math.pow(0.8, 3) * boostOf(6);
    check(
      'ролик на 20дБ тише цели поднят ровно на 6дБ, а не на 20',
      Math.abs(dB(capped.peak, expected)) < 0.2,
      `пик ${show(capped.peak)} против ${show(expected)}`
    );

    // Шесть децибел — значение по умолчанию, а не константа: предел выбирает
    // пользователь настройкой «Предел подъёма».
    for (const cap of [3, 10]) {
      const page = await playing(
        { id: 'cap' + cap, db: -20 },
        { amp: QUIET_AMP, volume: 0.8, normalize: true, maxBoostDb: cap }
      );
      const measured = await level(page);
      await page.close();
      const want = QUIET_AMP * Math.pow(0.8, 3) * boostOf(cap);
      check(
        `выбранный предел ${cap}дБ слышен именно как ${cap}дБ`,
        Math.abs(dB(measured.peak, want)) < 0.2,
        `пик ${show(measured.peak)} против ${show(want)}`
      );
    }

    const full = await playing(
      { id: 'headroom', db: -6 },
      { amp: LOUD_AMP, volume: 1, normalize: true }
    );
    const loudest = await level(full);
    await full.close();
    check(
      'тон −6dBFS на полной громкости доходит до шкалы, но не перегружает',
      loudest.peak <= 1.0001 && loudest.peak > 0.97,
      `пик ${show(loudest.peak)}`
    );
  }

  // --- 5. Смена усиления на ходу — без щелчка -----------------------------
  // Усиление меняется через setTargetAtTime, и это единственный способ
  // увидеть разницу: в числах ступенька и плавный переход выглядят
  // одинаково, а в отсчётах ступенька — разрыв.
  section('переключение выравнивания на ходу');
  {
    const page = await playing({ id: 'switch', db: -6 }, { normalize: false });
    const before = await level(page);

    // Переключаем несколько раз подряд: величина разрыва зависит от того, на
    // какую точку синуса пришлась ступенька, и у одиночного перехода она
    // может случайно оказаться мелкой. Разрывы копятся в одном замере.
    await page.evaluate(() => window.__tapReset());
    for (let round = 0; round < 3; round += 1) {
      await page.evaluate(() => window.__update({ normalizeLoudness: true }));
      await page.waitForTimeout(250);
      await page.evaluate(() => window.__update({ normalizeLoudness: false }));
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => window.__update({ normalizeLoudness: true }));
    await page.waitForTimeout(250);
    const during = await page.evaluate(() => window.__tapRead());
    const after = await level(page);

    check(
      'после включения настройки уровень поднялся на 6дБ',
      Math.abs(dB(after.peak, before.peak) - 6.02) < 0.2,
      `${dB(after.peak, before.peak).toFixed(2)}дБ (${show(before.peak)} → ${show(
        after.peak
      )})`
    );

    // Наибольший шаг синуса между соседними отсчётами — 2πf/rate от пика.
    // Ступенька усиления дала бы разрыв в разы больше.
    const natural = ((2 * Math.PI * FREQ) / after.rate) * after.peak;
    check(
      'переход прошёл без разрыва сигнала (щелчка нет)',
      during.maxStep < natural * 1.5,
      `наибольший шаг ${show(during.maxStep)} при естественном ${show(natural)}`
    );
    check(
      'на переходе нет перегрузки',
      during.peak <= 1.0001,
      `пик на переходе ${show(during.peak)}`
    );
    await page.close();
  }

  // --- 6. Выключение звука ------------------------------------------------
  // Здесь проверяется весь путь: нажатие мышью → выключение → тишина на
  // выходе → включение → ровно тот же уровень, что был.
  //
  // Отдельно замечено замером: тишину на этом пути обеспечивает сам элемент.
  // Прогон с усилением, намеренно игнорирующим muted, всё равно дал ноль на
  // выходе — Chromium глушит и то, что уходит в Web Audio. Умножение на ноль
  // в outputGain остаётся страховкой на случай другого движка, но
  // подтвердить его этим тестом нельзя, и он на это не претендует.
  section('выключение звука');
  {
    const page = await playing({ id: 'mute', db: -6 }, { normalize: true });
    const audible = await level(page, 200);
    await page.click('.ytev-mute');
    await page.waitForTimeout(300);
    const silent = await level(page, 200);
    check(
      'до нажатия сигнал есть',
      audible.peak > 0.01,
      `пик ${show(audible.peak)}`
    );
    check(
      'после выключения звука через граф идёт тишина',
      silent.peak < 1e-4,
      `пик ${silent.peak.toExponential(2)}`
    );

    await page.click('.ytev-mute');
    await page.waitForTimeout(300);
    const back = await level(page, 200);
    check(
      'после включения звук возвращается на прежний уровень',
      Math.abs(dB(back.peak, audible.peak)) < 0.15,
      `${dB(back.peak, audible.peak).toFixed(2)}дБ (${show(audible.peak)} → ${show(
        back.peak
      )})`
    );
    await page.close();
  }

  // --- 7. Громкий ролик: приглушение, которое иначе теряется ---------------
  // YouTube приглушает громкий ролик сам — записью в video.volume. Но эти
  // записи расширение откатывает к сохранённому уровню (иначе YouTube
  // сбрасывал бы громкость на своё значение при каждом переходе), и до звука
  // приглушение не доезжало: полевой Shorts с loudnessDb +3.48 играл на
  // 3.5дБ громче, чем без расширения. Проверка — по звуку: запись, которая
  // на 3.48дБ громче сведённой, обязана прийти к тому же уровню.
  section('приглушение громкого ролика');
  {
    const measure = async (spec, amp, normalize) => {
      const page = await playing(spec, { amp, normalize });
      const value = await level(page);
      await page.close();
      return value.peak;
    };

    const target = await measure({ id: 'target', db: 0 }, QUIET_AMP, false);
    const hot = await measure({ id: 'hot', db: HOT_DB }, HOT_AMP, false);
    check(
      'громкий ролик приходит к тому же уровню, что и сведённый',
      Math.abs(dB(hot, target)) < 0.2,
      `${dB(hot, target).toFixed(2)}дБ (пики ${show(hot)} и ${show(target)})`
    );

    // Приглушение — возврат к поведению YouTube, а не наша добавка: настройка
    // управляет только подъёмом тихих.
    const hotOn = await measure({ id: 'hot', db: HOT_DB }, HOT_AMP, true);
    check(
      'настройка выравнивания на приглушение не влияет',
      Math.abs(dB(hotOn, hot)) < 0.15,
      `${dB(hotOn, hot).toFixed(2)}дБ`
    );

    // Запас до перегрузки приглушение только увеличивает — проверяем, что
    // громкая запись на полной громкости не упирается в шкалу.
    const full = await playing(
      { id: 'hotfull', db: HOT_DB },
      { amp: HOT_AMP, volume: 1, normalize: false }
    );
    const loudest = await level(full);
    await full.close();
    check(
      'на полной громкости громкий ролик не перегружает',
      loudest.peak <= 1.0001,
      `пик ${show(loudest.peak)}`
    );
  }
});
