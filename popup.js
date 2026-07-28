'use strict';

const DEFAULTS = {
  enabled: true,
  gamma: 3,
  sliderScale: 7,
  shortsScale: 11,
  showPercent: true,
  autoCollapse: true,
  collapseDelay: false,
  useNativeSlider: false,
  normalizeLoudness: false,
  maxBoostDb: 6,
};

// Строки живут в _locales. Русский текст остаётся в разметке и здесь как
// запасной вариант: если ключ потеряется или chrome.i18n окажется
// недоступен, пользователь увидит осмысленную подпись, а не пустое место.
const FALLBACK = {
  curveExample: 'При положении 50% звук будет ≈ $1% от максимума.',
  maxBoostValue: '$1 дБ',
  saveSaved: 'Сохранено',
  saveSaving: 'Сохраняю…',
  saveError: 'Не удалось сохранить',
};

function message(key, ...substitutions) {
  try {
    const value = chrome.i18n.getMessage(key, substitutions);
    if (value) return value;
  } catch {}
  const fallback = FALLBACK[key];
  if (!fallback) return '';
  return fallback.replace(/\$(\d)/g, (whole, index) => {
    const value = substitutions[Number(index) - 1];
    return value === undefined ? whole : value;
  });
}

function localize() {
  const locale = message('@@ui_locale');
  if (locale) document.documentElement.lang = locale.replace('_', '-');
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const text = message(node.dataset.i18n);
    if (text) node.textContent = text;
  }
}

const $enabled = document.getElementById('enabled');
const $gamma = document.getElementById('gamma');
const $gammaValue = document.getElementById('gammaValue');
const $curveExample = document.getElementById('curveExample');
const $scale = document.getElementById('sliderScale');
const $scaleValue = document.getElementById('scaleValue');
const $shorts = document.getElementById('shortsScale');
const $shortsValue = document.getElementById('shortsValue');
const $useNative = document.getElementById('useNativeSlider');
const $showPercent = document.getElementById('showPercent');
const $autoCollapse = document.getElementById('autoCollapse');
const $collapseDelay = document.getElementById('collapseDelay');
const $normalize = document.getElementById('normalizeLoudness');
const $maxBoost = document.getElementById('maxBoostDb');
const $maxBoostValue = document.getElementById('maxBoostValue');
const $saveStatus = document.getElementById('saveStatus');
const $saveStatusText = document.getElementById('saveStatusText');
const $reset = document.getElementById('resetSettings');

const controls = [
  $enabled,
  $gamma,
  $scale,
  $shorts,
  $useNative,
  $showPercent,
  $autoCollapse,
  $collapseDelay,
  $normalize,
  $maxBoost,
];

function setRangeProgress(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const progress = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--range-progress', `${progress}%`);
}

function render() {
  const gamma = Number($gamma.value);
  const halfVolume = Math.round(100 * Math.pow(0.5, gamma));
  $gammaValue.textContent = gamma.toFixed(1);
  $curveExample.textContent = message('curveExample', String(halfVolume));
  $scaleValue.textContent = `${$scale.value}%`;
  $shortsValue.textContent = `${$shorts.value}%`;
  $maxBoostValue.textContent = message('maxBoostValue', $maxBoost.value);

  setRangeProgress($gamma);
  setRangeProgress($scale);
  setRangeProgress($shorts);
  setRangeProgress($maxBoost);

  for (const row of document.querySelectorAll('.own-only')) {
    row.hidden = $useNative.checked;
  }
  // Задержка имеет смысл только при включённом автосворачивании: без него
  // сворачивать нечего, и строка только занимала бы место.
  document.getElementById('collapseDelayRow').hidden =
    $useNative.checked || !$autoCollapse.checked;
  // Предел подъёма уточняет выравнивание: без него подтягивать нечего.
  document.getElementById('maxBoostRow').hidden = !$normalize.checked;
}

function setControls(settings) {
  $enabled.checked = settings.enabled;
  $gamma.value = settings.gamma;
  $scale.value = settings.sliderScale;
  $shorts.value = settings.shortsScale;
  $useNative.checked = settings.useNativeSlider;
  $showPercent.checked = settings.showPercent;
  $autoCollapse.checked = settings.autoCollapse;
  $collapseDelay.checked = settings.collapseDelay;
  $normalize.checked = settings.normalizeLoudness;
  $maxBoost.value = settings.maxBoostDb;
}

function values() {
  return {
    enabled: $enabled.checked,
    gamma: Number($gamma.value),
    sliderScale: Number($scale.value),
    shortsScale: Number($shorts.value),
    useNativeSlider: $useNative.checked,
    showPercent: $showPercent.checked,
    autoCollapse: $autoCollapse.checked,
    collapseDelay: $collapseDelay.checked,
    normalizeLoudness: $normalize.checked,
    maxBoostDb: Number($maxBoost.value),
  };
}

function showSaveStatus(state) {
  const saving = state === 'saving';
  $saveStatus.classList.toggle('is-saving', saving);
  $saveStatusText.textContent = message(
    state === 'error' ? 'saveError' : saving ? 'saveSaving' : 'saveSaved'
  );
}

// Range inputs may emit dozens of events while dragging. Debouncing avoids
// exhausting chrome.storage.sync's write quota, while change/pagehide still
// flush the final value immediately.
let saveTimer = 0;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  showSaveStatus('saving');
  chrome.storage.sync.set(values(), () => {
    showSaveStatus(chrome.runtime.lastError ? 'error' : 'saved');
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  showSaveStatus('saving');
  saveTimer = setTimeout(saveNow, 250);
}

localize();

chrome.storage.sync.get(DEFAULTS, (settings) => {
  setControls(settings);
  render();
  showSaveStatus('saved');
});

for (const control of controls) {
  control.addEventListener('input', () => {
    render();
    scheduleSave();
  });
  control.addEventListener('change', saveNow);
}

$reset.addEventListener('click', () => {
  setControls(DEFAULTS);
  render();
  saveNow();
});

window.addEventListener('pagehide', () => {
  if (saveTimer) saveNow();
});
