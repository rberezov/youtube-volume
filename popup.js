'use strict';

const DEFAULTS = { enabled: true, gamma: 3, sliderScale: 20 };

const $enabled = document.getElementById('enabled');
const $gamma = document.getElementById('gamma');
const $gammaValue = document.getElementById('gammaValue');
const $scale = document.getElementById('sliderScale');
const $scaleValue = document.getElementById('scaleValue');

function render() {
  $gammaValue.textContent = Number($gamma.value).toFixed(1);
  $scaleValue.textContent = $scale.value;
}

function save() {
  chrome.storage.sync.set({
    enabled: $enabled.checked,
    gamma: Number($gamma.value),
    sliderScale: Number($scale.value),
  });
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $enabled.checked = s.enabled;
  $gamma.value = s.gamma;
  $scale.value = s.sliderScale;
  render();
});

for (const el of [$enabled, $gamma, $scale]) {
  el.addEventListener('input', () => {
    render();
    save();
  });
}
