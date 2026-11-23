import type { DawEffect } from './effects';
import { denoiseModes, DENOISE_SWITCHES } from './effects';
import type { DawClip, DawSession } from './model';

export interface NativeMix {
  masterDb?: number;
  bpm?: number;
  masterEffects?: DawEffect[];
  tracks: { id: string; volumeDb: number; pan: number; effects?: DawEffect[]; clipEffects?: { id: string; effects: DawEffect[] }[] }[];
}

export function sameClipAudio(a: DawClip, b: DawClip): boolean {
  return a === b || a.id === b.id && a.assetId === b.assetId && a.start === b.start &&
    a.sourceIn === b.sourceIn && a.duration === b.duration && a.gainDb === b.gainDb &&
    a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut && a.envelope === b.envelope;
}

export function sameNativeLayout(before: readonly DawEffect[] = [], after: readonly DawEffect[] = []): boolean {
  return before.length === after.length && before.every((effect, index) => {
    const next = after[index];
    if (effect.id !== next.id || effect.type !== next.type || effect.enabled !== next.enabled) return false;
    if (effect.type === 'vst3') return effect.vst3?.classId === next.vst3?.classId;
    if (!effect.enabled) return true;
    if (effect.type === 'limiter') return effect.params.lookaheadMs === next.params.lookaheadMs && (effect.params.truePeak ?? 0) === (next.params.truePeak ?? 0);
    if (effect.type === 'saturation') return effect.params.oversample === next.params.oversample;
    if (effect.type === 'convolution') return (effect.params.space ?? 0) === (next.params.space ?? 0);
    if (effect.type === 'lofi') return effect.params.style === next.params.style;
    if (effect.type === 'pedal') return effect.params.mode === next.params.mode && effect.params.oversample === next.params.oversample;
    if (effect.type === 'ducker') return (effect.params.mode === 2) === (next.params.mode === 2);
    if (effect.type === 'denoise') {
      const previousModes = denoiseModes(effect.params), nextModes = denoiseModes(next.params);
      return DENOISE_SWITCHES.every(key => previousModes[key] === nextModes[key]) &&
        (!previousModes.spectralEnabled || !!effect.noiseProfile === !!next.noiseProfile);
    }
    if (effect.type === 'modulation') return ['mode', 'stages', 'waveform', 'sync'].every(key => effect.params[key] === next.params[key])
      && (!effect.params.sync || effect.params.note === next.params.note);
    return true;
  });
}

export function nativeMixDelta(before: DawSession, after: DawSession): NativeMix | undefined {
  if (before.id !== after.id || before.sampleRate !== after.sampleRate || before.assets !== after.assets || before.tracks.length !== after.tracks.length) return;
  const gridChanged = before.musicalGrid?.bpm !== after.musicalGrid?.bpm || before.musicalGrid?.beatsPerBar !== after.musicalGrid?.beatsPerBar || before.musicalGrid?.beatUnit !== after.musicalGrid?.beatUnit;
  if (gridChanged && [after.masterEffects, ...after.tracks.flatMap(track => [track.effects, ...track.clips.map(clip => clip.effects)])].some(chain =>
    chain?.some(effect => effect.enabled && effect.type === 'modulation' && effect.params.sync))) return;
  if (!sameNativeLayout(before.masterEffects, after.masterEffects)) return;
  const mix: NativeMix = { tracks: [] };
  if (before.masterDb !== after.masterDb) mix.masterDb = after.masterDb;
  if (before.masterEffects !== after.masterEffects) mix.masterEffects = after.masterEffects ?? [];
  if (before.musicalGrid?.bpm !== after.musicalGrid?.bpm) mix.bpm = after.musicalGrid?.bpm ?? 120;
  for (const [index, track] of after.tracks.entries()) {
    const previous = before.tracks[index];
    if (previous === track) continue;
    if (previous.id !== track.id || previous.muted !== track.muted || previous.solo !== track.solo || !sameNativeLayout(previous.effects, track.effects)) return;
    const clipEffects: NonNullable<NativeMix['tracks'][number]['clipEffects']> = [];
    if (previous.clips !== track.clips) {
      if (previous.clips.length !== track.clips.length) return;
      for (const [index, clip] of track.clips.entries()) {
        const old = previous.clips[index];
        if (old === clip) continue;
        if (!sameClipAudio(old, clip) || !sameNativeLayout(old.effects, clip.effects)) return;
        if (old.effects !== clip.effects) clipEffects.push({ id: clip.id, effects: clip.effects ?? [] });
      }
    }
    if (previous.volumeDb !== track.volumeDb || previous.pan !== track.pan || previous.effects !== track.effects || clipEffects.length) {
      mix.tracks.push({ id: track.id, volumeDb: track.volumeDb, pan: track.pan,
        ...(previous.effects !== track.effects ? { effects: track.effects ?? [] } : {}),
        ...(clipEffects.length ? { clipEffects } : {}),
      });
    }
  }
  return mix;
}
