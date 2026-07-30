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
    preload.cancelControl(updateSecret);
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
      // только до фактического старта звука на этом элементе и только если у
      // документа уже есть пользовательская активация — без неё незаглушённое
      // воспроизведение невозможно в принципе и мешать браузеру нельзя.
      // Осознанное выключение звука (наша кнопка, клавиша m, штатная кнопка
      // YouTube) заранее отмечает намерение и проходит сквозь подавление —
      // раньше окно в три секунды глотало и его.
      // Обратное направление (снятие mute при preferredMuted === true)
      // сеттер не трогает: его доводит onVolumeChange через
      // restorePreferredState, на кадр позже, но без риска для автозапуска.
      const suppress =
        requested &&
        !SETTINGS.useNativeSlider &&
        preferredMuted === false &&
        mutedGuardOpen &&
        !hasMutedIntent() &&
        hasUserActivation() &&
        this === getVideo();
      nativeMutedDesc.set.call(this, suppress ? false : requested);
    },
  });

  const logicalOf = (el) =>
    logicalVolume.has(el) ? logicalVolume.get(el) : nativeDesc.get.call(el);

