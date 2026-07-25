'use strict';

const DEFAULTS = {
  enabled: true,
  gamma: 3,
  sliderScale: 20,
  showPercent: true,
  autoCollapse: false,
};

const $enabled = document.getElementById('enabled');
const $gamma = document.getElementById('gamma');
const $gammaValue = document.getElementById('gammaValue');
const $scale = document.getElementById('sliderScale');
const $scaleValue = document.getElementById('scaleValue');
const $showPercent = document.getElementById('showPercent');
const $autoCollapse = document.getElementById('autoCollapse');

function render() {
  $gammaValue.textContent = Number($gamma.value).toFixed(1);
  $scaleValue.textContent = $scale.value;
}

// Запись откладывается: chrome.storage.sync допускает ~2 записи в
// секунду, а перетаскивание ползунка даёт десятки событий input — лишние
// записи молча отбрасывались квотой, включая финальное значение, и
// настройка «не менялась»
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set(
      {
        enabled: $enabled.checked,
        gamma: Number($gamma.value),
        sliderScale: Number($scale.value),
        showPercent: $showPercent.checked,
        autoCollapse: $autoCollapse.checked,
      },
      () => void chrome.runtime.lastError
    );
  }, 250);
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $enabled.checked = s.enabled;
  $gamma.value = s.gamma;
  $scale.value = s.sliderScale;
  $showPercent.checked = s.showPercent;
  $autoCollapse.checked = s.autoCollapse;
  render();
});

for (const el of [$enabled, $gamma, $scale, $showPercent, $autoCollapse]) {
  el.addEventListener('input', () => {
    render();
    save();
  });
}
