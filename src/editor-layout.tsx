import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

type PanelEdge = 'left' | 'right' | 'bottom';
type PanelSizes = Record<PanelEdge, number>;
type Viewport = { width: number; height: number };
const STORAGE_KEY = 'visiki-editor-layout-v1';
const DIVIDER_SIZE = 6;
const minimums: PanelSizes = { left: 190, right: 220, bottom: 140 };
const maximums: PanelSizes = { left: 480, right: 560, bottom: 600 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const viewportSize = (topInset: number): Viewport => ({ width: Math.max(760, window.innerWidth), height: Math.max(480, window.innerHeight) - topInset });
const defaultSizes = ({ width, height }: Viewport): PanelSizes => ({
  left: width >= 1700 ? 270 : width >= 1280 ? 250 : width > 1050 ? 218 : 195,
  right: width >= 1700 ? 300 : width >= 1280 ? 274 : width > 1050 ? 238 : 220,
  bottom: height <= 800 ? 232 : width >= 1700 ? 280 : 268,
});
function readPreferences(): Partial<PanelSizes> {
  try {
    const value: unknown = JSON.parse((localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('echo-editor-layout-v1')) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Partial<PanelSizes> = {};
    for (const edge of ['left', 'right', 'bottom'] as const) {
      const size = (value as Record<string, unknown>)[edge];
      if (typeof size === 'number' && Number.isFinite(size)) result[edge] = clamp(size, minimums[edge], maximums[edge]);
    }
    return result;
  } catch { return {}; }
}

export function useEditorLayout(sideCollapsed: boolean, topInset = 0) {
  const [viewport, setViewport] = useState(() => viewportSize(topInset));
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    const resize = () => setViewport(viewportSize(topInset));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [topInset]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* The editor remains usable when browser storage is unavailable. */ }
  }, [preferences]);

  const defaults = defaultSizes(viewport);
  const compactHeight = viewport.height <= 800;
  const header = compactHeight ? 53 : viewport.width >= 1700 ? 60 : 58;
  const footer = compactHeight ? 24 : viewport.width >= 1700 ? 28 : 27;
  const workspaceMin = Math.min(300, Math.max(200, viewport.height - header - footer - DIVIDER_SIZE - minimums.bottom));
  const bottomMax = Math.min(maximums.bottom, viewport.height - header - footer - DIVIDER_SIZE - Math.min(260, workspaceMin));
  const sizes: PanelSizes = {
    left: clamp(preferences.left ?? defaults.left, minimums.left, maximums.left),
    right: clamp(preferences.right ?? defaults.right, minimums.right, maximums.right),
    bottom: clamp(preferences.bottom ?? defaults.bottom, minimums.bottom, bottomMax),
  };
  const sideBudget = viewport.width - 320 - DIVIDER_SIZE * (sideCollapsed ? 1 : 2);
  if (sideCollapsed) sizes.right = Math.min(sizes.right, sideBudget);
  else if (sizes.left + sizes.right > sideBudget) {
    // Shrink the visible panels proportionally, preserving the saved sizes for a larger window.
    const availableExtra = sideBudget - minimums.left - minimums.right;
    const requestedExtra = sizes.left - minimums.left + sizes.right - minimums.right;
    sizes.left = minimums.left + (sizes.left - minimums.left) * availableExtra / requestedExtra;
    sizes.right = minimums.right + (sizes.right - minimums.right) * availableExtra / requestedExtra;
  }
  for (const edge of ['left', 'right', 'bottom'] as const) sizes[edge] = Math.round(sizes[edge]);
  if (!sideCollapsed && sizes.left + sizes.right > sideBudget) sizes.left -= sizes.left + sizes.right - sideBudget;
  const bounds = {
    left: { min: minimums.left, max: Math.floor(Math.min(maximums.left, sideBudget - sizes.right)) },
    right: { min: minimums.right, max: Math.floor(Math.min(maximums.right, sideBudget - (sideCollapsed ? 0 : sizes.left))) },
    bottom: { min: minimums.bottom, max: Math.floor(bottomMax) },
  };
  const latest = useRef({ sizes, bounds, sideCollapsed }); latest.current = { sizes, bounds, sideCollapsed };
  const change = useCallback((edge: PanelEdge, value: number) => {
    const current = latest.current;
    const size = Math.round(clamp(value, current.bounds[edge].min, current.bounds[edge].max));
    setPreferences(previous => {
      if (edge === 'bottom' || current.sideCollapsed) return { ...previous, [edge]: size };
      // While dragging one side, anchor the other side at its visible width. A bottom resize must never overwrite saved side widths.
      const other = edge === 'left' ? 'right' : 'left';
      return { ...previous, [other]: current.sizes[other], [edge]: size };
    });
  }, []);
  const reset = useCallback((edge: PanelEdge) => {
    setPreferences(previous => { const next = { ...previous }; delete next[edge]; return next; });
  }, []);
  const editorStyle: CSSProperties = {
    gridTemplateRows: `${header}px minmax(0, 1fr) ${DIVIDER_SIZE}px ${sizes.bottom}px ${footer}px`,
  };
  const workspaceStyle: CSSProperties = {
    gridTemplateColumns: sideCollapsed
      ? `minmax(320px, 1fr) ${DIVIDER_SIZE}px ${sizes.right}px`
      : `${sizes.left}px ${DIVIDER_SIZE}px minmax(320px, 1fr) ${DIVIDER_SIZE}px ${sizes.right}px`,
  };
  return { sizes, bounds, change, reset, editorStyle, workspaceStyle };
}

type EditorLayout = ReturnType<typeof useEditorLayout>;
const panelLabels: Record<PanelEdge, string> = { left: '左侧素材栏宽度', right: '右侧属性栏宽度', bottom: '底部时间线高度' };

export function EditorPanelSeparator({ edge, layout }: { edge: PanelEdge; layout: EditorLayout }) {
  const horizontal = edge === 'bottom';
  const [dragging, setDragging] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    cleanup.current?.();
    const target = event.currentTarget; target.focus();
    const pointerId = event.pointerId;
    const start = horizontal ? event.clientY : event.clientX;
    const initial = layout.sizes[edge];
    const cursorClass = horizontal ? 'panel-resizing-horizontal' : 'panel-resizing-vertical';
    document.body.classList.add(cursorClass); setDragging(true);
    try { target.setPointerCapture(pointerId); } catch { /* Window listeners also keep the drag active outside the divider. */ }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      const delta = (horizontal ? next.clientY : next.clientX) - start;
      layout.change(edge, initial + delta * (edge === 'left' ? 1 : -1));
    };
    const finish = () => {
      if (!cleanup.current) return;
      cleanup.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
      window.removeEventListener('blur', finish);
      target.removeEventListener('lostpointercapture', finish);
      document.body.classList.remove(cursorClass); setDragging(false);
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* The pointer may already have ended. */ }
    };
    const endPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(); };
    cleanup.current = finish;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    window.addEventListener('blur', finish);
    target.addEventListener('lostpointercapture', finish);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 40 : 10;
    let value = layout.sizes[edge];
    if (event.key === 'Home') value = layout.bounds[edge].min;
    else if (event.key === 'End') value = layout.bounds[edge].max;
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); layout.reset(edge); return; }
    else if (horizontal && ['ArrowUp', 'ArrowDown'].includes(event.key)) value += event.key === 'ArrowUp' ? step : -step;
    else if (!horizontal && ['ArrowLeft', 'ArrowRight'].includes(event.key)) value += (event.key === 'ArrowRight' ? step : -step) * (edge === 'left' ? 1 : -1);
    else { if (event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); } return; }
    event.preventDefault(); event.stopPropagation(); layout.change(edge, value);
  };
  return <div className={`panel-separator panel-separator-${edge}${dragging ? ' is-resizing' : ''}`} role="separator" tabIndex={0}
    aria-label={panelLabels[edge]} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-controls={`editor-panel-${edge}`}
    aria-valuemin={layout.bounds[edge].min} aria-valuemax={layout.bounds[edge].max} aria-valuenow={layout.sizes[edge]} aria-valuetext={`${layout.sizes[edge]} 像素`}
    title={`拖动调整${panelLabels[edge]}；方向键微调，Shift 加速，双击或 Enter 恢复默认`}
    onPointerDown={beginDrag} onKeyDown={keyDown} onDoubleClick={() => layout.reset(edge)}><span /></div>;
}
