import type { AudioAnalysis } from './types';

export interface SpectrumSignal { bands: Float64Array; peak: number; level: number }
interface PeakEnvelope { id: number; smoothing: number; values: Float32Array; hop: number; duration: number; last: number; stride: number }
const ids = new WeakMap<AudioAnalysis, number>();
const envelopes: PeakEnvelope[] = [];
let nextId = 1, retainedSamples = 0;
// The editor permits 100 layers. Keep their distinct smoothing values resident
// so sequential playback never rebuilds a whole song for every layer/frame.
// Storage is allocated lazily; each envelope stays <= 1 MiB, the LRU <= 128 MiB.
const MAX_ENTRIES = 128, MAX_ENTRY_SAMPLES = 262144, MAX_SAMPLES = MAX_ENTRIES * MAX_ENTRY_SAMPLES;
const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
const unit = (v: number): number => Number.isFinite(v) ? clamp(v) : 0;
const smoothness = (v: number): number => Number.isFinite(v) ? Math.round(clamp(v) * 1000) / 1000 : .6;
const ease = (v: number): number => { const x = clamp(v); return x * x * (3 - 2 * x); };
function usable(a: AudioAnalysis | null): a is AudioAnalysis {
  return !!a && Number.isFinite(a.duration) && a.duration > 0 && Number.isFinite(a.hopSec) && a.hopSec > 0 &&
    a.peaks?.length > 0;
}
const slope = (a: number, b: number): number => a * b <= 0 ? 0 : 2 * a * b / (a + b);
function hermite(a: number, b: number, ma: number, mb: number, f: number): number {
  const f2 = f * f, f3 = f2 * f;
  return clamp((2 * f3 - 3 * f2 + 1) * a + (f3 - 2 * f2 + f) * ma + (-2 * f3 + 3 * f2) * b + (f3 - f2) * mb, Math.min(a, b), Math.max(a, b));
}
function envelope(a: AudioAnalysis, smoothing: number): PeakEnvelope {
  let id = ids.get(a); if (!id) { id = nextId++; ids.set(a, id); }
  const found = envelopes.findIndex(e => e.id === id && e.smoothing === smoothing);
  if (found >= 0) { const e = envelopes.splice(found, 1)[0]; envelopes.push(e); return e; }
  const last = Math.min(a.peaks.length, Math.ceil(a.duration / a.hopSec));
  const stride = Math.max(1, Math.ceil((last + 1) / (MAX_ENTRY_SAMPLES - 1)));
  const values = new Float32Array(Math.ceil(last / stride) + 1);
  const attackSec = .008 + .028 * smoothing, releaseSec = .035 + .18 * smoothing;
  const attack = Math.exp(-a.hopSec / attackSec), release = Math.exp(-a.hopSec / releaseSec);
  let value = 0;
  // The initial state belongs to song time zero, never to the first requested
  // preview frame. A single cache build also serves arbitrary seeks/exports.
  for (let i = 1; i <= last; i++) {
    // peaks[i - 1] measures [(i - 1) * hop, i * hop). Integrating that
    // interval preserves the first transient and the final partial interval.
    const target = unit(a.peaks[i - 1]);
    const elapsed = Math.min(a.hopSec, Math.max(0, a.duration - (i - 1) * a.hopSec));
    const coefficient = elapsed < a.hopSec ? Math.exp(-elapsed / (target > value ? attackSec : releaseSec)) : target > value ? attack : release;
    value = target + coefficient * (value - target);
    if (i % stride === 0) values[i / stride] = value;
  }
  if (last > 0) values[values.length - 1] = value;
  const result = { id, smoothing, values, hop: a.hopSec, duration: a.duration, last, stride };
  envelopes.push(result); retainedSamples += values.length;
  while (envelopes.length > MAX_ENTRIES || retainedSamples > MAX_SAMPLES) retainedSamples -= envelopes.shift()!.values.length;
  return result;
}
function samplePeak(e: PeakEnvelope, time: number): number {
  if (!Number.isFinite(time) || time < 0 || time >= e.duration || e.values.length < 2) return 0;
  const position = clamp(time / e.hop, 0, e.last);
  const i = Math.min(e.values.length - 2, Math.floor(position / e.stride));
  const at = (n: number): number => e.values[clamp(n, 0, e.values.length - 1)];
  const frame = (n: number): number => Math.min(e.last, e.duration / e.hop, clamp(n, 0, e.values.length - 1) * e.stride);
  const width = frame(i + 1) - frame(i);
  if (width <= 0) return 0;
  const derivative = (n: number): number => {
    if (n <= 0 || n >= e.values.length - 1) return 0;
    const before = frame(n) - frame(n - 1), after = frame(n + 1) - frame(n);
    if (before <= 0 || after <= 0) return 0;
    const left = (at(n) - at(n - 1)) / before, right = (at(n + 1) - at(n)) / after;
    if (left * right <= 0) return 0;
    const w1 = 2 * after + before, w2 = after + 2 * before;
    return (w1 + w2) / (w1 / left + w2 / right);
  };
  const value = hermite(at(i), at(i + 1), derivative(i) * width, derivative(i + 1) * width, clamp((position - frame(i)) / width));
  // Fade to a truly flat line at EOF instead of dropping the last frame.
  return unit(value * ease((e.duration - time) / Math.min(.045 + .08 * e.smoothing, e.duration / 4)));
}

/** Capture the bounded immutable envelope once per contour, then sample each
 * horizontal position without repeatedly resolving the analysis/cache key. */
export function createSpectrumPeakSampler(analysis: AudioAnalysis | null, smoothing = .6): (time: number) => number {
  if (!usable(analysis)) return () => 0;
  const cached = envelope(analysis, smoothness(smoothing));
  return time => samplePeak(cached, time);
}
export function sampleSpectrumPeak(analysis: AudioAnalysis | null, timeSec: number, smoothing = .6): number {
  if (!usable(analysis) || !Number.isFinite(timeSec) || timeSec < 0 || timeSec >= analysis.duration) return 0;
  return samplePeak(envelope(analysis, smoothness(smoothing)), timeSec);
}
function bandAt(a: AudioAnalysis, time: number, band: number): number {
  if (time < 0 || time >= a.duration || !a.frames?.length) return 0;
  const position = clamp(time / a.hopSec, 0, a.frames.length - 1), i = Math.floor(position), f = position - i;
  const at = (n: number): number => unit(a.frames[clamp(n, 0, a.frames.length - 1)]?.[band] ?? 0);
  const before = at(i - 1), current = at(i), next = at(i + 1), after = at(i + 2);
  return hermite(current, next, slope(current - before, next - current), slope(next - current, after - next), f);
}
export function sampleSpectrumSignal(analysis: AudioAnalysis | null, timeSec: number, smoothing = .6): SpectrumSignal {
  const count = Number.isInteger(analysis?.bands) && analysis!.bands > 0 && analysis!.bands <= 4096 ? analysis!.bands : 64;
  const bands = new Float64Array(count);
  if (!usable(analysis) || !Number.isFinite(timeSec) || timeSec < 0 || timeSec >= analysis.duration) return { bands, peak: 0, level: 0 };
  const amount = smoothness(smoothing), spacing = .012 + .035 * amount;
  for (const [offset, weight] of [[-2, .08], [-1, .22], [0, .4], [1, .22], [2, .08]]) {
    for (let band = 0; band < count; band++) bands[band] += bandAt(analysis, timeSec + offset * spacing, band) * weight;
  }
  const peak = sampleSpectrumPeak(analysis, timeSec, amount);
  return { bands, peak, level: peak };
}
export function clearSpectrumSignalCache(): void { envelopes.length = 0; retainedSamples = 0; }
export function spectrumSignalCacheStats(): { entries: number; samples: number; bytes: number } {
  return { entries: envelopes.length, samples: retainedSamples, bytes: retainedSamples * 4 };
}
