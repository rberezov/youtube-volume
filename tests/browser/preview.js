'use strict';

// Предпросмотр ролика в ленте.
//
// Наведение на карточку поднимает отдельный плеер со своим <video>: стартует
// он немым, а по штатной кнопке снимает немоту на уровне, который помнит
// YouTube. Своей шкалы мы туда не встраиваем и кнопку не трогаем — но раз
// звук пошёл, идти он должен на сохранённом и нормализованном уровне.
//
// Обратной записи быть не должно: наведение на карточку — не выбор уровня.

const { openPage, run, waitFor } = require('./harness');

// В state харнесса сохранено 0.5 — его и должен получить предпросмотр.
const EXPECTED = 0.5;
const QUIET_DB = -6;
const HOT_DB = 8.39;
const physicalFor = (db) =>
  Math.pow(EXPECTED, 3) * Math.pow(10, -db / 20);

// Второй плеер рядом с основным: так это и выглядит в ленте.
function addPreview() {
  const host = document.createElement('div');
  host.className = 'html5-video-player';
  host.id = 'inline-preview-player';
  const video = document.createElement('video');
  video.className = 'video-stream html5-main-video';
  video.muted = true;
  window.__previewDb = -6;
  host.getVideoData = () => ({ video_id: 'preview-video' });
  host.getPlayerResponse = () => ({
    videoDetails: { videoId: 'preview-video' },
    playerConfig: {
      audioConfig: {
        loudnessDb: window.__previewDb,
        enablePerFormatLoudness: true,
      },
    },
    streamingData: {
      adaptiveFormats: [
        {
          itag: 251,
          mimeType: 'audio/webm; codecs="opus"',
          loudnessDb: window.__previewDb,
          audioTrack: null,
        },
      ],
    },
  });
  host.getDrcState = () => 1;
  host.getDrcUserPreference = () => 0;
  // Уровень, который помнит YouTube, — заведомо не наш.
  video.volume = 0.9;
  const unmute = document.createElement('button');
  unmute.className = 'ytp-unmute ytp-popup ytp-button';
  unmute.textContent = 'unmute';
  host.append(video, unmute);
  document.body.appendChild(host);
  video.dispatchEvent(new Event('loadeddata'));
  return video;
}

run('preview: предпросмотр звучит на сохранённом и нормализованном уровне', async ({
  browser,
  reporter,
  errors,
}) => {
  const { check } = reporter;

  const page = await openPage(browser, {
    withBridge: true,
    errors,
    settings: { normalizeLoudness: true, maxBoostDb: 15 },
    before: async (target) => {
      await target.evaluate(() => {
        window.__previewGains = [];
        window.__previewNativeVolumeGet = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          'volume'
        ).get;
        const Ctx = window.AudioContext;
        window.AudioContext = class extends Ctx {
          createMediaElementSource(media) {
            this.__previewLastMedia = media;
            return super.createMediaElementSource(media);
          }

          createGain() {
            const media = this.__previewLastMedia;
            const node = super.createGain();
            const proto = Object.getPrototypeOf(node.gain);
            const value = Object.getOwnPropertyDescriptor(proto, 'value');
            Object.defineProperty(node.gain, 'value', {
              get: () => value.get.call(node.gain),
              set: (next) => {
                window.__previewGains.push({ media, value: next });
                value.set.call(node.gain, next);
              },
            });
            const setTarget = node.gain.setTargetAtTime.bind(node.gain);
            node.gain.setTargetAtTime = (next, ...rest) => {
              window.__previewGains.push({ media, value: next });
              return setTarget(next, ...rest);
            };
            return node;
          }
        };
      });
    },
  });
  await page.evaluate(addPreview);

  const preview = () =>
    page.evaluate(() => {
      const el = document.querySelector('#inline-preview-player video');
      const report =
        window[Symbol.for('ytev.main.instance.v2')].previewLoudness()[0] || null;
      const gains = window.__previewGains
        .filter((entry) => entry.media === el)
        .map((entry) => entry.value);
      return {
        volume: +Number(el.volume).toFixed(3),
        physical: gains.length
          ? gains[gains.length - 1]
          : window.__previewNativeVolumeGet.call(el),
        muted: el.muted,
        report,
      };
    });

  await waitFor(async () => (await preview()).report?.boostDb === 6, {
    timeout: 2000,
    what: 'расчёта нормализации тихого предпросмотра',
  });
  const beforeUnmute = await preview();
  check(
    'немой предпросмотр не трогаем',
    beforeUnmute.muted === true && beforeUnmute.volume === 0.9,
    JSON.stringify(beforeUnmute)
  );
  check(
    'для тихого предпросмотра заранее рассчитано усиление +6 дБ',
    beforeUnmute.report?.db === QUIET_DB && beforeUnmute.report?.boostDb === 6,
    JSON.stringify(beforeUnmute.report)
  );

  // Кнопка YouTube делает ровно это.
  await page.evaluate(() => {
    document.querySelector('#inline-preview-player video').muted = false;
  });
  await waitFor(async () => (await preview()).volume === EXPECTED, {
    timeout: 2000,
    what: 'применения сохранённого уровня к предпросмотру',
  });
  const afterUnmute = await preview();
  check(
    'после снятия немоты звучит сохранённый уровень',
    afterUnmute.volume === EXPECTED,
    `${afterUnmute.volume} против ${EXPECTED}`
  );
  await waitFor(
    async () =>
      Math.abs((await preview()).physical - physicalFor(QUIET_DB)) < 1e-4,
    {
      timeout: 2000,
      what: 'фактического усиления тихого предпросмотра',
    }
  );
  const quietOutput = await preview();
  check(
    'после снятия немоты нормализация предпросмотра остаётся активной',
    quietOutput.report?.boostDb === 6 &&
      Math.abs(quietOutput.physical - physicalFor(QUIET_DB)) < 1e-4,
    JSON.stringify(quietOutput)
  );

  // YouTube переиспользует один inline <video> для разных карточек. Старый
  // коэффициент должен сняться на смене media, а новый — взяться из ответа
  // именно нового предпросмотра.
  await page.evaluate((db) => {
    window.__previewDb = db;
    const video = document.querySelector('#inline-preview-player video');
    video.dispatchEvent(new Event('durationchange'));
    video.dispatchEvent(new Event('loadeddata'));
  }, HOT_DB);
  await waitFor(async () => (await preview()).report?.boostDb === -HOT_DB, {
    timeout: 2000,
    what: 'пересчёта нормализации громкого предпросмотра',
  });
  await waitFor(
    async () =>
      Math.abs((await preview()).physical - physicalFor(HOT_DB)) < 1e-4,
    {
      timeout: 2000,
      what: 'фактического приглушения громкого предпросмотра',
    }
  );
  const hot = await preview();
  check(
    'громкий предпросмотр приглушается на свои 8.39 дБ',
    hot.report?.db === HOT_DB &&
      hot.report?.boostDb === -HOT_DB &&
      Math.abs(hot.physical - physicalFor(HOT_DB)) < 1e-4,
    JSON.stringify(hot)
  );
  check(
    'решение предпросмотра не попало в основной плеер',
    await page.evaluate(
      () => window[Symbol.for('ytev.main.instance.v2')].loudness().boostDb === 0
    )
  );

  check(
    'штатная кнопка предпросмотра осталась на месте и видима',
    await page.evaluate(() => {
      const button = document.querySelector('#inline-preview-player .ytp-unmute');
      return !!button && getComputedStyle(button).visibility !== 'hidden';
    })
  );

  // Предпросмотр — не выбор уровня: в хранилище с него не уходит ничего.
  const writes = await page.evaluate(() => window.__writes.slice());
  check(
    'предпросмотр ничего не записывает в хранилище',
    !writes.some((write) => 'savedVolume' in write),
    JSON.stringify(writes)
  );

  // Главный плеер живёт своей логикой: его уровень предпросмотр не трогает.
  const main = await page.evaluate(
    () => +Number(document.querySelector('#movie_player video').volume).toFixed(3)
  );
  check('уровень основного плеера не сдвинулся', main === EXPECTED, `${main}`);

  await page.close();
});
