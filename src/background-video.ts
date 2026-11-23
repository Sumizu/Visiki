import type { Layer, MediaAsset } from './types';
import { MAX_VIDEO_RATE, MIN_VIDEO_RATE } from './video-timing';

const EPSILON = 1e-8;

export function isVideoBackground(layer: Layer): boolean {
  return layer.type === 'background' && layer.params.backgroundType === 'video';
}

/** Backgrounds have a layer-relative source clock. Speed and reverse affect
 * the complete source without trimming or changing the background's span. */
export function backgroundVideoSourceTime(layer: Layer, projectTime: number, asset: MediaAsset): number {
  if (!isVideoBackground(layer) || asset.type !== 'video' || !Number.isFinite(asset.duration) || !asset.duration || asset.duration <= 0) {
    throw new Error('视频背景需要有效的视频素材');
  }
  const fps = typeof asset.fps === 'number' && Number.isFinite(asset.fps) ? Math.max(1, Math.min(240, asset.fps)) : 30;
  const duration = asset.duration;
  const rate = typeof layer.params.playbackRate === 'number' && Number.isFinite(layer.params.playbackRate)
    ? Math.max(MIN_VIDEO_RATE, Math.min(MAX_VIDEO_RATE, layer.params.playbackRate)) : 1;
  const reverse = layer.params.reverse === true;
  const elapsed = Math.max(0, (Number.isFinite(projectTime) ? projectTime : layer.start) - layer.start);
  const looping = layer.params.videoLoop !== false;
  const effectiveElapsed = elapsed * rate;
  let source = looping
    ? (Number.isFinite(effectiveElapsed) ? effectiveElapsed % duration : (elapsed % (duration / rate)) * rate)
    : Math.min(effectiveElapsed, duration);
  // Floating point modulo at an exact repeated boundary can land immediately
  // before EOF. Treat that rounding residue as the first frame of the loop.
  if (looping && (source < EPSILON || duration - source < EPSILON)) source = 0;
  const lastFrame = Math.max(0, Math.ceil(duration * fps - EPSILON) - 1);
  // Reverse starts in the final frame, including a partial frame at a
  // fractional EOF. Direction-aware rounding retains that partial duration.
  const frame = Math.max(0, Math.min(lastFrame, reverse
    ? Math.ceil((duration - 1 / fps - source - EPSILON) * fps)
    : Math.floor((source + EPSILON) * fps)));
  return frame / fps;
}
