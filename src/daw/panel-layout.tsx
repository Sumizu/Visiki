import {useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject} from 'react';

export interface DawPanelLayout {head: number; inspector: number; mixer: number}
export type DawPanel = keyof DawPanelLayout;
export interface DawPanelViewport {width: number; height: number; mixerSpace?: number}
export interface DawPanelBounds {min: number; max: number}

export const DAW_PANEL_DEFAULTS: Readonly<DawPanelLayout> = {head:188, inspector:292, mixer:230};
export const DAW_PANEL_STORAGE_KEY = 'visiki-daw-layout-v1';
const TIMELINE_MINIMUM = 130;
const PANEL_DIVIDER = 6;
const ABSOLUTE_BOUNDS: Record<DawPanel, DawPanelBounds> = {
  head:{min:140,max:320}, inspector:{min:235,max:460}, mixer:{min:170,max:420},
};

const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));
const finite = (value:unknown,fallback:number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Viewport limits leave useful room for the audio roll when panels are enlarged. */
export function dawPanelBounds(panel:DawPanel,layout:DawPanelLayout,viewport:DawPanelViewport):DawPanelBounds {
  const absolute = ABSOLUTE_BOUNDS[panel];
  let maximum = absolute.max;
  if (panel === 'mixer') {
    const available = viewport.mixerSpace ?? (viewport.height > 0 ? viewport.height-355 : maximum);
    maximum = Math.min(maximum,available);
  } else if (viewport.width > 0) {
    const other = panel === 'head' ? layout.inspector : layout.head;
    maximum = Math.min(maximum,viewport.width-other-TIMELINE_MINIMUM-PANEL_DIVIDER);
  }
  return {min:absolute.min,max:Math.max(absolute.min,Math.floor(maximum))};
}

/** Invalid saved preferences are replaced individually; temporary clamps do not erase them. */
export function resolveDawPanelLayout(input:unknown,viewport:DawPanelViewport):DawPanelLayout {
  const candidate = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Partial<DawPanelLayout> : {};
  const result:DawPanelLayout = {...DAW_PANEL_DEFAULTS};
  for (const panel of ['head','inspector','mixer'] as const) {
    const {min,max} = ABSOLUTE_BOUNDS[panel];
    result[panel] = Math.round(clamp(finite(candidate[panel],DAW_PANEL_DEFAULTS[panel]),min,max));
  }
  // Preserve the property pane first if an old preference is too wide for this window.
  const inspectorMaximum = viewport.width > 0
    ? Math.max(235,Math.min(460,viewport.width-140-TIMELINE_MINIMUM-PANEL_DIVIDER)) : 460;
  result.inspector = Math.min(result.inspector,inspectorMaximum);
  const headBounds = dawPanelBounds('head',result,viewport);
  result.head = clamp(result.head,headBounds.min,headBounds.max);
  const mixerBounds = dawPanelBounds('mixer',result,viewport);
  result.mixer = clamp(result.mixer,mixerBounds.min,mixerBounds.max);
  return result;
}

function readPreferences():DawPanelLayout {
  try { return resolveDawPanelLayout(JSON.parse(localStorage.getItem(DAW_PANEL_STORAGE_KEY) ?? 'null'),{width:0,height:0}); }
  catch { return {...DAW_PANEL_DEFAULTS}; }
}

const LABELS:Record<DawPanel,string> = {
  head:'调整音轨栏宽度', inspector:'调整属性栏宽度', mixer:'调整混音器高度',
};

export type DawResizeHandleProps = HTMLAttributes<HTMLDivElement> & {'data-daw-resize':DawPanel};

/** Panel sizes are UI preferences, deliberately independent of session undo and audio state. */
export function useDawPanelLayout(root:RefObject<HTMLElement|null>,active:boolean) {
  const [preferred,setPreferred] = useState<DawPanelLayout>(readPreferences);
  const [viewport,setViewport] = useState<DawPanelViewport>({width:0,height:0});
  const [resizing,setResizing] = useState(false);
  const preferredRef = useRef(preferred);
  const viewportRef = useRef(viewport);
  const layout = useMemo(() => resolveDawPanelLayout(preferred,viewport),[preferred,viewport]);
  const layoutRef = useRef(layout);
  const activeRef = useRef(active);
  const finishRef = useRef<null|((cancel:boolean,render?:boolean)=>void)>(null);
  preferredRef.current = preferred;
  viewportRef.current = viewport;
  layoutRef.current = layout;
  activeRef.current = active;

  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(DAW_PANEL_STORAGE_KEY,JSON.stringify(preferred)); } catch { /* Private storage may be unavailable. */ }
  },[preferred,resizing]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const arrangement = element.querySelector('.daw-arrangement');
      const toolbar = element.querySelector('.daw-toolbar');
      const transport = element.querySelector('.daw-transport');
      const mixerSpace = arrangement && toolbar && transport
        ? arrangement.getBoundingClientRect().height-toolbar.getBoundingClientRect().height-transport.getBoundingClientRect().height-TIMELINE_MINIMUM
        : undefined;
      setViewport(previous => previous.width === rect.width && previous.height === rect.height && previous.mixerSpace === mixerSpace
        ? previous : {width:rect.width,height:rect.height,mixerSpace});
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const selector of ['.daw-arrangement','.daw-toolbar','.daw-transport']) {
      const child = element.querySelector(selector);
      if (child) observer.observe(child);
    }
    window.addEventListener('resize',measure);
    measure();
    const frame = requestAnimationFrame(measure);
    return () => {cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',measure);};
  },[root,active]);

  useEffect(() => { if (!active) finishRef.current?.(true); },[active]);
  useEffect(() => () => finishRef.current?.(true,false),[]);

  const handleProps = useCallback((panel:DawPanel):DawResizeHandleProps => {
    const bounds = dawPanelBounds(panel,layout,viewport);
    return {
      role:'separator',tabIndex:active ? 0 : -1,'data-daw-resize':panel,
      'aria-label':LABELS[panel],'aria-orientation':panel === 'mixer' ? 'horizontal' : 'vertical',
      'aria-valuemin':bounds.min,'aria-valuemax':bounds.max,'aria-valuenow':layout[panel],
      'aria-valuetext':`${Math.round(layout[panel])} 像素`,
      title:'拖动调整；方向键微调，Shift 加快；双击或 Enter 复原；Esc 取消拖动',
      onPointerDown:event => {
        if (event.button !== 0 || !event.isPrimary || !activeRef.current) return;
        event.preventDefault();event.stopPropagation();
        event.currentTarget.focus({preventScroll:true});
        finishRef.current?.(true);
        const element = event.currentTarget;
        const pointerId = event.pointerId;
        const initial = {...preferredRef.current};
        const displayed = {...layoutRef.current};
        const origin = panel === 'mixer' ? event.clientY : event.clientX;
        const direction = panel === 'head' ? 1 : -1;
        const documentStyle = document.documentElement.style;
        const previousCursor = documentStyle.cursor;
        const previousSelect = documentStyle.userSelect;
        documentStyle.cursor = panel === 'mixer' ? 'ns-resize' : 'ew-resize';
        documentStyle.userSelect = 'none';
        setResizing(true);
        try {element.setPointerCapture(pointerId);} catch { /* Window listeners also cover synthetic pointer input. */ }
        let pending:DawPanelLayout|null = null;
        let frame:number|null = null;
        const flush = () => {
          frame = null;
          if (!pending) return;
          preferredRef.current = pending;
          setPreferred(pending);
          pending = null;
        };
        const move = (next:PointerEvent) => {
          if (next.pointerId !== pointerId) return;
          next.preventDefault();
          const coordinate = panel === 'mixer' ? next.clientY : next.clientX;
          const limits = dawPanelBounds(panel,displayed,viewportRef.current);
          pending = {...initial,[panel]:Math.round(clamp(displayed[panel]+direction*(coordinate-origin),limits.min,limits.max))};
          if (frame === null) frame = requestAnimationFrame(flush);
        };
        const up = (next:PointerEvent) => {if (next.pointerId === pointerId) finish(false);};
        const cancel = (next:PointerEvent) => {if (next.pointerId === pointerId) finish(true);};
        const blur = () => finish(true);
        const key = (next:KeyboardEvent) => {
          if (next.key !== 'Escape') return;
          next.preventDefault();next.stopPropagation();finish(true);
        };
        const finish = (cancelled:boolean,render=true) => {
          if (finishRef.current !== finish) return;
          finishRef.current = null;
          window.removeEventListener('pointermove',move,true);
          window.removeEventListener('pointerup',up,true);
          window.removeEventListener('pointercancel',cancel,true);
          window.removeEventListener('keydown',key,true);
          window.removeEventListener('blur',blur);
          if (frame !== null) cancelAnimationFrame(frame);
          documentStyle.cursor = previousCursor;
          documentStyle.userSelect = previousSelect;
          try {if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);} catch { /* Element may already be detached. */ }
          if (render) {
            if (cancelled) {preferredRef.current=initial;setPreferred(initial);pending=null;}
            else flush();
            setResizing(false);
          }
        };
        finishRef.current = finish;
        window.addEventListener('pointermove',move,{capture:true,passive:false});
        window.addEventListener('pointerup',up,true);
        window.addEventListener('pointercancel',cancel,true);
        window.addEventListener('keydown',key,true);
        window.addEventListener('blur',blur);
      },
      onDoubleClick:event => {
        event.preventDefault();event.stopPropagation();
        if (!activeRef.current) return;
        finishRef.current?.(true);
        setPreferred(previous => ({...previous,[panel]:DAW_PANEL_DEFAULTS[panel]}));
      },
      onKeyDown:event => {
        if (!activeRef.current || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        const limits = dawPanelBounds(panel,layoutRef.current,viewportRef.current);
        let next:number|undefined;
        const step = event.shiftKey ? 20 : 10;
        const increase = panel === 'mixer' ? 'ArrowUp' : panel === 'head' ? 'ArrowRight' : 'ArrowLeft';
        const decrease = panel === 'mixer' ? 'ArrowDown' : panel === 'head' ? 'ArrowLeft' : 'ArrowRight';
        if (event.key === increase) next=layoutRef.current[panel]+step;
        else if (event.key === decrease) next=layoutRef.current[panel]-step;
        else if (event.key === 'Home') next=limits.min;
        else if (event.key === 'End') next=limits.max;
        else if (event.key === 'Enter') next=DAW_PANEL_DEFAULTS[panel];
        if (next === undefined) return;
        event.preventDefault();event.stopPropagation();
        const value=clamp(next,limits.min,limits.max);
        setPreferred(previous => ({...previous,[panel]:value}));
      },
    };
  },[active,layout,viewport]);

  const updateLayout = (patch: Partial<DawPanelLayout>) => {
    const next = resolveDawPanelLayout({...preferredRef.current,...patch},{width:0,height:0});
    preferredRef.current = next;
    setPreferred(next);
    return resolveDawPanelLayout(next,viewportRef.current);
  };
  return {layout,resizing,handleProps,updateLayout};
}
