import type { LayerEffect } from './types';

export interface FadeTransform { opacity: number; offsetX: number; offsetY: number; scale: number }
export interface FadeDurations { fadeIn: number; fadeOut: number }
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;

/** Both edges share one finite clip. Preserve their requested ratio on short clips. */
export function fadeDurations(effect: LayerEffect, start: number, end: number): FadeDurations {
  const fadeIn = number(effect.params.fadeIn, .5, 0, 10);
  const fadeOut = number(effect.params.fadeOut, .5, 0, 10);
  const span = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  const ratio = fadeIn + fadeOut > span ? span / (fadeIn + fadeOut) : 1;
  return { fadeIn: fadeIn * ratio, fadeOut: fadeOut * ratio };
}

export function fadeCurve(progress: number, curve = 0): number {
  const x = clamp(progress);
  return curve === 1 ? x : curve === 2 ? Math.sin(x * Math.PI / 2) : x * x * (3 - 2 * x);
}

/** Absolute song-time sample, shared by visual rendering and audio monitoring. */
export function fadeAtTime(effect: LayerEffect, start: number, end: number, time: number,
  _size?: { width: number; height: number }): FadeTransform {
  const state: FadeTransform = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1 };
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time) || end <= start || time < start || time >= end) {
    state.opacity = 0; return state;
  }
  if (effect.type !== 'fade' || effect.enabled === false) return state;
  const strength = number(effect.strength, 1, 0, 1);
  if (strength === 0) return state;
  const edges = fadeDurations(effect, start, end);
  const entering = edges.fadeIn > 0 && time < start + edges.fadeIn;
  const exiting = edges.fadeOut > 0 && time > end - edges.fadeOut;
  const progress = entering ? (time - start) / edges.fadeIn : exiting ? (end - time) / edges.fadeOut : 1;
  const hidden = (1 - fadeCurve(progress, number(effect.params.curve, 0, 0, 2))) * strength;
  state.opacity = 1 - hidden;
  const direction = entering ? 1 : -1;
  const distance = number(effect.params.distance, 24, 0, 200);
  const style = number(effect.params.style, 0, 0, 5);
  if (style === 1 || style === 2) state.offsetY = hidden * distance * direction * (style === 1 ? 1 : -1);
  else if (style === 3 || style === 4) state.offsetX = hidden * distance * direction * (style === 3 ? 1 : -1);
  else if (style === 5) state.scale = 1 - .06 * hidden;
  return state;
}

/** Monitoring volume is multiplied separately by the UI; mute always wins there. */
export function audioGainAtTime(effects: readonly LayerEffect[] | undefined, timeSec: number, audioEnd: number): number {
  if (!Number.isFinite(timeSec) || !Number.isFinite(audioEnd) || audioEnd <= 0 || timeSec < 0 || timeSec >= audioEnd) return 0;
  return (effects ?? []).reduce((gain, effect) => effect.type === 'fade'
    ? gain * fadeAtTime(effect, 0, audioEnd, timeSec).opacity : gain, 1);
}

/** Per-sample FFmpeg expression. Input seek timestamps are reset before adding the
 * absolute export offset, so partial exports never restart either edge. Only
 * generated numeric literals and known operators enter this expression. */
export function buildAudioFadeFilter(effects: readonly LayerEffect[] | undefined, startSec: number, audioEnd: number): string {
  const active = (effects ?? []).filter(effect => effect.type === 'fade' && effect.enabled !== false && effect.strength > 0);
  if (!active.length) return 'apad';
  const time = `(t+${startSec})`;
  const curve = (x: string, mode: number): string => mode === 1 ? x : mode === 2 ? `sin((${x})*PI/2)` : `((${x})*(${x})*(3-2*(${x})))`;
  const envelope = active.map(effect => {
    const { fadeIn, fadeOut } = fadeDurations(effect, 0, audioEnd);
    const mode = number(effect.params.curve, 0, 0, 2);
    const incoming = fadeIn > 0 ? curve(`clip(${time}/${fadeIn},0,1)`, mode) : '1';
    const outgoing = fadeOut > 0 ? curve(`clip((${audioEnd}-${time})/${fadeOut},0,1)`, mode) : '1';
    const gain = `min(${incoming},${outgoing})`;
    const strength = number(effect.strength, 1, 0, 1);
    return `(1-${strength}+${strength}*(${gain}))`;
  }).join('*');
  // Imported music is normalized to stereo. aeval evaluates t for every sample,
  // unlike volume eval=frame, whose gain would visibly step at audio block edges.
  const gain = `if(lt(${time},${audioEnd}),${envelope},0)`;
  // aeval can emit an unspecified two-channel layout even with c=stereo on
  // recent FFmpeg builds; name it explicitly before negotiating AAC output.
  return `asetpts=PTS-STARTPTS,aeval=exprs='val(0)*(${gain})|val(1)*(${gain})':c=stereo,aformat=channel_layouts=stereo,apad`;
}
