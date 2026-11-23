import type { DemoProject, Layer, MediaAsset } from './types';
import { cloneEffects } from './effects';

export const MIN_VIDEO_RATE = 0.1;
export const MAX_VIDEO_RATE = 8;
const MAX_DURATION = 3600;
const EPSILON = 1e-8;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const frameLength = (fps: number): number => 1 / clamp(number(fps, 30), 1, 60);

export interface VideoRange { sourceIn: number; sourceOut: number; rate: number; reverse: boolean; duration: number; fps: number }

export function videoRange(layer: Layer, asset: MediaAsset): VideoRange {
  if (layer.type !== 'video' || asset.type !== 'video' || !asset.duration || !Number.isFinite(asset.duration) || asset.duration <= 0) {
    throw new Error('视频片段需要有效的视频素材');
  }
  const duration = asset.duration;
  const sourceIn = clamp(number(layer.params.sourceIn, 0), 0, Math.max(0, duration - EPSILON));
  const sourceOut = clamp(number(layer.params.sourceOut, duration), sourceIn + EPSILON, duration);
  return { sourceIn, sourceOut, rate: clamp(number(layer.params.playbackRate, 1), MIN_VIDEO_RATE, MAX_VIDEO_RATE),
    reverse: layer.params.reverse === true, duration, fps: clamp(number(asset.fps, 30), 1, 240) };
}

function updated(layer: Layer, start: number, sourceIn: number, sourceOut: number, rate: number): Layer {
  sourceIn = Math.max(0, sourceIn); rate = clamp(rate, MIN_VIDEO_RATE, MAX_VIDEO_RATE);
  const rawEnd = start + (sourceOut - sourceIn) / rate;
  const end = rawEnd > MAX_DURATION && rawEnd < MAX_DURATION + EPSILON ? MAX_DURATION : rawEnd;
  return { ...layer, start, end,
    params: { ...layer.params, sourceIn, sourceOut, playbackRate: rate } };
}

/** Source intervals are half open. In reverse the first decoded timestamp is
 * one source frame before sourceOut, so neither seeks nor exports hit EOF. */
export function videoSourceTime(layer: Layer, projectTime: number, asset: MediaAsset): number {
  const range = videoRange(layer, asset);
  const sourceFrame = 1 / range.fps;
  const elapsed = clamp(number(projectTime, layer.start) - layer.start, 0, Math.max(0, layer.end - layer.start));
  const raw = range.reverse ? range.sourceOut - sourceFrame - elapsed * range.rate : range.sourceIn + elapsed * range.rate;
  const first = Math.floor((range.sourceIn + EPSILON) * range.fps) / range.fps;
  const last = Math.max(first, (Math.ceil(Math.min(range.duration, range.sourceOut) * range.fps - EPSILON) - 1) / range.fps);
  // A cut can land inside a source frame. Use the frame covering that boundary,
  // with direction-aware rounding, so splitting cannot add or skip a frame.
  // At aligned boundaries reverse starts exactly sourceOut - 1 / source fps.
  const quantized = range.reverse ? Math.ceil((raw - EPSILON) * range.fps) / range.fps : Math.floor((raw + EPSILON) * range.fps) / range.fps;
  return clamp(quantized, first, last);
}

/** Move a clip without changing its source range or speed. If the destination
 * project is shorter than the clip, callers can extend it to the returned end. */
export function moveVideoLayer(layer: Layer, newStart: number, projectDuration = MAX_DURATION): Layer {
  const length = layer.end - layer.start;
  const maximum = Math.max(0, Math.min(MAX_DURATION, number(projectDuration, MAX_DURATION)) - length);
  const start = clamp(number(newStart, layer.start), 0, maximum);
  return { ...layer, start, end: start + length, params: { ...layer.params } };
}

/** Trim changes the source edge that is actually shown at the edited timeline
 * edge. In reverse, the left handle edits sourceOut and the right edits sourceIn. */
export function trimVideoLayer(layer: Layer, edge: 'start' | 'end', newTimelineTime: number, asset: MediaAsset, projectFps = 30): Layer {
  const r = videoRange(layer, asset);
  const minLength = Math.min(frameLength(projectFps), (r.sourceOut - r.sourceIn) / r.rate);
  if (edge === 'start') {
    const available = r.reverse ? (r.duration - r.sourceOut) / r.rate : r.sourceIn / r.rate;
    const start = clamp(number(newTimelineTime, layer.start), Math.max(0, layer.start - available), layer.end - minLength);
    const consumed = (start - layer.start) * r.rate;
    const trimmed=updated(layer, start, r.reverse ? r.sourceIn : Math.max(0, r.sourceIn + consumed), r.reverse ? Math.min(r.duration, r.sourceOut - consumed) : r.sourceOut, r.rate);
    return layer.effects?.length || layer.effectTimeOffset!==undefined ? {...trimmed,effectTimeOffset:(layer.effectTimeOffset??0)+start-layer.start} : trimmed;
  }
  const available = r.reverse ? r.sourceIn / r.rate : (r.duration - r.sourceOut) / r.rate;
  const end = clamp(number(newTimelineTime, layer.end), layer.start + minLength, Math.min(MAX_DURATION, layer.end + available));
  const added = (end - layer.end) * r.rate;
  return updated(layer, layer.start, r.reverse ? Math.max(0, r.sourceIn - added) : r.sourceIn, r.reverse ? r.sourceOut : Math.min(r.duration, r.sourceOut + added), r.rate);
}

/** Stretch preserves the complete source interval and changes playback rate. */
export function stretchVideoLayer(layer: Layer, edge: 'start' | 'end', newTimelineTime: number, asset: MediaAsset, projectFps = 30): Layer {
  const r = videoRange(layer, asset); const span = r.sourceOut - r.sourceIn;
  const minLength = Math.max(frameLength(projectFps), span / MAX_VIDEO_RATE);
  const maxLength = span / MIN_VIDEO_RATE;
  if (edge === 'start') {
    const start = clamp(number(newTimelineTime, layer.start), Math.max(0, layer.end - maxLength), Math.max(0, layer.end - minLength));
    return updated(layer, start, r.sourceIn, r.sourceOut, span / (layer.end - start));
  }
  const end = clamp(number(newTimelineTime, layer.end), layer.start + minLength, Math.min(MAX_DURATION, layer.start + maxLength));
  return updated(layer, layer.start, r.sourceIn, r.sourceOut, span / (end - layer.start));
}

export function setVideoRate(layer: Layer, rate: number, asset: MediaAsset, projectFps = 30): Layer {
  const r = videoRange(layer, asset); const span = r.sourceOut - r.sourceIn;
  const maxRate = Math.min(MAX_VIDEO_RATE, span / frameLength(projectFps));
  const minRate = Math.max(MIN_VIDEO_RATE, span / (MAX_DURATION - layer.start));
  const nextRate = clamp(number(rate, r.rate), minRate, Math.max(minRate, maxRate));
  return updated(layer, layer.start, r.sourceIn, r.sourceOut, nextRate);
}

export function setVideoSourceRange(layer: Layer, sourceIn: number, sourceOut: number, asset: MediaAsset, projectFps = 30): Layer {
  const r = videoRange(layer, asset);
  const minSpan = Math.min(r.duration, r.rate * frameLength(projectFps));
  const start = clamp(number(sourceIn, r.sourceIn), 0, Math.max(0, r.duration - minSpan));
  const maximumEnd = Math.min(r.duration, start + (MAX_DURATION - layer.start) * MAX_VIDEO_RATE);
  const end = clamp(number(sourceOut, r.sourceOut), start + minSpan, maximumEnd);
  const next = updated(layer, layer.start, start, end, r.rate);
  return next.end > MAX_DURATION ? setVideoRate(next, (end - start) / (MAX_DURATION - layer.start), asset, projectFps) : next;
}

export function splitVideoLayer(layer: Layer, at: number, asset: MediaAsset, projectFps = 30): [Layer, Layer] | null {
  const r = videoRange(layer, asset); const minLength = frameLength(projectFps);
  if (!Number.isFinite(at) || at - layer.start < minLength - EPSILON || layer.end - at < minLength - EPSILON) return null;
  const span = (at - layer.start) * r.rate;
  const cut = r.reverse ? r.sourceOut - span : r.sourceIn + span;
  const left = updated(layer, layer.start, r.reverse ? cut : r.sourceIn, r.reverse ? r.sourceOut : cut, r.rate);
  const right = updated({ ...layer, id: crypto.randomUUID(), name: `${layer.name} · 切片`, ...(layer.effects ? {effects:cloneEffects(layer.effects),effectTimeOffset:(layer.effectTimeOffset??0)+at-layer.start}: {}) }, at,
    r.reverse ? r.sourceIn : cut, r.reverse ? cut : r.sourceOut, r.rate);
  return [left, right];
}

/** Used when changing project duration: clips outside the new project are
 * removed and intersecting video clips are trimmed with source mapping intact. */
export function resizeProjectDuration(project: DemoProject, requestedDuration: number): DemoProject {
  const duration = clamp(number(requestedDuration, project.duration), frameLength(project.fps), MAX_DURATION);
  const videos = new Map((project.videos ?? []).map(asset => [asset.id, asset]));
  const layers = project.layers.flatMap(layer => {
    if (layer.start >= duration - EPSILON) return [];
    if (layer.end <= duration) return [layer];
    if (layer.type === 'video') {
      const asset = videos.get(String(layer.params.videoId));
      if (!asset || duration - layer.start < frameLength(project.fps) - EPSILON) return [];
      return [trimVideoLayer(layer, 'end', duration, asset, project.fps)];
    }
    return [{ ...layer, end: duration }];
  });
  return { ...project, duration, layers };
}
