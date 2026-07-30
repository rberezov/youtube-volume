  /* ------------------------------------------------------------------ *
   * Предпросмотр ролика в ленте
   *
   * Наведение на карточку поднимает отдельный плеер (`ytd-video-preview` со
   * своим `#inline-player` и своим `<video>`), и ведёт он себя сам по себе:
   * стартует немым, а по кнопке снимает немоту на том уровне, который помнит
   * YouTube. Своей шкалы мы туда не встраиваем и штатную кнопку не трогаем —
   * менять громкость в предпросмотре незачем. Но раз звук пошёл, идти он
   * должен на сохранённом уровне, а не на чужом.
   *
   * Только применяем. Обратно в хранилище с предпросмотра не пишем ничего:
   * это не осознанный выбор уровня, а побочный эффект наведения.
   * ------------------------------------------------------------------ */
  const PREVIEW_MEDIA_SELECTOR =
    'ytd-video-preview video, #inline-preview-player video, #inline-player video';
  const previewLoudnessState = new WeakMap();

  const previewPlayerFor = (el) => {
    if (!(el instanceof HTMLMediaElement)) return null;
    if (!el.closest('ytd-video-preview, #inline-preview-player, #inline-player')) {
      return null;
    }
    return el.closest('.html5-video-player, #inline-preview-player, #inline-player');
  };

  function setPreviewLoudness(el, snap, boost) {
    const previous = previewLoudnessState.get(el);
    const next = Number.isFinite(boost) && boost > 0 ? boost : 1;
    previewLoudnessState.set(el, {
      id: snap && snap.id ? snap.id : '',
      db: snap && Number.isFinite(snap.db) ? snap.db : null,
      drc: !!(snap && snap.drc),
      complete: !!(snap && snap.complete),
      source: snap && snap.source ? snap.source : '',
      trackId: snap && snap.trackId ? snap.trackId : '',
      trackItag: snap && snap.trackItag != null ? snap.trackItag : null,
      boost: next,
    });
    if (
      (!previous || Math.abs(previous.boost - next) > 1e-6) &&
      logicalVolume.has(el)
    ) {
      applyReal(el, toReal(logicalVolume.get(el)));
    }
  }

  function resetPreviewLoudness(el) {
    const previous = previewLoudnessState.get(el);
    if (!previous || Math.abs(previous.boost - 1) > 1e-6) {
      setPreviewLoudness(el, null, 1);
    }
  }

  function refreshPreviewLoudness(el, eventType = '') {
    const player = previewPlayerFor(el);
    if (!player) return false;
    // На emptied ответ плеера ещё относится к предыдущей карточке. Снимаем
    // старое решение сразу, а новое читаем на следующем media-событии.
    if (eventType === 'emptied') {
      resetPreviewLoudness(el);
      return false;
    }
    if (eventType === 'durationchange') resetPreviewLoudness(el);
    const snap = readLoudness(player);
    if (!snap.complete) return false;
    setPreviewLoudness(el, snap, Math.pow(10, loudnessDbFor(snap) / 20));
    return true;
  }

  function refreshAllPreviewLoudness() {
    document.querySelectorAll(PREVIEW_MEDIA_SELECTOR).forEach((el) => {
      refreshPreviewLoudness(el);
      if (!el.muted && logicalVolume.has(el)) {
        applyReal(el, toReal(logicalVolume.get(el)));
      }
    });
  }

  function applyPreviewVolume(el, eventType = '') {
    if (!volumeStateLoaded || !validVolume(preferredVolume)) return;
    if (!(el instanceof HTMLMediaElement)) return;
    // Главный плеер ведёт bindVideo() со всей своей логикой намерений.
    if (el === boundVideo || el === getVideo()) return;
    refreshPreviewLoudness(el, eventType);
    if (el.muted) return; // немой предпросмотр не трогаем
    const current = Number(logicalOf(el));
    if (validVolume(current) && Math.abs(current - preferredVolume) <= VOLUME_EPSILON) {
      // При снятии mute логический уровень уже может быть правильным, но
      // индивидуальный коэффициент предпросмотра всё равно надо довести до
      // GainNode (или до запасного прямого пути).
      applyReal(el, toReal(preferredVolume));
      return; // уже наш уровень — молчим, иначе была бы перепалка записей
    }
    el.volume = preferredVolume;
  }
  for (const type of [
    'emptied',
    'durationchange',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'playing',
    'volumechange',
  ]) {
    // Медиа-события не всплывают, но фазу перехвата проходят — поэтому один
    // слушатель на документе видит и те плееры, которых ещё нет в DOM.
    on(document, type, (e) => applyPreviewVolume(e.target, e.type), true);
  }

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

