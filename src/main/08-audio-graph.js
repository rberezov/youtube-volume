  /* ------------------------------------------------------------------ *
   * 1b. Регулировка через Web Audio — главное средство против треска
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

  const audio = {
    ctx: null,
    unavailable: false,
    nodes: new WeakMap(),
    // WeakMap удобен для поиска, но его нельзя обойти при dispose().
    // Отдельная Map содержит только ещё подключённые графы и очищается,
    // как только элемент уходит из документа или переводится на прямой путь.
    liveNodes: new Map(),
    failedElements: new WeakSet(),
  };
  const drmElements = new WeakSet();

  on(
    document,
    'encrypted',
    (e) => {
      if (e.target instanceof HTMLMediaElement) drmElements.add(e.target);
    },
    true
  );

  function audioGraph(el) {
    if (
      audio.unavailable ||
      !(el instanceof HTMLMediaElement) ||
      audio.failedElements.has(el)
    ) {
      return null;
    }
    const existing = audio.nodes.get(el);
    if (existing) return existing;
    if (drmElements.has(el) || el.mediaKeys) return null; // защищённый поток
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!audio.ctx) audio.ctx = new Ctx();
    } catch {
      audio.unavailable = true;
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
      gain.gain.value = outputGain(el, toReal(logicalOf(el)));
      src.connect(gain).connect(audio.ctx.destination);
      const node = {
        src,
        gain,
        target: gain.gain.value,
        onVolumeChange: null,
        stopWatch: null,
        released: false,
      };
      node.onVolumeChange = () => applyReal(el, toReal(logicalOf(el)));
      audio.nodes.set(el, node);
      audio.liveNodes.set(el, node);
      // уровень задаёт gain, сам элемент держим на максимуме
      nativeDesc.set.call(el, 1);
      el.addEventListener('volumechange', node.onVolumeChange);
      watchSilence(el, node);
      return node;
    } catch {
      audio.failedElements.add(el);
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
    let timer = 0;
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = 0;
      try {
        node.gain.disconnect(analyser);
      } catch {}
      if (node.stopWatch === stop) node.stopWatch = null;
    };
    node.stopWatch = stop;
    timer = setInterval(() => {
      if (!el.isConnected) {
        fallbackToDirect(el, node);
        return;
      }
      if (audio.failedElements.has(el) || ++ticks > 240) {
        stop(); // откат уже был или прошло 2 минуты
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
      if (silentFor >= 6000) {
        stop();
        fallbackToDirect(el, node);
      } else if (!silent && silentFor === 0 && lastTime > 3) {
        stop(); // звук идёт — сторож больше не нужен
      }
    }, 500);
  }

  function fallbackToDirect(el, node) {
    if (!node || node.released) return;
    node.released = true;
    audio.failedElements.add(el);
    audio.nodes.delete(el);
    audio.liveNodes.delete(el);
    if (node.stopWatch) node.stopWatch();
    if (node.onVolumeChange) {
      el.removeEventListener('volumechange', node.onVolumeChange);
      node.onVolumeChange = null;
    }
    try {
      node.gain.disconnect();
    } catch {}
    try {
      node.src.disconnect();
    } catch {}
    try {
      node.src.connect(audio.ctx.destination);
    } catch {}
    nativeDesc.set.call(el, Math.min(1, Math.max(0, node.target)));
  }

  // Основной путь установки фактической громкости
  function applyReal(el, real) {
    const node = audioGraph(el);
    if (node) {
      const target = outputGain(el, real);
      node.target = target;
      // 15мс — «мгновенно на слух», но без щелчка
      node.gain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.015);
      if (nativeDesc.get.call(el) !== 1) nativeDesc.set.call(el, 1);
      return;
    }
    setRealSmooth(el, Math.min(1, outputGain(el, real)));
  }

  // Контекст можно запустить только после жеста пользователя, поэтому
  // пробуем подключиться на любом взаимодействии и при старте
  // воспроизведения; до этого работает запасной путь
  let lastEngage = 0;
  function engageAudio() {
    if (audio.unavailable) return;
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
    on(document, type, engageAudio, true);
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

