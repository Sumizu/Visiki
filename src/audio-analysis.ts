import type { AudioAnalysis } from './types';

const FFT_SIZE = 2048;
const BAND_COUNT = 64;
const TARGET_FPS = 30;

function fft(real: Float64Array, imag: Float64Array, bitReverse: Uint16Array, cos: Float64Array, sin: Float64Array): void {
  const count = real.length;
  for (let i = 0; i < count; i++) {
    const j = bitReverse[i];
    if (j > i) {
      const value = real[i]; real[i] = real[j]; real[j] = value;
      const imaginary = imag[i]; imag[i] = imag[j]; imag[j] = imaginary;
    }
  }
  for (let size = 2; size <= count; size *= 2) {
    const half = size / 2;
    const step = count / size;
    for (let base = 0; base < count; base += size) {
      for (let j = 0; j < half; j++) {
        const twiddle = j * step;
        const index = base + j;
        const other = index + half;
        const r = real[other] * cos[twiddle] - imag[other] * sin[twiddle];
        const i = real[other] * sin[twiddle] + imag[other] * cos[twiddle];
        real[other] = real[index] - r; imag[other] = imag[index] - i;
        real[index] += r; imag[index] += i;
      }
    }
  }
}

const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Offline Hann-window FFT cache. Channels are combined as power, so opposite
 * phase stereo never becomes silent. Each frame is evaluated at a fixed hop;
 * preview, seeking, and export consume the same immutable cache.
 */
export async function analyzeAudio(buffer: AudioBuffer, onProgress?: (n: number) => void): Promise<AudioAnalysis> {
  if (!buffer.sampleRate || !buffer.numberOfChannels || !buffer.length) throw new Error('音频没有可分析的采样数据');
  const sampleRate = buffer.sampleRate;
  const hop = Math.max(1, Math.round(sampleRate / TARGET_FPS));
  const hopSec = hop / sampleRate;
  const duration = buffer.length / sampleRate;
  const count = Math.ceil(buffer.length / hop) + 1;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const window = new Float64Array(FFT_SIZE);
  const reverse = new Uint16Array(FFT_SIZE);
  const cos = new Float64Array(FFT_SIZE / 2);
  const sin = new Float64Array(FFT_SIZE / 2);
  let windowSum = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
    windowSum += window[i];
    let source = i; let reversed = 0;
    for (let b = 0; b < 11; b++) { reversed = (reversed << 1) | (source & 1); source >>>= 1; }
    reverse[i] = reversed;
  }
  for (let i = 0; i < cos.length; i++) { cos[i] = Math.cos(-2 * Math.PI * i / FFT_SIZE); sin[i] = Math.sin(-2 * Math.PI * i / FFT_SIZE); }
  const minFrequency = Math.min(35, sampleRate / 8);
  const maxFrequency = Math.min(16000, sampleRate / 2);
  const bandRanges = Array.from({ length: BAND_COUNT }, (_, i) => {
    const from = minFrequency * (maxFrequency / minFrequency) ** (i / BAND_COUNT);
    const to = minFrequency * (maxFrequency / minFrequency) ** ((i + 1) / BAND_COUNT);
    const start = Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.round(from * FFT_SIZE / sampleRate)));
    const end = Math.max(start + 1, Math.min(FFT_SIZE / 2, Math.round(to * FFT_SIZE / sampleRate)));
    return [start, end];
  });
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2);
  const normalization = 4 / (windowSum * windowSum * channels.length);
  const frames: Float32Array[] = [];
  const peaks = new Float32Array(count);
  const waveform = new Float32Array(Math.max(1, Math.min(2400, Math.ceil(duration * 120))));
  onProgress?.(0);
  // Store actual sample maxima separately from the frequency-domain features.
  for (const channel of channels) {
    for (let from = 0; from < channel.length; from += sampleRate) {
      const to = Math.min(channel.length, from + sampleRate);
      for (let sample = from; sample < to; sample++) {
        const amplitude = Math.min(1, Math.abs(channel[sample]));
        const peakIndex = Math.floor(sample / hop);
        const waveIndex = Math.min(waveform.length - 1, Math.floor(sample * waveform.length / buffer.length));
        if (amplitude > peaks[peakIndex]) peaks[peakIndex] = amplitude;
        if (amplitude > waveform[waveIndex]) waveform[waveIndex] = amplitude;
      }
      if ((from / sampleRate) % 5 === 0) await yieldToBrowser();
    }
  }
  for (let frame = 0; frame < count; frame++) {
    power.fill(0);
    const start = frame * hop - FFT_SIZE / 2;
    for (const channel of channels) {
      imag.fill(0);
      for (let i = 0; i < FFT_SIZE; i++) real[i] = (channel[start + i] ?? 0) * window[i];
      fft(real, imag, reverse, cos, sin);
      for (let bin = 0; bin < power.length; bin++) power[bin] += real[bin] ** 2 + imag[bin] ** 2;
    }
    const values = new Float32Array(BAND_COUNT);
    for (let band = 0; band < BAND_COUNT; band++) {
      const [from, to] = bandRanges[band];
      let totalPower = 0;
      for (let bin = from; bin < to; bin++) totalPower += power[bin];
      const amplitude = Math.sqrt(totalPower * normalization / (to - from));
      // A fixed -72 dB floor keeps amplitudes comparable throughout a project.
      values[band] = Math.max(0, Math.min(1, (20 * Math.log10(amplitude + 1e-10) + 72) / 72));
    }
    frames.push(values);
    if (frame % 12 === 0) { onProgress?.(frame / count); await yieldToBrowser(); }
  }
  onProgress?.(1);
  return { hopSec, bands: BAND_COUNT, frames, peaks, waveform, sampleRate, duration };
}

/** Linear time interpolation is deterministic even when frames are requested out of order. */
export function sampleFeatures(analysis: AudioAnalysis | null, timeSec: number): Float32Array {
  const result = new Float32Array(analysis?.bands ?? BAND_COUNT);
  if (!analysis || !analysis.frames.length || !Number.isFinite(timeSec) || timeSec < 0 || timeSec > analysis.duration) return result;
  const frame = Math.max(0, Math.min(analysis.frames.length - 1, timeSec / analysis.hopSec));
  const low = Math.floor(frame);
  const high = Math.min(analysis.frames.length - 1, low + 1);
  const fraction = frame - low;
  for (let i = 0; i < result.length; i++) result[i] = analysis.frames[low][i] * (1 - fraction) + analysis.frames[high][i] * fraction;
  return result;
}
