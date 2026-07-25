// Работает в MAIN-мире страницы: перехватывает установку громкости у
// HTMLMediaElement и применяет экспоненциальную кривую, а также добавляет
// в панель плеера длинный точный ползунок вместо стандартного.
(() => {
  'use strict';

  const SETTINGS = {
    enabled: true,          // применять экспоненциальную кривую
    gamma: 3,               // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderScale: 20,        // длина ползунка в % от ширины плеера
    shortsScale: 50,        // то же для Shorts — плеер узкий, размер свой
    showPercent: true,      // подпись с процентами рядом с ползунком
    autoCollapse: false,    // сворачивать шкалу, когда курсор не на ней
    useNativeSlider: false, // не строить свою шкалу — оставить штатную
  };

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

  const logicalOf = (el) =>
    logicalVolume.has(el) ? logicalVolume.get(el) : nativeDesc.get.call(el);

  /* ------------------------------------------------------------------ *
   * 1a. Регулировка через Web Audio — главное средство против треска
   *
   * Запись в video.volume из JS принципиально ступенчата: значение
   * применяется на границах аудиобуферов, поэтому быстрые изменения
   * дают «zipper noise» (треск), а экспоненциальная кривая ещё и
   * утраивает шаг в верхней части шкалы. GainNode автоматизирует
   * усиление в аудиопотоке с частотой дискретизации: setTargetAtTime с
   * постоянной времени 15мс воспринимается мгновенным, но щелчков не
   * даёт вовсе.
   *
   * Ограничения Web Audio, которые здесь обойдены:
   *  - DRM (EME): createMediaElementSource на защищённом потоке даёт
   *    тишину — такие элементы не подключаем (mediaKeys / событие
   *    encrypted);
   *  - приостановленный AudioContext (политика автовоспроизведения):
   *    подключаемся только когда контекст реально работает;
   *  - подключение необратимо, поэтому есть сторож тишины: если через
   *    граф ничего не идёт, возвращаемся к прямой записи громкости.
   * ------------------------------------------------------------------ */

  const audio = { ctx: null, failed: false, nodes: new WeakMap() };
  const drmElements = new WeakSet();

  document.addEventListener(
    'encrypted',
    (e) => {
      if (e.target instanceof HTMLMediaElement) drmElements.add(e.target);
    },
    true
  );

  function audioGraph(el) {
    if (audio.failed || !(el instanceof HTMLMediaElement)) return null;
    const existing = audio.nodes.get(el);
    if (existing) return existing;
    if (drmElements.has(el) || el.mediaKeys) return null; // защищённый поток
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!audio.ctx) audio.ctx = new Ctx();
    } catch {
      audio.failed = true;
      return null;
    }
    if (audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
    // пока контекст не запущен, звук через граф не пойдёт — ждём
    if (audio.ctx.state !== 'running') return null;
    try {
      const src = audio.ctx.createMediaElementSource(el);
      const gain = audio.ctx.createGain();
      gain.gain.value = toReal(logicalOf(el));
      src.connect(gain).connect(audio.ctx.destination);
      const node = { src, gain, target: gain.gain.value };
      audio.nodes.set(el, node);
      // уровень задаёт gain, сам элемент держим на максимуме
      nativeDesc.set.call(el, 1);
      el.addEventListener('volumechange', () => applyReal(el, toReal(logicalOf(el))));
      watchSilence(el, node);
      return node;
    } catch {
      audio.failed = true;
      return null;
    }
  }

  // Сторож: если через граф идёт ровно ноль при играющем незаглушённом
  // видео — значит подключение не работает (например, неожиданный DRM).
  // Тогда снимаем усиление и возвращаемся к прямой записи громкости.
  function watchSilence(el, node) {
    const ctx = audio.ctx;
    let analyser;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      node.gain.connect(analyser);
    } catch {
      return;
    }
    const buf = new Uint8Array(analyser.fftSize);
    let silentFor = 0;
    let lastTime = -1;
    let ticks = 0;
    const timer = setInterval(() => {
      if (!el.isConnected || audio.failed || ++ticks > 240) {
        clearInterval(timer); // элемент ушёл, откат уже был или прошло 2 минуты
        return;
      }
      const playing = !el.paused && !el.muted && el.currentTime !== lastTime;
      lastTime = el.currentTime;
      if (!playing || node.target < 0.01) {
        silentFor = 0;
        return;
      }
      analyser.getByteTimeDomainData(buf);
      const silent = buf.every((v) => v === 128); // 128 — цифровая тишина
      silentFor = silent ? silentFor + 500 : 0;
      if (silentFor >= 2000) {
        clearInterval(timer);
        fallbackToDirect(el, node);
      } else if (!silent && silentFor === 0 && lastTime > 3) {
        clearInterval(timer); // звук идёт — сторож больше не нужен
      }
    }, 500);
  }

  function fallbackToDirect(el, node) {
    audio.failed = true;
    audio.nodes.delete(el);
    try {
      node.gain.disconnect();
      node.src.connect(audio.ctx.destination);
    } catch {}
    nativeDesc.set.call(el, Math.min(1, Math.max(0, node.target)));
  }

  // Основной путь установки фактической громкости
  function applyReal(el, real) {
    const node = audioGraph(el);
    if (node) {
      const target = el.muted ? 0 : real;
      node.target = target;
      // 15мс — «мгновенно на слух», но без щелчка
      node.gain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.015);
      if (nativeDesc.get.call(el) !== 1) nativeDesc.set.call(el, 1);
      return;
    }
    setRealSmooth(el, real);
  }

  // Контекст можно запустить только после жеста пользователя, поэтому
  // пробуем подключиться на любом взаимодействии и при старте
  // воспроизведения; до этого работает запасной путь
  let lastEngage = 0;
  function engageAudio() {
    if (audio.failed) return;
    const now = Date.now();
    if (now - lastEngage < 400) return; // не дёргаем на каждое нажатие клавиши
    lastEngage = now;
    if (audio.ctx && audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
    document.querySelectorAll('video, audio').forEach((el) => {
      if (!el.paused) audioGraph(el);
    });
  }
  for (const type of ['pointerdown', 'keydown', 'playing']) {
    document.addEventListener(type, engageAudio, true);
  }

  // Запасной путь (Web Audio недоступен): подводка таймером — грубее,
  // чем автоматизация в аудиопотоке, но лучше мгновенного скачка
  const ramps = new WeakMap();
  function setRealSmooth(el, target) {
    let st = ramps.get(el);
    if (!st) {
      st = { active: false, target: 0 };
      ramps.set(el, st);
    }
    st.target = target;
    if (st.active) return; // текущий цикл дотянет до новой цели
    const current = nativeDesc.get.call(el);
    if (Math.abs(current - target) < 1e-6) return;
    if (document.hidden) {
      // в фоновой вкладке таймеры заторможены — ставим сразу
      nativeDesc.set.call(el, target);
      return;
    }
    st.active = true;
    let value = current;
    let last = performance.now();
    const step = () => {
      if (document.hidden) {
        nativeDesc.set.call(el, st.target);
        st.active = false;
        return;
      }
      const now = performance.now();
      const k = 1 - Math.exp(-(now - last) / 40); // постоянная времени 40мс
      last = now;
      value += (st.target - value) * Math.max(k, 0.2);
      if (Math.abs(st.target - value) < 0.002) {
        nativeDesc.set.call(el, st.target);
        st.active = false;
        return;
      }
      nativeDesc.set.call(el, Math.min(1, Math.max(0, value)));
      setTimeout(step, 16);
    };
    step();
  }

  // Применить кривую заново (после смены настроек); плавная подводка сама
  // пропускает элементы, у которых фактическое значение не меняется
  function reapplyCurve() {
    document.querySelectorAll('video, audio').forEach((el) => {
      if (logicalVolume.has(el)) applyReal(el, toReal(logicalVolume.get(el)));
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Настройки из popup (приходят через bridge.js, isolated world)
   * ------------------------------------------------------------------ */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'YTEV_SETTINGS') return;
    Object.assign(SETTINGS, e.data.settings);
    reapplyCurve();
    ensureUI(); // включение/выключение своей шкалы должно срабатывать сразу
    layout();
    updateUI();
    updateCollapsed();
  });
  window.postMessage({ type: 'YTEV_GET_SETTINGS' }, '*');

  /* ------------------------------------------------------------------ *
   * 3. Длинный точный ползунок в панели плеера
   *
   * Размеры задаются относительно плеера: толщина ползунка, бегунок и
   * подпись масштабируются через CSS-переменные (в полноэкранном режиме
   * YouTube ставит на плеер класс ytp-big-mode), а длина считается в JS —
   * доля ширины плеера, ограниченная реально свободным местом в панели.
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    /* Штатные ползунок и кнопка звука скрываются ТОЛЬКО при классе
       ytev-active — он ставится после успешного монтирования нашего
       блока и снимается в режиме отката. Если код расширения упадёт,
       класса не будет и штатная громкость останется на месте. */
    .ytev-active .ytp-volume-panel,
    .ytev-active .ytp-mute-button {
      display: none !important;
    }
    /* при наведении YouTube резервирует ширину под выезжающий штатный
       ползунок — он скрыт, поэтому рамка раздувалась бы впустую; пока
       работает наш ползунок, запрещаем области громкости менять ширину */
    .ytev-active .ytp-volume-area {
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      transition: none !important;
    }
    .ytev-box {
      --ytev-track: 4px;
      --ytev-thumb: 13px;
      --ytev-font: 12px;
      display: flex;
      align-items: center;
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      margin: 0 8px;
      position: relative;
    }
    /* содержимое поверх слоя подсветки */
    .ytev-box > * { position: relative; z-index: 1; }
    /* геометрия рамки: справа поле --ytev-pad, слева меньше — значок
       YouTube (viewBox 36×36) несёт собственные внутренние поля */
    .ytev-box.ytev-framed {
      padding: 0 var(--ytev-pad, 10px) 0 calc(var(--ytev-pad, 10px) * .25);
      gap: calc(var(--ytev-pad, 10px) * .5);
    }
    .ytev-box:not(.ytev-framed) { gap: 6px; }
    /* Если штатная кнопка звука была у правого края (обычное место в
       Shorts), шкала разворачивается влево — кнопка остаётся на своём
       месте, как у штатной выезжающей панели */
    .ytev-box.ytev-mirrored { flex-direction: row-reverse; }
    .ytev-box.ytev-framed.ytev-mirrored:not(.ytev-collapsed) {
      padding: 0 calc(var(--ytev-pad, 10px) * .25) 0 var(--ytev-pad, 10px);
    }
    /* Shorts: своего места в интерфейсе нет — кладём блок в собственный
       слой поверх плеера. Слой не перехватывает клики, блок — перехватывает */
    .ytev-overlay {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1000;
      display: flex;
      pointer-events: none;
    }
    .ytev-overlay .ytev-box {
      pointer-events: auto;
      transition: opacity .2s ease;
    }
    /* указатель ушёл с ролика — блок скрывается, как штатные кнопки */
    .ytev-pointer-away .ytev-overlay .ytev-box {
      opacity: 0;
      pointer-events: none;
    }
    /* своя кнопка звука с оригинальным значком YouTube: почти на всю
       высоту рамки, как у штатной, — сам глиф имеет поля внутри viewBox */
    .ytev-mute {
      flex: none;
      height: calc(100% - 4px);
      aspect-ratio: 1 / 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      padding: 0;
      margin: 0;
      color: #fff;
      cursor: pointer;
    }
    .ytev-box:not(.ytev-framed) .ytev-mute { height: 36px; }
    .ytev-mute svg { width: 100%; height: 100%; display: block; }
    /* Значок — один стиль, как в оригинальном плеере: заливка
       currentColor с тонкой тёмной обводкой (paint-order: stroke даёт
       тот же эффект, что слой .ytp-svg-shadow у YouTube) */
    .ytev-shape {
      fill: currentColor;
      stroke: rgba(0, 0, 0, .15);
      stroke-width: 2px;
      paint-order: stroke;
    }
    /* волны появляются и уходят от рупора при переходах громкости */
    .ytev-wave {
      transform-box: fill-box;
      transform-origin: left center;
      transition: opacity .13s ease, transform .13s ease;
    }
    .ytev-box[data-vol="muted"] .ytev-wave,
    .ytev-box[data-vol="low"] .ytev-wave-2 {
      opacity: 0;
      transform: translateX(-1.5px) scale(.55);
    }
    /* перечёркивание прочерчивается, как при отключении звука в YouTube;
       широкий тёмный штрих под ним даёт «вырез» в рупоре */
    .ytev-slash, .ytev-slash-cut {
      fill: none;
      stroke-linecap: round;
      stroke-dasharray: 27;
      stroke-dashoffset: 27;
      transition: stroke-dashoffset .18s ease;
    }
    .ytev-slash-cut { stroke: rgba(0, 0, 0, .55); stroke-width: 5px; }
    .ytev-slash { stroke: currentColor; stroke-width: 2.4px; }
    .ytev-box[data-vol="muted"] .ytev-slash,
    .ytev-box[data-vol="muted"] .ytev-slash-cut { stroke-dashoffset: 0; }
    /* автосворачивание: без курсора остаётся только кнопка; переходы
       включаются лишь на время переключения (.ytev-animating), чтобы
       не мешать замерам layout() */
    .ytev-box.ytev-animating { transition: gap .25s ease, padding .25s ease; }
    .ytev-box.ytev-animating .ytev-slider { transition: width .25s ease, opacity .2s ease; }
    .ytev-box.ytev-animating .ytev-label { transition: max-width .25s ease, opacity .2s ease; }
    /* Свёрнутое состояние — ровный круг со значком по центру, как
       штатные круглые кнопки YouTube. Кнопка занимает «высота − 4px»,
       поэтому симметричные поля по 2px дают ширину, равную высоте.
       border-radius перебивает инлайновое скругление, скопированное с
       плашки, поэтому !important. */
    .ytev-box.ytev-collapsed { gap: 0; padding: 0; }
    .ytev-box.ytev-framed.ytev-collapsed {
      padding: 0 2px;
      border-radius: 50% !important;
    }
    .ytev-box.ytev-collapsed .ytev-slider {
      width: 0 !important;
      min-width: 0 !important;
      opacity: 0;
    }
    .ytev-box.ytev-collapsed .ytev-label {
      max-width: 0;
      min-width: 0;
      opacity: 0;
    }
    /* подсветка при наведении — внутренний скруглённый слой с одинаковым
       пиксельным зазором со всех четырёх сторон, как у штатных «пилюль»
       YouTube; скругление уменьшено на величину зазора, чтобы контуры
       были концентричными; на раскладку не влияет */
    .ytev-box.ytev-framed::after {
      content: '';
      position: absolute;
      inset: var(--ytev-hl-inset, 4px);
      border-radius: var(--ytev-hl-radius, 16px);
      background: rgba(255, 255, 255, .12);
      opacity: 0;
      transition: opacity .1s;
      pointer-events: none;
      z-index: 0;
    }
    .ytev-box.ytev-framed:hover::after { opacity: 1; }
    .ytp-big-mode .ytev-box {
      --ytev-track: 5px;
      --ytev-thumb: 18px;
      --ytev-font: 15px;
      margin-left: 10px;
    }
    .ytev-slider {
      -webkit-appearance: none;
      appearance: none;
      min-width: 0;
      height: var(--ytev-track);
      border-radius: calc(var(--ytev-track) / 2);
      background: rgba(255, 255, 255, .3);
      outline: none;
      cursor: pointer;
      margin: 0;
    }
    .ytev-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: var(--ytev-thumb);
      height: var(--ytev-thumb);
      border-radius: 50%;
      background: #fff;
      border: none;
    }
    .ytev-label {
      color: #eee;
      font-family: Roboto, Arial, sans-serif;
      font-size: var(--ytev-font);
      line-height: 1;
      min-width: 2.5em; /* ровно под «100%», чтобы рамка не гуляла по ширине */
      max-width: 5em;
      overflow: hidden;
      text-align: center; /* запас ширины делится поровну на обе стороны */
      white-space: nowrap;
      user-select: none;
    }
    .ytev-muted .ytev-slider,
    .ytev-muted .ytev-label { opacity: .4; }
  `;
  document.documentElement.appendChild(style);

  const MIN_SLIDER = 48; // короче — бесполезно, лучше спрятать
  const SAFETY_GAP = 4;  // запас на округления, чтобы панель не «поехала»

  // фиксированные константы, вычисляются ОДИН раз из размеров плашки при
  // первом измерении и дальше не меняются:
  let edgeGap = 0;     // отступ по краям рамки (снаружи)
  let hlInset = 0;     // зазор слоя подсветки от рамки, одинаковый со всех сторон
  let shortsGap = 0;   // то же для Shorts — там свои размеры плеера
  let shortsInset = 0;

  // { box, slider, label, muteBtn, hiddenPill }
  let ui = null;
  let boundVideo = null;
  let observedPlayer = null;
  let observedPill = null;

  const isShorts = () => location.pathname.startsWith('/shorts/');

  // Активный плеер: на странице Shorts это плеер текущей ленты (он один и
  // переезжает между роликами), на обычной странице — #movie_player
  function getPlayer() {
    if (isShorts()) {
      // разметку Shorts YouTube меняет чаще прочего, поэтому пробуем
      // несколько путей и требуем, чтобы элемент был реально виден
      const selectors = [
        'ytd-reel-video-renderer[is-active] .html5-video-player',
        '#shorts-player .html5-video-player',
        'ytd-shorts .html5-video-player',
        '#shorts-player',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.clientWidth && el.clientHeight) return el;
      }
      // последний рубеж: контейнер видимого видео на странице
      const videos = [...document.querySelectorAll('video')].filter((v) => v.clientWidth);
      const video = videos.find((v) => !v.paused) || videos[0];
      const host =
        video && video.closest('.html5-video-player, #shorts-player, ytd-reel-video-renderer');
      if (host) return host;
    }
    return document.getElementById('movie_player');
  }
  const getVideo = () => {
    const p = getPlayer();
    return p ? p.querySelector('video') : null;
  };

  const fmt = (pct) => (pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';

  // Центр бегунка ходит не по всей ширине дорожки, а в пределах
  // [thumb/2, width − thumb/2], поэтому заливка «в процентах от ширины»
  // отставала от бегунка тем сильнее, чем ближе к краям. Считаем границу
  // заливки по фактическому положению центра.
  function paint(pct) {
    const w = ui.trackW || ui.slider.getBoundingClientRect().width;
    const thumb = ui.thumbPx || 13;
    const edge =
      w > thumb ? ((thumb / 2 + (pct / 100) * (w - thumb)) / w) * 100 : pct;
    ui.slider.style.background =
      `linear-gradient(to right, #fff 0% ${edge}%, rgba(255,255,255,.3) ${edge}% 100%)`;
  }

  function updateUI() {
    if (!ui) return;
    const video = getVideo();
    if (!video) return;
    const pct = video.volume * 100; // логическая громкость
    ui.slider.value = pct;
    paint(pct);
    ui.label.textContent = fmt(pct);
    const muted = video.muted || pct === 0;
    ui.box.classList.toggle('ytev-muted', muted);
    const state = muted ? 'muted' : pct < 50 ? 'low' : 'high';
    ui.box.dataset.vol = state;
    if (ui.muteBtn) {
      ui.muteBtn.title = muted ? 'Включить звук (m)' : 'Отключить звук (m)';
    }
    const real = toReal(pct / 100) * 100;
    ui.slider.title = SETTINGS.enabled
      ? `Громкость: ${fmt(pct)} (на выходе ≈ ${fmt(real)})`
      : `Громкость: ${fmt(pct)}`;
  }

  /* ------------------------------------------------------------------ *
   * Значок кнопки звука
   *
   * Один собственный значок в стиле оригинального плеера: те же формы
   * (viewBox 36×36), та же заливка с тонкой тёмной обводкой. Клонировать
   * SVG у штатной кнопки нельзя: в новом интерфейсе она содержит формы
   * сразу нескольких состояний, а переключают их классы на самой кнопке
   * — в копии все состояния накладывались друг на друга. Состояние
   * задаётся атрибутом data-vol на блоке, переходы делает CSS.
   * ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // формы значка громкости из плеера YouTube (viewBox 36×36)
  const ICON = {
    horn: 'M8,21 L12,21 L17,26 L17,10 L12,15 L8,15 L8,21 Z',
    wave1:
      'M19,14 L19,22 C20.48,21.32 21.5,19.77 21.5,18 C21.5,16.26 20.48,14.74 19,14 Z',
    wave2:
      'M19,11.29 C21.89,12.15 24,14.83 24,18 C24,21.17 21.89,23.85 19,24.71 L19,26.77 C23.01,25.86 26,22.28 26,18 C26,13.72 23.01,10.14 19,9.23 L19,11.29 Z',
    slash: 'M9,9 L27,27',
  };

  function buildIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ytev-icon');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = [
      [ICON.horn, 'ytev-shape'],
      [ICON.wave1, 'ytev-shape ytev-wave ytev-wave-1'],
      [ICON.wave2, 'ytev-shape ytev-wave ytev-wave-2'],
      [ICON.slash, 'ytev-slash-cut'],
      [ICON.slash, 'ytev-slash'],
    ];
    for (const [d, cls] of shapes) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  const num = (v) => parseFloat(v) || 0;

  // Доля ширины плеера под шкалу: у Shorts своя настройка, потому что
  // плеер там узкий (значение по умолчанию — на случай старой записи)
  const activeScale = () =>
    isShorts()
      ? num(SETTINGS.shortsScale) || 50
      : num(SETTINGS.sliderScale) || 20;

  const outerWidth = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none') return 0;
    return el.getBoundingClientRect().width + num(s.marginLeft) + num(s.marginRight);
  };

  const innerWidth = (el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - num(s.paddingLeft) - num(s.paddingRight);
  };

  // «Пилюля» со штатными кнопками — элемент, рядом с которым мы вставлены
  // и в котором живёт (скрытая) штатная кнопка звука
  function findPill() {
    const controls = ui.box.parentElement;
    if (!controls) return null;
    let el =
      (ui.hiddenPill && ui.hiddenPill.isConnected ? ui.hiddenPill : null) ||
      controls.querySelector('.ytp-volume-area, .ytp-mute-button');
    if (!el || ui.box.contains(el)) return null;
    while (el && el.parentElement !== controls) el = el.parentElement;
    return el && el !== ui.box ? el : null;
  }

  // Штатная кнопка звука скрыта через CSS; если кроме неё в «пилюле» не
  // осталось видимых кнопок — прячем пилюлю целиком, иначе висел бы
  // пустой кружок фона. В режиме отката пилюля возвращается.
  function markDonorPill(controls) {
    ui.hiddenPill = null;
    const mute = controls.querySelector('.ytp-mute-button');
    if (!mute || ui.box.contains(mute)) return;
    let pill = mute.parentElement;
    while (pill && pill.parentElement !== controls) pill = pill.parentElement;
    if (!pill || pill === ui.box) return;
    const hasOther = [...pill.querySelectorAll('button, [role="button"]')]
      .some((b) => b !== mute && b.offsetWidth > 0);
    if (!hasOther) {
      ui.hiddenPill = pill;
      pill.style.display = 'none';
    }
  }

  // Нормальный режим: наш блок виден и «в ответе» за громкость
  // (класс ytev-active включает CSS-скрытие штатных элементов),
  // опустевшая пилюля спрятана
  function enterNormal(player) {
    player.classList.add('ytev-active');
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = 'none';
    }
    ui.box.style.display = '';
  }

  // Откат (узкий плеер): наш блок спрятан, снятие класса возвращает
  // штатные кнопку и ползунок
  function enterFallback(player) {
    ui.box.style.display = 'none';
    if (ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    player.classList.remove('ytev-active');
  }

  const isTransparentBg = (bg) =>
    !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(bg);

  // Элементы, которые реально рисуют фон «плашки»: у обёрток (например,
  // .ytp-time-display) фон часто прозрачный, а видимая плашка — на
  // вложенном элементе; бывает и наоборот — полупрозрачный фон висит на
  // высокой обёртке. Поэтому собираем ВСЕ элементы с непрозрачным фоном
  // правдоподобной высоты, а образцом берём самый низкий: настоящая
  // плашка — самый компактный фоновый элемент строки.
  function collectSurfaces(root, out) {
    if (!root || !root.isConnected) return;
    const queue = [root];
    while (queue.length) {
      const el = queue.shift();
      if (el === ui.box || ui.box.contains(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none') continue;
      if (!isTransparentBg(s.backgroundColor)) {
        const h = el.getBoundingClientRect().height;
        // мелочь (переключатели, бейджи) и растянутые панели отсеиваем
        if (h >= 24 && h <= 80) out.push({ el, style: s, h });
      }
      for (const c of el.children) queue.push(c);
    }
  }

  // Свою рамку рисуем сами, копируя оформление с реально видимой плашки
  // той же строки (время, правые кнопки, пилюля-донор): ширина штатной
  // «пилюли» управляется скриптами YouTube под её собственное содержимое,
  // поэтому вставлять ползунок внутрь неё нельзя — он вылезает за фон.
  // Копирование с живого элемента даёт точное совпадение размеров и
  // оформления в любой версии интерфейса и теме; в старом интерфейсе
  // фоновых плашек нет — блок остаётся прозрачным.
  function syncFrameStyle() {
    const player = getPlayer();
    // В Shorts копировать не с чего (плашек в плеере нет), поэтому рамку
    // задаём сами — тёмная «пилюля» в стиле кнопок YouTube, размеры от
    // ширины плеера, чтобы вписываться в любой размер окна
    if (ui.overlay) {
      const w = player ? player.clientWidth : 0;
      if (!w) return;
      const h = Math.max(30, Math.min(46, Math.round(w * 0.1)));
      const pad = Math.max(6, Math.round(h * 0.23));
      if (!shortsGap) shortsGap = Math.max(8, Math.round(h * 0.32));
      if (!shortsInset) shortsInset = Math.max(3, Math.round(h * 0.09));
      const st = ui.box.style;
      ui.box.classList.add('ytev-framed');
      st.background = 'rgba(0, 0, 0, .6)';
      st.borderRadius = h / 2 + 'px';
      st.height = h + 'px';
      st.margin = '0'; // положение задаёт слой (positionOverlay)
      st.setProperty('--ytev-pad', pad + 'px');
      st.setProperty('--ytev-hl-inset', shortsInset + 'px');
      st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(h / 2 - shortsInset)) + 'px');
      st.backdropFilter = '';
      return;
    }
    const surfaces = [];
    collectSurfaces(player && player.querySelector('.ytp-time-display'), surfaces);
    collectSurfaces(player && player.querySelector('.ytp-right-controls'), surfaces);
    collectSurfaces(findPill(), surfaces);
    let surface = null;
    for (const sf of surfaces) {
      if (!surface || sf.h < surface.h) surface = sf;
    }
    if (resizeObserver && surface && surface.el !== observedPill) {
      resizeObserver.observe(surface.el); // плашка меняет высоту в big-mode
      observedPill = surface.el;
    }
    const st = ui.box.style;
    ui.box.classList.toggle('ytev-framed', !!surface);
    if (!surface) {
      st.background = '';
      st.borderRadius = '';
      st.height = '';
      st.backdropFilter = '';
      st.removeProperty('--ytev-pad');
      st.removeProperty('--ytev-hl-inset');
      st.removeProperty('--ytev-hl-radius');
      return;
    }
    const s = surface.style;
    const h = Math.round(surface.h);
    if (!edgeGap) edgeGap = Math.max(6, Math.round(h * 0.2));
    st.margin = '0 ' + edgeGap + 'px';
    st.background = s.backgroundColor;
    st.borderRadius = s.borderRadius;
    st.height = h + 'px';
    // единый отступ со всех сторон: сверху/снизу его задаёт центровка
    // содержимого (кнопка ужата до «высота минус два отступа»), слева и
    // справа — боковые поля рамки той же величины
    const pad = Math.max(6, Math.round(h * 0.23));
    st.setProperty('--ytev-pad', pad + 'px');
    // зазор подсветки: одна пиксельная величина со всех четырёх сторон,
    // скругление слоя уменьшено на неё же — контуры концентричны
    if (!hlInset) hlInset = Math.max(3, Math.round(h * 0.09));
    const radius = parseFloat(s.borderRadius) || h / 2;
    st.setProperty('--ytev-hl-inset', hlInset + 'px');
    st.setProperty('--ytev-hl-radius', Math.max(4, Math.round(radius - hlInset)) + 'px');
    st.backdropFilter = s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : '';
  }

  // Свободное место под ползунок: идём от нашего блока вверх до строки
  // управления (через любое число обёрток — в новом интерфейсе YouTube
  // кнопки вложены в «пилюли») и на каждом уровне вычитаем соседей вместе
  // с отступами, а у промежуточных обёрток — их собственные поля и рамки.
  function freeSpace(row) {
    let free = innerWidth(row);
    if (free <= 0) return 0; // панель скрыта — измерить нечего

    for (let node = ui.box; node && node !== row; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) return 0; // блок оторван от DOM
      for (const sib of parent.children) {
        if (sib !== node) free -= outerWidth(sib);
      }
      if (parent !== row) {
        const s = getComputedStyle(parent);
        free -=
          num(s.paddingLeft) + num(s.paddingRight) +
          num(s.marginLeft) + num(s.marginRight) +
          num(s.borderLeftWidth) + num(s.borderRightWidth);
      }
    }
    // собственные отступы блока и место под подпись с процентами
    free -= outerWidth(ui.box) - ui.slider.getBoundingClientRect().width;
    return free - SAFETY_GAP;
  }

  // Длина ползунка = настраиваемая доля ширины плеера, ограниченная
  // свободным местом; по краям рамки — постоянный зазор edgeGap. Если
  // места мало, сначала убираем подпись с процентами, а если и это не
  // помогло — прячем ползунок и возвращаем штатный (мини-плеер, узкое
  // окно).
  function layout() {
    if (!ui) return;
    // идёт анимация сворачивания — замеры бессмысленны, вернёмся тиком позже
    if (ui.box.classList.contains('ytev-animating')) return;
    const player = getPlayer();
    if (!player) return;

    // Shorts: блок лежит в своём слое, соседей нет — длина считается от
    // ширины плеера по отдельной настройке и ограничена ею же
    if (ui.overlay) {
      const wasFolded = ui.box.classList.contains('ytev-collapsed');
      ui.box.classList.remove('ytev-collapsed');
      enterNormal(player);
      ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
      // кнопка у правого края — раскрываемся влево
      ui.box.classList.toggle('ytev-mirrored', !!shortsAnchor && shortsAnchor.fx > 0.5);
      syncFrameStyle();
      const pw = player.clientWidth;
      if (!pw) return;
      ui.slider.style.width = MIN_SLIDER + 'px';
      const extra = ui.box.getBoundingClientRect().width - MIN_SLIDER;
      const room = pw - 2 * shortsGap - extra;
      const width = Math.max(MIN_SLIDER, Math.min(pw * (activeScale() / 100), room));
      ui.slider.style.width = Math.round(width) + 'px';
      ui.trackW = ui.slider.getBoundingClientRect().width;
      ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
      updateUI();
      if (wasFolded) updateCollapsed(false);
      positionOverlay();
      return;
    }

    // строка управления — ближайший предок, в котором есть и правые кнопки
    const rightControls = player.querySelector('.ytp-right-controls');
    let row = ui.box.parentElement;
    while (row && row !== player && !(rightControls && row.contains(rightControls))) {
      row = row.parentElement;
    }
    if (!row) return;

    // меряем в развёрнутом видимом состоянии и без штатного ползунка,
    // иначе решение зависело бы от предыдущего и режим отката «залипал» бы
    const wasCollapsed = ui.box.classList.contains('ytev-collapsed');
    ui.box.classList.remove('ytev-collapsed');
    enterNormal(player);
    ui.label.style.display = SETTINGS.showPercent ? '' : 'none';
    syncFrameStyle(); // поля рамки влияют на замер — обновляем до него
    if (innerWidth(row) <= 0) {
      if (wasCollapsed) updateCollapsed(false);
      return;
    }

    // Меряем, сжав ползунок до минимума: соседи (название главы) тоже
    // умеют сжиматься, и замер при текущей длине зависел бы от неё самой —
    // размер бы «дрожал» между двумя значениями. От минимума результат
    // один и тот же независимо от предыдущего состояния.
    ui.slider.style.width = MIN_SLIDER + 'px';

    let free = freeSpace(row);
    if (free < MIN_SLIDER && SETTINGS.showPercent) {
      ui.label.style.display = 'none';
      free = freeSpace(row);
    }

    // длина — настраиваемая доля ширины плеера, ограниченная свободным местом
    const desired = player.clientWidth * (activeScale() / 100);
    ui.slider.style.width =
      Math.round(Math.max(MIN_SLIDER, Math.min(desired, free))) + 'px';

    checkRowOverlap();
    if (!ui) return; // пересобрались в другом месте — раскладку доделает новый цикл

    // размеры дорожки и бегунка для расчёта заливки (см. paint)
    ui.trackW = ui.slider.getBoundingClientRect().width;
    ui.thumbPx = num(getComputedStyle(ui.box).getPropertyValue('--ytev-thumb'));
    updateUI();

    // подстраховка на случай неточного замера: если flex всё-таки сжал
    // ползунок до бесполезной длины — отдаём место штатному
    if (ui.slider.getBoundingClientRect().width < MIN_SLIDER - 1) {
      enterFallback(player);
    } else if (wasCollapsed) {
      updateCollapsed(false); // вернуть свёрнутое состояние без анимации
    }
  }

  // Автосворачивание: класс ytev-collapsed ставится, когда включена
  // настройка и на блоке нет ни курсора, ни фокуса. Переходы включаются
  // только на время переключения, чтобы не мешать замерам layout().
  let collapseTimer = 0;
  let animTimer = 0;
  function updateCollapsed(animate = true) {
    if (!ui) return;
    // разворот держит только клавиатурный фокус (:focus-visible) — обычный
    // клик по кнопке оставляет фокус внутри блока и не должен мешать
    // сворачиванию
    let keyboardFocus = false;
    try {
      keyboardFocus = !!ui.box.querySelector(':focus-visible');
    } catch {}
    const want = !!SETTINGS.autoCollapse && !ui.hover && !keyboardFocus;
    if (want === ui.box.classList.contains('ytev-collapsed')) return;
    if (!animate) {
      ui.box.classList.toggle('ytev-collapsed', want);
      return;
    }
    ui.box.classList.add('ytev-animating');
    ui.box.classList.toggle('ytev-collapsed', want);
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      if (ui) ui.box.classList.remove('ytev-animating');
      scheduleLayout();
    }, 350);
  }

  function bindVideo() {
    const video = getVideo();
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('volumechange', updateUI);
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
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;

  function observePlayer() {
    const player = getPlayer();
    if (!resizeObserver || !player || player === observedPlayer) return;
    if (observedPlayer) resizeObserver.unobserve(observedPlayer);
    resizeObserver.observe(player);
    observedPlayer = player;
  }

  // Следим за всеми контейнерами от ползунка до плеера: если рамка (или
  // любая обёртка) изменит размер, длина пересчитается сразу, а не по
  // секундному таймеру
  function observeChain() {
    if (!resizeObserver || !ui) return;
    const player = getPlayer();
    for (let el = ui.box.parentElement; el && el !== player; el = el.parentElement) {
      resizeObserver.observe(el); // повторный observe того же узла — no-op
    }
  }

  // Куда встраивать блок. На обычной странице — в строку управления
  // плеера. В Shorts своей строки управления нет (у плеера минимальная
  // обвязка, которая ещё и меняется от версии к версии), поэтому кладём
  // блок в собственный слой поверх плеера, слева сверху — там свободно.
  function findMount() {
    const player = getPlayer();
    if (!player) return null;
    // Сначала штатная строка управления — она есть и в Shorts (кнопки
    // паузы и звука рядом с полосой перемотки). Так блок встаёт ровно
    // туда, где было штатное управление, и живёт по правилам YouTube,
    // включая автоскрытие панели. Исключение — если в Shorts полоса
    // перемотки размещена поверх строки: тогда наша шкала легла бы на
    // неё внахлёст, и мы уходим в накладной слой (см. checkRowOverlap).
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

  /* ------------------------------------------------------------------ *
   * Скрытие штатной громкости в Shorts
   *
   * На обычной странице хватает класса ytev-active на плеере: штатные
   * кнопка и ползунок лежат внутри него. В Shorts же управление звуком
   * рисует обвязка ленты — она вне элемента плеера, и селектор до неё
   * не доставал, из-за чего рядом с нашей шкалой оставалась вторая,
   * штатная. Имён у этих элементов в новом интерфейсе несколько, поэтому
   * ищем по признаку «volume/mute» в классе или id, ограничиваясь
   * небольшими элементами (кнопка, а не контейнер всей панели).
   * ------------------------------------------------------------------ */

  const hiddenNative = new Set();
  const VOLUME_HINT = /(^|[^a-z])(volume|mute)/i;
  // место штатной кнопки звука в долях размера плеера — на него встаёт
  // наш блок, поэтому доли, а не пиксели: переживает смену размеров
  let shortsAnchor = null;

  const isButtonLike = (el, r) =>
    el.tagName === 'BUTTON' ||
    el.getAttribute('role') === 'button' ||
    Math.abs(r.width - r.height) < 12;

  const shortsScope = () =>
    document.querySelector('ytd-reel-video-renderer[is-active]') ||
    document.querySelector('#shorts-container') ||
    document.querySelector('ytd-shorts');

  function hideNativeVolume() {
    const scope = shortsScope();
    if (!scope) return;
    const player = getPlayer();
    const pr = player ? player.getBoundingClientRect() : null;
    const candidates = [
      ...scope.querySelectorAll(
        '.ytp-mute-button, .ytp-volume-panel, .ytp-volume-area,' +
          '[class*="volume" i], [class*="mute" i], [id*="volume" i], [id*="mute" i]'
      ),
    ].filter((el) => {
      if (hiddenNative.has(el)) return false;
      if (el.closest('.ytev-box, .ytev-overlay')) return false; // наше собственное
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!VOLUME_HINT.test(cls) && !VOLUME_HINT.test(el.id || '')) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false; // уже не видно
      return r.width <= 160 && r.height <= 160; // это кнопка, а не контейнер
    });

    // Якорь выбираем ДО того, как что-то скроем: контейнер громкости идёт
    // в списке раньше кнопки внутри него, и, скрыв его первым, мы бы
    // измеряли кнопку с нулевыми размерами и потеряли место
    if (!shortsAnchor && pr && pr.width && pr.height) {
      const button = candidates.find((el) => isButtonLike(el, el.getBoundingClientRect()));
      if (button) {
        const r = button.getBoundingClientRect();
        shortsAnchor = {
          fx: (r.left + r.width / 2 - pr.left) / pr.width,
          fy: (r.top + r.height / 2 - pr.top) / pr.height,
        };
      }
    }

    for (const el of candidates) {
      el.dataset.ytevHidden = '1';
      el.style.display = 'none';
      hiddenNative.add(el);
    }
  }

  function restoreNativeVolume() {
    for (const el of hiddenNative) {
      if (el.isConnected && el.dataset.ytevHidden) {
        el.style.display = '';
        delete el.dataset.ytevHidden;
      }
    }
    hiddenNative.clear();
    shortsAnchor = null;
  }

  // Ставим блок ровно на место штатной кнопки звука: совмещаем центр
  // нашей кнопки с запомненным центром штатной, а шкала разворачивается
  // вправо — как выезжает штатная. Если запомнить не удалось, кладём в
  // угол плеера с обычным отступом.
  function positionOverlay() {
    if (!ui || !ui.overlay) return;
    const player = getPlayer();
    const host = ui.box.parentElement;
    if (!player || !host) return;
    const pr = player.getBoundingClientRect();
    if (!pr.width) return;
    if (!shortsAnchor) {
      host.style.left = shortsGap + 'px';
      host.style.top = shortsGap + 'px';
      return;
    }
    const cur = {
      left: parseFloat(host.style.left) || 0,
      top: parseFloat(host.style.top) || 0,
    };
    const btn = ui.muteBtn.getBoundingClientRect();
    const wantX = pr.left + shortsAnchor.fx * pr.width;
    let wantY = pr.top + shortsAnchor.fy * pr.height;
    // если штатная кнопка сидит в панели управления, встаём НАД панелью:
    // иначе развёрнутая шкала накрыла бы полосу перемотки
    const bar = player.querySelector('.ytp-chrome-bottom');
    const barRect = bar && bar.getBoundingClientRect();
    if (barRect && barRect.height && wantY > barRect.top - 1) {
      const box = ui.box.getBoundingClientRect();
      wantY = barRect.top - shortsGap - box.height / 2;
    }
    host.style.left = Math.round(cur.left + wantX - (btn.left + btn.width / 2)) + 'px';
    host.style.top = Math.round(cur.top + wantY - (btn.top + btn.height / 2)) + 'px';

    // не даём блоку вылезти за пределы плеера
    const box = ui.box.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (box.right > pr.right - shortsGap) dx = pr.right - shortsGap - box.right;
    if (box.left + dx < pr.left + shortsGap) dx = pr.left + shortsGap - box.left;
    if (box.bottom > pr.bottom - shortsGap) dy = pr.bottom - shortsGap - box.bottom;
    if (box.top + dy < pr.top + shortsGap) dy = pr.top + shortsGap - box.top;
    if (dx || dy) {
      host.style.left = Math.round((parseFloat(host.style.left) || 0) + dx) + 'px';
      host.style.top = Math.round((parseFloat(host.style.top) || 0) + dy) + 'px';
    }
  }

  // Полный демонтаж: штатная громкость возвращается на место
  function teardownUI() {
    restoreNativeVolume();
    for (const el of document.querySelectorAll('.ytev-active')) {
      el.classList.remove('ytev-active');
    }
    if (ui && ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    for (const box of document.querySelectorAll('.ytev-box')) box.remove();
    for (const host of document.querySelectorAll('.ytev-overlay')) host.remove();
    ui = null;
    boundVideo = null;
  }

  function ensureUI() {
    // режим «штатная шкала»: свой блок не строим, но кривая продолжает
    // работать — её применяет перехватчик громкости
    if (SETTINGS.useNativeSlider) {
      if (ui) teardownUI();
      return;
    }
    const mount = findMount();
    if (!mount) return;
    const controls = mount.host;
    observePlayer();
    // в Shorts штатная громкость может лежать и вне плеера (обвязка
    // ленты) — правила для плеера туда не достают, прячем отдельно
    if (isShorts()) {
      hideNativeVolume();
      watchPointer(getPlayer()); // автоскрытие вместе с уходом указателя
    } else if (hiddenNative.size) {
      restoreNativeVolume();
    }
    if (ui && controls.contains(ui.box)) {
      if (ui.hiddenPill && !ui.hiddenPill.isConnected) markDonorPill(controls);
      bindVideo();
      layout();
      return;
    }

    // Сейчас будет собран новый блок, поэтому убираем ВСЕ прежние —
    // включая текущий. Раньше текущий пропускался, и при смене точки
    // монтирования (накладной слой → строка управления, пересоздание
    // плеера) на странице оставались два блока внахлёст.
    for (const stale of document.querySelectorAll('.ytev-box')) {
      const orphanMute = stale.querySelector('.ytp-mute-button');
      if (orphanMute) stale.before(orphanMute); // живую штатную кнопку возвращаем
      stale.remove();
    }
    ui = null;
    // опустевшие слои тоже убираем, кроме того, куда сейчас встаём
    for (const host of document.querySelectorAll('.ytev-overlay')) {
      if (host !== controls && !host.querySelector('.ytev-box')) host.remove();
    }

    const box = document.createElement('div');
    box.className = 'ytev-box';

    // Своя кнопка звука: значок предсказуемо центрирован при любом размере
    const muteBtn = document.createElement('button');
    muteBtn.className = 'ytev-mute';
    muteBtn.type = 'button';
    muteBtn.appendChild(buildIcon());
    muteBtn.addEventListener('click', () => {
      const player = getPlayer();
      const video = getVideo();
      if (!video) return;
      if (video.muted || video.volume === 0) {
        if (player && typeof player.unMute === 'function') player.unMute();
        video.muted = false;
      } else {
        if (player && typeof player.mute === 'function') player.mute();
        else video.muted = true;
      }
    });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.1';
    slider.className = 'ytev-slider';

    const label = document.createElement('span');
    label.className = 'ytev-label';

    box.append(muteBtn, slider, label);

    if (mount.overlay) {
      controls.appendChild(box); // свой слой поверх плеера Shorts
    } else {
      // встаём после «пилюли» с кнопками, а не внутрь неё: YouTube управляет
      // её шириной из скриптов под собственное содержимое, и вставленный
      // внутрь ползунок вылезал за фон. Рамку блок рисует сам (syncFrameStyle)
      let anchor = controls.querySelector('.ytp-volume-area, .ytp-mute-button');
      while (anchor && anchor.parentElement !== controls) anchor = anchor.parentElement;
      if (anchor) anchor.after(box);
      else controls.appendChild(box);
    }

    slider.addEventListener('input', applySliderValue);
    // стрелки должны двигать ползунок (шаг 0.1%), а не перематывать видео
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    // автосворачивание: следим за курсором и фокусом на блоке
    box.addEventListener('mouseenter', () => {
      if (!ui) return;
      ui.hover = true;
      clearTimeout(collapseTimer);
      updateCollapsed();
    });
    box.addEventListener('mouseleave', () => {
      if (!ui) return;
      ui.hover = false;
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(updateCollapsed, 500);
    });
    box.addEventListener('focusin', () => updateCollapsed());
    box.addEventListener('focusout', () => setTimeout(updateCollapsed, 0));
    // колесо мыши над ползунком: ±1%, с Shift ±0.1%
    box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 0.1 : 1;
        const cur = Number(slider.value);
        slider.value = Math.min(100, Math.max(0, cur + (e.deltaY < 0 ? step : -step)));
        applySliderValue();
      },
      { passive: false }
    );

    ui = { box, slider, label, muteBtn, hover: false, overlay: mount.overlay };
    markDonorPill(controls);
    observeChain();
    bindVideo();
    updateUI();
    layout();
    updateCollapsed(false);
  }

  // Во время регулировки громкость пишется ТОЛЬКО напрямую в
  // video.volume — одно точное значение на событие. Вызов
  // player.setVolume на каждом событии давал по две быстрые записи
  // чуть разных значений (округлённое YouTube + наше точное) — слышимый
  // треск; а дробное число в setVolume YouTube мог переокруглять сам и
  // потрескивать даже без движения ползунка. Сохранение громкости в
  // настройках YouTube делаем отложенно, один раз после конца движения
  // и только целым числом.
  let persistTimer = 0;
  function applySliderValue() {
    const video = getVideo();
    const player = getPlayer();
    if (!video || !ui) return;
    const pct = Math.min(100, Math.max(0, Number(ui.slider.value)));
    if (video.muted && pct > 0) {
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    video.volume = pct / 100;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const p = getPlayer();
      const v = getVideo();
      if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(pct));
      if (v) v.volume = pct / 100; // вернуть точное значение после округления
    }, 250);
  }

  // YouTube — SPA: плеер может появляться/пересоздаваться при навигации.
  // Заодно раз в секунду переспрашиваем настройки у bridge — доставка
  // становится самовосстанавливающейся, даже если разовое сообщение
  // потерялось (bridge отвечает текущим содержимым chrome.storage)
  setInterval(() => {
    ensureUI();
    window.postMessage({ type: 'YTEV_GET_SETTINGS' }, '*');
  }, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(ensureUI, 0));
  document.addEventListener('DOMContentLoaded', ensureUI);
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 0));
  window.addEventListener('resize', layout);
})();
