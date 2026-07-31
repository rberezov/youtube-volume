  /* ---- Доверие к чужому переключателю Stable Volume --------------------- *
   *
   * Обёртка setDrcUserPreference лежит на объекте страницы, и вызвать её
   * может любой её скрипт. Отличить штатный переключатель YouTube от
   * постороннего вызова по самому вызову нельзя: путь один и тот же, и
   * ревизия безопасности отметила это как способ выдать себя за пользователя
   * — расширение запоминало «человек хочет Stable Volume» и позже включало
   * её тому, кто не просил.
   *
   * Отличается обстановка. Настоящий переключатель нажимают, и между
   * нажатием и вызовом проходят миллисекунды; скрипт по таймеру такого следа
   * не оставляет. Поэтому намерение принимается только внутри короткого окна
   * после доверенного ввода: `isTrusted` страница подделать не может.
   *
   * Звук при этом ведёт себя одинаково в обоих случаях — предпочтение всё
   * равно возвращается в 0. Под сомнением здесь только память о выборе
   * пользователя, и в сомнительном случае она просто не меняется.
   * ---------------------------------------------------------------------- */
  const DRC_INTENT_WINDOW_MS = 750;
  let pendingDrcIntent = null;

  function drcToggleFromEvent(event) {
    if (!event || event.isTrusted !== true) return null;
    let path = [];
    try {
      path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    } catch {
      return null;
    }
    for (const node of path) {
      if (
        !(node instanceof Element) ||
        !node.classList.contains('ytp-drc-menu-item') ||
        node.getAttribute('role') !== 'menuitemcheckbox'
      ) {
        continue;
      }
      const player = node.closest('.html5-video-player, #movie_player, #shorts-player');
      if (!player || player !== getPlayer()) return null;
      return {
        player,
        // aria-checked описывает состояние ДО штатного обработчика YouTube.
        requested: node.getAttribute('aria-checked') === 'true' ? 0 : 1,
      };
    }
    return null;
  }

  function armDrcIntent(event) {
    if (
      event.type === 'keydown' &&
      event.key !== 'Enter' &&
      event.key !== ' ' &&
      event.key !== 'Spacebar'
    ) {
      return;
    }
    const toggle = drcToggleFromEvent(event);
    if (!toggle) return;
    pendingDrcIntent = {
      ...toggle,
      expiresAt: Date.now() + DRC_INTENT_WINDOW_MS,
    };
  }

  on(document, 'click', armDrcIntent, true);
  on(document, 'keydown', armDrcIntent, true);

  function consumeDrcIntent(player, requested) {
    const intent = pendingDrcIntent;
    if (!intent) return false;
    if (Date.now() > intent.expiresAt) {
      pendingDrcIntent = null;
      return false;
    }
    // Несовпадающий вызов не должен отнять подтверждённое нажатие у самого
    // переключателя. Разрешение расходуется только точным совпадением.
    if (intent.player !== player || intent.requested !== requested) return false;
    pendingDrcIntent = null;
    return true;
  }

  /**
   * YouTube не публикует событие изменения Stable Volume. Штатный переключатель
   * вызывает метод активного плеера, поэтому на время нашей нормализации держим
   * его обёрнутым: пользовательское включение запоминаем для восстановления,
   * но в сам плеер немедленно передаём 0. Внутренние вызовы расширения идут
   * через callOriginalDrcSetter() и не выглядят пользовательским намерением.
   */
  function guardYouTubeDrcSetter(player) {
    if (!SETTINGS.normalizeLoudness) {
      releaseYouTubeDrcSetterGuard();
      return false;
    }
    if (
      youtubeDrcSetterGuard &&
      youtubeDrcSetterGuard.player === player &&
      player &&
      player.setDrcUserPreference === youtubeDrcSetterGuard.wrapper
    ) {
      return true;
    }

    releaseYouTubeDrcSetterGuard();
    if (!player || typeof player.setDrcUserPreference !== 'function') return false;
    const original = player.setDrcUserPreference;
    const wrapper = function (value, ...rest) {
      const requested = Number(value) === 1 ? 1 : 0;
      if (!SETTINGS.normalizeLoudness) return original.call(this, value, ...rest);

      // Намерение выдаётся только настоящим нажатием непосредственно на
      // переключатель Stable Volume активного плеера. Любой другой клик,
      // клавиша или программный вызов setter память о выборе не меняют.
      if (consumeDrcIntent(player, requested)) {
        rememberYouTubeDrcUserIntent(requested === 1);
      }
      const result = original.call(this, 0, ...rest);
      youtubeNormalizationGeneration += 1;
      youtubeNormalizationPending = false;
      youtubeNormalizationForcedOff = true;
      queueMediaLoudnessRefresh(true);
      return result;
    };
    try {
      player.setDrcUserPreference = wrapper;
    } catch {
      return false;
    }
    if (player.setDrcUserPreference !== wrapper) return false;
    youtubeDrcSetterGuard = { player, original, wrapper };
    return true;
  }

  /**
   * Возвращаем YouTube Stable Volume только если расширение само выключило
   * ранее включённое предпочтение. Если пользователь держал Stable Volume
   * выключенной, маркера нет и расширение не меняет его выбор.
   */
  function restoreYouTubeNormalization(player) {
    releaseYouTubeDrcSetterGuard();
    youtubeNormalizationForcedOff = false;
    youtubeNormalizationPending = false;
    if (!youtubeDrcRestoreNeeded) {
      return true;
    }

    const hasSetter = !!(player && typeof player.setDrcUserPreference === 'function');
    youtubeNormalizationApiAvailable =
      hasSetter && typeof player.getDrcUserPreference === 'function';
    if (!hasSetter) return false;

    try {
      // Это глобальное предпочтение YouTube. Сам плеер применит DRC только к
      // роликам, для которых такая дорожка действительно существует.
      callOriginalDrcSetter(player, 1);
      youtubeDrcRestoreNeeded = false;
      requestYouTubeDrcStateSync();
      resetLoudness();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Наша нормализация и YouTube Stable Volume не должны работать одновременно.
   *
   * Текущий плеер публикует setDrcUserPreference(0) — ровно тот же путь,
   * которым пользуется штатный переключатель. Вызов сохраняет предпочтение,
   * выбирает исходную дорожку и перезагружает звук. Повторно сверяем состояние
   * по событиям плеера и media; внешний вызов setter перехватывается сразу.
   */
  function disableYouTubeNormalization(player) {
    if (!SETTINGS.normalizeLoudness) {
      return restoreYouTubeNormalization(player);
    }

    const hasGetter = !!(player && typeof player.getDrcUserPreference === 'function');
    const hasSetter = !!(player && typeof player.setDrcUserPreference === 'function');
    youtubeNormalizationApiAvailable = hasGetter && hasSetter;
    guardYouTubeDrcSetter(player);
    const preference = hasGetter ? callPlayer(player, 'getDrcUserPreference') : undefined;
    const normalizedPreference = Number(preference);

    if (normalizedPreference === 0) {
      rememberYouTubeDrcWasDisabled();
      youtubeNormalizationPending = false;
      youtubeNormalizationForcedOff = true;
      return true;
    }

    // На старой/экспериментальной сборке getter может отсутствовать отдельно.
    // Успешный вызов штатного setter всё равно является лучшим доступным
    // подтверждением: он синхронно сохраняет 0 и запускает смену дорожки.
    if (!hasGetter && hasSetter) {
      try {
        callOriginalDrcSetter(player, 0);
        youtubeNormalizationPending = false;
        youtubeNormalizationForcedOff = true;
        return true;
      } catch {}
    }

    youtubeNormalizationPending = true;
    youtubeNormalizationForcedOff = false;
    if (normalizedPreference === 1) rememberYouTubeDrcWasEnabled();
    // Пока исходная дорожка не подтверждена, снимаем прежнее усиление: иначе
    // на короткое время получилась бы двойная нормализация поверх активного DRC.
    if (preference !== undefined) resetLoudness();
    if (hasSetter) {
      try {
        callOriginalDrcSetter(player, 0);
        const confirmed = Number(callPlayer(player, 'getDrcUserPreference')) === 0;
        if (confirmed) {
          youtubeNormalizationPending = false;
          youtubeNormalizationForcedOff = true;
          return true;
        }
      } catch {}
    }
    return false;
  }

