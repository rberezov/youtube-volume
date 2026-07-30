// Измеритель громкости по ITU-R BS.1770-4.
//
// Коэффициенты K-взвешивания выводятся из аналоговых прототипов под
// фактическую частоту дискретизации: готовые числа стандарта даны для 48кГц,
// а контекст в браузере бывает и 44.1кГц — тогда полка уехала бы.
// Вывод сверен с таблицей стандарта: на 48кГц совпадает до 1e-15.
const HIST_MIN = -70;
// Шаг 0.01 LU: при 0.1 квантование гистограммы давало заметную в тестах
// погрешность интегральной оценки (−6.000 вместо −6.014). Память при этом
// всё равно копеечная — 30 КБ на гистограмму.
const HIST_STEP = 0.01;
const HIST_BINS = 7501;

function kWeighting(fs) {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const a0h = 1 + Kh / Qh + Kh * Kh;
  const hp = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (Kh * Kh - 1)) / a0h,
    a2: (1 - Kh / Qh + Kh * Kh) / a0h,
  };
  return [shelf, hp];
}

const energyOf = (loudness) => Math.pow(10, (loudness + 0.691) / 10);
const loudnessOf = (energy) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);

class LoudnessMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stages = kWeighting(sampleRate);
    this.filters = [];
    // Под-блок 100мс: из четырёх таких складывается окно 400мс (перекрытие
    // 75%), из тридцати — краткосрочное окно 3с.
    this.subTarget = Math.max(1, Math.round(sampleRate * 0.1));
    this.subFilled = 0;
    this.subSums = [];
    this.window = [];
    this.subIndex = 0;
    this.blockHist = new Int32Array(HIST_BINS);
    this.shortHist = new Int32Array(HIST_BINS);
    this.blockCount = 0;
    this.shortCount = 0;
    this.recent = [];
    this.momentary = null;
    this.shortTerm = null;
    this.frames = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'reset') this.reset();
      this.port.postMessage(this.snapshot('read'));
    };
  }

  reset() {
    this.filters = [];
    this.subFilled = 0;
    this.subSums = [];
    this.window = [];
    this.subIndex = 0;
    this.blockHist.fill(0);
    this.shortHist.fill(0);
    this.blockCount = 0;
    this.shortCount = 0;
    this.recent = [];
    this.momentary = null;
    this.shortTerm = null;
    this.frames = 0;
  }

  ensureChannels(count) {
    while (this.filters.length < count) {
      this.filters.push(
        this.stages.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
      );
      this.subSums.push(0);
    }
  }

  // Прямая форма I: коэффициентов мало, состояние наглядное, а точности
  // double здесь с большим запасом.
  filterSample(channel, sample) {
    const chain = this.filters[channel];
    let value = sample;
    for (let i = 0; i < this.stages.length; i += 1) {
      const c = this.stages[i];
      const s = chain[i];
      const out =
        c.b0 * value + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
      s.x2 = s.x1;
      s.x1 = value;
      s.y2 = s.y1;
      s.y1 = out;
      value = out;
    }
    return value;
  }

  // Громкость набора под-блоков: сумма средних квадратов по каналам с
  // весами G. Для стерео G = 1 у обоих каналов.
  windowLoudness(count) {
    if (this.window.length < count) return null;
    const slice = this.window.slice(this.window.length - count);
    const channels = slice[0].length;
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      let mean = 0;
      for (const sub of slice) mean += sub[ch];
      sum += mean / count;
    }
    return loudnessOf(sum);
  }

  bin(hist, loudness) {
    if (!Number.isFinite(loudness) || loudness < HIST_MIN) return false;
    const index = Math.min(
      HIST_BINS - 1,
      Math.max(0, Math.round((loudness - HIST_MIN) / HIST_STEP))
    );
    hist[index] += 1;
    return true;
  }

  // Двухпроходное гейтирование стандарта: абсолютный порог уже применён при
  // занесении в гистограмму, здесь относительный (−10 LU от среднего).
  gatedLoudness(hist, count, relative) {
    if (!count) return null;
    let sum = 0;
    for (let i = 0; i < HIST_BINS; i += 1) {
      if (hist[i]) sum += hist[i] * energyOf(HIST_MIN + i * HIST_STEP);
    }
    const threshold = loudnessOf(sum / count) - relative;
    let gatedSum = 0;
    let gatedCount = 0;
    for (let i = 0; i < HIST_BINS; i += 1) {
      const centre = HIST_MIN + i * HIST_STEP;
      if (!hist[i] || centre <= threshold) continue;
      gatedSum += hist[i] * energyOf(centre);
      gatedCount += hist[i];
    }
    if (!gatedCount) return null;
    return { loudness: loudnessOf(gatedSum / gatedCount), threshold, count: gatedCount };
  }

  // Диапазон громкости по EBU Tech 3342: перцентили 10 и 95 краткосрочных
  // значений после относительного гейта в −20 LU.
  range() {
    const gated = this.gatedLoudness(this.shortHist, this.shortCount, 20);
    if (!gated) return null;
    const kept = [];
    for (let i = 0; i < HIST_BINS; i += 1) {
      const centre = HIST_MIN + i * HIST_STEP;
      if (this.shortHist[i] && centre > gated.threshold) {
        kept.push([centre, this.shortHist[i]]);
      }
    }
    if (!kept.length) return null;
    const total = kept.reduce((sum, [, n]) => sum + n, 0);
    const percentile = (p) => {
      let seen = 0;
      const target = total * p;
      for (const [centre, n] of kept) {
        seen += n;
        if (seen >= target) return centre;
      }
      return kept[kept.length - 1][0];
    };
    return Math.max(0, percentile(0.95) - percentile(0.1));
  }

  // Тип нужен, чтобы отличить ежесекундный тик от ответа на запрос: без
  // handler'а сообщения копятся в очереди порта, и подписавшийся позже
  // получил бы сначала самый ранний тик, а не свежий снимок.
  snapshot(kind) {
    const integrated = this.gatedLoudness(this.blockHist, this.blockCount, 10);
    return {
      type: kind,
      rate: sampleRate,
      seconds: this.frames / sampleRate,
      momentary: this.momentary,
      shortTerm: this.shortTerm,
      integrated: integrated ? integrated.loudness : null,
      gatedBlocks: integrated ? integrated.count : 0,
      blocks: this.blockCount,
      lra: this.range(),
      recent: this.recent.slice(),
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length;
    this.ensureChannels(channels);
    const length = input[0].length;
    for (let i = 0; i < length; i += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        const value = this.filterSample(ch, input[ch][i]);
        this.subSums[ch] += value * value;
      }
      this.subFilled += 1;
      if (this.subFilled < this.subTarget) continue;

      const means = [];
      for (let ch = 0; ch < channels; ch += 1) {
        means.push(this.subSums[ch] / this.subTarget);
        this.subSums[ch] = 0;
      }
      this.subFilled = 0;
      this.window.push(means);
      if (this.window.length > 30) this.window.shift();
      this.subIndex += 1;

      // Окно 400мс каждые 100мс — это и есть блоки стандарта с перекрытием.
      const momentary = this.windowLoudness(4);
      if (momentary !== null) {
        this.momentary = momentary;
        if (this.bin(this.blockHist, momentary)) this.blockCount += 1;
      }
      const shortTerm = this.windowLoudness(30);
      if (shortTerm !== null) {
        this.shortTerm = shortTerm;
        // Краткосрочные значения в распределение — раз в секунду.
        if (this.subIndex % 10 === 0) {
          if (this.bin(this.shortHist, shortTerm)) this.shortCount += 1;
          this.recent.push(Number(shortTerm.toFixed(2)));
          if (this.recent.length > 120) this.recent.shift();
          // Снимок отдаётся раз в секунду по аудиочасам. Это не опрос:
          // главный поток ничего не спрашивает и таймеров не заводит.
          this.port.postMessage(this.snapshot('tick'));
        }
      }
    }
    this.frames += length;
    return true;
  }
}

registerProcessor('ytev-loudness-meter', LoudnessMeter);
