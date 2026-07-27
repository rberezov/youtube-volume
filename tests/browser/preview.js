'use strict';

// Предпросмотр ролика в ленте.
//
// Наведение на карточку поднимает отдельный плеер со своим <video>: стартует
// он немым, а по штатной кнопке снимает немоту на уровне, который помнит
// YouTube. Своей шкалы мы туда не встраиваем и кнопку не трогаем — но раз
// звук пошёл, идти он должен на сохранённом уровне.
//
// Обратной записи быть не должно: наведение на карточку — не выбор уровня.

const { openPage, run, waitFor } = require('./harness');

// В state харнесса сохранено 0.5 — его и должен получить предпросмотр.
const EXPECTED = 0.5;

// Второй плеер рядом с основным: так это и выглядит в ленте.
function addPreview() {
  const host = document.createElement('div');
  host.className = 'html5-video-player';
  host.id = 'inline-preview-player';
  const video = document.createElement('video');
  video.className = 'video-stream html5-main-video';
  video.muted = true;
  // Уровень, который помнит YouTube, — заведомо не наш.
  video.volume = 0.9;
  const unmute = document.createElement('button');
  unmute.className = 'ytp-unmute ytp-popup ytp-button';
  unmute.textContent = 'unmute';
  host.append(video, unmute);
  document.body.appendChild(host);
  return video;
}

run('preview: предпросмотр звучит на сохранённом уровне', async ({
  browser,
  reporter,
  errors,
}) => {
  const { check } = reporter;

  const page = await openPage(browser, { withBridge: true, errors });
  await page.evaluate(addPreview);

  const preview = () =>
    page.evaluate(() => {
      const el = document.querySelector('#inline-preview-player video');
      return { volume: +Number(el.volume).toFixed(3), muted: el.muted };
    });

  const beforeUnmute = await preview();
  check(
    'немой предпросмотр не трогаем',
    beforeUnmute.muted === true && beforeUnmute.volume === 0.9,
    JSON.stringify(beforeUnmute)
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
