'use strict';

const DEFAULTS = { enabled: true, gamma: 3, sliderWidth: 220 };

const $enabled = document.getElementById('enabled');
const $gamma = document.getElementById('gamma');
const $gammaValue = document.getElementById('gammaValue');
const $width = document.getElementById('sliderWidth');
const $widthValue = document.getElementById('widthValue');

function render() {
  $gammaValue.textContent = Number($gamma.value).toFixed(1);
  $widthValue.textContent = $width.value;
}

function save() {
  chrome.storage.sync.set({
    enabled: $enabled.checked,
    gamma: Number($gamma.value),
    sliderWidth: Number($width.value),
  });
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $enabled.checked = s.enabled;
  $gamma.value = s.gamma;
  $width.value = s.sliderWidth;
  render();
});

for (const el of [$enabled, $gamma, $width]) {
  el.addEventListener('input', () => {
    render();
    save();
  });
}
