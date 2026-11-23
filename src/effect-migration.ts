import type { Layer } from './types';
import { makeEffect, MAX_LAYER_EFFECTS } from './effects';

const styles: Record<string, number> = { fade: 0, 'fade-up': 1, 'fade-down': 2, 'fade-left': 3, 'fade-right': 4, 'fade-zoom': 5 };
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Upgrade a legacy built-in transition once. Full old stacks keep their legacy
 * painting path instead of discarding a transition or exceeding the stack cap. */
export function migrateLegacyFade(layer: Layer): Layer {
  if ((layer.effects?.length ?? 0) >= MAX_LAYER_EFFECTS) return layer;
  const params = { ...layer.params };
  let fadeIn = 0, fadeOut = 0, style = 0, timing = 0, distance = 24;
  if (layer.type === 'title' || layer.type === 'text') {
    if (!Object.hasOwn(styles, String(params.textTransition))) return layer;
    style = styles[String(params.textTransition)];
    fadeIn = fadeOut = clamp(finite(params.textTransitionDuration, .5), .05, 3);
    distance = clamp(finite(params.fontSize, 48) * .5, 8, 60);
    params.textTransition = 'none';
  } else if (layer.type === 'lyrics') {
    if (!Object.hasOwn(styles, String(params.transition))) return layer;
    style = styles[String(params.transition)]; timing = 1;
    fadeIn = fadeOut = clamp(finite(params.transitionDuration, .35), .05, 2);
    params.transition = 'none';
  } else if (layer.type === 'atmosphere') {
    fadeIn = clamp(finite(params.fadeIn, .4), 0, 3);
    fadeOut = clamp(finite(params.fadeOut, .4), 0, 3);
    if (fadeIn === 0 && fadeOut === 0) return layer;
    params.fadeIn = 0; params.fadeOut = 0;
  } else return layer;
  const effect = makeEffect('fade');
  effect.params = { ...effect.params, fadeIn, fadeOut, style, timing, distance };
  return { ...layer, params, effects: [...(layer.effects ?? []), effect] };
}
