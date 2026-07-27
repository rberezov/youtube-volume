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
});
