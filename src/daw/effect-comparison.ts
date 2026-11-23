import { getEffectDefaultParams, type DawEffect } from './effects';
import type { DawSession } from './model';
import { sameClipAudio } from './native-mix';

export interface EffectComparison {
  effectId: string;
  status: 'measuring' | 'ready';
  start?: number;
  end?: number;
  aLufs?: number;
  bLufs?: number;
  trimDb?: number;
}

export function comparisonTrim(slot: 'A' | 'B', a: number, b: number) {
  return Math.max(-60, Math.min(a, b) - (slot === 'A' ? a : b));
}

function paramsEqual(a: Record<string, number>, b: Record<string, number>) {
  return a === b || Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

function slots(effect: DawEffect) {
  const defaults = effect.type === 'vst3' ? {} : getEffectDefaultParams(effect.type);
  const active = { params: { ...defaults, ...effect.params }, profile: effect.noiseProfile, source: effect.sidechainTrackId };
  const inactive = { params: { ...defaults, ...effect.bState }, profile: effect.bNoiseProfile, source: effect.bSidechainTrackId };
  return effect.abSlot === 'B' ? [inactive, active] : [active, inactive];
}
function profilesEqual(a: number[] | undefined, b: number[] | undefined) {
  return a === b || !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The level match is valid only for these two settings in the same mix. */
export function comparisonMatches(before: DawSession, after: DawSession, effectId: string): boolean {
  if (before === after) return true;
  if (before.id !== after.id || before.sampleRate !== after.sampleRate || before.assets !== after.assets || before.masterDb !== after.masterDb ||
      before.musicalGrid?.bpm !== after.musicalGrid?.bpm || before.musicalGrid?.beatsPerBar !== after.musicalGrid?.beatsPerBar ||
      before.musicalGrid?.beatUnit !== after.musicalGrid?.beatUnit || before.tracks.length !== after.tracks.length) return false;
  const sameChain = (first: readonly DawEffect[] = [], next: readonly DawEffect[] = []) =>
    first === next || first.length === next.length && first.every((effect, index) => {
      const other = next[index];
      if (effect === other) return true;
      if (effect.id !== other.id || effect.type !== other.type || effect.enabled !== other.enabled) return false;
      if (effect.id !== effectId) return paramsEqual(effect.params, other.params) && profilesEqual(effect.noiseProfile, other.noiseProfile) &&
        effect.sidechainTrackId === other.sidechainTrackId;
      if (!effect.bState || !other.bState) return false;
      const a = slots(effect), b = slots(other);
      return a.every((slot, index) => paramsEqual(slot.params, b[index].params) && profilesEqual(slot.profile, b[index].profile) &&
        slot.source === b[index].source);
    });
  return sameChain(before.masterEffects, after.masterEffects) && before.tracks.every((track, index) => {
    const other = after.tracks[index];
    return track === other || track.id === other.id && (track.clips === other.clips ||
      track.clips.length === other.clips.length && track.clips.every((clip, i) => sameClipAudio(clip, other.clips[i]) && sameChain(clip.effects, other.clips[i].effects))) &&
      track.volumeDb === other.volumeDb &&
      track.pan === other.pan && track.muted === other.muted && track.solo === other.solo && sameChain(track.effects, other.effects);
  });
}

export function findComparisonEffect(session: DawSession, effectId: string) {
  return session.masterEffects?.find(effect => effect.id === effectId) ??
    session.tracks.flatMap(track => [...track.effects ?? [], ...track.clips.flatMap(clip => clip.effects ?? [])]).find(effect => effect.id === effectId);
}
