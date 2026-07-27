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

  // Та же ловушка, но через ШТАТНУЮ кнопку YouTube. Она лежит внутри
  // .ytp-volume-area, а её ищет проверка «это регулятор громкости» — и пока
  // проверки шли подряд, вторая тут же заново открывала окно, закрытое
  // первой. В режиме штатной шкалы эта кнопка единственная доступная.
  {
    const native = await openPage(browser, {
      withBridge: true,
      playerWidth: 1280,
      errors,
      before: async (target) => {
        await target.evaluate(() => {
          const player = document.getElementById('movie_player');
          player.mute = () => {
            const video = player.querySelector('video');
            player._restore = video.volume;
            video.volume = 0;
            video.muted = true;
          };
          // Штатная кнопка звука должна и правда глушить, как у YouTube.
          document.querySelector('.ytp-mute-button').addEventListener('click', () => {
            player.mute();
          });
        });
      },
    });

    // Штатную кнопку мы прячем своим CSS — для клика возвращаем её видимой.
    // Проверяется не она сама, а разбор жеста в обработчике pointerdown.
    await native.addStyleTag({
      content:
        // Донорскую «пилюлю» расширение прячет инлайновым display: none —
        // правило с !important из таблицы стилей его перебивает.
        'html #movie_player .pill { display: flex !important; }' +
        'html #movie_player .ytp-volume-area,' +
        'html #movie_player .ytp-mute-button {' +
        ' display: inline-flex !important; visibility: visible !important; }',
    });
    await dragSlider(native, 0.6);
    await native.waitForTimeout(400);
    const chosen = await native.evaluate(() =>
      +Number(document.querySelector('video').volume).toFixed(3)
    );
    check('громкость выставлена перед штатным mute', chosen > 0.1, `${chosen}`);

    await native.evaluate(() => (window.__writes.length = 0));
    await native.click('.ytp-mute-button');
    await native.waitForTimeout(700);
    const writes = await native.evaluate(() => window.__writes.slice());
    check(
      'штатная кнопка mute не записывает ноль как выбранную громкость',
      !writes.some((write) => write.savedVolume === 0),
      JSON.stringify(writes)
    );
    await native.close();
  }
});
