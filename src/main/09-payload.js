  /* ------------------------------------------------------------------ *
   * 2. Настройки из popup (доверенная инъекция через service worker)
   * ------------------------------------------------------------------ */

  function applyTrustedPayload(payload, includeState = false) {
    if (!payload || typeof payload !== 'object') return false;
    const state =
      includeState && payload.state && typeof payload.state === 'object'
        ? payload.state
        : {};
    // Сначала читаем маркер восстановления, и только потом применяем настройки:
    // refreshLoudness() может сразу выключить YouTube DRC. При обратном порядке
    // после перезапуска терялось бы знание, что DRC нужно вернуть.
    if (includeState && !youtubeDrcRestoreStateLoaded) {
      youtubeDrcRestoreStateTracked =
        typeof state.restoreYoutubeDrc === 'boolean';
      youtubeDrcRestoreNeeded = state.restoreYoutubeDrc === true;
      youtubeDrcRestoreStateLoaded = true;
      // Записи нет — значит доказательства нет.
      //
      // Здесь была миграция с 1.31.0: та версия уже могла выключить Stable
      // Volume, но ещё не записывала исходное состояние, и при включённой
      // нормализации отсутствие записи считалось «выключили мы». Условие
      // оказалось шире замысла: запись отсутствует не только после
      // обновления, но и на новой установке, и после очистки хранилища, и в
      // соседней вкладке, открытой раньше, чем доехала синхронизация. Во всех
      // этих случаях расширение собиралось включить Stable Volume тому, кто
      // держал её выключенной сам.
      //
      // Отличить «выключили мы» от «выключил пользователь» в этот момент
      // нельзя: предпочтение равно нулю в обоих случаях, а отметки версии в
      // хранилище нет. Раз выбор между двумя ошибками, выбираем менее
      // грубую: не вернуть чужую настройку — это упущение, которое человек
      // исправит сам в меню YouTube, а включить не спрошенное — это уже
      // изменение его выбора. Правило остаётся тем же, что и во всём файле:
      // возвращаем только то, что сами доказуемо меняли.
    }
    applySettings(payload.settings);
    applyStrings(payload.strings);
    applyMeterUrl(payload.meterUrl);
    if (!volumeStateLoaded) {
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
    bindVideo();
    // bindVideo() начинает новую ревизию и потому снимает старое усиление.
    // Пересчитываем после привязки синхронно: иначе первый ролик успевал
    // прозвучать с 0 дБ до отложенного media-события.
    refreshLoudness(); // сам позовёт reapplyCurve, если компенсация изменилась
    syncMeter(); // настройку выравнивания можно включить и во время ролика
    refreshAllPreviewLoudness();
    reapplyCurve();
    ensureUI(); // включение/выключение своей шкалы должно срабатывать сразу
    layout();
    updateUI();
    updateCollapsed();
    return true;
  }

  // Что расширение решило про громкость текущего ролика. Диагностика
  // намеренно публична: уровень ролика уже известен самой странице.
  function loudnessReport() {
    const snap = readLoudness(getPlayer());
    return {
      enabled: SETTINGS.normalizeLoudness,
      db: snap.db,
      drc: snap.drc,
      // complete — определилось ли состояние; source — кто дал ответ.
      // Вместе со stats и сырыми state/preference этого хватает, чтобы
      // разобрать любой спорный случай прямо из консоли.
      complete: snap.complete,
      source: snap.source,
      stats: snap.stats,
      state: snap.state,
      preference: snap.preference,
      trackId: snap.trackId,
      trackItag: snap.trackItag,
      dbSource: snap.dbSource,
      youtubeNormalizationDisabled:
        !SETTINGS.normalizeLoudness || youtubeNormalizationForcedOff,
      youtubeNormalizationPending,
      youtubeNormalizationApiAvailable,
      youtubeDrcRestoreNeeded,
      youtubeDrcRestoreStateTracked,
      youtubeNormalizationRestorePending:
        !SETTINGS.normalizeLoudness && youtubeDrcRestoreNeeded,
      boost: loudnessBoost,
      boostDb: Number((20 * Math.log10(loudnessBoost)).toFixed(2)),
      maxBoostDb: SETTINGS.maxBoostDb,
      // Живой замер по BS.1770. Приходит от воркле́та раз в секунду; null —
      // измеритель не подключён (выравнивание выключено, нет Web Audio или
      // страница не дала загрузить модуль).
      live: meterSnapshot,
    };
  }

  function previewLoudnessReport() {
    return [...document.querySelectorAll(PREVIEW_MEDIA_SELECTOR)].slice(0, 16).map((el) => {
      const state = previewLoudnessState.get(el);
      return {
        id: state && state.id ? state.id : '',
        db: state && Number.isFinite(state.db) ? state.db : null,
        drc: !!(state && state.drc),
        complete: !!(state && state.complete),
        source: state && state.source ? state.source : '',
        trackId: state && state.trackId ? state.trackId : '',
        trackItag: state && state.trackItag != null ? state.trackItag : null,
        boost: state ? state.boost : 1,
        boostDb: Number((20 * Math.log10(state ? state.boost : 1)).toFixed(2)),
        muted: el.muted,
        paused: el.paused,
      };
    });
  }

  // Этот объект никогда не публикуется в window. Секрет проверяет
  // неизменяемый preload-брокер, а сюда доходит уже авторизованный вызов.
  const controlApi = Object.freeze({
    dispose: disposeInstance,
    update(payload) {
      return applyTrustedPayload(payload, false);
    },
    drcRestoreState() {
      return youtubeDrcRestoreNeeded;
    },
  });

  const instanceApi = Object.freeze({
    version: 2,
    // Канал — опознавательный знак поколения, не секрет: он и так виден
    // странице в postMessage. В window остаётся только безопасная
    // диагностика, без update(), dispose() и чтения внутреннего DRC-флага.
    channel: CHANNEL_ID,
    loudness: loudnessReport,
    previewLoudness: previewLoudnessReport,
  });

