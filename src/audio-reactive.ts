import type { AudioAnalysis, LayerEffect, LayerParams } from './types';

export interface AudioReactiveState { level: number; scale: number; brightness: number; opacity: number }
export interface AudioReactiveOptions { muted?: boolean; gain?: number; audioEnd?: number }
interface ReactiveSettings { lowHz: number; highHz: number; sensitivity: number; threshold: number; attack: number; release: number }
interface Envelope { analysisId: number; key: string; values: Float32Array; stride: number; lastIndex: number }

const FFT_SIZE = 2048;
const MAX_ENVELOPE_SAMPLES = 262144;
const MAX_CACHED_SAMPLES = 1048576;
const MAX_ENVELOPES = 16;
const cache: Envelope[] = [];
let analysisIds = new WeakMap<AudioAnalysis, number>();
let nextAnalysisId = 1;
let retainedSamples = 0;
let builds = 0;
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const numeric = (params: LayerParams, key: string, fallback: number, min: number, max: number): number => {
  const value = params[key]; return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
};
const identity = (): AudioReactiveState => ({ level: 0, scale: 1, brightness: 1, opacity: 1 });

function resolveSettings(params: LayerParams): ReactiveSettings {
  const mode = Math.round(numeric(params, 'band', 0, 0, 4));
  const bands = [[20, 20000], [35, 250], [250, 4000], [4000, 16000]];
  const custom = [numeric(params, 'lowHz', 35, 20, 20000), numeric(params, 'highHz', 250, 20, 20000)].sort((a, b) => a - b);
  const [lowHz, highHz] = mode === 4 ? custom : bands[mode];
  return { lowHz, highHz, sensitivity: numeric(params, 'sensitivity', 1.5, 0, 5), threshold: numeric(params, 'threshold', .08, 0, 1),
    attack: numeric(params, 'attack', .06, 0, 1), release: numeric(params, 'release', .3, 0, 2) };
}

/** Reconstruct the analysis cache's actual FFT-bin spans. Its 64 bands are
 * logarithmic display buckets, not 64 equally spaced physical frequencies.
 * Overlap is measured against real bin centres, including rounded low bands. */
export function audioBandWeights(sampleRate: number, bands: number, lowHz: number, highHz: number): Float32Array {
  if (!Number.isInteger(bands) || bands < 1 || bands > 4096) return new Float32Array(0);
  const weights = new Float32Array(bands);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(lowHz) || !Number.isFinite(highHz)) return weights;
  const low = Math.max(0, Math.min(lowHz, highHz)); const high = Math.min(sampleRate / 2, Math.max(lowHz, highHz));
  if (high <= low) return weights;
  const minimum = Math.min(35, sampleRate / 8); const maximum = Math.min(16000, sampleRate / 2);
  const binHz = sampleRate / FFT_SIZE;
  for (let band = 0; band < bands; band++) {
    const from = minimum * (maximum / minimum) ** (band / bands);
    const to = minimum * (maximum / minimum) ** ((band + 1) / bands);
    const start = Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.round(from / binHz)));
    const end = Math.max(start + 1, Math.min(FFT_SIZE / 2, Math.round(to / binHz)));
    // Each Fourier bin represents a half-bin either side of its centre.
    const firstHz = (start - .5) * binHz; const lastHz = (end - .5) * binHz;
    weights[band] = clamp((Math.min(high, lastHz) - Math.max(low, firstHz)) / (lastHz - firstHz));
  }
  return weights;
}

function usable(analysis: AudioAnalysis | null): analysis is AudioAnalysis {
  return !!analysis && analysis.frames.length > 0 && Number.isFinite(analysis.hopSec) && analysis.hopSec > 0 &&
    Number.isFinite(analysis.sampleRate) && analysis.sampleRate > 0 && Number.isFinite(analysis.duration) && analysis.duration > 0 &&
    Number.isInteger(analysis.bands) && analysis.bands > 0 && analysis.bands <= 4096;
}

function frameLevel(frame: Float32Array | undefined, weights: Float32Array, settings: ReactiveSettings): number {
  if (!frame || settings.sensitivity === 0 || settings.threshold === 1) return 0;
  let amplitude = 0;
  for (let band = 0; band < Math.min(frame.length, weights.length); band++) {
    const value = frame[band]; if (!weights[band] || !Number.isFinite(value) || value <= 0) continue;
    // Recover linear amplitude from the analysis cache's fixed -72 dB floor.
    // A peak band preserves a bass beat even in a broad/full-frequency range;
    // fractional edge coverage attenuates partially selected frequency buckets.
    const linear = 10 ** ((clamp(value) * 72 - 72) / 20);
    amplitude = Math.max(amplitude, linear * Math.sqrt(weights[band]));
  }
  return clamp((amplitude * settings.sensitivity - settings.threshold) / (1 - settings.threshold));
}

function envelopeFor(analysis: AudioAnalysis, settings: ReactiveSettings): Envelope {
  let analysisId = analysisIds.get(analysis);
  if (analysisId === undefined) { analysisId = nextAnalysisId++; analysisIds.set(analysis, analysisId); }
  const key = [settings.lowHz, settings.highHz, settings.sensitivity, settings.threshold, settings.attack, settings.release].join('|');
  const found = cache.findIndex(entry => entry.analysisId === analysisId && entry.key === key);
  if (found >= 0) { const [entry] = cache.splice(found, 1); cache.push(entry); return entry; }
  const lastIndex = Math.min(analysis.frames.length - 1, Math.ceil(analysis.duration / analysis.hopSec));
  const stride = Math.max(1, Math.ceil((lastIndex + 1) / (MAX_ENVELOPE_SAMPLES - 1)));
  const values = new Float32Array(Math.ceil(lastIndex / stride) + 1);
  const weights = audioBandWeights(analysis.sampleRate, analysis.bands, settings.lowHz, settings.highHz);
  const attack = settings.attack > 0 ? Math.exp(-analysis.hopSec / settings.attack) : 0;
  const release = settings.release > 0 ? Math.exp(-analysis.hopSec / settings.release) : 0;
  let level = 0;
  for (let index = 0; index <= lastIndex; index++) {
    const target = frameLevel(analysis.frames[index], weights, settings);
    const coefficient = target > level ? attack : release;
    level = target + coefficient * (level - target);
    if (index % stride === 0) values[index / stride] = level;
  }
  // Retain the true final sample when a very long song needs a decimated cache.
  values[values.length - 1] = level;
  const entry = { analysisId, key, values, stride, lastIndex }; cache.push(entry); retainedSamples += values.length; builds++;
  while (cache.length > MAX_ENVELOPES || retainedSamples > MAX_CACHED_SAMPLES) retainedSamples -= cache.shift()!.values.length;
  return entry;
}

/** Pure global-song-time sample. Envelope history is precomputed once per
 * analysis/settings pair, so seeking and rendering out of order cannot change
 * the result. No audio, muted audio, zero fade gain, and out-of-source time are
 * exact identity transforms rather than a fabricated sine-wave animation. */
export function audioReactiveAtTime(effect: LayerEffect, analysis: AudioAnalysis | null, timeSec: number, options: AudioReactiveOptions = {}): AudioReactiveState {
  const strength = Number.isFinite(effect.strength) ? clamp(effect.strength) : 0;
  const gain = options.gain === undefined ? 1 : Number.isFinite(options.gain) ? clamp(options.gain) : 0;
  if (!effect.enabled || strength === 0 || options.muted || gain === 0 || !usable(analysis) || !Number.isFinite(timeSec) || timeSec < 0 ||
    timeSec >= analysis.duration || (options.audioEnd !== undefined && timeSec >= options.audioEnd)) return identity();
  const entry = envelopeFor(analysis, resolveSettings(effect.params));
  const position = clamp(timeSec / analysis.hopSec, 0, entry.lastIndex);
  const before = Math.min(entry.values.length - 1, Math.floor(position / entry.stride));
  const after = Math.min(entry.values.length - 1, before + 1);
  const beforeFrame = before * entry.stride; const afterFrame = Math.min(entry.lastIndex, after * entry.stride);
  const fraction = afterFrame > beforeFrame ? clamp((position - beforeFrame) / (afterFrame - beforeFrame)) : 0;
  const level = clamp((entry.values[before] * (1 - fraction) + entry.values[after] * fraction) * strength * gain);
  return { level, scale: 1 + numeric(effect.params, 'scale', .08, 0, .5) * level,
    brightness: 1 + numeric(effect.params, 'brightness', .12, 0, 1) * level,
    opacity: 1 - numeric(effect.params, 'opacity', 0, 0, 1) * level };
}

export function clearAudioReactiveCache(): void { cache.length = 0; retainedSamples = 0; builds = 0; analysisIds = new WeakMap(); nextAnalysisId = 1; }
/** Diagnostics are counts only; callers cannot mutate the cached song data. */
export function audioReactiveCacheStats(): { entries: number; samples: number; bytes: number; builds: number } {
  return { entries: cache.length, samples: retainedSamples, bytes: retainedSamples * 4, builds };
}
