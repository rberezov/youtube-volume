'use strict';

// Смена поколений: перезагрузка расширения даёт новый канал и секрет.
// Старый экземпляр должен уступить место, а не остаться жить с мёртвым
// секретом — иначе настройки из popup перестают доходить до страницы.

const { TEST_SETTINGS, openPage, readSource, run } = require('./harness');

const A = { channel: 'a'.repeat(32), secret: '1'.repeat(64) };
const B = { channel: 'b'.repeat(32), secret: '2'.repeat(64) };

run('generation: передача управления между поколениями', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  // main.js подключаем сами, чтобы вызывать youtubeVolumeMain многократно
  const page = await openPage(browser, {
    withMain: false,
    playerWidth: 1280,
    errors,
    before: (target) => target.addScriptTag({ content: readSource('main.js') }),
  });

  const inject = (generation, settings) =>
    page.evaluate(
      ([channel, secret, value]) =>
        youtubeVolumeMain(
          { channel, settings: value, state: { savedVolume: 0.5, savedMuted: false } },
          secret
        ),
      [generation.channel, generation.secret, { ...TEST_SETTINGS, ...settings }]
    );

  check('первое поколение поднялось', (await inject(A)) === true);
  await page.waitForTimeout(900);
  check('блок построен', await page.evaluate(() => !!document.querySelector('.ytev-box')));

  check('повтор с тем же каналом отклонён', (await inject(A)) === false);
  check(
    'блок остался ровно один',
    (await page.evaluate(() => document.querySelectorAll('.ytev-box').length)) === 1
  );

  check('новое поколение поднялось', (await inject(B)) === true);
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    boxes: document.querySelectorAll('.ytev-box').length,
    channel: window[Symbol.for('ytev.main.instance.v2')].channel,
  }));
  check('блок по-прежнему один', after.boxes === 1, `${after.boxes}`);
  check('в реестре новое поколение', after.channel === B.channel);

  const updates = await page.evaluate(
    ([oldSecret, newSecret, settings]) => {
      const api = window[Symbol.for('ytev.main.instance.v2')];
      return {
        withOld: api.update(oldSecret, { settings }),
        withNew: api.update(newSecret, { settings }),
      };
    },
    [A.secret, B.secret, { ...TEST_SETTINGS, sliderScale: 45 }]
  );
  check('старый секрет отклонён', updates.withOld === false);
  check('новый секрет принят', updates.withNew === true);
  await page.waitForTimeout(500);
  const width = await page.evaluate(
    () => document.querySelector('.ytev-slider').getBoundingClientRect().width
  );
  check('настройка применилась', width > 500, `${Math.round(width)}px`);

  check(
    'логическая громкость цела после смены поколений',
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.volume = 0.4;
      return Math.abs(video.volume - 0.4) < 1e-6;
    })
  );
  await page.close();
});
