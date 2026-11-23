import { createSpectrumPeakSampler } from './spectrum-signal';
import type { AudioAnalysis, Layer } from './types';

export interface SpectrumEcgPoint { x: number; y: number }
export interface SpectrumEcg { points: SpectrumEcgPoint[]; lineWidth: number }
interface Transient { time: number; energy: number; novelty: number }

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const numeric = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const smoothstep = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const STEP = .01;
// A small leading shoulder, a brisk Q/R/S excursion, then a quiet return.
// Times are relative to an actual musical onset, not a metronome or BPM clock.
const PULSE: readonly (readonly [number, number])[] = [
  [0, 0], [.018, -.10], [.040, 0], [.052, .12], [.068, -1],
  [.090, .48], [.115, 0], [.170, -.18], [.230, 0],
];

/** Find local rises on a fixed song-time grid. Only the visible history and a
 * small detection neighbourhood are visited, never the full song per frame. */
function transients(peakAt: (time: number) => number, start: number, end: number, duration: number): Transient[] {
  const first = Math.max(0, Math.floor(start / STEP));
  const last = Math.min(Math.ceil(duration / STEP), Math.ceil(end / STEP));
  const score = (index: number): number => {
    if (index < 0 || index * STEP >= duration) return 0;
    const time = index * STEP;
    return Math.max(0, peakAt(time + .018) - peakAt(time - .045));
  };
  // Neighbours use absolute indices, so entering/leaving the viewport cannot
  // change which onset wins the local competition or shift its position.
  const scores = new Map<number, number>();
  const at = (index: number): number => {
    const cached = scores.get(index);
    if (cached !== undefined) return cached;
    const value = score(index); scores.set(index, value); return value;
  };
  const result: Transient[] = [];
  for (let i = first; i <= last; i++) {
    const novelty = at(i);
    if (novelty < .006) continue;
    let winner = true;
    for (let offset = -7; offset <= 7; offset++) {
      if (offset === 0) continue;
      const other = at(i + offset);
      if (other > novelty + 1e-10 || (offset < 0 && Math.abs(other - novelty) <= 1e-10)) { winner = false; break; }
    }
    if (winner) result.push({ time: i * STEP, novelty, energy: peakAt(i * STEP + .025) });
  }
  return result;
}

function pulseAt(time: number): number {
  if (time <= 0 || time >= PULSE[PULSE.length - 1][0]) return 0;
  for (let i = 1; i < PULSE.length; i++) {
    if (time > PULSE[i][0]) continue;
    const [beforeTime, before] = PULSE[i - 1]; const [afterTime, after] = PULSE[i];
    return before + (after - before) * smoothstep((time - beforeTime) / (afterTime - beforeTime));
  }
  return 0;
}

/** A single ECG-inspired musical trace. Recent audio enters at the right and
 * moves left without a modulo/reset seam. Geometry depends only on song time,
 * including when sought directly or rendered out of order for export. */
export function sampleSpectrumEcg(layer: Layer, timeSec: number, analysis: AudioAnalysis | null): SpectrumEcg {
  const { width, height } = layer;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(timeSec)) {
    return { points: [], lineWidth: 0 };
  }
  const lineWidth = Math.min(width, height, clamp(numeric(layer.params.lineWidth, 2.8), .5, 8));
  const halfWidth = Math.max(0, (width - lineWidth) / 2), halfHeight = Math.max(0, (height - lineWidth) / 2);
  const windowSec = clamp(numeric(layer.params.envelopeWindow, 1.5), .25, 4);
  const smoothing = clamp(numeric(layer.params.smoothing, .6), 0, 1);
  const gain = clamp(numeric(layer.params.gain, 1.3), 0, 10);
  const segments = Math.max(96, clamp(Math.round(numeric(layer.params.barCount, 80)), 8, 256) * 2);
  const usable = !!analysis && Number.isFinite(analysis.duration) && analysis.duration > 0 &&
    Number.isFinite(analysis.hopSec) && analysis.hopSec > 0 && analysis.peaks?.length > 0 &&
    timeSec >= 0 && timeSec < analysis.duration;
  const left = timeSec - windowSec, pulseScale = .90 + smoothing * .25;
  const peakAt = usable && gain > 0 ? createSpectrumPeakSampler(analysis, smoothing) : () => 0;
  const events = usable && gain > 0 ? transients(peakAt, left - .23 * pulseScale, timeSec, analysis.duration) : [];
  const times = Array.from({ length: segments + 1 }, (_, i) => left + i / segments * windowSec);
  // Preserve narrow extrema even at low precision or a four-second viewport.
  // Fixed event knots also travel continuously with the audio, rather than
  // hopping between a small set of horizontal samples.
  for (const event of events) for (let i = 0; i < PULSE.length; i++) {
    const time = event.time + PULSE[i][0] * pulseScale;
    if (time > left && time < timeSec) times.push(time);
  }
  times.sort((a, b) => a - b);
  const edgeSec = Math.min(.05, windowSec * .07);
  const endGate = usable ? smoothstep((analysis.duration - timeSec) / Math.min(.08, analysis.duration / 4)) : 0;
  const points: SpectrumEcgPoint[] = [];
  let previousTime = -Infinity;
  for (const time of times) {
    if (Math.abs(time - previousTime) < 1e-10) continue;
    previousTime = time;
    const u = clamp((time - left) / windowSec, 0, 1);
    let trace = 0;
    if (usable && gain > 0) {
      const energy = peakAt(time);
      // A sustained note has only a minute, energy-driven baseline shimmer.
      // Silence is exactly flat; it never manufactures periodic heartbeats.
      const bed = energy >= 1e-5 ? 1 - Math.exp(-energy * gain * 1.8) : 0;
      trace = bed * .012 * (Math.sin(time * 11) + .3 * Math.sin(time * 17));
      for (const event of events) {
        const drive = event.energy * (.35 + .65 * clamp(event.novelty / (event.energy + .02), 0, 1));
        const strength = 1 - Math.exp(-drive * gain * 1.8);
        trace += strength * pulseAt((time - event.time) / pulseScale);
      }
    }
    const edge = smoothstep((time - left) / edgeSec) * smoothstep((timeSec - time) / edgeSec);
    points.push({ x: -halfWidth + u * halfWidth * 2, y: halfHeight * .96 * Math.tanh(trace * 1.3) * edge * endGate || 0 });
  }
  return { points, lineWidth };
}

/** One open stroke, inheriting scene colour/opacity and restoring all state. */
export function drawSpectrumEcg(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number, analysis: AudioAnalysis | null): void {
  const { points, lineWidth } = sampleSpectrumEcg(layer, timeSec, analysis);
  if (!points.length) return;
  const tangent = (index: number): number => {
    if (index <= 0 || index >= points.length - 1) return 0;
    const before = points[index].y - points[index - 1].y, after = points[index + 1].y - points[index].y;
    if (before * after <= 0) return 0;
    const leftWidth = points[index].x - points[index - 1].x, rightWidth = points[index + 1].x - points[index].x;
    if (leftWidth <= 0 || rightWidth <= 0) return 0;
    const left = before / leftWidth, right = after / rightWidth;
    return 3 * (leftWidth + rightWidth) / ((2 * rightWidth + leftWidth) / left + (rightWidth + 2 * leftWidth) / right);
  };
  ctx.save();
  try {
    ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.filter = 'none';
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const current = points[i], next = points[i + 1], dx = (next.x - current.x) / 3;
      const low = Math.min(current.y, next.y), high = Math.max(current.y, next.y);
      ctx.bezierCurveTo(current.x + dx, clamp(current.y + tangent(i) * dx, low, high),
        next.x - dx, clamp(next.y - tangent(i + 1) * dx, low, high), next.x, next.y);
    }
    ctx.stroke();
  } finally { ctx.restore(); }
}
