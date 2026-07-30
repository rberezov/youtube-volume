  function unbindVideo() {
    if (!videoBinding) return;
    const { video, onVolumeChange, restoreAfterMediaChange, onMediaProgress, onPlaying } =
      videoBinding;
    video.removeEventListener('volumechange', onVolumeChange);
    video.removeEventListener('loadedmetadata', restoreAfterMediaChange);
    video.removeEventListener('playing', restoreAfterMediaChange);
    video.removeEventListener('playing', onPlaying);
    for (const type of LOUDNESS_EVENTS) video.removeEventListener(type, onMediaProgress);
    videoBinding = null;
    boundVideo = null;
    mutedGuardOpen = false;
  }

  function bindVideo() {
    if (!volumeStateLoaded) return;
    const video = getVideo();
    if (!video || video === boundVideo) return;
    unbindVideo();
    boundVideo = video;
    // Новый элемент — снова подавляем autoplay-mute: в Shorts каждая лента
    // приходит со своим <video>, и именно на первых кадрах YouTube успевает
    // выставить mute до того, как мы восстановим состояние.
    mutedGuardOpen = true;
    // Новый ролик — новый уровень: прежнее решение снимаем сразу, новое
    // появится, как только снимок станет согласованным.
    resetLoudness();
    queueMediaLoudnessRefresh(true);
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
    // Звук пошёл — решение об автозапуске принято, и подавлять больше нечего.
    const onPlaying = () => {
      if (video === boundVideo) mutedGuardOpen = false;
    };
    // Решение о выравнивании обновляем по событиям самой дорожки, а не по
    // часам: именно к этим моментам плеер и досоздаёт то, чего не хватало
    // снимку. Синхронную пачку событий склеиваем в один пересчёт.
    const onMediaProgress = () => {
      if (video !== boundVideo) return;
      // Старое усиление снимаем в обработчике самого события, до следующего
      // кадра; дорогой снимок можно безопасно дочитать уже общей задачей.
      beginMediaRevision();
      // video_id и currentSrc при смене языковой дорожки остаются прежними,
      // поэтому обычная проверка завершённой ревизии пропустила бы событие.
      // События редкие и синхронная пачка всё равно склеивается таймером.
      queueMediaLoudnessRefresh(true);
    };
    videoBinding = {
      video,
      onVolumeChange,
      restoreAfterMediaChange,
      onMediaProgress,
      onPlaying,
    };
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('loadedmetadata', restoreAfterMediaChange);
    video.addEventListener('playing', restoreAfterMediaChange);
    video.addEventListener('playing', onPlaying);
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
    const watch = (el) => {
      if (!el || el === ui.box || observedChain.has(el)) return;
      uiResizeObserver.observe(el);
      observedChain.add(el);
    };
    for (let el = ui.box.parentElement; el && el !== player; el = el.parentElement) {
      watch(el);
      // Свободное место считается вычитанием соседей на каждом уровне
      // (см. freeSpace), поэтому их размеры важны не меньше своего. Раньше
      // это ловилось само собой: flex сжимал саму шкалу, и менялся наш
      // размер. Теперь шкала лежит в обрезающей обёртке и своего размера не
      // меняет — за соседями приходится следить явно. Иначе исчезнувшее
      // название главы освобождало место, а шкала оставалась короткой.
      for (const sibling of el.children) watch(sibling);
    }
  }

  function stopObservingUI() {
    if (playerResizeObserver) playerResizeObserver.disconnect();
    if (uiResizeObserver) uiResizeObserver.disconnect();
    observedPlayer = null;
    observedPill = null;
    observedChain.clear();
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
      // Новый ролик приходит раньше своей строки кнопок (замер: лента на 0мс,
      // строка на 164–172мс), и до её появления нельзя вставать никуда: ни
      // резервной тёмной кнопкой в накладной слой, ни в строку самого плеера —
      // потом пришлось бы переезжать. Раньше это закрывалось окном в 700мс,
      // то есть догадкой о задержке. Теперь ждём факта: пока строка не
      // собрана, не строим ничего, а наблюдатель за DOM позовёт снова, как
      // только она появится. Собранная строка без блока громкости —
      // достоверное «штатной громкости здесь не будет».
      if (shortsControlsExpected() && !shortsControlsReady()) return null;
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

