  /* ------------------------------------------------------------------ *
   * 1a-bis. Выравнивание громкости роликов
   *
   * YouTube кладёт в ответ плеера loudnessDb — насколько ролик громче
   * своей цели нормализации. Громкие он приглушает сам, умножая громкость
   * на 10^(-loudnessDb/20). Тихие не подтягивает: управляет он только
   * video.volume, а тот выше единицы не поднимается — поэтому лекция,
   * записанная на петличку, так и остаётся тихой. У нас усилитель Web
   * Audio, и недостающее мы можем добрать сами.
   *
   * Приглушение громких тоже приходится делать нам, и это не прихоть.
   * Плеер применяет его записью в video.volume, а мы такие записи
   * откатываем к сохранённому уровню — иначе YouTube сбрасывал бы громкость
   * на своё значение при каждом переходе. То есть перехват громкости
   * отменяет и приглушение: на Shorts с loudnessDb +3.48 ролик играл на
   * 3.5дБ громче, чем без расширения. Поэтому приглушение восстанавливается
   * независимо от настройки — это возврат к поведению YouTube, а не добавка.
   *
   * Добираем осторожно: только нехватку и не больше выбранного предела
   * (по умолчанию 6дБ, настройка «Предел подъёма»). Это сознательно
   * консервативно — у материала, который на N дБ тише цели, обычно есть
   * примерно столько же запаса до пика, поэтому лимитер (он добавил бы
   * задержку и рассинхрон с картинкой) не нужен.
   * ------------------------------------------------------------------ */

  // События дорожки, на которых имеет смысл перечитать снимок. emptied и
  // durationchange — это ровно то, что YouTube испускает при ручном
  // переключении «стабильной громкости»: без них решение ждало бы тика.
  const LOUDNESS_EVENTS = [
    'emptied',
    'durationchange',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'playing',
  ];
  let loudnessBoost = 1;
  let loudnessKey = '';
  let loudnessCacheId = '';
  let loudnessCacheTrackId = '';
  let loudnessCacheTrackItag = null;
  let youtubeNormalizationPending = false;
  let youtubeNormalizationApiAvailable = false;
  let youtubeNormalizationForcedOff = false;
  let youtubeNormalizationGeneration = 0;
  let youtubeDrcRestoreNeeded = false;
  let youtubeDrcRestoreStateLoaded = false;
  let youtubeDrcRestoreStateTracked = false;
  let youtubeDrcSetterGuard = null;
  const mediaObjectIds = new WeakMap();
  const mediaSourceIds = new WeakMap();
  let nextMediaObjectId = 1;
  let nextMediaSourceId = 1;
  let observedMediaRevision = '';
  let completeMediaRevision = '';
  let mediaLoudnessRefreshTimer = 0;
  let mediaLoudnessRefreshForced = false;

  function requestYouTubeDrcStateSync() {
    window.postMessage(
      {
        type: 'YTEV_DRC_STATE_DIRTY',
        channel: CHANNEL_ID,
      },
      PAGE_ORIGIN
    );
  }

  function rememberYouTubeDrcWasEnabled() {
    if (youtubeDrcRestoreStateTracked && youtubeDrcRestoreNeeded) return;
    youtubeDrcRestoreStateTracked = true;
    youtubeDrcRestoreNeeded = true;
    requestYouTubeDrcStateSync();
  }

  function rememberYouTubeDrcWasDisabled() {
    if (youtubeDrcRestoreStateTracked) return;
    youtubeDrcRestoreStateTracked = true;
    youtubeDrcRestoreNeeded = false;
    requestYouTubeDrcStateSync();
  }

  function rememberYouTubeDrcUserIntent(enabled) {
    const needed = enabled === true;
    if (youtubeDrcRestoreStateTracked && youtubeDrcRestoreNeeded === needed) return;
    youtubeDrcRestoreStateTracked = true;
    youtubeDrcRestoreNeeded = needed;
    requestYouTubeDrcStateSync();
  }

  function releaseYouTubeDrcSetterGuard() {
    const guard = youtubeDrcSetterGuard;
    youtubeDrcSetterGuard = null;
    if (!guard || guard.player.setDrcUserPreference !== guard.wrapper) return;
    try {
      guard.player.setDrcUserPreference = guard.original;
    } catch {}
  }

  function callOriginalDrcSetter(player, value) {
    const guard = youtubeDrcSetterGuard;
    const setter =
      guard && guard.player === player && player.setDrcUserPreference === guard.wrapper
        ? guard.original
        : player && player.setDrcUserPreference;
    if (typeof setter !== 'function') return false;
    setter.call(player, value);
    youtubeNormalizationGeneration += 1;
    return true;
  }

