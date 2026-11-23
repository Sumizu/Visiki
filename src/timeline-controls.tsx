import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import type { Layer } from './types';
import {
  clampTrackHeight, DEFAULT_AUDIO_TRACK_HEIGHT, DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT, normalizeTrackHeights, zoomTimelineAtCursor,
} from './timeline-layout';

const LAYOUT_STORAGE_KEY = 'visiki-timeline-layout-v1';
export const AUDIO_TRACK_ID = '__audio__';
type DropTarget = { targetId: string; placement: 'before' | 'after' };
type Point = { clientX: number; clientY: number };

function loadTrackHeights() {
  try { return normalizeTrackHeights(JSON.parse((localStorage.getItem(LAYOUT_STORAGE_KEY) ?? localStorage.getItem('echo-timeline-layout-v1')) ?? '{}')); }
  catch { return {}; }
}

/** Local timeline gestures never change project data until an order is dropped. */
export function useTimelineControls({ zoom, setZoom, onReorder }: {
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  onReorder: (sourceId: string, targetId: string, placement: 'before' | 'after') => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>(loadTrackHeights);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const mounted = useRef(true);
  const cancelGesture = useRef<(() => void) | null>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const pendingScroll = useRef<number | null>(null);
  const onReorderRef = useRef(onReorder); onReorderRef.current = onReorder;

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(trackHeights)); }
    catch { /* Track sizing remains available when local storage is unavailable. */ }
  }, [trackHeights]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelGesture.current?.(); };
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  }, [zoom]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      // Native non-passive handling prevents Alt+wheel from also scrolling a pane.
      event.preventDefault();
      if (cancelGesture.current || !event.deltaY) return;
      const rect = viewport.getBoundingClientRect();
      const label = viewport.querySelector<HTMLElement>('.ruler-label');
      const next = zoomTimelineAtCursor({
        zoom: zoomRef.current, deltaY: event.deltaY, deltaMode: event.deltaMode,
        clientX: event.clientX, viewportLeft: rect.left, viewportWidth: viewport.clientWidth,
        scrollLeft: pendingScroll.current ?? viewport.scrollLeft,
        labelWidth: label?.getBoundingClientRect().width ?? 173,
      });
      if (next.zoom === zoomRef.current) return;
      zoomRef.current = next.zoom;
      pendingScroll.current = next.scrollLeft;
      setZoom(next.zoom);
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [setZoom]);

  const heightFor = (id: string) => trackHeights[id] ?? (id === AUDIO_TRACK_ID ? DEFAULT_AUDIO_TRACK_HEIGHT : DEFAULT_TRACK_HEIGHT);
  const setHeight = (id: string, value: number) => setTrackHeights(current => {
    const next = clampTrackHeight(value, id === AUDIO_TRACK_ID ? DEFAULT_AUDIO_TRACK_HEIGHT : DEFAULT_TRACK_HEIGHT);
    return current[id] === next ? current : { ...current, [id]: next };
  });
  const resetHeight = (id: string) => setTrackHeights(current => {
    if (!(id in current)) return current;
    const next = { ...current }; delete next[id]; return next;
  });

  function beginResize(event: ReactPointerEvent<HTMLElement>, id: string) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation(); cancelGesture.current?.();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const initialY = event.clientY, initialHeight = heightFor(id);
    const initialPreference = trackHeights[id];
    const oldCursor = document.body.style.cursor, oldSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
    setResizingId(id);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      pointer.preventDefault(); setHeight(id, initialHeight + pointer.clientY - initialY);
    };
    const finish = (cancelled: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      handle.removeEventListener('lostpointercapture', cancelPointer);
      cancelGesture.current = null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelect;
      if (mounted.current) {
        setResizingId(null);
        if (cancelled) setTrackHeights(current => {
          const next = { ...current };
          if (initialPreference === undefined) delete next[id]; else next[id] = initialPreference;
          return next;
        });
      }
    };
    const up = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(false); };
    const cancelPointer = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(true); };
    const cancel = () => finish(true);
    const key = (keyboard: KeyboardEvent) => { if (keyboard.key === 'Escape') { keyboard.preventDefault(); keyboard.stopPropagation(); cancel(); } };
    cancelGesture.current = cancel;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    handle.addEventListener('lostpointercapture', cancelPointer);
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners also cover uncaptured pointers. */ }
  }

  function beginReorder(event: ReactPointerEvent<HTMLElement>, layer: Layer) {
    if (event.button !== 0 || !event.isPrimary || layer.locked) return;
    event.preventDefault(); event.stopPropagation(); cancelGesture.current?.();
    const viewport = scrollRef.current; if (!viewport) return;
    const handle = event.currentTarget, pointerId = event.pointerId;
    const initial = { clientX: event.clientX, clientY: event.clientY };
    let point: Point = initial, active = false, target: DropTarget | null = null, frame = 0, previousTick = 0;
    const oldCursor = document.body.style.cursor, oldSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const locateTarget = (position: Point) => {
      const bounds = viewport.getBoundingClientRect();
      if (position.clientX < bounds.left || position.clientX >= bounds.left + viewport.clientWidth || position.clientY < bounds.top || position.clientY >= bounds.top + viewport.clientHeight) return null;
      for (const row of viewport.querySelectorAll<HTMLElement>('[data-track-id]')) {
        const rect = row.getBoundingClientRect();
        if (position.clientY < rect.top || position.clientY >= rect.bottom) continue;
        const id = row.dataset.trackId;
        if (!id || id === AUDIO_TRACK_ID || id === layer.id) return null;
        return { targetId: id, placement: position.clientY < rect.top + rect.height / 2 ? 'before' : 'after' } as DropTarget;
      }
      return null;
    };
    const preview = () => {
      target = locateTarget(point);
      setDropTarget(current => current?.targetId === target?.targetId && current?.placement === target?.placement ? current : target);
    };
    const tick = (now: number) => {
      const elapsed = previousTick ? Math.min(32, now - previousTick) : 16; previousTick = now;
      const rect = viewport.getBoundingClientRect(), edge = Math.min(40, viewport.clientHeight / 3);
      if (point.clientX >= rect.left && point.clientX < rect.left + viewport.clientWidth && point.clientY >= rect.top && point.clientY < rect.top + viewport.clientHeight) {
        const y = point.clientY - rect.top;
        const velocity = y < edge ? -(1 - y / edge) : y > viewport.clientHeight - edge ? (y - viewport.clientHeight + edge) / edge : 0;
        if (velocity) { viewport.scrollTop += velocity * elapsed * .7; preview(); }
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      pointer.preventDefault(); point = { clientX: pointer.clientX, clientY: pointer.clientY };
      if (!active && Math.hypot(point.clientX - initial.clientX, point.clientY - initial.clientY) < 5) return;
      if (!active) { active = true; setDraggedId(layer.id); document.body.style.cursor = 'grabbing'; frame = requestAnimationFrame(tick); }
      preview();
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      handle.removeEventListener('lostpointercapture', cancelPointer);
      cancelAnimationFrame(frame); cancelGesture.current = null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelect;
      if (mounted.current) { setDraggedId(null); setDropTarget(null); }
      if (commit && active && target) onReorderRef.current(layer.id, target.targetId, target.placement);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      point = { clientX: pointer.clientX, clientY: pointer.clientY }; target = locateTarget(point); finish(true);
    };
    const cancelPointer = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(false); };
    const cancel = () => finish(false);
    const key = (keyboard: KeyboardEvent) => { if (keyboard.key === 'Escape') { keyboard.preventDefault(); keyboard.stopPropagation(); cancel(); } };
    cancelGesture.current = cancel;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    handle.addEventListener('lostpointercapture', cancelPointer);
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners also cover uncaptured pointers. */ }
  }

  return { scrollRef, heightFor, setHeight, resetHeight, beginResize, resizingId, beginReorder, draggedId, dropTarget };
}

export function TimelineTrackResize({ controls, trackId, name }: {
  controls: ReturnType<typeof useTimelineControls>; trackId: string; name: string;
}) {
  return <div className={`track-height-handle${controls.resizingId === trackId ? ' resizing' : ''}`}
    data-testid={`track-resize-${trackId}`} role="separator" aria-label={`${name}轨道高度`}
    aria-orientation="horizontal" aria-valuemin={MIN_TRACK_HEIGHT} aria-valuemax={MAX_TRACK_HEIGHT}
    aria-valuenow={controls.heightFor(trackId)} tabIndex={0}
    title="拖动调整轨道高度 · 双击或 Home 恢复默认 · 上下键微调，Shift 加速"
    onPointerDown={event => controls.beginResize(event, trackId)}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); controls.resetHeight(trackId); }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') controls.resetHeight(trackId);
      else controls.setHeight(trackId, event.key === 'End' ? MAX_TRACK_HEIGHT : controls.heightFor(trackId) + (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 10 : 1));
    }} />;
}
