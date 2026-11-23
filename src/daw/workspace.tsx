import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeftToLine, AudioLines, ChevronDown, ChevronUp, Clapperboard, Copy, FilePlus2, FolderOpen, HelpCircle, LoaderCircle, Magnet, Maximize2, MousePointer2, Music2, Pause, Play, Plus, Plug, Redo2, Save, Scissors, Settings2, SlidersHorizontal, Sparkles, Square, Trash2, Undo2, Upload, Volume2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { DawAsset, DawClip, DawSession, DawTrack } from './model';
import { DAW_TRACK_COLORS, addAssetToSession, addClip, addTrack, clipEnvelopeAt, createSession, createTrack, deleteClip, deleteTrack, duplicateClip, getMusicalGrid, moveClip, parseSession, serializeSession, sessionDuration, splitClip, trimClip, updateClip, updateMaster, updateMusicalGrid, updateTrack } from './model';
import { DawAudioEngine } from './native-engine';
import { dawHistoryShortcut } from './history-shortcuts';
import { MATCH_CLIP_MIME, analyzeDawMatchEq, exportDawMix, hydrateDawSession, importDawAudio, importDawRenderToEditor, learnDawNoise } from './services';
import type { DawMixResult, MatchReferenceId } from './services';
import type { MediaAsset } from '../types';
import type { AgentExecutor } from '../agent-client';
import { DawWaveform } from './waveform-view';
import { formatDawBars, getDawGrid, getDawGridLines, snapDawTime } from './timeline-interactions';
import { useDawPanelLayout } from './panel-layout';
import { DAW_MASTER_METER } from './meter';
import { DawMeter, createDawMeterRegistry, paintDawMeters, resetDawMeters } from './meter-view';
import { DAW_PREFERENCES_KEY, readDawPreferences } from './preferences';
import { DAW_GRID_DIVISIONS, type DawGridDivision } from './grid-division';
import { DawRhythmDialog } from './rhythm-dialog';
import { DawAutoMixDialog } from './auto-mix-dialog';
import { createDawAgentBridge, dawAgentError, type DawAgentWorkspace } from './agent-bridge';
import { addEffect, bypassEffectChain, clipEffectTarget, cloneEffectChain, copyEffect, getEffect, getEffectChain, moveEffect, removeEffect, resolveEffectTarget, updateEffect, type DawEffect } from './effects';
import { EffectChainView, EffectEditor, EffectsBrowser } from './effects-view';
import type { EffectMeterReadings } from './effects-view';
import { createVst3Effect } from './vst3';
import { Vst3Editor } from './vst3-view';
import { effectTargetName, getSidechainTracks, getNoiseBounds, makeMatchEqInput, makeNoiseSelectionPreview, matchEqRevision, useDawEffectWindows, type MatchEqAnalysis } from './effect-window-bridge';
import './workspace.css';

const AUTOSAVE_KEY = 'visiki-daw-session-v1';
const LIMIT_HISTORY = 80;
const fmtTime = (seconds: number) => {
  const value = Math.max(0, seconds || 0);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}.${String(Math.floor(value * 1000) % 1000).padStart(3, '0')}`;
};
const fmtMeasurement = (value: number | null | undefined, unit: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : '未测得';
const fmtDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const fmtPan = (value: number) => Math.abs(value) < .005 ? '居中' : `${value < 0 ? 'L' : 'R'} ${Math.round(Math.abs(value) * 100)}`;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input:not([type="range"]),textarea,select,[role="textbox"]'));
const isSpaceTextEntry = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('textarea,[role="textbox"]')) return true;
  const input = target.closest('input');
  return !!input && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden'].includes(input.type);
};
type Selection = { trackId: string; clipId?: string } | null;
type Dialog = 'help' | 'effects' | 'effect-editor' | 'assets' | 'export' | 'new' | 'timeline' | 'rhythm' | 'auto-mix' | null;
type ClipGesture = 'move' | 'start' | 'end' | 'fadeIn' | 'fadeOut';

function RangeField({ label, value, min, max, step = .1, display, onChange, begin, commit }: {
  label: string; value: number; min: number; max: number; step?: number; display?: string;
  onChange: (value: number) => void; begin: () => void; commit: () => void;
}) {
  return <label className="daw-field"><span className="daw-field-top"><span>{label}</span><output>{display ?? value.toFixed(2)}</output></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
      onPointerDown={begin} onPointerUp={commit} onPointerCancel={commit} onBlur={commit}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) begin(); }}
      onKeyUp={commit} onChange={event => onChange(Number(event.target.value))} />
  </label>;
}
function NumberField({ label, value, min = 0, max = 3600, onCommit }: { label: string; value: number; min?: number; max?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(3));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value.toFixed(3)); }, [value]);
  return <label className="daw-number">{label}<input type="number" aria-label={label} min={min} max={max} step="0.01" value={draft}
    onFocus={() => { focused.current = true; cancelled.current = false; }} onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; setDraft(value.toFixed(3)); event.currentTarget.blur(); } }}
    onBlur={() => { focused.current = false; const number = Number(draft); if (cancelled.current || !draft.trim() || !Number.isFinite(number)) setDraft(value.toFixed(3)); else { const next = Math.min(max, Math.max(min, number)); setDraft(next.toFixed(3)); if (next !== value) onCommit(next); } }} /></label>;
}
function EditableName({ value, label, fallback, className, style, onCommit }: { value: string; label: string; fallback: string; className?: string; style?: CSSProperties; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <input aria-label={label} className={className} style={style} maxLength={240} value={draft}
    onFocus={() => { focused.current = true; cancelled.current = false; }} onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; setDraft(value); event.currentTarget.blur(); } }}
    onBlur={() => { focused.current = false; const next = draft.trim() || fallback; setDraft(cancelled.current ? value : next); if (!cancelled.current && next !== value) onCommit(next); }} />;
}
function BpmField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false), cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  return <label className="daw-musical-field"><span>BPM</span><input type="number" aria-label="速度 BPM" min={20} max={300} step={.1} value={draft}
    onFocus={() => { focused.current = true; cancelled.current = false; }} onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); } }}
    onBlur={() => {
      focused.current = false;
      if (cancelled.current || !draft.trim() || !Number.isFinite(Number(draft))) { setDraft(String(value)); return; }
      const next = Math.round(Math.max(20, Math.min(300, Number(draft))) * 10) / 10;
      setDraft(String(next)); if (next !== value) onCommit(next);
    }} /></label>;
}
function IconButton({ label, children, onClick, disabled, active }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return <button type="button" className={`daw-icon${active ? ' active' : ''}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function DawWorkspace({ active, onImportToEditor, registerAgent }: {
  active: boolean;
  onImportToEditor: (asset: MediaAsset) => void;
  registerAgent?: (execute: AgentExecutor, active: boolean) => () => void;
}) {
  const [session, setSession] = useState<DawSession>(() => createSession());
  const sessionRef = useRef(session);
  const [selection, setSelection] = useState<Selection>(null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const history = useRef<{ past: DawSession[]; future: DawSession[] }>({ past: [], future: [] });
  const revision = useRef(0);
  if (!revision.current) revision.current = Number.parseInt(crypto.randomUUID().replaceAll('-', '').slice(0, 12), 16) + 1;
  const agentWorkspace = useRef<DawAgentWorkspace | null>(null);
  const [agentBridge] = useState(() => createDawAgentBridge(() => agentWorkspace.current!));
  const gesture = useRef<DawSession | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [scale, setScale] = useState(35);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const [preferences, setPreferences] = useState(readDawPreferences);
  const snap = preferences.snapEnabled;
  const setSnap = useCallback((value: boolean | ((current: boolean) => boolean)) => setPreferences(previous => ({ ...previous, snapEnabled: typeof value === 'function' ? value(previous.snapEnabled) : value })), []);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [monitorDb, setMonitorDb] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const importingMix = busy === '正在导入剪辑';
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [effectTarget, setEffectTarget] = useState<string>('master');
  const [editingEffect, setEditingEffect] = useState<string | null>(null);
  const [editingReadings, setEditingReadings] = useState<EffectMeterReadings>();
  const [effectComparison, setEffectComparison] = useState<import('./effect-comparison').EffectComparison>();
  const [noiseLearnState, setNoiseLearnState] = useState<{ id: string; pending?: boolean; message?: string }>();
  const [noiseListenId, setNoiseListenId] = useState<string>();
  const noiseRequest = useRef<AbortController | null>(null);
  const [matchResult, setMatchResult] = useState<MatchEqAnalysis>();
  const matchRequest = useRef<AbortController | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState('本机自动保存');
  const [exportResult, setExportResult] = useState<DawMixResult | null>(null);
  const [view, setView] = useState({ left: 0, width: 850, head: 188 });
  const root = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const autoMixSnapshot = useRef<DawSession>(session);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const editCursor = useRef<HTMLDivElement>(null);
  const timeDisplay = useRef<HTMLSpanElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sessionInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<{ trackId?: string; start: number }>({ start: 0 });
  const clipboard = useRef<{ clip: DawClip; trackId: string } | null>(null);
  const meters = useRef(createDawMeterRegistry());
  const activeRef = useRef(active); activeRef.current = active;
  const alive = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  const spaceHandled = useRef(false);
  const engine = useRef<DawAudioEngine | null>(null);
  const [restoring, setRestoring] = useState(true);
  const restoringRef = useRef(restoring); restoringRef.current = restoring;
  const { layout, resizing, handleProps, updateLayout } = useDawPanelLayout(root, active);
  const [snapGuide, setSnapGuide] = useState<{ time: number; label: string } | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    if (!alive.current) return;
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 5000);
  }, []);
  const duration = sessionDuration(session);
  const track = session.tracks.find(item => item.id === selection?.trackId);
  const clip = track?.clips.find(item => item.id === selection?.clipId);
  const clipAsset = session.assets.find(item => item.id === clip?.assetId);
  const musicalGrid = getMusicalGrid(session);
  const rulerOptions = { ...musicalGrid, unit: preferences.rulerUnit, gridDivision: preferences.gridDivision };
  const rulerOptionsRef = useRef(rulerOptions); rulerOptionsRef.current = rulerOptions;
  const signature = `${musicalGrid.beatsPerBar}/${musicalGrid.beatUnit}`;
  const signatures = ['2/4', '3/4', '4/4', '6/8']; if (!signatures.includes(signature)) signatures.push(signature);
  const timelineSeconds = Math.max(60, Math.ceil((duration + 15) / 10) * 10);
  const timelineWidth = Math.max(timelineSeconds * scale, view.width - view.head);
  const grid = getDawGrid(scale, rulerOptions);
  const gridDivisionLabel = DAW_GRID_DIVISIONS.find(item => item.value === preferences.gridDivision)?.label ?? '自动';
  const gridLines = getDawGridLines({ scale, left: view.left, width: Math.max(0, view.width - view.head), totalSeconds: timelineWidth / scale, ...rulerOptions });

  const apply = useCallback((next: DawSession) => {
    if (sessionRef.current !== next) revision.current++;
    sessionRef.current = next; engine.current?.setSession(next); setSession(next);
  }, []);
  const bumpHistory = useCallback(() => setHistoryVersion(value => value + 1), []);
  const beginGesture = useCallback(() => { if (!gesture.current) gesture.current = sessionRef.current; }, []);
  const commitGesture = useCallback(() => {
    const before = gesture.current; gesture.current = null;
    if (before && before !== sessionRef.current) {
      history.current.past = [...history.current.past.slice(-(LIMIT_HISTORY - 1)), before]; history.current.future = []; bumpHistory();
      engine.current?.commitSession();
    }
  }, [bumpHistory]);
  const commitEdit = useCallback((next: DawSession) => {
    const before = sessionRef.current;
    if (next === before) return;
    if (!gesture.current) { history.current.past = [...history.current.past.slice(-(LIMIT_HISTORY - 1)), before]; history.current.future = []; bumpHistory(); }
    apply(next);
  }, [apply, bumpHistory]);
  const edit = useCallback((transform: (current: DawSession) => DawSession) => {
    try { commitEdit(transform(sessionRef.current)); }
    catch (error) { notify(error instanceof Error ? error.message : '编辑未能完成'); }
  }, [commitEdit, notify]);
  const undo = useCallback(async () => {
    commitGesture();
    try {
      await engine.current?.syncVst3Editors();
      if (history.current.past.length && history.current.past.at(-1)?.id !== sessionRef.current.id) await engine.current?.closeVst3Editors();
    } catch (error) { notify(error instanceof Error ? error.message : '插件参数同步失败'); return; }
    const previous = history.current.past.pop(); if (!previous) return;
    history.current.future.push(sessionRef.current); apply(previous); bumpHistory();
  }, [apply, bumpHistory, commitGesture, notify]);
  const redo = useCallback(async () => {
    commitGesture();
    try {
      await engine.current?.syncVst3Editors();
      if (history.current.future.length && history.current.future.at(-1)?.id !== sessionRef.current.id) await engine.current?.closeVst3Editors();
    } catch (error) { notify(error instanceof Error ? error.message : '插件参数同步失败'); return; }
    const next = history.current.future.pop(); if (!next) return;
    history.current.past.push(sessionRef.current); apply(next); bumpHistory();
  }, [apply, bumpHistory, commitGesture, notify]);
  const paintPosition = useCallback(() => {
    const seconds = engine.current?.getPosition() ?? 0;
    if (playhead.current) playhead.current.style.transform = `translateX(${seconds * scaleRef.current}px)`;
    if (editCursor.current) editCursor.current.style.transform = `translateX(${(engine.current?.getEditPosition() ?? 0) * scaleRef.current}px)`;
    if (timeDisplay.current) timeDisplay.current.textContent = rulerOptionsRef.current.unit === 'bars' ? formatDawBars(seconds, rulerOptionsRef.current) : fmtTime(seconds);
  }, []);
  const revealPosition = useCallback(() => {
    const element = scroller.current; if (!element) return;
    const x = (engine.current?.getPosition() ?? 0) * scaleRef.current, head = element.querySelector('.daw-track-heading')?.getBoundingClientRect().width ?? 188;
    const width = element.clientWidth - head;
    if (x < element.scrollLeft) element.scrollLeft = Math.max(0, x - 20);
    else if (x > element.scrollLeft + width - 15) element.scrollLeft = Math.max(0, x - width + 30);
  }, []);
  const seek = useCallback((seconds: number) => { engine.current?.seek(seconds); paintPosition(); revealPosition(); }, [paintPosition, revealPosition]);
  const pause = useCallback(() => { engine.current?.pause(); setPlaying(false); paintPosition(); }, [paintPosition]);
  const pauseTransport = useCallback(() => { engine.current?.pauseTransport(); setPlaying(false); paintPosition(); revealPosition(); }, [paintPosition, revealPosition]);
  const togglePlay = useCallback(async () => {
    if (engine.current?.isPlaying()) { pauseTransport(); return; }
    try { await engine.current?.play(); if (alive.current && activeRef.current) setPlaying(engine.current?.isPlaying() ?? false); else engine.current?.pause(); }
    catch (error) { notify(error instanceof Error ? error.message : '播放失败'); }
  }, [notify, pauseTransport]);

  const changeEffect = (target: string, id: string, next: DawEffect) => edit(current => next.type === 'vst3' ? updateEffect(current, target, id, { params: next.params, enabled: next.enabled }) : updateEffect(current, target, id, { params: next.params, enabled: next.enabled, bState: next.bState, abSlot: next.abSlot, presetId: next.presetId, name: next.name, noiseProfile: next.noiseProfile ?? null, bNoiseProfile: next.bNoiseProfile ?? null, sidechainTrackId: next.sidechainTrackId ?? null, bSidechainTrackId: next.bSidechainTrackId ?? null }));
  const getNoiseStart = (target: string) => {
    const { start, end } = getNoiseBounds(sessionRef.current, target);
    return Math.max(start, Math.floor(1000 * Math.min(Math.max(start, end - .5), engine.current?.getEditPosition() ?? 0)) / 1000);
  };
  const learnNoise = async (target: string, id: string, start: number, length: number) => {
    if (noiseRequest.current || !activeRef.current) return;
    if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length < .5 || length > 3) {
      setNoiseLearnState({ id, message: '请选择 0.5–3 秒的纯底噪。' }); return;
    }
    const bounds = getNoiseBounds(sessionRef.current, target);
    if (!resolveEffectTarget(sessionRef.current, target) || start < bounds.start || start + length > bounds.end + .5 / sessionRef.current.sampleRate) {
      setNoiseLearnState({ id, message: '噪声选区必须位于效果目标范围内。' }); return;
    }
    commitGesture();
    const snapshot = sessionRef.current, controller = new AbortController();
    noiseRequest.current = controller; setNoiseLearnState({ id, pending: true });
    try {
      const noiseProfile = await learnDawNoise(snapshot, target, id, start, length, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      if (sessionRef.current !== snapshot) {
        setNoiseLearnState({ id, message: '取样期间工程已改变，请重新学习。' }); return;
      }
      commitGesture();
      edit(current => updateEffect(current, target, id, { noiseProfile }));
      setNoiseLearnState({ id, message: '已学习噪声曲线。' });
    } catch (error) {
      if (!controller.signal.aborted && alive.current) setNoiseLearnState({ id, message: error instanceof Error ? error.message : '学习噪声失败。' });
    } finally { if (noiseRequest.current === controller) noiseRequest.current = null; }
  };
  const toggleNoise = (id: string) => { if (activeRef.current) void engine.current?.toggleNoiseListening(id); };
  const analyzeMatch = async (target: string, id: string, sourceTarget: string, reference: MatchReferenceId) => {
    if (!activeRef.current || (reference.kind === 'clip' && sourceTarget === clipEffectTarget(reference.id))) return;
    const snapshot = sessionRef.current;
    const input = makeMatchEqInput(snapshot, target, id);
    if (!input.owner.hasAudio || (sourceTarget !== target && !input.sources.some(source => source.target === sourceTarget))) return;
    if (reference.kind === 'clip' && !input.references.some(clip => clip.id === reference.id)) return;
    commitGesture();
    matchRequest.current?.abort();
    const controller = new AbortController();
    matchRequest.current = controller;
    const result = { id, sourceTarget, reference, revision: matchEqRevision(snapshot, sourceTarget, reference) };
    setMatchResult({ ...result, pending: true });
    try {
      const gains = await analyzeDawMatchEq(snapshot, sourceTarget, reference, controller.signal);
      if (!controller.signal.aborted && alive.current) setMatchResult({ ...result, gains });
    } catch (error) {
      if (!controller.signal.aborted && alive.current) setMatchResult({ ...result, message: error instanceof Error ? error.message : '音色分析失败。' });
    } finally { if (matchRequest.current === controller) matchRequest.current = null; }
  };
  const auditionMatch = () => { if (engine.current?.isPlaying()) pause(); };
  const dragMatchClip = (event: ReactDragEvent, clipId: string) => {
    const payload = JSON.stringify([session.id, clipId]);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(MATCH_CLIP_MIME, payload);
    event.dataTransfer.setData('text/plain', `${MATCH_CLIP_MIME}:${payload}`);
  };
  const effectWindows = useDawEffectWindows({ session, canUndo: !!history.current.past.length, canRedo: !!history.current.future.length, onChange: changeEffect,
    onBeginGesture: beginGesture, onCommitGesture: commitGesture, onUndo: undo, onRedo: redo,
    onReadings: id => engine.current?.getEffectReading(id), onTransport: () => void togglePlay(), onResetMeters: () => engine.current?.resetMeters(),
    comparison: effectComparison, onToggleComparison: id => { commitGesture(); void engine.current?.toggleComparison(id); }, onCloseComparison: id => engine.current?.clearComparison(id),
    noiseLearning: noiseLearnState, noiseListenId, getNoiseStart, onLearnNoise: learnNoise, onToggleNoise: toggleNoise, onCloseNoise: id => engine.current?.clearNoiseListening(id),
    matchResult, onAnalyzeMatch: analyzeMatch, onAuditionMatch: auditionMatch, transportPlaying: playing, monitorDb });
  const [vst3OpenError, setVst3OpenError] = useState('');
  const openVst3Editor = async (target: string, id: string) => {
    const sessionId = sessionRef.current.id;
    const result = await engine.current?.openVst3Editor(id);
    if (!alive.current || !activeRef.current || sessionRef.current.id !== sessionId || !getEffectChain(sessionRef.current, target).some(effect => effect.id === id)) return;
    if (result?.opened) { setDialog(null); return; }
    setVst3OpenError(result?.error || '此插件未提供可用的原生窗口。');
    setEffectTarget(target); setEditingEffect(id); setDialog('effect-editor');
  };
  const openEffectEditor = (target: string, id: string) => {
    commitGesture();
    if (getEffect(sessionRef.current, target, id).type === 'vst3') { void openVst3Editor(target, id); return; }
    if (!effectWindows.open(target, id)) { setEffectTarget(target); setEditingEffect(id); setDialog('effect-editor'); }
  };
  useEffect(() => {
    if (!active || dialog !== 'effect-editor' || !editingEffect) return;
    const update = () => setEditingReadings(engine.current?.getEffectReading(editingEffect));
    update();
    const timer = window.setInterval(update, 1000 / 24);
    return () => { window.clearInterval(timer); engine.current?.clearComparison(editingEffect); engine.current?.clearNoiseListening(editingEffect); };
  }, [active, dialog, editingEffect]);
  const renderEffectChain = (target: string, title: string) => <EffectChainView title={title} effects={getEffectChain(session, target)} compact
    onAdd={() => { setEffectTarget(target); setDialog('effects'); }} onEdit={id => openEffectEditor(target, id)}
    onToggle={id => edit(current => { const effect = getEffect(current, target, id); return updateEffect(current, target, id, { enabled: !effect.enabled }); })}
    onBypassAll={() => { commitGesture(); edit(current => bypassEffectChain(current, target)); }}
    onRemove={id => edit(current => removeEffect(current, target, id))} onCopy={id => edit(current => copyEffect(current, target, id))}
    onMove={(id, direction) => edit(current => moveEffect(current, target, id, getEffectChain(current, target).findIndex(effect => effect.id === id) + direction))} />;

  useEffect(() => {
    alive.current = true;
    const playback = new DawAudioEngine(notify, setEffectComparison, setNoiseListenId, (sessionId, event) => {
      if (sessionRef.current.id !== sessionId) return;
      const current = sessionRef.current;
      const target = current.masterEffects?.some(effect => effect.id === event.effectId && effect.type === 'vst3') ? 'master' : current.tracks.find(track => track.effects?.some(effect => effect.id === event.effectId && effect.type === 'vst3'))?.id;
      if (!target) return;
      const effect = getEffectChain(current, target).find(item => item.id === event.effectId);
      if (!effect) return;
      const changed = Object.fromEntries(Object.entries(event.params ?? {}).filter(([key, value]) => Number.isFinite(value) && value >= 0 && value <= 1 && effect.params[key] !== value));
      if (!Object.keys(changed).length) return;
      commitGesture();
      commitEdit(updateEffect(sessionRef.current, target, event.effectId, { params: { ...effect.params, ...changed } }));
    });
    engine.current = playback;
    playback.setPlaybackRestartMode(readDawPreferences().restartMode);
    playback.setSession(sessionRef.current);
    const controller = new AbortController();
    void (async () => {
      try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        if (raw) {
          const restored = await hydrateDawSession(parseSession(raw), controller.signal);
          if (!alive.current || controller.signal.aborted) return;
          apply(restored.session); setSelection(restored.session.tracks[0] ? { trackId: restored.session.tracks[0].id } : null);
          if (restored.missing.length) notify(`已恢复会话，${restored.missing.length} 个素材未找到。请保留原素材库，或删除失联片段后重新导入。`);
        } else engine.current?.setSession(sessionRef.current);
      } catch (error) { if (!controller.signal.aborted) notify(`自动恢复未完成：${error instanceof Error ? error.message : '无法读取本机会话'}`); }
      finally { if (alive.current && !controller.signal.aborted) setRestoring(false); }
    })();
    return () => { alive.current = false; controller.abort(); request.current?.abort(); noiseRequest.current?.abort(); matchRequest.current?.abort(); playback.dispose(); if (engine.current === playback) engine.current = null; if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [apply, notify, commitGesture, commitEdit]);
  useEffect(() => {
    engine.current?.setPlaybackRestartMode(preferences.restartMode);
    try { localStorage.setItem(DAW_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Settings also work when storage is unavailable. */ }
  }, [preferences]);
  useEffect(() => {
    if (restoring) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, serializeSession(session)); setSavedAt('已自动保存到本机'); }
      catch { setSavedAt('自动保存不可用 · 请保存文件'); }
    }, 700);
    return () => clearTimeout(timer);
  }, [session, restoring]);
  useEffect(() => {
    const flush = () => {
      if (restoringRef.current) return;
      try { localStorage.setItem(AUTOSAVE_KEY, serializeSession(sessionRef.current)); } catch { /* File saving stays available when storage is full. */ }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => { if (!active) { pause(); void engine.current?.closeVst3Editors().catch(error => notify(error instanceof Error ? error.message : '关闭插件窗口失败')); engine.current?.clearComparison(); engine.current?.clearNoiseListening(); noiseRequest.current?.abort(); matchRequest.current?.abort(); setNoiseLearnState(undefined); setMatchResult(undefined); cancelDrag.current?.(); commitGesture(); setDialog(null); } }, [active, pause, commitGesture, notify]);
  useEffect(() => () => { cancelDrag.current?.(); }, []);
  useEffect(() => {
    if (!active || !playing) { paintPosition(); resetDawMeters(meters.current); return; }
    let raf = 0, previousMeter = 0;
    const update = (time: number) => {
      paintPosition();
      if (time - previousMeter > 32) {
        previousMeter = time;
        paintDawMeters(meters.current, engine.current?.getMeterLevels() ?? {}, time);
      }
      if (playing && !engine.current?.isPlaying()) setPlaying(false);
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update); return () => cancelAnimationFrame(raf);
  }, [active, paintPosition, playing]);
  useEffect(() => { paintPosition(); }, [scale, paintPosition, session, preferences.rulerUnit]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    let frame = 0;
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const heading = element.querySelector<HTMLElement>('.daw-track-heading');
      setView({ left: element.scrollLeft, width: element.clientWidth, head: heading?.offsetWidth || 188 });
    }); };
    const observer = new ResizeObserver(measure); observer.observe(element);
    const heading = element.querySelector('.daw-track-heading'); if (heading) observer.observe(heading);
    element.addEventListener('scroll', measure, { passive: true }); measure();
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    if (!selection) return;
    const nextTrack = session.tracks.find(item => item.id === selection.trackId);
    if (!nextTrack) setSelection(null);
    else if (selection.clipId && !nextTrack.clips.some(item => item.id === selection.clipId)) setSelection({ trackId: nextTrack.id });
  }, [session, selection]);
  useEffect(() => {
    if (!dialog || !active) return;
    const modal = dialogRef.current; if (!modal) return;
    const previousFocus = document.activeElement;
    modal.focus();
    const modalKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); event.stopPropagation(); setDialog(null); return; }
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); modal.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', modalKey, true);
    return () => { window.removeEventListener('keydown', modalKey, true); if (activeRef.current && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, [dialog, active]);

  const zoom = useCallback((next: number, clientX?: number) => {
    const bounded = Math.min(250, Math.max(4, next));
    const element = scroller.current; if (!element) { setScale(bounded); return bounded; }
    const mouseX = clientX === undefined ? (element.clientWidth - view.head) / 2 : clientX - element.getBoundingClientRect().left - view.head;
    const anchor = (element.scrollLeft + Math.max(0, mouseX)) / scaleRef.current;
    setScale(bounded);
    requestAnimationFrame(() => { element.scrollLeft = Math.max(0, anchor * bounded - Math.max(0, mouseX)); });
    return bounded;
  }, [view.head]);
  const fitTimeline = useCallback(() => {
    const element = scroller.current; if (!element) return;
    const fitted = Math.min(250, Math.max(4, (element.clientWidth - view.head - 40) / Math.max(1, sessionDuration(sessionRef.current))));
    setScale(fitted);
    element.scrollLeft = 0;
    return fitted;
  }, [view.head]);

  const readAgentView: DawAgentWorkspace['view'] = () => {
    const selected = selectionRef.current;
    const owner = sessionRef.current.tracks.find(track => track.id === selected?.trackId);
    const selection = owner ? owner.clips.some(clip => clip.id === selected?.clipId) ? selected : { trackId: owner.id } : null;
    return { active: activeRef.current, selection, preferences, zoom: scaleRef.current, mixerOpen, panels: layout };
  };
  const readAgentTransport: DawAgentWorkspace['transport'] = () => ({
    time: engine.current?.getPosition() ?? 0, editTime: engine.current?.getEditPosition() ?? 0,
    playing: engine.current?.isPlaying() ?? false, monitorDb,
  });
  const selectForAgent = (next: Selection) => { selectionRef.current = next; setSelection(next); };
  agentWorkspace.current = {
    session: () => sessionRef.current,
    revision: () => revision.current,
    editing: () => operation.current || !!gesture.current || !!moving || resizing,
    history: () => ({ canUndo: !!history.current.past.length, canRedo: !!history.current.future.length }),
    commit: (next, replace) => {
      if (replace) { pause(); clipboard.current = null; }
      commitEdit(next);
      if (replace) { selectForAgent(next.tracks[0] ? { trackId: next.tracks[0].id } : null); seek(0); }
    },
    undo, redo,
    engine: () => engine.current!,
    view: readAgentView,
    setView: patch => {
      const next = readAgentView();
      if (patch.selection !== undefined) { selectForAgent(patch.selection); next.selection = patch.selection; }
      if (patch.preferences) {
        next.preferences = { ...next.preferences, ...patch.preferences };
        setPreferences(next.preferences);
        engine.current?.setPlaybackRestartMode(next.preferences.restartMode);
      }
      if (patch.mixerOpen !== undefined) { setMixerOpen(patch.mixerOpen); next.mixerOpen = patch.mixerOpen; }
      if (patch.panels) next.panels = updateLayout(patch.panels);
      if (patch.zoom !== undefined) next.zoom = zoom(patch.zoom);
      if (patch.fit) next.zoom = fitTimeline() ?? next.zoom;
      return next;
    },
    transport: readAgentTransport,
    setTransport: async (patch, signal) => {
      const playback = engine.current!;
      if (patch.monitorDb !== undefined) { playback.setMonitorGain(patch.monitorDb); setMonitorDb(patch.monitorDb); }
      if (patch.playing === false) pauseTransport();
      if (patch.time !== undefined) seek(patch.time);
      if (patch.playing === true && !playback.isPlaying()) {
        const abort = () => playback.pause();
        signal.addEventListener('abort', abort, { once: true });
        try {
          await playback.play();
          signal.throwIfAborted();
          if (!activeRef.current) { playback.pause(); throw dawAgentError('播放期间 DAW 已切换到后台。', 'DAW_NOT_READY'); }
          setPlaying(playback.isPlaying()); paintPosition(); revealPosition();
        } finally { signal.removeEventListener('abort', abort); }
      }
      return { ...readAgentTransport(), monitorDb: patch.monitorDb ?? monitorDb };
    },
  };
  useLayoutEffect(() => {
    if (!restoring && registerAgent) return registerAgent(agentBridge.execute, active);
  }, [active, agentBridge, registerAgent, restoring]);
  useEffect(() => {
    window.addEventListener('pagehide', agentBridge.dispose);
    return () => { window.removeEventListener('pagehide', agentBridge.dispose); agentBridge.dispose(); };
  }, [agentBridge]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const wheel = (event: WheelEvent) => { if (!activeRef.current || !event.altKey) return; event.preventDefault(); zoom(scaleRef.current * Math.exp(-event.deltaY * .002), event.clientX); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [zoom]);
  const pointerTime = useCallback((clientX: number) => {
    const element = scroller.current; if (!element) return 0;
    return Math.max(0, (clientX - element.getBoundingClientRect().left + element.scrollLeft - view.head) / scaleRef.current);
  }, [view.head]);
  const snapTime = useCallback((time: number, source: DawSession, excludedId?: string, bypass?: boolean) => {
    const targets = preferences.snapEdges ? [{ time: 0, label: '起点' }] : [];
    if (excludedId && preferences.snapCursor) targets.push({ time: engine.current?.getPosition() ?? 0, label: '游标' });
    for (const item of source.tracks) for (const piece of item.clips) if (preferences.snapEdges && piece.id !== excludedId) {
      targets.push({ time: piece.start, label: `${piece.name} · 开始` }, { time: piece.start + piece.duration, label: `${piece.name} · 结束` });
    }
    const result = snapDawTime(time, { scale: scaleRef.current, enabled: snap, bypass, gridStep: preferences.snapGrid ? getDawGrid(scaleRef.current, rulerOptionsRef.current).snapStep : NaN, targets });
    if (result.kind !== 'grid') return result;
    const division = rulerOptionsRef.current.gridDivision;
    return { ...result, label: division !== 'auto' ? `${DAW_GRID_DIVISIONS.find(item => item.value === division)?.label ?? '音符'}网格` : rulerOptionsRef.current.unit === 'bars' ? '小节网格' : '时间网格' };
  }, [snap, preferences.snapGrid, preferences.snapEdges, preferences.snapCursor]);
  const showSnap = useCallback((result: ReturnType<typeof snapDawTime>) => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    setSnapGuide(result.snapped ? { time: result.time, label: result.label ?? '网格' } : null);
  }, []);
  const releaseSnap = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => setSnapGuide(null), 550);
  }, []);
  useEffect(() => () => { if (snapTimer.current) clearTimeout(snapTimer.current); }, []);
  useEffect(() => { if (!active || !snap) setSnapGuide(null); }, [active, snap]);
  const scrubCursor = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || busy || restoring || resizing) return;
    event.preventDefault();
    scroller.current?.focus();
    cancelDrag.current?.();
    const original = engine.current?.getPosition() ?? 0;
    const originalEdit = engine.current?.getEditPosition() ?? original;
    setMoving('cursor');
    const locate = (clientX: number, bypass: boolean) => {
      const result = snapTime(Math.min(sessionDuration(sessionRef.current), pointerTime(clientX)), sessionRef.current, undefined, bypass);
      showSnap(result); seek(Math.min(3600, result.time));
    };
    locate(event.clientX, event.shiftKey);
    const move = (pointer: PointerEvent) => locate(pointer.clientX, pointer.shiftKey);
    const finish = (cancel = false) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelMove); window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancelMove);
      if (cancel) { engine.current?.seek(original, { editPosition: originalEdit }); paintPosition(); revealPosition(); setSnapGuide(null); } else releaseSnap();
      setMoving(null); cancelDrag.current = null;
    };
    const up = () => finish(), cancelMove = () => finish(true);
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); finish(true); } };
    cancelDrag.current = cancelMove;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true }); window.addEventListener('pointercancel', cancelMove, { once: true }); window.addEventListener('keydown', escape); window.addEventListener('blur', cancelMove, { once: true });
  };

  const dragClip = (event: ReactPointerEvent<HTMLElement>, owner: DawTrack, piece: DawClip, kind: ClipGesture) => {
    if (event.button !== 0 || busy || restoring) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.closest<HTMLElement>('[data-daw-clip]')?.focus();
    commitGesture(); beginGesture(); setSelection({ trackId: owner.id, clipId: piece.id }); setMoving(piece.id);
    const original = sessionRef.current;
    const anchor = pointerTime(event.clientX) - piece.start;
    const initialX = event.clientX, initialY = event.clientY;
    let moved = false;
    const handleMove = (move: PointerEvent) => {
      if (!moved && Math.abs(move.clientX - initialX) + Math.abs(move.clientY - initialY) < 3) return;
      moved = true;
      const time = pointerTime(move.clientX);
      let target = owner.id;
      if (kind === 'move') {
        const under = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>('[data-daw-track]')?.dataset.dawTrack;
        if (under && original.tracks.some(item => item.id === under)) target = under;
        setDropTrack(target);
      }
      try {
        let next: DawSession;
        if (kind === 'move') {
          const start = time - anchor;
          let result = snapTime(start, original, piece.id, move.shiftKey);
          const end = snapTime(start + piece.duration, original, piece.id, move.shiftKey);
          if (end.snapped && end.kind === 'edge' && (!result.snapped || result.kind !== 'edge' || Math.abs(end.time - start - piece.duration) < Math.abs(result.time - start))) {
            showSnap(end); result = { ...end, time: Math.max(0, end.time - piece.duration) };
          } else showSnap(result);
          next = moveClip(original, owner.id, piece.id, result.time, target);
        }
        else if (kind === 'start' || kind === 'end') {
          const result = snapTime(time, original, piece.id, move.shiftKey); showSnap(result);
          next = trimClip(original, owner.id, piece.id, kind, result.time);
        }
        else next = updateClip(original, owner.id, piece.id, { [kind]: Math.max(0, Math.min(piece.duration, kind === 'fadeIn' ? time - piece.start : piece.start + piece.duration - time)) });
        apply(next); setSelection({ trackId: target, clipId: piece.id });
      } catch { /* Reaching a source edge leaves the last valid trim in place. */ }
    };
    const finish = (cancel = false) => {
      window.removeEventListener('pointermove', handleMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelMove); window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancelMove);
      if (cancel) { gesture.current = null; apply(original); setSelection({ trackId: owner.id, clipId: piece.id }); }
      else commitGesture();
      setMoving(null); setDropTrack(null); setSnapGuide(null);
      cancelDrag.current = null;
    };
    const up = () => finish();
    const cancelMove = () => finish(true);
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); finish(true); } };
    cancelDrag.current = cancelMove;
    window.addEventListener('pointermove', handleMove); window.addEventListener('pointerup', up, { once: true }); window.addEventListener('pointercancel', cancelMove, { once: true }); window.addEventListener('keydown', escape); window.addEventListener('blur', cancelMove, { once: true });
  };
  const splitSelected = useCallback(() => {
    const selected = selectionRef.current; if (!selected) { notify('先选择一个片段，再将游标移到切片位置。'); return; }
    const owner = sessionRef.current.tracks.find(item => item.id === selected.trackId);
    const time = engine.current?.getPosition() ?? 0;
    const piece = owner?.clips.find(item => item.id === selected.clipId) ?? owner?.clips.find(item => time > item.start && time < item.start + item.duration);
    if (!piece) { notify('游标需要位于所选轨道的片段中。'); return; }
    if (time <= piece.start || time >= piece.start + piece.duration) { notify('将游标移到片段内部后切片。'); return; }
    edit(current => splitClip(current, owner!.id, piece.id, time));
  }, [edit, notify]);
  const removeSelected = useCallback(() => {
    const selected = selectionRef.current; if (!selected) return;
    edit(current => selected.clipId ? deleteClip(current, selected.trackId, selected.clipId) : deleteTrack(current, selected.trackId));
  }, [edit]);
  const duplicateSelected = useCallback(() => {
    const selected = selectionRef.current; if (!selected?.clipId) return;
    edit(current => duplicateClip(current, selected.trackId, selected.clipId!));
  }, [edit]);
  const copySelected = useCallback(() => {
    const selected = selectionRef.current;
    const piece = sessionRef.current.tracks.find(item => item.id === selected?.trackId)?.clips.find(item => item.id === selected?.clipId);
    if (!piece || !selected) return;
    clipboard.current = { clip: structuredClone(piece), trackId: selected.trackId }; notify('已复制片段；Ctrl+V 粘贴到游标位置。');
  }, [notify]);
  const paste = useCallback(() => {
    const copied = clipboard.current; if (!copied) return;
    const destination = selectionRef.current?.trackId ?? sessionRef.current.tracks[0]?.id;
    if (!destination) return;
    const asset = sessionRef.current.assets.find(item => item.id === copied.clip.assetId);
    if (!asset) { clipboard.current = null; notify('复制的片段来自其他会话，请重新复制。'); return; }
    const piece = { ...copied.clip, ...(copied.clip.effects === undefined ? {} : { effects: cloneEffectChain(copied.clip.effects, true) }), id: crypto.randomUUID(), start: Math.round((engine.current?.getPosition() ?? 0) * asset.sampleRate) / asset.sampleRate };
    edit(current => parseSession({ ...current, tracks: current.tracks.map(item => item.id === destination ? { ...item, clips: [...item.clips, piece] } : item) }));
    setSelection({ trackId: destination, clipId: piece.id });
  }, [edit, notify]);
  const saveSession = useCallback(async () => {
    commitGesture();
    try { await engine.current?.syncVst3Editors(); } catch (error) { notify(`保存失败：${error instanceof Error ? error.message : '插件参数同步失败'}`); return; }
    const blob = new Blob([serializeSession(sessionRef.current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${sessionRef.current.name.replace(/[\\/:*?"<>|]/g, '_')}.visiki-daw.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('已保存会话文件；音频素材仍保留在本机素材库。');
  }, [commitGesture, notify]);
  useEffect(() => {
    if (!active) { spaceHandled.current = false; return; }
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (dialog || busy || restoring || moving || resizing || isSpaceTextEntry(event.target)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[data-workspace-navigation]')) return;
      if (!root.current?.contains(target) && target !== document.body && target !== document.documentElement) return;
      // Capture Space before native selects/buttons or track handlers consume it.
      // Enter and arrows remain available for operating the focused control.
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || spaceHandled.current) return;
      spaceHandled.current = true;
      void togglePlay();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !spaceHandled.current) return;
      event.preventDefault(); event.stopPropagation(); spaceHandled.current = false;
    };
    const blur = () => { spaceHandled.current = false; };
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true); window.removeEventListener('blur', blur); };
  }, [active, dialog, busy, restoring, moving, resizing, togglePlay]);
  useEffect(() => {
    if (!active) return;
    let nudging = false;
    const finishNudge = () => { if (nudging) { nudging = false; commitGesture(); } };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || (event.target instanceof HTMLElement && event.target.closest('[data-workspace-navigation]'))) return;
      if (busy || restoring || moving || resizing) return;
      const historyAction = dawHistoryShortcut(event);
      if (historyAction && (!dialog || dialog === 'effect-editor')) {
        event.preventDefault();
        if (!event.repeat) (historyAction === 'undo' ? undo : redo)();
        return;
      }
      if (isTyping(event.target) || dialog) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="separator"]') && !event.ctrlKey && !event.metaKey) return;
      const command = event.ctrlKey || event.metaKey;
      if (event.target instanceof HTMLInputElement && event.target.type === 'range' && !command) return;
      if (event.repeat && !['ArrowLeft', 'ArrowRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(event.code)) return;
      if (command && event.code === 'KeyS') { event.preventDefault(); saveSession(); }
      else if (command && event.code === 'KeyB') { event.preventDefault(); splitSelected(); }
      else if (command && event.code === 'KeyD') { event.preventDefault(); duplicateSelected(); }
      else if (command && event.code === 'KeyC') { event.preventDefault(); copySelected(); }
      else if (command && event.code === 'KeyV') { event.preventDefault(); paste(); }
      else if (command && event.code === 'KeyI') { event.preventDefault(); importTarget.current = { start: 0 }; fileInput.current?.click(); }
      else if (command && event.code === 'KeyO') { event.preventDefault(); sessionInput.current?.click(); }
      else if (command && event.shiftKey && event.code === 'KeyM') { event.preventDefault(); setMixerOpen(value => !value); }
      else if (event.code === 'Delete' || event.code === 'Backspace') { event.preventDefault(); removeSelected(); }
      else if (event.code === 'Home') { event.preventDefault(); seek(0); }
      else if (event.code === 'End') { event.preventDefault(); seek(sessionDuration(sessionRef.current)); }
      else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault(); const direction = event.code === 'ArrowLeft' ? -1 : 1;
        const step = getDawGrid(scaleRef.current, rulerOptionsRef.current).snapStep * (event.shiftKey ? 10 : 1);
        const selected = selectionRef.current;
        if (event.altKey && !command) {
          const piece = sessionRef.current.tracks.find(item => item.id === selected?.trackId)?.clips.find(item => item.id === selected?.clipId);
          if (piece && selected) {
            if (!nudging) { commitGesture(); beginGesture(); nudging = true; }
            edit(current => moveClip(current, selected.trackId, piece.id, Math.min(3600 - piece.duration, Math.max(0, piece.start + direction * step))));
          }
        } else if (command) {
          const position = engine.current?.getPosition() ?? 0;
          const boundaries = [0, ...sessionRef.current.tracks.flatMap(owner => owner.clips.flatMap(piece => [piece.start, piece.start + piece.duration]))];
          const candidates = boundaries.filter(time => direction < 0 ? time < position - .00001 : time > position + .00001);
          seek(candidates.length ? (direction < 0 ? Math.max(...candidates) : Math.min(...candidates)) : direction < 0 ? 0 : sessionDuration(sessionRef.current));
        } else seek(Math.min(3600, Math.max(0, (engine.current?.getPosition() ?? 0) + direction * step)));
      }
      else if (!command && !event.altKey && event.code === 'KeyN') { event.preventDefault(); setSnap(value => !value); }
      else if (!command && !event.altKey && event.code === 'KeyF') { event.preventDefault(); fitTimeline(); }
      else if (!command && !event.altKey && (event.code === 'Equal' || event.code === 'NumpadAdd' || event.code === 'Minus' || event.code === 'NumpadSubtract')) { event.preventDefault(); zoom(scaleRef.current * (event.code === 'Minus' || event.code === 'NumpadSubtract' ? 1 / 1.3 : 1.3)); }
      else if (!command && !event.altKey && (event.code === 'KeyM' || event.code === 'KeyS')) {
        const selected = sessionRef.current.tracks.find(item => item.id === selectionRef.current?.trackId); if (!selected) return;
        event.preventDefault(); edit(current => updateTrack(current, selected.id, event.code === 'KeyM' ? { muted: !selected.muted } : { solo: !selected.solo }));
      }
      else if (event.key === '?') { event.preventDefault(); setDialog('help'); }
      else if (event.code === 'Escape') setSelection(null);
    };
    const keyup = (event: KeyboardEvent) => { if (event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.key === 'Alt') finishNudge(); };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', finishNudge);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', finishNudge); finishNudge(); };
  }, [active, busy, restoring, dialog, moving, resizing, saveSession, redo, undo, splitSelected, duplicateSelected, copySelected, paste, togglePlay, removeSelected, seek, fitTimeline, zoom, edit, commitGesture, beginGesture]);

  const importFiles = useCallback(async (files: File[], target = importTarget.current) => {
    if (!files.length || operation.current) return;
    operation.current = true; const controller = new AbortController(); request.current = controller; pause();
    let successful = 0, nextTime = target.start;
    beginGesture();
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index]; setBusy(`正在导入 ${index + 1}/${files.length} · ${file.name}`);
        try {
          const asset = await importDawAudio(file, controller.signal); if (!alive.current) return;
          let current = addAssetToSession(sessionRef.current, asset);
          let owner = target.trackId ? current.tracks.find(item => item.id === target.trackId) : undefined;
          if (!owner) { owner = createTrack(asset.name.replace(/\.[^.]+$/, ''), DAW_TRACK_COLORS[current.tracks.length % DAW_TRACK_COLORS.length]); current = addTrack(current, owner); }
          current = addClip(current, owner.id, asset.id, target.trackId ? nextTime : 0);
          const added = current.tracks.find(item => item.id === owner!.id)!.clips.at(-1)!;
          apply(current); setSelection({ trackId: owner.id, clipId: added.id }); successful++;
          if (target.trackId) nextTime += asset.duration;
        } catch (error) { if (controller.signal.aborted) break; notify(`“${file.name}”导入失败：${error instanceof Error ? error.message : '未知错误'}`); }
      }
      if (successful) notify(`已导入 ${successful} 个音频；拖动片段移动，两侧边缘裁切。`);
    } finally { commitGesture(); operation.current = false; if (alive.current) setBusy(null); request.current = null; }
  }, [apply, beginGesture, commitGesture, notify, pause]);
  const chooseFiles = (trackId?: string) => { importTarget.current = { trackId, start: trackId ? engine.current?.getPosition() ?? 0 : 0 }; fileInput.current?.click(); };
  const openSession = async (file: File) => {
    if (operation.current) return;
    operation.current = true; pause(); setBusy('正在读取会话'); const controller = new AbortController(); request.current = controller;
    try {
      if (file.size > 24 * 1024 * 1024) throw new Error('会话文件超过 24 MB');
      const next = parseSession(await file.text());
      const hydrated = await hydrateDawSession(next, controller.signal); if (!alive.current) return;
      await engine.current?.closeVst3Editors();
      clipboard.current = null;
      edit(() => hydrated.session); setSelection(hydrated.session.tracks[0] ? { trackId: hydrated.session.tracks[0].id } : null); seek(0);
      if (hydrated.missing.length) notify(`会话已打开；${hydrated.missing.length} 个素材未找到。会话引用本机素材库；请恢复原素材库，或删除失联片段后重新导入。`);
      else notify('会话已打开。');
    } catch (error) { if (!controller.signal.aborted) notify(`打开失败：${error instanceof Error ? error.message : '会话无效'}`); }
    finally { operation.current = false; request.current = null; if (alive.current) setBusy(null); }
  };
  const renderMix = async () => {
    if (operation.current) return;
    operation.current = true; commitGesture(); setBusy('正在导出 WAV 混音'); setExportResult(null);
    const controller = new AbortController(); request.current = controller;
    try { await engine.current?.syncVst3Editors(); const result = await exportDawMix(sessionRef.current, controller.signal); if (alive.current) { setExportResult(result); notify('WAV 混音已生成。'); } }
    catch (error) { if (!controller.signal.aborted) notify(`导出失败：${error instanceof Error ? error.message : '未知错误'}`); }
    finally { operation.current = false; request.current = null; if (alive.current) setBusy(null); }
  };
  const importMixToEditor = async (result: DawMixResult) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = true;
    request.current = controller;
    setBusy('正在导入剪辑');
    try {
      const asset = await importDawRenderToEditor(result.id, controller.signal);
      if (alive.current && !controller.signal.aborted) {
        setDialog(null);
        onImportToEditor(asset);
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) notify(`导入剪辑失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      operation.current = false;
      request.current = null;
      if (alive.current) setBusy(null);
    }
  };
  const renderRange = (label: string, value: number, min: number, max: number, onChange: (value: number) => void, display?: string, step?: number) => <RangeField label={label} value={value} min={min} max={max} onChange={onChange} display={display} step={step} begin={beginGesture} commit={commitGesture} />;
  const trackEdit = (owner: DawTrack, patch: Partial<Pick<DawTrack, 'volumeDb' | 'pan' | 'muted' | 'solo' | 'name'>>) => edit(current => updateTrack(current, owner.id, patch));
  const addAssetClip = (asset: DawAsset, newTrack: boolean) => {
    edit(current => {
      let owner = newTrack ? undefined : current.tracks.find(item => item.id === selectionRef.current?.trackId);
      if (!owner) { owner = createTrack(asset.name.replace(/\.[^.]+$/, ''), DAW_TRACK_COLORS[current.tracks.length % DAW_TRACK_COLORS.length]); current = addTrack(current, owner); }
      const next = addClip(current, owner.id, asset.id, newTrack ? 0 : engine.current?.getPosition() ?? 0);
      setSelection({ trackId: owner.id, clipId: next.tracks.find(item => item.id === owner!.id)!.clips.at(-1)!.id }); return next;
    }); setDialog(null);
  };

  return <div ref={root} className={`daw-editor${resizing ? ' resizing' : ''}`} data-daw-editor aria-label="DAW 音轨编辑工作区" style={{ position: 'relative', '--daw-head-width': `${layout.head}px`, '--daw-inspector-width': `${layout.inspector}px`, '--daw-mixer-height': `${layout.mixer}px` } as CSSProperties}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }}
    onDrop={event => {
      event.preventDefault(); setDragOver(false); if (busy || restoring) return;
      const targetId = (event.target as HTMLElement).closest<HTMLElement>('[data-daw-track]')?.dataset.dawTrack;
      void importFiles([...event.dataTransfer.files], { trackId: targetId, start: targetId ? pointerTime(event.clientX) : 0 });
    }}>
    <input ref={fileInput} className="daw-hidden" type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.aiff,.aif,.wma" multiple aria-label="选择要导入的音频" onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ''; void importFiles(files); }} />
    <input ref={sessionInput} className="daw-hidden" type="file" accept=".json,.visiki-daw" aria-label="打开 DAW 会话文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void openSession(file); }} />
    <header className="daw-projectbar">
      <div className="daw-project-copy"><div className="daw-eyebrow-small">AUDIO WORKSPACE</div>
        <EditableName className="daw-project-name" label="混音工程名称" fallback="未命名混音" value={session.name} onCommit={value => edit(current => ({ ...current, name: value }))} />
        <div className="daw-project-meta">
          <div className="daw-project-stats">
            <span>{session.tracks.length} 条音轨</span><i aria-hidden="true" /><span>{fmtTime(duration).slice(0, 5)}</span>
            <i aria-hidden="true" /><span>{session.sampleRate / 1000} kHz / 立体声</span>
          </div>
          <div className="daw-project-rhythm">
            <BpmField value={musicalGrid.bpm} onCommit={bpm => edit(current => updateMusicalGrid(current, { bpm }))} />
            <label className="daw-musical-field"><span>拍号</span>
              <select aria-label="小节拍号" value={signature} onChange={event => {
                const [beatsPerBar, beatUnit] = event.target.value.split('/').map(Number);
                edit(current => updateMusicalGrid(current, { beatsPerBar, beatUnit }));
              }}>{signatures.map(value => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <button type="button" className="daw-btn ghost" title="自动估计音频 BPM 与拍号"
              onClick={() => { pause(); commitGesture(); setDialog('rhythm'); }}
              disabled={!session.assets.length || !!busy || restoring}><AudioLines size={14} />分析节奏</button>
            <span className="daw-save-state" role="status"><i aria-hidden="true" />{restoring ? '正在恢复' : savedAt}</span>
          </div>
        </div>
      </div>
      <div className="daw-project-actions">
        <button className="daw-btn ghost" title="分析主唱和伴奏，可选和声" onClick={() => {
          pause(); commitGesture(); autoMixSnapshot.current = sessionRef.current; setDialog('auto-mix');
        }} disabled={session.tracks.filter(item => !item.muted && item.clips.length).length < 2 || !!busy || restoring}><Sparkles size={14} />自动混音</button>
        <button className="daw-btn ghost" title="新建独立的 DAW 会话" onClick={() => setDialog('new')} disabled={!!busy || restoring}><FilePlus2 size={14} />新建</button>
        <button className="daw-btn ghost" title="打开 DAW 会话" onClick={() => sessionInput.current?.click()} disabled={!!busy || restoring}><FolderOpen size={14} />打开</button>
        <button className="daw-btn ghost" title="保存 DAW 会话 · Ctrl+S" onClick={saveSession} disabled={!!busy || restoring}><Save size={14} />保存</button>
        <button className="daw-btn primary" onClick={() => { setExportResult(null); setDialog('export'); }} disabled={!duration || !!busy || restoring}><ArrowDownToLine size={14} />导出音频</button>
      </div>
    </header>
    <main className="daw-body" inert={!!busy || restoring}><section className="daw-arrangement" aria-label="多轨时间线">
      <div className="daw-toolbar">
        <button className="daw-btn small" onClick={() => chooseFiles()} disabled={!!busy || restoring}><Plus size={13} />添加音频</button>
        <span className="daw-divider" /><IconButton label="选择并拖动片段" active onClick={() => notify('拖动片段移动；拖动两端裁切；Shift 暂时关闭吸附。')}><MousePointer2 size={16} /></IconButton>
        <IconButton label="在游标处切片 · Ctrl+B" onClick={splitSelected} disabled={!track || !!busy}><Scissors size={16} /></IconButton>
        <IconButton label="撤销 · Ctrl+Z" onClick={undo} disabled={!history.current.past.length || !!busy}><Undo2 size={16} /></IconButton>
        <IconButton label="重做 · Ctrl+Shift+Z" onClick={redo} disabled={!history.current.future.length || !!busy}><Redo2 size={16} /></IconButton>
        <span className="daw-selection-name">{clip?.name || track?.name || '选择音轨或片段'}</span>
        <div className="daw-toolbar-right"><button className={`daw-snap${snap ? ' active' : ''}`} aria-label="时间线吸附 · N" aria-pressed={snap} title={`吸附${snap ? '已开启' : '已关闭'} · N 切换 · Shift 临时关闭 · 更多设置见时间线选项`} onClick={() => setSnap(!snap)}><Magnet size={12} /><span>吸附</span></button>
          <select className="daw-grid-division" aria-label="网格细分" title={`${gridDivisionLabel} · 网格步长 ${Number(grid.snapStep.toFixed(6))} 秒 · 音符时值根据工程 BPM 计算`} value={preferences.gridDivision} onChange={event => setPreferences(previous => ({ ...previous, gridDivision: event.target.value as DawGridDivision }))}>{DAW_GRID_DIVISIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
          <IconButton label="时间线选项" onClick={() => setDialog('timeline')}><Settings2 size={14} /></IconButton>
          <div className="daw-zoom"><IconButton label="缩小时间线" onClick={() => zoom(scale / 1.3)}><ZoomOut size={13} /></IconButton><input aria-label="时间线缩放" type="range" min={4} max={250} value={scale} onChange={event => zoom(Number(event.target.value))} /><IconButton label="放大时间线" onClick={() => zoom(scale * 1.3)}><ZoomIn size={13} /></IconButton></div>
          <IconButton label="适合工程 · F" onClick={fitTimeline}><Maximize2 size={13} /></IconButton>
          <IconButton label="素材库" onClick={() => setDialog('assets')}><Music2 size={15} /></IconButton>
          <IconButton label="效果库 · 内置音频效果" onClick={() => { setEffectTarget(clip ? clipEffectTarget(clip.id) : track?.id ?? 'master'); setDialog('effects'); }}><Plug size={15} /></IconButton>
        </div>
      </div>
      <div ref={scroller} className="daw-scroll" data-daw-scroll tabIndex={-1}>
        <div className="daw-grid" data-daw-grid-division={preferences.gridDivision} data-daw-grid-step={grid.minorStep} data-daw-snap-step={grid.snapStep} style={{ width: timelineWidth + view.head }}>
          <div className="daw-time-grid" style={{ left: view.head }} aria-hidden="true">{gridLines.map(line => <span key={line.time} data-daw-grid-line={line.time} className={line.major ? 'major' : 'minor'} style={{ left: line.x }} />)}</div>
          <div className="daw-ruler"><div className="daw-track-heading"><span>音轨</span><select className="daw-ruler-unit" aria-label="时间标尺显示" value={preferences.rulerUnit} onChange={event => setPreferences(previous => ({ ...previous, rulerUnit: event.target.value as 'time' | 'bars' }))}><option value="time">时间</option><option value="bars">小节</option></select><div {...handleProps('head')} className="daw-resize daw-resize-head" /></div>
            <div className="daw-ruler-lane" style={{ width: timelineWidth }} onPointerDown={scrubCursor}>
              {gridLines.map(line => <span key={line.time} className={`daw-ruler-mark ${line.major ? 'major' : 'minor'}`} style={{ left: line.x }}>{line.major && <span className="daw-tick">{preferences.rulerUnit === 'bars' ? formatDawBars(line.time, musicalGrid) : fmtTime(line.time).slice(0, grid.majorStep < 1 ? 9 : 5)}</span>}</span>)}
            </div>
          </div>
          {session.tracks.map((owner, index) => <div key={owner.id} className={`daw-track-row${selection?.trackId === owner.id ? ' selected' : ''}${dropTrack === owner.id ? ' drop-target' : ''}`} data-daw-track={owner.id} style={{ '--track-color': owner.color } as CSSProperties}>
            <div className="daw-track-head" tabIndex={0} aria-label={`选择音轨 ${owner.name}`} onClick={event => { event.currentTarget.focus(); setSelection({ trackId: owner.id }); }} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelection({ trackId: owner.id }); } }}>
              <div className="daw-track-title"><span className="daw-track-color" /><strong title={owner.name}>{owner.name}</strong><small>{String(index + 1).padStart(2, '0')}</small></div>
              <div className="daw-track-buttons"><button className={`daw-ms${owner.muted ? ' muted' : ''}`} aria-label={`${owner.name} 静音`} aria-pressed={owner.muted} title="静音 · 参与导出" onClick={event => { event.stopPropagation(); trackEdit(owner, { muted: !owner.muted }); }}>M</button><button className={`daw-ms${owner.solo ? ' solo' : ''}`} aria-label={`${owner.name} 独奏`} aria-pressed={owner.solo} title="独奏 · 仅试听，默认导出全部未静音轨道" onClick={event => { event.stopPropagation(); trackEdit(owner, { solo: !owner.solo }); }}>S</button><span className="daw-track-db">{fmtDb(owner.volumeDb)}</span></div>
              <input className="daw-track-volume" type="range" aria-label={`${owner.name} 轨道音量`} min={-60} max={12} step={.1} value={owner.volumeDb} onPointerDown={event => { event.stopPropagation(); beginGesture(); }} onPointerUp={commitGesture} onPointerCancel={commitGesture} onBlur={commitGesture} onKeyDown={beginGesture} onKeyUp={commitGesture} onChange={event => trackEdit(owner, { volumeDb: Number(event.target.value) })} onClick={event => event.stopPropagation()} />
              <DawMeter id={owner.id} label={`${owner.name} 轨道电平`} registry={meters.current} orientation="horizontal" compact />
              <div {...handleProps('head')} className="daw-resize daw-resize-head" />
            </div>
            <div className="daw-lane" tabIndex={-1} style={{ width: timelineWidth }} onPointerDown={event => { if (event.button !== 0) return; setSelection({ trackId: owner.id }); scrubCursor(event); }}>
              {owner.clips.map(piece => {
                const asset = session.assets.find(item => item.id === piece.assetId); if (!asset) return null;
                const width = piece.duration * scale;
                const envelope = Array.from({ length: 33 }, (_, position) => `${position / 32 * 100},${(1 - clipEnvelopeAt(piece, position / 32 * piece.duration)) * 62}`);
                return <div key={piece.id} data-daw-clip={piece.id} role="button" tabIndex={0} aria-label={`${piece.name}，${fmtTime(piece.start)}，时长 ${piece.duration.toFixed(2)} 秒`} className={`daw-clip${selection?.clipId === piece.id ? ' selected' : ''}${moving === piece.id ? ' is-moving' : ''}`} style={{ left: piece.start * scale, width }} onPointerDown={event => dragClip(event, owner, piece, 'move')} onFocus={() => setSelection({ trackId: owner.id, clipId: piece.id })}>
                  <div className="daw-clip-label">
                    {width >= 42 ? <span className="daw-match-drag" draggable title="拖到音色匹配 EQ，设为参考片段" aria-label="拖动参考片段"
                      onPointerDown={event => event.stopPropagation()} onDragStart={event => dragMatchClip(event, piece.id)}><Music2 size={11} /></span> : <AudioLines size={10} />}
                    <span>{piece.name}</span>{piece.gainDb !== 0 && <small>{fmtDb(piece.gainDb)}</small>}{!!piece.effects?.length && <small title="此片段有独立效果">FX</small>}
                  </div>
                  <DawWaveform asset={asset} clip={piece} scale={scale} viewStart={view.left} viewWidth={view.width - view.head} color={owner.color} />
                  {(piece.fadeIn > 0 || piece.fadeOut > 0 || piece.envelope?.length) ? <svg className="daw-fades" width="100%" height="62" viewBox="0 0 100 62" preserveAspectRatio="none" aria-hidden="true"><path d={`M0,0 L${envelope.join(' L')} L100,0 Z`} /></svg> : null}
                  <span className="daw-trim left" title="拖动裁切片段开始" onPointerDown={event => dragClip(event, owner, piece, 'start')} /><span className="daw-trim right" title="拖动裁切片段结尾" onPointerDown={event => dragClip(event, owner, piece, 'end')} />
                  {selection?.clipId === piece.id && width > 35 && <><span className="daw-fade-handle" title="拖动设置淡入时长" style={{ left: Math.min(width - 12, Math.max(3, piece.fadeIn * scale - 4)) }} onPointerDown={event => dragClip(event, owner, piece, 'fadeIn')} /><span className="daw-fade-handle" title="拖动设置淡出时长" style={{ right: Math.min(width - 12, Math.max(3, piece.fadeOut * scale - 4)) }} onPointerDown={event => dragClip(event, owner, piece, 'fadeOut')} /></>}
                </div>;
              })}
            </div>
          </div>)}
          {!!session.tracks.length && <div className="daw-add-row"><div className="daw-add-head"><button disabled={!!busy} onClick={() => { const added = createTrack(`音轨 ${session.tracks.length + 1}`, DAW_TRACK_COLORS[session.tracks.length % DAW_TRACK_COLORS.length]); edit(current => addTrack(current, added)); setSelection({ trackId: added.id }); }}><Plus size={12} />添加空音轨</button></div></div>}
          {!session.tracks.length && <div className="daw-empty" style={{ left: view.left + view.head, width: Math.max(0, view.width - view.head), right: 'auto' }}><div className="daw-empty-card"><AudioLines className="daw-empty-art" size={43} strokeWidth={1.2} /><h2>从一段声音开始</h2><p>拖入人声、伴奏或音频文件，<br />在时间线上整理片段，调整音量与空间。</p><button className="daw-btn primary" disabled={!!busy || restoring} onClick={() => chooseFiles()}><Upload size={14} />导入音频</button><small>支持 WAV、MP3、FLAC、M4A 等 · 可多选</small></div></div>}
          <div ref={editCursor} className="daw-edit-cursor" style={{ display: preferences.restartMode === 'from-cursor' && playing ? 'block' : 'none' }} aria-hidden="true" /><div ref={playhead} className="daw-playhead" aria-hidden="true" />
          {snapGuide && <div className="daw-snap-guide" data-daw-snap-time={snapGuide.time} style={{ left: view.head + snapGuide.time * scale }} aria-hidden="true"><span>{preferences.rulerUnit === 'bars' ? `${formatDawBars(snapGuide.time, musicalGrid)} (${fmtTime(snapGuide.time)})` : fmtTime(snapGuide.time)} · {snapGuide.label}</span></div>}
        </div>
      </div>

      {mixerOpen && <section className="daw-mixer" aria-label="混音器"><div {...handleProps('mixer')} className="daw-resize daw-resize-mixer" /><div className="daw-mixer-heading"><div>混音器<span>推子影响混音 · Solo 仅试听</span></div><IconButton label="收起混音器" onClick={() => setMixerOpen(false)}><ChevronDown size={14} /></IconButton></div><div className="daw-mixer-channels">
        {session.tracks.map(owner => <div className="daw-channel" key={owner.id} style={{ '--track-color': owner.color } as CSSProperties}><div className="daw-channel-name"><button onClick={() => setSelection({ trackId: owner.id })} title={owner.name}>{owner.name}</button><output>{owner.volumeDb.toFixed(1)}</output></div><div className="daw-channel-volume"><input aria-label={`${owner.name} 混音推子`} type="range" min={-60} max={12} step={.1} value={owner.volumeDb} onPointerDown={beginGesture} onPointerUp={commitGesture} onPointerCancel={commitGesture} onBlur={commitGesture} onKeyDown={beginGesture} onKeyUp={commitGesture} onChange={event => trackEdit(owner, { volumeDb: Number(event.target.value) })} /><DawMeter id={owner.id} label={`${owner.name} 混音器电平`} registry={meters.current} /></div><div className="daw-track-buttons"><button className={`daw-ms${owner.muted ? ' muted' : ''}`} onClick={() => trackEdit(owner, { muted: !owner.muted })} aria-label={`${owner.name} 混音器静音`} aria-pressed={owner.muted}>M</button><button className={`daw-ms${owner.solo ? ' solo' : ''}`} onClick={() => trackEdit(owner, { solo: !owner.solo })} aria-label={`${owner.name} 混音器独奏`} aria-pressed={owner.solo}>S</button></div></div>)}
        <div className="daw-channel master"><div className="daw-channel-name"><span>主输出</span><output>{session.masterDb.toFixed(1)}</output></div><div className="daw-channel-volume"><input aria-label="主输出音量" type="range" min={-60} max={12} step={.1} value={session.masterDb} onPointerDown={beginGesture} onPointerUp={commitGesture} onPointerCancel={commitGesture} onBlur={commitGesture} onKeyDown={beginGesture} onKeyUp={commitGesture} onChange={event => edit(current => updateMaster(current, Number(event.target.value)))} /><DawMeter id={DAW_MASTER_METER} label="主输出电平" registry={meters.current} /></div><p className="daw-master-label">此音量写入导出音频</p></div>
      </div></section>}
      <div className="daw-transport"><div className="daw-transport-controls"><IconButton label="回到起点 · Home" onClick={() => seek(0)}><ArrowLeftToLine size={17} /></IconButton><button className="daw-play" aria-label={playing ? '暂停 · Space' : '播放 · Space'} title="播放 / 暂停 · Space" disabled={!duration || restoring} onClick={() => void togglePlay()}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><IconButton label="停止播放 · 遵循自动返回设置" onClick={pauseTransport}><Square size={15} /></IconButton></div><span ref={timeDisplay} className="daw-time">00:00.000</span><span className="daw-total">{preferences.rulerUnit === 'bars' ? '小节.拍' : `/ ${fmtTime(duration)}`}</span><label className="daw-restart" title="Auto Return · 停止时返回播放起点"><span>自动返回</span><select aria-label="自动返回" value={preferences.restartMode} onChange={event => setPreferences(previous => ({ ...previous, restartMode: event.target.value as 'resume' | 'from-cursor' }))}><option value="resume">关闭 · 保持位置</option><option value="from-cursor">开启 · 返回起点</option></select></label><label className="daw-listening" title="仅影响试听，不写入导出文件"><Volume2 size={14} /><span>试听音量</span><input type="range" aria-label="试听音量" min={-60} max={0} step={1} value={monitorDb} onChange={event => { const value = Number(event.target.value); setMonitorDb(value); engine.current?.setMonitorGain(value); }} /></label><button className={`daw-btn ghost daw-mixer-toggle${mixerOpen ? ' active' : ''}`} onClick={() => setMixerOpen(!mixerOpen)} aria-expanded={mixerOpen}><SlidersHorizontal size={14} />混音器{mixerOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</button></div>
    </section>
    <div {...handleProps('inspector')} className="daw-resize daw-resize-inspector" />
    <aside className="daw-inspector" aria-label="所选轨道与片段属性"><div className="daw-inspector-heading"><Settings2 size={14} /><span>{clip ? '片段与轨道' : '轨道属性'}</span>{track && <IconButton label={clip ? '删除所选片段 · Delete' : '删除所选轨道 · Delete'} onClick={removeSelected} disabled={!!busy}><Trash2 size={13} /></IconButton>}</div>
      {track ? <>
        <section className="daw-inspector-section"><div className="daw-selected-track" style={{ '--track-color': track.color } as CSSProperties}><span className="daw-track-avatar"><AudioLines size={18} /></span><div style={{ minWidth: 0 }}><EditableName key={track.id} value={track.name} label="轨道名称" fallback="音轨" onCommit={value => trackEdit(track, { name: value })} /><small>{track.clips.length} 个片段 · {track.muted ? '已静音' : track.solo ? '独奏试听' : '正常混音'}</small></div></div>
          {renderRange('轨道音量', track.volumeDb, -60, 12, value => trackEdit(track, { volumeDb: value }), fmtDb(track.volumeDb))}
          {renderRange('左右位置', track.pan, -1, 1, value => trackEdit(track, { pan: value }), fmtPan(track.pan), .01)}
          <div className="daw-effect-choices"><button className="daw-btn small ghost" onClick={() => chooseFiles(track.id)} disabled={!!busy}><Plus size={11} />添加片段</button><button className="daw-btn small ghost" onClick={() => setDialog('assets')}><Music2 size={11} />素材库</button></div>
        </section>
        {clip && <section className="daw-inspector-section"><h3><span>所选片段</span><span style={{ display: 'flex' }}><IconButton label="复制片段到结尾 · Ctrl+D" onClick={duplicateSelected} disabled={!!busy}><Copy size={12} /></IconButton><IconButton label="切片 · Ctrl+B" onClick={splitSelected} disabled={!!busy}><Scissors size={12} /></IconButton></span></h3>
          <EditableName key={clip.id} label="片段名称" fallback="音频片段" value={clip.name} style={{ width: '100%', padding: '6px 8px', marginBottom: 14, fontSize: 10 }} onCommit={value => edit(current => updateClip(current, track.id, clip.id, { name: value }))} />
          <span className="daw-match-drag daw-match-inspector-drag" draggable title="拖到音色匹配 EQ 的参考区" onDragStart={event => dragMatchClip(event, clip.id)}><Music2 size={12} />拖作 EQ 参考</span>
          <div className="daw-number-row"><NumberField label="开始位置 / 秒" value={clip.start} max={3600 - clip.duration} onCommit={value => edit(current => moveClip(current, track.id, clip.id, value))} /><NumberField label="结束位置 / 秒" value={clip.start + clip.duration} min={clip.start + 1 / session.sampleRate} max={Math.min(3600, clip.start + (clipAsset?.duration ?? clip.duration) - clip.sourceIn)} onCommit={value => edit(current => trimClip(current, track.id, clip.id, 'end', value))} /></div>
          {renderRange('片段增益', clip.gainDb, -60, 24, value => edit(current => updateClip(current, track.id, clip.id, { gainDb: value })), fmtDb(clip.gainDb))}
          {renderRange('淡入', clip.fadeIn, 0, clip.duration, value => edit(current => updateClip(current, track.id, clip.id, { fadeIn: value })), `${clip.fadeIn.toFixed(2)} s`, .01)}
          {renderRange('淡出', clip.fadeOut, 0, clip.duration, value => edit(current => updateClip(current, track.id, clip.id, { fadeOut: value })), `${clip.fadeOut.toFixed(2)} s`, .01)}
          <p className="daw-note">源入点 {clip.sourceIn.toFixed(3)} s · 时长 {clip.duration.toFixed(3)} s<br />{clip.envelope?.length ? '裁切保留现有音量曲线；调整淡入 / 淡出将重新设置。' : '裁切保留原素材，可再次向外拖动恢复。'}</p>
        </section>}
        {clip && <section className="daw-inspector-section">{renderEffectChain(clipEffectTarget(clip.id), '片段效果链')}</section>}
        <section className="daw-inspector-section">{renderEffectChain(track.id, '轨道效果链')}</section>
      </> : <><div className="daw-empty-inspector"><MousePointer2 size={22} strokeWidth={1.3} /><p style={{ marginTop: 12 }}>选择音轨调整音量与左右位置，<br />选择片段进行裁切和淡化。</p></div></>}
    <section className="daw-inspector-section">{renderEffectChain('master', '主输出效果链')}</section></aside></main>
    <footer className="daw-footer"><span><strong>内置音频效果</strong> · 原生 DSP / 同链导出</span><span><span className="daw-key">Space</span>播放</span><span><span className="daw-key">Ctrl+B</span>切片</span><span className="right">Alt + 滚轮 缩放时间线<IconButton label="操作帮助" onClick={() => setDialog('help')}><HelpCircle size={12} /></IconButton></span></footer>
    {busy && <div className="daw-toast" role="status"><span className="daw-import-progress"><LoaderCircle size={14} className="spin" />{busy}<button className="daw-btn small ghost" onClick={() => request.current?.abort()}>取消</button></span></div>}
    {toast && !busy && <div className="daw-toast" role="status">{toast}</div>}
    {dragOver && <div className="daw-drag-screen"><div><Upload size={38} /><p style={{ marginTop: 15 }}>放开以导入音频</p><small>放在现有音轨上添加片段；放在空白处新建音轨</small></div></div>}
    {dialog && active && <div className="daw-modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null); }}><section ref={dialogRef} tabIndex={-1} className={`daw-modal${dialog === 'rhythm' ? ' daw-rhythm-modal' : dialog === 'auto-mix' ? ' daw-auto-mix-modal' : dialog === 'effects' ? ' daw-effects-modal daw-effects-picker' : dialog === 'effect-editor' ? ' daw-effects-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="daw-dialog-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(null); }}><div className="daw-modal-heading"><h2 id="daw-dialog-title">{dialog === 'help' ? '音轨编辑' : dialog === 'effects' ? '效果库' : dialog === 'assets' ? '音频素材库' : dialog === 'export' ? '导出音频' : dialog === 'timeline' ? '时间线选项' : dialog === 'rhythm' ? '节奏分析' : dialog === 'auto-mix' ? '自动混音' : dialog === 'effect-editor' ? '效果编辑器' : '新建混音会话'}</h2><IconButton label="关闭对话框" disabled={!!busy} onClick={() => setDialog(null)}><X size={17} /></IconButton></div>
      {dialog === 'auto-mix' && <DawAutoMixDialog session={autoMixSnapshot.current} monitorDb={monitorDb}
        onPauseTransport={pause} onClose={() => setDialog(null)} onApply={next => {
          if (sessionRef.current !== autoMixSnapshot.current) {
            notify('工程已更改，请重新打开自动混音进行分析。'); setDialog(null); return;
          }
          edit(() => next); setDialog(null); notify('已应用自动混音，可一次撤销。');
        }} />}
      {dialog === 'rhythm' && <DawRhythmDialog assets={session.assets} selectedClip={clip} currentGrid={musicalGrid} onClose={() => setDialog(null)} onApply={patch => {
        edit(current => updateMusicalGrid(current, patch)); setPreferences(previous => ({ ...previous, rulerUnit: 'bars' })); setDialog(null);
        notify(`已更新工程速度 ${patch.bpm} BPM${patch.beatsPerBar ? ` · ${patch.beatsPerBar}/${patch.beatUnit}` : ''}`);
      }} />}
      {dialog === 'help' && <><p>拖动片段移动；拖动左右边缘裁切；选中片段后，拖动顶端的小方块设置淡入 / 淡出。同一轨道重叠片段会相加，分别设置淡化可得到交叉淡化。</p><div className="daw-help-grid"><span>播放 / 暂停</span><kbd>Space</kbd><span>在游标处切片</span><kbd>Ctrl + B</kbd><span>复制 / 粘贴到游标</span><kbd>Ctrl + C / V</kbd><span>复制片段到结尾</span><kbd>Ctrl + D</kbd><span>撤销 / 重做</span><kbd>Ctrl + Z / Shift + Z</kbd><span>删除片段或音轨</span><kbd>Delete</kbd><span>缩放时间线</span><kbd>Alt + 滚轮</kbd><span>临时关闭吸附（拖动 / 定位）</span><kbd>Shift</kbd><span>切换吸附</span><kbd>N</kbd><span>游标步进 / 加快</span><kbd>← → / Shift + ← →</kbd><span>前 / 后片段边缘</span><kbd>Ctrl + ← →</kbd><span>微移所选片段（按住连续移动）</span><kbd>Alt + ← →</kbd><span>起点 / 工程结尾</span><kbd>Home / End</kbd><span>缩小 / 放大 / 完整工程</span><kbd>− / + / F</kbd><span>所选轨道静音 / 独奏</span><kbd>M / S</kbd><span>导入音频 / 打开会话</span><kbd>Ctrl + I / O</kbd><span>展开 / 收起混音器</span><kbd>Ctrl + Shift + M</kbd><span>操作帮助</span><kbd>?</kbd></div><p style={{ marginTop: 18 }}>拖动音轨栏右边缘、属性栏左边缘和混音器上边缘调整大小；双击复原。选中分隔线可用方向键调整。吸附网格随缩放变化；绿色辅助线表示当前对齐位置。轨道与主输出电平显示真实峰值 / RMS，红色表示削波。</p><p style={{ marginTop: 18 }}>空格统一控制播放 / 暂停；聚焦按钮、下拉框或滑块时同样有效，Enter 和方向键用于操作控件。文字 / 数值输入与弹窗保留原生按键。静音影响导出；独奏只影响试听。底部“试听音量”不写入导出，“主输出”音量参与混缩。当前使用基础流式试听，播放定位精度将在原生引擎阶段提升。</p></>}
      {dialog === 'timeline' && <><p>吸附可完全关闭，也可分别选择对齐目标；按 N 切换总开关，按住 Shift 临时绕过。</p><label className="daw-division-setting"><span>网格细分</span><select aria-label="网格细分（时间线选项）" value={preferences.gridDivision} onChange={event => setPreferences(previous => ({ ...previous, gridDivision: event.target.value as DawGridDivision }))}>{DAW_GRID_DIVISIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><p className="daw-note">自动：随缩放调整细分。固定音符：按工程 BPM 计算，缩放时保持吸附精度；过密的刻线会简化显示。时间与小节标尺均可使用，不改变已有音频。</p><div className="daw-preference-list"><label><input type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />启用时间线吸附</label>{([{ key: 'snapGrid', label: '时间 / 小节网格' }, { key: 'snapEdges', label: '片段开始与结束边缘' }, { key: 'snapCursor', label: '播放游标（移动片段时）' }] as const).map(item => <label key={item.key}><input type="checkbox" checked={preferences[item.key]} onChange={event => setPreferences(previous => ({ ...previous, [item.key]: event.target.checked }))} />{item.label}</label>)}</div><p>“小节”模式根据工程 BPM 和拍号显示小节与拍；调整 BPM 只改变标尺与网格，不拉伸已有音频。BPM 与拍号随会话保存。</p><p>自动返回（Auto Return）开启时，停止后返回播放前的游标位置；关闭时，保留停止位置供下次继续。这里的起点是播放起点；Home 可回到工程零点。播放 / 暂停与停止按钮均遵循此设置。</p><div className="daw-modal-actions"><button className="daw-btn primary" onClick={() => setDialog(null)}>完成</button></div></>}
      {dialog === 'effects' && <>
        <label className="daw-division-setting"><span>添加到</span><select aria-label="效果目标" value={effectTarget} onChange={event => setEffectTarget(event.target.value)}>
          {!resolveEffectTarget(session, effectTarget) && <option value={effectTarget}>目标已移除，请重新选择</option>}
          <option value="master">主输出 · 全部音轨</option>
          {session.tracks.map(owner => <optgroup key={owner.id} label={`轨道：${owner.name}`}><option value={owner.id}>{`轨道：${owner.name}`}</option>{owner.clips.map(piece => <option key={piece.id} value={clipEffectTarget(piece.id)}>{`片段：${piece.name} · ${fmtTime(piece.start)}`}</option>)}</optgroup>)}
        </select></label>
        <EffectsBrowser hideHeading vst3Disabled={resolveEffectTarget(session, effectTarget)?.kind !== 'track' && effectTarget !== 'master'} onAddVst3={plugin => edit(current => { const next = addEffect(current, effectTarget, createVst3Effect(plugin)); notify(`已添加到${effectTargetName(next, effectTarget)}效果链`); return next; })} onAdd={type => edit(current => {
          const next = addEffect(current, effectTarget, type);
          notify(`已添加到${effectTargetName(next, effectTarget)}效果链`);
          return next;
        })} />
      </>}
      {dialog === 'effect-editor' && editingEffect && (() => { const targetExists = !!resolveEffectTarget(session, effectTarget); const effect = targetExists ? getEffectChain(session, effectTarget).find(item => item.id === editingEffect) : undefined; return effect ? effect.type === 'vst3' ? <Vst3Editor effect={effect} nativeError={vst3OpenError} onRetryNative={() => void openVst3Editor(effectTarget, effect.id)} onChange={next => changeEffect(effectTarget, effect.id, next)} onBeginGesture={beginGesture} onCommitGesture={commitGesture} onUndo={undo} onRedo={redo} canUndo={!!history.current.past.length} canRedo={!!history.current.future.length} /> : <EffectEditor effect={effect} ownerName={effectTargetName(session, effectTarget)} sidechainTracks={getSidechainTracks(session, effectTarget)} onChange={next => changeEffect(effectTarget, effect.id, next)} onBeginGesture={beginGesture} onCommitGesture={commitGesture} onUndo={undo} onRedo={redo} canUndo={!!history.current.past.length} canRedo={!!history.current.future.length} readings={editingReadings} sampleRate={session.sampleRate} tempoBpm={musicalGrid.bpm} onResetMeters={() => engine.current?.resetMeters()} comparison={effectComparison?.effectId === effect.id ? effectComparison : undefined} onToggleComparison={() => { commitGesture(); void engine.current?.toggleComparison(effect.id); }}
        onLearnNoise={(start, length) => void learnNoise(effectTarget, effect.id, start, length)} onListenNoise={() => toggleNoise(effect.id)}
        matchEq={effect.type === 'eq' ? { ...makeMatchEqInput(session, effectTarget, effect.id, matchResult), transportPlaying: playing, monitorDb } : undefined}
        onAnalyzeMatch={(sourceTarget, reference) => void analyzeMatch(effectTarget, effect.id, sourceTarget, reference)}
        onAuditionMatch={auditionMatch}
        noiseLearnStart={getNoiseStart(effectTarget)} noiseLearnEnd={getNoiseBounds(session, effectTarget).end} noiseLearning={noiseLearnState?.id === effect.id && noiseLearnState.pending} noisePreview={effect.type === 'denoise' ? makeNoiseSelectionPreview(session, effectTarget, getNoiseStart(effectTarget)) : undefined}
        noiseLearnMessage={noiseLearnState?.id === effect.id ? noiseLearnState.message : undefined} listeningNoise={noiseListenId === effect.id} /> : <p>该效果已被移除。</p>; })()}

      {dialog === 'assets' && <><p>已导入素材可以重复使用。素材文件保留在本机，保存会话不会复制音频文件。</p>{session.assets.length ? session.assets.map(asset => <div key={asset.id} className="daw-reserved-item"><Music2 size={16} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{asset.name}</div><small>{fmtTime(asset.duration)} · {asset.channels} 声道 · {asset.sampleRate / 1000} kHz</small></div><button className="daw-btn small" onClick={() => addAssetClip(asset, false)} title="插入所选轨道的游标位置">插入</button><button className="daw-icon" title="以新轨道添加" aria-label={`${asset.name} 以新轨道添加`} onClick={() => addAssetClip(asset, true)}><Plus size={13} /></button></div>) : <p>尚未导入音频。</p>}<div className="daw-modal-actions"><button className="daw-btn primary" disabled={!!busy} onClick={() => { setDialog(null); chooseFiles(); }}><Plus size={13} />导入音频</button></div></>}
      {dialog === 'new' && <><p>当前会话会保留在撤销历史中。需要长期保留时，请先保存会话文件。</p><div className="daw-modal-actions"><button className="daw-btn" onClick={saveSession}>先保存</button><button className="daw-btn primary" onClick={() => { void (async () => { pause(); try { await engine.current?.closeVst3Editors(); } catch (error) { notify(error instanceof Error ? error.message : '关闭插件窗口失败'); return; } clipboard.current = null; edit(() => createSession()); setSelection(null); seek(0); setDialog(null); })(); }}>新建空会话</button></div></>}
      {dialog === 'export' && <>
        <p>导出全部未静音轨道，包含片段增益、淡化、轨道音量、左右位置与主输出音量。</p>
        <div className="daw-reserved-item">
          <AudioLines size={18} />
          <span>WAV · 24 bit · {session.sampleRate / 1000} kHz · 立体声
            <small style={{ display: 'block', marginTop: 4 }}>范围 00:00 — {fmtTime(duration)} · {session.tracks.filter(item => !item.muted).length} 条未静音音轨</small>
          </span>
        </div>
        <p className="daw-note">使用当前修订的固定快照。内置效果使用原生处理链，保留混响／延迟尾音（最多 30 秒）。轨道独奏、试听音量、EQ 频段独听、检测信号独听和立体声临时监听不影响导出；明确设置的声道转换仍会写入导出。</p>
        {exportResult && <>
          <div className="daw-reserved-item daw-export-result">
            <span>导出已完成 · 时长 {fmtTime(exportResult.duration)}
              {typeof exportResult.tailSeconds === 'number' && Number.isFinite(exportResult.tailSeconds) && exportResult.tailSeconds > 0 ? `（含 ${exportResult.tailSeconds.toFixed(2)} 秒尾音）` : ''}
            </span>
            <div className="daw-export-result-actions">
              <a className="daw-btn" href={exportResult.url} download={exportResult.name}><ArrowDownToLine size={13} />下载 WAV</a>
              <button type="button" className="daw-btn primary" disabled={!!busy} onClick={() => void importMixToEditor(exportResult)}>
                {importingMix ? <LoaderCircle className="spin" size={13} /> : <Clapperboard size={13} />}
                {importingMix ? '正在导入…' : '导入剪辑'}
              </button>
            </div>
          </div>
          <p className="daw-note">导入剪辑会将混音设为当前剪辑工程的主音轨，可撤销。</p>
          <div className="daw-export-quality" aria-label="导出质量测量">
            <div><span>综合响度</span><strong>{fmtMeasurement(exportResult.loudness?.integrated, 'LUFS')}</strong></div>
            <div><span>真峰值</span><strong>{fmtMeasurement(exportResult.loudness?.truePeak, 'dBTP')}</strong></div>
            <div><span>超限采样</span><strong>{typeof exportResult.clippedSamples === 'number' && Number.isFinite(exportResult.clippedSamples) && exportResult.clippedSamples >= 0 ? exportResult.clippedSamples.toLocaleString() : '未测得'}</strong></div>
          </div>
          <p className="daw-note">超限采样数统计量化前超出 ±1 的采样值，左右声道分别计数；0 表示没有超限采样。</p>
        </>}
        <div className="daw-modal-actions">
          <button type="button" className="daw-btn" onClick={() => busy ? request.current?.abort() : setDialog(null)}>
            {importingMix ? '取消导入' : busy ? '取消导出' : '关闭'}
          </button>
          <button type="button" className={`daw-btn${exportResult ? '' : ' primary'}`} disabled={!!busy || !duration} onClick={() => void renderMix()}>
            {busy && !importingMix ? <LoaderCircle className="spin" size={13} /> : <ArrowDownToLine size={13} />}生成 WAV
          </button>
        </div>
      </>}
    </section></div>}
    <span hidden data-daw-history-version={historyVersion} />
  </div>;
}
