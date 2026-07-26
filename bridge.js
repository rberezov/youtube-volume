// Isolated world: запускает main.js через service worker и принимает только
// запросы на сохранение, подтверждённые доверенным действием пользователя.
(() => {
  'use strict';

  const PAGE_ORIGIN = location.origin;
  const WRITE_INTERVAL_MS = 250;
  const INTENT_WINDOW_MS = 2000;
  const EARLY_HIDE_STYLE_ID = 'ytev-early-native-volume-style';
  const EARLY_HIDE_CLASS = 'ytev-native-volume-hidden';
  const EARLY_HIDE_MANAGED_CLASS = 'ytev-native-volume-managed';
  const EARLY_HIDE_CSS = `
    .${EARLY_HIDE_CLASS} .ytp-volume-area,
    .${EARLY_HIDE_CLASS} .ytp-volume-panel,
    .${EARLY_HIDE_CLASS} .ytp-mute-button,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer volume-controls,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer .ytdVolumeControlsHost,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls volume-controls,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls .ytdVolumeControlsHost {
      visibility: hidden !important;
    }
  `;
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

  // Читаем только один безопасный UI-флаг прямо из chrome.storage: для этого
  // не нужно будить service worker. На document_start правило успевает встать
  // до того, как YouTube создаст штатные контролы. Через 8 секунд оно само
  // отпускается, если основной код не принял управление.
  let earlyHideFailSafe = 0;
  function setEarlyNativeHidden(hidden) {
    const root = document.documentElement;
    if (!root || !root.classList) return;
    if (hidden) {
      let style =
        typeof document.getElementById === 'function'
          ? document.getElementById(EARLY_HIDE_STYLE_ID)
          : null;
      if (!style && typeof document.createElement === 'function') {
        style = document.createElement('style');
        style.id = EARLY_HIDE_STYLE_ID;
        style.textContent = EARLY_HIDE_CSS;
        root.appendChild(style);
      }
      root.classList.add(EARLY_HIDE_CLASS);
      clearTimeout(earlyHideFailSafe);
      earlyHideFailSafe = setTimeout(() => {
        if (!root.classList.contains(EARLY_HIDE_MANAGED_CLASS)) {
          root.classList.remove(EARLY_HIDE_CLASS);
        }
      }, 8000);
      return;
    }
    clearTimeout(earlyHideFailSafe);
    root.classList.remove(EARLY_HIDE_CLASS);
  }

  try {
    chrome.storage.sync.get({ useNativeSlider: false }, (settings) => {
      setEarlyNativeHidden(settings.useNativeSlider === false);
    });
  } catch {}

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
    if (typeof expected !== 'boolean') {
      mutedIntentBudget = 0;
      expectedMuted = undefined;
      return;
    }
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
    if (typeof expectedMuted !== 'boolean' || value !== expectedMuted) return false;
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

  const isShorts = () =>
    typeof location === 'object' &&
    String(location.pathname || '').startsWith('/shorts/');
  const mediaSource = (video) =>
    video ? String(video.currentSrc || video.src || '') : '';
  function activeReel() {
    return (
      document.querySelector('ytd-reel-video-renderer[is-active]') ||
      document.querySelector(
        '#reel-overlay-container ytd-reel-video-renderer'
      ) ||
      document.querySelector('ytd-reel-video-renderer')
    );
  }
  const nativeVolumeControl = (target) => {
    const classic = closest(target, '.ytp-volume-area, .ytp-volume-panel');
    if (classic) return classic;
    const shorts = closest(target, 'volume-controls, .ytdVolumeControlsHost');
    if (!shorts) return null;
    const reel = closest(shorts, 'ytd-reel-video-renderer');
    const active = activeReel();
    if (active) return reel === active ? shorts : null;
    return reel && !reel.hidden ? shorts : null;
  };

  function shortsNativeSliderFromDom() {
    if (
      typeof document === 'undefined' ||
      typeof document.querySelectorAll !== 'function'
    ) {
      return null;
    }
    const reel = activeReel();
    if (!reel || typeof reel.querySelectorAll !== 'function') return null;
    const sliders = reel.querySelectorAll(
      'volume-controls input#volume-input'
    );
    return sliders.length === 1 ? sliders[0] : null;
  }

  // Логический уровень глазами изолированного мира. Прочитать video.volume
  // здесь нельзя: подменённый геттер живёт в MAIN-мире, а сам элемент при
  // включённом Web Audio держится на максимуме — уровень задаёт усилитель.
  // Зато видно то же, что и пользователю: положение нашего ползунка либо
  // проценты на штатной панели YouTube.
  function extensionSliderFromDom() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const sliders = document.querySelectorAll('.ytev-slider');
    // Больше одного — на странице подделка: свой ползунок ровно один.
    // Тогда честного источника нет и записи не будет.
    if (sliders.length !== 1) return null;
    const slider = sliders[0];
    return closest(slider, '.ytev-box') ? slider : null;
  }

  function logicalPercentFromDom() {
    if (typeof document === 'undefined') return null;
    const slider = extensionSliderFromDom();
    if (slider) {
      const pct = Number(slider.value);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return { pct, tolerance: EXACT_TOLERANCE };
      }
      return null;
    }
    // Если элементы с нашим классом есть, но источник неоднозначен или
    // лежит вне нашего блока, к штатной панели не откатываемся: это
    // выглядит как подмена DOM со стороны страницы.
    if (
      typeof document.querySelectorAll === 'function' &&
      document.querySelectorAll('.ytev-slider').length
    ) {
      return null;
    }
    const shortsSlider = shortsNativeSliderFromDom();
    if (shortsSlider) {
      const pct = Number(shortsSlider.value);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return { pct, tolerance: EXACT_TOLERANCE };
      }
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
  let sampleSource = null;
  function grantVolumeFromDom(duration = INTENT_WINDOW_MS) {
    const video = activeVideo();
    const sourceAtIntent = mediaSource(video);
    const sample = () => {
      const currentVideo = activeVideo();
      const currentSource = mediaSource(currentVideo);
      if (
        video &&
        (currentVideo !== video ||
          (sourceAtIntent && currentSource && sourceAtIntent !== currentSource))
      ) {
        return;
      }
      const observed = logicalPercentFromDom();
      if (!observed) return;
      grantVolumeIntent(duration, observed.pct / 100, observed.tolerance);
    };
    // Протяжка по штатной панели шлёт pointermove десятками в секунду, и
    // без этой проверки на элементе одновременно жило бы столько же
    // одинаковых слушателей. Хватает одного: каждая проба всё равно
    // переоткрывает окно с новым значением.
    if (video && typeof video.addEventListener === 'function' && sampleSource !== video) {
      const onChange = () => setTimeout(sample, 0);
      sampleSource = video;
      video.addEventListener('volumechange', onChange);
      setTimeout(() => {
        video.removeEventListener('volumechange', onChange);
        if (sampleSource === video) sampleSource = null;
      }, 400);
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
        if (
          (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          nativeVolumeControl(e.target)
        ) {
          grantVolumeFromDom(5000);
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!isShorts() && closest(e.target, PLAYER_SELECTOR)) {
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
      if (!e.isTrusted) return;
      if (matches(e.target, '.ytev-slider')) {
        const slider = extensionSliderFromDom();
        if (slider && e.target === slider) grantSliderValue(slider);
        return;
      }
      const nativeSlider = shortsNativeSliderFromDom();
      if (nativeSlider && e.target === nativeSlider) {
        const pct = Number(nativeSlider.value);
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          const video = activeVideo();
          grantSliderIntent(
            5000,
            pct / 100,
            pct > 0 ? false : video ? !!video.muted : undefined
          );
        }
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
      } else if (nativeVolumeControl(e.target)) {
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
        nativeVolumeControl(e.target)
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
        nativeVolumeControl(e.target)
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
      if (area !== 'sync') return;
      if (
        changes.useNativeSlider &&
        typeof changes.useNativeSlider.newValue === 'boolean'
      ) {
        setEarlyNativeHidden(changes.useNativeSlider.newValue === false);
      }
      sendRuntime('YTEV_UPDATE_SETTINGS');
    });
  } catch {}

  sendRuntime('YTEV_INIT');
})();
