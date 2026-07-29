'use strict';

// Цена сигнала от страницы.
//
// Расширение синхронизирует один флаг — «нужно ли вернуть пользователю
// Stable Volume». Просьбу перечитать его посылает MAIN-мир обычным
// postMessage, и мост намеренно принимает её без секрета: подделать значение
// нельзя, service worker читает его сам из доверенного экземпляра.
//
// Но просьба не бесплатна: каждая будит service worker, внедряет скрипт в
// MAIN-мир и пишет в хранилище. Ревизия безопасности показала, что скрипт
// страницы может гонять этот путь без ограничений — 50 сообщений давали
// 50 обращений. Здесь проверяется, что поток стал безобидным, а настоящий
// сигнал по-прежнему доходит.

const { openPage, run, waitFor } = require('./harness');

// Счётчик обращений к service worker на стороне страницы.
function countRuntimeMessages() {
  window.__sw = [];
  const send = window.chrome.runtime.sendMessage;
  window.chrome.runtime.sendMessage = (message, callback) => {
    window.__sw.push(message && message.type);
    if (typeof callback === 'function') callback({ ok: true });
    return send(message, callback);
  };
}

const syncCount = (page) =>
  page.evaluate(
    () => window.__sw.filter((type) => type === 'YTEV_SYNC_DRC_STATE').length
  );

// Поток сообщений, каждое в своей задаче — так это выглядело бы у скрипта
// страницы на таймере.
async function flood(page, channel, times) {
  await page.evaluate(
    async ([ch, count]) => {
      for (let i = 0; i < count; i += 1) {
        window.postMessage(
          { type: 'YTEV_DRC_STATE_DIRTY', channel: ch },
          location.origin
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    [channel, times]
  );
}

run('drc-sync: поток сигналов от страницы', async ({ browser, reporter, errors }) => {
  const { check } = reporter;

  const page = await openPage(browser, { withBridge: true, errors });
  await page.evaluate(countRuntimeMessages);
  const channel = await page.evaluate(
    () => window[Symbol.for('ytev.main.instance.v2')].channel
  );
  check('канал виден странице — подделать сообщение может кто угодно', !!channel);

  // Первый сигнал должен дойти сразу: он и есть смысл механизма.
  await page.evaluate(() => (window.__sw.length = 0));
  await flood(page, channel, 1);
  let delivered = true;
  try {
    await waitFor(async () => (await syncCount(page)) >= 1, {
      timeout: 2000,
      what: 'первой синхронизации',
    });
  } catch {
    delivered = false;
  }
  check('настоящий сигнал доходит', delivered, `обращений: ${await syncCount(page)}`);

  // Дальше — поток. Ограничитель держит не более одного обращения в секунду,
  // поэтому за полсекунды после первого пройти не должно ничто.
  await page.evaluate(() => (window.__sw.length = 0));
  await flood(page, channel, 50);
  await page.waitForTimeout(500);
  const burst = await syncCount(page);
  check(
    '50 сообщений подряд не превращаются в 50 обращений',
    burst <= 1,
    `обращений: ${burst}`
  );

  // И при этом путь не «выключен навсегда»: после паузы сигнал снова доходит.
  await page.evaluate(() => (window.__sw.length = 0));
  await page.waitForTimeout(1100);
  await flood(page, channel, 1);
  let resumed = true;
  try {
    await waitFor(async () => (await syncCount(page)) >= 1, {
      timeout: 2000,
      what: 'синхронизации после паузы',
    });
  } catch {
    resumed = false;
  }
  check('после паузы сигнал снова доходит', resumed, `обращений: ${await syncCount(page)}`);

  // Чужой канал мост обязан игнорировать целиком.
  //
  // Сначала даём отстояться: после потока выше в очереди может лежать
  // отложенный сигнал, и попади он в окно замера — проверка обвинила бы
  // чужой канал в чужой работе. Сперва убеждаемся, что тихо, и только потом
  // шлём подделку.
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window.__sw.length = 0));
  await page.waitForTimeout(300);
  const idle = await syncCount(page);
  check('в покое обращений нет', idle === 0, `обращений: ${idle}`);

  await flood(page, 'f'.repeat(32), 20);
  await page.waitForTimeout(300);
  const foreign = await syncCount(page);
  check('сообщение с чужим каналом не даёт ничего', foreign === 0, `обращений: ${foreign}`);

  await page.close();
});
