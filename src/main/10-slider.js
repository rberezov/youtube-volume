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
    /* Раннее скрытие включается ещё на document_start. visibility оставляет
       геометрию штатного блока доступной для точного монтажа нашей шкалы. */
    .${EARLY_HIDE_CLASS} .ytp-volume-area,
    .${EARLY_HIDE_CLASS} .ytp-volume-panel,
    .${EARLY_HIDE_CLASS} .ytp-mute-button,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer volume-controls,
    .${EARLY_HIDE_CLASS} ytd-reel-video-renderer .ytdVolumeControlsHost,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls volume-controls,
    .${EARLY_HIDE_CLASS} ytd-shorts-player-controls .ytdVolumeControlsHost {
      visibility: hidden !important;
    }
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
      /* Под «100%» с запасом: при 2.5em текст был на 0.7px шире коробки и
         последний знак подрезался. */
      --ytev-pct: 2.7em;
      --ytev-gap: 0px;
      /* Ровно то, что YouTube ставит своим значкам (снято с живой строки
         Shorts): широкое мягкое размытие и слабая непрозрачность, поэтому
         смещение в один пиксель на глаз не читается. Своя прежняя тень с
         размытием 2px при 50% выглядела заметно направленной вниз. */
      --ytev-shadow: drop-shadow(0 1px 4px rgb(0 0 0 / 30%));
      display: flex;
      align-items: center;
      align-self: center;
      box-sizing: border-box;
      min-width: 0;
      /* Поля задаёт syncFrameStyle: они дополняют отступы соседей, а не
         прибавляются к ним. Постоянные 8px здесь давали двойной зазор. */
      margin: 0;
      position: relative;
      /* В актуальном интерфейсе Shorts вся строка кнопок получает
         pointer-events:none, а свойство наследуется. Возвращаем
         интерактивность нашему поддереву явно, иначе клик попадает в video. */
      pointer-events: auto;
    }
    /* Новый блок сначала получает размеры, фон, состояние иконки и состояние
       сворачивания и только затем показывается. Иначе браузер успевает
       отрисовать резервный фон и проиграть переход к конечному состоянию. */
    .ytev-box.ytev-initializing {
      visibility: hidden !important;
    }
    .ytev-box.ytev-initializing,
    .ytev-box.ytev-initializing *,
    .ytev-box.ytev-initializing::after {
      transition: none !important;
      animation: none !important;
    }
    /* содержимое поверх слоя подсветки */
    .ytev-box > * { position: relative; z-index: 1; }
    /* геометрия рамки: справа поле --ytev-pad, слева меньше — значок
       YouTube (viewBox 24×24) несёт собственные внутренние поля */
    .ytev-box.ytev-framed {
      /* Поле со стороны значка. Одно и то же в обоих состояниях: пока
         свёрнутый круг имел свои 2px, кнопка при наведении заметно
         подпрыгивала на четверть пикселя туда-обратно. */
      --ytev-lead: calc(var(--ytev-pad, 10px) * .25);
      padding: 0 var(--ytev-pad, 10px) 0 var(--ytev-lead);
      /* Промежуток между значком и шкалой живёт внутри шторки, а не как
         gap самой рамки. Как gap он менялся вместе со сворачиванием, и при
         разворачивании начало шкалы уезжало вправо на эти же пиксели.
         Внутри шторки отступ обрезается вместе с содержимым, ширины рамки
         не меняет — и левый край дорожки стоит на месте от первого кадра. */
      --ytev-gap: calc(var(--ytev-pad, 10px) * .5);
      /* Проценты стоят посередине между концом шкалы и краем рамки: поля
         слева и справа от них равны. Величина — среднее прежних двух
         (промежутка после шкалы и поля рамки), поэтому ширина блока не
         меняется, а подпись перестаёт липнуть к шкале. */
      --ytev-pct-side: calc((var(--ytev-gap) + var(--ytev-pad, 10px)) / 2);
      gap: 0;
      /* «Хвост» за концом шкалы, когда подписи с процентами нет. С обычным
         полем дорожка упиралась в рамку почти вплотную, а у штатной кнопки
         YouTube за её концом заметно больше воздуха. Когда подпись есть,
         этот воздух дают промежуток и сама подпись. */
      --ytev-tail: calc(var(--ytev-pad, 10px) * 1.75);
    }
    .ytev-box:not(.ytev-framed) { gap: 6px; }
    /* Если штатная кнопка звука была у правого края (обычное место в
       Shorts), шкала разворачивается влево — кнопка остаётся на своём
       месте, как у штатной выезжающей панели */
    .ytev-box.ytev-mirrored { flex-direction: row-reverse; }
    .ytev-box.ytev-framed.ytev-mirrored:not(.ytev-collapsed) {
      padding: 0 var(--ytev-lead) 0 var(--ytev-pad, 10px);
    }
    /* :not(.ytev-collapsed) обязателен: без него эти правила перебили бы
       поля свёрнутого круга — у них выше специфичность. */
    .ytev-box.ytev-framed.ytev-nolabel:not(.ytev-collapsed) {
      padding-right: var(--ytev-tail);
    }
    .ytev-box.ytev-framed.ytev-mirrored.ytev-nolabel:not(.ytev-collapsed) {
      padding-right: var(--ytev-lead);
      padding-left: var(--ytev-tail);
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
      pointer-events: auto;
    }
    .ytev-box:not(.ytev-framed) .ytev-mute { height: 36px; }
    .ytev-mute svg,
    .ytev-slider { filter: var(--ytev-shadow); }
    .ytev-label { text-shadow: 0 1px 4px rgb(0 0 0 / 30%); }
    .ytev-mute svg {
      /* У штатной кнопки YouTube SVG 24×24 внутри зоны 36×36 — это 66.7%.
         Наша рамка ниже штатной пилюли, и в ней тот же значок смотрелся
         крупновато, поэтому доля заметно меньше. */
      width: 55.1%;
      height: 55.1%;
      display: block;
      overflow: visible;
    }
    /* Актуальные формы YouTube (viewBox 24×24). При выключении звука
       волны за 200 мс сжимаются к своим центрам, после чего появляется
       штатный контурный рупор с крестом. Включение идёт в обратную сторону. */
    .ytev-speaker,
    .ytev-wave,
    .ytev-muted-icon { fill: currentColor; }
    .ytev-speaker {
      opacity: 1;
      transition: opacity .04s linear;
    }
    .ytev-wave {
      opacity: 1;
      transform: scale(1);
      transform-box: view-box;
      transition:
        transform .2s cubic-bezier(.2, 0, 0, 1),
        opacity .04s linear;
    }
    .ytev-wave-1 { transform-origin: 75% 50%; }
    .ytev-wave-2 { transform-origin: 91.6667% 50%; }
    .ytev-muted-icon {
      opacity: 0;
      transform: scale(.94);
      transform-box: view-box;
      transform-origin: 50% 50%;
      transition:
        opacity .04s linear,
        transform .2s cubic-bezier(.2, 0, 0, 1);
    }
    /* На тихой громкости YouTube оставляет только внутреннюю волну. */
    .ytev-box[data-vol="low"] .ytev-wave-2 {
      opacity: 0;
      transform: scale(0);
      transition-delay: 0s, .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-speaker {
      opacity: 0;
      transition-delay: .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-wave {
      opacity: 0;
      transform: scale(0);
      transition-delay: 0s, .16s;
    }
    .ytev-box[data-vol="muted"] .ytev-muted-icon {
      opacity: 1;
      transform: scale(1);
      transition-delay: .16s, 0s;
    }
    @media (prefers-reduced-motion: reduce) {
      .ytev-speaker,
      .ytev-wave,
      .ytev-muted-icon { transition: none; }
    }
    /* автосворачивание: без курсора остаётся только кнопка; переходы
       включаются лишь на время переключения (.ytev-animating), чтобы
       не мешать замерам layout() */
    .ytev-box.ytev-animating {
      transition: padding .25s ease, border-radius .25s ease;
    }
    /* Обрезающая обёртка шкалы: ширину меняет она, а <input> внутри всё
       время своего размера — поэтому шкала выезжает, а не растягивается. */
    .ytev-slot {
      display: flex;
      align-items: center;
      /* На всю высоту рамки: сама дорожка 4px, а бегунок 13px и торчит за
         её пределы. При высоте по содержимому overflow: hidden срезал его
         сверху и снизу — бегунок пропадал совсем. */
      align-self: stretch;
      /* Сжиматься обёртке можно: если замер свободного места ошибся, flex
         ужмёт её, и layout() увидит это и вернёт штатный ползунок. Сам
         <input> внутри при этом остаётся своего размера. */
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
    }
    /* С клавиатурным фокусом шкала и так раскрыта, обрезать нечего — зато
       иначе обрезалась бы рамка фокуса по бокам. */
    /* Именно :focus-visible, а не :focus-within: после клика по кнопке
       звука фокус остаётся на ней, и обрезка снималась бы — свёрнутый блок
       превращался в кружок, из которого торчала шкала во всю длину. */
    .ytev-slot:has(:focus-visible) { overflow: visible; }
    /* Селектор через .ytev-box намеренно: у самой шкалы ниже объявлено
       margin: 0, и при равной специфичности оно перебивало этот отступ —
       промежуток молча уезжал в конец шторки, из-за чего проценты стояли
       дальше от шкалы, чем от края рамки. */
    .ytev-box .ytev-slot > * { margin-left: var(--ytev-gap); }
    .ytev-box .ytev-label-slot > * { margin-left: var(--ytev-pct-side); }
    .ytev-box.ytev-mirrored .ytev-slot > * {
      margin-left: 0;
      margin-right: var(--ytev-gap);
    }
    .ytev-box.ytev-mirrored .ytev-label-slot > * {
      margin-left: 0;
      margin-right: var(--ytev-pct-side);
    }
    .ytev-box.ytev-framed:not(.ytev-nolabel):not(.ytev-collapsed) {
      padding-right: var(--ytev-pct-side);
    }
    .ytev-box.ytev-framed.ytev-mirrored:not(.ytev-nolabel):not(.ytev-collapsed) {
      padding-right: var(--ytev-lead);
      padding-left: var(--ytev-pct-side);
    }
    /* Зеркальный режим: блок раскрывается влево, значит шкала должна
       выезжать из-под кнопки, оставаясь прижатой к ней правым краем. */
    .ytev-box.ytev-mirrored .ytev-slot { justify-content: flex-end; }
    .ytev-box.ytev-animating .ytev-slot { transition: width .25s ease; }
    /* Проценты открываются вслед за шкалой: та же шторка, но со сдвигом на
       0.1с. Общая длительность совпадает с длиной хода шкалы, поэтому конец
       анимации по-прежнему ловится одним событием. Сворачивание идёт в
       обратном порядке — подпись уходит первой, без сдвига. */
    .ytev-box.ytev-animating .ytev-label-slot {
      transition: max-width .15s ease .1s, opacity .15s ease .1s;
    }
    .ytev-box.ytev-animating.ytev-collapsed .ytev-label-slot {
      transition: max-width .15s ease, opacity .12s ease;
    }
    /* Ширина шторки процентов и минимальная ширина самой подписи — одна и
       та же величина: тогда max-width шторки идёт от нуля ровно до
       натуральной ширины подписи, и открытие размазано на всю анимацию, а
       не заканчивается в первые кадры. */
    /* Свой размер шрифта здесь обязателен: --ytev-pct задан в em, а
       считается он в том элементе, где используется. Без этой строки шторка
       брала em от шрифта строки управления YouTube, а подпись — от своего.
       На мелком шрифте строки шторка выходила уже содержимого и срезала
       подпись справа: «%» съедался, а сама подпись прижималась к краю
       рамки. Замер: при 9px в строке справа от текста оставалось −1.5px. */
    .ytev-label-slot {
      font-size: var(--ytev-font);
      max-width: calc(var(--ytev-pct) + var(--ytev-pct-side));
    }
    /* Свёрнутое состояние — ровный круг со значком по центру, как
       штатные круглые кнопки YouTube. Кнопка занимает «высота − 4px»,
       поэтому симметричные поля по 2px дают ширину, равную высоте.
       Скругление задаётся в пикселях (половина высоты), а не в процентах:
       50% на ещё широком блоке — это эллипс, и в начале сворачивания
       рамка заметно вспухала по бокам, прежде чем сжаться. В пикселях та
       же величина и анимируется, и на квадрате даёт ровный круг.
       !important перебивает инлайновое скругление, скопированное с плашки. */
    .ytev-box.ytev-collapsed { gap: 0; padding: 0; }
    /* Свёрнутый круг: со стороны значка поле то же, что и в развёрнутом
       виде, а противоположное добирает до квадрата — кнопка занимает
       «высота − 4px», поэтому сумма полей равна 4px. */
    .ytev-box.ytev-framed.ytev-collapsed {
      padding: 0 max(0px, calc(4px - var(--ytev-lead))) 0 var(--ytev-lead);
      border-radius: var(--ytev-round, 50%) !important;
    }
    .ytev-box.ytev-framed.ytev-mirrored.ytev-collapsed {
      padding: 0 var(--ytev-lead) 0 max(0px, calc(4px - var(--ytev-lead)));
    }
    .ytev-box.ytev-collapsed .ytev-slot {
      width: 0 !important;
      min-width: 0 !important;
    }
    .ytev-box.ytev-collapsed .ytev-label-slot {
      max-width: 0;
      opacity: 0;
    }
    /* Уважаем системную настройку: там, где движение просят убрать,
       сворачивание должно происходить мгновенно, а не быстро. */
    @media (prefers-reduced-motion: reduce) {
      .ytev-box.ytev-animating,
      .ytev-box.ytev-animating .ytev-slider,
      .ytev-box.ytev-animating .ytev-label { transition: none; }
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
      flex: none; /* внутри обрезающей обёртки размер задаём мы, а не flex */
      min-width: 0;
      height: var(--ytev-track);
      border-radius: calc(var(--ytev-track) / 2);
      background: rgba(255, 255, 255, .3);
      outline: none;
      cursor: pointer;
      margin: 0;
      pointer-events: auto;
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
      min-width: var(--ytev-pct); /* под «100%», чтобы рамка не гуляла */
      max-width: var(--ytev-pct);
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

  // Ширину задаём обоим: обёртке (её и анимируем) и самому <input> (он
  // внутри неё постоянного размера, иначе бегунок и заливка «поехали» бы).
  function setSliderWidth(px) {
    const value = Math.round(px) + 'px';
    ui.slider.style.width = value;
    // Шторке нужен ещё и отступ от значка: он лежит внутри неё.
    ui.slot.style.width = `calc(${value} + var(--ytev-gap))`;
  }
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
  let videoBinding = null;
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
    const selected = p ? p.querySelector('video') : null;
    // Во время Shorts → Home YouTube заранее создаёт скрытый остановленный
    // #movie_player, но прежний Shorts ещё несколько секунд звучит. Пока
    // новый кандидат не начал воспроизведение, активным остаётся фактически
    // играющий boundVideo — иначе DOM-sweep перепривяжется к заготовке и
    // снимет нормализацию со старого звука.
    if (
      boundVideo &&
      !boundVideo.paused &&
      !boundVideo.ended &&
      (!selected || selected === boundVideo || selected.paused)
    ) {
      return boundVideo;
    }
    return selected;
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
    ui.slider.setAttribute('aria-valuetext', fmt(pct));
    paint(pct);
    ui.label.textContent = fmt(pct);
    const muted = video.muted || pct === 0;
    ui.box.classList.toggle('ytev-muted', muted);
    const state = muted ? 'muted' : pct < 50 ? 'low' : 'high';
    ui.box.dataset.vol = state;
    if (ui.muteBtn) {
      // Только aria-label: всплывающей подсказки у кнопки нет, она
      // перекрывала бы плеер. Клавиша озвучивается через aria-keyshortcuts.
      ui.muteBtn.setAttribute(
        'aria-label',
        muted ? STRINGS.playerUnmute : STRINGS.playerMute
      );
    }
  }

