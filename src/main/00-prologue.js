// СОБИРАЕТСЯ из src/main/*.js — `npm run build:main`. Правьте части, а не
// результат: расхождение ловят тесты и сборщик пакета.
//
// Одним файлом он остаётся не по привычке. Service worker передаёт саму
// функцию youtubeVolumeMain в chrome.scripting.executeScript, тот сериализует
// её исходник и выполняет в MAIN-мире страницы, где нет ни модулей, ни
// chrome.runtime, ни возможности что-то догрузить: CSP youtube.com отклоняет
// и blob-модуль, и любой посторонний скрипт. Разделение поэтому сделано в
// исходнике, а собранный артефакт остаётся прежним.
//
// Запускается service worker через chrome.scripting.executeScript в MAIN-мире:
// перехватывает установку громкости у HTMLMediaElement, применяет
// экспоненциальную кривую и добавляет точный ползунок.
function youtubeVolumeMain(initialPayload, updateSecret) {
  'use strict';

  const PAGE_ORIGIN = location.origin;
  const CHANNEL_PATTERN = /^[a-f0-9]{32}$/;
  const SECRET_PATTERN = /^[a-f0-9]{64}$/;
  const CHANNEL_ID =
    initialPayload && typeof initialPayload.channel === 'string'
      ? initialPayload.channel
      : '';
  if (!CHANNEL_PATTERN.test(CHANNEL_ID) || !SECRET_PATTERN.test(updateSecret)) {
    return false;
  }
  const INSTANCE_KEY = Symbol.for('ytev.main.instance.v2');
  // preload.js уже стоит в MAIN-мире с document_start. Помимо раннего уровня
  // он держит неизменяемый брокер управления: секрет проверяется внутри его
  // замыкания и больше не передаётся функции из writable-свойства window.
  // beginControl() также гасит предыдущее поколение ДО захвата дескрипторов:
  // его dispose() возвращает нативные volume/muted.
  const preload = window[Symbol.for('ytev.preload.instance.v1')];
  if (
    !preload ||
    preload.version !== 1 ||
    typeof preload.takeover !== 'function' ||
    typeof preload.beginControl !== 'function' ||
    typeof preload.commitControl !== 'function' ||
    typeof preload.cancelControl !== 'function'
  ) {
    return false;
  }
  if (!preload.beginControl(CHANNEL_ID, updateSecret)) return false;

  // preload.js удерживает
  // сохранённый уровень, пока service worker читает chrome.storage.
  // Снимаем его синхронный перехват до захвата нативных дескрипторов:
  // дальше полный экземпляр отвечает и за кривую, и за состояние.
  // Форму объекта подделать нетрудно, поэтому из ответа берём ровно два
  // поля и только в допустимом виде — ни одно постороннее свойство внутрь
  // не проходит. Сам слот реестра preload занимает первым делом, ещё до
  // своих ранних выходов, так что чужому объекту там взяться неоткуда.
  let preloadState = null;
  if (
    preload &&
    preload.version === 1 &&
    typeof preload.takeover === 'function'
  ) {
    try {
      const state = preload.takeover();
      const heldVolume = Number(state && state.volume);
      if (
        state &&
        typeof state === 'object' &&
        Number.isFinite(heldVolume) &&
        heldVolume >= 0 &&
        heldVolume <= 1
      ) {
        preloadState = {
          volume: heldVolume,
          volumeDirty: state.volumeDirty === true,
        };
      }
    } catch {}
  }

  // Снятие всего, что экземпляр развесил на window/document. Нужно для
  // dispose(): без этого старое поколение продолжало бы жить слушателями.
  const teardown = [];
  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    teardown.push(() => target.removeEventListener(type, handler, options));
  }

  // Потолок для настройки «предел подъёма». Это уже большой запас, поэтому
  // пользователь включает его осознанно: у самых тихих записей он полезен,
  // но при ошибочном loudnessDb может приблизить пики к перегрузке.
  const MAX_BOOST_LIMIT_DB = 15;

  const SETTINGS = {
    enabled: true,          // применять экспоненциальную кривую
    gamma: 3,               // крутизна кривой: real = logical^gamma (1 = линейно)
    sliderScale: 7,         // длина ползунка в % от ширины плеера
    shortsScale: 11,        // то же для Shorts — плеер узкий, размер свой
    showPercent: true,      // подпись с процентами рядом с ползунком
    autoCollapse: true,     // сворачивать шкалу, когда курсор не на ней
    collapseDelay: false,   // сворачивать не сразу, дав шкале открыться
    useNativeSlider: false, // не строить свою шкалу — оставить штатную
    normalizeLoudness: false, // подтягивать тихие ролики к общему уровню
    maxBoostDb: 6,          // предел подъёма тихих, дБ (приглушение не трогает)
  };
  const EARLY_HIDE_CLASS = 'ytev-native-volume-hidden';
  const EARLY_HIDE_MANAGED_CLASS = 'ytev-native-volume-managed';
  let earlyHideSafetyTimer = 0;

  function setEarlyNativeHidden(hidden, settled = false) {
    const root = document.documentElement;
    if (!root || !root.classList) return;
    root.classList.add(EARLY_HIDE_MANAGED_CLASS);
    root.classList.toggle(EARLY_HIDE_CLASS, hidden);
    clearTimeout(earlyHideSafetyTimer);
    if (hidden && !settled) {
      // Если YouTube изменил DOM и наша шкала не смогла смонтироваться,
      // штатное управление должно вернуться автоматически.
      earlyHideSafetyTimer = setTimeout(() => {
        if (!document.querySelector('.ytev-box')) {
          root.classList.remove(EARLY_HIDE_CLASS);
        }
      }, 8000);
    }
  }

  // Подписи приходят готовыми из service worker: chrome.i18n в MAIN-мире нет.
  // Значения по умолчанию русские и остаются на случай неполного payload —
  // пустая подпись у кнопки хуже непереведённой.
  const STRINGS = {
    playerSliderLabel: 'Громкость',
    playerUnmute: 'Включить звук',
    playerMute: 'Отключить звук',
  };

  function applyStrings(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(STRINGS)) {
      if (typeof value[key] === 'string' && value[key]) STRINGS[key] = value[key];
    }
  }

  function applySettings(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of [
      'enabled',
      'showPercent',
      'autoCollapse',
      'collapseDelay',
      'useNativeSlider',
      'normalizeLoudness',
    ]) {
      if (typeof value[key] === 'boolean') SETTINGS[key] = value[key];
    }
    const gamma = Number(value.gamma);
    const sliderScale = Number(value.sliderScale);
    const shortsScale = Number(value.shortsScale);
    const maxBoostDb = Number(value.maxBoostDb);
    if (Number.isFinite(gamma)) SETTINGS.gamma = Math.min(6, Math.max(1, gamma));
    if (Number.isFinite(sliderScale)) {
      SETTINGS.sliderScale = Math.min(70, Math.max(2, sliderScale));
    }
    if (Number.isFinite(shortsScale)) {
      SETTINGS.shortsScale = Math.min(70, Math.max(2, shortsScale));
    }
    if (Number.isFinite(maxBoostDb)) {
      SETTINGS.maxBoostDb = Math.min(MAX_BOOST_LIMIT_DB, Math.max(1, maxBoostDb));
    }
    setEarlyNativeHidden(!SETTINGS.useNativeSlider);
  }

