import type { DawAsset, DawSession } from './model';
import { parseSession, serializeSession } from './model';
import type { DawRhythmAnalysis } from './rhythm-analysis';
import type { MediaAsset } from '../types';

async function result<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({ error: `服务返回 ${response.status}` }));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

export async function importDawAudio(file: File, signal?: AbortSignal): Promise<DawAsset> {
  const form = new FormData(); form.append('file', file);
  return result<DawAsset>(await fetch('/api/daw/assets', { method: 'POST', body: form, signal }));
}

export async function loadDawAsset(id: string, signal?: AbortSignal, summary = false): Promise<DawAsset> {
  const response = await fetch(`/api/daw/assets/${encodeURIComponent(id)}/metadata${summary ? '?summary=1' : ''}`, { signal });
  return result<DawAsset>(response);
}

export interface DawRhythmResult extends DawRhythmAnalysis { assetId: string; start: number; cached: boolean }
export async function analyzeDawAudioRhythm(source: { assetId: string; start?: number; duration?: number }, signal?: AbortSignal): Promise<DawRhythmResult> {
  return result<DawRhythmResult>(await fetch('/api/daw/analyze-rhythm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source), signal,
  }));
}

/** Session files contain local asset identities, not embedded PCM or waveform arrays. */
export async function hydrateDawSession(session: DawSession, signal?: AbortSignal): Promise<{ session: DawSession; missing: string[] }> {
  const missing: string[] = [];
  const assets: DawAsset[] = [];
  for (const source of session.assets) {
    signal?.throwIfAborted();
    const response = await fetch(`/api/daw/assets/${encodeURIComponent(source.id)}/metadata`, { signal });
    if (response.status === 404) { missing.push(source.name); assets.push({ ...source, peaks: [] }); continue; }
    const asset = await result<DawAsset>(response);
    assets.push(asset);
  }
  return { session: parseSession({ ...session, assets }), missing };
}

export interface DawMixResult {
  id: string; url: string; name: string; duration: number; sampleRate: number; channels: number;
  loudness?: { integrated: number | null; truePeak: number | null; lra?: number | null };
  clippedSamples?: number | null;
  tailSeconds?: number;
}
export async function exportDawMix(session: DawSession, signal?: AbortSignal, includeTail?: boolean): Promise<DawMixResult> {
  return result<DawMixResult>(await fetch('/api/daw/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: JSON.parse(serializeSession(session)), ...(includeTail === undefined ? {} : { includeTail }) }), signal,
  }));
}
export async function importDawRenderToEditor(id: string, signal: AbortSignal): Promise<MediaAsset> {
  return result<MediaAsset>(await fetch(`/api/daw/renders/${encodeURIComponent(id)}/to-editor`, { method: 'POST', signal }));
}

export async function learnDawNoise(session: DawSession, target: string, effectId: string, start: number, duration: number, signal: AbortSignal): Promise<number[]> {
  const response = await fetch('/api/daw/native/learn-noise', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ session: JSON.parse(serializeSession(session)), target, effectId, start, duration }),
  });
  return (await result<{ noiseProfile: number[] }>(response)).noiseProfile;
}

export type MatchReferenceId = { kind: 'clip' | 'asset'; id: string };
export const MATCH_CLIP_MIME = 'application/x-visiki-daw-clip';
export async function analyzeDawMatchEq(session: DawSession, sourceTarget: string, reference: MatchReferenceId, signal: AbortSignal): Promise<number[]> {
  const response = await fetch('/api/daw/match-eq', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ session: JSON.parse(serializeSession(session)), sourceTarget,
      ...(reference.kind === 'clip' ? { referenceClipId: reference.id } : { referenceAssetId: reference.id }) }),
  });
  return (await result<{ gains: number[] }>(response)).gains;
}
