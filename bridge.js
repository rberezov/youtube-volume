// Isolated world: запускает main.js через service worker и принимает только
// запросы на сохранение, подтверждённые доверенным действием пользователя.
(() => {
  'use strict';

  const PAGE_ORIGIN = location.origin;
  const WRITE_INTERVAL_MS = 250;
  const INTENT_WINDOW_MS = 2000;
  const randomHex = (byteLength) =>
    Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('');
  // Тот же набор, что и в main.js: условия «жест над плеером» должны
  // совпадать в обоих мирах, иначе один считает действие осознанным, а
  // второй отказывается его сохранять.
  const PLAYER_SELECTOR = '#movie_player, .html5-video-player, ytd-reel-video-renderer';
  const activeChannel = randomHex(16);
  const updateSecret = randomHex(32);
  let volumeIntentUntil = 0;
  let mutedIntentUntil = 0;
  let volumeIntentBudget = 0;
  let mutedIntentBudget = 0;
  let expectedVolume;
  let expectedVolumeTolerance = 0;
  let expectedMuted;
  let pendingWrite = {};
  let writeTimer = 0;
  let lastWriteAt = 0;

  // Ползунок расширения даёт то же самое число, что уйдёт в сообщении, а
  // штатная панель YouTube показывает целые проценты — оттуда значение
  // приходит огрублённым, и точное сравнение отвергало бы честные записи.
  const EXACT_TOLERANCE = 1e-6;
  const ARIA_TOLERANCE = 0.015;

  function grantVolumeIntent(duration = INTENT_WINDOW_MS, expected, tolerance = EXACT_TOLERANCE) {
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
    expectedVolume = expected;
    expectedVolumeTolerance = tolerance;
  }

  function grantMutedIntent(duration = INTENT_WINDOW_MS, expected) {
    mutedIntentUntil = Date.now() + duration;
    mutedIntentBudget = 1;
    expectedMuted = expected;
  }

  // Кастомный ползунок меняет сразу два независимых состояния:
  // громкость и, при значении выше нуля, mute. Оба последующих сообщения
  // main.js должны быть авторизованы одним и тем же жестом пользователя.
  function grantSliderIntent(
    duration = INTENT_WINDOW_MS,
    expectedVolumeValue,
    expectedMutedValue
  ) {
    grantVolumeIntent(duration, expectedVolumeValue);
    grantMutedIntent(duration, expectedMutedValue);
  }

  // Ожидаемое значение обязательно. Раньше при expectedVolume === undefined
  // окно пропускало любое число: страница видит канал (main.js сам
  // публикует его в postMessage) и внутри честного окна — например, пока
  // пользователь жмёт стрелку над плеером — успевала записать своё
  // значение, заодно съедая единственный бюджет и вытесняя настоящую
  // запись. Нет подтверждённого значения — нет и записи.
  function consumeVolumeIntent(value) {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return false;
    if (expectedVolume === undefined) return false;
    if (Math.abs(value - expectedVolume) > expectedVolumeTolerance) return false;
    volumeIntentBudget -= 1;
    expectedVolume = undefined;
    return true;
  }

  function consumeMutedIntent(value) {
    if (Date.now() > mutedIntentUntil || mutedIntentBudget < 1) return false;
    if (expectedMuted !== undefined && value !== expectedMuted) return false;
    mutedIntentBudget -= 1;
    expectedMuted = undefined;
    return true;
  }

  function isEditable(target) {
    const tag = String(target && target.tagName).toUpperCase();
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      !!(target && target.isContentEditable)
    );
  }

  function matches(target, selector) {
    return !!(target && typeof target.matches === 'function' && target.matches(selector));
  }

  function closest(target, selector) {
    return target && typeof target.closest === 'function'
      ? target.closest(selector)
      : null;
  }

  function activeVideo() {
    if (typeof document === 'undefined') return null;
    const selectors = [
      'ytd-reel-video-renderer[is-active] video',
      '#shorts-player video',
      '#movie_player video',
    ];
    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video) return video;
    }
    return document.querySelector('video');
  }

  // Логический уровень глазами изолированного мира. Прочитать video.volume
  // здесь нельзя: подменённый геттер живёт в MAIN-мире, а сам элемент при
  // включённом Web Audio держится на максимуме — уровень задаёт усилитель.
  // Зато видно то же, что и пользователю: положение нашего ползунка либо
  // проценты на штатной панели YouTube.
  function logicalPercentFromDom() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const sliders = document.querySelectorAll('.ytev-slider');
    // Больше одного — на странице подделка: свой ползунок ровно один.
    // Тогда честного источника нет и записи не будет.
    if (sliders.length > 1) return null;
    if (sliders.length === 1) {
      const slider = sliders[0];
      const pct = Number(slider.value);
      if (closest(slider, '.ytev-box') && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return { pct, tolerance: EXACT_TOLERANCE };
      }
      return null;
    }
    const panel = document.querySelector('.ytp-volume-panel[aria-valuenow]');
    if (panel) {
      const pct = Number(panel.getAttribute('aria-valuenow'));
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return { pct, tolerance: ARIA_TOLERANCE };
      }
    }
    return null;
  }

  // Для стрелок, колеса и штатной панели предсказать результат жеста
  // заранее нельзя: шаг задаёт YouTube. Поэтому берём пробу уже после
  // того, как громкость применилась, — на volumechange (он приходит и в
  // изолированный мир) плюс страховочная проба по таймеру. main.js шлёт
  // своё сообщение через 250мс дебаунса, то есть заведомо позже.
  function grantVolumeFromDom(duration = INTENT_WINDOW_MS) {
    const sample = () => {
      const observed = logicalPercentFromDom();
      if (!observed) return;
      grantVolumeIntent(duration, observed.pct / 100, observed.tolerance);
    };
    const video = activeVideo();
    if (video && typeof video.addEventListener === 'function') {
      const onChange = () => setTimeout(sample, 0);
      video.addEventListener('volumechange', onChange);
      setTimeout(() => video.removeEventListener('volumechange', onChange), 400);
    }
    setTimeout(sample, 120);
  }

  function expectedMuteAfterToggle(target) {
    const video = activeVideo();
    if (!video) return undefined;
    const box = closest(target, '.ytev-box');
    const slider =
      box && typeof box.querySelector === 'function'
        ? box.querySelector('.ytev-slider')
        : null;
    const sliderValue = Number(slider && slider.value);
    const zeroVolume =
      slider && Number.isFinite(sliderValue)
        ? sliderValue === 0
        : Number(video.volume) === 0;
    return video.muted || zeroVolume ? false : true;
  }

  function grantSliderValue(slider, duration = INTENT_WINDOW_MS) {
    const pct = Number(slider && slider.value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    const video = activeVideo();
    const muted = pct > 0 ? false : video ? !!video.muted : undefined;
    grantSliderIntent(duration, pct / 100, muted);
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const muteControl = closest(e.target, '.ytp-mute-button, .ytev-mute');
      if (
        !e.repeat &&
        muteControl &&
        (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')
      ) {
        grantMutedIntent(INTENT_WINDOW_MS, expectedMuteAfterToggle(e.target));
        grantVolumeFromDom(); // на нулевом уровне кнопка ещё и вернёт громкость
      }
      if (isEditable(e.target)) {
        // Для range браузер сам отправит trusted input уже с новым значением.
        // До него не открываем окно записи с неизвестным результатом.
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (closest(e.target, PLAYER_SELECTOR)) {
          grantVolumeFromDom();
        }
      } else if (!e.repeat && String(e.key).toLowerCase() === 'm') {
        const video = activeVideo();
        grantMutedIntent(INTENT_WINDOW_MS, video ? !video.muted : undefined);
      }
    },
    true
  );

  window.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && matches(e.target, '.ytev-slider')) {
        grantSliderValue(e.target);
      }
    },
    true
  );

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.isTrusted) return;
      const box = closest(e.target, '.ytev-box');
      if (box && typeof box.querySelector === 'function') {
        const slider = box.querySelector('.ytev-slider');
        const current = Number(slider && slider.value);
        if (slider && Number.isFinite(current)) {
          const step = e.shiftKey ? 0.1 : 1;
          const next = Math.min(
            100,
            Math.max(0, current + (e.deltaY < 0 ? step : -step))
          );
          const video = activeVideo();
          grantSliderIntent(
            INTENT_WINDOW_MS,
            next / 100,
            next > 0 ? false : video ? !!video.muted : undefined
          );
        }
      } else if (closest(e.target, PLAYER_SELECTOR)) {
        grantVolumeFromDom();
      }
    },
    true
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      if (closest(e.target, '.ytp-mute-button, .ytev-mute')) {
        grantMutedIntent(INTENT_WINDOW_MS, expectedMuteAfterToggle(e.target));
        grantVolumeFromDom(); // на нулевом уровне кнопка ещё и вернёт громкость
      }
      if (
        !closest(e.target, '.ytev-slider') &&
        closest(e.target, '.ytp-volume-area, .ytp-volume-panel')
      ) {
        grantVolumeFromDom();
      }
    },
    true
  );

  // Click покрывает мышь и вспомогательные технологии; Enter/Space
  // дополнительно авторизуются выше по trusted keydown, не полагаясь на
  // то, как конкретный браузер пометит порождённый клавиатурой click.
  window.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && closest(e.target, '.ytp-mute-button, .ytev-mute')) {
        grantMutedIntent(INTENT_WINDOW_MS, expectedMuteAfterToggle(e.target));
        grantVolumeFromDom(); // на нулевом уровне кнопка ещё и вернёт громкость
      }
    },
    true
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!e.isTrusted || !(e.buttons & 1)) return;
      if (
        !closest(e.target, '.ytev-slider') &&
        closest(e.target, '.ytp-volume-area, .ytp-volume-panel')
      ) {
        grantVolumeFromDom();
      }
    },
    true
  );

  // После обновления/перезагрузки расширения старый мост на уже открытой
  // странице остаётся жить, но его chrome.* уже недействительны — любой
  // вызов бросает «Extension context invalidated». Проверяем перед
  // обращением, иначе ошибка сыпалась бы на каждый запрос настроек.
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  function sendRuntime(type) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(
        { type, channel: activeChannel, secret: updateSecret },
        () => void chrome.runtime.lastError
      );
    } catch {}
  }

  function flushWrite() {
    writeTimer = 0;
    if (!alive() || !Object.keys(pendingWrite).length) return;
    const value = pendingWrite;
    pendingWrite = {};
    lastWriteAt = Date.now();
    try {
      chrome.storage.local.set(value, () => void chrome.runtime.lastError);
    } catch {}
  }

  function queueWrite(value) {
    Object.assign(pendingWrite, value);
    clearTimeout(writeTimer);
    const delay = Math.max(0, WRITE_INTERVAL_MS - (Date.now() - lastWriteAt));
    writeTimer = setTimeout(flushWrite, delay);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== PAGE_ORIGIN || !e.data) return;
    if (e.data.channel !== activeChannel) return;
    if (e.data.type === 'YTEV_SAVE_VOLUME') {
      const volume = Number(e.data.volume);
      if (
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 1 ||
        !consumeVolumeIntent(volume)
      ) {
        return;
      }
      queueWrite({ savedVolume: volume });
      return;
    }
    if (e.data.type === 'YTEV_SAVE_MUTED') {
      if (
        typeof e.data.muted !== 'boolean' ||
        !consumeMutedIntent(e.data.muted)
      ) {
        return;
      }
      queueWrite({ savedMuted: e.data.muted });
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') sendRuntime('YTEV_UPDATE_SETTINGS');
    });
  } catch {}

  sendRuntime('YTEV_INIT');
})();
