  /* ---- Почему решение спрашивается у плеера, а не собирается по кусочкам --
   *
   * Новый YouTube умеет отдавать DRC-вариант дорожки («стабильная
   * громкость»): он уже сведён к цели −14 LKFS и его собственный loudnessDb
   * равен нулю, а playerConfig.audioConfig.loudnessDb остаётся от исходной
   * дорожки. Усиление по нему поверх DRC — двойная нормализация: на ролике с
   * «DRC (cont.−14.0 dB / tgt.−14.0 dB)» расширение читало −12.7дБ и
   * накидывало ещё +6дБ.
   *
   * Раньше тип дорожки брался из строки громкости в getStatsForNerds(), и это
   * порождало гонку: замер на переходе Shorts → обычное видео показал усиление
   * на 553мс, признак DRC на 616мс и снятие только на 1513мс. Лечить её окном
   * ожидания нельзя — окно лишь догадка о величине зазора: на медленной машине
   * или медленном канале зазор её превысит, на быстрой мы ждём зря.
   *
   * Полевой дамп ответа плеера показал, что вычислить дорожку из самого ответа
   * тоже нельзя. На ролике с DRC под одним и тем же itag 251 лежат сразу три
   * варианта — исходный (loudnessDb −12.71), DRC (isDrc: true, loudnessDb 0) и
   * ещё один с −4.24; audioTrack у всех null, признака selected/active нет, а
   * в SABR-режиме у форматов нет даже url. То есть streamingData описывает
   * доступные варианты, а не текущий выбор: наличие isDrc: true не значит, что
   * DRC играет. По той же причине не годится и hasDrcAudioTrack() — это
   * доступность, и в момент гонки она запаздывала.
   *
   * Выбранную дорожку знает сам плеер: getDrcState() возвращает 0 при активном
   * DRC и 1 без него, и в пойманной гонке он уже отдавал 0, когда статистика
   * ещё молчала. Но одного его мало: при ручном выключении «стабильной
   * громкости» на ролике с DRC он залипает на 0 — статистика уже показывала
   * исходную дорожку (cont.−26.7дБ), а состояние не менялось ни через пять
   * секунд, ни после перезагрузки. Меняется там getDrcUserPreference():
   * 1 — «стабильная громкость» включена, 0 — выключена.
   * Поэтому DRC считается играющим только при совпадении обоих: состояние 0 и
   * предпочтение 1. Состояние 1 или предпочтение 0 — значит играет исходная
   * дорожка. Всё остальное (включая отсутствие любого из методов) —
   * «неизвестно», а в этом состоянии усиление не поднимается никогда.
   * ------------------------------------------------------------------ */

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

  function callPlayer(player, method) {
    if (!player || typeof player[method] !== 'function') return undefined;
    try {
      return player[method]();
    } catch {
      return undefined;
    }
  }

  // Играет ли сейчас DRC-вариант. null — «неизвестно»: либо плеер не ответил,
  // либо его ответы не складываются в решение.
  function drcFromPlayer(state, preference) {
    if (state === 0 && preference === 1) return true;
    if (state === 1 || preference === 0) return false;
    return null;
  }

  // Запасной путь на случай, если внутренние методы плеера однажды исчезнут:
  // решаем по статистике, но только когда её уровень совпал с уровнем из
  // ответа плеера. Совпадение и есть доказательство, что оба источника
  // описывают один ролик, — без него никакого решения.
  //
  // Форм у строки две. Старая печатала сам loudnessDb («content loudness
  // −12.7dB»), новая — абсолютный уровень и цель («cont.−26.7 dB / tgt.−14.0
  // dB»), а loudnessDb в ней это их разность. Принимаем обе: статистика
  // округляет до десятых, отсюда допуск.
  function statsConfirms(text, db) {
    const numbers = [];
    DB_IN_STATS.lastIndex = 0;
    for (let match; (match = DB_IN_STATS.exec(text)); ) {
      const value = Number(String(match[2]).replace(',', '.')) * (match[1] ? -1 : 1);
      if (Number.isFinite(value)) numbers.push(value);
    }
    const close = (value) => Math.abs(value - db) < 0.1;
    if (numbers.some(close)) return true;
    return numbers.length >= 2 && close(numbers[0] - numbers[1]);
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
   * `getAudioTrack()` возвращает выбранную дорожку, но её форма частично
   * минифицирована YouTube. Не привязываемся к промежуточным именам полей:
   * ограниченно обходим объект и ищем только `id`, который действительно
   * присутствует среди audioTrack.id текущего ответа плеера. Заодно извлекаем
   * itag из непрозрачного верхнего id вида `251;...`, если YouTube его отдал.
   */
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
        const names = Object.getOwnPropertyNames(value).slice(0, 64);
        for (const name of names) {
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
      // DRC и Voice Boost — отдельные обработанные варианты той же дорожки.
      // При нашей нормализации нужен уровень исходного аудио.
      if (format.isDrc === true || format.isVb === true) continue;
      const value =
        format.loudnessDb == null || format.loudnessDb === ''
          ? NaN
          : Number(format.loudnessDb);
      if (Number.isFinite(value)) values.push(value);
    }
    if (!values.length) return NaN;
    // Разные кодеки отличаются на сотые дБ. Существенно разные значения
    // означают, что YouTube добавил ещё один неизвестный вариант: не угадываем.
    if (Math.max(...values) - Math.min(...values) >= 0.15) return NaN;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  /**
   * Полное решение из одного снимка состояния плеера.
   * `complete: false` — «пока неизвестно»; в этом состоянии усиление не
   * поднимается никогда, поэтому худший исход на медленной машине — «тише,
   * чем могло бы», и никогда «громче, чем нужно».
   */
  function readLoudness(player) {
    const id = currentVideoId(player);
    const stats = statsVolumeText(player);
    // Сырые ответы плеера возим в снимке: полевой разбор регресса со
    // «стабильной громкостью» упирался ровно в то, что их не было видно.
    const state = callPlayer(player, 'getDrcState');
    const preference = callPlayer(player, 'getDrcUserPreference');
    const unknown = {
      id,
      db: null,
      drc: false,
      complete: false,
      source: '',
      stats,
      state,
      preference,
      trackId: '',
      trackItag: null,
      dbSource: '',
    };
    if (!player || typeof player.getPlayerResponse !== 'function') return unknown;
    // Ответ плеера — объект страницы: и вызов, и последующее чтение свойств
    // может бросить (геттеры там чужие). Разбор целиком под try, потому что
    // bindVideo() зовёт refreshLoudness() ДО восстановления сохранённой
    // громкости: исключение отсюда оставило бы новый <video> с громкостью
    // YouTube и без наших слушателей.
    try {
      return readResponse(player, id, unknown, stats, state, preference);
    } catch {
      return unknown;
    }
  }

  function readResponse(player, id, unknown, stats, state, preference) {
    const response = player.getPlayerResponse();
    if (!response) return unknown;
    // Сразу после перехода плеер ещё какое-то время отдаёт ответ предыдущего
    // ролика. Снимок от чужого ролика решением не считается.
    const details = response.videoDetails;
    const snapshotId = details && details.videoId ? String(details.videoId) : '';
    if (id && snapshotId && snapshotId !== id) return unknown;
    const videoId = id || snapshotId;
    if (!videoId) return unknown;
    unknown.id = videoId;

    const formats =
      response.streamingData && Array.isArray(response.streamingData.adaptiveFormats)
        ? response.streamingData.adaptiveFormats
        : [];
    const track = activeAudioTrack(player, formats);
    const trackDb = activeTrackLoudness(formats, track);
    const config = response.playerConfig && response.playerConfig.audioConfig;
    const raw = config ? config.loudnessDb : undefined;
    const configDb = raw == null || raw === '' ? NaN : Number(raw);
    // В многоязычном ответе общее audioConfig.loudnessDb может относиться к
    // оригиналу, хотя фактически играет перевод. Если выбранную дорожку пока
    // нельзя сопоставить, безопаснее дождаться следующего события, чем
    // применить уровень другого языка.
    const db = Number.isFinite(trackDb)
      ? trackDb
      : track.count > 1
        ? NaN
        : configDb;
    const known = {
      id: videoId,
      db: Number.isFinite(db) ? db : null,
      stats,
      state,
      preference,
      trackId: track.id,
      trackItag: track.itag,
      dbSource: Number.isFinite(trackDb)
        ? 'audioTrack'
        : Number.isFinite(configDb) && track.count <= 1
          ? 'audioConfig'
          : '',
    };
    // Прочитанный уровень показываем и в неполном снимке: без него
    // диагностика не отличит «уровня ещё нет» от «нечем подтвердить».
    unknown.db = known.db;

    const drc = drcFromPlayer(state, preference);
    // При активном DRC уровень уже не нужен: усиливать нечего в любом случае.
    if (drc === true) return { ...known, drc: true, complete: true, source: 'drcState' };
    if (!Number.isFinite(db)) return unknown;
    if (drc === false) return { ...known, drc: false, complete: true, source: 'drcState' };

    if (/\bDRC\b/.test(stats)) {
      return { ...known, drc: true, complete: true, source: 'stats' };
    }
    if (statsConfirms(stats, db)) {
      return { ...known, drc: false, complete: true, source: 'stats' };
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
    loudnessCacheId = '';
    loudnessCacheTrackId = '';
    loudnessCacheTrackItag = null;
    setLoudnessBoost(1);
  }

  function mediaObjectId(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return 0;
    let id = mediaObjectIds.get(value);
    if (!id) {
      id = nextMediaObjectId++;
      mediaObjectIds.set(value, id);
    }
    return id;
  }

  function mediaSourceId(video) {
    if (!video) return 0;
    const src = String(video.currentSrc || video.src || '');
    const previous = mediaSourceIds.get(video);
    if (previous && previous.src === src) return previous.id;
    const next = { src, id: nextMediaSourceId++ };
    mediaSourceIds.set(video, next);
    return next.id;
  }

  function playerForRevisionVideo(video) {
    if (!video || typeof video.closest !== 'function') return null;
    const candidates = [
      video.closest('.html5-video-player'),
      video.closest('#shorts-player'),
      video.closest('#movie_player'),
      video.closest('ytd-reel-video-renderer'),
    ];
    return (
      candidates.find(
        (candidate) =>
          candidate &&
          (typeof candidate.getVideoData === 'function' ||
            typeof candidate.getPlayerResponse === 'function')
      ) ||
      candidates.find(Boolean) ||
      null
    );
  }

  /**
   * В Shorts один плеер и один <video> переезжают между роликами, поэтому
   * идентичности DOM-узлов недостаточно. В Watch YouTube тоже иногда повторно
   * использует их, но video_id и currentSrc обновляются в другой момент.
   * URL намеренно не входит в ключ: при Shorts → Home адрес меняется раньше,
   * чем перестаёт звучать старое видео. Реальная смена определяется плеером,
   * <video>, video_id и currentSrc — именно они описывают источник звука.
   */
  function currentMediaRevision() {
    const selectedPlayer = getPlayer();
    const selectedVideo = selectedPlayer ? selectedPlayer.querySelector('video') : null;
    // Во время Shorts → Home новый плеер ещё не выбран, но прежний <video>
    // продолжает играть. URL уже не Shorts, поэтому getPlayer() возвращает
    // null; держимся за фактически звучащий boundVideo до его остановки.
    const keepPlayingBound =
      boundVideo &&
      !boundVideo.paused &&
      !boundVideo.ended &&
      (!selectedVideo || selectedVideo === boundVideo || selectedVideo.paused);
    const video = keepPlayingBound ? boundVideo : selectedVideo;
    const player =
      keepPlayingBound ? playerForRevisionVideo(boundVideo) || selectedPlayer : selectedPlayer;
    const data = callPlayer(player, 'getVideoData');
    let id = data && typeof data === 'object' ? String(data.video_id || '') : '';
    const shorts = location.pathname.startsWith('/shorts/');
    if (!id && shorts) id = location.pathname.split('/')[2] || '';
    if (!id && !shorts) {
      try {
        id = new URL(location.href).searchParams.get('v') || '';
      } catch {}
    }
    return `p${mediaObjectId(player)}|v${mediaObjectId(video)}|${id}|s${mediaSourceId(
      video
    )}`;
  }

  function beginMediaRevision() {
    const revision = currentMediaRevision();
    if (revision !== observedMediaRevision) {
      observedMediaRevision = revision;
      completeMediaRevision = '';
      resetLoudness();
    }
    return revision;
  }

  function refreshLoudness() {
    const revision = beginMediaRevision();
    const player = getPlayer();
    const youtubeNormalizationDisabled = disableYouTubeNormalization(player);
    const snap = readLoudness(player);
    // Ролик сменился — прежнее решение недействительно, и ждать полного
    // снимка нельзя. bindVideo() сюда не поможет: он выходит первой строкой,
    // если <video> тот же, а YouTube переиспользует элемент для следующего
    // ролика. Без этого усиление предыдущего действовало бы всё время, пока
    // снимок нового неполон, — то самое «громче, чем нужно».
    if (snap.id && loudnessKey && !loudnessKey.startsWith(snap.id + '|')) {
      resetLoudness();
    }
    // Если API переключателя исчез, но статистика уже однозначно подтверждает
    // исходную дорожку, применять нашу нормализацию безопасно. При DRC или
    // неизвестном состоянии остаёмся на единичном усилении.
    if (
      !snap.complete ||
      (SETTINGS.normalizeLoudness && !youtubeNormalizationDisabled && snap.drc)
    ) {
      if (completeMediaRevision === revision) completeMediaRevision = '';
      return false;
    }
    completeMediaRevision = revision;
    // В ключ входит признак DRC для режима с выключенной нашей нормализацией
    // и сама настройка: при её переключении решение обязано пересчитаться.
    const key = `${snap.id}|${snap.trackId || 'default'}|${
      snap.trackItag == null ? 'any' : snap.trackItag
    }|${snap.drc ? 'drc' : 'raw'}|${Number.isFinite(snap.db) ? snap.db.toFixed(3) : 'none'}|${
      SETTINGS.normalizeLoudness ? SETTINGS.maxBoostDb : 'off'
    }`;
    if (key === loudnessKey) return true;
    loudnessKey = key;
    loudnessCacheId = snap.id;
    loudnessCacheTrackId = snap.trackId || '';
    loudnessCacheTrackItag = snap.trackItag == null ? null : snap.trackItag;
    setLoudnessBoost(Math.pow(10, loudnessDbFor(snap) / 20));
    // document_start-preload прочитает это на следующей полной загрузке и
    // применит проверенный уровень именно к тому же video_id ещё до play().
    cachePreferredState();
    return true;
  }

  /**
   * Склеивает пачку emptied/durationchange/loadedmetadata/... в один проход.
   * Таймер здесь не определяет корректность и не является опросом: новое
   * событие уже произошло, мы лишь даём синхронной пачке событий закончиться.
   */
  function queueMediaLoudnessRefresh(force = false) {
    mediaLoudnessRefreshForced = mediaLoudnessRefreshForced || force;
    if (mediaLoudnessRefreshTimer) return;
    mediaLoudnessRefreshTimer = setTimeout(() => {
      mediaLoudnessRefreshTimer = 0;
      const forced = mediaLoudnessRefreshForced;
      mediaLoudnessRefreshForced = false;
      const revision = beginMediaRevision();
      const generation = youtubeNormalizationGeneration;
      const ready = disableYouTubeNormalization(getPlayer());
      const drcChanged = generation !== youtubeNormalizationGeneration;
      if (
        !forced &&
        ready &&
        !drcChanged &&
        !youtubeNormalizationPending &&
        completeMediaRevision === revision
      ) {
        return;
      }
      refreshLoudness();
    }, 0);
  }

  /**
   * Сколько дБ добавить (или убрать) на этом ролике.
   *
   * Приглушение громких — не наша добавка, а восстановление того, что делает
   * сам YouTube, и потому оно не зависит от настройки. Плеер приглушает
   * громкий ролик записью в `video.volume`, а мы такие записи откатываем к
   * сохранённому уровню (иначе YouTube сбрасывал бы громкость на своё
   * значение при каждом переходе). Полевой замер на Shorts с loudnessDb
   * +3.48 показал результат: приглушение до звука не доезжало, и ролик играл
   * на 3.5дБ громче, чем без расширения. Раз громкость перехватываем мы,
   * применять его тоже нам.
   *
   * Подъём тихих — наша добавка, её и включает настройка. При включённой
   * настройке Stable Volume уже принудительно выключена и здесь всегда
   * обрабатывается исходная дорожка. В режиме без нашей нормализации активный
   * DRC по-прежнему оставляем как есть.
   */
  function loudnessDbFor(snap) {
    if (snap.drc) return 0;
    if (snap.db > 0) return -snap.db;
    return SETTINGS.normalizeLoudness ? Math.min(SETTINGS.maxBoostDb, -snap.db) : 0;
  }

  // Итоговое усиление в графе. Компенсация живёт только здесь: запасной
  // путь пишет прямо в video.volume, а он выше единицы не поднимается.
  const loudnessBoostFor = (el) => {
    const preview = previewLoudnessState.get(el);
    if (preview) return preview.boost;
    return el === boundVideo || el === getVideo() ? loudnessBoost : 1;
  };
  const outputGain = (el, real) => (el.muted ? 0 : real * loudnessBoostFor(el));

