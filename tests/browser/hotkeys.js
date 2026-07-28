'use strict';

// Горячие клавиши и раскладка клавиатуры.
//
// YouTube опознаёт свои горячие клавиши по введённому символу (`e.key`).
// На нелатинской раскладке символ другой — m это «ь», k это «л», — и клавиши
// не срабатывают вовсе: ни отключение звука, ни пауза. Полевой отчёт был
// именно такой: «работают только на английской раскладке».
//
// Расширение опознаёт клавишу по `e.code` (физическая клавиша, от раскладки
// не зависит) и на чужой раскладке забирает событие себе: выполняет действие
// сразу и останавливает дальнейшую доставку. Отсюда два условия, которые тут
// и проверяются: на латинской раскладке звук не должен переключиться дважды,
// а на кириллице — не должен вернуться обратно, каким бы поздним ни оказался
// обработчик YouTube.
//
// Нажатия идут через CDP: Playwright умеет слать код клавиши, но не умеет
// подставить чужой символ, а нужна именно пара «символ „ь“ на клавише KeyM».
// События при этом настоящие (isTrusted), иначе расширение их не приняло бы.

const { openPage, run } = require('./harness');

// Обработчик самого YouTube, каким он виден снаружи: смотрит на символ и
// поэтому понимает только латиницу.
//
// delay — насколько поздно он отвечает. Полевая проверка показала, что нулём
// это считать нельзя: звук глох и тут же возвращался (слышно как треск), то
// есть обработчик YouTube успевал переключить его обратно после нас. Поэтому
// в тестах он умеет отвечать и с задержкой, а расширение обязано быть
// правым при любой.
function installYouTubeHotkeys(delay = 0, byCode = false) {
  window.__handled = [];
  document.addEventListener('keydown', (e) => {
    const act = (fn) => (delay ? setTimeout(fn, delay) : fn());
    const key = String(e.key).toLowerCase();
    const video = document.querySelector('#movie_player video');
    if (!video) return;
    // byCode — гипотеза «а вдруг YouTube смотрит на код клавиши»: тогда он
    // отвечает и на «ь». Расширение обязано остаться правым и в этом случае.
    const isMute = byCode ? e.code === 'KeyM' : key === 'm';
    const isPlay = byCode ? e.code === 'KeyK' : key === 'k';
    if (isMute) {
      act(() => {
        video.muted = !video.muted;
        window.__handled.push('m');
      });
    } else if (isPlay) {
      act(() => {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        window.__handled.push('k');
      });
    }
  });
}

// Раскладки: символ, который приходит с той же физической клавиши.
const LAYOUTS = {
  latin: { KeyM: 'm', KeyK: 'k' },
  cyrillic: { KeyM: 'ь', KeyK: 'л' },
};
const VIRTUAL_KEY = { KeyM: 77, KeyK: 75 };

async function press(page, code, layout) {
  const cdp = await page.context().newCDPSession(page);
  const key = LAYOUTS[layout][code];
  const common = {
    key,
    code,
    windowsVirtualKeyCode: VIRTUAL_KEY[code],
    nativeVirtualKeyCode: VIRTUAL_KEY[code],
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key, ...common });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await cdp.detach();
  // Запас на отложенную проверку расширения (setTimeout 0) и на его же
  // обработчики volumechange.
  await page.waitForTimeout(200);
}

const state = (page) =>
  page.evaluate(() => {
    const video = document.querySelector('#movie_player video');
    return {
      muted: video.muted,
      paused: video.paused,
      handled: window.__handled.slice(),
    };
  });

run('hotkeys: m и k на любой раскладке', async ({ browser, reporter, errors }) => {
  const { check, section } = reporter;

  async function open({ delay = 0, byCode = false, ...options } = {}) {
    const page = await openPage(browser, {
      errors,
      ...options,
      before: async (target) => {
        await target.evaluate(
          ([install, ms, code]) => {
            new Function('return ' + install)()(ms, code);
          },
          [installYouTubeHotkeys.toString(), delay, byCode]
        );
      },
    });
    // Ролик должен играть: пауза проверяется по фактическому состоянию.
    await page.evaluate(async () => {
      const video = document.querySelector('#movie_player video');
      video.loop = true;
      // Пустой поток проигрывать нечего, поэтому паузу эмулируем полем:
      // расширение и макет плеера смотрят на video.paused одинаково.
      Object.defineProperty(video, 'paused', {
        configurable: true,
        get() {
          return this.__paused !== false;
        },
      });
      video.play = function () {
        this.__paused = false;
        return Promise.resolve();
      };
      video.pause = function () {
        this.__paused = true;
      };
      video.__paused = false;
    });
    return page;
  }

  // --- 1. Латинская раскладка: YouTube справляется сам --------------------
  // Здесь важно не «работает», а «сработало ровно один раз»: если бы
  // расширение переключало безусловно, звук вернулся бы в исходное.
  section('латинская раскладка — вмешиваться не нужно');
  {
    const page = await open();
    await press(page, 'KeyM', 'latin');
    const afterMute = await state(page);
    check(
      'm выключает звук ровно один раз',
      afterMute.muted === true && afterMute.handled.join() === 'm',
      JSON.stringify(afterMute)
    );

    await press(page, 'KeyM', 'latin');
    const afterSecond = await state(page);
    check(
      'повторное m возвращает звук',
      afterSecond.muted === false,
      JSON.stringify(afterSecond)
    );

    await press(page, 'KeyK', 'latin');
    const afterPause = await state(page);
    check(
      'k ставит на паузу ровно один раз',
      afterPause.paused === true && afterPause.handled.join() === 'm,m,k',
      JSON.stringify(afterPause)
    );
    await page.close();
  }

  // --- 2. Кириллица: YouTube молчит, действуем мы -------------------------
  section('кириллица — YouTube клавишу не понимает');
  {
    const page = await open();
    await press(page, 'KeyM', 'cyrillic');
    const afterMute = await state(page);
    check(
      '«ь» на клавише m выключает звук',
      afterMute.muted === true,
      JSON.stringify(afterMute)
    );
    check(
      'сам YouTube при этом ничего не обработал',
      afterMute.handled.length === 0,
      JSON.stringify(afterMute.handled)
    );

    await press(page, 'KeyM', 'cyrillic');
    check(
      'повторное «ь» возвращает звук',
      (await state(page)).muted === false,
      JSON.stringify(await state(page))
    );

    await press(page, 'KeyK', 'cyrillic');
    const afterPause = await state(page);
    check(
      '«л» на клавише k ставит на паузу',
      afterPause.paused === true,
      JSON.stringify(afterPause)
    );

    await press(page, 'KeyK', 'cyrillic');
    check(
      'повторное «л» снимает с паузы',
      (await state(page)).paused === false,
      JSON.stringify(await state(page))
    );
    await page.close();
  }

  // --- 2b. Поздний обработчик YouTube -------------------------------------
  // Ровно то, что нашлось в поле. Первая версия решала отложенно: «если
  // через такт состояние не изменилось — переключаю сам». Стоит обработчику
  // YouTube ответить чуть позже — и он отменяет наше переключение: звук
  // глохнет и тут же возвращается, слышно как треск, а клавиша выглядит
  // нерабочей. Теперь на чужой раскладке событие забирается целиком.
  section('YouTube отвечает с задержкой');
  {
    const page = await open({ delay: 60, byCode: true });
    await press(page, 'KeyM', 'cyrillic');
    await page.waitForTimeout(300);
    const after = await state(page);
    check(
      'звук остался выключенным, а не вернулся',
      after.muted === true,
      JSON.stringify(after)
    );
    check(
      'до обработчика YouTube событие не дошло — переключения ровно одно',
      after.handled.length === 0,
      JSON.stringify(after.handled)
    );

    await press(page, 'KeyK', 'cyrillic');
    await page.waitForTimeout(300);
    const paused = await state(page);
    check(
      'пауза тоже не отменяется',
      paused.paused === true && paused.handled.length === 0,
      JSON.stringify(paused)
    );
    await page.close();
  }

  // --- 3. Поле ввода: клавиша — это буква ---------------------------------
  // Поиск, комментарий, форма: там «ь» должен остаться буквой.
  section('в поле ввода клавиша не команда');
  {
    const page = await open();
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'typing';
      document.body.appendChild(input);
      input.focus();
    });
    await press(page, 'KeyM', 'cyrillic');
    await press(page, 'KeyK', 'cyrillic');
    const after = await state(page);
    check(
      'звук и воспроизведение не тронуты',
      after.muted === false && after.paused === false,
      JSON.stringify(after)
    );
    await page.close();
  }

  // --- 4. Состояние сохраняется и с кириллицы -----------------------------
  // Запись требует настоящего события и подтверждения значения в bridge.js,
  // поэтому проверяется отдельно: путь у клавиши другой, чем у кнопки.
  section('запись состояния');
  {
    const page = await open({ withBridge: true });
    await page.evaluate(() => (window.__writes.length = 0));
    await press(page, 'KeyM', 'cyrillic');
    await page.waitForTimeout(700);
    const writes = await page.evaluate(() => window.__writes.slice());
    check(
      'выключение звука с кириллицы сохраняется',
      writes.some((write) => write.savedMuted === true),
      JSON.stringify(writes)
    );
    await page.close();
  }
});
