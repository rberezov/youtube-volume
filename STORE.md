# Материалы для Chrome Web Store

Тексты готовы к вставке в форму листинга. Скриншоты нужно снять самостоятельно
— требования и список кадров в конце файла.

---

## Русский

### Короткое описание (до 132 символов)

```
Точная регулировка громкости YouTube: экспоненциальная кривая и длинный
ползунок вместо стандартного короткого.
```

### Полное описание

```
Стандартный ползунок громкости YouTube меняет громкость линейно, а слух
воспринимает её логарифмически. Из-за этого почти весь полезный диапазон сжат
в первых 10–20% шкалы: чуть сдвинул — уже громко, а тихо сделать невозможно.

Расширение применяет степенную кривую: громкость на выходе = (позиция)^γ.
При γ = 3 позиция 50% даёт 12.5% амплитуды — субъективно это как раз половина
громкости. Крутизна настраивается от 1 (как в YouTube) до 6.

ЧТО ЕЩЁ

• Длинный ползунок прямо в панели плеера, с шагом 0.1% и индикатором
  процентов. Длина настраивается и масштабируется вместе с плеером.
• Работает в Shorts, где длина настраивается отдельно — плеер там узкий.
• Без треска при регулировке: громкость применяется через Web Audio, то есть
  меняется в аудиопотоке с частотой дискретизации, а не ступенчато.
• Громкость и состояние «звук выключен» сохраняются и переносятся между
  обычными видео, Shorts и новыми вкладками.
• Колесо мыши над ползунком: ±1%, с Shift — ±0.1%.
• Автосворачивание: без курсора остаётся аккуратная круглая кнопка. Шкала
  выезжает и убирается плавно, проценты появляются следом за ней. Есть режим
  с задержкой перед сворачиванием — удобно с длинной шкалой.
• Выравнивание громкости роликов, по желанию: расширение отключает
  «стабильную громкость» YouTube и само выравнивает исходный звук. Предел
  подъёма выбирается — от 1 до 15 дБ, по умолчанию 6. По умолчанию выключено.
• Режим «использовать шкалу YouTube»: свой ползунок не строится, а
  экспоненциальная кривая продолжает работать.
• Если в панели не хватает места, ползунок укорачивается, затем прячутся
  проценты, а в совсем узком плеере возвращается штатный ползунок YouTube —
  громкость всегда остаётся регулируемой.

ПРИВАТНОСТЬ

Расширение не собирает данные и не делает сетевых запросов вообще. Хранятся
только ваши настройки, последний уровень громкости и технический кэш громкости
текущего ролика — всё в браузере. Исходный код открыт.
```

---

## English

### Short description (max 132 characters)

```
Precise YouTube volume control: an exponential curve and a long slider in
place of the short stock one.
```

### Full description

```
YouTube's volume slider is linear, but hearing is logarithmic. As a result
almost the entire useful range is crammed into the first 10–20% of the slider:
nudge it and it is already loud, and quiet is simply out of reach.

This extension applies a power curve: output volume = (position)^γ. At γ = 3
the 50% position gives 12.5% amplitude — which subjectively is exactly half
the loudness. The steepness is adjustable from 1 (same as YouTube) to 6.

WHAT ELSE

• A long slider right in the player controls, with a 0.1% step and a
  percentage readout. Its length is configurable and scales with the player.
• Works in Shorts, where the length is configured separately — the player
  there is narrow.
• No crackle while adjusting: volume is applied through Web Audio, so the gain
  changes at the audio sample rate instead of stepping at buffer boundaries.
• Volume and mute state are remembered and carried across regular videos,
  Shorts and new tabs.
• Mouse wheel over the slider: ±1%, with Shift ±0.1%.
• Auto-collapse: with the pointer away only a neat round button remains. The
  slider slides out and back smoothly, with the percentage following it. A
  collapse delay mode is available — handy with a long slider.
• Optional loudness matching across videos: the extension disables YouTube
  Stable Volume and normalizes the original audio itself. Choose a boost limit
  from 1 to 15 dB; the default is 6 dB. Disabled by default.
• "Use the YouTube slider" mode: no custom slider is built, while the
  exponential curve keeps working.
• When the control bar runs out of room the slider shrinks, then the
  percentage is hidden, and in a very narrow player the stock YouTube slider
  comes back — volume always stays adjustable.

PRIVACY

The extension collects no data and makes no network requests at all. Only your
settings, the last volume level and a technical cache of the current video's
loudness are stored, in your browser. The source code is open.
```

---

## Обоснование разрешений

Chrome Web Store требует объяснить каждое разрешение. Формулировки ниже можно
вставлять как есть.

**`storage`**
> Хранит настройки расширения (крутизна кривой, длина ползунка, режимы
> отображения) и последний уровень громкости, чтобы они не сбрасывались между
> видео и вкладками. Никакие другие данные не сохраняются.

**`scripting`**
> Нужен для внедрения кода в страницу YouTube: расширение перехватывает
> регулировку громкости и строит собственный ползунок в панели плеера. Без
> внедрения в контекст страницы это невозможно.

**Доступ к `https://www.youtube.com/*`**
> Единственный сайт, на котором расширение работает. Доступа к другим страницам
> оно не запрашивает и не получает.

**Удалённый код**
> Не используется. Всё исполняемое содержимое входит в пакет расширения;
> внешние скрипты не загружаются, сетевых запросов расширение не делает.

---

## Скриншоты

Снять нужно самостоятельно на настоящем YouTube — подставлять сюда кадры с
макетов нельзя, это выдало бы макет за реальный интерфейс.

Требования магазина: **1280×800** или 640×400, PNG или JPEG, от 1 до 5 штук.
Первый скриншот показывается в результатах поиска — он важнее остальных.

Список кадров:

1. **Обычное видео, ползунок развёрнут** — панель плеера с длинной шкалой и
   процентами. Основной кадр, ставить первым.
2. **Popup с настройками** — видно крутизну кривой и пример «при положении 50%
   звук будет ≈ 13%», а ниже — переключатели, включая выравнивание громкости
   роликов.
3. **Shorts** — блок громкости на месте штатного контрола.
4. **Автосворачивание** — круглая кнопка без курсора рядом с развёрнутым
   состоянием (можно одним кадром «до/после»).
5. *(необязательно)* **Режим штатной шкалы** — интерфейс YouTube не изменён,
   но кривая работает.

Иконки для листинга уже есть в `icons/` (16, 32, 48, 128).

---

## Перед публикацией

- [ ] Проверить версию в `manifest.json` и в `package.json` — они должны совпадать.
- [ ] `npm test` — все проверки зелёные.
- [ ] Проверить на русском и английском профиле Chrome (`chrome://settings/languages`).
- [ ] Снять скриншоты по списку выше.
- [ ] Указать ссылку на `PRIVACY.md` в поле политики конфиденциальности.
- [ ] Собрать ZIP без `node_modules`, `tests`, `.github` и файлов разработки.
