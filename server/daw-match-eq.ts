import { promises as fs } from 'node:fs';
import { EQ_MATCH_FREQUENCIES as anchors } from '../src/daw/effects';

export interface MatchEqSource {
  file: string;
  info: { sampleRate: number; channels: 1 | 2; sampleCount: number; dataOffset: number };
  sourceIn: number;
  duration: number;
  /** Linear clip/track gain for aggregating several dry sources. */
  gain?: number;
}

const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Iterative radix-2 FFT. The windowed data and scratch arrays are reused per frame. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, wrStep = Math.cos(angle), wiStep = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = start + j, b = a + size / 2;
        const tr = wr * real[b] - wi * imag[b], ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
        const next = wr * wrStep - wi * wiStep; wi = wr * wiStep + wi * wrStep; wr = next;
      }
    }
  }
}

async function spectrum(source: MatchEqSource, signal: AbortSignal): Promise<{ powers: number[]; valid: boolean[]; duration: number } | undefined> {
  const { info } = source;
  const start = Math.round(source.sourceIn * info.sampleRate);
  const frames = Math.min(Math.round(Math.min(source.duration, 8) * info.sampleRate), info.sampleCount - start);
  if (start < 0 || frames < 1) throw invalid('所选片段没有可分析的音频');
  const block = info.channels * 4;
  const buffer = Buffer.alloc(frames * block);
  const handle = await fs.open(source.file, 'r');
  try {
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), info.dataOffset + start * block + offset);
      if (!bytesRead) throw invalid('音频缓存不完整');
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  let square = 0;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const value = buffer.readFloatLE(offset);
    if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw invalid('音频包含无效浮点样本');
    square += value * value;
  }
  const gain = source.gain ?? 1;
  if (square / (frames * info.channels) * gain * gain < 1e-10) return undefined;

  // Approx. 10 Hz resolution even for high-rate sources; bounded to 32768 points.
  const size = Math.min(32768, Math.max(1024, 2 ** Math.ceil(Math.log2(info.sampleRate / 10))));
  const real = new Float64Array(size), imag = new Float64Array(size);
  const window = Float64Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1)));
  const powers = new Float64Array(size / 2 + 1);
  const hop = size >> 1;
  let count = 0;
  // Center a short clip in the window, otherwise use overlapping full windows.
  const positions = frames <= size ? [Math.floor((frames - size) / 2)] : Array.from({ length: 1 + Math.floor((frames - size) / hop) }, (_, i) => i * hop);
  for (const position of positions) {
    for (let channel = 0; channel < info.channels; channel++) {
      signal.throwIfAborted();
      for (let i = 0; i < size; i++) {
        const frame = position + i;
        real[i] = frame >= 0 && frame < frames ? buffer.readFloatLE(frame * block + channel * 4) * window[i] : 0;
        imag[i] = 0;
      }
      fft(real, imag);
      for (let bin = 1; bin < powers.length; bin++) powers[bin] += real[bin] ** 2 + imag[bin] ** 2;
      count++;
    }
    // Let disconnects and server shutdown deliver aborts during CPU work.
    if (count % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  signal.throwIfAborted();
  const nyquist = info.sampleRate / 2;
  const valid = anchors.map(hz => hz < nyquist * .85);
  const bandPowers = anchors.map(hz => {
    let weightedPower = 0, weightSum = 0;
    for (let bin = 1; bin < powers.length; bin++) {
      const frequency = bin * info.sampleRate / size;
      const distance = Math.log2(frequency / hz);
      if (Math.abs(distance) > 2) continue;
      const weight = Math.exp(-.5 * (distance / .55) ** 2);
      weightedPower += powers[bin] * weight; weightSum += weight;
    }
    return Math.max(weightedPower / Math.max(weightSum * count * size * size, 1), square / (frames * info.channels) * 1e-12, 1e-30) * gain * gain;
  });
  return { powers: bandPowers, valid, duration: frames / info.sampleRate };
}

/** Compare dry spectral shapes; remove global level differences and bound each suggestion. */
export async function matchEqSources(target: MatchEqSource | MatchEqSource[], reference: MatchEqSource, signal: AbortSignal): Promise<number[]> {
  const sources = Array.isArray(target) ? target : [target];
  const spectra: NonNullable<Awaited<ReturnType<typeof spectrum>>>[] = [];
  for (const source of sources) {
    const result = await spectrum(source, signal);
    if (result) spectra.push(result);
  }
  const b = await spectrum(reference, signal);
  if (!spectra.length || !b) throw invalid('所选音频静音或电平过低，无法匹配');
  const a = {
    valid: anchors.map((_, i) => spectra.some(item => item.valid[i])),
    powers: anchors.map((_, i) => {
      const usable = spectra.filter(item => item.valid[i]);
      const duration = usable.reduce((sum, item) => sum + item.duration, 0);
      return usable.reduce((sum, item) => sum + item.powers[i] * item.duration, 0) / Math.max(duration, 1e-30);
    }),
  };
  const valid = anchors.map((_, i) => a.valid[i] && b.valid[i]);
  const differences = anchors.map((_, i) => 10 * Math.log10(Math.max(b.powers[i], 1e-30) / Math.max(a.powers[i], 1e-30)));
  const mean = differences.reduce((sum, value, i) => sum + (valid[i] ? value : 0), 0) / valid.filter(Boolean).length;
  const centered = differences.map(value => value - mean);
  return centered.map((value, i) => {
    if (!valid[i]) return 0;
    let sum = value * .7, weight = .7;
    for (const adjacent of [i - 1, i + 1]) if (valid[adjacent]) { sum += centered[adjacent] * .15; weight += .15; }
    return Number(Math.max(-6, Math.min(6, sum / weight)).toFixed(1));
  });
}
