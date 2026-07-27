// Запускается service worker через chrome.scripting.executeScript в MAIN-мире:
// перехватывает установку громкости у HTMLMediaElement, применяет
// экспоненциальную кривую и добавляет точный ползунок.
function youtubeVolumeMain(initialPayload, updateSecret) {
  'use strict';

  const PAGE_ORIGIN = location.origin;
  const CHANNEL_PATTERN = /^[a-f0-9]{32}$/;
  const SECRET_PATTERN = /^[a-f0-9]{64}$/;
  const CHANNEL_ID =
    initialPayload && typeof initialPayload.channel === 'string'
      ? initialPayload.channel
      : '';
  if (!CHANNEL_PATTERN.test(CHANNEL_ID) || !SECRET_PATTERN.test(updateSecret)) {
    return false;
  }
  const INSTANCE_KEY = Symbol.for('ytev.main.instance.v2');
  // Смена поколений. Ключ глобального реестра символов угадывается тривиально,
  // поэтому «занят — значит уходим» означало бы, что страница выключает
  // расширение одной строкой. Опознаём именно свой экземпляр и различаем два
  // случая: тот же документ (bridge жив, канал совпадает — второй раз
  // разворачиваться не нужно) и старое поколение после перезагрузки
  // расширения (канал другой: секрет и канал прошлого bridge уже мертвы, и
  // без передачи управления настройки из popup до страницы не доходили).
  // Гасим предшественника ДО захвата дескрипторов ниже: его dispose()
  // возвращает нативные volume/muted, и порядок наоборот стёр бы наш патч.
  const previous = window[INSTANCE_KEY];
  const isOurs =
    previous &&
    typeof previous === 'object' &&
    previous.version === 2 &&
    typeof previous.dispose === 'function' &&
    typeof previous.channel === 'string';
  if (isOurs && previous.channel === CHANNEL_ID) return false;
  if (isOurs) {
    try {
      previous.dispose();
    } catch {}
  }

  // preload.js уже стоит в MAIN-мире с document_start и удерживает
  // сохранённый уровень, пока service worker читает chrome.storage.
  // Снимаем его синхронный перехват до захвата нативных дескрипторов:
  // дальше полный экземпляр отвечает и за кривую, и за состояние.
  // Форму объекта подделать нетрудно, поэтому из ответа берём ровно два
  // поля и только в допустимом виде — ни одно постороннее свойство внутрь
  // не проходит. Сам слот реестра preload занимает первым делом, ещё до
  // своих ранних выходов, так что чужому объекту там взяться неоткуда.
  const preload = window[Symbol.for('ytev.preload.instance.v1')];
  let preloadState = null;
  if (
    preload &&
    preload.version === 1 &&
    typeof preload.takeover === 'function'
  ) {
    try {
      const state = preload.takeover();
      const heldVolume = Number(state && state.volume);
      if (
        state &&
        typeof state === 'object' &&
        state.volumeDirty === true &&
        Number.isFinite(heldVolume) &&
        heldVolume >= 0 &&
        heldVolume <= 1
      ) {
        preloadState = { volume: heldVolume, volumeDirty: true };
      }
    } catch {}
  }

  // Снятие всего, что экземпляр развесил на window/document. Нужно для
  // dispose(): без этого старое поколение продолжало бы жить слушателями.
  const teardown = [];
  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    teardown.push(() => target.removeEventListener(type, handler, options));
  }

  const SETTINGS = {
    enabled: true,          // применять экспоненциальную кривую
    gamma: 3,               // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderScale: 7,         // длина ползунка в % от ширины плеера
    shortsScale: 11,        // то же для Shorts — плеер узкий, размер свой
    showPercent: true,      // подпись с процентами рядом с ползунком
    autoCollapse: true,     // сворачивать шкалу, когда курсор не на ней
    useNativeSlider: false, // не строить свою шкалу — оставить штатную
    normalizeLoudness: false, // подтягивать тихие ролики к общему уровню
  };
  const EARLY_HIDE_CLASS = 'ytev-native-volume-hidden';
  const EARLY_HIDE_MANAGED_CLASS = 'ytev-native-volume-managed';
  let earlyHideSafetyTimer = 0;

  function setEarlyNativeHidden(hidden, settled = false) {
    const root = document.documentElement;
    if (!root || !root.classList) return;
    root.classList.add(EARLY_HIDE_MANAGED_CLASS);
    root.classList.toggle(EARLY_HIDE_CLASS, hidden);
    clearTimeout(earlyHideSafetyTimer);
    if (hidden && !settled) {
      // Если YouTube изменил DOM и наша шкала не смогла смонтироваться,
      // штатное управление должно вернуться автоматически.
      earlyHideSafetyTimer = setTimeout(() => {
        if (!document.querySelector('.ytev-box')) {
          root.classList.remove(EARLY_HIDE_CLASS);
        }
      }, 8000);
    }
  }

  // Подписи приходят готовыми из service worker: chrome.i18n в MAIN-мире нет.
  // Значения по умолчанию русские и остаются на случай неполного payload —
  // пустая подпись у кнопки хуже непереведённой.
  const STRINGS = {
    playerSliderLabel: 'Громкость',
    playerUnmute: 'Включить звук',
    playerMute: 'Отключить звук',
  };

  function applyStrings(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(STRINGS)) {
      if (typeof value[key] === 'string' && value[key]) STRINGS[key] = value[key];
    }
  }

  function applySettings(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of [
      'enabled',
      'showPercent',
      'autoCollapse',
      'useNativeSlider',
      'normalizeLoudness',
    ]) {
      if (typeof value[key] === 'boolean') SETTINGS[key] = value[key];
    }
    const gamma = Number(value.gamma);
    const sliderScale = Number(value.sliderScale);
    const shortsScale = Number(value.shortsScale);
    if (Number.isFinite(gamma)) SETTINGS.gamma = Math.min(6, Math.max(1, gamma));
    if (Number.isFinite(sliderScale)) {
      SETTINGS.sliderScale = Math.min(70, Math.max(2, sliderScale));
    }
    if (Number.isFinite(shortsScale)) {
      SETTINGS.shortsScale = Math.min(70, Math.max(2, shortsScale));
    }
    setEarlyNativeHidden(!SETTINGS.useNativeSlider);
  }

  /* ------------------------------------------------------------------ *
   * 1. Экспоненциальная кривая громкости
   *
   * YouTube выставляет video.volume линейно (позиция ползунка / 100),
   * но восприятие громкости логарифмическое, поэтому внизу шкалы шаги
   * слишком грубые. Подменяем сеттер volume: сохраняем «логическое»
   * значение (то, что видит YouTube) и отдаём в аудиотракт value^gamma.
   * Геттер возвращает логическое значение, так что для YouTube ничего
   * не меняется.
   * ------------------------------------------------------------------ */

  const mediaProto = HTMLMediaElement.prototype;
  const nativeDesc = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const nativeMutedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'muted');
  if (
    !nativeDesc ||
    typeof nativeDesc.get !== 'function' ||
    typeof nativeDesc.set !== 'function' ||
    !nativeMutedDesc ||
    typeof nativeMutedDesc.get !== 'function' ||
    typeof nativeMutedDesc.set !== 'function'
  ) {
    return false;
  }
  const logicalVolume = new WeakMap();

  const toReal = (v) => (SETTINGS.enabled ? Math.pow(v, SETTINGS.gamma) : v);

  Object.defineProperty(mediaProto, 'volume', {
    configurable: true,
    enumerable: nativeDesc.enumerable,
    get() {
      return logicalVolume.has(this)
        ? logicalVolume.get(this)
        : nativeDesc.get.call(this);
    },
    set(value) {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        // нативный сеттер сам бросит корректную ошибку
        nativeDesc.set.call(this, value);
        return;
      }
      const prev = logicalVolume.get(this);
      logicalVolume.set(this, v);
      applyReal(this, toReal(v));
      // Когда уровень задаёт усилитель Web Audio, громкость самого
      // элемента не меняется — и браузер не шлёт volumechange. Без него
      // замер бы весь интерфейс: проценты, заливка шкалы, значок, да и
      // собственные подсказки YouTube. Шлём событие сами; условие
      // «значение изменилось» исключает зацикливание, если обработчик
      // в ответ запишет ту же громкость.
      if (prev !== v && audio.nodes.has(this)) {
        this.dispatchEvent(new Event('volumechange'));
      }
    },
  });

  Object.defineProperty(mediaProto, 'muted', {
    configurable: true,
    enumerable: nativeMutedDesc.enumerable,
    get() {
      return nativeMutedDesc.get.call(this);
    },
    set(value) {
      const requested = !!value;
      // Shorts при запуске успевает выставить autoplay-mute до события
      // playing; подавляем эту запись прямо в сеттере, без одного кадра
      // с неправильным значком. Кнопка и клавиша M заранее обновляют
      // preferredMuted, поэтому осознанное действие пользователя проходит.
      //
      // Окно узкое намеренно. Раньше сеттер держал preferredMuted вечно и
      // для любого направления: тогда video.muted = true не срабатывал
      // никогда, включая честный muted-autoplay, а без него браузер
      // отклоняет play() и ролик не стартует сам. Поэтому подавляем только
      // включение mute, только пока пользователь осознанно держит звук,
      // только первые секунды жизни элемента и только если у документа уже
      // есть пользовательская активация — без неё незаглушённое
      // воспроизведение невозможно в принципе и мешать браузеру нельзя.
      // Обратное направление (снятие mute при preferredMuted === true)
      // сеттер не трогает: его доводит onVolumeChange через
      // restorePreferredState, на кадр позже, но без риска для автозапуска.
      const suppress =
        requested &&
        !SETTINGS.useNativeSlider &&
        preferredMuted === false &&
        Date.now() < mutedGuardUntil &&
        hasUserActivation() &&
        this === getVideo();
      nativeMutedDesc.set.call(this, suppress ? false : requested);
    },
  });

  const logicalOf = (el) =>
    logicalVolume.has(el) ? logicalVolume.get(el) : nativeDesc.get.call(el);

  /* ------------------------------------------------------------------ *
   * 1a. Единая громкость для всех плееров YouTube
   *
   * Shorts и обычная страница используют разные <video>, а внутри ленты
   * YouTube может переиспользовать элемент с новым media source. WeakMap
   * выше намеренно хранит значение отдельно для каждого элемента, поэтому
   * без общего уровня новый плеер возвращался к громкости YouTube.
   * ------------------------------------------------------------------ */

  const VOLUME_EPSILON = 0.0005;
  let preferredVolume = null;
  let preferredMuted = null;
  let volumeStateLoaded = false;
  let preferredVolumeDirty = false;
  let preferredMutedDirty = false;
  let saveVolumeTimer = 0;
  let saveMutedTimer = 0;
  // Последний ненулевой уровень: кнопка «включить звук» на нуле возвращает
  // именно его — как штатная кнопка YouTube. Без этого клик снимал mute,
  // оставлял нулевую громкость и выглядел как мёртвая кнопка.
  let lastAudibleVolume = 0.5;
  // Окно подавления autoplay-mute, переоткрывается на каждый новый <video>
  const MUTED_GUARD_MS = 3000;
  let mutedGuardUntil = 0;
  const hasUserActivation = () =>
    typeof navigator === 'object' &&
    !!navigator &&
    !!navigator.userActivation &&
    navigator.userActivation.hasBeenActive === true;
  const STATE_CACHE_KEY = 'ytev-volume-state-v1';
  const validVolume = (value) =>
    Number.isFinite(value) && value >= 0 && value <= 1;
  const rememberAudible = (volume) => {
    if (validVolume(volume) && volume > 0) lastAudibleVolume = volume;
  };

  function cachePreferredState() {
    try {
      localStorage.setItem(
        STATE_CACHE_KEY,
        JSON.stringify({
          volume: validVolume(preferredVolume) ? preferredVolume : null,
          muted: typeof preferredMuted === 'boolean' ? preferredMuted : null,
          enabled: SETTINGS.enabled,
          gamma: SETTINGS.gamma,
          useNativeSlider: SETTINGS.useNativeSlider,
        })
      );
    } catch {}
  }

  // Синхронный кэш нужен только для самого первого кадра новой страницы.
  // chrome.storage остаётся источником истины и перезапишет кэш, когда
  // bridge пришлёт актуальное состояние.
  try {
    const cached = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || 'null');
    const cachedVolume = Number(cached && cached.volume);
    if (cached && cached.volume != null && validVolume(cachedVolume)) {
      preferredVolume = cachedVolume;
      rememberAudible(cachedVolume);
    }
    if (cached && typeof cached.muted === 'boolean') {
      preferredMuted = cached.muted;
    }
  } catch {}
  const preloadVolume = Number(preloadState && preloadState.volume);
  if (
    preloadState &&
    preloadState.volumeDirty === true &&
    validVolume(preloadVolume)
  ) {
    preferredVolume = preloadVolume;
    preferredVolumeDirty = true;
    rememberAudible(preloadVolume);
  }

  function rememberVolume(value, persist = false) {
    const volume = Number(value);
    if (!validVolume(volume)) return;
    preferredVolume = volume;
    if (!persist) {
      rememberAudible(volume);
      return;
    }
    preferredVolumeDirty = true;
    cachePreferredState();
    clearTimeout(saveVolumeTimer);
    saveVolumeTimer = setTimeout(() => {
      // Уровень «до выключения звука» запоминаем только когда регулировка
      // остановилась. Иначе протяжка к нулю оставляла бы последним
      // слышимым значением случайные проценты, пойманные по дороге, и
      // кнопка возвращала бы почти тишину.
      rememberAudible(volume);
      window.postMessage(
        { type: 'YTEV_SAVE_VOLUME', channel: CHANNEL_ID, volume },
        PAGE_ORIGIN
      );
    }, 250);
  }

  function rememberMuted(value, persist = false) {
    const muted = !!value;
    preferredMuted = muted;
    if (!persist) return;
    preferredMutedDirty = true;
    cachePreferredState();
    clearTimeout(saveMutedTimer);
    saveMutedTimer = setTimeout(() => {
      window.postMessage(
        { type: 'YTEV_SAVE_MUTED', channel: CHANNEL_ID, muted },
        PAGE_ORIGIN
      );
    }, 250);
  }

  let volumeIntentUntil = 0;
  let mutedIntentUntil = 0;
  let volumeIntentVideo = null;
  let volumeIntentSource = '';
  const mediaSource = (video) =>
    video ? String(video.currentSrc || video.src || '') : '';
  const markVolumeIntent = (duration = 1200) => {
    volumeIntentVideo = getVideo();
    volumeIntentSource = mediaSource(volumeIntentVideo);
    volumeIntentUntil = Date.now() + duration;
  };
  const markMutedIntent = (duration = 1200) => {
    mutedIntentUntil = Date.now() + duration;
  };
  const hasVolumeIntent = (video = getVideo()) => {
    if (Date.now() > volumeIntentUntil) return false;
    if (volumeIntentVideo && video !== volumeIntentVideo) return false;
    const source = mediaSource(video);
    return !volumeIntentSource || !source || source === volumeIntentSource;
  };
  const hasMutedIntent = () => Date.now() <= mutedIntentUntil;
  const isEditableTarget = (target) =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  // Тот же набор, что и в bridge.js: условия «жест над плеером» должны
  // совпадать в обоих мирах, иначе один считает действие осознанным, а
  // второй отказывается его сохранять.
  const PLAYER_SELECTOR = '#movie_player, .html5-video-player, ytd-reel-video-renderer';
  const nativeVolumeControl = (target) => {
    if (!(target instanceof Element)) return null;
    const classic = target.closest('.ytp-volume-area, .ytp-volume-panel');
    if (classic) return classic;
    const shorts = target.closest('volume-controls, .ytdVolumeControlsHost');
    if (!shorts) return null;
    const reel = shorts.closest('ytd-reel-video-renderer');
    const active = activeReel();
    if (active) return reel === active ? shorts : null;
    return reel && !reel.hidden ? shorts : null;
  };
  const shortsNativeSlider = () => {
    const reel = activeReel();
    if (!reel || typeof reel.querySelectorAll !== 'function') return null;
    const sliders = reel.querySelectorAll(
      'volume-controls input#volume-input'
    );
    return sliders.length === 1 ? sliders[0] : null;
  };
  const nativePercentFromControl = (target) => {
    const shortsSlider = shortsNativeSlider();
    if (shortsSlider && target === shortsSlider) {
      const pct = Number(shortsSlider.value);
      return Number.isFinite(pct) && pct >= 0 && pct <= 100
        ? pct
        : null;
    }
    if (!(target instanceof Element)) return null;
    // Запасную панель ищем только внутри области громкости, где произошло
    // событие. Раньше отсюда брался ползунок плеера, даже когда жест пришёл
    // от совсем другого контрола, — и сохранялся уровень, который
    // пользователь не трогал.
    const area = target.closest('.ytp-volume-area, .ytp-volume-panel');
    const panel =
      target.closest('.ytp-volume-panel[aria-valuenow]') ||
      (area && area.querySelector('.ytp-volume-panel[aria-valuenow]'));
    if (!panel) return null;
    const pct = Number(panel.getAttribute('aria-valuenow'));
    return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
  };
  const applyTrustedNativeVolume = (target) => {
    if (!SETTINGS.useNativeSlider || !nativeVolumeControl(target)) {
      return false;
    }
    const pct = nativePercentFromControl(target);
    const video = getVideo();
    if (pct == null || !video) return false;
    const volume = pct / 100;
    markVolumeIntent(5000);
    rememberVolume(volume, true);
    if (volume > 0 && video.muted) {
      markMutedIntent(5000);
      rememberMuted(false, true);
      const player = getPlayer();
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    video.volume = volume;
    updateUI();
    return true;
  };
  let nativeApplyTimer = 0;
  const scheduleTrustedNativeVolume = (target) => {
    if (!SETTINGS.useNativeSlider || !nativeVolumeControl(target)) return;
    const video = getVideo();
    const source = mediaSource(video);
    clearTimeout(nativeApplyTimer);
    nativeApplyTimer = setTimeout(() => {
      nativeApplyTimer = 0;
      const current = getVideo();
      const currentSource = mediaSource(current);
      if (
        video &&
        (current !== video ||
          (source && currentSource && source !== currentSource))
      ) {
        return;
      }
      applyTrustedNativeVolume(target);
    }, 0);
  };
  const insidePlayer = (target) => {
    const player = getPlayer();
    if (player && target instanceof Node && player.contains(target)) return true;
    return target instanceof Element && !!target.closest(PLAYER_SELECTOR);
  };

  // Внешние способы управления YouTube тоже считаются осознанным выбором:
  // стрелки/колесо и штатная шкала должны обновлять preferredVolume, а не
  // выглядеть как очередной автоматический сброс при смене media.
  on(
    window,
    'keydown',
    (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      const isOwnSlider =
        target instanceof HTMLInputElement && target.classList.contains('ytev-slider');
      if (isEditableTarget(target)) {
        if (
          (isOwnSlider || nativeVolumeControl(target)) &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
          markVolumeIntent();
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Только над плеером: YouTube и сам меняет громкость стрелками
        // лишь при фокусе на плеере, а bridge открывает окно записи по
        // тому же условию. Раньше main.js метил намерение на любой стрелке
        // (например, при прокрутке комментариев) — и тогда служебный сброс
        // громкости принимался за осознанный выбор, а запись всё равно
        // отклонялась мостом: состояние сессии расходилось с хранилищем.
        if (!isShorts() && insidePlayer(target)) markVolumeIntent();
        return;
      }
      if (String(e.key).toLowerCase() !== 'm' || e.repeat) return;
      markMutedIntent();
      const video = getVideo();
      if (video) rememberMuted(!video.muted, true);
    },
    true
  );

  on(
    window,
    'wheel',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target && nativeVolumeControl(target)) {
        markVolumeIntent();
      }
    },
    true
  );

  on(
    window,
    'pointerdown',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('.ytp-mute-button, .ytev-mute')) markMutedIntent(5000);
      if (nativeVolumeControl(target) || target.closest('.ytev-slider')) {
        markVolumeIntent(5000);
        scheduleTrustedNativeVolume(target);
      }
    },
    true
  );

  on(
    window,
    'pointermove',
    (e) => {
      if (!(e.buttons & 1)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        target &&
        (nativeVolumeControl(target) || target.closest('.ytev-slider'))
      ) {
        markVolumeIntent(1500);
        scheduleTrustedNativeVolume(target);
      }
    },
    true
  );

  function restorePreferredVolume(video) {
    if (!video || !validVolume(preferredVolume)) return false;
    const current = Number(logicalOf(video));
    if (!validVolume(current) || Math.abs(current - preferredVolume) > VOLUME_EPSILON) {
      video.volume = preferredVolume;
      return true;
    }
    // YouTube can reuse the same <video> for the next Short and reset its
    // native output to 100% without going through the patched JS setter.
    // In that case logicalVolume still contains the preferred value, so the
    // logical comparison above alone cannot see the reset.
    const expectedReal = toReal(preferredVolume);
    const node = audio.nodes.get(video);
    const actualReal = node ? node.target : Number(nativeDesc.get.call(video));
    const expectedOutput = node
      ? outputGain(video, expectedReal)
      : video.muted
        ? 0
        : expectedReal;
    if (
      !Number.isFinite(actualReal) ||
      Math.abs(actualReal - expectedOutput) > VOLUME_EPSILON
    ) {
      applyReal(video, expectedReal);
      return true;
    }
    return false;
  }

  function restorePreferredState(video) {
    if (!video) return false;
    let changed = restorePreferredVolume(video);
    if (typeof preferredMuted !== 'boolean' || video.muted === preferredMuted) {
      return changed;
    }
    const player = getPlayer();
    if (player) {
      const method = preferredMuted ? 'mute' : 'unMute';
      if (typeof player[method] === 'function') player[method]();
    }
    video.muted = preferredMuted;
    changed = true;
    return changed;
  }

  /* ------------------------------------------------------------------ *
   * 1a-bis. Выравнивание громкости роликов
   *
   * YouTube кладёт в ответ плеера loudnessDb — насколько ролик громче
   * своей цели нормализации. Громкие он приглушает сам, умножая громкость
   * на 10^(-loudnessDb/20). Тихие не подтягивает: управляет он только
   * video.volume, а тот выше единицы не поднимается — поэтому лекция,
   * записанная на петличку, так и остаётся тихой. У нас усилитель Web
   * Audio, и недостающее мы можем добрать сами.
   *
   * Добираем осторожно: не больше 6дБ и только нехватку. Это сознательно
   * консервативно — у материала, который на N дБ тише цели, обычно есть
   * примерно столько же запаса до пика, поэтому лимитер (он добавил бы
   * задержку и рассинхрон с картинкой) не нужен.
   * ------------------------------------------------------------------ */

  const MAX_BOOST_DB = 6;
  // События дорожки, на которых имеет смысл перечитать снимок.
  const LOUDNESS_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'];
  let loudnessBoost = 1;
  let loudnessKey = '';

  /* ---- Почему решение принимается только по согласованному снимку ----
   *
   * Новый YouTube умеет отдавать отдельную DRC-дорожку («стабильная
   * громкость»): она уже сведена к цели −14 LKFS, а
   * playerConfig.audioConfig.loudnessDb остаётся от исходной дорожки. Усиление
   * по нему поверх DRC — двойная нормализация: на ролике с
   * «DRC (cont.−14.0 dB / tgt.−14.0 dB)» расширение читало −12.7дБ и
   * накидывало ещё +6дБ.
   *
   * Уровень и тип дорожки лежат в разных местах — в ответе плеера и в
   * статистике — и готовы не одновременно. Замер на переходе Shorts → обычное
   * видео: усиление на 553мс, признак DRC на 616мс, снятие только на 1513мс.
   * Раньше это лечилось окном ожидания в 2 секунды, но окно — догадка о
   * величине зазора: на медленной машине или медленном канале зазор её
   * превысит, на быстрой мы ждём зря.
   *
   * Поэтому ждём не время, а факт. Решение считается известным, только если
   * два источника описывают одну и ту же дорожку:
   *   - в строке громкости стоит DRC — усиливать нечего, вопрос закрыт;
   *   - либо статистика показывает ровно тот же уровень, что и ответ плеера
   *     (в «Статистике для сисадминов» он подписан как content loudness), —
   *     значит статистика уже про этот ролик, и DRC в ней нет;
   *   - либо ответ плеера вовсе не предлагает DRC-дорожки — тогда играть ей
   *     неоткуда.
   * Во всех остальных случаях снимок неполон, и усиление не поднимается.
   * ------------------------------------------------------------------ */

  // Ключи формата со ссылками и подписями: там встречается любое сочетание
  // букв, и поиск «drc» по ним давал бы ложные срабатывания.
  const FORMAT_NOISE_KEY = /url|cipher|signature|init|index|range|projection/i;
  // Число перед «dB» в строке громкости. Минус бывает и типографский, а
  // разделитель дробной части зависит от локали интерфейса.
  const DB_IN_STATS = /(-|−)?(\d+(?:[.,]\d+)?)\s*dB/gi;

  function statsVolumeText(player) {
    if (!player || typeof player.getStatsForNerds !== 'function') return '';
    try {
      const stats = player.getStatsForNerds();
      return stats && stats.volume != null ? String(stats.volume) : '';
    } catch {
      return '';
    }
  }

  // Совпал ли уровень из статистики с уровнем из ответа плеера. Это и есть
  // сверка: два источника сошлись — значит описывают один ролик.
  function statsConfirms(text, db) {
    DB_IN_STATS.lastIndex = 0;
    for (let match; (match = DB_IN_STATS.exec(text)); ) {
      const value = Number(String(match[2]).replace(',', '.')) * (match[1] ? -1 : 1);
      // Статистика округляет до десятых, отсюда допуск.
      if (Number.isFinite(value) && Math.abs(value - db) < 0.1) return true;
    }
    return false;
  }

  // DRC-дорожка у YouTube — отдельный формат (в yt-dlp он виден как «251-drc»
  // рядом с «251»), поэтому метка есть в самом описании формата. Ищем её
  // широко, не завязываясь на единственное имя поля: правка должна пережить
  // переименование.
  function formatLooksDrc(format) {
    if (!format || typeof format !== 'object') return false;
    for (const key of Object.keys(format)) {
      if (FORMAT_NOISE_KEY.test(key)) continue;
      const value = format[key];
      if (value == null || value === false || value === '') continue;
      if (/drc/i.test(key)) return true;
      let text;
      try {
        text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      } catch {
        continue;
      }
      // Длинные строки — это всё те же ссылки под другими именами: короткое
      // «drc» находится в них случайно.
      if (text.length <= 120 && /drc/i.test(text)) return true;
    }
    return false;
  }

  function audioFormats(response) {
    const streaming = response && response.streamingData;
    const list = streaming && streaming.adaptiveFormats;
    if (!Array.isArray(list)) return null;
    const audio = list.filter((f) => f && /^audio/i.test(String(f.mimeType || '')));
    return audio.length ? audio : null;
  }

  function currentVideoId(player) {
    try {
      const data =
        player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      return data && data.video_id ? String(data.video_id) : '';
    } catch {
      return '';
    }
  }

  /**
   * Полное решение из одного снимка.
   * `complete: false` — «пока неизвестно»; в этом состоянии усиление не
   * поднимается никогда, поэтому худший исход на медленной машине — «тише,
   * чем могло бы», и никогда «громче, чем нужно».
   */
  function readLoudness(player) {
    const id = currentVideoId(player);
    const stats = statsVolumeText(player);
    const unknown = { id, db: null, drc: false, complete: false, source: '', stats };
    if (!player || typeof player.getPlayerResponse !== 'function') return unknown;
    let response = null;
    try {
      response = player.getPlayerResponse();
    } catch {
      return unknown;
    }
    if (!response) return unknown;
    // Сразу после перехода плеер ещё какое-то время отдаёт ответ предыдущего
    // ролика. Снимок от чужого ролика решением не считается.
    const details = response.videoDetails;
    const snapshotId = details && details.videoId ? String(details.videoId) : '';
    if (id && snapshotId && snapshotId !== id) return unknown;
    const videoId = id || snapshotId;
    if (!videoId) return unknown;
    unknown.id = videoId;

    const config = response.playerConfig && response.playerConfig.audioConfig;
    const raw = config ? config.loudnessDb : undefined;
    const db = raw == null || raw === '' ? NaN : Number(raw);
    const known = { id: videoId, db: Number.isFinite(db) ? db : null, stats };
    // Прочитанный уровень показываем и в неполном снимке: без него
    // диагностика не отличит «уровня ещё нет» от «нечем подтвердить».
    unknown.db = known.db;

    if (/\bDRC\b/.test(stats)) {
      return { ...known, drc: true, complete: true, source: 'stats' };
    }
    if (!Number.isFinite(db)) return unknown;
    if (statsConfirms(stats, db)) {
      return { ...known, drc: false, complete: true, source: 'stats' };
    }
    const formats = audioFormats(response);
    if (formats && !formats.some(formatLooksDrc)) {
      return { ...known, drc: false, complete: true, source: 'formats' };
    }
    return unknown;
  }

  function setLoudnessBoost(next) {
    if (Math.abs(next - loudnessBoost) < 1e-6) return;
    loudnessBoost = next;
    reapplyCurve(); // через setTargetAtTime, поэтому без щелчка
  }

  // Смена ролика: прежнее решение больше не действует, а нового ещё нет.
  function resetLoudness() {
    loudnessKey = '';
    setLoudnessBoost(1);
  }

  function refreshLoudness() {
    if (!SETTINGS.normalizeLoudness) {
      resetLoudness();
      return;
    }
    const snap = readLoudness(getPlayer());
    if (!snap.complete) return;
    // В ключ входит и признак DRC: «стабильную громкость» можно включить
    // и выключить прямо во время ролика, и решение тогда меняется.
    const key = `${snap.id}|${snap.drc ? 'drc' : 'raw'}`;
    if (key === loudnessKey) return;
    loudnessKey = key;
    const boostDb = snap.drc || snap.db >= 0 ? 0 : Math.min(MAX_BOOST_DB, -snap.db);
    setLoudnessBoost(Math.pow(10, boostDb / 20));
  }

  // Итоговое усиление в графе. Компенсация живёт только здесь: запасной
  // путь пишет прямо в video.volume, а он выше единицы не поднимается.
  const outputGain = (el, real) => (el.muted ? 0 : real * loudnessBoost);

  /* ------------------------------------------------------------------ *
   * 1b. Регулировка через Web Audio — главное средство против треска
   *
   * Запись в video.volume из JS принципиально ступенчата: значение
   * применяется на границах аудиобуферов, поэтому быстрые изменения
   * дают «zipper noise» (треск), а экспоненциальная кривая ещё и
   * утраивает шаг в верхней части шкалы. GainNode автоматизирует
   * усиление в аудиопотоке с частотой дискретизации: setTargetAtTime с
   * постоянной времени 15мс воспринимается мгновенным, но щелчков не
   * даёт вовсе.
   *
   * Ограничения Web Audio, которые здесь обойдены:
   *  - DRM (EME): createMediaElementSource на защищённом потоке даёт
   *    тишину — такие элементы не подключаем (mediaKeys / событие
   *    encrypted);
   *  - приостановленный AudioContext (политика автовоспроизведения):
   *    подключаемся только когда контекст реально работает;
   *  - подключение необратимо, поэтому есть сторож тишины: если через
   *    граф ничего не идёт, возвращаемся к прямой записи громкости.
   * ------------------------------------------------------------------ */

  const audio = {
    ctx: null,
    unavailable: false,
    nodes: new WeakMap(),
    // WeakMap удобен для поиска, но его нельзя обойти при dispose().
    // Отдельная Map содержит только ещё подключённые графы и очищается,
    // как только элемент уходит из документа или переводится на прямой путь.
    liveNodes: new Map(),
    failedElements: new WeakSet(),
  };
  const drmElements = new WeakSet();

  on(
    document,
    'encrypted',
    (e) => {
      if (e.target instanceof HTMLMediaElement) drmElements.add(e.target);
    },
    true
  );

  function audioGraph(el) {
    if (
      audio.unavailable ||
      !(el instanceof HTMLMediaElement) ||
      audio.failedElements.has(el)
    ) {
      return null;
    }
    const existing = audio.nodes.get(el);
    if (existing) return existing;
    if (drmElements.has(el) || el.mediaKeys) return null; // защищённый поток
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!audio.ctx) audio.ctx = new Ctx();
    } catch {
      audio.unavailable = true;
      return null;
    }
    if (audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
    // пока контекст не запущен, звук через граф не пойдёт — ждём
    if (audio.ctx.state !== 'running') return null;
    try {
      const src = audio.ctx.createMediaElementSource(el);
      const gain = audio.ctx.createGain();
      gain.gain.value = outputGain(el, toReal(logicalOf(el)));
      src.connect(gain).connect(audio.ctx.destination);
      const node = {
        src,
        gain,
        target: gain.gain.value,
        onVolumeChange: null,
        stopWatch: null,
        released: false,
      };
      node.onVolumeChange = () => applyReal(el, toReal(logicalOf(el)));
      audio.nodes.set(el, node);
      audio.liveNodes.set(el, node);
      // уровень задаёт gain, сам элемент держим на максимуме
      nativeDesc.set.call(el, 1);
      el.addEventListener('volumechange', node.onVolumeChange);
      watchSilence(el, node);
      return node;
    } catch {
      audio.failedElements.add(el);
      return null;
    }
  }

  // Сторож: если через граф идёт ровно ноль при играющем незаглушённом
  // видео — значит подключение не работает (например, неожиданный DRM).
  // Тогда снимаем усиление и возвращаемся к прямой записи громкости.
  function watchSilence(el, node) {
    const ctx = audio.ctx;
    let analyser;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      node.gain.connect(analyser);
    } catch {
      return;
    }
    const buf = new Uint8Array(analyser.fftSize);
    let silentFor = 0;
    let lastTime = -1;
    let ticks = 0;
    let timer = 0;
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = 0;
      try {
        node.gain.disconnect(analyser);
      } catch {}
      if (node.stopWatch === stop) node.stopWatch = null;
    };
    node.stopWatch = stop;
    timer = setInterval(() => {
      if (!el.isConnected) {
        fallbackToDirect(el, node);
        return;
      }
      if (audio.failedElements.has(el) || ++ticks > 240) {
        stop(); // откат уже был или прошло 2 минуты
        return;
      }
      const playing = !el.paused && !el.muted && el.currentTime !== lastTime;
      lastTime = el.currentTime;
      if (!playing || node.target < 0.01) {
        silentFor = 0;
        return;
      }
      analyser.getByteTimeDomainData(buf);
      const silent = buf.every((v) => v === 128); // 128 — цифровая тишина
      silentFor = silent ? silentFor + 500 : 0;
      if (silentFor >= 6000) {
        stop();
        fallbackToDirect(el, node);
      } else if (!silent && silentFor === 0 && lastTime > 3) {
        stop(); // звук идёт — сторож больше не нужен
      }
    }, 500);
  }

  function fallbackToDirect(el, node) {
    if (!node || node.released) return;
    node.released = true;
    audio.failedElements.add(el);
    audio.nodes.delete(el);
    audio.liveNodes.delete(el);
    if (node.stopWatch) node.stopWatch();
    if (node.onVolumeChange) {
      el.removeEventListener('volumechange', node.onVolumeChange);
      node.onVolumeChange = null;
    }
    try {
      node.gain.disconnect();
    } catch {}
    try {
      node.src.disconnect();
    } catch {}
    try {
      node.src.connect(audio.ctx.destination);
    } catch {}
    nativeDesc.set.call(el, Math.min(1, Math.max(0, node.target)));
  }

  // Основной путь установки фактической громкости
  function applyReal(el, real) {
    const node = audioGraph(el);
    if (node) {
      const target = outputGain(el, real);
      node.target = target;
      // 15мс — «мгновенно на слух», но без щелчка
      node.gain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.015);
      if (nativeDesc.get.call(el) !== 1) nativeDesc.set.call(el, 1);
      return;
    }
    setRealSmooth(el, real);
  }

  // Контекст можно запустить только после жеста пользователя, поэтому
  // пробуем подключиться на любом взаимодействии и при старте
  // воспроизведения; до этого работает запасной путь
  let lastEngage = 0;
  function engageAudio() {
    if (audio.unavailable) return;
    const now = Date.now();
    if (now - lastEngage < 400) return; // не дёргаем на каждое нажатие клавиши
    lastEngage = now;
    if (audio.ctx && audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
    document.querySelectorAll('video, audio').forEach((el) => {
      if (!el.paused) audioGraph(el);
    });
  }
  for (const type of ['pointerdown', 'keydown', 'playing']) {
    on(document, type, engageAudio, true);
  }

  // Запасной путь (Web Audio недоступен): подводка таймером — грубее,
  // чем автоматизация в аудиопотоке, но лучше мгновенного скачка
  const ramps = new WeakMap();
  function setRealSmooth(el, target) {
    let st = ramps.get(el);
    if (!st) {
      st = { active: false, target: 0 };
      ramps.set(el, st);
    }
    st.target = target;
    if (st.active) return; // текущий цикл дотянет до новой цели
    const current = nativeDesc.get.call(el);
    if (Math.abs(current - target) < 1e-6) return;
    if (document.hidden) {
      // в фоновой вкладке таймеры заторможены — ставим сразу
      nativeDesc.set.call(el, target);
      return;
    }
    st.active = true;
    let value = current;
    let last = performance.now();
    const step = () => {
      if (document.hidden) {
        nativeDesc.set.call(el, st.target);
        st.active = false;
        return;
      }
      const now = performance.now();
      const k = 1 - Math.exp(-(now - last) / 40); // постоянная времени 40мс
      last = now;
      value += (st.target - value) * Math.max(k, 0.2);
      if (Math.abs(st.target - value) < 0.002) {
        nativeDesc.set.call(el, st.target);
        st.active = false;
        return;
      }
      nativeDesc.set.call(el, Math.min(1, Math.max(0, value)));
      setTimeout(step, 16);
    };
    step();
  }

  // Применить кривую заново (после смены настроек); плавная подводка сама
  // пропускает элементы, у которых фактическое значение не меняется
  function reapplyCurve() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (logicalVolume.has(el)) applyReal(el, toReal(logicalVolume.get(el)));
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Настройки из popup (доверенная инъекция через service worker)
   * ------------------------------------------------------------------ */

  function applyTrustedPayload(payload, includeState = false) {
    if (!payload || typeof payload !== 'object') return false;
    applySettings(payload.settings);
    applyStrings(payload.strings);
    if (!volumeStateLoaded) {
      const state =
        includeState && payload.state && typeof payload.state === 'object'
          ? payload.state
          : {};
      const savedValue = state.savedVolume;
      const savedVolume = Number(savedValue);
      if (!preferredVolumeDirty && savedValue != null && validVolume(savedVolume)) {
        preferredVolume = savedVolume;
      }
      if (!preferredMutedDirty) {
        if (typeof state.savedMuted === 'boolean') {
          preferredMuted = state.savedMuted;
        } else if (savedValue != null && validVolume(savedVolume)) {
          // Версии до 1.12.6 сохраняли только уровень. Не наследуем
          // случайный autoplay-mute YouTube при первом запуске новой страницы.
          preferredMuted = false;
        }
      }
      volumeStateLoaded = true;
      if (
        preloadState &&
        preloadState.volumeDirty === true &&
        validVolume(Number(preloadState.volume))
      ) {
        rememberVolume(Number(preloadState.volume), true);
      }
      preloadState = null;
    }
    cachePreferredState();
    refreshLoudness(); // сам позовёт reapplyCurve, если компенсация изменилась
    reapplyCurve();
    bindVideo();
    ensureUI(); // включение/выключение своей шкалы должно срабатывать сразу
    layout();
    updateUI();
    updateCollapsed();
    return true;
  }

  const instanceApi = Object.freeze({
    version: 2,
    // Канал — опознавательный знак поколения, не секрет: он и так виден
    // странице, потому что main.js сам публикует его в postMessage.
    // Совпал — значит это тот же bridge и разворачиваться второй раз не
    // нужно; не совпал — расширение перезагрузили, и мы уступаем место.
    channel: CHANNEL_ID,
    dispose: disposeInstance,
    // Что расширение решило про громкость текущего ролика. Нужно, чтобы
    // сверить наш вывод с числом, которое YouTube показывает в «Статистике
    // для сисадминов»: там то же значение подписано как content loudness.
    // Ничего закрытого не отдаёт — уровень ролика странице и так известен.
    loudness() {
      const snap = readLoudness(getPlayer());
      return {
        enabled: SETTINGS.normalizeLoudness,
        db: snap.db,
        drc: snap.drc,
        // complete — согласовались ли источники; source — кто дал ответ.
        // Вместе со stats этого хватает, чтобы разобрать любой спорный
        // случай прямо из консоли, не добавляя отладочных крючков.
        complete: snap.complete,
        source: snap.source,
        stats: snap.stats,
        boost: loudnessBoost,
        boostDb: Number((20 * Math.log10(loudnessBoost)).toFixed(2)),
        maxBoostDb: MAX_BOOST_DB,
      };
    },
    update(candidateSecret, payload) {
      if (candidateSecret !== updateSecret) return false;
      return applyTrustedPayload(payload, false);
    },
  });

  /* ------------------------------------------------------------------ *
   * 3. Длинный точный ползунок в панели плеера
   *
   * Размеры задаются относительно плеера: толщина ползунка, бегунок и
   * подпись масштабируются через CSS-переменные (в полноэкранном режиме
   * YouTube ставит на плеер класс ytp-big-mode), а длина считается в JS —
   * доля ширины плеера, ограниченная реально свободным местом в панели.
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    /* Раннее скрытие включается ещё на document_start. visibility оставляет
       геометрию штатного блока доступной для точного монтажа нашей шкалы. */
    .${EARLY_HIDE_CLASS} .ytp-volume-area,
    .${EARLY_HIDE_CLASS} .ytp-volume-panel,
    .${EARLY_HIDE_CLASS} .ytp-mute-button,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer volume-controls,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer .ytdVolumeControlsHost,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls volume-controls,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls .ytdVolumeControlsHost {
      visibility: hidden !important;
    }
    /* Штатные ползунок и кнопка звука скрываются ТОЛЬКО при классе
       ytev-active — он ставится после успешного монтирования нашего
       блока и снимается в режиме отката. Если код расширения упадёт,
       класса не будет и штатная громкость останется на месте. */
    .ytev-active .ytp-volume-panel,
    .ytev-active .ytp-mute-button {
      display: none !important;
    }
    /* при наведении YouTube резервирует ширину под выезжающий штатный
       ползунок — он скрыт, поэтому рамка раздувалась бы впустую; пока
       работает наш ползунок, запрещаем области громкости менять ширину */
    .ytev-active .ytp-volume-area {
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      transition: none !important;
    }
    .ytev-box {
      --ytev-track: 4px;
      --ytev-thumb: 13px;
      --ytev-font: 12px;
      display: flex;
      align-items: center;
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      margin: 0 8px;
      position: relative;
      /* В актуальном интерфейсе Shorts вся строка кнопок получает
         pointer-events:none, а свойство наследуется. Возвращаем
         интерактивность нашему поддереву явно, иначе клик попадает в video. */
      pointer-events: auto;
    }
    /* Новый блок сначала получает размеры, фон, состояние иконки и состояние
       сворачивания и только затем показывается. Иначе браузер успевает
       отрисовать резервный фон и проиграть переход к конечному состоянию. */
    .ytev-box.ytev-initializing {
      visibility: hidden !important;
    }
    .ytev-box.ytev-initializing,
    .ytev-box.ytev-initializing *,
    .ytev-box.ytev-initializing::after {
      transition: none !important;
      animation: none !important;
    }
    /* содержимое поверх слоя подсветки */
    .ytev-box > * { position: relative; z-index: 1; }
    /* геометрия рамки: справа поле --ytev-pad, слева меньше — значок
       YouTube (viewBox 24×24) несёт собственные внутренние поля */
    .ytev-box.ytev-framed {
      padding: 0 var(--ytev-pad, 10px) 0 calc(var(--ytev-pad, 10px) * .25);
      gap: calc(var(--ytev-pad, 10px) * .5);
    }
    .ytev-box:not(.ytev-framed) { gap: 6px; }
    /* Если штатная кнопка звука была у правого края (обычное место в
       Shorts), шкала разворачивается влево — кнопка остаётся на своём
       месте, как у штатной выезжающей панели */
    .ytev-box.ytev-mirrored { flex-direction: row-reverse; }
    .ytev-box.ytev-framed.ytev-mirrored:not(.ytev-collapsed) {
      padding: 0 calc(var(--ytev-pad, 10px) * .25) 0 var(--ytev-pad, 10px);
    }
    /* Shorts: своего места в интерфейсе нет — кладём блок в собственный
       слой поверх плеера. Слой не перехватывает клики, блок — перехватывает */
    .ytev-overlay {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1000;
      display: flex;
      pointer-events: none;
    }
    .ytev-overlay .ytev-box {
      pointer-events: auto;
      transition: opacity .2s ease;
    }
    /* указатель ушёл с ролика — блок скрывается, как штатные кнопки */
    .ytev-pointer-away .ytev-overlay .ytev-box {
      opacity: 0;
      pointer-events: none;
    }
    /* своя кнопка звука с оригинальным значком YouTube: почти на всю
       высоту рамки, как у штатной, — сам глиф имеет поля внутри viewBox */
    .ytev-mute {
      flex: none;
      height: calc(100% - 4px);
      aspect-ratio: 1 / 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      padding: 0;
      margin: 0;
      color: #fff;
      cursor: pointer;
      pointer-events: auto;
    }
    .ytev-box:not(.ytev-framed) .ytev-mute { height: 36px; }
    .ytev-mute svg {
      /* У штатной кнопки YouTube SVG 24×24 внутри зоны 36×36. */
      width: 66.6667%;
      height: 66.6667%;
      display: block;
      overflow: visible;
    }
    /* Актуальные формы YouTube (viewBox 24×24). При выключении звука
       волны за 200 мс сжимаются к своим центрам, после чего появляется
       штатный контурный рупор с крестом. Включение идёт в обратную сторону. */
    .ytev-speaker,
    .ytev-wave,
    .ytev-muted-icon { fill: currentColor; }
    .ytev-speaker {
      opacity: 1;
      transition: opacity .04s linear;
    }
    .ytev-wave {
      opacity: 1;
      transform: scale(1);
      transform-box: view-box;
      transition:
        transform .2s cubic-bezier(.2, 0, 0, 1),
        opacity .04s linear;
    }
    .ytev-wave-1 { transform-origin: 75% 50%; }
    .ytev-wave-2 { transform-origin: 91.6667% 50%; }
    .ytev-muted-icon {
      opacity: 0;
      transform: scale(.94);
      transform-box: view-box;
      transform-origin: 50% 50%;
      transition:
        opacity .04s linear,
        transform .2s cubic-bezier(.2, 0, 0, 1);
    }
    /* На тихой громкости YouTube оставляет только внутреннюю волну. */
    .ytev-box[data-vol="low"] .ytev-wave-2 {
      opacity: 0;
      transform: scale(0);
      transition-delay: 0s, .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-speaker {
      opacity: 0;
      transition-delay: .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-wave {
      opacity: 0;
      transform: scale(0);
      transition-delay: 0s, .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-muted-icon {
      opacity: 1;
      transform: scale(1);
      transition-delay: .16s, 0s;
    }
    @media (prefers-reduced-motion: reduce) {
      .ytev-speaker,
      .ytev-wave,
      .ytev-muted-icon { transition: none; }
    }
    /* автосворачивание: без курсора остаётся только кнопка; переходы
       включаются лишь на время переключения (.ytev-animating), чтобы
       не мешать замерам layout() */
    .ytev-box.ytev-animating { transition: gap .25s ease, padding .25s ease; }
    .ytev-box.ytev-animating .ytev-slider { transition: width .25s ease, opacity .2s ease; }
    .ytev-box.ytev-animating .ytev-label { transition: max-width .25s ease, opacity .2s ease; }
    /* Свёрнутое состояние — ровный круг со значком по центру, как
       штатные круглые кнопки YouTube. Кнопка занимает «высота − 4px»,
       поэтому симметричные поля по 2px дают ширину, равную высоте.
       border-radius перебивает инлайновое скругление, скопированное с
       плашки, поэтому !important. */
    .ytev-box.ytev-collapsed { gap: 0; padding: 0; }
    .ytev-box.ytev-framed.ytev-collapsed {
      padding: 0 2px;
      border-radius: 50% !important;
    }
    .ytev-box.ytev-collapsed .ytev-slider {
      width: 0 !important;
      min-width: 0 !important;
      opacity: 0;
    }
    .ytev-box.ytev-collapsed .ytev-label {
      max-width: 0;
      min-width: 0;
      opacity: 0;
    }
    /* подсветка при наведении — внутренний скруглённый слой с одинаковым
       пиксельным зазором со всех четырёх сторон, как у штатных «пилюль»
       YouTube; скругление уменьшено на величину зазора, чтобы контуры
       были концентричными; на раскладку не влияет */
    .ytev-box.ytev-framed::after {
      content: '';
      position: absolute;
      inset: var(--ytev-hl-inset, 4px);
      border-radius: var(--ytev-hl-radius, 16px);
      background: rgba(255, 255, 255, .12);
      opacity: 0;
      transition: opacity .1s;
      pointer-events: none;
      z-index: 0;
    }
    .ytev-box.ytev-framed:hover::after { opacity: 1; }
    .ytp-big-mode .ytev-box {
      --ytev-track: 5px;
      --ytev-thumb: 18px;
      --ytev-font: 15px;
      margin-left: 10px;
    }
    .ytev-slider {
      -webkit-appearance: none;
      appearance: none;
      min-width: 0;
      height: var(--ytev-track);
      border-radius: calc(var(--ytev-track) / 2);
      background: rgba(255, 255, 255, .3);
      outline: none;
      cursor: pointer;
      margin: 0;
      pointer-events: auto;
    }
    .ytev-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: var(--ytev-thumb);
      height: var(--ytev-thumb);
      border-radius: 50%;
      background: #fff;
      border: none;
    }
    .ytev-label {
      color: #eee;
      font-family: Roboto, Arial, sans-serif;
      font-size: var(--ytev-font);
      line-height: 1;
      min-width: 2.5em; /* ровно под «100%», чтобы рамка не гуляла по ширине */
      max-width: 5em;
      overflow: hidden;
      text-align: center; /* запас ширины делится поровну на обе стороны */
      white-space: nowrap;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  const MIN_SLIDER = 48; // короче — бесполезно, лучше спрятать
  const SAFETY_GAP = 4;  // запас на округления, чтобы панель не «поехала»

  // фиксированные константы, вычисляются ОДИН раз из размеров плашки при
  // первом измерении и дальше не меняются:
  let edgeGap = 0;     // отступ по краям рамки (снаружи)
  let hlInset = 0;     // зазор слоя подсветки от рамки, одинаковый со всех сторон
  let shortsGap = 0;   // то же для Shorts — там свои размеры плеера
  let shortsInset = 0;

  // { box, slider, label, muteBtn, hiddenPill }
  let ui = null;
  let boundVideo = null;
  let videoBinding = null;
  let observedPlayer = null;
  let observedPill = null;

  const isShorts = () => location.pathname.startsWith('/shorts/');

  // Активный плеер: на странице Shorts это плеер текущей ленты (он один и
  // переезжает между роликами), на обычной странице — #movie_player
  function getPlayer() {
    if (isShorts()) {
      // разметку Shorts YouTube меняет чаще прочего, поэтому пробуем
      // несколько путей и требуем, чтобы элемент был реально виден
      const selectors = [
        'ytd-reel-video-renderer[is-active] .html5-video-player',
        '#shorts-player .html5-video-player',
        'ytd-shorts .html5-video-player',
        '#shorts-player',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.clientWidth && el.clientHeight) return el;
      }
      // последний рубеж: контейнер видимого видео на странице
      const videos = [...document.querySelectorAll('video')].filter((v) => v.clientWidth);
      const video = videos.find((v) => !v.paused) || videos[0];
      const host =
        video && video.closest('.html5-video-player, #shorts-player, ytd-reel-video-renderer');
      if (host) return host;
    }
    return document.getElementById('movie_player');
  }
  const getVideo = () => {
    const p = getPlayer();
    return p ? p.querySelector('video') : null;
  };

  const fmt = (pct) => (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';

  // Центр бегунка ходит не по всей ширине дорожки, а в пределах
  // [thumb/2, width − thumb/2], поэтому заливка «в процентах от ширины»
  // отставала от бегунка тем сильнее, чем ближе к краям. Считаем границу
  // заливки по фактическому положению центра.
  function paint(pct) {
    const w = ui.trackW || ui.slider.getBoundingClientRect().width;
    const thumb = ui.thumbPx || 13;
    const edge =
      w > thumb ? ((thumb / 2 + (pct / 100) * (w - thumb)) / w) * 100 : pct;
    ui.slider.style.background =
      `linear-gradient(to right, #fff 0% ${edge}%, rgba(255,255,255,.3) ${edge}% 100%)`;
  }

  function updateUI() {
    if (!ui) return;
    const video = getVideo();
    if (!video) return;
    const pct = video.volume * 100; // логическая громкость
    ui.slider.value = pct;
    ui.slider.setAttribute('aria-valuetext', fmt(pct));
    paint(pct);
    ui.label.textContent = fmt(pct);
    const muted = video.muted || pct === 0;
    ui.box.classList.toggle('ytev-muted', muted);
    const state = muted ? 'muted' : pct < 50 ? 'low' : 'high';
    ui.box.dataset.vol = state;
    if (ui.muteBtn) {
      // Только aria-label: всплывающей подсказки у кнопки нет, она
      // перекрывала бы плеер. Клавиша озвучивается через aria-keyshortcuts.
      ui.muteBtn.setAttribute(
        'aria-label',
        muted ? STRINGS.playerUnmute : STRINGS.playerMute
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * Значок кнопки звука
   *
   * Точные формы актуального плеера YouTube (viewBox 24×24): заполненный
   * рупор с одной/двумя волнами и отдельный контурный mute-значок с
   * крестом. Состояние задаётся data-vol, а CSS повторяет оригинальную
   * 200-миллисекундную анимацию схлопывания и раскрытия волн.
   * ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // формы значка громкости из актуального плеера YouTube (viewBox 24×24)
  const ICON = {
    speaker:
      'M 11.60 2.08 L 11.48 2.14 L 3.91 6.68 C 3.02 7.21 2.28 7.97 1.77 8.87 C 1.26 9.77 1.00 10.79 1 11.83 V 12.16 L 1.01 12.56 C 1.07 13.52 1.37 14.46 1.87 15.29 C 2.38 16.12 3.08 16.81 3.91 17.31 L 11.48 21.85 C 11.63 21.94 11.80 21.99 11.98 21.99 C 12.16 22.00 12.33 21.95 12.49 21.87 C 12.64 21.78 12.77 21.65 12.86 21.50 C 12.95 21.35 13 21.17 13 21 V 3 C 12.99 2.83 12.95 2.67 12.87 2.52 C 12.80 2.37 12.68 2.25 12.54 2.16 C 12.41 2.07 12.25 2.01 12.08 2.00 C 11.92 1.98 11.75 2.01 11.60 2.08 Z',
    wave1:
      'M 15.53 7.05 C 15.35 7.22 15.25 7.45 15.24 7.70 C 15.23 7.95 15.31 8.19 15.46 8.38 L 15.53 8.46 L 15.70 8.64 C 16.09 9.06 16.39 9.55 16.61 10.08 L 16.70 10.31 C 16.90 10.85 17 11.42 17 12 L 16.99 12.24 C 16.96 12.73 16.87 13.22 16.70 13.68 L 16.61 13.91 C 16.36 14.51 15.99 15.07 15.53 15.53 C 15.35 15.72 15.25 15.97 15.26 16.23 C 15.26 16.49 15.37 16.74 15.55 16.92 C 15.73 17.11 15.98 17.21 16.24 17.22 C 16.50 17.22 16.76 17.12 16.95 16.95 C 17.6 16.29 18.11 15.52 18.46 14.67 L 18.59 14.35 C 18.82 13.71 18.95 13.03 18.99 12.34 L 19 12 C 18.99 11.19 18.86 10.39 18.59 9.64 L 18.46 9.32 C 18.15 8.57 17.72 7.89 17.18 7.3 L 16.95 7.05 L 16.87 6.98 C 16.68 6.82 16.43 6.74 16.19 6.75 C 15.94 6.77 15.71 6.87 15.53 7.05 Z',
    wave2:
      'M18.36 4.22 C18.18 4.39 18.08 4.62 18.07 4.87 C18.05 5.12 18.13 5.36 18.29 5.56 L18.36 5.63 L18.66 5.95 C19.36 6.72 19.91 7.60 20.31 8.55 L20.47 8.96 C20.82 9.94 21 10.96 21 11.99 L20.98 12.44 C20.94 13.32 20.77 14.19 20.47 15.03 L20.31 15.44 C19.86 16.53 19.19 17.52 18.36 18.36 C18.17 18.55 18.07 18.80 18.07 19.07 C18.07 19.33 18.17 19.59 18.36 19.77 C18.55 19.96 18.80 20.07 19.07 20.07 C19.33 20.07 19.59 19.96 19.77 19.77 C20.79 18.75 21.61 17.54 22.16 16.20 L22.35 15.70 C22.72 14.68 22.93 13.62 22.98 12.54 L23 12 C22.99 10.73 22.78 9.48 22.35 8.29 L22.16 7.79 C21.67 6.62 20.99 5.54 20.15 4.61 L19.77 4.22 L19.70 4.15 C19.51 3.99 19.26 3.91 19.02 3.93 C18.77 3.94 18.53 4.04 18.36 4.22 Z',
    muted:
      'M11.60 2.08L11.48 2.14L3.91 6.68C3.02 7.21 2.28 7.97 1.77 8.87C1.26 9.77 1.00 10.79 1 11.83V12.16L1.01 12.56C1.07 13.52 1.37 14.46 1.87 15.29C2.38 16.12 3.08 16.81 3.91 17.31L11.48 21.85C11.63 21.94 11.80 21.99 11.98 21.99C12.16 22.00 12.33 21.95 12.49 21.87C12.64 21.78 12.77 21.65 12.86 21.50C12.95 21.35 13 21.17 13 21V3C12.99 2.83 12.95 2.67 12.87 2.52C12.80 2.37 12.68 2.25 12.54 2.16C12.41 2.07 12.25 2.01 12.08 2.00C11.92 1.98 11.75 2.01 11.60 2.08ZM4.94 8.4V8.40L11 4.76V19.23L4.94 15.6C4.38 15.26 3.92 14.80 3.58 14.25C3.24 13.70 3.05 13.07 3.00 12.43L3 12.17V11.83C2.99 11.14 3.17 10.46 3.51 9.86C3.85 9.25 4.34 8.75 4.94 8.4ZM21.29 8.29L19 10.58L16.70 8.29L16.63 8.22C16.43 8.07 16.19 7.99 15.95 8.00C15.70 8.01 15.47 8.12 15.29 8.29C15.12 8.47 15.01 8.70 15.00 8.95C14.99 9.19 15.07 9.43 15.22 9.63L15.29 9.70L17.58 12L15.29 14.29C15.19 14.38 15.12 14.49 15.06 14.61C15.01 14.73 14.98 14.87 14.98 15.00C14.98 15.13 15.01 15.26 15.06 15.39C15.11 15.51 15.18 15.62 15.28 15.71C15.37 15.81 15.48 15.88 15.60 15.93C15.73 15.98 15.86 16.01 15.99 16.01C16.12 16.01 16.26 15.98 16.38 15.93C16.50 15.87 16.61 15.80 16.70 15.70L19 13.41L21.29 15.70L21.36 15.77C21.56 15.93 21.80 16.01 22.05 15.99C22.29 15.98 22.53 15.88 22.70 15.70C22.88 15.53 22.98 15.29 22.99 15.05C23.00 14.80 22.93 14.56 22.77 14.36L22.70 14.29L20.41 12L22.70 9.70C22.80 9.61 22.87 9.50 22.93 9.38C22.98 9.26 23.01 9.12 23.01 8.99C23.01 8.86 22.98 8.73 22.93 8.60C22.88 8.48 22.81 8.37 22.71 8.28C22.62 8.18 22.51 8.11 22.39 8.06C22.26 8.01 22.13 7.98 22.00 7.98C21.87 7.98 21.73 8.01 21.61 8.06C21.49 8.12 21.38 8.19 21.29 8.29Z',
  };

  function buildIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ytev-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = [
      [ICON.speaker, 'ytev-speaker'],
      [ICON.wave1, 'ytev-wave ytev-wave-1'],
      [ICON.wave2, 'ytev-wave ytev-wave-2'],
      [ICON.muted, 'ytev-muted-icon'],
    ];
    for (const [d, cls] of shapes) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  const num = (v) => parseFloat(v) || 0;

  // Доля ширины плеера под шкалу: у Shorts своя настройка, потому что
  // плеер там узкий (значение по умолчанию — на случай старой записи)
  const activeScale = () =>
    isShorts()
      ? num(SETTINGS.shortsScale) || 11
      : num(SETTINGS.sliderScale) || 7;

  const outerWidth = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none') return 0;
    return el.getBoundingClientRect().width + num(s.marginLeft) + num(s.marginRight);
  };

  const innerWidth = (el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - num(s.paddingLeft) - num(s.paddingRight);
  };

  // «Пилюля» со штатными кнопками — элемент, рядом с которым мы вставлены
  // и в котором живёт (скрытая) штатная кнопка звука
  function findPill() {
    const controls = ui.box.parentElement;
    if (!controls) return null;
    let el =
      (ui.hiddenPill && ui.hiddenPill.isConnected ? ui.hiddenPill : null) ||
      controls.querySelector('.ytp-volume-area, .ytp-mute-button');
    if (!el || ui.box.contains(el)) return null;
    while (el && el.parentElement !== controls) el = el.parentElement;
    return el && el !== ui.box ? el : null;
  }

  // Штатная кнопка звука скрыта через CSS; если кроме неё в «пилюле» не
  // осталось видимых кнопок — прячем пилюлю целиком, иначе висел бы
  // пустой кружок фона. В режиме отката пилюля возвращается.
  function markDonorPill(controls) {
    ui.hiddenPill = null;
    const mute = controls.querySelector('.ytp-mute-button');
    if (!mute || ui.box.contains(mute)) return;
    let pill = mute.parentElement;
    while (pill && pill.parentElement !== controls) pill = pill.parentElement;
    if (!pill || pill === ui.box) return;
    const hasOther = [...pill.querySelectorAll('button, [role="button"]')]
      .some((b) => b !== mute && b.offsetWidth > 0);
    if (!hasOther) {
      ui.hiddenPill = pill;
      pill.style.display = 'none';
    }
  }

  // Нормальный режим: наш блок виден и «в ответе» за громкость
  // (класс ytev-active включает CSS-скрытие штатных элементов),
  // опустевшая пилюля спрятана
  function enterNormal(player) {
    setEarlyNativeHidden(true, true);
    player.classList.add('ytev-active');
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = 'none';
    }
    ui.box.style.display = '';
  }

  // Откат (узкий плеер): наш блок спрятан, снятие класса возвращает
  // штатные кнопку и ползунок
  function enterFallback(player) {
    setEarlyNativeHidden(false, true);
    ui.box.style.display = 'none';
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    player.classList.remove('ytev-active');
  }

  const isTransparentBg = (bg) =>
    !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(bg);

  // Элементы, которые реально рисуют фон «плашки»: у обёрток (например,
  // .ytp-time-display) фон часто прозрачный, а видимая плашка — на
  // вложенном элементе; бывает и наоборот — полупрозрачный фон висит на
  // высокой обёртке. Поэтому собираем ВСЕ элементы с непрозрачным фоном
  // правдоподобной высоты, а образцом берём самый низкий: настоящая
  // плашка — самый компактный фоновый элемент строки.
  function collectSurfaces(root, out) {
    if (!root || !root.isConnected) return;
    const queue = [root];
    while (queue.length) {
      const el = queue.shift();
      if (el === ui.box || ui.box.contains(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none') continue;
      if (!isTransparentBg(s.backgroundColor)) {
        const h = el.getBoundingClientRect().height;
        // мелочь (переключатели, бейджи) и растянутые панели отсеиваем
        if (h >= 24 && h <= 80) out.push({ el, style: s, h });
      }
      for (const c of el.children) queue.push(c);
    }
  }

  // Свою рамку рисуем сами, копируя оформление с реально видимой плашки
  // той же строки (время, правые кнопки, пилюля-донор): ширина штатной
  // «пилюли» управляется скриптами YouTube под её собственное содержимое,
  // поэтому вставлять ползунок внутрь неё нельзя — он вылезает за фон.
  // Копирование с живого элемента даёт точное совпадение размеров и
  // оформления в любой версии интерфейса и теме; в старом интерфейсе
  // фоновых плашек нет — блок остаётся прозрачным.
  function syncFrameStyle() {
    const player = getPlayer();
    if (uiResizeObserver && observedPill && isShorts()) {
      uiResizeObserver.unobserve(observedPill);
      observedPill = null;
    }
    // В Shorts копировать не с чего (плашек в плеере нет), поэтому рамку
    // задаём сами — тёмная «пилюля» в стиле кнопок YouTube, размеры от
    // ширины плеера, чтобы вписываться в любой размер окна
    if (ui.overlay) {
      const w = player ? player.clientWidth : 0;
      if (!w) return;
      const h = Math.max(30, Math.min(46, Math.round(w * 0.1)));
      const pad = Math.max(6, Math.round(h * 0.23));
      if (!shortsGap) shortsGap = Math.max(8, Math.round(h * 0.32));
      if (!shortsInset) shortsInset = Math.max(3, Math.round(h * 0.09));
      const st = ui.box.style;
      ui.box.classList.add('ytev-framed');
      st.background = 'rgba(0, 0, 0, .6)';
      st.borderRadius = h / 2 + 'px';
      st.height = h + 'px';
      st.margin = '0'; // положение задаёт слой (positionOverlay)
      st.setProperty('--ytev-pad', pad + 'px');
      st.setProperty('--ytev-hl-inset', shortsInset + 'px');
      st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(h / 2 - shortsInset)) + 'px');
      st.backdropFilter = '';
      return;
    }
    // строка кнопок Shorts: копируем оформление штатного блока громкости
    if (isShorts() && shortsFrame) {
      const st = ui.box.style;
      const h = shortsFrame.height;
      const pad = Math.max(6, Math.round(h * 0.23));
      if (!shortsInset) shortsInset = Math.max(3, Math.round(h * 0.09));
      ui.box.classList.add('ytev-framed');
      st.background = shortsFrame.bg;
      st.borderRadius = shortsFrame.radius;
      st.height = h + 'px';
      st.margin = '0';
      st.setProperty('--ytev-pad', pad + 'px');
      st.setProperty('--ytev-hl-inset', shortsInset + 'px');
      st.setProperty(
        '--ytev-hl-radius',
        Math.max(4, Math.round((parseFloat(shortsFrame.radius) || h / 2) - shortsInset)) + 'px'
      );
      st.backdropFilter = '';
      return;
    }
    const surfaces = [];
    collectSurfaces(player && player.querySelector('.ytp-time-display'), surfaces);
    collectSurfaces(player && player.querySelector('.ytp-right-controls'), surfaces);
    collectSurfaces(findPill(), surfaces);
    let surface = null;
    for (const sf of surfaces) {
      if (!surface || sf.h < surface.h) surface = sf;
    }
    if (uiResizeObserver && (!surface || surface.el !== observedPill)) {
      if (observedPill) uiResizeObserver.unobserve(observedPill);
      observedPill = surface ? surface.el : null;
      if (observedPill) {
        uiResizeObserver.observe(observedPill); // плашка меняет высоту в big-mode
      }
    }
    const st = ui.box.style;
    ui.box.classList.toggle('ytev-framed', !!surface);
    if (!surface) {
      st.background = '';
      st.borderRadius = '';
      st.height = '';
      st.backdropFilter = '';
      st.removeProperty('--ytev-pad');
      st.removeProperty('--ytev-hl-inset');
      st.removeProperty('--ytev-hl-radius');
      return;
    }
    const s = surface.style;
    const h = Math.round(surface.h);
    if (!edgeGap) edgeGap = Math.max(6, Math.round(h * 0.2));
    st.margin = '0 ' + edgeGap + 'px';
    st.background = s.backgroundColor;
    st.borderRadius = s.borderRadius;
    st.height = h + 'px';
    // единый отступ со всех сторон: сверху/снизу его задаёт центровка
    // содержимого (кнопка ужата до «высота минус два отступа»), слева и
    // справа — боковые поля рамки той же величины
    const pad = Math.max(6, Math.round(h * 0.23));
    st.setProperty('--ytev-pad', pad + 'px');
    // зазор подсветки: одна пиксельная величина со всех четырёх сторон,
    // скругление слоя уменьшено на неё же — контуры концентричны
    if (!hlInset) hlInset = Math.max(3, Math.round(h * 0.09));
    const radius = parseFloat(s.borderRadius) || h / 2;
    st.setProperty('--ytev-hl-inset', hlInset + 'px');
    st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(radius - hlInset)) + 'px');
    st.backdropFilter = s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : '';
  }

  // Свободное место под ползунок: идём от нашего блока вверх до строки
  // управления (через любое число обёрток — в новом интерфейсе YouTube
  // кнопки вложены в «пилюли») и на каждом уровне вычитаем соседей вместе
  // с отступами, а у промежуточных обёрток — их собственные поля и рамки.
  function freeSpace(row) {
    let free = innerWidth(row);
    if (free <= 0) return 0; // панель скрыта — измерить нечего

    for (let node = ui.box; node && node !== row; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) return 0; // блок оторван от DOM
      for (const sib of parent.children) {
        if (sib !== node) free -= outerWidth(sib);
      }
      if (parent !== row) {
        const s = getComputedStyle(parent);
        free -=
          num(s.paddingLeft) + num(s.paddingRight) +
          num(s.marginLeft) + num(s.marginRight) +
          num(s.borderLeftWidth) + num(s.borderRightWidth);
      }
    }
    // собственные отступы блока и место под подпись с процентами
    free -= outerWidth(ui.box) - ui.slider.getBoundingClientRect().width;
    return free - SAFETY_GAP;
  }

  // Длина ползунка = настраиваемая доля ширины плеера, ограниченная
  // свободным местом; по краям рамки — постоянный зазор edgeGap. Если
  // места мало, сначала убираем подпись с процентами, а если и это не
  // помогло — прячем ползунок и возвращаем штатный (мини-плеер, узкое
  // окно).
  function layout() {
    if (!ui) return;
    // идёт анимация сворачивания — замеры бессмысленны, вернёмся тиком позже
    if (ui.box.classList.contains('ytev-animating')) return;
    const player = getPlayer();
    if (!player) return;

    // Shorts: блок стоит либо в строке кнопок самого Shorts (она вне
    // элемента плеера, соседей для расчёта нет), либо в своём слое —
    // длину в обоих случаях берём от ширины плеера по своей настройке
    if (ui.overlay || ui.shortsRow) {
      const wasFolded = ui.box.classList.contains('ytev-collapsed');
      ui.box.classList.remove('ytev-collapsed');
      enterNormal(player);
      ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
      // кнопка у правого края — раскрываемся влево
      ui.box.classList.toggle('ytev-mirrored', !!shortsAnchor && shortsAnchor.fx > 0.5);
      syncFrameStyle();
      const pw = player.clientWidth;
      if (!pw) return;
      ui.slider.style.width = MIN_SLIDER + 'px';
      const extra = ui.box.getBoundingClientRect().width - MIN_SLIDER;
      // в строке кнопок место считаем от её левого края до края плеера
      const room = ui.overlay
        ? pw - 2 * shortsGap - extra
        : player.getBoundingClientRect().right -
          ui.box.parentElement.getBoundingClientRect().left -
          extra -
          16;
      const width = Math.max(MIN_SLIDER, Math.min(pw * (activeScale() / 100), room));
      ui.slider.style.width = Math.round(width) + 'px';
      ui.trackW = ui.slider.getBoundingClientRect().width;
      ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
      updateUI();
      if (wasFolded) updateCollapsed(false);
      if (ui.overlay) positionOverlay();
      return;
    }

    // строка управления — ближайший предок, в котором есть и правые кнопки
    const rightControls = player.querySelector('.ytp-right-controls');
    let row = ui.box.parentElement;
    while (row && row !== player && !(rightControls && row.contains(rightControls))) {
      row = row.parentElement;
    }
    if (!row) return;

    // меряем в развёрнутом видимом состоянии и без штатного ползунка,
    // иначе решение зависело бы от предыдущего и режим отката «залипал» бы
    const wasCollapsed = ui.box.classList.contains('ytev-collapsed');
    ui.box.classList.remove('ytev-collapsed');
    enterNormal(player);
    ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
    syncFrameStyle(); // поля рамки влияют на замер — обновляем до него
    if (innerWidth(row) <= 0) {
      if (wasCollapsed) updateCollapsed(false);
      return;
    }

    // Меряем, сжав ползунок до минимума: соседи (название главы) тоже
    // умеют сжиматься, и замер при текущей длине зависел бы от неё самой —
    // размер бы «дрожал» между двумя значениями. От минимума результат
    // один и тот же независимо от предыдущего состояния.
    ui.slider.style.width = MIN_SLIDER + 'px';

    let free = freeSpace(row);
    if (free < MIN_SLIDER && SETTINGS.showPercent) {
      ui.label.style.display = 'none';
      free = freeSpace(row);
    }

    // длина — настраиваемая доля ширины плеера, ограниченная свободным местом
    const desired = player.clientWidth * (activeScale() / 100);
    ui.slider.style.width =
      Math.round(Math.max(MIN_SLIDER, Math.min(desired, free))) + 'px';

    checkRowOverlap();
    if (!ui) return; // пересобрались в другом месте — раскладку доделает новый цикл

    // размеры дорожки и бегунка для расчёта заливки (см. paint)
    ui.trackW = ui.slider.getBoundingClientRect().width;
    ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
    updateUI();

    // подстраховка на случай неточного замера: если flex всё-таки сжал
    // ползунок до бесполезной длины — отдаём место штатному
    if (ui.slider.getBoundingClientRect().width < MIN_SLIDER - 1) {
      enterFallback(player);
    } else if (wasCollapsed) {
      updateCollapsed(false); // вернуть свёрнутое состояние без анимации
    }
  }

  // Автосворачивание: класс ytev-collapsed ставится, когда включена
  // настройка и на блоке нет ни курсора, ни фокуса. Переходы включаются
  // только на время переключения, чтобы не мешать замерам layout().
  let collapseTimer = 0;
  let animTimer = 0;
  function updateCollapsed(animate = true) {
    if (!ui) return;
    // разворот держит только клавиатурный фокус (:focus-visible) — обычный
    // клик по кнопке оставляет фокус внутри блока и не должен мешать
    // сворачиванию
    let keyboardFocus = false;
    try {
      keyboardFocus = !!ui.box.querySelector(':focus-visible');
    } catch {}
    const want = !!SETTINGS.autoCollapse && !ui.hover && !keyboardFocus;
    if (want === ui.box.classList.contains('ytev-collapsed')) return;
    if (!animate) {
      ui.box.classList.toggle('ytev-collapsed', want);
      return;
    }
    ui.box.classList.add('ytev-animating');
    ui.box.classList.toggle('ytev-collapsed', want);
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      if (ui) ui.box.classList.remove('ytev-animating');
      scheduleLayout();
    }, 350);
  }

  function unbindVideo() {
    if (!videoBinding) return;
    const { video, onVolumeChange, restoreAfterMediaChange, onMediaProgress } =
      videoBinding;
    video.removeEventListener('volumechange', onVolumeChange);
    video.removeEventListener('loadedmetadata', restoreAfterMediaChange);
    video.removeEventListener('playing', restoreAfterMediaChange);
    for (const type of LOUDNESS_EVENTS) video.removeEventListener(type, onMediaProgress);
    videoBinding = null;
    boundVideo = null;
  }

  function bindVideo() {
    if (!volumeStateLoaded) return;
    const video = getVideo();
    if (!video || video === boundVideo) return;
    unbindVideo();
    boundVideo = video;
    if (isShorts()) beginShortsMountWait();
    // Новый элемент — новое окно подавления autoplay-mute: в Shorts каждая
    // лента приходит со своим <video>, и именно на первых кадрах YouTube
    // успевает выставить mute до того, как мы восстановим состояние.
    mutedGuardUntil = Date.now() + MUTED_GUARD_MS;
    // Новый ролик — новый уровень: прежнее решение снимаем сразу, новое
    // появится, как только снимок станет согласованным.
    resetLoudness();
    refreshLoudness();
    const current = Number(logicalOf(video));
    if (!validVolume(preferredVolume) && validVolume(current)) {
      rememberVolume(current);
    } else {
      restorePreferredState(video);
    }
    const onVolumeChange = () => {
      if (video !== boundVideo) return;
      const value = Number(logicalOf(video));
      // Осознанные стрелки, колесо и штатные контролы обновляют общий
      // уровень. Записи без недавнего пользовательского ввода считаются
      // служебным сбросом YouTube и не перетирают сохранённое значение.
      if (hasVolumeIntent(video) && validVolume(value)) {
        rememberVolume(value, true);
      } else {
        restorePreferredVolume(video);
      }
      if (hasMutedIntent() || (SETTINGS.useNativeSlider && hasVolumeIntent(video))) {
        rememberMuted(video.muted, true);
      } else if (
        typeof preferredMuted === 'boolean' &&
        video.muted !== preferredMuted
      ) {
        restorePreferredState(video);
      }
      updateUI();
    };
    const restoreAfterMediaChange = () => {
      setTimeout(() => {
        if (video !== getVideo()) return;
        restorePreferredState(video);
        updateUI();
      }, 0);
    };
    // Решение о выравнивании обновляем по событиям самой дорожки, а не по
    // часам: именно к этим моментам плеер и досоздаёт то, чего не хватало
    // снимку. Секундный тик остаётся страховкой.
    const onMediaProgress = () => {
      if (video === boundVideo) refreshLoudness();
    };
    videoBinding = { video, onVolumeChange, restoreAfterMediaChange, onMediaProgress };
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('loadedmetadata', restoreAfterMediaChange);
    video.addEventListener('playing', restoreAfterMediaChange);
    for (const type of LOUDNESS_EVENTS) video.addEventListener(type, onMediaProgress);
    updateUI();
  }

  // Пересчёт по любому изменению размеров откладываем до следующего
  // кадра: layout() сам меняет ширину ползунка, и синхронный вызов из
  // ResizeObserver зациклил бы наблюдатель. Повторные вызовы схлопываются.
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  // Плеер меняет размер при разворачивании, режиме театра, ресайзе окна;
  // рамка вокруг ползунка — ещё и при наведении и перестройках интерфейса
  const playerResizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;
  const uiResizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;
  const observedChain = new Set();

  function observePlayer() {
    const player = getPlayer();
    if (!playerResizeObserver || !player || player === observedPlayer) return;
    if (observedPlayer) playerResizeObserver.unobserve(observedPlayer);
    playerResizeObserver.observe(player);
    observedPlayer = player;
  }

  // Следим за всеми контейнерами от ползунка до плеера: если рамка (или
  // любая обёртка) изменит размер, длина пересчитается сразу, а не по
  // секундному таймеру
  function observeChain() {
    if (!uiResizeObserver || !ui) return;
    for (const el of observedChain) uiResizeObserver.unobserve(el);
    observedChain.clear();
    const player = getPlayer();
    for (let el = ui.box.parentElement; el && el !== player; el = el.parentElement) {
      uiResizeObserver.observe(el);
      observedChain.add(el);
    }
  }

  function stopObservingUI() {
    if (playerResizeObserver) playerResizeObserver.disconnect();
    if (uiResizeObserver) uiResizeObserver.disconnect();
    observedPlayer = null;
    observedPill = null;
    observedChain.clear();
  }

  const SHORTS_NATIVE_MOUNT_GRACE_MS = 700;
  let shortsMountWaitUntil = isShorts()
    ? Date.now() + SHORTS_NATIVE_MOUNT_GRACE_MS
    : 0;
  let shortsMountRetryTimer = 0;

  function beginShortsMountWait() {
    if (!isShorts()) return;
    shortsMountWaitUntil = Date.now() + SHORTS_NATIVE_MOUNT_GRACE_MS;
  }

  function waitForShortsNativeMount() {
    if (!isShorts()) return false;
    const remaining = shortsMountWaitUntil - Date.now();
    if (remaining <= 0) return false;
    clearTimeout(shortsMountRetryTimer);
    shortsMountRetryTimer = setTimeout(() => {
      shortsMountRetryTimer = 0;
      ensureUI();
    }, Math.min(80, remaining));
    return true;
  }

  // Куда встраивать блок. На обычной странице — в строку управления
  // плеера. В Shorts своей строки управления нет (у плеера минимальная
  // обвязка, которая ещё и меняется от версии к версии), поэтому кладём
  // блок в собственный слой поверх плеера, слева сверху — там свободно.
  function findMount() {
    const player = getPlayer();
    if (!player) return null;
    // В Shorts лучшее место — строка кнопок самого Shorts
    // (ytd-shorts-player-controls): встаём в неё рядом с паузой, ровно
    // на место штатного блока громкости, и наследуем его поведение,
    // включая автоскрытие вместе с остальными кнопками.
    if (isShorts()) {
      const volumeHost = shortsVolumeHost();
      const row = volumeHost && volumeHost.parentElement;
      if (row) {
        captureShortsFrame(volumeHost);
        shortsMountAnchor = volumeHost;
        return { host: row, before: volumeHost, overlay: false };
      }
      // Новый Shorts сначала создаёт видео, а штатную строку кнопок добавляет
      // несколькими кадрами позже. Не показываем на это время резервную тёмную
      // кнопку: ранний CSS уже спрятал штатную, а короткий поиск обычно успевает
      // найти её настоящий контейнер и сразу построить окончательный интерфейс.
      if (waitForShortsNativeMount()) return null;
    }
    // Иначе штатная строка управления плеера. Исключение — если в Shorts
    // полоса перемотки размещена поверх строки: тогда наша шкала легла бы
    // на неё внахлёст, и мы уходим в накладной слой (см. checkRowOverlap).
    const controls = player.querySelector('.ytp-left-controls');
    if (controls && controls.clientWidth && !(isShorts() && shortsRowUnusable)) {
      return { host: controls, overlay: false };
    }
    if (!isShorts()) return null;
    // Строки управления нет — кладём блок в собственный слой поверх плеера
    let host = player.querySelector(':scope > .ytev-overlay');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ytev-overlay';
      // слой позиционируется от плеера — он должен быть точкой отсчёта
      if (getComputedStyle(player).position === 'static') {
        player.style.position = 'relative';
      }
      player.appendChild(host);
    }
    return { host, overlay: true };
  }

  // Автоскрытие накладного блока: пока указатель на ролике — блок виден,
  // ушёл — исчезает, как штатные кнопки Shorts. Признак вешаем на саму
  // ленту, а не на слой: слой пересоздаётся, а обработчики остаются.
  const pointerWatched = new WeakSet();
  function watchPointer(player) {
    const scope = shortsScope() || player;
    if (pointerWatched.has(scope)) return;
    pointerWatched.add(scope);
    let hideTimer = 0;
    const show = () => {
      clearTimeout(hideTimer);
      scope.classList.remove('ytev-pointer-away');
    };
    const hide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => scope.classList.add('ytev-pointer-away'), 400);
    };
    scope.addEventListener('pointerenter', show);
    scope.addEventListener('pointermove', show);
    scope.addEventListener('pointerleave', hide);
  }

  // Проверка на нахлёст со штатной полосой перемотки: в Shorts она может
  // лежать поверх строки управления, и тогда встроенная в строку шкала
  // накрывает её. Заметив это, навсегда переходим на накладной слой.
  let shortsRowUnusable = false;
  function checkRowOverlap() {
    if (!ui || ui.overlay || !isShorts() || shortsRowUnusable) return;
    const player = getPlayer();
    if (!player) return;
    const box = ui.box.getBoundingClientRect();
    if (!box.width) return;
    const bars = player.querySelectorAll(
      '.ytp-progress-bar-container, .ytp-progress-bar, [class*="progress-bar" i]'
    );
    for (const bar of bars) {
      const r = bar.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const ix = Math.min(box.right, r.right) - Math.max(box.left, r.left);
      const iy = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
      // полоса перемотки тонкая (4px), поэтому порог по вертикали
      // минимальный — иначе полное перекрытие не считалось бы нахлёстом
      if (ix > 2 && iy > 1) {
        shortsRowUnusable = true;
        ensureUI(); // пересобираемся в слое поверх плеера
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Скрытие штатной громкости в Shorts
   *
   * На обычной странице хватает класса ytev-active на плеере: штатные
   * кнопка и ползунок лежат внутри него. В Shorts же управление звуком
   * рисует обвязка ленты — она вне элемента плеера, и селектор до неё
   * не доставал, из-за чего рядом с нашей шкалой оставалась вторая,
   * штатная. Имён у этих элементов в новом интерфейсе несколько, поэтому
   * ищем по признаку «volume/mute» в классе или id, ограничиваясь
   * небольшими элементами (кнопка, а не контейнер всей панели).
   * ------------------------------------------------------------------ */

  // Узел → его прежний inline-display. Именно Map, а не Set: элемент мог
  // иметь собственный inline-стиль, и возврат пустой строкой его терял.
  const hiddenNative = new Map();
  // в новом интерфейсе классы в camelCase (ytdVolumeControlsHost), поэтому
  // без требования не-буквы перед словом — иначе такие имена не находились
  const VOLUME_HINT = /volume|mute/i;
  // место штатной кнопки звука в долях размера плеера — на него встаёт
  // наш блок, поэтому доли, а не пиксели: переживает смену размеров
  let shortsAnchor = null;

  const isButtonLike = (el, r) =>
    el.tagName === 'BUTTON' ||
    el.getAttribute('role') === 'button' ||
    Math.abs(r.width - r.height) < 12;

  // активная лента: атрибута is-active в новом интерфейсе нет, зато
  // отрисованная лента лежит в #reel-overlay-container
  function activeReel() {
    return (
      document.querySelector('ytd-reel-video-renderer[is-active]') ||
      document.querySelector(
        '#reel-overlay-container ytd-reel-video-renderer'
      ) ||
      document.querySelector('ytd-reel-video-renderer')
    );
  }

  const shortsScope = () =>
    activeReel() ||
    document.querySelector('#shorts-container') ||
    document.querySelector('ytd-shorts');

  // Оформление снимаем со штатного блока громкости Shorts до того, как
  // его скроем: фон там рисует вложенный «скрим», поэтому ищем первый
  // элемент с непрозрачным фоном
  let shortsFrame = null;
  function captureShortsFrame(el) {
    if (shortsFrame || !el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.height) return;
    let painted = null;
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const s = getComputedStyle(node);
      if (s.display !== 'none' && !isTransparentBg(s.backgroundColor)) {
        painted = s;
        break;
      }
    }
    shortsFrame = {
      bg: painted ? painted.backgroundColor : 'rgba(0, 0, 0, .6)',
      radius: painted ? painted.borderRadius : Math.round(rect.height / 2) + 'px',
      height: Math.round(rect.height),
    };
  }

  // Штатный блок громкости Shorts — <volume-controls> в строке кнопок
  // ytd-shorts-player-controls; он лежит вне элемента плеера
  let shortsMountAnchor = null; // рядом с ним стоим; помним и после скрытия
  function shortsVolumeHost() {
    // Мы сами скрываем штатный блок, и по размерам его больше не найти —
    // поэтому держим ссылку. Без этого точка монтирования «терялась»
    // после первого же тика, и блок скакал между строкой и слоем.
    if (shortsMountAnchor && shortsMountAnchor.isConnected) return shortsMountAnchor;
    const reel = activeReel() || document;
    const el =
      reel.querySelector('volume-controls, .ytdVolumeControlsHost') ||
      reel.querySelector('ytd-shorts-player-controls [class*="volume" i]');
    if (!el) return null;
    if (hiddenNative.has(el)) return el; // спрятан нами — всё равно годится
    return el.getBoundingClientRect().width ? el : null;
  }

  function hideNativeVolume() {
    const scope = shortsScope();
    if (!scope) return;
    // Функция вызывается на каждом тике, а лента Shorts бесконечно
    // пересоздаёт свои узлы. Без чистки набор удерживал бы отсоединённые
    // поддеревья всех просмотренных роликов до самого выключения.
    for (const el of hiddenNative.keys()) {
      if (!el.isConnected) hiddenNative.delete(el);
    }
    const player = getPlayer();
    const pr = player ? player.getBoundingClientRect() : null;
    const candidates = [
      ...scope.querySelectorAll(
        '.ytp-mute-button, .ytp-volume-panel, .ytp-volume-area,' +
          '[class*="volume" i], [class*="mute" i], [id*="volume" i], [id*="mute" i]'
      ),
    ].filter((el) => {
      if (hiddenNative.has(el)) return false;
      if (el.closest('.ytev-box, .ytev-overlay')) return false; // наше собственное
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!VOLUME_HINT.test(cls) && !VOLUME_HINT.test(el.id || '')) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false; // уже не видно
      return r.width <= 160 && r.height <= 160; // это кнопка, а не контейнер
    });

    // Якорь выбираем ДО того, как что-то скроем: контейнер громкости идёт
    // в списке раньше кнопки внутри него, и, скрыв его первым, мы бы
    // измеряли кнопку с нулевыми размерами и потеряли место
    if (!shortsAnchor && pr && pr.width && pr.height) {
      const button = candidates.find((el) => isButtonLike(el, el.getBoundingClientRect()));
      if (button) {
        const r = button.getBoundingClientRect();
        shortsAnchor = {
          fx: (r.left + r.width / 2 - pr.left) / pr.width,
          fy: (r.top + r.height / 2 - pr.top) / pr.height,
        };
      }
    }

    for (const el of candidates) {
      hiddenNative.set(el, el.style.display);
      el.dataset.ytevHidden = '1';
      el.style.display = 'none';
    }
  }

  function restoreNativeVolume() {
    for (const [el, display] of hiddenNative) {
      if (el.isConnected && el.dataset.ytevHidden) {
        el.style.display = display || '';
        delete el.dataset.ytevHidden;
      }
    }
    hiddenNative.clear();
    shortsAnchor = null;
    shortsMountAnchor = null;
  }

  // Ставим блок ровно на место штатной кнопки звука: совмещаем центр
  // нашей кнопки с запомненным центром штатной, а шкала разворачивается
  // вправо — как выезжает штатная. Если запомнить не удалось, кладём в
  // угол плеера с обычным отступом.
  function positionOverlay() {
    if (!ui || !ui.overlay) return;
    const player = getPlayer();
    const host = ui.box.parentElement;
    if (!player || !host) return;
    const pr = player.getBoundingClientRect();
    if (!pr.width) return;
    if (!shortsAnchor) {
      host.style.left = shortsGap + 'px';
      host.style.top = shortsGap + 'px';
      return;
    }
    const cur = {
      left: parseFloat(host.style.left) || 0,
      top: parseFloat(host.style.top) || 0,
    };
    const btn = ui.muteBtn.getBoundingClientRect();
    const wantX = pr.left + shortsAnchor.fx * pr.width;
    let wantY = pr.top + shortsAnchor.fy * pr.height;
    // если штатная кнопка сидит в панели управления, встаём НАД панелью:
    // иначе развёрнутая шкала накрыла бы полосу перемотки
    const bar = player.querySelector('.ytp-chrome-bottom');
    const barRect = bar && bar.getBoundingClientRect();
    if (barRect && barRect.height && wantY > barRect.top - 1) {
      const box = ui.box.getBoundingClientRect();
      wantY = barRect.top - shortsGap - box.height / 2;
    }
    host.style.left = Math.round(cur.left + wantX - (btn.left + btn.width / 2)) + 'px';
    host.style.top = Math.round(cur.top + wantY - (btn.top + btn.height / 2)) + 'px';

    // не даём блоку вылезти за пределы плеера
    const box = ui.box.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (box.right > pr.right - shortsGap) dx = pr.right - shortsGap - box.right;
    if (box.left + dx < pr.left + shortsGap) dx = pr.left + shortsGap - box.left;
    if (box.bottom > pr.bottom - shortsGap) dy = pr.bottom - shortsGap - box.bottom;
    if (box.top + dy < pr.top + shortsGap) dy = pr.top + shortsGap - box.top;
    if (dx || dy) {
      host.style.left = Math.round((parseFloat(host.style.left) || 0) + dx) + 'px';
      host.style.top = Math.round((parseFloat(host.style.top) || 0) + dy) + 'px';
    }
  }

  // Полный демонтаж: штатная громкость возвращается на место
  function teardownUI() {
    setEarlyNativeHidden(false, true);
    stopObservingUI();
    restoreNativeVolume();
    for (const el of document.querySelectorAll('.ytev-active')) {
      el.classList.remove('ytev-active');
    }
    if (ui && ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    for (const box of document.querySelectorAll('.ytev-box')) box.remove();
    for (const host of document.querySelectorAll('.ytev-overlay')) host.remove();
    ui = null;
  }

  function ensureUI() {
    // Не рисуем значок из временного autoplay-состояния YouTube. Обычно
    // bridge отвечает ещё до появления плеера; синхронный кэш выше при
    // повторных открытиях позволяет применить mute ещё раньше.
    if (!volumeStateLoaded) return;
    // режим «штатная шкала»: свой блок не строим, но кривая продолжает
    // работать — её применяет перехватчик громкости
    if (SETTINGS.useNativeSlider) {
      setEarlyNativeHidden(false, true);
      if (ui) teardownUI();
      bindVideo();
      return;
    }
    const mount = findMount();
    if (!mount) return;
    const controls = mount.host;
    observePlayer();
    // в Shorts штатная громкость может лежать и вне плеера (обвязка
    // ленты) — правила для плеера туда не достают, прячем отдельно
    if (isShorts()) {
      hideNativeVolume();
      watchPointer(getPlayer()); // автоскрытие вместе с уходом указателя
    } else if (hiddenNative.size) {
      restoreNativeVolume();
    }
    if (ui && controls.contains(ui.box)) {
      if (ui.hiddenPill && !ui.hiddenPill.isConnected) markDonorPill(controls);
      bindVideo();
      layout();
      return;
    }

    // Сейчас будет собран новый блок, поэтому убираем ВСЕ прежние —
    // включая текущий. Раньше текущий пропускался, и при смене точки
    // монтирования (накладной слой → строка управления, пересоздание
    // плеера) на странице оставались два блока внахлёст.
    for (const stale of document.querySelectorAll('.ytev-box')) {
      const orphanMute = stale.querySelector('.ytp-mute-button');
      if (orphanMute) stale.before(orphanMute); // живую штатную кнопку возвращаем
      stale.remove();
    }
    ui = null;
    // опустевшие слои тоже убираем, кроме того, куда сейчас встаём
    for (const host of document.querySelectorAll('.ytev-overlay')) {
      if (host !== controls && !host.querySelector('.ytev-box')) host.remove();
    }

    const box = document.createElement('div');
    box.className = 'ytev-box ytev-initializing';

    // Своя кнопка звука: значок предсказуемо центрирован при любом размере
    const muteBtn = document.createElement('button');
    muteBtn.className = 'ytev-mute';
    muteBtn.type = 'button';
    muteBtn.setAttribute('aria-keyshortcuts', 'm');
    muteBtn.appendChild(buildIcon());
    muteBtn.addEventListener('click', () => {
      const player = getPlayer();
      const video = getVideo();
      if (!video) return;
      const silent = video.volume === 0;
      if (video.muted || silent) {
        rememberMuted(false, true);
        if (player && typeof player.unMute === 'function') player.unMute();
        video.muted = false;
        // На нулевой громкости снятия mute мало: уровень остаётся нулевым и
        // кнопка выглядит мёртвой (щёлкаешь — тишина, и обратно не
        // выключается). Возвращаем последний слышимый уровень, как это
        // делает штатная кнопка YouTube, через общий путь ползунка — он
        // сам снимет mute у плеера, сохранит значение и отложенно отдаст
        // его в настройки YouTube.
        if (silent && ui) {
          ui.slider.value = String(lastAudibleVolume * 100);
          applySliderValue(ui.slider);
        }
      } else {
        rememberMuted(true, true);
        if (player && typeof player.mute === 'function') player.mute();
        else video.muted = true;
      }
    });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.1';
    slider.className = 'ytev-slider';
    slider.setAttribute('aria-label', STRINGS.playerSliderLabel);

    const label = document.createElement('span');
    label.className = 'ytev-label';

    box.append(muteBtn, slider, label);

    if (mount.before && mount.before.isConnected) {
      mount.before.after(box); // ровно на место штатного блока громкости
    } else if (mount.overlay) {
      controls.appendChild(box); // свой слой поверх плеера Shorts
    } else {
      // встаём после «пилюли» с кнопками, а не внутрь неё: YouTube управляет
      // её шириной из скриптов под собственное содержимое, и вставленный
      // внутрь ползунок вылезал за фон. Рамку блок рисует сам (syncFrameStyle)
      let anchor = controls.querySelector('.ytp-volume-area, .ytp-mute-button');
      while (anchor && anchor.parentElement !== controls) anchor = anchor.parentElement;
      if (anchor) anchor.after(box);
      else controls.appendChild(box);
    }

    // стрелки должны двигать ползунок (шаг 0.1%), а не перематывать видео
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    // автосворачивание: следим за курсором и фокусом на блоке
    box.addEventListener('mouseenter', () => {
      if (!ui) return;
      ui.hover = true;
      clearTimeout(collapseTimer);
      updateCollapsed();
    });
    box.addEventListener('mouseleave', () => {
      if (!ui) return;
      ui.hover = false;
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(updateCollapsed, 500);
    });
    box.addEventListener('focusin', () => updateCollapsed());
    box.addEventListener('focusout', () => setTimeout(updateCollapsed, 0));
    // колесо мыши над ползунком: ±1%, с Shift ±0.1%
    box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 0.1 : 1;
        const cur = Number(slider.value);
        slider.value = Math.min(100, Math.max(0, cur + (e.deltaY < 0 ? step : -step)));
        applySliderValue(slider);
      },
      { passive: false }
    );

    ui = {
      box, slider, label, muteBtn,
      hover: false,
      overlay: mount.overlay,
      shortsRow: !!mount.before,
    };
    markDonorPill(controls);
    observeChain();
    bindVideo();
    updateUI();
    layout();
    updateCollapsed(false);
    requestAnimationFrame(() => {
      if (box.isConnected) box.classList.remove('ytev-initializing');
    });
  }

  // Во время регулировки громкость пишется ТОЛЬКО напрямую в
  // video.volume — одно точное значение на событие. Вызов
  // player.setVolume на каждом событии давал по две быстрые записи
  // чуть разных значений (округлённое YouTube + наше точное) — слышимый
  // треск; а дробное число в setVolume YouTube мог переокруглять сам и
  // потрескивать даже без движения ползунка. Сохранение громкости в
  // настройках YouTube делаем отложенно, один раз после конца движения
  // и только целым числом.
  let persistTimer = 0;
  function applySliderValue(slider = ui && ui.slider) {
    const video = getVideo();
    const player = getPlayer();
    if (!video || !slider) return;
    const pct = Math.min(100, Math.max(0, Number(slider.value)));
    if (pct > 0) rememberMuted(false, true);
    if (video.muted && pct > 0) {
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    if (pct === 0) rememberMuted(video.muted, true);
    rememberVolume(pct / 100, true);
    video.volume = pct / 100;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const p = getPlayer();
      const v = getVideo();
      if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(pct));
      if (v) v.volume = pct / 100; // вернуть точное значение после округления
    }, 250);
  }

  // Строка управления Shorts перехватывает bubbling/capture-события своих
  // дочерних контролов. Из-за этого нативный range визуально двигался, но
  // его собственный input-обработчик мог вообще не вызываться. Ловим input
  // раньше обвязки YouTube — на window в capture-фазе.
  //
  // Проверки обязательны в обе стороны. Раньше условием было «у элемента
  // есть класс ytev-slider», и любой скрипт страницы мог создать свой
  // <input class="ytev-slider">, послать ненастоящий input и крутить
  // громкость. Берём только настоящее событие и только со своего ползунка.
  // Регистрация стоит здесь, а не в начале функции: до объявления ui
  // обработчик обращался бы к переменной в TDZ.
  on(
    window,
    'input',
    (e) => {
      if (!e.isTrusted) return;
      if (SETTINGS.useNativeSlider && applyTrustedNativeVolume(e.target)) {
        return;
      }
      if (!ui || e.target !== ui.slider) return;
      applySliderValue(ui.slider);
    },
    true
  );

  applyTrustedPayload(initialPayload, true);

  // YouTube — SPA: плеер может появляться/пересоздаваться при навигации.
  const tick = setInterval(() => {
    // YouTube регулярно заменяет <video> в Shorts. Не оставляем старые
    // слушатели и JS-ссылки жить до конца вкладки.
    for (const [el, node] of audio.liveNodes) {
      if (!el.isConnected) fallbackToDirect(el, node);
    }
    bindVideo();
    ensureUI();
    refreshLoudness(); // ответ плеера приходит позже, чем появляется <video>
  }, 1000);
  const prepareForNavigation = () => {
    // Переход — самый ранний сигнал смены ролика, раньше нового <video>.
    resetLoudness();
    if (!SETTINGS.useNativeSlider) {
      setEarlyNativeHidden(true);
      beginShortsMountWait();
    }
  };
  const refreshAfterNavigation = () =>
    setTimeout(() => {
      bindVideo();
      ensureUI();
    }, 0);
  on(document, 'yt-navigate-start', prepareForNavigation);
  on(document, 'yt-navigate-finish', refreshAfterNavigation);
  on(document, 'DOMContentLoaded', refreshAfterNavigation);
  on(document, 'fullscreenchange', () => setTimeout(layout, 0));
  on(window, 'resize', layout);

  // Регистрация перезаписываемая: иначе следующее поколение (перезагрузка
  // расширения) не смогло бы встать на место мёртвого экземпляра, а
  // страница, заранее занявшая ключ, выключала бы расширение навсегда.
  // Провал defineProperty (ключ занят неперезаписываемым чужим значением)
  // не фатален: без регистрации теряется только живое обновление настроек.
  try {
    Object.defineProperty(window, INSTANCE_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: instanceApi,
    });
  } catch {}
  return true;

  // Полная остановка экземпляра. Вызывается только следующим поколением и
  // только до того, как оно захватит дескрипторы: сначала мы возвращаем
  // нативные volume/muted, потом преемник берёт их уже чистыми.
  function disposeInstance() {
    clearInterval(tick);
    clearTimeout(saveVolumeTimer);
    clearTimeout(saveMutedTimer);
    clearTimeout(persistTimer);
    clearTimeout(earlyHideSafetyTimer);
    clearTimeout(shortsMountRetryTimer);
    for (const off of teardown.splice(0)) {
      try {
        off();
      } catch {}
    }
    try {
      teardownUI();
      unbindVideo();
    } catch {}
    if (document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.remove(
        EARLY_HIDE_CLASS,
        EARLY_HIDE_MANAGED_CLASS
      );
    }
    // Граф Web Audio необратим: элемент навсегда привязан к первому
    // MediaElementAudioSourceNode, и преемник уже не сможет его создать.
    // Поэтому не бросаем элементы с чужим усилением — переводим их на
    // прямую запись громкости тем же путём, что и сторож тишины.
    for (const [el, node] of [...audio.liveNodes]) {
      fallbackToDirect(el, node);
    }
    Object.defineProperty(mediaProto, 'volume', nativeDesc);
    Object.defineProperty(mediaProto, 'muted', nativeMutedDesc);
  }
}
