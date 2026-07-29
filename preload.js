// MAIN world, document_start: удерживает последний проверенный уровень до
// пробуждения service worker и запуска полного main.js.
(() => {
  'use strict';

  const INSTANCE_KEY = Symbol.for('ytev.preload.instance.v1');
  const STATE_CACHE_KEY = 'ytev-volume-state-v1';
  const CHANNEL_PATTERN = /^[a-f0-9]{32}$/;
  const SECRET_PATTERN = /^[a-f0-9]{64}$/;
  // localStorage принадлежит странице YouTube и не является доверенным
  // хранилищем. До прихода состояния из chrome.storage любой ранний результат
  // (включая кэш нормализации) ограничивается этим безопасным потолком.
  const EARLY_SAFE_VOLUME_LIMIT = 0.5;
  const MAX_BOOST_LIMIT_DB = 15;
  // Окно доверия держим таким же коротким, как в bridge.js: за это время
  // YouTube успевает применить жест, а лишние секунды только расширяют
  // промежуток, в который может вклиниться скрипт страницы.
  const INTENT_WINDOW_MS = 2000;
  // Штатная панель YouTube показывает целые проценты, поэтому сверка с ней
  // огрублённая — как ARIA_TOLERANCE в bridge.js.
  const DOM_TOLERANCE = 0.015;

  const existingDescriptor = Object.getOwnPropertyDescriptor(window, INSTANCE_KEY);
  if (existingDescriptor && existingDescriptor.configurable === false) return;

  // Слот реестра занимаем ПЕРВЫМ делом — до всех ранних выходов. Ключ
  // глобального реестра символов угадывается тривиально, а main.js забирает
  // отсюда удержанный уровень. Если preload выйдет, не заняв слот (кэша нет,
  // битый JSON, чужие дескрипторы), объект объявит скрипт страницы, и main.js
  // примет подставленное значение за выбор пользователя. Наружу отдаём
  // замороженный объект с делегирующим takeover: реализация подставляется
  // ниже и остаётся в замыкании, поэтому странице её не подменить.
  let takeoverImpl = () => false;
  let pendingControl = null;
  let activeControl = null;

  const validControl = (value) =>
    value &&
    typeof value === 'object' &&
    typeof value.dispose === 'function' &&
    typeof value.update === 'function' &&
    typeof value.drcRestoreState === 'function';

  // Неизменяемый брокер — единственная точка, через которую service worker
  // обращается к полному MAIN-инстансу. Код страницы видит методы брокера, но
  // не знает 256-битный secret из isolated world и не получает ссылку на
  // control-объект. В отличие от прежнего writable-слота window, подменить
  // callback и дождаться передачи секрета сюда нельзя.
  const beginControl = (channel, secret) => {
    if (!CHANNEL_PATTERN.test(channel) || !SECRET_PATTERN.test(secret)) return false;
    if (activeControl && activeControl.channel === channel) return false;
    if (activeControl) {
      try {
        activeControl.api.dispose();
      } catch {}
    }
    activeControl = null;
    pendingControl = { channel, secret };
    return true;
  };

  const commitControl = (secret, value) => {
    if (
      !pendingControl ||
      secret !== pendingControl.secret ||
      !validControl(value)
    ) {
      return false;
    }
    activeControl = {
      channel: pendingControl.channel,
      secret,
      api: value,
    };
    pendingControl = null;
    return true;
  };

  const cancelControl = (secret) => {
    if (!pendingControl || secret !== pendingControl.secret) return false;
    pendingControl = null;
    return true;
  };

  const invokeControl = (secret, operation, payload) => {
    if (!activeControl || secret !== activeControl.secret) return null;
    try {
      if (operation === 'update') return activeControl.api.update(payload);
      if (operation === 'drcRestoreState') {
        return activeControl.api.drcRestoreState();
      }
    } catch {}
    return null;
  };

  const api = Object.freeze({
    version: 1,
    takeover: () => takeoverImpl(),
    beginControl,
    commitControl,
    cancelControl,
    invokeControl,
  });
  try {
    Object.defineProperty(window, INSTANCE_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
  } catch {
    return;
  }

  const mediaProto = HTMLMediaElement.prototype;
  const nativeVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const nativeMuted = Object.getOwnPropertyDescriptor(mediaProto, 'muted');
  const nativePlay = mediaProto.play;
  if (
    !nativeVolume ||
    typeof nativeVolume.get !== 'function' ||
    typeof nativeVolume.set !== 'function' ||
    !nativeMuted ||
    typeof nativeMuted.set !== 'function' ||
    typeof nativePlay !== 'function'
  ) {
    return;
  }

  let cached;
  try {
    cached = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || 'null');
  } catch {
    return;
  }

  // Отсутствие кэша — это именно «удерживать нечего», а не нулевая
  // громкость. Проверять `Number(cached && cached.volume)` нельзя:
  // при отсутствующем кэше выражение даёт Number(null) === 0, и на первой
  // же загрузке нового профиля preload удерживал бы полную тишину до
  // прихода main.js.
  const cachedVolume =
    cached && typeof cached === 'object' ? Number(cached.volume) : NaN;
  if (!Number.isFinite(cachedVolume) || cachedVolume < 0 || cachedVolume > 1) {
    return;
  }
  const volume = Math.min(cachedVolume, EARLY_SAFE_VOLUME_LIMIT);
  const enabled = !cached || cached.enabled !== false;
  const cachedGamma = Number(cached && cached.gamma);
  const gamma = Number.isFinite(cachedGamma)
    ? Math.min(6, Math.max(1, cachedGamma))
    : 3;
  const normalizeLoudness = cached && cached.normalizeLoudness === true;
  const cachedMaxBoostDb = Number(cached && cached.maxBoostDb);
  const maxBoostDb = Number.isFinite(cachedMaxBoostDb)
    ? Math.min(MAX_BOOST_LIMIT_DB, Math.max(1, cachedMaxBoostDb))
    : 6;
  const cachedLoudness =
    cached && cached.loudness && typeof cached.loudness === 'object'
      ? cached.loudness
      : null;
  let heldVolume = volume;
  let volumeDirty = false;
  let volumeIntentUntil = 0;
  let volumeIntentBudget = 0;
  let volumeIntentVideo = null;
  let volumeIntentSource = '';
  let expectedVolume;
  const shouldMute = cached && cached.muted === true;
  const logicalVolume = new WeakMap();
  const earlyLoudnessBoost = new WeakMap();
  let active = true;

  const closest = (target, selector) =>
    target && typeof target.closest === 'function'
      ? target.closest(selector)
      : null;
  const activeReel = () =>
    document.querySelector('ytd-reel-video-renderer[is-active]') ||
    document.querySelector(
      '#reel-overlay-container ytd-reel-video-renderer'
    ) ||
    document.querySelector('ytd-reel-video-renderer');
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
  const activeVideo = () => {
    const reel = activeReel();
    return (
      (reel && reel.querySelector('video')) ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  };
  const mediaSource = (media) =>
    media ? String(media.currentSrc || media.src || '') : '';

  const playerForMedia = (media) =>
    closest(media, '.html5-video-player, #movie_player, #shorts-player') ||
    document.querySelector(
      'ytd-reel-video-renderer[is-active] .html5-video-player, #shorts-player .html5-video-player, #movie_player'
    );
  const callPlayer = (player, method) => {
    if (!player || typeof player[method] !== 'function') return undefined;
    try {
      return player[method]();
    } catch {
      return undefined;
    }
  };
  const locationVideoId = () => {
    if (typeof location !== 'object' || !location) return '';
    const path = String(location.pathname || '');
    if (path.startsWith('/shorts/')) return path.split('/')[2] || '';
    const match = /(?:^|[?&])v=([^&]+)/.exec(String(location.search || ''));
    return match ? decodeURIComponent(match[1]) : '';
  };
  const currentVideoId = (player, response) => {
    const data = callPlayer(player, 'getVideoData');
    if (data && typeof data === 'object' && data.video_id) {
      return String(data.video_id);
    }
    const details = response && response.videoDetails;
    return details && details.videoId
      ? String(details.videoId)
      : locationVideoId();
  };

  // Ранний путь использует ту же осторожную привязку к активной
  // аудиодорожке, что и основной код. На мультиязычном ролике общий
  // audioConfig может относиться к оригиналу, пока играет перевод.
  function activeAudioTrack(player, formats) {
    const trackIds = new Set();
    const itags = new Set();
    for (const format of formats) {
      const track = format && format.audioTrack;
      if (track && track.id != null) trackIds.add(String(track.id));
      const itag = Number(format && format.itag);
      if (Number.isInteger(itag) && itag > 0) itags.add(itag);
    }
    if (!trackIds.size) return { id: '', itag: null, count: 0 };

    const selected = callPlayer(player, 'getAudioTrack');
    const matchedIds = new Set();
    const matchedItags = new Set();
    if (selected && (typeof selected === 'object' || typeof selected === 'function')) {
      const seen = new Set();
      const pending = [{ value: selected, depth: 0 }];
      let inspected = 0;
      while (pending.length && inspected < 64) {
        const item = pending.pop();
        const value = item.value;
        if (
          !value ||
          (typeof value !== 'object' && typeof value !== 'function') ||
          seen.has(value)
        ) {
          continue;
        }
        seen.add(value);
        inspected += 1;
        for (const name of Object.getOwnPropertyNames(value).slice(0, 64)) {
          let child;
          try {
            child = value[name];
          } catch {
            continue;
          }
          if (name === 'id' && typeof child === 'string') {
            if (trackIds.has(child)) matchedIds.add(child);
            const itagMatch = /^(\d+);/.exec(child);
            const itag = itagMatch ? Number(itagMatch[1]) : NaN;
            if (Number.isInteger(itag) && itags.has(itag)) matchedItags.add(itag);
          }
          if (
            item.depth < 4 &&
            child &&
            (typeof child === 'object' || typeof child === 'function')
          ) {
            pending.push({ value: child, depth: item.depth + 1 });
          }
        }
      }
    }
    return {
      id:
        matchedIds.size === 1
          ? matchedIds.values().next().value
          : trackIds.size === 1
            ? trackIds.values().next().value
            : '',
      itag: matchedItags.size === 1 ? matchedItags.values().next().value : null,
      count: trackIds.size,
    };
  }

  function activeTrackLoudness(formats, track) {
    if (!track.id) return NaN;
    const values = [];
    for (const format of formats) {
      const audioTrack = format && format.audioTrack;
      if (!audioTrack || String(audioTrack.id || '') !== track.id) continue;
      if (track.itag != null && Number(format.itag) !== track.itag) continue;
      if (format.isDrc === true || format.isVb === true) continue;
      const value =
        format.loudnessDb == null || format.loudnessDb === ''
          ? NaN
          : Number(format.loudnessDb);
      if (Number.isFinite(value)) values.push(value);
    }
    if (!values.length || Math.max(...values) - Math.min(...values) >= 0.15) {
      return NaN;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function cachedBoostDbFor(videoId, track) {
    if (!normalizeLoudness || !cachedLoudness) return NaN;
    if (String(cachedLoudness.videoId || '') !== videoId) return NaN;
    const cachedTrackId = String(cachedLoudness.trackId || '');
    if (cachedTrackId) {
      if (track.id !== cachedTrackId) return NaN;
      const cachedItag =
        cachedLoudness.trackItag == null ? NaN : Number(cachedLoudness.trackItag);
      if (
        Number.isInteger(cachedItag) &&
        track.itag != null &&
        cachedItag !== track.itag
      ) {
        return NaN;
      }
    } else if (track.count > 1) {
      return NaN;
    }
    const db = Number(cachedLoudness.boostDb);
    return Number.isFinite(db) && db <= maxBoostDb && db >= -60 ? db : NaN;
  }

  function refreshEarlyLoudness(media) {
    if (!normalizeLoudness || !(media instanceof HTMLMediaElement)) return;
    const selectedMedia = activeVideo();
    if (selectedMedia && media !== selectedMedia) return;
    const player = playerForMedia(media);
    if (!player || typeof player.getPlayerResponse !== 'function') return;
    try {
      const response = player.getPlayerResponse();
      if (!response) return;
      const videoId = currentVideoId(player, response);
      const expectedId = locationVideoId();
      const snapshotId =
        response.videoDetails && response.videoDetails.videoId
          ? String(response.videoDetails.videoId)
          : '';
      if (
        !videoId ||
        (expectedId && videoId !== expectedId) ||
        (snapshotId && snapshotId !== videoId)
      ) {
        return;
      }

      const state = Number(callPlayer(player, 'getDrcState'));
      const preference = Number(callPlayer(player, 'getDrcUserPreference'));
      // Активный DRC уже нормализован самим YouTube; неизвестное состояние
      // тоже не усиливаем. Preference 0 подтверждает исходную дорожку даже
      // на сборках, где getDrcState после переключения залипает на нуле.
      if (state === 0 && preference === 1) {
        earlyLoudnessBoost.set(media, 1);
        return;
      }
      if (!(state === 1 || preference === 0)) return;

      const formats =
        response.streamingData && Array.isArray(response.streamingData.adaptiveFormats)
          ? response.streamingData.adaptiveFormats
          : [];
      const track = activeAudioTrack(player, formats);
      let boostDb = cachedBoostDbFor(videoId, track);
      if (!Number.isFinite(boostDb)) {
        const trackDb = activeTrackLoudness(formats, track);
        const config = response.playerConfig && response.playerConfig.audioConfig;
        const configDb =
          config && config.loudnessDb != null ? Number(config.loudnessDb) : NaN;
        const db = Number.isFinite(trackDb)
          ? trackDb
          : track.count <= 1
            ? configDb
            : NaN;
        if (!Number.isFinite(db)) return;
        boostDb = db > 0 ? -db : Math.min(maxBoostDb, -db);
      }
      earlyLoudnessBoost.set(media, Math.pow(10, boostDb / 20));
    } catch {}
  }

  // То же, что видит пользователь: положение штатного ползунка Shorts или
  // проценты на панели обычного плеера. Читать video.volume для сверки
  // бессмысленно — именно его и подменяют.
  const nativePercentFromDom = () => {
    const reel = activeReel();
    const sliders =
      reel && typeof reel.querySelectorAll === 'function'
        ? reel.querySelectorAll('volume-controls input#volume-input')
        : null;
    if (sliders && sliders.length === 1) {
      const pct = Number(sliders[0].value);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    const panel = document.querySelector('.ytp-volume-panel[aria-valuenow]');
    if (panel) {
      const pct = Number(panel.getAttribute('aria-valuenow'));
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    return null;
  };
  const corroborated = (requested) => {
    const pct = nativePercentFromDom();
    return pct != null && Math.abs(requested - pct / 100) <= DOM_TOLERANCE;
  };

  const grantVolumeIntent = (duration = INTENT_WINDOW_MS, expected) => {
    volumeIntentVideo = activeVideo();
    volumeIntentSource = mediaSource(volumeIntentVideo);
    volumeIntentUntil = Date.now() + duration;
    volumeIntentBudget = 1;
    expectedVolume = expected;
  };
  // Возвращает, насколько значению можно верить: '' — не верим вовсе,
  // 'hold' — применяем к сессии, но в сохранение не пускаем, 'trusted' —
  // подтверждено самим контролом и годится для записи.
  const consumeVolumeIntent = (media, requested) => {
    if (Date.now() > volumeIntentUntil || volumeIntentBudget < 1) return '';
    if (volumeIntentVideo && media !== volumeIntentVideo) return '';
    const source = mediaSource(media);
    if (
      volumeIntentSource &&
      source &&
      volumeIntentSource !== source
    ) {
      return '';
    }
    if (expectedVolume !== undefined) {
      if (Math.abs(requested - expectedVolume) > 1e-6) return '';
      volumeIntentBudget = 0;
      expectedVolume = undefined;
      return 'trusted';
    }
    // Для стрелок, колеса и протяжки штатной панели результат жеста заранее
    // неизвестен — шаг задаёт YouTube. Раньше окно в этом случае принимало
    // любое значение, и скрипт страницы, попавший в чужой жест, диктовал
    // сохранённый уровень. Теперь неподтверждённое значение живёт только в
    // текущей сессии и до записи в хранилище не доходит.
    volumeIntentBudget = 0;
    return corroborated(requested) ? 'trusted' : 'hold';
  };

  const outputVolume = (media) => {
    const base = enabled ? Math.pow(heldVolume, gamma) : heldVolume;
    const boost = earlyLoudnessBoost.get(media) || 1;
    return Math.min(EARLY_SAFE_VOLUME_LIMIT, Math.max(0, base * boost));
  };

  const applyCachedOutput = (media) => {
    if (!active || !(media instanceof HTMLMediaElement)) return;
    try {
      nativeVolume.set.call(media, outputVolume(media));
      // Включать mute заранее безопасно. Снимать его до основного кода
      // нельзя: на новой вкладке это может нарушить политику autoplay.
      if (shouldMute) nativeMuted.set.call(media, true);
    } catch {}
  };

  const earlyVolumeGet = function () {
    return logicalVolume.has(this) ? logicalVolume.get(this) : heldVolume;
  };
  const earlyVolumeSet = function (value) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested < 0 || requested > 1) {
      nativeVolume.set.call(this, value);
      return;
    }
    // Автоматические записи YouTube пока удерживаем на сохранённом уровне.
    // Доверенный жест над штатным контролом заранее открывает короткое
    // окно, чтобы он работал даже во время холодного запуска service worker.
    const verdict = consumeVolumeIntent(this, requested);
    if (verdict) {
      heldVolume = requested;
      if (verdict === 'trusted') volumeDirty = true;
    }
    logicalVolume.set(this, requested);
    applyCachedOutput(this);
  };

  try {
    Object.defineProperty(mediaProto, 'volume', {
      configurable: true,
      enumerable: nativeVolume.enumerable,
      get: earlyVolumeGet,
      set: earlyVolumeSet,
    });
  } catch {
    return;
  }

  const earlyPlay = function (...args) {
    refreshEarlyLoudness(this);
    applyCachedOutput(this);
    return nativePlay.apply(this, args);
  };
  mediaProto.play = earlyPlay;

  const onPointerDown = (event) => {
    if (event.isTrusted && nativeVolumeControl(event.target)) {
      grantVolumeIntent();
    }
  };
  const onPointerMove = (event) => {
    if (
      event.isTrusted &&
      event.buttons & 1 &&
      nativeVolumeControl(event.target)
    ) {
      grantVolumeIntent();
    }
  };
  const onWheel = (event) => {
    if (event.isTrusted && nativeVolumeControl(event.target)) {
      grantVolumeIntent();
    }
  };
  const onKeyDown = (event) => {
    if (
      event.isTrusted &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      nativeVolumeControl(event.target)
    ) {
      grantVolumeIntent();
    }
  };
  const onNativeInput = (event) => {
    if (!event.isTrusted || !nativeVolumeControl(event.target)) return;
    const pct = Number(event.target && event.target.value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    grantVolumeIntent(INTENT_WINDOW_MS, pct / 100);
    heldVolume = pct / 100;
    volumeDirty = true;
    document.querySelectorAll('video, audio').forEach(applyCachedOutput);
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('wheel', onWheel, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('input', onNativeInput, true);

  const onMediaReady = (event) => {
    refreshEarlyLoudness(event.target);
    applyCachedOutput(event.target);
  };
  for (const type of ['loadstart', 'loadedmetadata', 'play']) {
    document.addEventListener(type, onMediaReady, true);
  }

  const applyTree = (node) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLMediaElement) {
      refreshEarlyLoudness(node);
      applyCachedOutput(node);
    }
    node.querySelectorAll('video, audio').forEach((media) => {
      refreshEarlyLoudness(media);
      applyCachedOutput(media);
    });
  };
  document.querySelectorAll('video, audio').forEach((media) => {
    refreshEarlyLoudness(media);
    applyCachedOutput(media);
  });
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) applyTree(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // Если service worker не проснулся, main.js не придёт вовсе, а наблюдатель
  // за всем деревом и подменённый play() остались бы до конца вкладки. На
  // обороте DOM у YouTube это заметная постоянная нагрузка, поэтому тяжёлую
  // часть снимаем сами; удержание уровня остаётся на дешёвых слушателях.
  let releaseTimer = setTimeout(() => {
    releaseTimer = 0;
    if (!active) return;
    observer.disconnect();
    if (mediaProto.play === earlyPlay) mediaProto.play = nativePlay;
  }, 15000);

  takeoverImpl = () => {
    if (!active) return false;
    active = false;
    clearTimeout(releaseTimer);
    observer.disconnect();
    for (const type of ['loadstart', 'loadedmetadata', 'play']) {
      document.removeEventListener(type, onMediaReady, true);
    }
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('input', onNativeInput, true);
    const currentVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
    if (
      currentVolume &&
      currentVolume.get === earlyVolumeGet &&
      currentVolume.set === earlyVolumeSet
    ) {
      Object.defineProperty(mediaProto, 'volume', nativeVolume);
    }
    if (mediaProto.play === earlyPlay) mediaProto.play = nativePlay;
    return { volume: heldVolume, volumeDirty };
  };
})();
