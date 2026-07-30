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
  // Подавление autoplay-mute. Открывается на каждый новый <video> и
  // закрывается фактом, а не часами: как только на элементе начался звук,
  // решение об автозапуске уже принято и подавлять нечего. Прежние три
  // секунды были догадкой о длительности запуска — на медленной машине
  // YouTube успевал заглушить ролик уже после окна, на быстрой окно зря
  // висело над честными действиями пользователя.
  let mutedGuardOpen = false;
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
          normalizeLoudness: SETTINGS.normalizeLoudness,
          maxBoostDb: SETTINGS.maxBoostDb,
          loudness:
            loudnessCacheId && Number.isFinite(loudnessBoost)
              ? {
                  videoId: loudnessCacheId,
                  trackId: loudnessCacheTrackId,
                  trackItag: loudnessCacheTrackItag,
                  boostDb: Number((20 * Math.log10(loudnessBoost)).toFixed(3)),
                }
              : null,
        })
      );
    } catch {}
  }

  // main.js не читает page-writable localStorage повторно: он получает от
  // preload только уже проверенный и ограниченный ранний уровень, после чего
  // chrome.storage из initialPayload остаётся источником истины.
  const preloadVolume = Number(preloadState && preloadState.volume);
  if (preloadState && validVolume(preloadVolume)) {
    preferredVolume = preloadVolume;
    preferredVolumeDirty = preloadState.volumeDirty === true;
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
  let volumeGestureAt = 0;
  // Сколько времени после самого жеста запись громкости ещё считается его
  // следствием.
  //
  // Полевая находка в Shorts: на первой загрузке меняешь громкость — и она
  // сама уползает вниз. Причина в том, что окно намерения открывалось на
  // секунды (нажатие на ползунок — на пять), а плеер именно в это время
  // применяет СВОЙ сохранённый уровень. Служебная запись попадала в открытое
  // окно и принималась за осознанный выбор: уровень оставался чужим, вместо
  // того чтобы откатиться.
  //
  // Отличает их не величина, а близость к жесту. Свою громкость YouTube
  // пишет синхронно в обработчике события — стрелка, колесо, штатный
  // ползунок дают запись через миллисекунды. Отложенное восстановление
  // приходит само по себе, вне всякого ввода. Полсекунды с запасом
  // покрывают первое и отсекают второе.
  const VOLUME_GESTURE_GRACE_MS = 500;
  const mediaSource = (video) =>
    video ? String(video.currentSrc || video.src || '') : '';
  const markVolumeIntent = (duration = 1200) => {
    volumeIntentVideo = getVideo();
    volumeIntentSource = mediaSource(volumeIntentVideo);
    volumeIntentUntil = Date.now() + duration;
    volumeGestureAt = Date.now();
  };
  const markMutedIntent = (duration = 1200) => {
    mutedIntentUntil = Date.now() + duration;
  };
  // Выключение звука — не жест громкости. Окно, открытое недавней
  // регулировкой, нужно закрыть: реализация mute() у плеера может писать в
  // video.volume, и внутри открытого окна такая запись принималась за
  // осознанный выбор пользователя — сохранённой громкостью становился ноль.
  // Снаружи это выглядело так: «поменял громкость, нажал mute — громкость
  // тоже изменилась». Вне окна та же запись откатывается как служебная.
  const dropVolumeIntent = () => {
    volumeIntentUntil = 0;
    volumeIntentVideo = null;
    volumeIntentSource = '';
    volumeGestureAt = 0;
  };
  const hasVolumeIntent = (video = getVideo()) => {
    if (Date.now() > volumeIntentUntil) return false;
    // Жест мог быть давно: нажатие открывает окно на пять секунд, чтобы
    // пережить долгую протяжку штатного ползунка. Но принимать по нему
    // чужую запись можно, только пока сам жест свежий — иначе в окно
    // попадает отложенное восстановление громкости плеером.
    if (Date.now() - volumeGestureAt > VOLUME_GESTURE_GRACE_MS) return false;
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

  // Переключение звука: одно на кнопку и на клавишу.
  //
  // rescueSilent — поведение кнопки: на нулевой громкости она возвращает
  // последний слышимый уровень, иначе выглядит мёртвой. Клавише это не
  // подходит: у YouTube m на нуле только переключает флаг, и делай мы иначе,
  // одна и та же клавиша вела бы себя по-разному на латинской раскладке
  // (сработал YouTube) и на кириллице (сработали мы).
  function toggleMute(rescueSilent = true) {
    const player = getPlayer();
    const video = getVideo();
    if (!video) return;
    dropVolumeIntent();
    const silent = rescueSilent && video.volume === 0;
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
  }

  function togglePlay(video) {
    const player = getPlayer();
    if (video.paused) {
      if (player && typeof player.playVideo === 'function') player.playVideo();
      else video.play().catch(() => {});
    } else if (player && typeof player.pauseVideo === 'function') {
      player.pauseVideo();
    } else {
      video.pause();
    }
  }

