import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clapperboard, Copy, Disc3, Download, Eye, EyeOff, FileText, FolderOpen, GripVertical, Image as ImageIcon, Layers3, LoaderCircle, LockKeyhole, Magnet, Maximize, Minus, Music2, PanelLeftClose, Pause, Play, Plus, Redo2, RotateCcw, Save, Search, Settings2, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Square, Sun, Trash2, Type, Undo2, UnlockKeyhole, Upload, Volume2, VolumeX, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { AudioAnalysis, DemoProject, EffectType, ExportProgress, FontAsset, Layer, LayerEffect, LayerType, LyricsResult, MediaAsset, SceneResources, SongResult } from './types';
import { createDefaultProject, makeLayer } from './default-project';
import { LayoutTemplate } from 'lucide-react';
import { TemplateLibrary } from './template-library';
import { applyProjectTemplate, PROJECT_TEMPLATES } from './templates';
import type { TemplateApplyOptions } from './templates';
import { renderScene } from './scene';
import { analyzeAudio } from './audio-analysis';
import { mergeBilingual, parseLyrics } from './lyrics';
import { fetchLyrics, loadDemoAudio, runExport, searchSongs, uploadMedia } from './services';
import { validateProject } from './project-io';
import { BUILTIN_FONTS, loadProjectFonts, normalizeLyricFonts, resolveLyricFontIds, uploadFont } from './fonts';
import { normalizeLyricStyles, updateLyricStyles } from './lyric-style';
import { VideoFramePool } from './video-frames';
import { trimVideoLayer, stretchVideoLayer, setVideoRate, splitVideoLayer, setVideoSourceRange, resizeProjectDuration } from './video-timing';
import { moveLayer } from './layer-timing';
import { audioGainAtTime } from './fade-effect';
import { MIN_VIDEO_RATE, MAX_VIDEO_RATE } from './video-timing';
import { EditorPanelSeparator, useEditorLayout } from './editor-layout';
import { PARTICLE_PRESETS, PARTICLE_LIMITS, particleDefaults } from './particles';
import { ATMOSPHERE_KINDS, ATMOSPHERE_PRESETS, ATMOSPHERE_LIMITS, atmosphereDefaults } from './atmosphere';
import { reorderTimelineLayer, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM } from './timeline-layout';
import { AUDIO_TRACK_ID, TimelineTrackResize, useTimelineControls } from './timeline-controls';
import { COLOR_EFFECT_PRESETS, EFFECT_DEFINITIONS, MAX_LAYER_EFFECTS, cloneEffects, effectDefaults, effectSupportsTarget, makeEffect, resetEffect } from './effects';
import { connectAgentEditor } from './agent-client';
import type { AgentCommand } from './agent-client';
import { applyAgentOperations, AGENT_OPERATION_TYPES, AGENT_OPERATION_FIELDS } from './agent-operations';
import { agentExportSettings, prepareAgentAnalysis, renderAgentPreview } from './agent-render';
import { useWorkspace } from './workspace-context';
import './styles.css';

const clone = <T,>(value: T): T => structuredClone(value);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const iconByType: Record<LayerType, typeof Disc3> = { background: ImageIcon, image: ImageIcon, video: Clapperboard, disc: Disc3, lyrics: FileText, spectrum: AudioLines, particles: Sparkles, atmosphere: Sun, player: Play, title: Type, text: Type };
const componentNames: Record<LayerType, string> = { background: '氛围背景', image: '封面卡片', video: '视频片段', disc: '旋转唱片', lyrics: '滚动歌词', spectrum: '音频可视化', particles: '氛围粒子', atmosphere: '光影氛围', player: '播放器', title: '曲目信息', text: '文本框' };
const componentHints: Record<LayerType, string> = { background: '独立图片 / 视频与柔和色彩', image: '独立摆放的图片卡片', video: '在播放头添加本地视频素材', disc: '黑胶 / CD · 跟随时间旋转', lyrics: '原文与译文同步显示', spectrum: '心电单线 / 交错双线 / 振幅包络 / 条形 / 环形', particles: '星尘 / 萤火 / 雪雨 / 花瓣 / 散景', atmosphere: '光泄漏 / 薄雾 / 光束', player: '播放图标与歌曲进度', title: '歌名与歌手信息', text: '自由输入文字 · 多行排版' };
const timecode = (time: number, withFrames = false, fps = 30) => {
  const safe = Math.max(0, Number.isFinite(time) ? time : 0);
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(Math.floor(safe % 60)).padStart(2, '0');
  return `${mm}:${ss}${withFrames ? `:${String(Math.floor(safe % 1 * fps)).padStart(2, '0')}` : ''}`;
};
const lrcTime = (time: number) => { const centiseconds = Math.round(Math.max(0, time) * 100); return `${timecode(Math.floor(centiseconds / 100))}.${String(centiseconds % 100).padStart(2, '0')}`; };
const downloadText = (text: string, filename: string, mime = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const withAudio = (project: DemoProject, asset: MediaAsset): DemoProject => {
  const duration = clamp(Math.max(asset.duration ?? project.duration, ...project.layers.filter(layer => layer.type === 'video').map(layer => layer.end)), .1, 3600);
  return { ...project, audio: asset, duration, layers: project.layers.map(layer => layer.type === 'video' ? layer : ({ ...layer,
    start: Math.min(layer.start, Math.max(0, duration - .1)),
    end: Math.abs(layer.end - project.duration) < .2 ? duration : Math.min(layer.end, duration),
  })) };
};
// Demo audio only fills snapshots that did not yet have music.
const withInitialAudio = (project: DemoProject, asset: MediaAsset): DemoProject => project.audio ? project : withAudio(project, asset);
function readStoredProject(): DemoProject | null {
  try {
    const saved = localStorage.getItem('visiki-project-v1') ?? localStorage.getItem('echo-project-v1');
    if (saved) return validateProject(JSON.parse(saved));
  } catch { /* Editing works without local storage. */ }
  return null;
}
const parameterKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const EFFECT_DRAG_MIME = 'application/x-visiki-effect';
const ParameterHistoryContext = createContext({
  begin: (_owner: string) => {},
  preview: (_owner: string, change: () => void) => change(),
  end: (_owner?: string) => {},
});

function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props}>{children}</button>;
}
function IconButton({ children, label, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button className={`icon-button${active ? ' is-active' : ''}`} title={label} aria-label={label} {...props}>{children}</button>;
}
function NumberField({ label, value, onChange, min, max, step = 1, suffix, disabled }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean }) {
  return <label className="number-field"><span>{label}</span><input aria-label={`${label}数值`} type="number" disabled={disabled} value={Math.round(value * 100) / 100} min={min} max={max} step={step} onChange={e => {
    if (e.target.value !== '') { const next = Number(e.target.value); if (Number.isFinite(next)) onChange(clamp(next, min ?? -100000, max ?? 100000)); }
  }} />{suffix && <small>{suffix}</small>}</label>;
}
function DurationField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  const focused = useRef(false); const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(Math.round(value * 100) / 100)); }, [value]);
  return <label className="number-field duration-field"><span>工程时长</span><input aria-label="工程时长数值" type="number" min={.1} max={3600} step={.1} value={draft} onFocus={() => { focused.current = true; cancelled.current = false; }} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); } }} onBlur={event => { focused.current = false; if (cancelled.current) { setDraft(String(Math.round(value * 100) / 100)); return; } const number = Number(event.currentTarget.value); const next = event.currentTarget.value !== '' && Number.isFinite(number) ? clamp(number, .1, 3600) : value; setDraft(String(Math.round(next * 100) / 100)); if (next !== value) onCommit(next); }} /><small>秒</small></label>;
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return <label className="color-field"><span>{label}</span><div><input type="color" aria-label={label} value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'} onChange={e => onChange(e.target.value)} /><code>{value.toUpperCase()}</code></div></label>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="toggle-field"><span>{label}</span><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><i /></label>;
}
function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className={`modal${wide ? ' modal-wide' : ''}`}>
    <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div>{children}
  </section></div>;
}

export default function App({ incomingAudio, incomingAudioSignal, onAudioImported }: {
  incomingAudio?: MediaAsset | null; incomingAudioSignal?: AbortSignal; onAudioImported?: (asset: MediaAsset) => void;
} = {}) {
  const { active, topInset } = useWorkspace();
  const activeRef = useRef(active); activeRef.current = active;
  const [restoredProject] = useState(readStoredProject);
  const [project, setProject] = useState<DemoProject>(() => restoredProject ?? createDefaultProject());
  const projectRef = useRef(project); projectRef.current = project;
  const history = useRef<{ past: DemoProject[]; future: DemoProject[] }>({ past: [], future: [] });
  const parameterEdit = useRef<{ owner: string; before: DemoProject } | null>(null);
  const previewingParameter = useRef(false);
  const initialAudioAsset = useRef<MediaAsset | null>(null);
  const initialAudioAllowed = useRef(!incomingAudio);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    (restoredProject ? restoredProject.layers.find(layer => !layer.locked) : project.layers.find(layer => layer.type === 'disc'))?.id ?? null);
  const [leftTab, setLeftTab] = useState<'assets' | 'layers' | 'components' | 'effects' | 'templates'>('assets');
  const [inspectorTab, setInspectorTab] = useState<'layer' | 'effects' | 'project'>('layer');
  const [effectSearch, setEffectSearch] = useState('');
  const [effectCategory, setEffectCategory] = useState('全部');
  const [effectClipboard, setEffectClipboard] = useState<LayerEffect[]>([]);
  const [effectDropTarget, setEffectDropTarget] = useState<string | null>(null);
  const draggedEffectType = useRef<EffectType | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [time, setTime] = useState(0); const timeRef = useRef(0);
  const [volume, setVolume] = useState(0.72);
  const volumeRef = useRef(volume); volumeRef.current = volume;
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const analyzedAudioUrl = useRef('');
  const [analysisStatus, setAnalysisStatus] = useState('正在准备演示音乐…');
  const [busyMedia, setBusyMedia] = useState<'audio' | 'image' | 'video' | null>(null);
  const [busyFont, setBusyFont] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsTab, setLyricsTab] = useState<'search' | 'edit'>('search');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'netease' | 'qq'>('netease');
  const [songs, setSongs] = useState<SongResult[]>([]);
  const [songStatus, setSongStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [searchError, setSearchError] = useState('');
  const [pickedSong, setPickedSong] = useState<SongResult | null>(null);
  const [lyricsResult, setLyricsResult] = useState<LyricsResult | null>(null);
  const [lyricStatus, setLyricStatus] = useState<'idle' | 'loading' | 'done' | 'empty' | 'error'>('idle');
  const [lyricError, setLyricError] = useState('');
  const lyricRequest = useRef(0);
  const [applySongInfo, setApplySongInfo] = useState(true);
  const [encoding, setEncoding] = useState('utf-8');
  const lyricImportMode = useRef<'original' | 'translation'>('original');
  const [showExport, setShowExport] = useState(false);
  const [exportResolution, setExportResolution] = useState('720');
  const [exportRange, setExportRange] = useState<'all' | 'clip'>('all');
  const [exportStart, setExportStart] = useState(0);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState('');
  const [exportUrl, setExportUrl] = useState('');
  const exportAbort = useRef<AbortController | null>(null);
  // Random epoch prevents a stale revision from matching after an editor reload.
  const agentRevision = useRef({ project, value: 0 });
  if (!agentRevision.current.value) agentRevision.current.value = parseInt(crypto.randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1;
  const agentJobs = useRef(new Map<string, ExportProgress & { revision: number }>());
  const agentExecute = useRef<(command: AgentCommand) => Promise<unknown>>(async () => { throw new Error('编辑器正在初始化'); });
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [edgeTool, setEdgeTool] = useState<'trim' | 'stretch'>('trim');
  const [snapping, setSnapping] = useState(true);
  const [help, setHelp] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const editorLayout = useEditorLayout(sideCollapsed, topInset);
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const fontImportTarget = useRef<{ layerId: string; slot: 'fontId' | 'translationFontId' } | null>(null);
  const lyricInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const resourcesRef = useRef<SceneResources>({ cover: null, images: new Map(), videos: new Map(), analysis: null });
  const getTemplateResources = useCallback(() => resourcesRef.current, []);
  const fontsRevision = useRef(0);
  const transportAnchor = useRef({ time: 0, wall: 0 });
  const videoRevision = useRef(0);
  const [videoLoading, setVideoLoading] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 720, height: 405 });
  const [dragging, setDragging] = useState(false);
  const selected = project.layers.find(layer => layer.id === selectedId) ?? null;
  const selectedAudio = selectedId === AUDIO_TRACK_ID;
  const selectedEffectTarget = selectedAudio ? { id: AUDIO_TRACK_ID, name: '主音轨', effects: project.audioEffects ?? [], locked: false } : selected;
  const selectedVideoAsset = selected?.type === 'video' ? project.videos?.find(asset => asset.id === selected.params.videoId) : undefined;
  const libraryImages = useMemo(() => {
    const assets = new Map<string, MediaAsset>();
    for (const asset of [...(project.images ?? []), ...(project.cover ? [project.cover] : [])]) assets.set(asset.id, asset);
    return [...assets.values()];
  }, [project.images, project.cover]);
  const fontLoadKey = project.layers.filter(layer => ['lyrics', 'title', 'text'].includes(layer.type)).map(layer => `${layer.id}:${String(layer.params.fontId ?? '')}:${String(layer.params.translationFontId ?? '')}:${layer.visible}:${layer.opacity > 0}:${String(layer.params.mode ?? '')}:${layer.type === 'text' && !!String(layer.params.text ?? '').trim()}`).join('|') + `|lyrics:${project.lyrics.some(cue => !!cue.text.trim())}:${project.lyrics.some(cue => !!cue.translation?.trim())}`;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const exportBusy = !!exportAbort.current;
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), error ? 7500 : 4000);
  }, []);
  const finishParameterEdit = useCallback((owner?: string) => {
    const edit = parameterEdit.current;
    if (!edit || (owner && owner !== edit.owner)) return;
    parameterEdit.current = null;
    if (JSON.stringify(edit.before) === JSON.stringify(projectRef.current)) return;
    history.current.past.push(edit.before);
    if (history.current.past.length > 75) history.current.past.shift();
    history.current.future = []; setHistoryVersion(v => v + 1);
  }, []);
  const beginParameterEdit = useCallback((owner: string) => {
    if (parameterEdit.current?.owner === owner) return;
    finishParameterEdit();
    parameterEdit.current = { owner, before: clone(projectRef.current) };
  }, [finishParameterEdit]);
  const previewParameterEdit = useCallback((owner: string, change: () => void) => {
    beginParameterEdit(owner);
    previewingParameter.current = true;
    try { change(); } finally { previewingParameter.current = false; }
  }, [beginParameterEdit]);
  const parameterHistory = useMemo(() => ({ begin: beginParameterEdit, preview: previewParameterEdit, end: finishParameterEdit }), [beginParameterEdit, previewParameterEdit, finishParameterEdit]);
  const commit = useCallback((change: (current: DemoProject) => DemoProject, record = true) => {
    if (record && !previewingParameter.current) finishParameterEdit();
    const current = projectRef.current;
    const next = change(current);
    if (next === current) return;
    if (record && !previewingParameter.current) {
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      history.current.past.push(clone(current)); if (history.current.past.length > 75) history.current.past.shift(); history.current.future = []; setHistoryVersion(v => v + 1);
    }
    projectRef.current = next; setProject(next);
  }, [finishParameterEdit]);
  const updateLayer = useCallback((id: string, patch: Partial<Layer>, record = true) => {
    commit(current => ({ ...current, layers: current.layers.map(layer => layer.id === id ? { ...layer, ...patch } : layer) }), record);
  }, [commit]);
  const changeLayerEffects = (id: string, change: (effects: LayerEffect[]) => LayerEffect[]) => {
    const audioTarget = id === AUDIO_TRACK_ID;
    const target = audioTarget ? { id: AUDIO_TRACK_ID, name: '主音轨', effects: projectRef.current.audioEffects ?? [], locked: false } : projectRef.current.layers.find(layer => layer.id === id);
    if (!target) return;
    if (target.locked) { notify('请先解锁目标轨道，再编辑效果。', true); return; }
    const effects = change(target.effects ?? []);
    if (effects.length > MAX_LAYER_EFFECTS) { notify(`每个轨道最多添加 ${MAX_LAYER_EFFECTS} 个效果，请先删除部分效果。`, true); return; }
    if (effects.some(effect => !effectSupportsTarget(effect.type, audioTarget ? 'audio' : 'visual'))) { notify('主音轨仅支持音频淡入淡出效果，本次修改未应用。', true); return; }
    if (audioTarget) commit(current => ({ ...current, audioEffects: effects }));
    else updateLayer(id, { effects });
  };
  const appendLayerEffect = (type: EffectType, id = selectedId) => {
    const audioTarget = id === AUDIO_TRACK_ID;
    const target = audioTarget ? { id: AUDIO_TRACK_ID, name: '主音轨', effects: projectRef.current.audioEffects ?? [], locked: false } : projectRef.current.layers.find(layer => layer.id === id);
    if (!target) { notify('请先选择一个轨道，或将效果拖入目标轨道。'); return; }
    if (!effectSupportsTarget(type, audioTarget ? 'audio' : 'visual')) { notify('此效果用于画面轨道；主音轨可添加“淡入淡出”来调整音乐音量。', true); return; }
    if (target.locked) { notify('目标轨道已锁定，请解锁后再添加效果。', true); return; }
    if ((target.effects?.length ?? 0) >= MAX_LAYER_EFFECTS) { notify(`每个轨道最多添加 ${MAX_LAYER_EFFECTS} 个效果。`, true); return; }
    changeLayerEffects(target.id, effects => [...effects, makeEffect(type)]);
    setSelectedId(target.id); setInspectorTab('effects');
    notify(`已将${EFFECT_DEFINITIONS.find(item => item.type === type)?.name ?? '效果'}添加到「${target.name}」。`);
  };
  const pasteLayerEffects = () => {
    if (!selectedEffectTarget || !effectClipboard.length) return;
    if (selectedEffectTarget.locked) { notify('请先解锁目标轨道，再粘贴效果。', true); return; }
    if (effectClipboard.some(effect => !effectSupportsTarget(effect.type, selectedAudio ? 'audio' : 'visual'))) { notify('复制的效果中包含主音轨不支持的画面效果，本次没有粘贴。请单独复制淡入淡出效果。', true); return; }
    if ((selectedEffectTarget.effects?.length ?? 0) + effectClipboard.length > MAX_LAYER_EFFECTS) { notify(`粘贴后将超过 ${MAX_LAYER_EFFECTS} 个效果，请先删除部分效果。`, true); return; }
    changeLayerEffects(selectedEffectTarget.id, effects => [...effects, ...cloneEffects(effectClipboard)]);
    notify(`已向「${selectedEffectTarget.name}」追加 ${effectClipboard.length} 个效果。`);
  };
  const effectDragOver = (event: ReactDragEvent<HTMLElement>, id: string, locked = false) => {
    if (!event.dataTransfer.types.includes(EFFECT_DRAG_MIME)) return;
    event.preventDefault(); event.stopPropagation();
    // Keep the drop event available so incompatible targets can explain rejection.
    event.dataTransfer.dropEffect = 'copy';
    setEffectDropTarget(locked || (draggedEffectType.current && !effectSupportsTarget(draggedEffectType.current, id === AUDIO_TRACK_ID ? 'audio' : 'visual')) ? null : id);
  };
  const dropLayerEffect = (event: ReactDragEvent<HTMLElement>, id: string) => {
    if (!event.dataTransfer.types.includes(EFFECT_DRAG_MIME)) return;
    event.preventDefault(); event.stopPropagation(); setEffectDropTarget(null);
    const type = EFFECT_DEFINITIONS.find(item => item.type === event.dataTransfer.getData(EFFECT_DRAG_MIME))?.type;
    if (type) appendLayerEffect(type, id);
  };
  const timelineControls = useTimelineControls({
    zoom: timelineZoom, setZoom: setTimelineZoom,
    onReorder: (sourceId, targetId, placement) => commit(current => {
      const layers = reorderTimelineLayer(current.layers, sourceId, targetId, placement);
      return layers === current.layers ? current : { ...current, layers };
    }),
  });
  const updateParams = (patch: Record<string, string | number | boolean>) => {
    if (!selected) return;
    commit(current => ({ ...current, layers: current.layers.map(layer => layer.id === selected.id ? {
      ...layer, params: layer.type === 'lyrics' ? updateLyricStyles(normalizeLyricFonts(layer.params), patch) : { ...layer.params, ...patch },
    } : layer) }));
  };
  const undo = useCallback(() => {
    finishParameterEdit();
    const previous = history.current.past.pop(); if (!previous) return;
    history.current.future.push(clone(projectRef.current)); projectRef.current = previous; setProject(previous); setHistoryVersion(v => v + 1);
  }, [finishParameterEdit]);
  const redo = useCallback(() => {
    finishParameterEdit();
    const next = history.current.future.pop(); if (!next) return;
    history.current.past.push(clone(projectRef.current)); projectRef.current = next; setProject(next); setHistoryVersion(v => v + 1);
  }, [finishParameterEdit]);
  const syncAudio = useCallback((value: number, shouldPlay: boolean) => {
    const audio = audioRef.current; const asset = projectRef.current.audio;
    if (!audio || !asset) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : asset.duration ?? Infinity;
    const audioEnd = Math.min(projectRef.current.duration, duration);
    audio.volume = clamp(volumeRef.current * audioGainAtTime(projectRef.current.audioEffects ?? [], value, audioEnd), 0, 1);
    const inRange = value < duration - .001;
    if (Number.isFinite(duration) && Math.abs(audio.currentTime - Math.min(value, duration)) > .12) {
      try { audio.currentTime = Math.min(value, duration); } catch { /* Metadata is still loading. */ }
    }
    if (shouldPlay && inRange && activeRef.current) { if (audio.paused) void audio.play().catch(() => {}); }
    else if (!audio.paused) audio.pause();
  }, []);
  const seek = useCallback((next: number) => {
    const value = clamp(next, 0, projectRef.current.duration);
    transportAnchor.current = { time: value, wall: performance.now() };
    timeRef.current = value; setTime(value);
    syncAudio(value, playingRef.current);
  }, [syncAudio]);
  const pause = useCallback(() => {
    if (playingRef.current) {
      const value = clamp(transportAnchor.current.time + (performance.now() - transportAnchor.current.wall) / 1000, 0, projectRef.current.duration);
      timeRef.current = value; setTime(value); transportAnchor.current = { time: value, wall: performance.now() };
    }
    audioRef.current?.pause(); playingRef.current = false; setPlaying(false);
  }, []);
  const togglePlay = useCallback(async () => {
    if (!activeRef.current) return;
    if (playingRef.current) { pause(); return; }
    if (timeRef.current >= projectRef.current.duration - .02) seek(0);
    transportAnchor.current = { time: timeRef.current, wall: performance.now() };
    playingRef.current = true; setPlaying(true); syncAudio(timeRef.current, true);
  }, [pause, seek, syncAudio]);
  useEffect(() => {
    if (!active) { finishParameterEdit(); pause(); }
  }, [active, finishParameterEdit, pause]);
  const applyTemplate = useCallback((id: string, options: TemplateApplyOptions) => {
    try {
      const next = applyProjectTemplate(projectRef.current, id, options);
      pause(); commit(() => next);
      setSelectedId(next.layers.find(layer => layer.type === 'lyrics')?.id ?? next.layers.find(layer => !layer.locked)?.id ?? null);
      setInspectorTab('layer');
      notify(`已应用“${PROJECT_TEMPLATES.find(template => template.id === id)?.name ?? '预设'}”，可一键撤销。`);
    } catch (error) { notify(errorText(error), true); }
  }, [commit, notify, pause]);
  const saveProject = useCallback(() => { finishParameterEdit(); downloadText(JSON.stringify(projectRef.current, null, 2), `${projectRef.current.title || '未命名工程'}.visiki.json`); notify('工程已保存。素材引用本机文件服务，换设备时请重新导入素材。'); }, [finishParameterEdit, notify]);
  const duplicateLayer = useCallback(() => {
    const layer = selectedRef.current; if (!layer) return;
    const copy = { ...clone(layer), ...(layer.effects ? { effects: cloneEffects(layer.effects) } : {}), id: crypto.randomUUID(), name: `${layer.name} 副本`, x: layer.x + 32, y: layer.y + 32, locked: false };
    commit(current => ({ ...current, layers: [...current.layers, copy] })); setSelectedId(copy.id);
  }, [commit]);
  const deleteLayer = useCallback(() => {
    const layer = selectedRef.current; if (!layer) return;
    if (layer.locked) { notify('请先解锁该组件。'); return; }
    commit(current => ({ ...current, layers: current.layers.filter(item => item.id !== layer.id) })); setSelectedId(null);
  }, [commit, notify]);
  const addLayer = (type: LayerType) => {
    if (type === 'video') { videoInput.current?.click(); setLeftTab('assets'); return; }
    const layer = makeLayer(type, project.duration);
    if (type === 'text') { layer.x = project.width / 2; layer.y = project.height / 2; layer.width = Math.min(800, project.width * .75); layer.height = Math.min(240, project.height * .5); }
    if (type === 'particles' || type === 'atmosphere') {
      layer.x = project.width / 2; layer.y = project.height / 2; layer.width = project.width; layer.height = project.height;
      const maxSeed = type === 'atmosphere' ? ATMOSPHERE_LIMITS.seed[1] : PARTICLE_LIMITS.seed[1];
      const seeds = new Set(project.layers.filter(item => item.type === type).map(item => Number(item.params.seed)));
      let seed = 1 + parseInt(layer.id.replaceAll('-', '').slice(0, 8), 16) % maxSeed;
      while (seeds.has(seed)) seed = seed % maxSeed + 1;
      layer.params.seed = seed;
    }
    commit(current => {
      if (type !== 'particles' && type !== 'atmosphere') return { ...current, layers: [...current.layers, layer] };
      const index = current.layers.reduce((position, item, itemIndex) => item.type === 'background' ? itemIndex + 1 : position, 0);
      return { ...current, layers: [...current.layers.slice(0, index), layer, ...current.layers.slice(index)] };
    }); setSelectedId(layer.id); setInspectorTab('layer'); setLeftTab('layers');
  };
  const addImageLayer = (asset: MediaAsset) => {
    const layer = makeLayer('image', project.duration);
    const offset = project.layers.filter(item => item.type === 'image').length % 6 * 48;
    layer.name = asset.name.replace(/\.[^.]+$/, '');
    layer.x = project.width / 2 + offset; layer.y = project.height / 2 + offset;
    layer.width = 560; layer.height = 560;
    layer.params = { ...layer.params, imageId: asset.id };
    commit(current => ({ ...current, layers: [...current.layers, layer] }));
    setSelectedId(layer.id); setInspectorTab('layer');
  };
  const useImageFor = (asset: MediaAsset, type: 'background' | 'image') => {
    let targetId = '';
    commit(current => {
      const target = current.layers.find(layer => layer.type === type);
      const next = target ?? { ...makeLayer(type, current.duration), ...(type === 'background' ? { x: current.width / 2, y: current.height / 2, width: current.width, height: current.height } : {}) };
      targetId = next.id;
      const updated = { ...next, params: { ...next.params, imageId: asset.id, followCover: false, ...(type === 'background' ? { backgroundType: 'image' } : {}) } };
      return { ...current, layers: target ? current.layers.map(layer => layer.id === target.id ? updated : layer) : type === 'background' ? [updated, ...current.layers] : [...current.layers, updated] };
    });
    setSelectedId(targetId); setInspectorTab('layer');
  };
  const useVideoForBackground = (asset: MediaAsset) => {
    let targetId = '';
    commit(current => {
      const target = current.layers.find(layer => layer.type === 'background');
      const next = target ?? { ...makeLayer('background', current.duration), x: current.width / 2, y: current.height / 2, width: current.width, height: current.height };
      targetId = next.id;
      const updated = { ...next, params: { ...next.params, backgroundType: 'video', videoId: asset.id } };
      // Background footage fills its existing timeline span, regardless of source duration.
      return { ...current, layers: target ? current.layers.map(layer => layer.id === target.id ? updated : layer) : [updated, ...current.layers] };
    });
    setSelectedId(targetId); setInspectorTab('layer');
  };
  const addVideoLayer = (asset: MediaAsset) => {
    const sourceDuration = Math.min(asset.duration ?? 0, 3600 - timeRef.current);
    if (sourceDuration < 1 / projectRef.current.fps) { notify((asset.duration ?? 0) < 1 / projectRef.current.fps ? '视频短于一工程帧，无法加入当前帧率工程。' : '播放头已到最大工程时长，请先向前定位。', true); return; }
    const layer = makeLayer('video', projectRef.current.duration);
    layer.name = asset.name.replace(/\.[^.]+$/, '');
    layer.x = projectRef.current.width / 2; layer.y = projectRef.current.height / 2;
    layer.width = projectRef.current.width; layer.height = projectRef.current.height;
    layer.start = timeRef.current; layer.end = layer.start + sourceDuration;
    layer.params = { ...layer.params, videoId: asset.id, sourceIn: 0, sourceOut: sourceDuration, playbackRate: 1, reverse: false, fit: 'stretch' };
    commit(current => ({ ...current, duration: Math.max(current.duration, layer.end), layers: [...current.layers, layer] }));
    setSelectedId(layer.id); setInspectorTab('layer');
  };
  const changeVideo = useCallback((id: string, change: (layer: Layer, asset: MediaAsset, current: DemoProject) => Layer, record = true) => {
    commit(current => {
      const layer = current.layers.find(item => item.id === id);
      const asset = current.videos?.find(item => item.id === layer?.params.videoId);
      if (!layer || layer.type !== 'video' || !asset) return current;
      const updated = change(layer, asset, current);
      // A drag can temporarily lengthen a clip. Keep only the final gesture's
      // required extension, rather than retaining the longest intermediate value.
      const baselineDuration = parameterEdit.current?.before.duration ?? current.duration;
      const duration = Math.max(baselineDuration, updated.end, ...current.layers.filter(item => item.id !== id).map(item => item.end));
      return { ...current, duration, layers: current.layers.map(item => item.id === id ? updated : item) };
    }, record);
  }, [commit]);
  const moveLayerInTimeline = useCallback((id: string, start: number, record = true, initial?: Layer) => {
    commit(current => {
      const layer = current.layers.find(item => item.id === id);
      if (!layer || layer.locked) return current;
      const updated = moveLayer(initial ?? layer, start, current.fps);
      const baselineDuration = parameterEdit.current?.before.duration ?? current.duration;
      const duration = Math.max(baselineDuration, updated.end, ...current.layers.filter(item => item.id !== id).map(item => item.end));
      return { ...current, duration, layers: current.layers.map(item => item.id === id ? updated : item) };
    }, record);
  }, [commit]);
  const pickChromaColor = async () => {
    const EyeDropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropper) return;
    try { const result = await new EyeDropper().open(); updateParams({ chromaColor: result.sRGBHex }); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) notify(errorText(error), true); }
  };
  const splitSelectedVideo = useCallback(() => {
    const layer = selectedRef.current; if (!layer || layer.type !== 'video' || layer.locked) return;
    const current = projectRef.current; const asset = current.videos?.find(item => item.id === layer.params.videoId); if (!asset) return;
    const parts = splitVideoLayer(layer, timeRef.current, asset, current.fps);
    if (!parts) { notify('请将播放头置于视频片段内部后分割。'); return; }
    commit(value => ({ ...value, layers: value.layers.flatMap(item => item.id === layer.id ? parts : [item]) }));
    setSelectedId(parts[1].id);
  }, [commit, notify]);
  const reorderLayer = (id: string, direction: -1 | 1) => {
    commit(current => { const layers = [...current.layers]; const index = layers.findIndex(item => item.id === id); const next = index + direction; if (next < 0 || next >= layers.length) return current; [layers[index], layers[next]] = [layers[next], layers[index]]; return { ...current, layers }; });
  };

  useEffect(() => {
    if (restoredProject) {
      notify('已恢复上次工程。素材无法读取时，可重新导入。'); return;
    }
    if (!initialAudioAllowed.current) return;
    let cancelled = false;
    loadDemoAudio().then(asset => {
      if (cancelled || !initialAudioAllowed.current) return;
      initialAudioAsset.current = asset;
      history.current.past = history.current.past.map(snapshot => withInitialAudio(snapshot, asset));
      history.current.future = history.current.future.map(snapshot => withInitialAudio(snapshot, asset));
      if (parameterEdit.current) parameterEdit.current.before = withInitialAudio(parameterEdit.current.before, asset);
      const initialized = withInitialAudio(projectRef.current, asset);
      projectRef.current = initialized; setProject(initialized);
    }).catch(error => { if (!cancelled && initialAudioAllowed.current) { setAnalysisStatus('演示音频未加载'); notify(errorText(error), true); } });
    return () => { cancelled = true; };
  }, [restoredProject, notify]);
  useEffect(() => {
    if (!active || !incomingAudio || incomingAudioSignal?.aborted || busyMedia) return;
    initialAudioAllowed.current = false;
    if (projectRef.current.audio?.id !== incomingAudio.id) {
      pause();
      commit(current => withAudio(current, incomingAudio));
    }
    onAudioImported?.(incomingAudio);
    notify('混音已导入主音轨，可按 Ctrl+Z 撤销。');
  }, [active, incomingAudio, incomingAudioSignal, onAudioImported, busyMedia, commit, notify, pause]);
  useEffect(() => {
    const timeout = setTimeout(() => { try { localStorage.setItem('visiki-project-v1', JSON.stringify(project)); } catch { /* Saving a JSON file remains available. */ } }, 600);
    return () => clearTimeout(timeout);
  }, [project]);
  useEffect(() => { if (timeRef.current > project.duration) { pause(); seek(project.duration); } }, [project.duration, pause, seek]);
  useEffect(() => { syncAudio(timeRef.current, playingRef.current); }, [volume, project.audioEffects, project.duration, project.audio?.duration, syncAudio]);
  useEffect(() => {
    let cancelled = false; const context = new AudioContext();
    pause(); seek(0); resourcesRef.current.analysis = null; analyzedAudioUrl.current = ''; setAnalysis(null);
    if (!project.audio?.url) { setAnalysisStatus('等待导入音乐'); void context.close(); return; }
    setAnalysisStatus('正在分析真实音频频谱…');
    (async () => {
      const response = await fetch(project.audio!.url); if (!response.ok) throw new Error('工程音乐读取失败，请重新导入音乐。');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      const result = await analyzeAudio(buffer, progress => { if (!cancelled) setAnalysisStatus(`正在分析频谱 ${Math.round(progress * 100)}%`); });
      if (!cancelled) { resourcesRef.current.analysis = result; analyzedAudioUrl.current = project.audio!.url; setAnalysis(result); setAnalysisStatus('音频分析完成'); }
    })().catch(error => { if (!cancelled) { setAnalysisStatus('音频分析失败'); notify(errorText(error), true); } }).finally(() => { void context.close(); });
    return () => { cancelled = true; };
  }, [project.audio?.url, notify, pause, seek]);
  useEffect(() => {
    let cancelled = false;
    const loaded = new Map<string, CanvasImageSource>();
    for (const asset of libraryImages) {
      const cached = resourcesRef.current.images?.get(asset.id);
      if (cached) loaded.set(asset.id, cached);
    }
    resourcesRef.current.images = loaded;
    resourcesRef.current.cover = project.cover ? loaded.get(project.cover.id) ?? null : null;
    for (const asset of libraryImages) {
      if (loaded.has(asset.id)) continue;
      const image = new window.Image();
      image.onload = () => {
        if (cancelled) return;
        // Publish a new map so a paused preview also redraws when an image arrives.
        resourcesRef.current.images = new Map(resourcesRef.current.images).set(asset.id, image);
        if (asset.id === project.cover?.id) resourcesRef.current.cover = image;
      };
      image.onerror = () => { if (!cancelled) notify(`图片读取失败，请重新导入：${asset.name}`, true); };
      image.src = asset.url;
    }
    return () => { cancelled = true; };
  }, [libraryImages, project.cover?.id, notify]);
  useEffect(() => {
    let cancelled = false;
    loadProjectFonts(projectRef.current).catch(error => { if (!cancelled) notify(errorText(error), true); }).finally(() => { if (!cancelled) fontsRevision.current++; });
    return () => { cancelled = true; };
  }, [project.fonts, fontLoadKey, notify]);
  useEffect(() => {
    if (!active) return;
    const target = monitorRef.current; if (!target) return;
    const observer = new ResizeObserver(() => { const width = Math.max(1, target.clientWidth - 48); const height = Math.max(1, target.clientHeight - 40); const ratio = project.width / project.height; const stageWidth = Math.min(width, height * ratio); setStageSize({ width: stageWidth, height: stageWidth / ratio }); });
    observer.observe(target); return () => observer.disconnect();
  }, [active, sideCollapsed, project.width, project.height]);
  useEffect(() => {
    if (!active) return;
    let handle = 0; let previous = 0;
    let lastProject: DemoProject | null = null; let lastTime = -1;
    let lastCover: CanvasImageSource | null = null; let lastImages: SceneResources['images']; let lastAnalysis: AudioAnalysis | null = null; let lastFontsRevision = -1; let lastVideoRevision = -1;
    const pool = new VideoFramePool(); const controller = new AbortController();
    let preparing = false; let requestedProject: DemoProject | null = null; let requestedTime = -1; let failedProject: DemoProject | null = null;
    const frame = (now: number) => {
      handle = requestAnimationFrame(frame); if (now - previous < 1000 / 30 - 1) return; previous = now;
      if (playingRef.current) {
        const next = Math.min(projectRef.current.duration, transportAnchor.current.time + (now - transportAnchor.current.wall) / 1000);
        timeRef.current = next; setTime(next); syncAudio(next, true);
        if (next >= projectRef.current.duration) { playingRef.current = false; setPlaying(false); audioRef.current?.pause(); }
      }
      const canvas = canvasRef.current; if (!canvas) return;
      const current = projectRef.current; if (canvas.width !== current.width || canvas.height !== current.height) { canvas.width = current.width; canvas.height = current.height; }
      const resources = resourcesRef.current;
      if (!preparing && (requestedProject !== current || requestedTime !== timeRef.current) && failedProject !== current) {
        requestedProject = current; requestedTime = timeRef.current; preparing = true;
        const hasVideo = current.layers.some(layer => layer.type === 'video' && layer.visible && layer.opacity > 0 && timeRef.current >= layer.start && timeRef.current < layer.end);
        setVideoLoading(hasVideo);
        pool.prepare(current, timeRef.current, controller.signal).then(videos => {
          if (!controller.signal.aborted) { resourcesRef.current.videos = videos; videoRevision.current++; }
        }).catch(error => { if (!controller.signal.aborted) { failedProject = current; notify(`视频预览读取失败：${errorText(error)}`, true); } }).finally(() => {
          preparing = false; if (!controller.signal.aborted) setVideoLoading(false);
        });
      }
      if (lastProject === current && lastTime === timeRef.current && lastCover === resources.cover && lastImages === resources.images && lastAnalysis === resources.analysis && lastFontsRevision === fontsRevision.current && lastVideoRevision === videoRevision.current) return;
      const ctx = canvas.getContext('2d'); if (ctx) {
        renderScene(ctx, current, timeRef.current, resources, { editor: false });
        lastProject = current; lastTime = timeRef.current; lastCover = resources.cover; lastImages = resources.images; lastAnalysis = resources.analysis; lastFontsRevision = fontsRevision.current; lastVideoRevision = videoRevision.current;
      }
    };
    handle = requestAnimationFrame(frame); return () => { cancelAnimationFrame(handle); controller.abort(); pool.dispose(); };
  }, [active, notify, syncAudio]);
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement;
      if (target.closest('[data-workspace-navigation]')) return;
      const cmd = event.ctrlKey || event.metaKey;
      const projectShortcut = cmd && ['s', 'z', 'y', 'b'].includes(event.key.toLowerCase());
      const parameterControl = target.closest('[data-parameter-control="true"]');
      if ((target.closest('input,textarea,select,[contenteditable="true"]') && !(parameterControl && projectShortcut)) || showLyrics || showExport || help) return;
      if (cmd && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
      else if (cmd && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (cmd && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (cmd && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateLayer(); }
      else if (cmd && event.key.toLowerCase() === 'b') { event.preventDefault(); splitSelectedVideo(); }
      else if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteLayer(); }
      else if (event.key === 'Home') { event.preventDefault(); seek(0); }
      else if (event.key === 'Escape') setSelectedId(null);
      else if (event.key.startsWith('Arrow')) {
        event.preventDefault(); const layer = selectedRef.current;
        if (layer && !layer.locked) { const delta = event.shiftKey ? 10 : 1; updateLayer(layer.id, { x: layer.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), y: layer.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0) }); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { pause(); seek(timeRef.current + (event.key === 'ArrowRight' ? 1 : -1) / projectRef.current.fps); }
      }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [active, deleteLayer, duplicateLayer, help, pause, redo, saveProject, seek, showExport, showLyrics, splitSelectedVideo, togglePlay, undo, updateLayer]);

  async function importMedia(file: File, type: 'audio' | 'image') {
    if (type === 'image') { await importImages([file]); return; }
    setBusyMedia(type); pause();
    try {
      const asset = await uploadMedia(file, type);
      commit(current => withAudio(current, asset));
      notify(`音乐已导入：${asset.name}`);
    } catch (error) { notify(errorText(error), true); } finally { setBusyMedia(null); }
  }
  async function importImages(files: File[]) {
    if (!files.length) return;
    setBusyMedia('image');
    try {
      const results = await Promise.allSettled(files.map(file => uploadMedia(file, 'image')));
      const assets = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (assets.length) commit(current => {
        const images = new Map<string, MediaAsset>();
        for (const asset of [...(current.images ?? []), ...(current.cover ? [current.cover] : []), ...assets]) images.set(asset.id, asset);
        return { ...current, images: [...images.values()], cover: current.cover ?? assets[0], layers: current.cover ? current.layers : current.layers.map(layer => ['background', 'image'].includes(layer.type) && !layer.params.imageId ? { ...layer, params: { ...layer.params, imageId: assets[0].id, followCover: false } } : layer) };
      });
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) notify(`已导入 ${assets.length} 张图片，${failures.length} 张失败：${errorText((failures[0] as PromiseRejectedResult).reason)}`, true);
      else notify(`已导入 ${assets.length} 张图片，可从素材库添加到画布。`);
    } finally { setBusyMedia(null); }
  }
  async function importVideos(files: File[]) {
    if (!files.length) return;
    setBusyMedia('video');
    try {
      // Normalize large videos sequentially to avoid running several encoders at once.
      const assets: MediaAsset[] = []; const failures: string[] = [];
      for (const file of files) {
        try { assets.push(await uploadMedia(file, 'video')); }
        catch (error) { failures.push(`${file.name}：${errorText(error)}`); }
      }
      if (assets.length) commit(current => ({ ...current, videos: [...(current.videos ?? []), ...assets] }));
      notify(failures.length ? `已导入 ${assets.length} 个视频，${failures[0]}` : `已导入 ${assets.length} 个视频，点击“添加视频”放到当前播放头。`, failures.length > 0);
    } finally { setBusyMedia(null); }
  }
  const openFontImport = (layerId: string, slot: 'fontId' | 'translationFontId' = 'fontId') => { fontImportTarget.current = { layerId, slot }; fontInput.current?.click(); };
  async function importFonts(files: File[]) {
    if (!files.length) return;
    if ((projectRef.current.fonts?.length ?? 0) + files.length > 100) { notify('字体库最多容纳 100 款导入字体，请减少选择数量。', true); return; }
    const target = fontImportTarget.current ? { ...fontImportTarget.current } : null;
    setBusyFont(true);
    try {
      const results = await Promise.allSettled(files.map(file => uploadFont(file)));
      const assets = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (assets.length) commit(current => {
        const fonts = new Map<string, FontAsset>();
        for (const asset of [...(current.fonts ?? []), ...assets]) fonts.set(asset.id, asset);
        return { ...current, fonts: [...fonts.values()], layers: current.layers.map(layer => layer.id === target?.layerId ? { ...layer, params: { ...(layer.type === 'lyrics' ? normalizeLyricFonts(layer.params) : layer.params), [target.slot]: assets[0].id } } : layer) };
      });
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) notify(`已导入 ${assets.length} 款字体，${failures.length} 款失败：${errorText((failures[0] as PromiseRejectedResult).reason)}`, true);
      else notify(`已导入 ${assets.length} 款字体，并应用到当前文字组件。`);
    } finally { setBusyFont(false); }
  }
  async function importProject(file: File) {
    try {
      const value = validateProject(JSON.parse(await file.text()));
      initialAudioAllowed.current = false;
      pause(); commit(() => value); seek(0); setSelectedId(value.layers.find(layer => !layer.locked)?.id ?? null); notify('工程已打开。若素材显示失联，请重新导入音乐或封面。');
    } catch (error) { notify(errorText(error), true); }
  }
  async function importLyricFile(file: File) {
    try {
      const text = new TextDecoder(encoding).decode(await file.arrayBuffer());
      const cues = parseLyrics(text, file.name.toLowerCase().endsWith('.srt') ? 'srt' : 'lrc');
      if (!cues.length) throw new Error('没有找到带时间的歌词。请检查 LRC / SRT 内容与文件编码。');
      if (lyricImportMode.current === 'translation') commit(current => ({ ...current, lyrics: current.lyrics.length ? current.lyrics.map(cue => { const translation = cues.find(item => Math.abs(item.time - cue.time) <= .08); return translation ? { ...cue, translation: [translation.text, translation.translation].filter(Boolean).join('\n') } : cue; }) : cues }));
      else commit(current => ({ ...current, lyrics: cues, lyricsSource: undefined }));
      notify(`已${lyricImportMode.current === 'translation' ? '合并译文' : '导入歌词'}：${cues.length} 行`); setShowLyrics(true); setLyricsTab('edit');
    } catch (error) { notify(errorText(error), true); }
  }
  const openLyricFile = (mode: 'original' | 'translation') => { lyricImportMode.current = mode; lyricInput.current?.click(); };
  async function doSearch() {
    if (!query.trim()) return;
    lyricRequest.current++;
    setSongStatus('loading'); setSearchError(''); setPickedSong(null); setLyricsResult(null); setLyricStatus('idle');
    try { const results = await searchSongs(query.trim(), provider); setSongs(results); setSongStatus('done'); }
    catch (error) { setSongs([]); setSearchError(errorText(error)); setSongStatus('error'); }
  }
  async function selectSong(song: SongResult) {
    const token = ++lyricRequest.current;
    setPickedSong(song); setLyricsResult(null); setLyricStatus('loading'); setLyricError('');
    try { const result = await fetchLyrics(song.id, song.provider); if (token !== lyricRequest.current) return; setLyricsResult(result); setLyricStatus(result.originalLrc?.trim() && parseLyrics(result.originalLrc).length ? 'done' : 'empty'); }
    catch (error) { if (token !== lyricRequest.current) return; setLyricError(errorText(error)); setLyricStatus('error'); }
  }
  const onlinePreview = useMemo(() => lyricsResult?.originalLrc ? mergeBilingual(lyricsResult.originalLrc, lyricsResult.translatedLrc || '') : [], [lyricsResult]);
  function applyOnlineLyrics() {
    if (!lyricsResult || !onlinePreview.length) return;
    commit(current => ({ ...current, lyrics: onlinePreview, lyricsOffsetMs: 0, ...(applySongInfo && pickedSong ? { title: pickedSong.title, artist: pickedSong.artists.join(' / ') } : {}), lyricsSource: { provider: lyricsResult.provider, id: lyricsResult.id, url: lyricsResult.sourceUrl } }));
    notify(`已加入 ${onlinePreview.length} 行歌词${lyricsResult.translatedLrc ? '及同步译文' : ''}，可在“歌词校对”中调整。`); setLyricsTab('edit');
  }
  async function startExport() {
    if (exportAbort.current) { setExportError('已有导出任务正在进行。'); return; }
    if (project.audio && !analysis) { setExportError('请等待音频分析完成后再导出。'); return; }
    const start = exportRange === 'all' ? 0 : clamp(exportStart, 0, Math.max(0, project.duration - .1));
    const end = exportRange === 'all' ? project.duration : Math.min(project.duration, start + 10);
    pause(); setExportError(''); setExportUrl('');
    const controller = new AbortController(); exportAbort.current = controller;
    setExportProgress({ jobId: '', state: 'rendering', completed: 0, total: Math.ceil((end - start) * project.fps) });
    try {
      const result = await runExport(clone(project), { ...resourcesRef.current }, { width: exportResolution === '1080' ? 1920 : 1280, height: Number(exportResolution), fps: project.fps, start, end }, progress => setExportProgress(progress), controller.signal);
      setExportUrl(result.downloadUrl); setExportProgress(current => current ? { ...current, state: 'complete', completed: current.total } : current); notify('视频导出完成，可以下载 MP4。');
    } catch (error) {
      if (controller.signal.aborted) { setExportProgress(current => current ? { ...current, state: 'cancelled' } : current); }
      else { setExportError(errorText(error)); setExportProgress(current => current ? { ...current, state: 'error' } : current); }
    } finally { exportAbort.current = null; }
  }

  agentExecute.current = async command => {
    const args = command.args ?? {};
    const currentRevision = () => {
      if (agentRevision.current.project !== projectRef.current) agentRevision.current = { project: projectRef.current, value: agentRevision.current.value + 1 };
      return agentRevision.current.value;
    };
    const fail = (message: string, code = 'invalid'): never => { throw Object.assign(new Error(message), { code }); };
    const checkKeys = (keys: string[]) => { if (Object.keys(args).some(key => !keys.includes(key))) fail('命令包含未知参数'); };
    const snapshot = () => ({ project: clone(projectRef.current), revision: currentRevision(), time: timeRef.current, playing: playingRef.current, canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 });
    if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision()) fail('工程已变化，请重新读取后再编辑', 'conflict');
    if (Date.now() >= command.deadline) fail('命令已过期', 'timeout');
    const mutations = ['edit', 'apply_template', 'replace_project', 'undo', 'redo'];
    if (mutations.includes(command.type)) {
      if (dragging || parameterEdit.current) fail('正在拖动或修改参数，请结束当前操作后重试', 'busy');
    }
    switch (command.type) {
      case 'get_project': checkKeys([]); return snapshot();
      case 'catalog': {
        checkKeys([]);
        const layerTypes: LayerType[] = ['background', 'image', 'video', 'disc', 'lyrics', 'spectrum', 'player', 'title', 'text', 'particles', 'atmosphere'];
        return { templates: PROJECT_TEMPLATES, effects: EFFECT_DEFINITIONS, fonts: [...BUILTIN_FONTS, ...(projectRef.current.fonts ?? [])],
          layers: layerTypes.map(type => ({ type, name: componentNames[type], defaults: makeLayer(type, projectRef.current.duration).params })),
          operations: AGENT_OPERATION_TYPES, operationFields: AGENT_OPERATION_FIELDS, audioTargetId: 'audio', coordinates: 'pixels; x/y are layer centers; layer index 0 is the bottom',
          limits: { layers: 100, operationsPerBatch: 100, duration: 3600, undoSteps: 75 }, revision: currentRevision() };
      }
      case 'edit': {
        checkKeys(['operations']);
        const next = applyAgentOperations(projectRef.current, args.operations);
        initialAudioAllowed.current = false;
        pause(); commit(() => next); seek(Math.min(timeRef.current, next.duration));
        if (!next.layers.some(layer => layer.id === selectedId)) setSelectedId(null);
        notify('Agent 已更新工程，可一步撤销。'); return snapshot();
      }
      case 'apply_template': {
        checkKeys(['id', 'keepCustomLayers']);
        if (typeof args.id !== 'string' || (args.keepCustomLayers !== undefined && typeof args.keepCustomLayers !== 'boolean')) fail('模板参数无效');
        const next = applyProjectTemplate(projectRef.current, args.id as string, { keepCustomLayers: args.keepCustomLayers as boolean | undefined });
        initialAudioAllowed.current = false;
        pause(); commit(() => next); setSelectedId(next.layers.find(layer => layer.type === 'lyrics')?.id ?? null);
        notify('Agent 已应用模板，可一步撤销。'); return snapshot();
      }
      case 'replace_project': {
        checkKeys(['project']); const next = validateProject(args.project);
        initialAudioAllowed.current = false;
        pause(); commit(() => next); seek(0); setSelectedId(null);
        notify('Agent 已打开工程，可一步撤销。'); return snapshot();
      }
      case 'undo': checkKeys([]); pause(); undo(); seek(Math.min(timeRef.current, projectRef.current.duration)); return snapshot();
      case 'redo': checkKeys([]); pause(); redo(); seek(Math.min(timeRef.current, projectRef.current.duration)); return snapshot();
      case 'seek': {
        checkKeys(['time', 'playing']);
        if (typeof args.time !== 'number' || !Number.isFinite(args.time) || args.time < 0 || args.time > projectRef.current.duration || (args.playing !== undefined && typeof args.playing !== 'boolean')) fail('播放位置或播放状态无效');
        if (args.playing === true && !activeRef.current) fail('请先切换到剪辑工作区再开始试听', 'busy');
        pause(); seek(args.time as number); if (args.playing === true) await togglePlay();
        return { time: timeRef.current, playing: playingRef.current, revision: currentRevision() };
      }
      case 'preview': {
        checkKeys(['time', 'width', 'height']);
        const revision = currentRevision(); const source = clone(projectRef.current);
        const frame = await renderAgentPreview(source, { ...args, time: args.time ?? timeRef.current }, AbortSignal.timeout(Math.max(1, command.deadline - Date.now())), source.audio?.url === analyzedAudioUrl.current ? resourcesRef.current.analysis : null);
        return { ...frame, revision };
      }
      case 'start_export': {
        checkKeys(['width', 'height', 'fps', 'start', 'end']);
        if (exportAbort.current) fail('已有导出任务正在进行', 'busy');
        const source = clone(projectRef.current); const revision = currentRevision(); const settings = agentExportSettings(source, args);
        const id = crypto.randomUUID(); const controller = new AbortController(); exportAbort.current = controller;
        const initial: ExportProgress & { revision: number } = { jobId: id, state: 'rendering', completed: 0, total: Math.ceil((settings.end - settings.start) * settings.fps), revision };
        while (agentJobs.current.size >= 8) agentJobs.current.delete(agentJobs.current.keys().next().value!);
        agentJobs.current.set(id, initial);
        pause(); setShowExport(true); setExportError(''); setExportUrl(''); setExportProgress(initial);
        void (async () => {
          try {
            const analysis = await prepareAgentAnalysis(source, controller.signal, source.audio?.url === analyzedAudioUrl.current ? resourcesRef.current.analysis : null);
            controller.signal.throwIfAborted();
            const result = await runExport(source, { ...resourcesRef.current, analysis }, settings, progress => {
              const value = { ...progress, jobId: id, revision };
              agentJobs.current.set(id, value); setExportProgress(value);
            }, controller.signal);
            const value = { ...agentJobs.current.get(id)!, state: 'complete' as const, completed: initial.total, downloadUrl: result.downloadUrl };
            agentJobs.current.set(id, value); setExportProgress(value); setExportUrl(result.downloadUrl); notify('Agent 视频导出完成。');
          } catch (error) {
            const value = { ...agentJobs.current.get(id)!, state: controller.signal.aborted ? 'cancelled' as const : 'error' as const, message: errorText(error) };
            agentJobs.current.set(id, value); setExportProgress(value);
            if (!controller.signal.aborted) setExportError(value.message);
          } finally { if (exportAbort.current === controller) exportAbort.current = null; }
        })();
        return initial;
      }
      case 'get_export': case 'cancel_export': {
        checkKeys(['jobId']);
        if (typeof args.jobId !== 'string') fail('导出任务 ID 无效');
        const job = agentJobs.current.get(args.jobId as string); if (!job) return fail('找不到导出任务；编辑器重开后任务记录不保留', 'not_found');
        if (command.type === 'cancel_export' && ['rendering', 'encoding'].includes(job.state)) exportAbort.current?.abort();
        return { ...job };
      }
      default: return fail('不支持的 Agent 命令');
    }
  };
  useEffect(() => connectAgentEditor(command => agentExecute.current(command)), []);

  function beginTransform(event: ReactPointerEvent, layer: Layer, mode: 'move' | 'rotate' | 'resize', corner?: [number, number]) {
    event.preventDefault(); event.stopPropagation(); setSelectedId(layer.id); setInspectorTab('layer');
    finishParameterEdit();
    if (layer.locked) return;
    const stage = stageRef.current; if (!stage) return;
    const rect = stage.getBoundingClientRect(); const scale = projectRef.current.width / rect.width;
    const point = { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    const initial = clone(layer); const before = clone(projectRef.current); const audioAtStart = initialAudioAsset.current; let moved = false;
    const radians = initial.rotation * Math.PI / 180; const cos = Math.cos(radians); const sin = Math.sin(radians);
    const angle = Math.atan2(point.y - layer.y, point.x - layer.x);
    setDragging(true);
    const move = (pointer: PointerEvent) => {
      const p = { x: (pointer.clientX - rect.left) * scale, y: (pointer.clientY - rect.top) * scale };
      if (!moved && Math.hypot(p.x - point.x, p.y - point.y) < 2) return; moved = true;
      let patch: Partial<Layer> = {};
      if (mode === 'move') {
        let x = initial.x + p.x - point.x, y = initial.y + p.y - point.y;
        if (snapping && !pointer.altKey) {
          const snapX = [initial.width / 2, projectRef.current.width / 2, projectRef.current.width - initial.width / 2];
          const snapY = [initial.height / 2, projectRef.current.height / 2, projectRef.current.height - initial.height / 2];
          projectRef.current.layers.filter(item => item.id !== initial.id && item.visible).forEach(item => { snapX.push(item.x); snapY.push(item.y); });
          x = snapX.find(value => Math.abs(value - x) < 12) ?? x; y = snapY.find(value => Math.abs(value - y) < 12) ?? y;
        }
        patch = { x: Math.round(x), y: Math.round(y) };
      } else if (mode === 'rotate') {
        let rotation = initial.rotation + (Math.atan2(p.y - initial.y, p.x - initial.x) - angle) * 180 / Math.PI;
        if (pointer.shiftKey) rotation = Math.round(rotation / 15) * 15; patch = { rotation: Math.round(rotation * 10) / 10 };
      } else if (corner) {
        const dx = p.x - initial.x, dy = p.y - initial.y;
        const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos;
        const anchorX = -corner[0] * initial.width / 2, anchorY = -corner[1] * initial.height / 2;
        let width = Math.max(30, corner[0] * (localX - anchorX)); let height = Math.max(30, corner[1] * (localY - anchorY));
        if (pointer.shiftKey || initial.type === 'disc') { const ratio = initial.width / initial.height; if (width / height > ratio) height = width / ratio; else width = height * ratio; }
        const cx = anchorX + corner[0] * width / 2, cy = anchorY + corner[1] * height / 2;
        patch = { width: Math.round(width), height: Math.round(height), x: Math.round(initial.x + cx * cos - cy * sin), y: Math.round(initial.y + cx * sin + cy * cos) };
      }
      updateLayer(initial.id, patch, false);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); setDragging(false);
      if (moved) { history.current.past.push(!audioAtStart && initialAudioAsset.current ? withInitialAudio(before, initialAudioAsset.current) : before); history.current.future = []; setHistoryVersion(v => v + 1); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true });
  }
  function selectOnCanvas(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width * project.width; const y = (event.clientY - rect.top) / rect.height * project.height;
    const hit = [...project.layers].reverse().find(layer => {
      if (!layer.visible || layer.locked || time < layer.start || time > layer.end) return false;
      const a = -layer.rotation * Math.PI / 180; const dx = x - layer.x, dy = y - layer.y;
      return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= layer.width / 2 && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= layer.height / 2;
    });
    if (hit) beginTransform(event, hit, 'move'); else setSelectedId(null);
  }
  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault(); pause(); const rect = event.currentTarget.getBoundingClientRect();
    const move = (pointer: { clientX: number }) => seek((pointer.clientX - rect.left) / rect.width * project.duration);
    move(event); const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true });
  }
  function trimLayer(event: ReactPointerEvent, layer: Layer, edge: 'start' | 'end') {
    event.preventDefault(); event.stopPropagation(); if (layer.locked) return;
    pause(); setSelectedId(layer.id); setInspectorTab('layer');
    const owner = `timeline-trim-${layer.id}`; beginParameterEdit(owner);
    const lane = event.currentTarget.parentElement?.parentElement; if (!lane) return;
    const width = lane.getBoundingClientRect().width; const initialX = event.clientX; const initial = clone(layer); const before = projectRef.current;
    const stretch = layer.type === 'video' && (edgeTool === 'stretch' || event.altKey);
    const move = (pointer: PointerEvent) => {
      const next = Math.round((initial[edge] + (pointer.clientX - initialX) / width * before.duration) * before.fps) / before.fps;
      if (layer.type === 'video') changeVideo(layer.id, (_current, asset) => stretch ? stretchVideoLayer(initial, edge, next, asset, before.fps) : trimVideoLayer(initial, edge, next, asset, before.fps), false);
      else updateLayer(layer.id, { [edge]: edge === 'start' ? clamp(next, 0, layer.end - 1 / before.fps) : clamp(next, layer.start + 1 / before.fps, before.duration) }, false);
    };
    const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); finishParameterEdit(owner); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true });
  }
  function moveTimelineClip(event: ReactPointerEvent, layer: Layer) {
    if (layer.locked || (event.target as HTMLElement).closest('.trim-handle')) return;
    event.preventDefault(); event.stopPropagation(); pause(); setSelectedId(layer.id); setInspectorTab('layer');
    const lane = event.currentTarget.parentElement; if (!lane) return;
    const owner = `timeline-move-${layer.id}`; beginParameterEdit(owner);
    const initial = clone(layer); const before = projectRef.current; const width = lane.getBoundingClientRect().width; const initialX = event.clientX;
    const move = (pointer: PointerEvent) => {
      const delta = (pointer.clientX - initialX) / width * before.duration;
      let start = Math.round((initial.start + delta) * before.fps) / before.fps;
      if (snapping && !pointer.altKey) {
        const length = initial.end - initial.start; const threshold = 8 / width * before.duration;
        const targets = [0, timeRef.current, ...before.layers.filter(item => item.id !== layer.id).flatMap(item => [item.start, item.end])];
        for (const target of targets) {
          if (Math.abs(start - target) < threshold) { start = target; break; }
          if (Math.abs(start + length - target) < threshold) { start = target - length; break; }
        }
      }
      moveLayerInTimeline(layer.id, start, false, initial);
    };
    const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); finishParameterEdit(owner); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true });
  }
  const waveformPath = useMemo(() => {
    if (!analysis?.waveform.length) return '';
    const samples = analysis.waveform; const n = Math.min(400, samples.length); let d = '';
    for (let i = 0; i < n; i++) { const value = samples[Math.floor(i / n * samples.length)]; const x = i / (n - 1) * 1000; d += `M${x.toFixed(2)} ${(12 - Math.max(.8, Math.abs(value) * 11)).toFixed(2)}V${(12 + Math.max(.8, Math.abs(value) * 11)).toFixed(2)}`; }
    return d;
  }, [analysis]);
  const selectedStyle: CSSProperties | undefined = selected ? { left: `${selected.x / project.width * 100}%`, top: `${selected.y / project.height * 100}%`, width: `${selected.width / project.width * 100}%`, height: `${selected.height / project.height * 100}%`, transform: `translate(-50%,-50%) rotate(${selected.rotation}deg)` } : undefined;
  const currentCueIndex = project.lyrics.reduce((last, cue, index) => cue.time + project.lyricsOffsetMs / 1000 <= time ? index : last, -1);
  const exportPercent = exportProgress ? Math.round(exportProgress.completed / Math.max(1, exportProgress.total) * 100) : 0;
  const exportElapsed = exportProgress?.elapsedMs !== undefined ? `${(exportProgress.elapsedMs / 1000).toFixed(1)} 秒` : '';
  const exportRate = exportProgress?.framesPerSecond ? `${exportProgress.framesPerSecond.toFixed(1)} 帧/秒` : '';
  void historyVersion;

  return <ParameterHistoryContext.Provider value={parameterHistory}><div className={`editor-app${sideCollapsed ? ' sidebar-collapsed' : ''}`} style={editorLayout.editorStyle}>
    <audio ref={audioRef} src={project.audio?.url} muted={project.audioMuted === true} preload="auto" onLoadedMetadata={() => syncAudio(timeRef.current, playingRef.current)} />
    <input ref={audioInput} className="hidden-input" type="file" accept="audio/*,.flac,.wav,.mp3,.m4a,.ogg" onChange={e => { const file = e.target.files?.[0]; if (file) void importMedia(file, 'audio'); e.target.value = ''; }} />
    <input ref={imageInput} className="hidden-input" type="file" accept="image/*" multiple aria-label="导入多张图片" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void importImages(files); e.target.value = ''; }} />
    <input ref={videoInput} className="hidden-input" type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v" multiple aria-label="导入视频文件" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void importVideos(files); e.target.value = ''; }} />
    <input ref={fontInput} className="hidden-input" type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" multiple aria-label="导入字体文件" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void importFonts(files); e.target.value = ''; }} />
    <input ref={lyricInput} className="hidden-input" type="file" accept=".lrc,.srt,.txt" onChange={e => { const file = e.target.files?.[0]; if (file) void importLyricFile(file); e.target.value = ''; }} />
    <input ref={projectInput} className="hidden-input" type="file" accept=".json,.visiki,.echo" onChange={e => { const file = e.target.files?.[0]; if (file) void importProject(file); e.target.value = ''; }} />

    <header className="app-header">
      <div className="header-file-actions"><Button onClick={() => projectInput.current?.click()}><FolderOpen size={15} /><span>打开</span></Button><Button onClick={saveProject} title="保存工程 Ctrl+S"><Save size={15} /><span>保存</span></Button><i className="toolbar-divider" /><IconButton label="撤销 Ctrl+Z" disabled={!history.current.past.length} onClick={undo}><Undo2 size={17} /></IconButton><IconButton label="重做 Ctrl+Y" disabled={!history.current.future.length} onClick={redo}><Redo2 size={17} /></IconButton></div>
      <div className="project-heading"><span className="project-heading-title">{project.title || '未命名工程'}</span><span className="saved-label"><span />本地自动保存</span></div>
      <div className="header-right"><span className="project-spec">{project.width} × {project.height}<span> / </span>{project.fps} fps</span><IconButton label="快捷键与使用帮助" onClick={() => setHelp(true)}><CircleHelp size={18} /></IconButton><Button className="primary export-button" onClick={() => setShowExport(true)}>{exportBusy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}<span>{exportBusy ? `导出中 ${exportPercent}%` : '导出视频'}</span></Button></div>
    </header>

    <main className="workspace" style={editorLayout.workspaceStyle}>
      <aside className="library-panel" id="editor-panel-left">
        <div className="panel-tabs library-tabs template-navigation"><button className={leftTab === 'assets' ? 'active' : ''} onClick={() => setLeftTab('assets')}><FolderOpen size={15} />素材</button><button className={leftTab === 'components' ? 'active' : ''} onClick={() => setLeftTab('components')}><Plus size={15} />组件</button><button className={leftTab === 'templates' ? 'active' : ''} data-testid="templates-tab" onClick={() => setLeftTab('templates')}><LayoutTemplate size={15} />模板</button><button className={leftTab === 'layers' ? 'active' : ''} onClick={() => setLeftTab('layers')}><Layers3 size={15} />图层<span className="count-badge">{project.layers.length}</span></button><button className={leftTab === 'effects' ? 'active' : ''} onClick={() => setLeftTab('effects')}><Sparkles size={15} />效果</button></div>
        {leftTab === 'assets' && <div className="library-content">
          <div className="section-label">项目素材<span>本地处理</span></div>
          <button className={`import-zone${busyMedia === 'audio' ? ' busy' : ''}`} onClick={() => audioInput.current?.click()} disabled={!!busyMedia} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void importMedia(file, 'audio'); }}><span className="import-zone-icon">{busyMedia === 'audio' ? <LoaderCircle className="spin" size={22} /> : <Music2 size={22} />}</span><strong>导入音乐</strong><span>拖入音频或点击选择</span><small>MP3 · WAV · FLAC · M4A</small></button>
          {project.audio && <div className="asset-row"><div className="asset-icon audio"><AudioLines size={19} /></div><div><strong title={project.audio.name}>{project.audio.name}</strong><span>{timecode(project.audio.duration ?? project.duration)} · {project.audio.sampleRate ? `${(project.audio.sampleRate / 1000).toFixed(1)} kHz` : '主音轨'}</span></div><IconButton label="移除配乐" onClick={() => { initialAudioAllowed.current = false; pause(); commit(current => ({ ...current, audio: null })); }}><X size={13} /></IconButton></div>}
          <button className="cover-import" onClick={() => imageInput.current?.click()} disabled={!!busyMedia} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busyMedia) void importImages(Array.from(e.dataTransfer.files)); }}><div className={`cover-thumb${project.cover ? '' : ' demo-art'}`}>{project.cover ? <img src={project.cover.url} alt="项目封面" /> : <><div className="demo-moon" /><div className="demo-mountains" /></>}{busyMedia === 'image' && <LoaderCircle className="spin" size={22} />}</div><span><strong>{busyMedia === 'image' ? '正在导入图片…' : '导入图片 · 支持多选'}</strong><small>{libraryImages.length ? `${libraryImages.length} 张图片 · 背景与卡片独立选图` : '当前使用原创演示画面'}</small></span><Upload size={16} /></button>
          {libraryImages.length > 0 && <div className="image-library"><div className="section-label">图片素材<span>{libraryImages.length} 张</span></div>{libraryImages.map(asset => <article className="image-asset-card" key={asset.id} data-asset-id={asset.id}><img src={asset.url} alt={asset.name} /><div><strong title={asset.name}>{asset.name}</strong><div className="image-asset-actions"><button onClick={() => useImageFor(asset, 'background')}>用作背景</button><button onClick={() => useImageFor(asset, 'image')}>用作卡片</button><button onClick={() => addImageLayer(asset)}><Plus size={10} />添加图片</button></div></div></article>)}</div>}
          <button className={`video-import${busyMedia === 'video' ? ' busy' : ''}`} onClick={() => videoInput.current?.click()} disabled={!!busyMedia} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busyMedia) void importVideos(Array.from(e.dataTransfer.files)); }}><span>{busyMedia === 'video' ? <LoaderCircle className="spin" size={21} /> : <Clapperboard size={21} />}</span><div><strong>{busyMedia === 'video' ? '正在处理视频…' : '导入视频 · 支持多选'}</strong><small>MP4 · MOV · WEBM · MKV</small></div><Upload size={15} /></button>
          {(project.videos?.length ?? 0) > 0 && <div className="video-library"><div className="section-label">视频素材<span>{project.videos!.length} 个</span></div>{project.videos!.map(asset => <article className="video-asset-card" key={asset.id} data-asset-id={asset.id}>{asset.posterUrl ? <img src={asset.posterUrl} alt={asset.name} /> : <div className="video-asset-placeholder"><Clapperboard size={21} /></div>}<div><strong title={asset.name}>{asset.name}</strong><small>{timecode(asset.duration ?? 0)} · {asset.width} × {asset.height}</small><div className="video-asset-actions"><button onClick={() => addVideoLayer(asset)}><Plus size={11} />添加视频</button><button onClick={() => useVideoForBackground(asset)}>用作背景</button></div></div></article>)}<p className="parameter-note">添加视频可放到当前播放头；用作背景会铺满背景轨道并循环。配乐使用主音轨。</p></div>}
          <div className="section-label lyrics-label">歌词<span>{project.lyrics.length} 行已就绪</span></div>
          <button className="fetch-lyrics-card" onClick={() => { setShowLyrics(true); setLyricsTab('search'); }}><span><Search size={18} /></span><div><strong>在线获取歌词</strong><small>搜索歌名，或粘贴歌曲链接</small></div><ChevronRight size={16} /></button>
          <div className="split-actions"><Button onClick={() => openLyricFile('original')}><FileText size={14} />导入 LRC / SRT</Button><Button onClick={() => { setShowLyrics(true); setLyricsTab('edit'); }}><SlidersHorizontal size={14} />校对</Button></div>
          <div className="mini-lyric-preview"><span className="eyebrow">当前歌词</span><p>{project.lyrics[Math.max(0, currentCueIndex)]?.text ?? '尚未添加歌词'}</p><small>{project.lyrics[Math.max(0, currentCueIndex)]?.translation ?? '支持原文与译文同步显示'}</small></div>
          <div className="library-note"><ShieldCheck size={14} /><span>音乐、图片与视频保留在本机<br />仅获取歌词时连接音乐服务</span></div>
        </div>}
        {leftTab === 'components' && <div className="library-content component-library"><div className="section-label">添加到画面<span>可自由编排</span></div>{(Object.keys(componentNames) as LayerType[]).map(type => { const Icon = iconByType[type]; return <button className="component-card" key={type} onClick={() => addLayer(type)}><span className={`component-icon ${type}`}><Icon size={21} /></span><div><strong>{componentNames[type]}</strong><small>{componentHints[type]}</small></div><Plus size={15} /></button>; })}<p className="subtle-note">添加后可在预览中拖动，或在属性面板精确设置。</p></div>}
        {leftTab === 'templates' && <TemplateLibrary project={project} getResources={getTemplateResources} onApply={applyTemplate} />}
        {leftTab === 'effects' && <div className="library-content effects-library" data-testid="effects-library">
          <div className="section-label">轨道效果<span>{EFFECT_DEFINITIONS.length} 种</span></div>
          <label className="effects-search"><Search size={14} /><input aria-label="搜索轨道效果" value={effectSearch} onChange={event => setEffectSearch(event.target.value)} placeholder="搜索效果" />{effectSearch && <button aria-label="清空效果搜索" onClick={() => setEffectSearch('')}><X size={12} /></button>}</label>
          <div className="effect-categories" role="group" aria-label="效果分类">{['全部', ...new Set(EFFECT_DEFINITIONS.map(item => item.category))].map(category => <button key={category} className={effectCategory === category ? 'active' : ''} onClick={() => setEffectCategory(category)}>{category}</button>)}</div>
          <div className={`effect-target-note${selectedEffectTarget?.locked ? ' warning' : ''}`} data-testid="effect-target-note"><SlidersHorizontal size={13} /><span>{selectedEffectTarget ? selectedEffectTarget.locked ? `「${selectedEffectTarget.name}」已锁定，解锁后可添加` : (selectedEffectTarget.effects?.length ?? 0) >= MAX_LAYER_EFFECTS ? `「${selectedEffectTarget.name}」已达到 ${MAX_LAYER_EFFECTS} 个效果上限` : `添加到「${selectedEffectTarget.name}」${selectedAudio ? ' · 支持音频淡入淡出' : ''}` : '请选择轨道，或将效果拖入轨道'}</span></div>
          <div className="effect-card-list">{EFFECT_DEFINITIONS.filter(item => (effectCategory === '全部' || item.category === effectCategory) && `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(effectSearch.trim().toLowerCase())).map(def => <div key={def.type} className="effect-library-card" draggable data-testid={`effect-card-${def.type}`} aria-label={`拖动${def.name}到轨道`} onDragStart={event => { draggedEffectType.current = def.type; event.dataTransfer.setData(EFFECT_DRAG_MIME, def.type); event.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => { draggedEffectType.current = null; setEffectDropTarget(null); }}>
            <div className={`effect-card-preview ${def.type}`} aria-hidden="true"><span className="effect-preview-moon" /><span className="effect-preview-mountains" /><span className="effect-preview-lines" /><b>FX</b></div>
            <div className="effect-card-copy"><strong>{def.name}<small>{def.category}</small></strong><p>{def.description}</p><span className="effect-target-types">{def.targets.includes('audio') ? '画面 / 音频' : '画面轨道'}</span><button aria-label={`添加${def.name}到所选轨道`} disabled={!selectedEffectTarget || selectedEffectTarget.locked || (selectedEffectTarget.effects?.length ?? 0) >= MAX_LAYER_EFFECTS || !effectSupportsTarget(def.type, selectedAudio ? 'audio' : 'visual')} title={!selectedEffectTarget ? '请先选择轨道' : selectedEffectTarget.locked ? '请先解锁目标轨道' : !effectSupportsTarget(def.type, selectedAudio ? 'audio' : 'visual') ? '主音轨仅支持音频淡入淡出' : (selectedEffectTarget.effects?.length ?? 0) >= MAX_LAYER_EFFECTS ? '已达到效果数量上限' : `添加到${selectedEffectTarget.name}`} onClick={() => appendLayerEffect(def.type)}><Plus size={12} />添加</button></div>
          </div>)}</div>
          {!EFFECT_DEFINITIONS.some(item => (effectCategory === '全部' || item.category === effectCategory) && `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(effectSearch.trim().toLowerCase())) && <p className="effect-search-empty">没有找到匹配的效果。</p>}
          <p className="subtle-note">将卡片拖入轨道，或选中轨道后点击“添加”。音乐呼吸由配乐频段驱动画面；淡入淡出可作用于画面和主音轨。</p>
        </div>}
        {leftTab === 'layers' && <div className="layers-content"><div className="section-label">画面叠放顺序<span>上方显示在前</span></div><div className="layer-list">{[...project.layers].reverse().map(layer => { const Icon = iconByType[layer.type]; return <div key={layer.id} className={`layer-item${selectedId === layer.id ? ' selected' : ''}${!layer.visible ? ' invisible' : ''}`} onClick={() => { setSelectedId(layer.id); setInspectorTab(tab => tab === 'effects' ? 'effects' : 'layer'); }}><GripVertical size={12} className="grip" /><span className={`layer-type-icon ${layer.type}`}><Icon size={16} /></span><strong>{layer.name}</strong><button aria-label={`${layer.visible ? '隐藏' : '显示'}${layer.name}`} title={layer.visible ? '隐藏图层' : '显示图层'} onClick={e => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><button aria-label={`${layer.locked ? '解锁' : '锁定'}${layer.name}`} title={layer.locked ? '解锁图层' : '锁定图层'} onClick={e => { e.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}>{layer.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</button></div>; })}</div><div className="layer-list-actions"><IconButton label="上移一层" disabled={!selected || project.layers.at(-1)?.id === selectedId} onClick={() => selected && reorderLayer(selected.id, 1)}><ArrowUp size={16} /></IconButton><IconButton label="下移一层" disabled={!selected || project.layers[0]?.id === selectedId} onClick={() => selected && reorderLayer(selected.id, -1)}><ArrowDown size={16} /></IconButton><i /><IconButton label="复制组件 Ctrl+D" disabled={!selected} onClick={duplicateLayer}><Copy size={15} /></IconButton><IconButton label="删除组件 Delete" disabled={!selected || selected.locked} onClick={deleteLayer}><Trash2 size={15} /></IconButton></div><Button className="add-component-button" onClick={() => setLeftTab('components')}><Plus size={15} />添加组件</Button></div>}
        <div className="library-footer"><span><span className={`status-dot${analysis ? ' ready' : ''}`} />{analysisStatus}</span><IconButton label="收起素材面板" onClick={() => setSideCollapsed(true)}><PanelLeftClose size={15} /></IconButton></div>
      </aside>

      {!sideCollapsed && <EditorPanelSeparator edge="left" layout={editorLayout} />}

      <section className="preview-panel">
        <div className="panel-title"><div>{sideCollapsed && <IconButton label="展开素材面板" onClick={() => setSideCollapsed(false)}><FolderOpen size={16} /></IconButton>}<Clapperboard size={15} /><strong>节目预览</strong><span className="panel-subtitle">主场景</span></div><div><span className="preview-quality">适合画面 <ChevronDown size={11} /></span><IconButton label="吸附：中心与边缘，Alt 临时关闭" active={snapping} onClick={() => setSnapping(!snapping)}><Magnet size={15} /></IconButton><IconButton label="清除选框，查看完整画面" onClick={() => setSelectedId(null)}><Maximize size={15} /></IconButton></div></div>
        <div className={`monitor-well${dragging ? ' is-dragging' : ''}`} ref={monitorRef}>
          <div className="stage" ref={stageRef} style={{ width: stageSize.width, height: stageSize.height }}><canvas ref={canvasRef} width={project.width} height={project.height} onPointerDown={selectOnCanvas} aria-label="视频预览画布，单击选择组件并拖动位置" />
            {selected && selected.visible && time >= selected.start && time <= selected.end && <div className={`selection-box${selected.locked ? ' locked' : ''}`} style={selectedStyle} onPointerDown={event => beginTransform(event, selected, 'move')}><div className="selection-name">{selected.locked && <LockKeyhole size={9} />}{selected.name}</div>{!selected.locked && <><i className="rotation-stem" /><button className="rotate-handle" aria-label="拖动旋转组件" title="拖动旋转，Shift 吸附 15°" onPointerDown={event => beginTransform(event, selected, 'rotate')}><RotateCcw size={10} /></button>{([[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]).map(corner => <button key={corner.join()} className={`resize-handle corner-${corner[0] > 0 ? 'r' : 'l'}${corner[1] > 0 ? 'b' : 't'}`} aria-label="拖动缩放组件" title="拖动缩放，Shift 保持比例" onPointerDown={event => beginTransform(event, selected, 'resize', corner)} />)}</>}</div>}
          </div>
          <div className="monitor-hint">{videoLoading && <LoaderCircle className="spin" size={11} />}{dragging ? '按住 Shift 保持比例 · Alt 临时关闭吸附' : videoLoading ? '正在定位视频帧…' : selected ? `${selected.name} · 拖动以移动，角点以缩放` : '单击画面中的组件，开始编辑'}</div>
        </div>
        <div className="transport"><div className="transport-time"><strong>{timecode(time, true, project.fps)}</strong><span> / {timecode(project.duration, true, project.fps)}</span></div><div className="transport-buttons"><IconButton label="回到起点 Home" onClick={() => { pause(); seek(0); }}><SkipBack size={17} /></IconButton><IconButton label="后退一帧" onClick={() => { pause(); seek(time - 1 / project.fps); }}><ChevronLeft size={20} /></IconButton><button className="play-button" title="播放 / 暂停 Space" aria-label={playing ? '暂停' : '播放'} onClick={() => void togglePlay()}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><IconButton label="前进一帧" onClick={() => { pause(); seek(time + 1 / project.fps); }}><ChevronRight size={20} /></IconButton><IconButton label="跳到末尾" onClick={() => { pause(); seek(project.duration); }}><SkipForward size={17} /></IconButton></div><label className="volume-control" title="试听音量，不影响导出音量"><Volume2 size={15} /><input aria-label="试听音量" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} /></label></div>
      </section>

      <EditorPanelSeparator edge="right" layout={editorLayout} />
      <aside className="inspector-panel" id="editor-panel-right"><div className="panel-tabs inspector-tabs"><button className={inspectorTab === 'layer' ? 'active' : ''} onClick={() => setInspectorTab('layer')}><Settings2 size={15} />组件属性</button><button className={inspectorTab === 'effects' ? 'active' : ''} onClick={() => setInspectorTab('effects')}>效果{selectedEffectTarget?.effects?.length ? <span className="count-badge">{selectedEffectTarget.effects.length}</span> : null}</button><button className={inspectorTab === 'project' ? 'active' : ''} onClick={() => setInspectorTab('project')}>工程</button></div>
        {inspectorTab === 'effects' && (selectedEffectTarget ? <div className="inspector-content effect-inspector" key={`effects-${selectedEffectTarget.id}`}><div className="effect-inspector-heading"><Sparkles size={17} /><div><h3>{selectedEffectTarget.name}</h3><p>{selectedAudio ? '音频效果 · 作用于音乐音量' : '轨道效果 · 按从上到下的顺序处理'}</p></div></div>{selectedEffectTarget.locked && <div className="locked-notice"><LockKeyhole size={13} />已锁定，解锁后可编辑效果</div>}<div className="effect-stack-actions"><Button aria-label="复制全部轨道效果" disabled={!selectedEffectTarget.effects?.length} onClick={() => { setEffectClipboard(clone(selectedEffectTarget.effects ?? [])); notify(`已复制 ${selectedEffectTarget.effects?.length ?? 0} 个效果。`); }}><Copy size={12} />复制效果</Button><Button aria-label="粘贴轨道效果" disabled={!effectClipboard.length || selectedEffectTarget.locked} onClick={pasteLayerEffects} title={effectClipboard.length ? `追加 ${effectClipboard.length} 个效果到此轨道` : '先从其他轨道复制效果'}><Plus size={12} />粘贴{effectClipboard.length > 0 && <small>{effectClipboard.length}</small>}</Button></div>
          <EffectStackEditor layer={selectedEffectTarget} target={selectedAudio ? 'audio' : 'visual'} lyricPerCue={selected?.type === 'lyrics' && String(selected.params.mode ?? 'scroll') !== 'scroll'} onCopy={effect => { setEffectClipboard([clone(effect)]); notify('已复制此效果。'); }} onChange={change => changeLayerEffects(selectedEffectTarget.id, change)} />
          <Button className="full-button" onClick={() => setLeftTab('effects')}><Plus size={13} />浏览轨道效果</Button><p className="parameter-note">{selectedAudio ? '音频淡入从音乐起点开始，淡出在音乐与工程中较早的终点结束；试听与导出使用相同的音量曲线。' : '效果跟随轨道的显示区间与显隐设置。'}复制效果会追加到目标轨道，最多 {MAX_LAYER_EFFECTS} 项。</p>
          {selected && (selected.effects?.length ?? 0) >= MAX_LAYER_EFFECTS && (['text', 'title'].includes(selected.type) && String(selected.params.textTransition ?? 'none') !== 'none' || selected.type === 'lyrics' && String(selected.params.transition ?? 'none') !== 'none' || selected.type === 'atmosphere' && (Number(selected.params.fadeIn ?? 0) > 0 || Number(selected.params.fadeOut ?? 0) > 0)) && <p className="parameter-note">旧版淡入淡出已保留；腾出一个效果位置并重新打开工程后，可迁入轨道效果。</p>}
        </div> : <div className="empty-inspector"><Sparkles size={30} /><h3>选择一个轨道</h3><p>在左侧浏览效果，<br />选中轨道后添加，或直接拖入轨道。</p><Button onClick={() => setLeftTab('effects')}>浏览轨道效果</Button></div>)}
        {inspectorTab === 'layer' && selected ? <div className="inspector-content" key={selected.id}><div className="selected-heading"><span className={`layer-type-icon ${selected.type}`}>{(() => { const Icon = iconByType[selected.type]; return <Icon size={18} />; })()}</span><input aria-label="组件名称" value={selected.name} onChange={e => updateLayer(selected.id, { name: e.target.value })} /><IconButton label={selected.locked ? '解锁组件' : '锁定组件'} active={selected.locked} onClick={() => updateLayer(selected.id, { locked: !selected.locked })}>{selected.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</IconButton></div>
          {selected.locked && <div className="locked-notice"><LockKeyhole size={13} />已锁定，预览与时间线中均不可拖动</div>}
          <div className="inspector-section"><h3>变换<span>中心坐标 · px</span></h3><div className="field-grid"><NumberField label="X" value={selected.x} onChange={x => updateLayer(selected.id, { x })} /><NumberField label="Y" value={selected.y} onChange={y => updateLayer(selected.id, { y })} /></div><RangeField label="宽度" suffix="px" value={selected.width} min={10} max={3840} numericMax={10000} step={1} onChange={width => updateLayer(selected.id, { width })} /><RangeField label="高度" suffix="px" value={selected.height} min={10} max={2160} numericMax={10000} step={1} onChange={height => updateLayer(selected.id, { height })} /><RangeField label="旋转" suffix="°" value={selected.rotation} min={-180} max={180} numericMin={-3600} numericMax={3600} step={1} onChange={rotation => updateLayer(selected.id, { rotation })} /><RangeField label={selected.type === 'background' ? '背景透明度' : '不透明度'} suffix="%" value={Math.round((selected.type === 'background' ? 1 - selected.opacity : selected.opacity) * 100)} min={0} max={100} step={1} onChange={value => updateLayer(selected.id, { opacity: selected.type === 'background' ? 1 - value / 100 : value / 100 })} /></div>
          <div className="inspector-section"><h3>外观与动效</h3>
            {selected.type === 'background' && <SelectField label="背景类型" value={String(selected.params.backgroundType ?? 'image')} onChange={backgroundType => updateParams({ backgroundType })} options={[["image", "图片"], ["video", "视频"], ["color", "纯色"]]} />}
            {(['image', 'disc'].includes(selected.type) || (selected.type === 'background' && !['video', 'color'].includes(String(selected.params.backgroundType)))) && <><SelectField label={selected.type === 'background' ? '背景图片' : selected.type === 'image' ? '卡片图片' : '唱片图片'} value={selected.params.followCover === true ? '__cover__' : String(selected.params.imageId ?? '')} onChange={value => updateParams({ imageId: value === '__cover__' ? '' : value, followCover: value === '__cover__' })} options={[["", selected.type === 'disc' ? "默认唱片封面" : "未选择图片"], ["__cover__", "跟随默认封面"], ...libraryImages.map(asset => [asset.id, asset.name] as [string, string])]} /><p className="parameter-note">{selected.params.followCover === true || (selected.type === 'disc' && !selected.params.imageId) ? '此图层跟随工程默认封面；也可选择素材库中的独立图片。' : '此图层独立选择图片，更换其他图层的图片不会影响这里。'}</p></>}
            {selected.type === 'background' && selected.params.backgroundType === 'video' && <><SelectField label="背景视频" value={String(selected.params.videoId ?? '')} onChange={videoId => updateParams({ videoId })} options={[["", "未选择视频"], ...(project.videos ?? []).map(asset => [asset.id, asset.name] as [string, string])]} />{!selected.params.videoId && <p className="parameter-note">先在素材库导入视频，再选择背景视频或点击素材的“用作背景”。</p>}<RangeField label="背景播放速度" suffix="倍" value={Number(selected.params.playbackRate ?? 1)} min={MIN_VIDEO_RATE} max={MAX_VIDEO_RATE} step={.05} onChange={playbackRate => updateParams({ playbackRate })} /><Toggle label="倒放背景视频" checked={selected.params.reverse === true} onChange={reverse => updateParams({ reverse })} /><Toggle label="循环背景视频" checked={selected.params.videoLoop !== false} onChange={videoLoop => updateParams({ videoLoop })} /><SelectField label="背景适配" value={String(selected.params.fit ?? 'cover')} onChange={fit => updateParams({ fit })} options={[["cover", "填充并裁切"], ["contain", "完整显示"], ["stretch", "拉伸至组件尺寸（可变形）"]]} /><p className="parameter-note">背景视频从背景轨道起点播放，调速不会改变轨道长度。关闭循环后，正放停在末帧、倒放停在首帧。视频原声不加入配乐。</p></>}
            {selected.type === 'background' && <><ColorField label="背景色" value={String(selected.params.color)} onChange={color => updateParams({ color })} />{selected.params.backgroundType !== 'color' && <><RangeField label="背景亮度" value={Number(selected.params.brightness ?? .5)} min={0} max={1} step={.01} onChange={brightness => updateParams({ brightness })} /><RangeField label="背景模糊" suffix="px" value={Number(selected.params.blur ?? 40)} min={0} max={100} step={1} onChange={blur => updateParams({ blur })} /></>}</>}
            {selected.type === 'image' && <><SelectField label="图片适配" value={String(selected.params.fit)} onChange={fit => updateParams({ fit })} options={[['cover', '填充并裁切'], ['contain', '完整显示']]} /><SelectField label="图片蒙版" value={String(selected.params.mask ?? 'rounded')} onChange={mask => updateParams({ mask })} options={[["rectangle", "矩形"], ["rounded", "圆角矩形"], ["circle", "圆形"], ["ellipse", "椭圆"], ["diamond", "菱形"], ["hexagon", "六边形"]]} />{(selected.params.mask ?? 'rounded') === 'rounded' && <RangeField label="图片圆角" suffix="px" value={Number(selected.params.radius ?? 2)} min={0} max={300} step={1} onChange={radius => updateParams({ radius })} />}<Toggle label="图片投影" checked={Boolean(selected.params.shadow)} onChange={shadow => updateParams({ shadow })} />{Boolean(selected.params.shadow) && <RangeField label="阴影强度" suffix="%" value={Math.round(Number(selected.params.shadowOpacity ?? 160 / 255) * 100)} min={0} max={100} step={1} onChange={value => updateParams({ shadowOpacity: value / 100 })} />}</>}
            {selected.type === 'video' && selectedVideoAsset && <><SelectField label="视频来源" value={String(selected.params.videoId)} onChange={videoId => { const asset = project.videos?.find(item => item.id === videoId); if (!asset) return; if (Math.min(asset.duration ?? 0, 3600 - selected.start) < 1 / project.fps) { notify('视频短于一工程帧或超出工程时长，无法替换。', true); return; } changeVideo(selected.id, layer => { const length = Math.min(asset.duration ?? 0, 3600 - layer.start); return { ...layer, end: layer.start + length, params: { ...layer.params, videoId, sourceIn: 0, sourceOut: length, playbackRate: 1, reverse: false } }; }); }} options={(project.videos ?? []).map(asset => [asset.id, asset.name] as [string, string])} /><SelectField label="视频适配" value={String(selected.params.fit ?? 'cover')} onChange={fit => updateParams({ fit })} options={[["stretch", "拉伸至组件尺寸（可变形）"], ["cover", "填充并裁切"], ["contain", "完整显示"]]} /><p className="parameter-note">选择“拉伸至组件尺寸”后，分别调节宽度、高度或拖动角点即可改变视频比例；按住 Shift 拖动保持当前比例。</p><div className="video-source-details"><span>原素材 {timecode(selectedVideoAsset.duration ?? 0)}</span><span>{selectedVideoAsset.width} × {selectedVideoAsset.height} · {(selectedVideoAsset.fps ?? 30).toFixed(2)} fps</span></div><div className="field-grid"><NumberField label="源入点" suffix="秒" value={Number(selected.params.sourceIn ?? 0)} min={0} max={Math.max(0, Number(selected.params.sourceOut) - Number(selected.params.playbackRate ?? 1) / project.fps)} step={.01} onChange={sourceIn => changeVideo(selected.id, (layer, asset, current) => setVideoSourceRange(layer, sourceIn, Number(layer.params.sourceOut), asset, current.fps))} /><NumberField label="源出点" suffix="秒" value={Number(selected.params.sourceOut ?? selectedVideoAsset.duration)} min={Number(selected.params.sourceIn ?? 0) + Number(selected.params.playbackRate ?? 1) / project.fps} max={selectedVideoAsset.duration} step={.01} onChange={sourceOut => changeVideo(selected.id, (layer, asset, current) => setVideoSourceRange(layer, Number(layer.params.sourceIn ?? 0), sourceOut, asset, current.fps))} /></div><RangeField label="播放速度" suffix="倍" value={Number(selected.params.playbackRate ?? 1)} min={.1} max={8} step={.05} onChange={rate => changeVideo(selected.id, (layer, asset, current) => setVideoRate(layer, rate, asset, current.fps))} /><Toggle label="倒放视频" checked={selected.params.reverse === true} onChange={reverse => updateParams({ reverse })} /><Button className="full-button split-video-button" onClick={splitSelectedVideo} disabled={selected.locked || time <= selected.start || time >= selected.end}><Clapperboard size={14} />播放头处分割</Button><p className="parameter-note">拖动时间线片段可移动；两端裁切源画面。切换“速率拉伸”或按住 Alt 拖动两端，可保留源区间并改变速度。视频原声不加入配乐。</p></>}
            {selected.type === 'video' && <details className="parameter-group chroma-group" open><summary><span>色键抠像</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><Toggle label="启用色键抠像" checked={selected.params.chromaEnabled === true} onChange={chromaEnabled => updateParams({ chromaEnabled })} />{selected.params.chromaEnabled === true && <><div className="chroma-presets" role="group" aria-label="键控预设"><Button className={String(selected.params.chromaColor ?? '#00ff00').toLowerCase() === '#00ff00' ? 'active' : ''} onClick={() => updateParams({ chromaColor: '#00ff00' })}><i style={{ background: '#00ff00' }} />绿幕</Button><Button className={String(selected.params.chromaColor ?? '#00ff00').toLowerCase() === '#0000ff' ? 'active' : ''} onClick={() => updateParams({ chromaColor: '#0000ff' })}><i style={{ background: '#0000ff' }} />蓝幕</Button><Button onClick={() => { const input = document.querySelector<HTMLInputElement>('input[aria-label="键控颜色"]'); if (input) { try { input.showPicker(); } catch { input.click(); } } }}>自定义</Button></div><ColorField label="键控颜色" value={String(selected.params.chromaColor ?? '#00ff00')} onChange={chromaColor => updateParams({ chromaColor })} />{'EyeDropper' in window && <Button className="full-button chroma-eyedropper" onClick={() => void pickChromaColor()}><Search size={13} />吸管选取屏幕颜色</Button>}<RangeField label="色键容差" value={Number(selected.params.chromaTolerance ?? .18)} min={0} max={1} step={.01} onChange={chromaTolerance => updateParams({ chromaTolerance })} /><RangeField label="边缘柔化" value={Number(selected.params.chromaSoftness ?? .10)} min={0} max={1} step={.01} onChange={chromaSoftness => updateParams({ chromaSoftness })} /><RangeField label="溢色抑制" value={Number(selected.params.chromaSpill ?? .5)} min={0} max={1} step={.01} onChange={chromaSpill => updateParams({ chromaSpill })} /><p className="parameter-note">将所选颜色变为透明，显示下方轨道。先选幕布颜色，再调容差与边缘；溢色抑制可减轻前景边缘的绿光或蓝光。</p></>}</div></details>}
            {selected.type === 'disc' && <><div className="skin-picker"><button className={selected.params.skin === 'vinyl' ? 'active' : ''} onClick={() => updateParams({ skin: 'vinyl' })}><span className="mini-disc vinyl" /><strong>经典黑胶</strong></button><button className={selected.params.skin === 'cd' ? 'active' : ''} onClick={() => updateParams({ skin: 'cd' })}><span className="mini-disc cd" /><strong>银色 CD</strong></button></div><RangeField label="转速" suffix="RPM" value={Number(selected.params.rpm ?? 8)} min={-120} max={120} step={1} onChange={rpm => updateParams({ rpm })} /><RangeField label="封面比例" value={Number(selected.params.labelRatio ?? .48)} min={.2} max={.9} step={.01} onChange={labelRatio => updateParams({ labelRatio })} /><Toggle label="显示唱臂" checked={Boolean(selected.params.tonearm)} onChange={tonearm => updateParams({ tonearm })} /><p className="parameter-note">唱片旋转由歌曲时间驱动，定位与导出保持一致。</p></>}
            {selected.type === 'lyrics' && <><SelectField label="显示模式" value={String(selected.params.mode ?? 'scroll')} onChange={mode => updateParams({ mode })} options={[['scroll', '多行滚动'], ['bilingual', '双语两行'], ['single', '单行切换']]} /><FontPicker label="原文字体" value={resolveLyricFontIds(selected.params).original} fonts={project.fonts ?? []} busy={busyFont} onChange={fontId => updateParams({ fontId })} onImport={() => openFontImport(selected.id, 'fontId')} /><FontPicker label="译文字体" value={resolveLyricFontIds(selected.params).translation} fonts={project.fonts ?? []} busy={busyFont} onChange={translationFontId => updateParams({ translationFontId })} onImport={() => openFontImport(selected.id, 'translationFontId')} /><LyricsStyleEditor params={selected.params} onChange={updateParams} /><details className="parameter-group" open><summary><span>排版与行距</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><SelectField label="对齐方式" value={String(selected.params.align ?? 'center')} onChange={align => updateParams({ align })} options={[['left', '左对齐'], ['center', '居中'], ['right', '右对齐']]} />{selected.params.mode === 'scroll' && <RangeField label="显示行数" min={1} max={7} step={1} value={Number(selected.params.lines ?? 3)} onChange={lines => updateParams({ lines })} />}<RangeField label="整体行距" suffix="px" value={Number(selected.params.lineGap ?? 20)} min={0} max={160} step={1} onChange={lineGap => updateParams({ lineGap })} /><RangeField label="译文与原文行距" suffix="px" value={Number(selected.params.translationGap ?? 8)} min={0} max={120} step={1} onChange={translationGap => updateParams({ translationGap })} /><p className="parameter-note">整体行距用于歌词块之间，译文行距用于同一句的原文与译文之间。</p></div></details>{selected.params.mode !== 'scroll' && <p className="parameter-note">歌词切换动效请从“效果”库添加淡入淡出，并选择“每句歌词”。</p>}<details className="parameter-group"><summary><span>歌词时间校准</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><RangeField label="歌词整体偏移" suffix="ms" step={10} min={-10000} max={10000} numericMin={-3600000} numericMax={3600000} value={project.lyricsOffsetMs} onChange={lyricsOffsetMs => commit(current => ({ ...current, lyricsOffsetMs }))} /><p className="parameter-note">正值延后，负值提前。</p><div className="offset-nudge-actions"><Button onClick={() => commit(current => ({ ...current, lyricsOffsetMs: current.lyricsOffsetMs - 100 }))}><Minus size={12} />100 ms</Button><Button onClick={() => commit(current => ({ ...current, lyricsOffsetMs: current.lyricsOffsetMs + 100 }))}><Plus size={12} />100 ms</Button></div></div></details><Button className="full-button" onClick={() => { setShowLyrics(true); setLyricsTab('edit'); }}><FileText size={14} />打开歌词校对</Button></>}
            {selected.type === 'lyrics' && <details className="parameter-group" open><summary><span>文字平面朝向</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><RangeField label="左右朝向" suffix="°" value={Number(selected.params.planeYaw ?? 0)} min={-75} max={75} step={1} onChange={planeYaw => updateParams({ planeYaw })} /><RangeField label="透视强度" suffix="%" value={Number(selected.params.planePerspective ?? 50)} min={0} max={300} step={1} onChange={planePerspective => updateParams({ planePerspective })} /><p className="parameter-note">负值朝左，正值朝右，0° 正面显示。透视强度只调节近大远小，保持各行中线方向一致；0% 不产生远近缩放。选区保持矩形，可叠加上方“旋转”调整画面内角度。</p></div></details>}
            {['text', 'title'].includes(selected.type) && <p className="parameter-note">出入场动效请从“效果”库添加淡入淡出，可调整样式、淡入与淡出时长。</p>}
            {['text', 'title', 'lyrics'].includes(selected.type) && <TextGlowEditor params={selected.params} onChange={updateParams} scope={selected.type} />}
            {selected.type === 'spectrum' && <>
              <SelectField label="可视化样式" value={String(selected.params.mode ?? 'bars')} onChange={mode => updateParams({ mode })} options={[['bars', '条形频谱'], ['ecg-wave', '心电单曲线'], ['dual-wave', '交错双曲线'], ['wave', '振幅包络'], ['ring', '环形频谱']]} />
              <ColorField label="动效颜色" value={String(selected.params.color)} onChange={color => updateParams({ color })} />
              <RangeField label="响应强度" value={Number(selected.params.gain ?? 1.3)} min={.2} max={4} step={.1} onChange={gain => updateParams({ gain })} />
              <RangeField label={['ecg-wave','dual-wave','wave'].includes(String(selected.params.mode)) ? '曲线精细度' : '频谱条数'} value={Number(selected.params.barCount ?? 80)} min={16} max={160} step={8} onChange={barCount => updateParams({ barCount })} />
              {['ecg-wave','dual-wave','wave'].includes(String(selected.params.mode)) && <>
                <RangeField label="动态平滑" value={Math.round(Number(selected.params.smoothing ?? .6) * 100)} min={0} max={100} step={1} suffix="%" onChange={value => updateParams({ smoothing: value / 100 })} />
                <RangeField label="线条粗细" value={Number(selected.params.lineWidth ?? 2.8)} min={.5} max={8} step={.1} suffix="px" onChange={lineWidth => updateParams({ lineWidth })} />
              </>}
              {selected.params.mode === 'dual-wave' && <RangeField label="流动速度" value={Number(selected.params.flowSpeed ?? 1)} min={0} max={3} step={.05} suffix="倍" onChange={flowSpeed => updateParams({ flowSpeed })} />}
              {selected.params.mode === 'wave' && <RangeField label="包络视窗" value={Number(selected.params.envelopeWindow ?? 1.5)} min={.25} max={4} step={.05} suffix="秒" onChange={envelopeWindow => updateParams({ envelopeWindow })} />}
              {selected.params.mode === 'ecg-wave' && <RangeField label="扫描视窗" value={Number(selected.params.envelopeWindow ?? 1.5)} min={.25} max={4} step={.05} suffix="秒" onChange={envelopeWindow => updateParams({ envelopeWindow })} />}
              <p className="parameter-note">{selected.params.mode === 'ecg-wave' ? '单条心电风格脉冲线，尖峰跟随音乐瞬态向左扫描；扫描视窗越短，移动越快。仅绘制线条，无填充。' : selected.params.mode === 'dual-wave' ? '主辅两条曲线交织流动，仅绘制线条。流速为 0 时停止平移，仍响应音乐；提高动态平滑可减轻快速抖动。' : selected.params.mode === 'wave' ? '以柔和轮廓显示真实音频的振幅变化。瞬态随播放向左流动；视窗越长，可见的音乐变化越多。' : '根据当前音乐计算真实频谱，预览与导出共享分析结果。'}</p>
            </>}
            {selected.type === 'particles' && <ParticleEditor params={selected.params} onChange={updateParams} />}
            {selected.type === 'atmosphere' && <AtmosphereEditor params={selected.params} onChange={updateParams} />}
            {selected.type === 'player' && <><ColorField label="组件颜色" value={String(selected.params.color)} onChange={color => updateParams({ color })} /><Toggle label="歌曲进度条" checked={Boolean(selected.params.progress)} onChange={progress => updateParams({ progress })} /><Toggle label="时间标签" checked={Boolean(selected.params.time)} onChange={time => updateParams({ time })} /><p className="parameter-note">画面内的播放图标是视频装饰；试听请使用预览下方按钮。</p></>}
            {selected.type === 'text' && <><TextContentField value={String(selected.params.text ?? '')} onChange={text => updateParams({ text })} /><FontPicker value={String(selected.params.fontId ?? '')} fonts={project.fonts ?? []} busy={busyFont} onChange={fontId => updateParams({ fontId })} onImport={() => openFontImport(selected.id)} /><RangeField label="字号" suffix="px" value={Number(selected.params.fontSize ?? 48)} min={10} max={180} step={1} onChange={fontSize => updateParams({ fontSize })} /><ColorField label="文字颜色" value={String(selected.params.color ?? '#ffffff')} onChange={color => updateParams({ color })} /><SelectField label="对齐方式" value={String(selected.params.align ?? 'left')} onChange={align => updateParams({ align })} options={[["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]]} /><RangeField label="字重" value={Number(selected.params.fontWeight ?? 400)} min={100} max={900} step={100} onChange={fontWeight => updateParams({ fontWeight, fontWeightSynthesis: true })} /><Toggle label="斜体" checked={selected.params.italic === true} onChange={italic => updateParams({ italic })} /><p className="parameter-note">可变字体可细分字重；常规字体支持合成加粗。</p><RangeField label="文字行高" suffix="倍" value={Number(selected.params.lineHeight ?? 1.3)} min={.8} max={3} step={.05} onChange={lineHeight => updateParams({ lineHeight })} /><p className="parameter-note">可输入多行文字，随文本框宽度自动换行；拖动文本框可调整位置与大小。</p></>}
            {selected.type === 'title' && <><label className="text-field"><span>歌名</span><input value={project.title} onChange={e => commit(current => ({ ...current, title: e.target.value }))} /></label><label className="text-field"><span>歌手 / 副标题</span><input value={project.artist} onChange={e => commit(current => ({ ...current, artist: e.target.value }))} /></label><FontPicker value={String(selected.params.fontId ?? '')} fonts={project.fonts ?? []} busy={busyFont} onChange={fontId => updateParams({ fontId })} onImport={() => openFontImport(selected.id)} /><RangeField label="字号" suffix="px" value={Number(selected.params.fontSize ?? 26)} min={10} max={180} step={1} onChange={fontSize => updateParams({ fontSize })} /><RangeField label="主标题字重" value={Number(selected.params.fontWeight ?? 600)} min={100} max={900} step={100} onChange={fontWeight => updateParams({ fontWeight })} /><Toggle label="主标题斜体" checked={selected.params.italic === true} onChange={italic => updateParams({ italic })} /><RangeField label="副标题字重" value={Number(selected.params.subtitleFontWeight ?? 400)} min={100} max={900} step={100} onChange={subtitleFontWeight => updateParams({ subtitleFontWeight })} /><Toggle label="副标题斜体" checked={selected.params.subtitleItalic === true} onChange={subtitleItalic => updateParams({ subtitleItalic })} /><p className="parameter-note">可变字体可细分字重；常规字体支持合成加粗。</p><ColorField label="文字颜色" value={String(selected.params.color)} onChange={color => updateParams({ color })} /></>}
          </div>
          <div className="inspector-section"><h3>时间线区间<span>秒</span></h3><div className="field-grid"><NumberField label="起点" value={selected.start} min={0} max={3600 - (selected.end - selected.start)} step={1 / project.fps} disabled={selected.locked} onChange={start => moveLayerInTimeline(selected.id, start)} /><NumberField label="终点" value={selected.end} min={selected.start + 1 / project.fps} max={selected.type === 'video' ? 3600 : project.duration} step={1 / project.fps} disabled={selected.locked} onChange={end => selected.type === 'video' ? changeVideo(selected.id, (layer, asset, current) => edgeTool === 'stretch' ? stretchVideoLayer(layer, 'end', end, asset, current.fps) : trimVideoLayer(layer, 'end', end, asset, current.fps)) : updateLayer(selected.id, { end })} /></div><p className="parameter-note">起点移动整个组件并保留时长；{selected.type === 'video' ? '终点按时间线边缘工具裁切或拉伸。' : '拖动两端调整出现区间。'}{selected.type === 'lyrics' && '歌词仍跟随配乐时间，需要校准时请调整歌词整体偏移。'}</p><Toggle label="显示组件" checked={selected.visible} onChange={visible => updateLayer(selected.id, { visible })} /></div>
          <div className="inspector-bottom"><Button onClick={duplicateLayer}><Copy size={13} />复制组件</Button><IconButton label="删除组件" disabled={selected.locked} onClick={deleteLayer}><Trash2 size={15} /></IconButton></div>
        </div> : inspectorTab === 'layer' && selectedAudio ? <div className="inspector-content audio-inspector"><div className="effect-inspector-heading"><AudioLines size={20} /><div><h3>主音轨</h3><p>{project.audio?.name ?? '等待导入音乐'}</p></div></div><Toggle label="静音主音轨" checked={project.audioMuted === true} onChange={audioMuted => commit(current => ({ ...current, audioMuted }))} /><Button className="full-button" onClick={() => { setInspectorTab('effects'); setLeftTab('effects'); }}><Sparkles size={14} />设置音频淡入淡出</Button><p className="parameter-note">将“淡入淡出”效果添加到 A1 主音轨，可分别调整音乐淡入、淡出时长及曲线。试听音量滑块不影响导出音量。</p></div> : inspectorTab === 'layer' ? <div className="empty-inspector"><SlidersHorizontal size={31} /><h3>选择一个组件</h3><p>单击预览画面或图层列表，<br />在这里调整它的样式与位置。</p><Button onClick={() => setLeftTab('components')}><Plus size={14} />添加组件</Button></div> : inspectorTab === 'project' && <div className="inspector-content"><div className="inspector-section project-settings"><h3>工程信息</h3><label className="text-field"><span>曲目名称</span><input value={project.title} onChange={e => commit(current => ({ ...current, title: e.target.value }))} /></label><label className="text-field"><span>歌手</span><input value={project.artist} onChange={e => commit(current => ({ ...current, artist: e.target.value }))} /></label><div className="project-info-row"><span>画布</span><strong>{project.width} × {project.height}</strong></div><div className="project-info-row"><span>帧率</span><strong>{project.fps} fps</strong></div><DurationField value={project.duration} onCommit={duration => { pause(); commit(current => resizeProjectDuration(current, duration)); seek(Math.min(timeRef.current, duration)); }} /><p className="parameter-note">最长 3600 秒。缩短后裁去末尾画面，移除区间外片段；可撤销恢复。</p><div className="project-info-row"><span>歌词</span><strong>{project.lyrics.length} 行{project.lyricsSource && ' · 在线获取'}</strong></div></div><div className="inspector-section"><h3>工程文件</h3><Button className="full-button" onClick={saveProject}><Save size={15} />保存工程 JSON</Button><Button className="full-button" onClick={() => projectInput.current?.click()}><FolderOpen size={15} />打开工程</Button><p className="parameter-note">工程自动保存在当前浏览器。JSON 保存布局、歌词和本机素材引用；移动到其他设备后需重新选择素材。</p></div><div className="inspector-section"><h3>恢复演示布局</h3><Button className="full-button" onClick={() => { const defaults = createDefaultProject(); commit(current => ({ ...current, layers: defaults.layers.map(layer => ({ ...layer, end: current.duration })) })); setSelectedId(null); notify('已恢复默认组件布局，保留音乐、封面与歌词。'); }}><RotateCcw size={14} />重置组件布局</Button></div></div>}
      </aside>
    </main>

    <EditorPanelSeparator edge="bottom" layout={editorLayout} />
    <section className="timeline-panel" id="editor-panel-bottom">
      <div className="timeline-header">
        <div><Layers3 size={15} /><strong>时间线</strong><span className="timeline-sequence">主场景 <ChevronDown size={11} /></span></div>
        <div>
          <label className="timeline-tool"><span>边缘工具</span><select aria-label="片段边缘工具" value={edgeTool} onChange={event => setEdgeTool(event.target.value as 'trim' | 'stretch')}><option value="trim">裁切</option><option value="stretch">速率拉伸</option></select></label>
          <IconButton label="播放头处分割 Ctrl+B" disabled={!selected || selected.type !== 'video' || selected.locked || time <= selected.start || time >= selected.end} onClick={splitSelectedVideo}><Clapperboard size={15} /></IconButton>
          <span className="timeline-hint" title="拖动左侧手柄调整层序；拖动轨道底边调整高度；Alt + 滚轮缩放时间轴">拖柄排序 · 底边调高 · Alt + 滚轮缩放</span>
          <IconButton label="缩小时间线" disabled={timelineZoom <= MIN_TIMELINE_ZOOM} onClick={() => setTimelineZoom(value => Math.max(MIN_TIMELINE_ZOOM, value - .5))}><ZoomOut size={15} /></IconButton>
          <input aria-label="时间线缩放" type="range" min={MIN_TIMELINE_ZOOM} max={MAX_TIMELINE_ZOOM} step=".01" value={timelineZoom} onChange={event => setTimelineZoom(Number(event.target.value))} />
          <IconButton label="放大时间线" disabled={timelineZoom >= MAX_TIMELINE_ZOOM} onClick={() => setTimelineZoom(value => Math.min(MAX_TIMELINE_ZOOM, value + .5))}><ZoomIn size={15} /></IconButton><span className="zoom-value">{Math.round(timelineZoom * 100)}%</span>
        </div>
      </div>
      <div className="timeline-scroll" ref={timelineControls.scrollRef} data-testid="timeline-scroll" aria-label="时间轴轨道区域" title="Alt + 滚轮：缩放时间轴；滚轮：上下滚动；拖动轨道底边：调整高度">
        <div className="timeline-content" style={{ width: `${timelineZoom * 100}%` }}>
          <div className="track-row ruler-row"><div className="track-label ruler-label"><span>组件 / 轨道</span><span>时:分:秒</span></div><div className="timeline-ruler" onPointerDown={scrub}>{Array.from({ length: Math.ceil(project.duration / (project.duration > 180 ? 30 : project.duration > 60 ? 10 : 5)) + 1 }, (_, index) => { const value = index * (project.duration > 180 ? 30 : project.duration > 60 ? 10 : 5); return value <= project.duration ? <span key={value} style={{ left: `${value / project.duration * 100}%` }}>{timecode(value)}</span> : null; })}<div className="ruler-playhead" style={{ left: `${time / project.duration * 100}%` }} /></div></div>
          {[...project.layers].reverse().map((layer, index) => {
            const Icon = iconByType[layer.type];
            const insertion = timelineControls.dropTarget?.targetId === layer.id ? timelineControls.dropTarget.placement : null;
            return <div className={`track-row layer-track${selectedId === layer.id ? ' selected-track' : ''}${timelineControls.draggedId === layer.id ? ' dragging-track' : ''}${effectDropTarget === layer.id ? ' effect-drop-target' : ''}`} data-track-id={layer.id} key={layer.id} style={{ height: timelineControls.heightFor(layer.id) }} onDragOver={event => effectDragOver(event, layer.id, layer.locked)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEffectDropTarget(null); }} onDrop={event => dropLayerEffect(event, layer.id)}>
              <div className="track-label">
                <button className="track-reorder-grip" data-testid={`track-reorder-${layer.id}`} aria-label={`调整轨道顺序 ${layer.name}`} disabled={layer.locked} title={layer.locked ? '已锁定，解锁后可调整轨道顺序' : '上下拖动调整图层顺序 · 上方轨道显示在前'} onPointerDown={event => { setSelectedId(layer.id); setInspectorTab('layer'); timelineControls.beginReorder(event, layer); }}><GripVertical size={13} /></button>
                <button className="track-select" onClick={() => { setSelectedId(layer.id); setInspectorTab(tab => tab === 'effects' ? 'effects' : 'layer'); }}><span className="track-code">V{project.layers.length - index}</span><Icon size={13} /><span>{layer.name}</span>{layer.locked && <LockKeyhole size={11} />}</button>
                {!!layer.effects?.length && <button className="track-effects-badge" aria-label={`查看${layer.name}的效果 ${layer.effects.length}项`} title={`查看 ${layer.effects.length} 个轨道效果`} onClick={() => { setSelectedId(layer.id); setInspectorTab('effects'); }}>FX <small>{layer.effects.length}</small></button>}
                <button className="track-visibility" aria-label={`${layer.visible ? '隐藏' : '显示'}轨道 ${layer.name}`} title={layer.visible ? '隐藏此轨道（预览与导出）' : '显示此轨道（预览与导出）'} onClick={() => updateLayer(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
              </div>
              <div className="track-lane" onPointerDown={event => { if (event.target === event.currentTarget) scrub(event); }}>
                <div data-testid={`timeline-clip-${layer.id}`} data-layer-id={layer.id} className={`timeline-clip ${layer.type}${selectedId === layer.id ? ' selected' : ''}${!layer.visible ? ' clip-hidden' : ''}${layer.locked ? ' clip-locked' : ''}`} onPointerDown={event => moveTimelineClip(event, layer)} title={layer.type === 'video' ? `${layer.name} · ${Number(layer.params.playbackRate ?? 1).toFixed(2)} 倍${layer.params.reverse ? ' · 倒放' : ''} · 拖动移动` : `${layer.name} · ${layer.locked ? '已锁定' : '拖动移动'}`} style={{ left: `${layer.start / project.duration * 100}%`, width: `${(layer.end - layer.start) / project.duration * 100}%` }} onClick={() => { setSelectedId(layer.id); setInspectorTab('layer'); }}>
                  <i className="trim-handle left" data-trim-edge="start" title={layer.type === 'video' ? '拖动左侧裁切，Alt 速率拉伸' : '拖动左侧调整出现起点'} onPointerDown={event => trimLayer(event, layer, 'start')} /><Icon size={11} /><span>{layer.name}{layer.type === 'video' && <small>{Number(layer.params.playbackRate ?? 1).toFixed(2)}×{layer.params.reverse ? ' ↶' : ''}</small>}</span>{!!layer.effects?.length && <span className="clip-effects-badge" aria-hidden="true">FX {layer.effects.length}</span>}{layer.type === 'lyrics' && project.lyrics.map((cue, i) => <i className="lyric-marker" key={i} title={`${timecode(cue.time)} ${cue.text}`} style={{ left: `${(cue.time + project.lyricsOffsetMs / 1000 - layer.start) / (layer.end - layer.start) * 100}%` }} />)}<i className="trim-handle right" data-trim-edge="end" title={layer.type === 'video' ? '拖动右侧裁切，Alt 速率拉伸' : '拖动右侧调整出现终点'} onPointerDown={event => trimLayer(event, layer, 'end')} />
                </div>
                <div className="track-playhead" style={{ left: `${time / project.duration * 100}%` }} />
              </div>
              <TimelineTrackResize controls={timelineControls} trackId={layer.id} name={layer.name} />
              {insertion && <div data-testid="track-insertion-line" className={`track-insertion-line ${insertion}`} />}
            </div>;
          })}
          <div className={`track-row audio-track${project.audioMuted ? ' muted-track' : ''}${selectedAudio ? ' selected-track' : ''}${effectDropTarget === AUDIO_TRACK_ID ? ' effect-drop-target' : ''}`} data-track-id={AUDIO_TRACK_ID} style={{ height: timelineControls.heightFor(AUDIO_TRACK_ID) }} onDragOver={event => effectDragOver(event, AUDIO_TRACK_ID)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEffectDropTarget(null); }} onDrop={event => dropLayerEffect(event, AUDIO_TRACK_ID)}>
            <div className="track-label"><span className="track-grip-spacer" aria-hidden="true" /><button className="track-select" onClick={() => { setSelectedId(AUDIO_TRACK_ID); setInspectorTab('effects'); }}><span className="track-code">A1</span><AudioLines size={14} /><span>主音轨</span></button>{!!project.audioEffects?.length && <button className="track-effects-badge" aria-label={`查看主音轨的效果 ${project.audioEffects.length}项`} title={`查看 ${project.audioEffects.length} 个音频效果`} onClick={() => { setSelectedId(AUDIO_TRACK_ID); setInspectorTab('effects'); }}>FX <small>{project.audioEffects.length}</small></button>}<button className="track-visibility" aria-label={project.audioMuted ? '取消静音主音轨' : '静音主音轨'} title={project.audioMuted ? '取消静音（试听与导出）' : '静音（试听与导出）'} onClick={() => commit(current => ({ ...current, audioMuted: !current.audioMuted }))}>{project.audioMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button></div>
            <div className="track-lane" onPointerDown={scrub}><div className={`audio-clip${project.audio ? '' : ' empty-audio'}${selectedAudio ? ' selected' : ''}`} data-testid="timeline-audio-clip" style={{ width: `${project.audio ? Math.min(1, (project.audio.duration ?? project.duration) / project.duration) * 100 : 100}%` }} onClick={() => { setSelectedId(AUDIO_TRACK_ID); setInspectorTab('effects'); }}><svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-label="音频波形"><path d={waveformPath} /></svg><span>{project.audioMuted ? '已静音 · ' : ''}{project.audio?.name ?? '等待导入音乐'}</span>{!!project.audioEffects?.length && <span className="clip-effects-badge" aria-hidden="true">FX {project.audioEffects.length}</span>}</div><div className="track-playhead" style={{ left: `${time / project.duration * 100}%` }} /></div>
            <TimelineTrackResize controls={timelineControls} trackId={AUDIO_TRACK_ID} name="主音轨" />
          </div>
        </div>
      </div>
    </section>
    <footer className="app-footer"><span><span className="status-dot ready" />本地工作区<span className="footer-divider">/</span>{project.layers.length} 个组件<span className="footer-divider">/</span>{project.lyrics.length} 行歌词</span><span><span className="keyboard-key">Space</span> 播放 / 暂停<span className="footer-divider">·</span><span className="keyboard-key">Ctrl S</span> 保存<span className="footer-divider">·</span>Visiki Demo 0.1</span></footer>

    {showLyrics && <Modal title="获取与编辑歌词" subtitle="搜索歌曲或粘贴分享链接，直接将原文与译文加入工程。" onClose={() => setShowLyrics(false)} wide><div className="modal-tabs"><button className={lyricsTab === 'search' ? 'active' : ''} onClick={() => setLyricsTab('search')}><Search size={15} />在线获取</button><button className={lyricsTab === 'edit' ? 'active' : ''} onClick={() => setLyricsTab('edit')}><FileText size={15} />歌词校对<span>{project.lyrics.length}</span></button></div>
      {lyricsTab === 'search' ? <><form className="lyrics-search" onSubmit={e => { e.preventDefault(); void doSearch(); }}><select aria-label="歌词来源" value={provider} onChange={e => setProvider(e.target.value as 'netease' | 'qq')}><option value="netease">网易云音乐</option></select><div><Search size={17} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={provider === 'netease' ? '输入歌名、歌手，或粘贴网易云歌曲链接 / ID' : '输入歌名、歌手，或粘贴 QQ 音乐链接'} /></div><Button className="primary" type="submit" disabled={!query.trim() || songStatus === 'loading'}>{songStatus === 'loading' ? <LoaderCircle className="spin" size={16} /> : '搜索歌词'}</Button></form><div className="lyrics-workflow"><div className="song-results"><div className="workflow-column-heading"><span>1 <strong>选择歌曲</strong></span><small>{songStatus === 'done' ? `${songs.length} 个结果` : '歌词来源公开音乐接口'}</small></div>{songStatus === 'loading' && <div className="workflow-empty"><LoaderCircle className="spin" size={27} /><p>正在搜索歌曲…</p></div>}{songStatus === 'error' && <div className="error-panel"><strong>连接音乐服务失败</strong><p>{searchError}</p><Button onClick={() => void doSearch()}>重新搜索</Button></div>}{songStatus === 'idle' && <div className="workflow-empty"><Music2 size={31} /><h3>找到音乐里的每一句</h3><p>搜索关键词，或直接使用歌曲分享链接。<br />歌曲音频仍需从本地导入。</p></div>}{songStatus === 'done' && !songs.length && <div className="workflow-empty"><Search size={28} /><h3>没有找到匹配歌曲</h3><p>尝试完整歌名、歌手名，或直接粘贴歌曲链接。</p></div>}{songs.map(song => <button className={`song-result${pickedSong?.id === song.id ? ' active' : ''}`} key={`${song.provider}-${song.id}`} onClick={() => void selectSong(song)}><div className="song-art"><Music2 size={20} /></div><div><strong>{song.title}</strong><span>{song.artists.join(' / ')}<i>·</i>{song.album || '未知专辑'}</span></div><small>{timecode(song.durationMs / 1000)}</small>{pickedSong?.id === song.id ? <Check size={16} /> : <ChevronRight size={16} />}</button>)}</div><div className="online-lyrics-preview"><div className="workflow-column-heading"><span>2 <strong>预览歌词</strong></span>{lyricsResult && <small>{onlinePreview.length} 行{lyricsResult.translatedLrc && ' · 含译文'}</small>}</div>{lyricStatus === 'idle' && <div className="workflow-empty"><FileText size={31} /><p>选择左侧歌曲，预览原文与译文。</p></div>}{lyricStatus === 'loading' && <div className="workflow-empty"><LoaderCircle className="spin" size={27} /><p>正在获取歌词…</p></div>}{lyricStatus === 'empty' && <div className="workflow-empty"><FileText size={29} /><h3>该歌曲暂未提供可用歌词</h3><p>可能为纯音乐，或来源没有收录歌词。<br />你仍可导入本地 LRC / SRT 文件。</p><Button onClick={() => openLyricFile('original')}>导入本地歌词</Button></div>}{lyricStatus === 'error' && <div className="error-panel"><strong>歌词获取失败</strong><p>{lyricError}</p><Button onClick={() => pickedSong && void selectSong(pickedSong)}>重新获取</Button></div>}{lyricStatus === 'done' && <div className="lyric-preview-lines">{onlinePreview.map((cue, index) => <div key={index}><time>{timecode(cue.time)}</time><section><p>{cue.text}</p>{cue.translation && <small>{cue.translation}</small>}</section></div>)}</div>}</div></div><div className="modal-footer lyrics-footer"><span className="privacy-note"><ShieldCheck size={14} />仅获取歌词，不下载歌曲音频</span><div><label className="checkbox-label"><input type="checkbox" checked={applySongInfo} onChange={e => setApplySongInfo(e.target.checked)} />同时更新歌名和歌手</label><Button className="primary" disabled={lyricStatus !== 'done' || !onlinePreview.length} onClick={applyOnlineLyrics}><Plus size={15} />加入工程</Button></div></div></> : <><div className="lyric-edit-toolbar"><div><Button onClick={() => openLyricFile('original')}><Upload size={14} />导入原文</Button><Button onClick={() => openLyricFile('translation')}><Plus size={14} />合并译文</Button><select aria-label="歌词文件编码" value={encoding} onChange={e => setEncoding(e.target.value)}><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option><option value="shift-jis">Shift-JIS</option></select></div><div><Button onClick={() => downloadText(lyricsToLrc(project.lyrics, project.lyricsOffsetMs), `${project.title}.lrc`, 'text/plain;charset=utf-8')}><Download size={14} />导出 LRC</Button><Button onClick={() => commit(current => ({ ...current, lyrics: [...current.lyrics, { time: Math.round(time * 100) / 100, text: '新歌词', translation: '' }].sort((a, b) => a.time - b.time) }))}><Plus size={14} />添加当前时间</Button></div></div><div className="lyric-edit-head"><span>时间 / 秒</span><span>原文</span><span>译文</span><span /></div><div className="lyric-edit-rows">{project.lyrics.length ? project.lyrics.map((cue, index) => <div className={`lyric-edit-row${index === currentCueIndex ? ' current' : ''}`} key={index}><div><button title="定位到该句" onClick={() => { pause(); seek(cue.time + project.lyricsOffsetMs / 1000); }}><Play size={12} /></button><input aria-label={`第 ${index + 1} 行时间`} type="number" step=".01" min="0" value={cue.time} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value)) commit(current => ({ ...current, lyrics: current.lyrics.map((item, i) => i === index ? { ...item, time: Math.max(0, value) } : item) })); }} /></div><textarea aria-label={`第 ${index + 1} 行原文`} value={cue.text} onChange={e => commit(current => ({ ...current, lyrics: current.lyrics.map((item, i) => i === index ? { ...item, text: e.target.value } : item) }))} /><textarea aria-label={`第 ${index + 1} 行译文`} placeholder="可选译文" value={cue.translation ?? ''} onChange={e => commit(current => ({ ...current, lyrics: current.lyrics.map((item, i) => i === index ? { ...item, translation: e.target.value } : item) }))} /><IconButton label={`删除第 ${index + 1} 行`} onClick={() => commit(current => ({ ...current, lyrics: current.lyrics.filter((_, i) => i !== index) }))}><Trash2 size={14} /></IconButton></div>) : <div className="workflow-empty"><FileText size={29} /><p>还没有歌词，在线获取或导入一个歌词文件。</p></div>}</div><div className="modal-footer"><div className="offset-control"><span>整体偏移</span><Button onClick={() => commit(current => ({ ...current, lyricsOffsetMs: current.lyricsOffsetMs - 100 }))}><Minus size={12} />100</Button><NumberField label="" value={project.lyricsOffsetMs} suffix="ms" step={100} onChange={lyricsOffsetMs => commit(current => ({ ...current, lyricsOffsetMs }))} /><Button onClick={() => commit(current => ({ ...current, lyricsOffsetMs: current.lyricsOffsetMs + 100 }))}><Plus size={12} />100</Button><small>正值延后</small></div><Button className="primary" onClick={() => { commit(current => ({ ...current, lyrics: [...current.lyrics].sort((a, b) => a.time - b.time) })); setShowLyrics(false); }}>完成校对</Button></div></>}
    </Modal>}

    {showExport && <Modal title="导出音乐视频" subtitle="使用与预览相同的场景，逐帧渲染并编码为 MP4。" onClose={() => setShowExport(false)}><div className="export-content"><div className="export-summary"><div className="export-summary-art"><Disc3 size={31} /></div><div><strong>{project.title || '未命名视频'}</strong><span>{timecode(project.duration)} · {project.fps} fps · H.264 / AAC</span></div><span className="file-badge">.MP4</span></div><label className="export-field"><span>输出分辨率</span><select value={exportResolution} disabled={exportBusy} onChange={e => setExportResolution(e.target.value)}><option value="720">1280 × 720 — 720p · 更快</option><option value="1080">1920 × 1080 — 1080p · 高清</option></select></label><label className="export-field"><span>导出范围</span><select value={exportRange} disabled={exportBusy} onChange={e => setExportRange(e.target.value as 'all' | 'clip')}><option value="all">完整工程（{timecode(project.duration)}）</option><option value="clip">10 秒测试片段</option></select></label>{exportRange === 'clip' && <NumberField label="开始时间" suffix="秒" value={exportStart} min={0} max={Math.max(0, project.duration - .1)} step={.1} onChange={setExportStart} />}
      {exportProgress && <div className={`export-progress-block ${exportProgress.state}`}><div><strong>{exportProgress.state === 'rendering' ? '正在合成画面并编码' : exportProgress.state === 'encoding' ? '正在完成视频文件' : exportProgress.state === 'complete' ? '视频已导出' : exportProgress.state === 'cancelled' ? '导出已取消' : '导出未完成'}</strong><span>{exportProgress.state === 'complete' ? <Check size={17} /> : `${Math.min(100, exportPercent)}%`}</span></div><progress max="100" value={Math.min(100, exportPercent)} /><p>{exportProgress.message || (exportProgress.state === 'rendering' ? `${exportProgress.completed} / ${exportProgress.total} 帧${exportRate ? ` · ${exportRate}` : ''}${exportElapsed ? ` · 已用 ${exportElapsed}` : ''}` : exportProgress.state === 'complete' ? `${exportElapsed ? `用时 ${exportElapsed}。` : ''}点击下方按钮保存到你的电脑。` : '导出过程中可以关闭此窗口并继续编辑。')}</p></div>}
      {exportError && <div className="error-panel"><strong>导出失败</strong><p>{exportError}</p></div>}<div className="export-note"><ShieldCheck size={16} /><p>音乐、图片、视频与逐帧画面在本机处理。导出使用开始时的工程快照，文件包含当前可见组件{project.audio ? project.audioMuted ? '与静音音轨' : '与配乐' : '，没有配乐时输出无声视频'}。</p></div></div><div className="modal-footer"><span className="export-estimate">{exportResolution}p · {Math.ceil((exportRange === 'all' ? project.duration : Math.min(10, project.duration - exportStart)) * project.fps)} 帧</span><div>{exportBusy ? <Button onClick={() => exportAbort.current?.abort()}><Square size={13} />取消导出</Button> : exportUrl ? <><Button onClick={() => { setExportUrl(''); setExportProgress(null); }}>再次导出</Button><a className="button primary" href={exportUrl} download><Download size={15} />下载 MP4</a></> : <Button className="primary" disabled={!!project.audio && !analysis} onClick={() => void startExport()}><Download size={15} />开始导出</Button>}</div></div></Modal>}

    {help && <Modal title="从一首歌，到一支音乐视频" subtitle="三个步骤开始创作；所有组件都可以独立编排。" onClose={() => setHelp(false)}><div className="help-content"><div><span>1</span><section><h3>导入音乐与封面</h3><p>左侧导入素材。现在的工程已包含原创合成演示音乐与封面。</p></section></div><div><span>2</span><section><h3>获取歌词，设计画面</h3><p>搜索歌名或粘贴歌曲分享链接获取歌词；在画布中拖动组件，使用右侧属性精调。</p></section></div><div><span>3</span><section><h3>试听与导出</h3><p>点击时间尺定位，使用播放按钮试听。先导出 10 秒片段检查，再生成完整 MP4。</p></section></div><div className="shortcut-grid"><span>播放 / 暂停<kbd>Space</kbd></span><span>保存工程<kbd>Ctrl S</kbd></span><span>撤销 / 重做<kbd>Ctrl Z / Y</kbd></span><span>复制组件<kbd>Ctrl D</kbd></span><span>微调位置<kbd>方向键</kbd></span><span>比例缩放 / 角度吸附<kbd>Shift</kbd></span><span>临时关闭吸附<kbd>Alt</kbd></span><span>删除 / 取消选择<kbd>Delete / Esc</kbd></span></div><p className="parameter-note">音频素材引用当前本机服务；保存工程 JSON 不会内嵌音频图片。在线歌词来自音乐服务公开接口，服务异常时可直接导入 LRC / SRT。</p></div></Modal>}
    {toast && <div role="status" className={`toast${toast.error ? ' error' : ''}`}>{toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button></div>}
  </div></ParameterHistoryContext.Provider>;
}

function TextContentField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const history = useContext(ParameterHistoryContext);
  const owner = useId();
  useEffect(() => () => history.end(owner), [history, owner]);
  return <label className="text-field text-content-field"><span>文本内容<small>{value.length} / 10000</small></span><textarea aria-label="文本内容" maxLength={10000} rows={5} value={value} placeholder="输入文字，可按 Enter 换行" onFocus={() => history.begin(owner)} onChange={event => history.preview(owner, () => onChange(event.target.value))} onBlur={() => history.end(owner)} /></label>;
}

function EffectStackEditor({ layer, target, lyricPerCue, onCopy, onChange }: { layer: { id: string; name: string; locked?: boolean; effects?: LayerEffect[] }; target: 'visual' | 'audio'; lyricPerCue?: boolean; onCopy: (effect: LayerEffect) => void; onChange: (change: (effects: LayerEffect[]) => LayerEffect[]) => void }) {
  const effects = layer.effects ?? [];
  const update = (id: string, patch: Partial<LayerEffect>) => onChange(current => current.map(effect => effect.id === id ? { ...effect, ...patch } : effect));
  const move = (id: string, offset: -1 | 1) => onChange(current => {
    const index = current.findIndex(effect => effect.id === id);
    if (index < 0 || index + offset < 0 || index + offset >= current.length) return current;
    const next = [...current]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next;
  });
  return <div className="effect-stack" data-testid="effect-stack">
    <div className="section-label">已应用效果<span>{effects.length} / {MAX_LAYER_EFFECTS}</span></div>
    {!effects.length && <div className="effect-stack-empty"><Sparkles size={24} /><p>此轨道还没有效果</p><span>从左侧效果库添加，或拖到时间轴轨道。</span></div>}
    {effects.map((effect, index) => {
      const def = EFFECT_DEFINITIONS.find(item => item.type === effect.type);
      if (!def) return null;
      const prefix = `${def.name} ${index + 1}`;
      const defaults = effectDefaults(effect.type);
      const preset = effect.type === 'color' ? COLOR_EFFECT_PRESETS.find(item => Object.entries(item.params).every(([key, value]) => (effect.params[key] ?? defaults[key]) === value))?.value ?? '__custom__' : '';
      const stopSummary = (event: ReactMouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); };
      return <details className={`effect-stack-item${effect.enabled ? '' : ' effect-bypassed'}`} key={effect.id} open data-testid={`effect-stack-item-${effect.id}`} data-effect-type={effect.type}>
        <summary><button className="effect-enable" aria-label={`${effect.enabled ? '关闭' : '开启'}${prefix}`} aria-pressed={effect.enabled} disabled={layer.locked} onClick={event => { stopSummary(event); update(effect.id, { enabled: !effect.enabled }); }} title={effect.enabled ? '暂时关闭此效果' : '开启此效果'}>{effect.enabled ? <Eye size={13} /> : <EyeOff size={13} />}</button><strong title={def.name}><small>{String(index + 1).padStart(2, '0')}</small>{def.name}</strong><span className="effect-order-actions"><IconButton label={`复制${prefix}`} onClick={event => { stopSummary(event); onCopy(effect); }}><Copy size={12} /></IconButton><IconButton label={`上移${prefix}`} disabled={layer.locked || index === 0} onClick={event => { stopSummary(event); move(effect.id, -1); }}><ArrowUp size={12} /></IconButton><IconButton label={`下移${prefix}`} disabled={layer.locked || index === effects.length - 1} onClick={event => { stopSummary(event); move(effect.id, 1); }}><ArrowDown size={12} /></IconButton><IconButton label={`删除${prefix}`} disabled={layer.locked} onClick={event => { stopSummary(event); onChange(current => current.filter(item => item.id !== effect.id)); }}><Trash2 size={12} /></IconButton></span><ChevronDown size={12} /></summary>
        <fieldset disabled={layer.locked} className="effect-stack-controls"><p className="parameter-note">{def.description}{!effect.enabled && ' · 效果已关闭'}</p><RangeField label={`${prefix} · 整体强度`} value={Math.round(effect.strength * 10000) / 100} min={0} max={100} step={1} suffix="%" onChange={strength => update(effect.id, { strength: strength / 100 })} />
          {effect.type === 'color' && <SelectField label={`${prefix} · 调色预设`} value={preset} options={[['__custom__', '自定义'], ...COLOR_EFFECT_PRESETS.map(item => [item.value, item.label] as [string, string])]} onChange={value => { const next = COLOR_EFFECT_PRESETS.find(item => item.value === value); if (next) update(effect.id, { params: { ...next.params } }); }} />}
          {def.controls.map(control => {
            const value = Number(effect.params[control.key] ?? defaults[control.key]);
            const setValue = (next: number) => update(effect.id, { params: { ...effect.params, [control.key]: control.integer ? Math.round(next) : next } });
            const label = `${prefix} · ${control.label}`;
            if (effect.type === 'audio-reactive') {
              if (control.key === 'band') return <SelectField key={control.key} label={label} value={String(value)} options={[["0", "全频"], ["1", "低频 · 35–250 Hz"], ["2", "中频 · 250–4000 Hz"], ["3", "高频 · 4000–16000 Hz"], ["4", "自定义频段"]]} onChange={next => setValue(Number(next))} />;
              if (['lowHz', 'highHz'].includes(control.key) && Number(effect.params.band ?? defaults.band) !== 4) return null;
            }
            if (effect.type === 'fade') {
              if (control.key === 'style') return target === 'audio' ? null : <SelectField key={control.key} label={label} value={String(value)} options={[["0", "透明度淡入淡出"], ["1", "淡入上移"], ["2", "淡入下移"], ["3", "淡入左移"], ["4", "淡入右移"], ["5", "淡入缩放"]]} onChange={next => setValue(Number(next))} />;
              if (control.key === 'curve') return <SelectField key={control.key} label={label} value={String(value)} options={[["0", "平滑"], ["1", "线性"], ["2", target === 'audio' ? "等功率" : "正弦缓入"]]} onChange={next => setValue(Number(next))} />;
              if (control.key === 'timing') return target === 'audio' || !lyricPerCue ? null : <SelectField key={control.key} label={label} value={String(value)} options={[["0", "组件出入场"], ["1", "每句歌词"]]} onChange={next => setValue(Number(next))} />;
              if (control.key === 'distance' && (target === 'audio' || ![1, 2, 3, 4].includes(Number(effect.params.style ?? defaults.style)))) return null;
            }
            const percent = effect.type === 'audio-reactive' && ['threshold', 'scale', 'brightness', 'opacity'].includes(control.key);
            const factor = percent ? 100 : 1;
            return <RangeField key={control.key} label={label} value={Math.round(value * factor * 10000) / 10000} min={control.min * factor} max={control.max * factor} step={control.step * factor} suffix={percent ? '%' : control.suffix} onChange={next => setValue(next / factor)} />;
          })}
          {effect.type === 'audio-reactive' && <p className="parameter-note">以工程配乐为驱动，缩放围绕组件中心。静音、配乐结束或缺少分析时保持原画；配乐淡入淡出也会同步减弱联动。自定义频段受采样率和 16 kHz 分析上限约束。拖动播放头和导出得到相同结果。</p>}
          {effect.type === 'fade' && <p className="parameter-note">{target === 'audio' ? '音频只改变音量，画面样式不作用于音轨。淡出在配乐与工程中较早的终点结束。' : lyricPerCue && Number(effect.params.timing ?? defaults.timing) === 1 ? '每句原文与译文同步进入和退出；句子较短时，过渡会自动缩短。' : '以组件在时间线上的起点和终点计算；片段较短时，过渡会自动缩短。'}</p>}
          <Button className="effect-reset" aria-label={`重置${prefix}`} onClick={() => onChange(current => current.map(item => item.id === effect.id ? resetEffect(item) : item))}><RotateCcw size={12} />恢复默认</Button>
        </fieldset>
      </details>;
    })}
  </div>;
}

function FontPicker({ label = '文字字体', value, fonts, busy, onChange, onImport }: { label?: string; value: string; fonts: FontAsset[]; busy: boolean; onChange: (fontId: string) => void; onImport: () => void }) {
  const choices = [...BUILTIN_FONTS, ...fonts.filter(font => !BUILTIN_FONTS.some(builtin => builtin.id === font.id))];
  return <div className="font-picker"><SelectField label={label} value={value} onChange={onChange} options={[["", "系统默认"], ...choices.map(font => [font.id, font.name] as [string, string])]} /><div className="font-picker-actions"><small>{!value ? '使用本机系统字体' : fonts.some(font => font.id === value) ? '已导入字体' : '内置字体 · 免费可商用'}</small><Button onClick={onImport} aria-label={label === '文字字体' ? '导入字体' : `导入${label}`} disabled={busy}>{busy ? <LoaderCircle className="spin" size={12} /> : <Upload size={12} />}{busy ? '正在导入…' : '导入字体'}</Button></div><p className="parameter-note font-formats">TTF · OTF · WOFF · WOFF2，可多选</p></div>;
}

function AtmosphereEditor({ params, onChange }: { params: Layer['params']; onChange: (patch: Layer['params']) => void }) {
  const kind = ATMOSPHERE_KINDS.find(item => item.value === params.kind)?.value ?? 'leak';
  const presets = ATMOSPHERE_PRESETS.filter(item => item.kind === kind);
  const preset = presets.find(item => item.value === params.preset)?.value ?? presets[0].value;
  const defaults: Layer['params'] = atmosphereDefaults(kind, preset);
  const value = (key: string) => Number(params[key] ?? defaults[key]);
  const applyPreset = (nextKind: typeof kind, nextPreset?: string) => {
    const chosen = ATMOSPHERE_PRESETS.find(item => item.kind === nextKind && item.value === nextPreset)
      ?? ATMOSPHERE_PRESETS.find(item => item.kind === nextKind)!;
    onChange({ ...atmosphereDefaults(nextKind, chosen.value), seed: Math.round(value('seed')), fadeIn: value('fadeIn'), fadeOut: value('fadeOut') });
  };
  const field = (key: keyof typeof ATMOSPHERE_LIMITS, label: string, step: number, suffix?: string, percent = false, integer = false) => {
    const factor = percent ? 100 : 1;
    return <RangeField label={label} value={value(key) * factor} min={ATMOSPHERE_LIMITS[key][0] * factor} max={ATMOSPHERE_LIMITS[key][1] * factor} step={step} suffix={suffix} onChange={next => onChange({ [key]: integer ? Math.round(next / factor) : next / factor })} />;
  };
  const sourceFields = <>{field('sourceX', '光源横向位置', 1, '%', true)}{field('sourceY', '光源纵向位置', 1, '%', true)}</>;
  return <div className="atmosphere-editor" data-testid="atmosphere-editor">
    <SelectField label="氛围类型" value={kind} options={ATMOSPHERE_KINDS.map(item => [item.value, item.label])} onChange={next => {
      const nextKind = ATMOSPHERE_KINDS.find(item => item.value === next)?.value;
      if (nextKind) applyPreset(nextKind);
    }} />
    <SelectField label="氛围预设" value={preset} options={presets.map(item => [item.value, item.label])} onChange={next => applyPreset(kind, next)} />
    <p className="parameter-note">切换类型或预设会重置外观与运动参数，保留随机种子、轨道效果、组件变换和时间区间。</p>
    <details className="parameter-group" open><summary><span>色彩与叠加</span><ChevronDown size={13} /></summary><div className="parameter-group-content">
      {field('intensity', '氛围强度', 1, '%', true)}
      <ColorField label="氛围主色" value={String(params.color ?? defaults.color)} onChange={color => onChange({ color })} />
      <ColorField label="辅助光色" value={String(params.secondaryColor ?? defaults.secondaryColor)} onChange={secondaryColor => onChange({ secondaryColor })} />
      <SelectField label="氛围混合方式" value={String(params.blendMode ?? defaults.blendMode)} options={[["normal", "正常"], ["screen", "滤色"], ["add", "添加"]]} onChange={blendMode => onChange({ blendMode })} />
    </div></details>
    <details className="parameter-group" open><summary><span>{kind === 'leak' ? '光泄漏形态' : kind === 'fog' ? '薄雾形态' : '光束形态'}</span><ChevronDown size={13} /></summary><div className="parameter-group-content">
      {kind === 'leak' && <>{field('scale', '光泄漏覆盖', .05, '倍')}{sourceFields}</>}
      {kind === 'fog' && <>{field('density', '雾密度', 1, '%', true)}{field('scale', '雾纹理尺度', .05, '倍')}</>}
      {kind === 'rays' && <>{sourceFields}{field('spread', '光束展开角', 1, '°')}{field('rayCount', '光束数量', 1, undefined, false, true)}{field('length', '光束长度', .05, '倍')}{field('scale', '光束宽度', .05, '倍')}</>}
      {field('softness', '氛围柔边', 1, '%', true)}
    </div></details>
    <details className="parameter-group" open><summary><span>运动与变化</span><ChevronDown size={13} /></summary><div className="parameter-group-content">
      {field('speed', '氛围运动速度', .05, '倍')}
      {field('direction', kind === 'rays' ? '光束朝向' : kind === 'leak' ? '光斑朝向' : '氛围运动方向', 1, '°')}
      {field('variation', '变化幅度', 1, '%', true)}
      <p className="parameter-note">速度设为 0 可保持静止；运动由组件内时间驱动，拖动播放头与导出保持一致。</p>
    </div></details>
    <details className="parameter-group"><summary><span>分布</span><ChevronDown size={13} /></summary><div className="parameter-group-content">
      {field('seed', '氛围随机种子', 1, undefined, false, true)}
      <Button className="full-button" aria-label="重新生成氛围分布" onClick={() => {
        const next = 1 + Math.floor(Math.random() * ATMOSPHERE_LIMITS.seed[1]);
        onChange({ seed: next === value('seed') ? next % ATMOSPHERE_LIMITS.seed[1] + 1 : next });
      }}><RotateCcw size={13} />重新分布</Button>
      <p className="parameter-note">出入场动效请从“效果”库添加淡入淡出，调整时长与样式。</p>
    </div></details>
    <p className="parameter-note">默认置于背景上方，可在轨道中调整层序到前景。此组件绘制光影氛围，不自动识别画面遮挡或光源。</p>
  </div>;
}

function ParticleEditor({ params, onChange }: { params: Layer['params']; onChange: (patch: Layer['params']) => void }) {
  const preset = PARTICLE_PRESETS.find(item => item.value === params.preset)?.value ?? 'stardust';
  const defaults: Layer['params'] = particleDefaults(preset);
  const value = (key: string) => Number(params[key] ?? defaults[key]);
  return <>
    <SelectField label="粒子预设" value={preset} options={PARTICLE_PRESETS.map(item => [item.value, item.label])} onChange={next => {
      const selectedPreset = PARTICLE_PRESETS.find(item => item.value === next)?.value;
      if (selectedPreset) onChange({ ...particleDefaults(selectedPreset), seed: value('seed') });
    }} />
    <p className="parameter-note">切换预设会重置下方外观与运动参数；保留分布种子、组件变换和时间区间。</p>
    <RangeField label="粒子数量" value={value('count')} min={PARTICLE_LIMITS.count[0]} max={PARTICLE_LIMITS.count[1]} step={1} onChange={count => onChange({ count: Math.round(count) })} />
    <RangeField label="粒子大小" suffix="px" value={value('size')} min={PARTICLE_LIMITS.size[0]} max={PARTICLE_LIMITS.size[1]} step={.5} onChange={size => onChange({ size })} />
    <RangeField label="运动速度" suffix="倍" value={value('speed')} min={PARTICLE_LIMITS.speed[0]} max={PARTICLE_LIMITS.speed[1]} step={.05} onChange={speed => onChange({ speed })} />
    <RangeField label="水平风力" value={value('wind')} min={PARTICLE_LIMITS.wind[0]} max={PARTICLE_LIMITS.wind[1]} step={.05} onChange={wind => onChange({ wind })} />
    <RangeField label="飘动幅度" value={value('turbulence')} min={PARTICLE_LIMITS.turbulence[0]} max={PARTICLE_LIMITS.turbulence[1]} step={.05} onChange={turbulence => onChange({ turbulence })} />
    <ColorField label="粒子颜色" value={String(params.color ?? defaults.color)} onChange={color => onChange({ color })} />
    <RangeField label="粒子不透明度" suffix="%" value={Math.round(value('particleOpacity') * 100)} min={PARTICLE_LIMITS.particleOpacity[0] * 100} max={PARTICLE_LIMITS.particleOpacity[1] * 100} step={1} onChange={next => onChange({ particleOpacity: next / 100 })} />
    <RangeField label="闪烁强度" suffix="%" value={Math.round(value('twinkle') * 100)} min={PARTICLE_LIMITS.twinkle[0] * 100} max={PARTICLE_LIMITS.twinkle[1] * 100} step={1} onChange={next => onChange({ twinkle: next / 100 })} />
    <details className="parameter-group"><summary><span>粒子分布</span><ChevronDown size={13} /></summary><div className="parameter-group-content">
      <RangeField label="分布种子" value={value('seed')} min={PARTICLE_LIMITS.seed[0]} max={PARTICLE_LIMITS.seed[1]} step={1} onChange={seed => onChange({ seed: Math.round(seed) })} />
      <Button className="full-button" onClick={() => {
        const next = 1 + Math.floor(Math.random() * PARTICLE_LIMITS.seed[1]);
        onChange({ seed: next === value('seed') ? next % PARTICLE_LIMITS.seed[1] + 1 : next });
      }}><RotateCcw size={13} />重新分布</Button>
    </div></details>
    <p className="parameter-note">宽度与高度控制粒子活动区域，水平风力负值向左、正值向右。默认位于背景上方；可在图层面板上移至前景、添加多个粒子组件。锁定后可在画布选择下方组件。定位、播放和导出使用同一套运动。</p>
  </>;
}

function TextGlowEditor({ params, onChange, scope }: { params: Layer['params']; onChange: (patch: Layer['params']) => void; scope: LayerType }) {
  const enabled = params.glowEnabled === true;
  return <details className="parameter-group" open><summary><span>自发光</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><Toggle label="启用自发光" checked={enabled} onChange={glowEnabled => onChange({ glowEnabled })} />{enabled && <><ColorField label="发光颜色" value={String(params.glowColor ?? '#ffffff')} onChange={glowColor => onChange({ glowColor })} /><RangeField label="发光强度" suffix="%" value={Math.round(Number(params.glowIntensity ?? 1) * 100)} min={0} max={200} step={1} onChange={value => onChange({ glowIntensity: value / 100 })} /><RangeField label="发光范围" suffix="px" value={Number(params.glowRadius ?? 18)} min={0} max={80} step={1} onChange={glowRadius => onChange({ glowRadius })} /><p className="parameter-note">在文字边缘叠加柔和光晕，保留文字本身的颜色。{scope === 'lyrics' ? '原文、译文及各行共用此效果。' : scope === 'title' ? '歌名与歌手 / 副标题共用此效果。' : '效果应用于文本框中的全部文字。'}</p></>}</div></details>;
}

function LyricsStyleEditor({ params, onChange }: { params: Layer['params']; onChange: (patch: Layer['params']) => void }) {
  const [tab, setTab] = useState<'active' | 'inactive'>('active');
  const inactive = params.mode === 'scroll' && tab === 'inactive';
  const prefix = inactive ? '非当前' : '播放中';
  const parameterKey = (name: string) => {
    if (inactive) return `inactive${name[0].toUpperCase()}${name.slice(1)}`;
    if (['fontSize', 'translationSize', 'color', 'translationColor'].includes(name)) return name;
    return `active${name[0].toUpperCase()}${name.slice(1)}`;
  };
  const styles = normalizeLyricStyles(params);
  const numberValue = (name: string, fallback: number) => Number(styles[parameterKey(name)] ?? fallback);
  const stringValue = (name: string, fallback: string) => String(styles[parameterKey(name)] ?? fallback);
  const change = (name: string, value: string | number | boolean) => onChange({ [parameterKey(name)]: value });
  const shadow = params[parameterKey('shadowEnabled')] !== false;
  const activeSize = Number(styles.fontSize ?? 43);
  const activeTranslationSize = Number(styles.translationSize ?? 36);
  const activeColor = String(styles.color ?? '#ffffff');
  const activeTranslationColor = String(styles.translationColor ?? '#e5e2f0');
  return <div className="lyrics-style-editor"><div className="lyrics-style-tabs" role="tablist" aria-label="歌词样式对象"><button role="tab" aria-selected={!inactive} className={!inactive ? 'active' : ''} onClick={() => setTab('active')}>播放中歌词</button>{params.mode === 'scroll' && <button role="tab" aria-selected={inactive} className={inactive ? 'active' : ''} onClick={() => setTab('inactive')}>非当前歌词</button>}</div><div className="lyrics-style-body" role="tabpanel" aria-label={`${prefix}歌词样式`}><p className="parameter-note style-target-note">{inactive ? '此样式同时应用于已播放和待播放的歌词。' : '此样式应用于当前正在播放的一句。'}</p><RangeField label={`${prefix}原文字号`} suffix="px" value={numberValue('fontSize', activeSize)} min={10} max={180} step={1} onChange={value => change('fontSize', value)} /><RangeField label={`${prefix}译文字号`} suffix="px" value={numberValue('translationSize', activeTranslationSize)} min={10} max={180} step={1} onChange={value => change('translationSize', value)} /><RangeField label={`${prefix}原文字重`} value={numberValue('fontWeight', inactive ? 400 : 600)} min={100} max={900} step={100} onChange={value => change('fontWeight', value)} /><Toggle label={`${prefix}原文斜体`} checked={params[parameterKey('italic')] === true} onChange={value => change('italic', value)} /><RangeField label={`${prefix}译文字重`} value={numberValue('translationFontWeight', inactive ? 400 : 500)} min={100} max={900} step={100} onChange={value => change('translationFontWeight', value)} /><Toggle label={`${prefix}译文斜体`} checked={params[parameterKey('translationItalic')] === true} onChange={value => change('translationItalic', value)} /><p className="parameter-note">可变字体可细分字重；常规字体支持合成加粗。</p><ColorField label={`${prefix}原文颜色`} value={stringValue('color', activeColor)} onChange={value => change('color', value)} /><ColorField label={`${prefix}译文颜色`} value={stringValue('translationColor', activeTranslationColor)} onChange={value => change('translationColor', value)} /><RangeField label={`${prefix}歌词不透明度`} suffix="%" value={Math.round(numberValue('opacity', inactive ? .24 : 1) * 100)} min={0} max={100} step={1} onChange={value => change('opacity', value / 100)} /><details className="parameter-group nested-parameter-group"><summary><span>{prefix}描边</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><RangeField label={`${prefix}描边宽度`} suffix="px" value={numberValue('strokeWidth', 0)} min={0} max={20} step={.5} onChange={value => change('strokeWidth', value)} /><ColorField label={`${prefix}描边颜色`} value={stringValue('strokeColor', '#080810')} onChange={value => change('strokeColor', value)} /></div></details><details className="parameter-group nested-parameter-group"><summary><span>{prefix}阴影</span><ChevronDown size={13} /></summary><div className="parameter-group-content"><Toggle label={`${prefix}文字阴影`} checked={shadow} onChange={value => change('shadowEnabled', value)} />{shadow && <><ColorField label={`${prefix}阴影颜色`} value={stringValue('shadowColor', '#07080d')} onChange={value => change('shadowColor', value)} /><RangeField label={`${prefix}阴影不透明度`} suffix="%" value={Math.round(numberValue('shadowOpacity', .75) * 100)} min={0} max={100} step={1} onChange={value => change('shadowOpacity', value / 100)} /><RangeField label={`${prefix}阴影模糊`} suffix="px" value={numberValue('shadowBlur', 8)} min={0} max={80} step={1} onChange={value => change('shadowBlur', value)} /><RangeField label={`${prefix}阴影水平偏移`} suffix="px" value={numberValue('shadowX', 0)} min={-100} max={100} step={1} onChange={value => change('shadowX', value)} /><RangeField label={`${prefix}阴影垂直偏移`} suffix="px" value={numberValue('shadowY', 2)} min={-100} max={100} step={1} onChange={value => change('shadowY', value)} /></>}</div></details></div></div>;
}

function RangeField({ label, value, min, max, step, onChange, suffix, numericMin = min, numericMax = max }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; suffix?: string; numericMin?: number; numericMax?: number }) {
  const history = useContext(ParameterHistoryContext);
  const owner = useId();
  const inputId = `${owner}-range`;
  const [numberDraft, setNumberDraft] = useState<string | null>(null);
  const mode = useRef<'pointer' | 'keyboard' | 'number' | null>(null);
  const keys = useRef(new Set<string>());
  const finish = useCallback(() => { mode.current = null; keys.current.clear(); history.end(owner); }, [history, owner]);
  const start = (kind: 'pointer' | 'keyboard' | 'number') => { mode.current = kind; history.begin(owner); };
  const change = (next: number) => {
    const single = mode.current === null;
    history.preview(owner, () => onChange(Math.round(clamp(next, numericMin, numericMax) * 10000) / 10000));
    if (single) history.end(owner);
  };
  const nudge = (direction: -1 | 1) => { finish(); change(value + direction * step); };
  useEffect(() => {
    const finishPointer = () => { if (mode.current === 'pointer') finish(); };
    const finishKey = (event: KeyboardEvent) => {
      if (mode.current !== 'keyboard' || !parameterKeys.has(event.key)) return;
      keys.current.delete(event.key); if (!keys.current.size) finish();
    };
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);
    window.addEventListener('keyup', finishKey);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      window.removeEventListener('keyup', finishKey);
      window.removeEventListener('blur', finish);
      history.end(owner);
    };
  }, [finish, history, owner]);
  return <div className="range-field" data-parameter-control="true"><div className="range-field-heading"><label htmlFor={inputId}>{label}</label><div className="range-value"><input aria-label={`${label}数值`} type="number" value={numberDraft ?? Math.round(value * 10000) / 10000} min={numericMin} max={numericMax} step={step} onFocus={() => { setNumberDraft(String(Math.round(value * 10000) / 10000)); start('number'); }} onBlur={event => { const raw = event.currentTarget.value; if (raw !== '' && Number.isFinite(Number(raw))) change(Number(raw)); setNumberDraft(null); finish(); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) setNumberDraft(null); if (event.key === 'Enter') event.currentTarget.blur(); }} onChange={event => { const raw = event.target.value; setNumberDraft(raw); const next = Number(raw); if (raw !== '' && Number.isFinite(next) && next >= numericMin && next <= numericMax) change(next); }} />{suffix && <small>{suffix}</small>}</div></div><div className="range-slider-row"><button aria-label={`减少${label}`} title={`减少 ${step}${suffix ?? ''}`} disabled={value <= numericMin} onClick={() => nudge(-1)}><Minus size={11} /></button><input id={inputId} aria-label={label} type="range" min={min} max={max} step={step} value={clamp(value, min, max)} onPointerDown={event => { start('pointer'); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window events also end the gesture. */ } }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { if (mode.current === 'pointer') finish(); }} onKeyDown={event => { if (parameterKeys.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) { if (mode.current !== 'keyboard') start('keyboard'); keys.current.add(event.key); } }} onBlur={finish} onChange={event => change(Number(event.target.value))} /><button aria-label={`增加${label}`} title={`增加 ${step}${suffix ?? ''}`} disabled={value >= numericMax} onClick={() => nudge(1)}><Plus size={11} /></button></div></div>;
}
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{options.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select></label>;
}
function lyricsToLrc(cues: DemoProject['lyrics'], delayMs = 0) {
  const shift = -Math.min(0, ...cues.map(cue => cue.time));
  const fileOffset = Math.round(shift * 1000 - delayMs);
  return `${fileOffset ? `[offset:${fileOffset}]\n` : ''}${cues.map(cue => `[${lrcTime(cue.time + shift)}]${cue.text}${cue.translation ? `\n[${lrcTime(cue.time + shift)}]${cue.translation}` : ''}`).join('\n')}`;
}
