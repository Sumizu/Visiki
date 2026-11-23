import type { Layer } from './types';

export const TEXT_TRANSITIONS = ['none', 'fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'fade-zoom'] as const;
export type TextTransition = typeof TEXT_TRANSITIONS[number];
export const MIN_TEXT_TRANSITION_DURATION = .05;
export const MAX_TEXT_TRANSITION_DURATION = 3;
export const DEFAULT_TEXT_TRANSITION_DURATION = .5;

export interface TextTransitionState {
  mode: TextTransition;
  /** Effective seconds for each edge; shortened to half of a short clip. */
  duration: number;
  opacity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (value: number): number => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };

/** A pure timeline sample. Seeking, preview and export all use song seconds,
 * never wall-clock time or the number of frames already rendered. Missing
 * settings preserve the exact static rendering path of existing projects. */
export function textTransitionAtTime(layer: Pick<Layer, 'params' | 'start' | 'end'>, timeSec: number): TextTransitionState {
  const rawMode = layer.params.textTransition;
  const mode: TextTransition = TEXT_TRANSITIONS.includes(rawMode as TextTransition) ? rawMode as TextTransition : 'none';
  const rawDuration = layer.params.textTransitionDuration;
  const requestedDuration = typeof rawDuration === 'number' && Number.isFinite(rawDuration)
    ? clamp(rawDuration, MIN_TEXT_TRANSITION_DURATION, MAX_TEXT_TRANSITION_DURATION) : DEFAULT_TEXT_TRANSITION_DURATION;
  const span = layer.end - layer.start;
  const duration = Number.isFinite(span) && span > 0 ? Math.min(requestedDuration, span / 2) : 0;
  const state: TextTransitionState = { mode, duration, opacity: 1, offsetX: 0, offsetY: 0, scale: 1 };
  if (mode === 'none') return state;
  if (!Number.isFinite(timeSec) || !Number.isFinite(layer.start) || !Number.isFinite(layer.end) || duration <= 0) {
    state.opacity = 0;
    return state;
  }
  const entering = timeSec - layer.start < duration;
  const progress = entering ? (timeSec - layer.start) / duration : (layer.end - timeSec) / duration;
  state.opacity = smoothstep(progress);
  const hidden = 1 - state.opacity;
  const rawSize = layer.params.fontSize;
  const fallbackSize = 48;
  const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? rawSize : fallbackSize;
  const distance = clamp(size * .5, 8, 60);
  // Direction names describe travel. The same motion continues through the
  // exit, so an upward entrance leaves upward rather than snapping backward.
  const movement = hidden * distance * (entering ? 1 : -1);
  if (mode === 'fade-up') state.offsetY = movement;
  else if (mode === 'fade-down') state.offsetY = -movement;
  else if (mode === 'fade-left') state.offsetX = movement;
  else if (mode === 'fade-right') state.offsetX = -movement;
  else if (mode === 'fade-zoom') state.scale = 1 - .06 * hidden;
  return state;
}

/** Apply one transition to the whole title/text group, including its glow.
 * The caller paints the editor selection after this scoped transform. */
export function withTextTransition(ctx: CanvasRenderingContext2D, layer: Pick<Layer, 'params' | 'start' | 'end'>,
  timeSec: number, paint: () => void): void {
  const state = textTransitionAtTime(layer, timeSec);
  if (state.opacity <= 0) return;
  if (state.opacity === 1 && state.offsetX === 0 && state.offsetY === 0 && state.scale === 1) {
    paint();
    return;
  }
  ctx.save();
  try {
    ctx.globalAlpha *= state.opacity;
    if (state.offsetX !== 0 || state.offsetY !== 0) ctx.translate(state.offsetX, state.offsetY);
    if (state.scale !== 1) ctx.scale(state.scale, state.scale);
    paint();
  } finally { ctx.restore(); }
}
