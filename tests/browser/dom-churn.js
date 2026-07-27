'use strict';

// Перестройка DOM за спиной расширения.
//
// YouTube — SPA: он выкидывает и пересоздаёт <video>, строку управления и
// целые куски плеера без единого события навигации. Раньше это подбирал опрос
// раз в секунду, теперь — MutationObserver. Разница снаружи не видна, поэтому
// нужен харнесс, который бьёт по DOM ровно так же, как это делает YouTube, и
// требует восстановления без всяких «подождём секунду».
//
// Проверка обязана падать, если наблюдатель отключить: без него ни одно из
// восстановлений ниже не произойдёт вовсе.

const { openPage, run, videoVolume, waitFor } = require('./harness');

// videoVolume читает громкость через перехватчик, то есть логический уровень.
// В state харнесса сохранено 0.5 — его и должен получить любой новый элемент.
const EXPECTED = 0.5;

run('dom-churn: восстановление после перестройки страницы', async ({
  browser,
  reporter,
  errors,
}) => {
  const { check } = reporter;

  const hasBox = (page) =>
    page.evaluate(() => document.querySelectorAll('.ytev-box').length);

  // --- 1. YouTube снёс наш блок вместе со строкой управления -------------
  {
    const page = await openPage(browser, { errors });
    check('блок построен изначально', (await hasBox(page)) === 1);

    await page.evaluate(() => {
      // Именно так это выглядит в бою: перерисовывается весь низ плеера.
      const controls = document.querySelector('.ytp-chrome-controls');
      const fresh = controls.cloneNode(true);
      for (const stale of fresh.querySelectorAll('.ytev-box')) stale.remove();
      controls.replaceWith(fresh);
    });

    let restored = true;
    try {
      await waitFor(async () => (await hasBox(page)) === 1, {
        timeout: 4000,
        what: 'пересборки блока',
      });
    } catch {
      restored = false;
    }
    check(
      'блок пересобран после замены строки управления',
      restored,
      `блоков на странице: ${await hasBox(page)}`
    );
    await page.close();
  }

  // --- 2. YouTube заменил сам <video> ------------------------------------
  // Так ведёт себя лента Shorts: каждый ролик приходит со своим элементом.
  // Новый элемент обязан получить сохранённую громкость, иначе ролик
  // заиграет на уровне YouTube.
  {
    const page = await openPage(browser, { errors });
    check('исходная громкость применена', (await videoVolume(page)) === EXPECTED);

    const startedAt = await page.evaluate(() => {
      const old = document.querySelector('video');
      const fresh = document.createElement('video');
      fresh.style.cssText = 'width:100%;height:120px;display:block';
      old.replaceWith(fresh);
      return fresh.volume; // новый элемент приходит с единицей
    });
    check(
      'новый элемент действительно приходит с чужим уровнем',
      startedAt === 1,
      `у нового <video> ${startedAt}`
    );

    let applied = true;
    try {
      await waitFor(async () => (await videoVolume(page)) === EXPECTED, {
        timeout: 4000,
        what: 'применения громкости к новому элементу',
      });
    } catch {
      applied = false;
    }
    check(
      'новый <video> получил сохранённую громкость',
      applied,
      `фактическая=${await videoVolume(page)} против ${EXPECTED}`
    );
    await page.close();
  }

  // --- 2b. Плеер отдаёт объект с бросающим геттером -----------------------
  // getPlayerResponse() возвращает объект страницы: и вызов, и чтение его
  // свойств могут бросить. bindVideo() читает уровень ДО восстановления
  // сохранённой громкости, поэтому исключение оттуда оставило бы новый
  // <video> с громкостью YouTube и без наших слушателей.
  {
    const page = await openPage(browser, {
      // Разбор ответа плеера исполняется только при включённом выравнивании.
      withMain: { normalizeLoudness: true },
      errors,
      before: async (target) => {
        await target.evaluate(() => {
          const player = document.getElementById('movie_player');
          player.getVideoData = () => ({ video_id: 'hostile' });
          player.getDrcState = () => 1;
          player.getPlayerResponse = () => ({
            get videoDetails() {
              throw new Error('видеодетали недоступны');
            },
          });
          // Строка Shorts тоже может огрызнуться на чтение служебных полей.
          const controls = document.createElement('ytd-shorts-player-controls');
          Object.defineProperty(controls, 'polymerController', {
            get() {
              throw new Error('контроллер недоступен');
            },
          });
          document.body.appendChild(controls);
        });
      },
    });

    check(
      'блок построен, несмотря на бросающие геттеры',
      (await hasBox(page)) === 1,
      `блоков: ${await hasBox(page)}`
    );

    await page.evaluate(() => {
      const old = document.querySelector('video');
      const fresh = document.createElement('video');
      fresh.style.cssText = 'width:100%;height:120px;display:block';
      old.replaceWith(fresh);
    });
    let applied = true;
    try {
      await waitFor(async () => (await videoVolume(page)) === EXPECTED, {
        timeout: 4000,
        what: 'применения громкости при бросающем ответе плеера',
      });
    } catch {
      applied = false;
    }
    check(
      'громкость всё равно применяется к новому <video>',
      applied,
      `фактическая=${await videoVolume(page)} против ${EXPECTED}`
    );
    await page.close();
  }

  // --- 3. Плеер появился позже расширения --------------------------------
  // Холодный старт на медленном канале: main.js уже работает, а плеера ещё
  // нет. Никакого события об этом не приходит — только мутация DOM.
  {
    const page = await openPage(browser, {
      errors,
      before: async (target) => {
        await target.evaluate(() => {
          const player = document.getElementById('movie_player');
          window.__player = player;
          player.remove();
        });
      },
    });
    check('без плеера блок не строится', (await hasBox(page)) === 0);

    await page.evaluate(() => document.body.appendChild(window.__player));

    let mounted = true;
    try {
      await waitFor(async () => (await hasBox(page)) === 1, {
        timeout: 4000,
        what: 'монтирования после появления плеера',
      });
    } catch {
      mounted = false;
    }
    check(
      'блок построен, как только плеер появился',
      mounted,
      `блоков на странице: ${await hasBox(page)}`
    );
    await page.close();
  }
});
