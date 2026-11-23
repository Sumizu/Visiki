import type { Layer } from './types';

/** Move a layer without changing its length, contents or source timestamps.
 * Placement snaps to project frames; the final boundary stays within one hour. */
export function moveLayer(layer: Layer, requestedStart: number, projectFps = 30, maximumDuration = 3600): Layer {
  if (layer.locked) return layer;
  const duration = layer.end - layer.start;
  if (!Number.isFinite(duration) || duration <= 0) return layer;
  const limit = Number.isFinite(maximumDuration) ? Math.max(duration, Math.min(3600, maximumDuration)) : 3600;
  const fps = Number.isFinite(projectFps) ? Math.min(60, Math.max(1, projectFps)) : 30;
  const target = Number.isFinite(requestedStart) ? requestedStart : layer.start;
  // Round the last legal placement downward as well, so a fractional source
  // duration does not move the new start between project frames at the limit.
  const latestStart = Math.max(0, Math.floor((limit - duration + 1e-8) * fps) / fps);
  const start = Math.max(0, Math.min(latestStart, Math.round(target * fps) / fps));
  if (Math.abs(start - layer.start) < 1e-10) return layer;
  return { ...layer, start, end: start + duration };
}
