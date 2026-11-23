import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionDuration, type DawClip, type DawSession } from './model';
import { clipEffectTarget, denoiseModes, getEffectChain, resolveEffectTarget, validateEffectChain } from './effects';
import type { DawEffect, DawEffectTarget } from './effects';
import type { EffectMeterReadings, MatchEqInput, MatchEqResult, NoiseSelectionPreview } from './effects-view';
import type { EffectComparison } from './effect-comparison';
import type { MatchReferenceId } from './services';

export const EFFECT_WINDOW_PROTOCOL = 'visiki-fx-v1' as const;
export const effectWindowChannel = (owner: string) => `visiki-fx-${owner}`;
export interface EffectWindowSnapshot {
  effect: DawEffect; ownerName: string; sidechainTracks: { id: string; name: string }[]; tempoBpm: number; sampleRate: number; canUndo: boolean; canRedo: boolean;
  readings?: EffectMeterReadings; transportAvailable: boolean; resetMetersAvailable?: boolean; comparison?: EffectComparison;
  noise?: { start: number; end: number; preview?: NoiseSelectionPreview; learning?: boolean; message?: string; listening: boolean };
  matchEq?: MatchEqInput;
}
export interface EffectWindowMessage {
  protocol: typeof EFFECT_WINDOW_PROTOCOL; kind: 'ready' | 'snapshot' | 'meters' | 'change' | 'begin' | 'commit' | 'undo' | 'redo' | 'transport' | 'resetMeters' | 'compare' | 'learnNoise' | 'listenNoise' | 'matchEq' | 'auditionMatch' | 'closed' | 'close' | 'error';
  target: string; id: string; client?: string; snapshot?: EffectWindowSnapshot; effect?: DawEffect;
  readings?: EffectMeterReadings; error?: string;
  noiseRange?: { start: number; duration: number };
  matchClips?: { sourceTarget: string; reference: MatchReferenceId };
}
export interface DawEffectWindowsOptions {
  session: DawSession; canUndo: boolean; canRedo: boolean;
  onChange: (target: DawEffectTarget, id: string, next: DawEffect) => void;
  onBeginGesture: () => void; onCommitGesture: () => void; onUndo: () => void; onRedo: () => void;
  onReadings?: (id: string) => EffectMeterReadings | undefined; onTransport?: () => void; onResetMeters?: () => void;
  comparison?: EffectComparison; onToggleComparison: (id: string) => void; onCloseComparison: (id: string) => void;
  noiseLearning?: { id: string; pending?: boolean; message?: string };
  noiseListenId?: string;
  getNoiseStart?: (target: string) => number;
  onLearnNoise?: (target: string, effectId: string, start: number, duration: number) => void;
  onToggleNoise?: (id: string) => void;
  onCloseNoise?: (id: string) => void;
  matchResult?: MatchEqAnalysis;
  onAnalyzeMatch?: (target: string, id: string, sourceTarget: string, reference: MatchReferenceId) => void;
  onAuditionMatch?: () => void;
  transportPlaying?: boolean;
  monitorDb?: number;
}
interface OpenEffectWindow { target: string; id: string; client?: string; browser?: Window }
const windowKey = (target: string, id: string) => `${target}:${id}`;
const getEffect = (session: DawSession, target: string, id: string) => {
  try { return getEffectChain(session, target).find(effect => effect.id === id); } catch { return undefined; }
};
const getReadings = (state: DawEffectWindowsOptions, id: string) => {
  const readings = state.onReadings?.(id);
  return readings ? { sampleRate: state.session.sampleRate, spectrumMaxHz: state.session.sampleRate / 2, ...readings } : undefined;
};

export function effectTargetName(session: DawSession, target: string): string {
  const resolved = resolveEffectTarget(session, target);
  return !resolved ? '已移除的目标' : resolved.kind === 'master' ? '主输出' : resolved.kind === 'track' ? `轨道：${resolved.track.name}` : `片段：${resolved.clip.name}（${resolved.track.name}）`;
}

export function getSidechainTracks(session: DawSession, target: string): { id: string; name: string }[] {
  const resolved = resolveEffectTarget(session, target);
  if (!resolved) return [];
  return session.tracks.filter(track => resolved.kind === 'master' || track.id !== resolved.track.id).map(track => ({ id: track.id, name: track.name }));
}

export type MatchEqAnalysis = MatchEqResult & { revision: string };
export function matchEqRevision(session: DawSession, sourceTarget: string, reference: MatchReferenceId): string {
  const owner = resolveEffectTarget(session, sourceTarget);
  const key = (clip?: DawClip) => clip && [clip.id, clip.assetId, clip.sourceIn, clip.duration];
  const source = owner?.kind === 'clip' ? key(owner.clip) : (owner?.kind === 'track' ? [owner.track] : session.tracks)
    .map(track => [track.id, track.volumeDb, owner?.kind === 'master' && [track.muted, track.solo],
      track.clips.map(clip => [key(clip), clip.start, clip.gainDb])]);
  const ref = reference.kind === 'clip' ? key(session.tracks.flatMap(track => track.clips).find(clip => clip.id === reference.id)) : reference.id;
  return JSON.stringify([session.id, source, ref]);
}

export function makeMatchEqInput(session: DawSession, target: string, id: string, analysis?: MatchEqAnalysis): MatchEqInput {
  const resolved = resolveEffectTarget(session, target);
  const label = (name: string, clip: DawClip) => `${name} / ${clip.name} · ${clip.start.toFixed(2)} 秒`;
  const references = session.tracks.flatMap(track => track.clips.map(clip => ({
    kind: 'clip' as const, id: clip.id, assetId: clip.assetId, name: label(track.name, clip), start: clip.sourceIn, duration: clip.duration,
  })));
  const ownerClips = !resolved ? [] : resolved.kind === 'clip' ? [resolved.clip]
    : (resolved.kind === 'track' ? [resolved.track] : session.tracks).flatMap(track => track.clips);
  const ownerIds = new Set(ownerClips.map(clip => clip.id));
  const sources = resolved?.kind !== 'clip' ? references.filter(ref => ownerIds.has(ref.id))
    .map(ref => ({ target: clipEffectTarget(ref.id), name: ref.name })) : [];
  const result = analysis?.id === id && analysis.revision === matchEqRevision(session, analysis.sourceTarget, analysis.reference)
    ? { id, sourceTarget: analysis.sourceTarget, reference: analysis.reference, pending: analysis.pending, message: analysis.message, gains: analysis.gains } : undefined;
  return { sessionId: session.id, owner: { target, name: effectTargetName(session, target), hasAudio: !!ownerClips.length }, sources, references, result };
}

export function getNoiseBounds(session: DawSession, target: string): { start: number; end: number } {
  const resolved = resolveEffectTarget(session, target);
  return resolved?.kind === 'clip' ? { start: resolved.clip.start, end: resolved.clip.start + resolved.clip.duration } : { start: 0, end: sessionDuration(session) };
}

export function makeNoiseSelectionPreview(session: DawSession, target: string, position: number): NoiseSelectionPreview | undefined {
  const resolved = resolveEffectTarget(session, target);
  if (!resolved) return;
  const bounds = getNoiseBounds(session, target), duration = bounds.end - bounds.start;
  if (duration <= 0) return;
  const span = Math.min(8, duration);
  const start = Math.max(bounds.start, Math.min(position - span / 3, bounds.end - span));
  const end = start + span, peaks = Array<number>(120).fill(0);
  const assets = new Map(session.assets.map(asset => [asset.id, asset]));
  const solo = session.tracks.some(track => track.solo);
  for (const track of session.tracks) {
    if (resolved.kind !== 'master' && track.id !== resolved.track.id || track.muted || solo && !track.solo) continue;
    for (const clip of track.clips) {
      if (resolved.kind === 'clip' && clip.id !== resolved.clip.id) continue;
      if (clip.start >= end || clip.start + clip.duration <= start) continue;
      const asset = assets.get(clip.assetId);
      if (!asset?.peaks.length || !(asset.peakHopSec > 0)) continue;
      const gain = 10 ** (clip.gainDb / 20);
      for (let i = 0; i < peaks.length; i++) {
        const low = Math.max(clip.start, start + span * i / peaks.length);
        const high = Math.min(clip.start + clip.duration, start + span * (i + 1) / peaks.length);
        if (high <= low) continue;
        const first = Math.floor((low - clip.start + clip.sourceIn) / asset.peakHopSec);
        const last = Math.ceil((high - clip.start + clip.sourceIn) / asset.peakHopSec);
        for (const channel of asset.peaks) {
          for (let j = Math.max(0, first); j < Math.min(last, channel.max.length); j++) {
            peaks[i] = Math.max(peaks[i], gain * Math.max(Math.abs(channel.min[j]), Math.abs(channel.max[j])));
          }
        }
      }
    }
  }
  return { start, end, peaks, lowerBound: bounds.start };
}

/** One parent owns the document and audio engine. Child windows only send editing intents. */
export function useDawEffectWindows(options: DawEffectWindowsOptions): { open: (target: DawEffectTarget, id: string) => boolean } {
  const [owner] = useState(() => globalThis.crypto.randomUUID());
  const latest = useRef(options); latest.current = options;
  const channel = useRef<BroadcastChannel | null>(null);
  const windows = useRef(new Map<string, OpenEffectWindow>());
  const gestures = useRef(new Set<string>());
  const post = useCallback((message: EffectWindowMessage) => { try { channel.current?.postMessage(message); } catch { /* Closing a parent is allowed during an outstanding update. */ } }, []);
  const snapshot = useCallback((entry: OpenEffectWindow) => {
    const state = latest.current, effect = getEffect(state.session, entry.target, entry.id);
    if (!effect) { post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'close', target: entry.target, id: entry.id, client: entry.client }); return; }
    const ownerName = effectTargetName(state.session, entry.target);
    const noiseStart = effect.type === 'denoise' ? state.getNoiseStart?.(entry.target) ?? 0 : 0;
    post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'snapshot', target: entry.target, id: entry.id, client: entry.client, snapshot: {
      effect, ownerName, sidechainTracks: getSidechainTracks(state.session, entry.target), tempoBpm: state.session.musicalGrid?.bpm ?? 120, sampleRate: state.session.sampleRate, canUndo: state.canUndo, canRedo: state.canRedo,
      readings: getReadings(state, entry.id), transportAvailable: !!state.onTransport, resetMetersAvailable: !!state.onResetMeters,
      comparison: state.comparison?.effectId === entry.id ? state.comparison : undefined,
      matchEq: effect.type === 'eq' && state.onAnalyzeMatch ? { ...makeMatchEqInput(state.session, entry.target, effect.id, state.matchResult),
        transportPlaying: state.transportPlaying, monitorDb: state.monitorDb } : undefined,
      noise: effect.type === 'denoise' && state.onLearnNoise ? {
        start: noiseStart, end: getNoiseBounds(state.session, entry.target).end, preview: denoiseModes(effect.params).spectralEnabled ? makeNoiseSelectionPreview(state.session, entry.target, noiseStart) : undefined,
        learning: state.noiseLearning?.id === entry.id && state.noiseLearning.pending,
        message: state.noiseLearning?.id === entry.id ? state.noiseLearning.message : undefined,
        listening: state.noiseListenId === entry.id,
      } : undefined,
    } });
  }, [post]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const connection = new BroadcastChannel(effectWindowChannel(owner)); channel.current = connection;
    const finishGesture = (client: string) => { if (gestures.current.delete(client) && !gestures.current.size) latest.current.onCommitGesture(); };
    connection.onmessage = event => {
      const message = event.data as EffectWindowMessage;
      if (!message || message.protocol !== EFFECT_WINDOW_PROTOCOL || typeof message.target !== 'string' || typeof message.id !== 'string' || typeof message.client !== 'string') return;
      const key = windowKey(message.target, message.id), entry = windows.current.get(key);
      if (!entry) return;
      if (message.kind === 'ready') { entry.client = message.client; snapshot(entry); return; }
      if (entry.client !== message.client) return;
      const effect = getEffect(latest.current.session, entry.target, entry.id);
      if (!effect) { snapshot(entry); return; }
      if (message.kind === 'begin') { if (!gestures.current.size) latest.current.onBeginGesture(); gestures.current.add(message.client); }
      else if (message.kind === 'commit') finishGesture(message.client);
      else if (message.kind === 'closed') { finishGesture(message.client); latest.current.onCloseComparison(entry.id); latest.current.onCloseNoise?.(entry.id); windows.current.delete(key); }
      else if (message.kind === 'undo') { finishGesture(message.client); latest.current.onUndo(); }
      else if (message.kind === 'redo') { finishGesture(message.client); latest.current.onRedo(); }
      else if (message.kind === 'transport') latest.current.onTransport?.();
      else if (message.kind === 'resetMeters') latest.current.onResetMeters?.();
      else if (message.kind === 'compare') latest.current.onToggleComparison(entry.id);
      else if (message.kind === 'learnNoise' && effect.type === 'denoise' && message.noiseRange) {
        finishGesture(message.client);
        latest.current.onLearnNoise?.(entry.target, entry.id, message.noiseRange.start, message.noiseRange.duration);
      }
      else if (message.kind === 'listenNoise' && effect.type === 'denoise') latest.current.onToggleNoise?.(entry.id);
      else if (message.kind === 'matchEq' && effect.type === 'eq' && typeof message.matchClips?.sourceTarget === 'string' &&
        typeof message.matchClips.reference?.id === 'string' && ['clip', 'asset'].includes(message.matchClips.reference.kind)) {
        finishGesture(message.client);
        latest.current.onAnalyzeMatch?.(entry.target, entry.id, message.matchClips.sourceTarget, message.matchClips.reference);
      }
      else if (message.kind === 'auditionMatch' && effect.type === 'eq') latest.current.onAuditionMatch?.();
      else if (message.kind === 'change') {
        const next = message.effect;
        if (!next || next.id !== effect.id || next.type !== effect.type || validateEffectChain([next]).length) { post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'error', target: entry.target, id: entry.id, client: entry.client, error: '效果参数无效，已保留工程中的设置。' }); snapshot(entry); return; }
        try { latest.current.onChange(entry.target, entry.id, next); }
        catch (error) { post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'error', target: entry.target, id: entry.id, client: entry.client, error: error instanceof Error ? error.message : '无法更新效果参数' }); snapshot(entry); }
      }
    };
    const timer = window.setInterval(() => {
      for (const [key, entry] of windows.current) {
        if (entry.browser?.closed) { if (entry.client) finishGesture(entry.client); latest.current.onCloseComparison(entry.id); latest.current.onCloseNoise?.(entry.id); windows.current.delete(key); continue; }
        if (entry.client) post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'meters', target: entry.target, id: entry.id, client: entry.client, readings: getReadings(latest.current, entry.id) });
      }
    }, 1000 / 24);
    const closeAll = () => { for (const entry of windows.current.values()) post({ protocol: EFFECT_WINDOW_PROTOCOL, kind: 'close', target: entry.target, id: entry.id, client: entry.client }); };
    window.addEventListener('beforeunload', closeAll);
    return () => {
      window.clearInterval(timer); window.removeEventListener('beforeunload', closeAll); closeAll();
      if (gestures.current.size) latest.current.onCommitGesture(); gestures.current.clear(); windows.current.clear(); connection.close();
      if (channel.current === connection) channel.current = null;
    };
  }, [owner, snapshot, post]);
  useEffect(() => { for (const entry of windows.current.values()) if (entry.client) snapshot(entry); }, [options.session, options.canUndo, options.canRedo, options.comparison, options.noiseLearning, options.noiseListenId, options.matchResult, options.transportPlaying, options.monitorDb, snapshot]);
  const open = useCallback((target: DawEffectTarget, id: string) => {
    const effect = getEffect(latest.current.session, target, id);
    if (!effect || !channel.current) return false;
    const key = windowKey(target, id), previous = windows.current.get(key);
    if (previous?.browser && !previous.browser.closed) { previous.browser.focus(); snapshot(previous); return true; }
    const url = new URL(window.location.href);
    url.search = ''; url.hash = ''; url.searchParams.set('visikiEffect', '1'); url.searchParams.set('owner', owner); url.searchParams.set('target', target); url.searchParams.set('effect', id);
    const entry: OpenEffectWindow = { target, id };
    windows.current.set(key, entry);
    const desktop = (window as Window & { visikiDesktop?: { openEffect?: (options: { url: string; key: string }) => void } }).visikiDesktop;
    try {
      if (typeof desktop?.openEffect === 'function') { desktop.openEffect({ url: url.toString(), key: `${owner}:${key}` }); return true; }
      const browser = window.open(url.toString(), `visiki-fx-${owner}-${key}`, 'popup=yes,width=820,height=750,resizable=yes,scrollbars=yes');
      if (!browser) { windows.current.delete(key); return false; }
      entry.browser = browser; return true;
    } catch { windows.current.delete(key); return false; }
  }, [owner, snapshot]);
  return { open };
}
