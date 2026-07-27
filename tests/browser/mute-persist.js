'use strict';


// Кнопка mute на нулевой громкости должна и вернуть звук, и сохраниться:
// bridge выдаёт при этом сразу два разрешения — на mute и на уровень.
// Раньше обе ветки клика вели в «включить звук», уровень оставался нулевым,
// и кнопка выглядела мёртвой.

const { dragSlider, openPage, run } = require('./harness');

run('mute-persist: возврат уровня с нуля и его запись', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  const page = await openPage(browser, {
    withBridge: true,
    playerWidth: 1280,
    errors,
  });

  await dragSlider(page, 0);
  await page.waitForTimeout(400);
  const atZero = await page.evaluate(() => ({
    volume: document.querySelector('video').volume,
    writes: window.__writes.slice(),
  }));
  check('протяжка довела до нуля', atZero.volume === 0);
  check(
    'ноль сохранён',
    atZero.writes.some((write) => write.savedVolume === 0),
    JSON.stringify(atZero.writes)
  );

  await page.evaluate(() => (window.__writes.length = 0));
  await page.click('.ytev-mute');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    volume: +Number(document.querySelector('video').volume).toFixed(3),
    muted: document.querySelector('video').muted,
    writes: window.__writes.slice(),
  }));
  check('звук вернулся', after.volume === 0.5, `${after.volume}`);
  check('mute снят', after.muted === false);
  check(
    'возвращённый уровень сохранён',
    after.writes.some((write) => write.savedVolume === 0.5),
    JSON.stringify(after.writes)
  );
  check(
    'снятый mute сохранён',
    after.writes.some((write) => write.savedMuted === false),
    JSON.stringify(after.writes)
  );

  await page.click('.ytev-mute');
  await page.waitForTimeout(500);
  check(
    'повторный клик глушит',
    await page.evaluate(() => document.querySelector('video').muted === true)
  );
  await page.close();

  // Полевая находка: поменял громкость, сразу нажал mute — и громкость тоже
  // изменилась. Причина в том, что реализация mute() у плеера пишет в
  // video.volume, а окно доверия, открытое только что протянутым ползунком,
  // ещё не закрылось: служебная запись принималась за осознанный выбор, и
  // сохранённым уровнем становился ноль. Жест выключения звука теперь это
  // окно закрывает.
  {
    const zeroing = await openPage(browser, {
      withBridge: true,
      playerWidth: 1280,
      errors,
      before: async (target) => {
        await target.evaluate(() => {
          const player = document.getElementById('movie_player');
          // Как у настоящего плеера: mute() уводит уровень в ноль, а
          // прежний запоминает у себя.
          player.mute = () => {
            const video = player.querySelector('video');
            player._restore = video.volume;
            video.volume = 0;
            video.muted = true;
          };
          player.unMute = () => {
            const video = player.querySelector('video');
            video.muted = false;
            if (player._restore != null) video.volume = player._restore;
          };
        });
      },
    });

    await dragSlider(zeroing, 0.7);
    await zeroing.waitForTimeout(400);
    const chosen = await zeroing.evaluate(() =>
      +Number(document.querySelector('video').volume).toFixed(3)
    );
    check('громкость выставлена протяжкой', chosen > 0.1, `${chosen}`);

    // Сразу, внутри окна доверия от протяжки, — именно так и ломалось.
    await zeroing.evaluate(() => (window.__writes.length = 0));
    await zeroing.click('.ytev-mute');
    await zeroing.waitForTimeout(700);
    const muted = await zeroing.evaluate(() => ({
      muted: document.querySelector('video').muted,
      writes: window.__writes.slice(),
    }));
    check('mute сработал', muted.muted === true);
    check(
      'ноль от mute не записался как выбранная громкость',
      !muted.writes.some((write) => write.savedVolume === 0),
      JSON.stringify(muted.writes)
    );

    await zeroing.click('.ytev-mute');
    await zeroing.waitForTimeout(700);
    const back = await zeroing.evaluate(() =>
      +Number(document.querySelector('video').volume).toFixed(3)
    );
    check(
      'после снятия mute громкость та же, что была',
      Math.abs(back - chosen) < 0.01,
      `${chosen} → ${back}`
    );
    await zeroing.close();
  }
});
