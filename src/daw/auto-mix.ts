import { addEffect, bypassEnabledEffects, getAutoMixEffectName, getEffectChain, getEffectDefinition, remainingDawEffectSlots, resolveEffectTarget, type DawEffectType } from './effects';
import { serializeSession, updateTrack, type DawSession } from './model';

export interface AutoMixRange { start: number; end: number }
export interface AutoMixSection extends AutoMixRange {
  id: string; kind: 'lead' | 'harmony' | 'handoff' | 'backing' | 'ending'; label: string;
}
export interface AutoMixDelivery {
  mode: 'preserve' | 'peak' | 'custom'; ceilingDb: number; targetLufs: number;
}
export interface AutoMixOptions {
  roles: { lead: string; harmony?: string; backing: string };
  harmony: 'support' | 'duet' | 'mixed';
  direction: 'blended' | 'natural' | 'forward';
  genre: 'none' | 'pop' | 'rock' | 'acoustic';
  space: 'unchanged' | 'room' | 'plate';
  spaceAmount: number;
  handoffs?: AutoMixRange[];
  delivery?: AutoMixDelivery;
  excludedChangeIds?: string[];
}

interface ChangeDescription { id: string; label: string; reason: string; target: string }
export type AutoMixChange = ChangeDescription & (
  { kind: 'fader'; deltaDb: number } |
  { kind: 'effect'; type: DawEffectType; params: Record<string, number>; sidechainTrackId?: string; noiseProfile?: number[] } |
  { kind: 'outputGain'; target: 'master'; deltaDb: number }
);
export interface AutoMixLevel { integrated: number | null; truePeak: number | null }
export interface AutoMixPlan {
  changes: AutoMixChange[]; sections: AutoMixSection[]; handoffs: AutoMixRange[]; notes: string[];
  output: AutoMixLevel;
  proposedOutput?: AutoMixLevel & { limitingDb?: number };
}
export interface AutoMixFrame {
  time: number; duration: number; rmsDb: number; peakDb: number; kDb: number;
  bandsDb: number[]; detectorDb?: number; keyBandsPeakDb?: number[]; keyRmsDb?: number;
  sibilance?: { ratioDb: number; envelopeDb: number }[];
  stereo?: { leftDb: number; rightDb: number; correlation: number };
}
export interface AutoMixProbe { maxDb: number; p90Db: number; activeFraction: number; frames?: number[]; levelLossDb?: number | null }
export interface AutoMixScan {
  complete: boolean; hopSec: number;
  tracks: { id: string; frames: AutoMixFrame[] }[];
  output: AutoMixLevel; probes?: Record<string, AutoMixProbe>;
}

export const DEFAULT_AUTO_MIX_DELIVERY: AutoMixDelivery = { mode: 'preserve', ceilingDb: -1, targetLufs: -14 };
export function defaultAutoMixOptions(session: DawSession): AutoMixOptions {
  const tracks = session.tracks.filter(track => !track.muted && track.clips.length);
  const roles: AutoMixOptions['roles'] = { lead: '', backing: '' };
  const patterns = {
    backing: /伴奏|karaoke|backing\s*track|instrumental|(?:^|[\s_-])inst(?:[\s_.-]|$)|オフボーカル/i,
    harmony: /和声|伴唱|合唱|harmony|choir|background\s*vocals?|backing\s*vocals?|(?:^|[\s_-])b[gv]v?s?(?:[\s_.-]|$)|コーラス/i,
    lead: /主唱|干声|主音|人声|lead|vocals?|歌声|メイン/i,
  };
  for (const role of ['backing', 'harmony', 'lead'] as const) {
    const unused = tracks.filter(track => !Object.values(roles).includes(track.id));
    const matches = unused.filter(track => patterns[role].test(track.name));
    if (matches.length === 1) roles[role] = matches[0].id;
  }
  const unmatched = tracks.filter(track => !Object.values(roles).includes(track.id));
  const vacant = (['lead', 'backing'] as const).filter(role => !roles[role]);
  if (unmatched.length === 1 && vacant.length === 1) roles[vacant[0]] = unmatched[0].id;
  return { roles, harmony: 'support', direction: 'natural', genre: 'none',
    space: 'room', spaceAmount: 25, delivery: { ...DEFAULT_AUTO_MIX_DELIVERY } };
}

export const isBalanceChange = (change: AutoMixChange) => change.kind === 'fader';

export function countAutoMixBypassedEffects(session: DawSession): number {
  return [session.masterEffects, ...session.tracks.map(track => track.effects)]
    .reduce((total, chain) => total + (chain?.filter(effect => effect.enabled).length ?? 0), 0);
}

export function bypassAutoMixInserts(session: DawSession): DawSession {
  const masterEffects = bypassEnabledEffects(session.masterEffects);
  const tracks = session.tracks.map(track => {
    const effects = bypassEnabledEffects(track.effects);
    return effects ? { ...track, effects } : track;
  });
  return masterEffects || tracks.some((track, index) => track !== session.tracks[index])
    ? { ...session, tracks, ...(masterEffects ? { masterEffects } : {}) } : session;
}

/** Proposal IDs stay stable for the result list. Each applied pass gets a fresh insert ID. */
export function autoMixEffectInstanceId(session: DawSession, proposalId: string): string {
  const existing = new Set([...session.masterEffects ?? [], ...session.tracks.flatMap(track =>
    [...track.effects ?? [], ...track.clips.flatMap(clip => clip.effects ?? [])])].map(effect => effect.id));
  if (!existing.has(proposalId)) return proposalId;
  let index = 2;
  while (existing.has(`${proposalId}-${index}`)) index++;
  return `${proposalId}-${index}`;
}

/** Shared by the analysis job, preview, and the single history entry on Apply. */
export function applyAutoMixPlan(session: DawSession, plan: AutoMixPlan, changeIds: ReadonlySet<string>): DawSession {
  let next = bypassAutoMixInserts(session);
  for (const change of plan.changes) {
    if (!changeIds.has(change.id)) continue;
    if (change.kind === 'fader') {
      const track = next.tracks.find(item => item.id === change.target);
      if (track && change.deltaDb) next = updateTrack(next, track.id, { volumeDb: track.volumeDb + change.deltaDb });
    } else {
      const target = resolveEffectTarget(next, change.target);
      if (!target || target.kind === 'clip') continue;
      const chain = getEffectChain(next, change.target);
      if (!remainingDawEffectSlots(chain)) continue;
      const type = change.kind === 'outputGain' ? 'stereo' : change.type;
      const definition = getEffectDefinition(type);
      const params = { ...definition.presets[0].params,
        ...(change.kind === 'outputGain' ? { gainDb: change.deltaDb } : change.params) };
      next = addEffect(next, change.target, {
        id: autoMixEffectInstanceId(session, change.id), type,
        name: getAutoMixEffectName(change.kind === 'outputGain' ? 'outputGain' : type),
        enabled: true, params,
        ...(change.kind === 'effect' && change.sidechainTrackId ? { sidechainTrackId: change.sidechainTrackId } : {}),
        ...(change.kind === 'effect' && change.type === 'denoise' && change.noiseProfile ? { noiseProfile: change.noiseProfile } : {}),
      });
    }
  }
  return next;
}

async function postAutoMix(route: string, session: DawSession, body: object, signal?: AbortSignal) {
  const response = await fetch(`/api/daw/auto-mix/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...body, session: JSON.parse(serializeSession(session)) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `自动混音请求失败 (${response.status})`);
  }
  return response;
}

export async function analyzeDawAutoMix(session: DawSession, options: AutoMixOptions, signal?: AbortSignal): Promise<AutoMixPlan> {
  return (await postAutoMix('analyze', session, { options }, signal)).json();
}

export async function previewDawAutoMix(session: DawSession, range: AutoMixRange, signal?: AbortSignal) {
  const response = await postAutoMix('preview', session, { range }, signal);
  const level = (header: string): number | null => {
    const value = response.headers.get(header);
    return value === null || !value.trim() || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  return { blob: await response.blob(), integrated: level('X-Visiki-LUFS'), truePeak: level('X-Visiki-True-Peak') };
}
