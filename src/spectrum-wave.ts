import { sampleSpectrumSignal } from './spectrum-signal';
import type { AudioAnalysis, Layer } from './types';

export interface SpectrumWavePoint { x: number; y: number }
export type DualSpectrumWave = [SpectrumWavePoint[], SpectrumWavePoint[]];

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const unit = (value: number): number => Number.isFinite(value) ? clamp(value, 0, 1) : 0;
const numeric = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const lineWidth = (layer: Layer): number => Math.min(clamp(numeric(layer.params.lineWidth, 2.8), .5, 8), layer.width, layer.height);

/**
 * Two open, interlacing strokes. A broad frequency contour and two related,
 * asymmetric carriers give the lines clear crossings and a leading / following
 * rhythm. Actual linear energy keeps quiet music quiet, including flat silence.
 * Coordinates are local to the layer centre and include half-stroke padding.
 */
export function sampleDualSpectrumWave(layer: Layer, timeSec: number, analysis: AudioAnalysis | null): DualSpectrumWave {
  const { width, height } = layer;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(timeSec)) return [[], []];
  const segments = clamp(Math.round(numeric(layer.params.barCount, 80)), 8, 256) * 2;
  const count = Math.max(64, segments);
  const gain = clamp(numeric(layer.params.gain, 1.3), 0, 10);
  const halfWidth = Math.max(0, (width - lineWidth(layer)) / 2);
  const halfHeight = Math.max(0, (height - lineWidth(layer)) / 2);
  const smoothing = clamp(numeric(layer.params.smoothing, .6), 0, 1);
  const flowSpeed = clamp(numeric(layer.params.flowSpeed, 1), 0, 3);
  const features = sampleSpectrumSignal(analysis, timeSec, smoothing);
  const bands = features.bands;
  // Overlapping Gaussian averages preserve broad tonal differences without
  // turning individual FFT bins into corners or flickering narrow peaks.
  const contour = Array.from({ length: 13 }, (_, index) => {
    const centre = index / 12 * Math.max(0, bands.length - 1);
    const radius = Math.max(1.5, bands.length * .11);
    let total = 0; let weights = 0;
    for (let band = 0; band < bands.length; band++) {
      const distance = (band - centre) / radius;
      const weight = Math.exp(-.5 * distance * distance);
      total += unit(bands[band]) * weight; weights += weight;
    }
    return weights ? total / weights : 0;
  });
  // A rational shoulder continues to distinguish strong passages. Unlike a
  // hard clamp (or an early exponential ceiling), it does not create plateaus.
  const drive = unit(features.level) * gain * 2.2;
  const amplitude = halfHeight * .94 * drive / (.62 + drive);
  // All moving harmonics share this unwrapped phase, so there is no reset seam.
  // Zero flow freezes only the carrier: the contour still responds to music.
  const phase = timeSec * 2 * flowSpeed;
  const first: SpectrumWavePoint[] = []; const second: SpectrumWavePoint[] = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const position = u * (contour.length - 1); const low = Math.floor(position);
    const fraction = position - low; const smooth = fraction * fraction * (3 - 2 * fraction);
    const band = contour[low] * (1 - smooth) + contour[Math.min(low + 1, contour.length - 1)] * smooth;
    const taper = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 1.15);
    const spatialPhase = TAU * 2.15 * u;
    const theta = spatialPhase - phase;
    const carrier = .83 * Math.sin(theta + .1 * Math.sin(TAU * u - phase)) + .14 * Math.sin(2 * theta + .55);
    const follower = -.88 * Math.sin(theta + .34) + .1 * Math.sin(2 * theta - .7);
    const envelope = (.63 + band * .37) * taper;
    const x = -halfWidth + u * halfWidth * 2;
    const y = amplitude * envelope * carrier;
    first.push({ x, y });
    second.push({ x, y: amplitude * (.68 + band * .32) * taper * follower * (.78 + .12 * Math.cos(TAU * (u - .14))) });
  }
  return [first, second];
}

/** Inherits the scene's colour and opacity. Only two strokes, with no shadow or fill. */
export function drawDualSpectrumWave(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number, analysis: AudioAnalysis | null): void {
  const curves = sampleDualSpectrumWave(layer, timeSec, analysis);
  if (!curves[0].length) return;
  const yLimit = Math.max(0, (layer.height - lineWidth(layer)) / 2);
  ctx.save();
  try {
    ctx.lineWidth = lineWidth(layer); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.filter = 'none';
    for (const [index, points] of curves.entries()) {
      ctx.lineWidth = lineWidth(layer) * (index === 0 ? 1 : .72);
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
      for (let i = 0; i < points.length - 1; i++) {
        const previous = points[Math.max(0, i - 1)]; const current = points[i];
        const next = points[i + 1]; const after = points[Math.min(points.length - 1, i + 2)];
        // Catmull–Rom interpolation passes through samples; clamped control points
        // keep even tiny layers and maximum gain inside their stroke-safe bounds.
        ctx.bezierCurveTo(current.x + (next.x - previous.x) / 6,
          clamp(current.y + (next.y - previous.y) / 6, -yLimit, yLimit),
          next.x - (after.x - current.x) / 6,
          clamp(next.y - (after.y - current.y) / 6, -yLimit, yLimit), next.x, next.y);
      }
      ctx.stroke();
    }
  } finally { ctx.restore(); }
}
