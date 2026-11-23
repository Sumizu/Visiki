import { createSpectrumPeakSampler } from './spectrum-signal';
import type { AudioAnalysis, Layer } from './types';

export interface SpectrumEnvelopePoint { x: number; y: number }
export interface SpectrumEnvelope {
  upper: SpectrumEnvelopePoint[];
  lower: SpectrumEnvelopePoint[];
  lineWidth: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const numeric = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const smoothstep = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

/**
 * A moving window of real sample peaks, rather than the FFT's dB-normalised
 * bands. All smoothing is tied to audio time, so seeking and offline export
 * produce the same contour as uninterrupted playback.
 */
export function sampleSpectrumEnvelope(layer: Layer, timeSec: number, analysis: AudioAnalysis | null): SpectrumEnvelope {
  const { width, height } = layer;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(timeSec)) {
    return { upper: [], lower: [], lineWidth: 0 };
  }
  const lineWidth = Math.min(width, height, clamp(numeric(layer.params.lineWidth, 2.8), .5, 8));
  const halfWidth = Math.max(0, (width - lineWidth) / 2);
  const halfHeight = Math.max(0, (height - lineWidth) / 2);
  const segments = Math.max(64, clamp(Math.round(numeric(layer.params.barCount, 80)), 8, 256) * 2);
  const windowSec = clamp(numeric(layer.params.envelopeWindow, 1.5), .25, 4);
  const smoothing = clamp(numeric(layer.params.smoothing, .6), 0, 1);
  const gain = clamp(numeric(layer.params.gain, 1.3), 0, 10);
  const usable = analysis && Number.isFinite(analysis.duration) && analysis.duration > 0 &&
    Number.isFinite(analysis.hopSec) && analysis.hopSec > 0 && analysis.peaks.length > 0 &&
    timeSec >= 0 && timeSec < analysis.duration;
  // Boundary easing avoids a whole silhouette appearing/disappearing at once.
  const edgeSec = usable ? Math.min(.08, windowSec * .12, analysis.duration / 4) : 1;
  const boundary = usable ? smoothstep(timeSec / edgeSec) * smoothstep((analysis.duration - timeSec) / edgeSec) : 0;
  const spacing = windowSec * .0075 + smoothing * .024;
  const peakAt = usable && boundary > 0 && gain > 0 ? createSpectrumPeakSampler(analysis, smoothing) : null;
  const upper: SpectrumEnvelopePoint[] = []; const lower: SpectrumEnvelopePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const sourceTime = timeSec + (u - .5) * windowSec;
    let peak = 0;
    if (peakAt) {
      // A compact, fixed binomial kernel smooths the shoulders of isolated
      // transients without sweeping a maximum across the entire time window.
      for (let tap = -2; tap <= 2; tap++) {
        const weight = tap === 0 ? 6 : Math.abs(tap) === 1 ? 4 : 1;
        peak += peakAt(sourceTime + tap * spacing) * weight / 16;
      }
    }
    peak = Number.isFinite(peak) ? clamp(peak, 0, 1) : 0;
    const strength = (1 - Math.exp(-peak * gain * 1.7)) * boundary;
    const shoulder = i === 0 || i === segments ? 0 : Math.sin(Math.PI * u);
    const x = -halfWidth + u * halfWidth * 2;
    // Rounded ends and a slightly shallower lower edge form a quiet, organic
    // silhouette. Their only changing amplitude comes from the source music.
    upper.push({ x, y: strength > 0 && shoulder > 0 ? -halfHeight * .94 * strength * Math.pow(shoulder, 1.45) : 0 });
    lower.push({ x, y: halfHeight * .70 * strength * Math.pow(shoulder, 1.75) });
  }
  return { upper, lower, lineWidth };
}

/** Shape-preserving cubic tangents avoid ringing outside the measured envelope. */
function traceContour(ctx: CanvasRenderingContext2D, points: SpectrumEnvelopePoint[], move: boolean): void {
  if (move) ctx.moveTo(points[0].x, points[0].y);
  const tangent = (index: number): number => {
    if (index <= 0 || index >= points.length - 1) return 0;
    const before = points[index].y - points[index - 1].y;
    const after = points[index + 1].y - points[index].y;
    return before * after > 0 ? 2 * before * after / (before + after) : 0;
  };
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i]; const next = points[i + 1];
    const dx = (next.x - current.x) / 3;
    const low = Math.min(current.y, next.y); const high = Math.max(current.y, next.y);
    ctx.bezierCurveTo(current.x + dx, clamp(current.y + tangent(i) / 3, low, high),
      next.x - dx, clamp(next.y - tangent(i + 1) / 3, low, high), next.x, next.y);
  }
}

/** One translucent fill and one fine outline; inherits scene colour and alpha. */
export function drawSpectrumEnvelope(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number, analysis: AudioAnalysis | null): void {
  const geometry = sampleSpectrumEnvelope(layer, timeSec, analysis);
  if (!geometry.upper.length) return;
  ctx.save();
  try {
    const alpha = ctx.globalAlpha;
    ctx.lineWidth = geometry.lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.filter = 'none';
    ctx.beginPath();
    traceContour(ctx, geometry.upper, true);
    traceContour(ctx, geometry.lower.slice().reverse(), false);
    ctx.closePath();
    ctx.globalAlpha = alpha * .18; ctx.fill();
    ctx.globalAlpha = alpha; ctx.stroke();
  } finally { ctx.restore(); }
}
