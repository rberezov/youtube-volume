  /* ------------------------------------------------------------------ *
   * YouTube — SPA: плеер, <video> и строка управления пересоздаются на ходу.
   * Раньше их искал опрос раз в секунду. Теперь смотрим на сам факт
   * перестройки: появление и исчезновение узла — это всегда childList-мутация,
   * поэтому наблюдатель видит строго больше, чем видел опрос, и видит сразу,
   * а не в среднем через полсекунды.
   * ------------------------------------------------------------------ */

  // Можно ли улучшить текущее место блока. В Shorts штатная строка кнопок
  // появляется позже видео: если мы уже стоим в накладном слое, а строка
  // подъехала, стоит перебраться в неё.
  function uiCanImprove() {
    return !!(ui && ui.overlay && isShorts() && !shortsRowUnusable && shortsVolumeHost());
  }

  function sweep() {
    // YouTube регулярно заменяет <video> в Shorts. Не оставляем старые
    // слушатели и JS-ссылки жить до конца вкладки.
    for (const [el, node] of audio.liveNodes) {
      if (!el.isConnected) fallbackToDirect(el, node);
    }
    bindVideo(); // сам перечитает уровень ролика, если элемент сменился
    // ensureUI() перестраивает интерфейс и делает замеры геометрии, поэтому
    // на каждую мутацию его звать нельзя — получилась бы взбивка лейаута.
    // Зовём, только когда блока действительно нет на месте.
    if (SETTINGS.useNativeSlider || !ui || !ui.box.isConnected || uiCanImprove()) {
      ensureUI();
    }
    // refreshLoudness() здесь намеренно нет: getStatsForNerds() и
    // getPlayerResponse() недёшевы, а страница у YouTube шевелится постоянно.
    // Уровень перечитывают события самой дорожки, навигация и bindVideo() —
    // то есть всё, после чего он может измениться.
  }

  let sweepQueued = false;
  let sweepTimer = 0;
  // Склейка через setTimeout, а не requestAnimationFrame: в фоновой вкладке
  // кадров нет вовсе, а Shorts там продолжают листаться — и новый ролик
  // остался бы без сохранённой громкости до возвращения на вкладку.
  // Флаг снимается внутри обработчика, а не в sweep(): иначе достаточно было
  // бы синхронного setTimeout, чтобы порядок присваиваний оставил флаг
  // поднятым навсегда и обходы прекратились.
  function scheduleSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    sweepTimer = setTimeout(() => {
      sweepQueued = false;
      sweepTimer = 0;
      sweep();
    }, 0);
  }
  // Проверка типа — как у ResizeObserver рядом: сам код не должен падать
  // там, где среда беднее браузера.
  const domObserver =
    typeof MutationObserver === 'function' ? new MutationObserver(scheduleSweep) : null;
  if (domObserver) {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  const prepareForNavigation = () => {
    // yt-navigate-start означает лишь начало SPA-перехода. При Shorts → Home
    // старый ролик продолжает играть до готовности страницы, поэтому его
    // проверенное усиление сохраняем. Сброс выполнит beginMediaRevision(),
    // когда действительно изменятся video_id, currentSrc или сам плеер.
    completeMediaRevision = '';
    if (!SETTINGS.useNativeSlider) {
      setEarlyNativeHidden(true);
    }
  };
  const refreshAfterNavigation = () =>
    setTimeout(() => {
      bindVideo();
      ensureUI();
      queueMediaLoudnessRefresh();
    }, 0);
  on(document, 'yt-navigate-start', prepareForNavigation);
  // Самый ранний надёжный сигнал нового video_id в Shorts. В Watch он тоже
  // приходит раньше yt-navigate-finish, хотя оба режима переиспользуют <video>.
  on(document, 'yt-player-updated', () => {
    beginMediaRevision();
    queueMediaLoudnessRefresh();
  });
  on(document, 'yt-navigate-finish', refreshAfterNavigation);
  on(document, 'DOMContentLoaded', refreshAfterNavigation);
  on(document, 'visibilitychange', () => {
    if (!document.hidden) queueMediaLoudnessRefresh();
  });
  on(document, 'resume', () => queueMediaLoudnessRefresh());
  on(window, 'pageshow', () => queueMediaLoudnessRefresh());
  on(document, 'fullscreenchange', () => setTimeout(layout, 0));
  on(window, 'resize', layout);

  if (!preload.commitControl(updateSecret, controlApi)) {
    disposeInstance();
    preload.cancelControl(updateSecret);
    return false;
  }

  // Публичный слот нужен только для диагностики из консоли. Управляющих
  // методов и секрета в нём нет; service worker обращается исключительно к
  // неизменяемому preload-брокеру.
  try {
    Object.defineProperty(window, INSTANCE_KEY, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: instanceApi,
    });
  } catch {}
  return true;

  // Полная остановка экземпляра. Вызывается только следующим поколением и
  // только до того, как оно захватит дескрипторы: сначала мы возвращаем
  // нативные volume/muted, потом преемник берёт их уже чистыми.
  function disposeInstance() {
    if (domObserver) domObserver.disconnect();
    clearTimeout(sweepTimer);
    clearTimeout(collapseTimer);
    if (animCleanup) animCleanup();
    clearTimeout(saveVolumeTimer);
    clearTimeout(saveMutedTimer);
    clearTimeout(persistTimer);
    clearTimeout(earlyHideSafetyTimer);
    clearTimeout(mediaLoudnessRefreshTimer);
    releaseYouTubeDrcSetterGuard();
    detachMeter();
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
