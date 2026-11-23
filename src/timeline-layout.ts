import type { Layer } from './types';

export const MIN_TRACK_HEIGHT = 24;
export const MAX_TRACK_HEIGHT = 160;
export const DEFAULT_TRACK_HEIGHT = 24;
export const DEFAULT_AUDIO_TRACK_HEIGHT = 36;
export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 5;

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function clampTrackHeight(value: number, fallback = DEFAULT_TRACK_HEIGHT): number {
  return clamp(Math.round(finite(value, finite(fallback, DEFAULT_TRACK_HEIGHT))), MIN_TRACK_HEIGHT, MAX_TRACK_HEIGHT);
}

/** Local layout preferences are independent of the saved composition. */
export function normalizeTrackHeights(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  let count = 0;
  for (const key in value) {
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) continue;
    result[key] = clampTrackHeight(descriptor.value);
    if (++count >= 2000) break;
  }
  return result;
}

/** Layers render bottom-to-top, whereas before/after refer to their visible top-to-bottom tracks. */
export function reorderTimelineLayer(layers: Layer[], draggedId: string, targetId: string, placement: 'before' | 'after'): Layer[] {
  if (draggedId === targetId || (placement !== 'before' && placement !== 'after')) return layers;
  const source = layers.find(layer => layer.id === draggedId);
  if (!source || source.locked || !layers.some(layer => layer.id === targetId)) return layers;
  const displayed = layers.slice().reverse();
  displayed.splice(displayed.indexOf(source), 1);
  const target = displayed.findIndex(layer => layer.id === targetId);
  displayed.splice(target + (placement === 'after' ? 1 : 0), 0, source);
  displayed.reverse();
  return displayed.every((layer, index) => layer === layers[index]) ? layers : displayed;
}

export interface TimelineZoomInput {
  zoom: number;
  deltaY: number;
  deltaMode: number;
  clientX: number;
  viewportLeft: number;
  viewportWidth: number;
  scrollLeft: number;
  labelWidth: number;
}

/** Preserve the time under the cursor, accounting for the fixed, sticky track label column. */
export function zoomTimelineAtCursor(input: TimelineZoomInput): { zoom: number; scrollLeft: number } {
  const oldZoom = clamp(finite(input.zoom, MIN_TIMELINE_ZOOM), MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM);
  const width = clamp(finite(input.viewportWidth, 0), 0, Number.MAX_SAFE_INTEGER / MAX_TIMELINE_ZOOM);
  const labelWidth = clamp(finite(input.labelWidth, 0), 0, width);
  // WheelEvent line/page units use 16 CSS pixels and one viewport width respectively.
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? Math.max(1, width) : 1;
  const delta = finite(input.deltaY, 0);
  const exponent = clamp(-delta * unit * .002, -50, 50);
  const zoom = clamp(oldZoom * Math.exp(exponent), MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM);
  if (width === 0) return { zoom, scrollLeft: 0 };

  const oldScroll = clamp(finite(input.scrollLeft, 0), 0, width * (oldZoom - 1));
  const viewportLeft = finite(input.viewportLeft, 0);
  const cursor = clamp(finite(input.clientX, viewportLeft + labelWidth) - viewportLeft, labelWidth, width);
  const cursorTimeOffset = cursor - labelWidth;
  const oldTimeWidth = width * oldZoom - labelWidth;
  const newTimeWidth = width * zoom - labelWidth;
  const timeFraction = oldTimeWidth > 0 ? (oldScroll + cursorTimeOffset) / oldTimeWidth : 0;
  const scrollLeft = clamp(timeFraction * newTimeWidth - cursorTimeOffset, 0, width * (zoom - 1));
  return { zoom, scrollLeft };
}
