  /* ---- Горячие клавиши и раскладка ------------------------------------- *
   *
   * YouTube опознаёт свои горячие клавиши по `e.key`, то есть по введённому
   * символу. На нелатинской раскладке символ другой (m — это «ь», k — «л»), и
   * клавиши не срабатывают: ни отключение звука, ни пауза. Раскладку
   * приходится переключать ради паузы.
   *
   * Мы опознаём клавишу по `e.code` — это физическая клавиша, от раскладки не
   * зависящая, — и в этом случае **берём событие себе**: выполняем действие
   * сразу и останавливаем дальнейшую доставку.
   *
   * Первая версия решала иначе и оказалась неверной: она действовала
   * отложенно, «если через такт состояние плеера не изменилось». Это гонка.
   * Полевая проверка показала ровно её исход: звук глохнет и тут же
   * возвращается, слышно как лёгкий треск (два резких обрыва волны подряд), а
   * клавиша выглядит нерабочей. Достаточно, чтобы обработчик YouTube сработал
   * не в том же такте, а чуть позже, — и он отменяет наше переключение.
   *
   * Синхронное решение гонки не оставляет: сравнивается символ, а не время.
   * Если символ — латинская буква, действует YouTube, мы только отмечаем
   * намерение. Если символ чужой, YouTube эту клавишу игнорирует по
   * построению, и событие целиком наше — двойного переключения не будет
   * ни при каком порядке обработчиков.
   * ---------------------------------------------------------------------- */
  const HOTKEY_MUTE = { code: 'KeyM', letter: 'm' };
  const HOTKEY_PLAY = { code: 'KeyK', letter: 'k' };
  // Та же физическая клавиша, но символ не латинский: YouTube такое нажатие
  // не опознаёт.
  const foreignLayout = (e, key) =>
    e.code === key.code && String(e.key).toLowerCase() !== key.letter;
  const pressed = (e, key) =>
    e.code === key.code || String(e.key).toLowerCase() === key.letter;

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
      if (e.repeat) return;
      if (pressed(e, HOTKEY_MUTE)) {
        markMutedIntent();
        dropVolumeIntent();
        const video = getVideo();
        if (!video) return;
        // На своей раскладке звук переключит YouTube — нам достаточно
        // отметить намерение, чтобы состояние сохранилось.
        rememberMuted(!video.muted, true);
        if (foreignLayout(e, HOTKEY_MUTE)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          toggleMute(false);
        }
        return;
      }
      // Пауза к громкости отношения не имеет, и в расширении её бы не было —
      // если бы не та же причина: на нелатинской раскладке k у YouTube не
      // работает.
      if (foreignLayout(e, HOTKEY_PLAY)) {
        // Отдельной проверки страницы не нужно: вне Shorts getPlayer() —
        // это #movie_player, и в ленте, где играет только предпросмотр,
        // видео отсюда не возьмётся.
        const video = getVideo();
        if (!video) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlay(video);
      }
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
      // Ветки взаимоисключающие, и это существенно: штатная кнопка звука
      // лежит ВНУТРИ .ytp-volume-area, которую ищет nativeVolumeControl().
      // Пока проверки шли подряд, второе условие тут же заново открывало
      // окно громкости, закрытое первым, — и запись, которую делает mute()
      // плеера, снова принималась за осознанный выбор.
      if (target.closest('.ytp-mute-button, .ytev-mute')) {
        markMutedIntent(5000);
        dropVolumeIntent();
      } else if (nativeVolumeControl(target) || target.closest('.ytev-slider')) {
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

  // Отпускание — тоже жест, и без него правило «запись близко к жесту» ломало
  // бы протяжку с остановкой: нажал, подержал ползунок неподвижно секунду,
  // отпустил — штатный плеер пишет громкость именно на отпускании, а
  // последнее движение к тому времени уже не свежее.
  on(
    window,
    'pointerup',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      // Кнопка звука исключается первой и по той же причине, что при
      // нажатии: она лежит ВНУТРИ .ytp-volume-area. Без этой ветки
      // отпускание заново открывало окно, закрытое нажатием, и ноль от
      // mute() плеера снова становился «выбранной громкостью» — ровно то,
      // что ловит mute-persist.
      if (target.closest('.ytp-mute-button, .ytev-mute')) return;
      if (nativeVolumeControl(target) || target.closest('.ytev-slider')) {
        markVolumeIntent(1500);
        scheduleTrustedNativeVolume(target);
      }
    },
    true
  );

