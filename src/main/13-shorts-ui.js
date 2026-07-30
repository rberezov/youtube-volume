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

  // Узел → его прежний inline-display. Именно Map, а не Set: элемент мог
  // иметь собственный inline-стиль, и возврат пустой строкой его терял.
  const hiddenNative = new Map();
  // в новом интерфейсе классы в camelCase (ytdVolumeControlsHost), поэтому
  // без требования не-буквы перед словом — иначе такие имена не находились
  const VOLUME_HINT = /volume|mute/i;
  // место штатной кнопки звука в долях размера плеера — на него встаёт
  // наш блок, поэтому доли, а не пиксели: переживает смену размеров
  let shortsAnchor = null;

  const isButtonLike = (el, r) =>
    el.tagName === 'BUTTON' ||
    el.getAttribute('role') === 'button' ||
    Math.abs(r.width - r.height) < 12;

  // Активная лента. Самый надёжный признак — та, внутри которой лежит
  // текущий плеер: он в Shorts один. Атрибут is-active в новом интерфейсе
  // может отсутствовать даже у видимой ленты, поэтому он идёт после, а не
  // первым — иначе выбор мог достаться соседней ленте из буфера.
  function activeReel() {
    const player = getPlayer();
    if (player && typeof player.closest === 'function') {
      const owner = player.closest('ytd-reel-video-renderer');
      if (owner) return owner;
    }
    return (
      document.querySelector('ytd-reel-video-renderer[is-active]') ||
      document.querySelector(
        '#reel-overlay-container ytd-reel-video-renderer'
      ) ||
      document.querySelector('ytd-reel-video-renderer')
    );
  }

  /**
   * Собрана ли строка управления Shorts целиком.
   *
   * Полевой замер двух переходов подряд: новая лента видна на 0мс, строка
   * появляется на 164мс и 172мс — и появляется сразу вся, вместе с
   * volume-controls. Состояния «строка уже собрана, а блока громкости ещё
   * нет» не было ни разу. Значит собранная строка без громкости — это
   * достоверный признак «штатной громкости здесь не будет», и накладной слой
   * можно строить по факту, а не по истечении окна ожидания.
   *
   * Проверяем структуру, а не внутренние поля Polymer: didCallReady и
   * isAttached недокументированы, и требовать их — значит выключить блок в
   * Shorts целиком при первом же переименовании. Если они есть и явно
   * говорят «ещё не готов» — верим им; если их нет, полагаемся на структуру.
   */
  // Пользуется ли эта сборка YouTube строкой ytd-shorts-player-controls
  // вообще. Отличает «строка ещё не приехала» от «строки здесь не бывает»:
  // при переходе соседние ленты в буфере свои строки уже имеют, а на сборке
  // без этого компонента его нет во всём документе — и ждать нечего.
  function shortsControlsExpected() {
    return !!document.querySelector('ytd-shorts-player-controls');
  }

  function shortsControlsReady() {
    const scope = shortsScope();
    const controls = scope && scope.querySelector('ytd-shorts-player-controls');
    if (!controls || !controls.isConnected) return false;
    if (!controls.querySelector('#left-controls > yt-button-shape')) return false;
    if (!controls.querySelector('#right-controls > #menu-button')) return false;
    // polymerController и его поля принадлежат странице: чтение может
    // бросить. Исключение отсюда сломало бы ensureUI(), то есть сборку
    // интерфейса целиком, поэтому непрочитанное считаем «подтверждения нет».
    try {
      const controller = controls.polymerController;
      if (controller && (controller.didCallReady === false || controller.isAttached === false)) {
        return false;
      }
    } catch {}
    return true;
  }

  const shortsScope = () =>
    activeReel() ||
    document.querySelector('#shorts-container') ||
    document.querySelector('ytd-shorts');

  // Оформление снимаем со штатного блока громкости Shorts до того, как
  // его скроем: фон там рисует вложенный «скрим», поэтому ищем первый
  // элемент с непрозрачным фоном
  let shortsFrame = null;
  // Донор оформления, когда сам блок громкости ещё не разложен: соседняя
  // кнопка той же строки. Размер и фон у них общие — ради них оформление и
  // снимается.
  function shortsFrameDonor(el) {
    const row = el.parentElement;
    if (!row) return null;
    for (const sibling of row.children) {
      if (sibling === el || sibling.contains(el)) continue;
      if (sibling.getBoundingClientRect().height) return sibling;
    }
    return null;
  }

  function captureShortsFrame(el) {
    if (shortsFrame || !el) return;
    // На первых кадрах ленты штатный блок громкости бывает ещё нулевой
    // высоты, а сразу после этого мы его прячем — и снять с него оформление
    // становится нельзя уже никогда: у скрытого узла высота нулевая всегда.
    // Раньше первый Shorts в сессии из-за этого выходил без рамки вовсе:
    // 36×36 без фона и скругления. Со следующей ленты всё вставало на место,
    // потому что там блок успевал разложиться до скрытия.
    const donor = el.getBoundingClientRect().height ? el : shortsFrameDonor(el);
    if (!donor) return;
    const rect = donor.getBoundingClientRect();
    if (!rect.height) return;
    let painted = null;
    for (const node of [donor, ...donor.querySelectorAll('*')]) {
      const s = getComputedStyle(node);
      if (s.display !== 'none' && !isTransparentBg(s.backgroundColor)) {
        painted = s;
        break;
      }
    }
    const height = Math.round(rect.height);
    const radius = painted ? painted.borderRadius : height / 2 + 'px';
    shortsFrame = {
      bg: painted ? painted.backgroundColor : 'rgba(0, 0, 0, .6)',
      // Скругление в процентах на развёрнутом блоке дало бы эллипс: он шире,
      // чем выше. Приводим к пикселям — на квадрате это тот же круг.
      radius: /%/.test(radius) ? height / 2 + 'px' : radius,
      height,
    };
  }

  // Штатный блок громкости Shorts — <volume-controls> в строке кнопок
  // ytd-shorts-player-controls; он лежит вне элемента плеера
  let shortsMountAnchor = null; // рядом с ним стоим; помним и после скрытия
  function shortsVolumeHost() {
    // Мы сами скрываем штатный блок, и по размерам его больше не найти —
    // поэтому держим ссылку. Без этого точка монтирования «терялась»
    // после первого же тика, и блок скакал между строкой и слоем.
    if (shortsMountAnchor && shortsMountAnchor.isConnected) return shortsMountAnchor;
    const reel = activeReel() || document;
    const el =
      reel.querySelector('volume-controls, .ytdVolumeControlsHost') ||
      reel.querySelector('ytd-shorts-player-controls [class*="volume" i]');
    // Годится сам факт существования узла, а не его размеры: после скрытия
    // расширением он 0×0 и visibility: hidden, но остаётся правильным якорем —
    // и ровно так же выглядит в первые мгновения после появления.
    return el && el.isConnected ? el : null;
  }

  function hideNativeVolume() {
    const scope = shortsScope();
    if (!scope) return;
    // Функция вызывается на каждом тике, а лента Shorts бесконечно
    // пересоздаёт свои узлы. Без чистки набор удерживал бы отсоединённые
    // поддеревья всех просмотренных роликов до самого выключения.
    for (const el of hiddenNative.keys()) {
      if (!el.isConnected) hiddenNative.delete(el);
    }
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
      // Узел, на место которого мы встаём, прячем всегда — даже если он уже
      // нулевого размера. Нулевой, но видимый элемент остаётся элементом
      // flex-строки и получает промежуток с обеих сторон: между кнопкой
      // воспроизведения и нашим блоком выходило 16px вместо восьми.
      if (el === shortsMountAnchor) return true;
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
      hiddenNative.set(el, el.style.display);
      el.dataset.ytevHidden = '1';
      el.style.display = 'none';
    }
  }

  function restoreNativeVolume() {
    for (const [el, display] of hiddenNative) {
      if (el.isConnected && el.dataset.ytevHidden) {
        el.style.display = display || '';
        delete el.dataset.ytevHidden;
      }
    }
    hiddenNative.clear();
    shortsAnchor = null;
    shortsMountAnchor = null;
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
  // Слежение за курсором висит на строке управления плеера, а она переживает
  // наш блок: снимаем при любой его замене, не только при полном демонтаже.
  function detachHoverScope() {
    if (!ui || !ui.hoverScope) return;
    ui.hoverScope.removeEventListener('mouseleave', ui.onScopeLeave);
  }

  function teardownUI() {
    setEarlyNativeHidden(false, true);
    stopObservingUI();
    restoreNativeVolume();
    for (const el of document.querySelectorAll('.ytev-active')) {
      el.classList.remove('ytev-active');
    }
    if (ui && ui.hiddenPill && ui.hiddenPill.isConnected) {
      ui.hiddenPill.style.display = '';
    }
    detachHoverScope();
    for (const box of document.querySelectorAll('.ytev-box')) box.remove();
    for (const host of document.querySelectorAll('.ytev-overlay')) host.remove();
    ui = null;
  }

  function ensureUI() {
    // Не рисуем значок из временного autoplay-состояния YouTube. Обычно
    // bridge отвечает ещё до появления плеера; синхронный кэш выше при
    // повторных открытиях позволяет применить mute ещё раньше.
    if (!volumeStateLoaded) return;
    // режим «штатная шкала»: свой блок не строим, но кривая продолжает
    // работать — её применяет перехватчик громкости
    if (SETTINGS.useNativeSlider) {
      setEarlyNativeHidden(false, true);
      if (ui) teardownUI();
      bindVideo();
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
    detachHoverScope();
    ui = null;
    // опустевшие слои тоже убираем, кроме того, куда сейчас встаём
    for (const host of document.querySelectorAll('.ytev-overlay')) {
      if (host !== controls && !host.querySelector('.ytev-box')) host.remove();
    }

    const box = document.createElement('div');
    box.className = 'ytev-box ytev-initializing';

    // Своя кнопка звука: значок предсказуемо центрирован при любом размере
    const muteBtn = document.createElement('button');
    muteBtn.className = 'ytev-mute';
    muteBtn.type = 'button';
    muteBtn.setAttribute('aria-keyshortcuts', 'm');
    muteBtn.appendChild(buildIcon());
    muteBtn.addEventListener('click', () => toggleMute());

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.1';
    slider.className = 'ytev-slider';
    slider.setAttribute('aria-label', STRINGS.playerSliderLabel);

    const label = document.createElement('span');
    label.className = 'ytev-label';
    // Проценты открываются той же шторкой, что и шкала, только чуть позже:
    // сама подпись размера не меняет, её обрезает обёртка.
    const labelSlot = document.createElement('div');
    labelSlot.className = 'ytev-slot ytev-label-slot';
    labelSlot.appendChild(label);

    // Шкала живёт в обрезающей обёртке, а не сворачивается сама. Раньше
    // анимировалась ширина самого <input>: он появлялся целиком, но сжатым,
    // и на глазах растягивался — бегунок ползёт, заливка тянется. У штатной
    // шкалы YouTube ширина постоянна, а выезжает она из-под кнопки. Так же
    // и здесь: ширину меняет обёртка с overflow: hidden, а <input> внутри
    // всё время своего размера, поэтому шкала открывается постепенно.
    const slot = document.createElement('div');
    slot.className = 'ytev-slot';
    slot.appendChild(slider);

    box.append(muteBtn, slot, labelSlot);

    if (mount.before && mount.before.isConnected) {
      mount.before.after(box); // ровно на место штатного блока громкости
    } else if (mount.overlay) {
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

    // стрелки должны двигать ползунок (шаг 0.1%), а не перематывать видео
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    // Автосворачивание: следим за курсором в области наведения и за фокусом
    // на блоке. Область — строка управления плеера, а в Shorts сам блок
    // (см. hoverScope ниже). Слушатели снимает teardownUI: строка живёт
    // дольше нашего блока, и оставленные на ней обработчики копились бы.
    // Раскрывать начинаем только с самой кнопки — то есть со свёрнутого
    // круга: наведение на соседнюю кнопку строки не должно выдвигать
    // громкость, у штатного регулятора она тоже открывается от себя.
    // А закрываем по уходу из всей строки: доведя мышь до шкалы, её обычно
    // сразу тянут вбок, и схлопывание на полпути только мешает.
    const hoverScope = mount.overlay || mount.before ? box : controls;
    const onScopeEnter = () => {
      if (!ui) return;
      ui.hover = true;
      clearTimeout(collapseTimer);
      updateCollapsed();
    };
    const onScopeLeave = () => {
      if (!ui) return;
      ui.hover = false;
      // По умолчанию сразу: штатная шкала YouTube тоже начинает уезжать в
      // тот же момент, когда указатель ушёл. Но с длинной шкалой мелкое
      // движение мышью легко выводит курсор за рамку, и тогда удобнее
      // прежнее поведение — полсекунды на возврат, за которые разворот
      // успевает дойти до конца. Это и включает настройка.
      clearTimeout(collapseTimer);
      if (SETTINGS.collapseDelay) {
        collapseTimer = setTimeout(updateCollapsed, COLLAPSE_DELAY_MS);
      } else {
        updateCollapsed();
      }
    };
    // Вход считаем по блоку (в свёрнутом виде это и есть кружок кнопки),
    // выход — по всей области. В Shorts обе области совпадают.
    box.addEventListener('mouseenter', onScopeEnter);
    hoverScope.addEventListener('mouseleave', onScopeLeave);
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
        applySliderValue(slider);
      },
      { passive: false }
    );

    ui = {
      box, slider, slot, label, labelSlot, muteBtn,
      hover: false,
      overlay: mount.overlay,
      shortsRow: !!mount.before,
      // Область наведения. На обычной странице это вся строка управления
      // плеера (.ytp-left-controls): пока указатель в ней, шкала остаётся
      // раскрытой — как у штатного регулятора, который не схлопывается от
      // движения к соседней кнопке. В Shorts своей строки нет, там область
      // прежняя — сам блок.
      hoverScope,
      onScopeEnter,
      onScopeLeave,
    };
    markDonorPill(controls);
    observeChain();
    bindVideo();
    updateUI();
    layout();
    updateCollapsed(false);
    requestAnimationFrame(() => {
      if (box.isConnected) box.classList.remove('ytev-initializing');
    });
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
  function applySliderValue(slider = ui && ui.slider) {
    const video = getVideo();
    const player = getPlayer();
    if (!video || !slider) return;
    const pct = Math.min(100, Math.max(0, Number(slider.value)));
    if (pct > 0) rememberMuted(false, true);
    if (video.muted && pct > 0) {
      if (player && typeof player.unMute === 'function') player.unMute();
      video.muted = false;
    }
    if (pct === 0) rememberMuted(video.muted, true);
    rememberVolume(pct / 100, true);
    video.volume = pct / 100;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const p = getPlayer();
      const v = getVideo();
      if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(pct));
      if (v) v.volume = pct / 100; // вернуть точное значение после округления
    }, 250);
  }

  // Строка управления Shorts перехватывает bubbling/capture-события своих
  // дочерних контролов. Из-за этого нативный range визуально двигался, но
  // его собственный input-обработчик мог вообще не вызываться. Ловим input
  // раньше обвязки YouTube — на window в capture-фазе.
  //
  // Проверки обязательны в обе стороны. Раньше условием было «у элемента
  // есть класс ytev-slider», и любой скрипт страницы мог создать свой
  // <input class="ytev-slider">, послать ненастоящий input и крутить
  // громкость. Берём только настоящее событие и только со своего ползунка.
  // Регистрация стоит здесь, а не в начале функции: до объявления ui
  // обработчик обращался бы к переменной в TDZ.
  on(
    window,
    'input',
    (e) => {
      if (!e.isTrusted) return;
      if (SETTINGS.useNativeSlider && applyTrustedNativeVolume(e.target)) {
        return;
      }
      if (!ui || e.target !== ui.slider) return;
      applySliderValue(ui.slider);
    },
    true
  );

  applyTrustedPayload(initialPayload, true);

