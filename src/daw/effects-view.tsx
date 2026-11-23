import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Activity, ArrowDown, ArrowRight, ArrowUp, AudioLines, BarChart3, Check, ChevronDown, ChevronUp, Copy, ExternalLink, Filter, Gauge, GitCompareArrows, Headphones, Layers3, Plus, Power, Redo2, RotateCcw, Save, Search, Shield, SlidersHorizontal, Sparkles, Star, Trash2, Undo2, Upload, Waves, X } from 'lucide-react';
import { DAW_DELAY_NOTE_BEATS, DAW_EFFECT_CATALOG, DENOISE_SWITCHES, EQ_MATCH_FREQUENCIES, canAuditionDenoise, clipEffectTarget, copyActiveEffectSlot, denoiseModes, describeEnabledEqBands, formatEffectParameter, getEffectDefinition, getEffectDefaultParams, getEffectDisplayName, isDawEffectType } from './effects';
import type { DawEffect, DawEffectParameter, DawEffectType } from './effects';
import { DAW_FAVORITES_KEY, DAW_PRESETS_KEY, createDawUserPreset, isDawUserPreset, readEffectPreference, writeEffectPreference } from './effect-preferences';
import type { EffectComparison } from './effect-comparison';
import { dawHistoryShortcut } from './history-shortcuts';
import { eqBandResponse, eqCutoffHz, eqMatchResponse, eqSupportsDynamics } from './eq-response';
import { compressorTransfer, deesserResponse, deesserLimitDb, delayEvents, saturationTransfer } from './effect-graph-math';
import { MATCH_CLIP_MIME, importDawAudio, type MatchReferenceId } from './services';
import './effects-view.css';
import { Vst3Browser } from './vst3-view';
import type { Vst3Plugin } from './vst3';

/** Readings are measured audio levels in dBFS, never synthesized by the view. */
export interface EffectMeterReadings {
  inputDb?: number; outputDb?: number; inputRmsDb?: number; outputRmsDb?: number;
  reductionDb?: number; sidechainInputDb?: number; duckerProgramDb?: number; duckerKeyDb?: number; transientGainDb?: number; peakDb?: number; rmsDb?: number; correlation?: number;
  spectrum?: readonly number[]; spectrumMaxHz?: number; sampleRate?: number; leftDb?: number; rightDb?: number;
  integratedLufs?: number; shortTermLufs?: number; momentaryLufs?: number;
  truePeakDb?: number; loudnessRange?: number; crestDb?: number;
  bandReductionDb?: readonly number[]; multibandReductionDb?: readonly number[];
}
export interface NoiseSelectionPreview {
  start: number;
  end: number;
  peaks: number[];
  lowerBound?: number;
}
export interface MatchEqResult {
  id: string; sourceTarget: string; reference: MatchReferenceId; pending?: boolean; message?: string; gains?: number[];
}
type MatchEqReference = MatchReferenceId & { assetId: string; name: string; start: number; duration: number };
export interface MatchEqInput {
  sessionId: string; owner: { target: string; name: string; hasAudio: boolean };
  sources: { target: string; name: string }[]; references: MatchEqReference[]; result?: MatchEqResult;
  transportPlaying?: boolean; monitorDb?: number;
}
export interface EffectsBrowserProps { onAdd: (type: DawEffectType) => void; compact?: boolean; onClose?: () => void; hideHeading?: boolean; onAddVst3?: (plugin: Vst3Plugin) => void; vst3Disabled?: boolean }
export interface EffectChainViewProps {
  title: string; effects: readonly DawEffect[]; onAdd: () => void; onEdit: (id: string) => void;
  onToggle: (id: string) => void; onBypassAll: () => void; onRemove: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void;
  onCopy: (id: string) => void; compact?: boolean;
}
export interface EffectEditorProps {
  effect: DawEffect; ownerName?: string; sidechainTracks?: readonly { id: string; name: string }[]; onChange: (next: DawEffect) => void;
  onBeginGesture?: () => void; onCommitGesture?: () => void;
  onUndo?: () => void; onRedo?: () => void; canUndo?: boolean; canRedo?: boolean;
  comparison?: EffectComparison; onToggleComparison?: () => void;
  readings?: EffectMeterReadings; sampleRate?: number; tempoBpm?: number; onResetMeters?: () => void; onClose?: () => void;
  onLearnNoise?: (start: number, duration: number) => void; noiseLearning?: boolean; noiseLearnStart?: number; noiseLearnEnd?: number; noiseLearnMessage?: string; noisePreview?: NoiseSelectionPreview; onListenNoise?: () => void; listeningNoise?: boolean;
  matchEq?: MatchEqInput; onAnalyzeMatch?: (sourceTarget: string, reference: MatchReferenceId) => void; onAuditionMatch?: () => void;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finiteDb = (value?: number) => Number.isFinite(value) ? clamp(value!, -90, 24) : -90;
const dbText = (value?: number) => value !== undefined && Number.isFinite(value) && value > -89 ? value.toFixed(1) : '−∞';
function useStoredList<T>(key: string, validate: (value: unknown) => value is T) {
  const read = () => readEffectPreference(key, validate);
  const [list, setList] = useState<T[]>(read);
  useEffect(() => { const listener = (event: StorageEvent) => { if (event.key === key) setList(read()); }; window.addEventListener('storage', listener); return () => window.removeEventListener('storage', listener); }, [key]);
  return [list, (next: T[]) => { setList(next); try { writeEffectPreference(key, next); } catch { /* Session remains usable if storage is full. */ } }] as const;
}
const effectIcons: Record<DawEffectType, typeof Waves> = { eq: Filter, compressor: Gauge, ducker: ArrowDown, gate: Shield, deesser: AudioLines, transient: Activity, reverb: Waves, delay: Layers3, saturation: Sparkles, stereo: Headphones, limiter: SlidersHorizontal, meter: BarChart3, multiband: SlidersHorizontal, convolution: Waves, modulation: Waves, denoise: Shield, lofi: Sparkles, pedal: Gauge };
function EffectIcon({ type, size = 21 }: { type: DawEffectType | 'vst3'; size?: number }) { const Icon = type === 'vst3' ? AudioLines : effectIcons[type] ?? AudioLines; return <Icon size={size} strokeWidth={1.5} />; }
function IconButton({ title, onClick, disabled, active, children, className = '' }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode; className?: string }) {
  return <button type="button" title={title} aria-label={title} className={`fx-icon-button ${active ? 'active' : ''} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function EffectsBrowser({ onAdd, compact = false, onClose, hideHeading = false, onAddVst3, vst3Disabled }: EffectsBrowserProps) {
  const [tab, setTab] = useState<'builtin' | 'vst3'>('builtin');
  const [query, setQuery] = useState(''), [category, setCategory] = useState('全部');
  const [favorites, setFavorites] = useStoredList(DAW_FAVORITES_KEY, isDawEffectType);
  const categories = ['全部', ...new Set(DAW_EFFECT_CATALOG.map(effect => effect.category)), '收藏'];
  const normalized = query.trim().toLocaleLowerCase();
  const effects = DAW_EFFECT_CATALOG.filter(effect => (category === '全部' || category === '收藏' && favorites.includes(effect.type) || effect.category === category) && (!normalized || [effect.name, effect.subtitle, effect.type, effect.description, effect.category].join(' ').toLocaleLowerCase().includes(normalized)));
  const tabs = onAddVst3 && <nav className="fx-browser-filters" aria-label="效果来源"><button type="button" className={tab === 'builtin' ? 'active' : ''} onClick={() => setTab('builtin')}>内置效果</button><button type="button" className={tab === 'vst3' ? 'active' : ''} onClick={() => setTab('vst3')}>VST3</button></nav>;
  if (tab === 'vst3' && onAddVst3) return <>{tabs}<Vst3Browser onAdd={onAddVst3} disabled={vst3Disabled} /></>;
  return <section className={`fx-surface fx-browser ${compact ? 'compact' : ''}`} aria-label="内置效果库">
    {tabs}
    {!hideHeading && <div className="fx-browser-head"><div><h2>内置效果</h2><p>添加到所选片段、轨道或主输出。</p></div>{onClose ? <IconButton title="关闭效果库" onClick={onClose}><X size={17} /></IconButton> : <span className="fx-tag">VISIKI AUDIO</span>}</div>}
    <label className="fx-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、类型或声音处理…" aria-label="搜索内置效果" /><span className="fx-tag">{DAW_EFFECT_CATALOG.length} FX</span></label>
    <nav className="fx-browser-filters" aria-label="效果分类">{categories.map(name => <button type="button" key={name} className={category === name ? 'active' : ''} aria-pressed={category === name} onClick={() => setCategory(name)}>{name === '收藏' ? '★ ' : ''}{name}</button>)}</nav>
    <div className="fx-library-count"><span>{effects.length} 款效果 · {category}</span><span>点击添加到当前效果链</span></div>
    <div className="fx-library-results"><div className="fx-library-grid">{effects.map(effect => <article className="fx-library-card" key={effect.type} data-effect-type={effect.type}>
      <div className="fx-effect-icon" style={{ color: effect.color }}><EffectIcon type={effect.type} /></div><div className="fx-library-info"><h3>{effect.name}</h3><small>{effect.subtitle}</small><p>{effect.description}</p><div className="fx-library-actions"><span className="fx-tag">{effect.category}</span><button type="button" className="fx-button small" onClick={() => onAdd(effect.type)} aria-label={`添加${effect.name}`}><Plus size={12} />添加</button></div></div>
      <button type="button" className={`fx-favorite ${favorites.includes(effect.type) ? 'active' : ''}`} aria-label={`${favorites.includes(effect.type) ? '取消收藏' : '收藏'}${effect.name}`} aria-pressed={favorites.includes(effect.type)} onClick={() => setFavorites(favorites.includes(effect.type) ? favorites.filter(type => type !== effect.type) : [...favorites, effect.type])}><Star size={13} fill={favorites.includes(effect.type) ? 'currentColor' : 'none'} /></button>
    </article>)}</div>
    {!effects.length && <div className="fx-library-empty"><Search size={25} /><p>{category === '收藏' && !query ? '点击效果上的星标，建立你的常用效果库。' : '没有找到匹配的效果，试试其他关键词。'}</p></div>}
    <p className="fx-browser-foot">效果按从上到下的顺序处理声音，可在效果链中随时调整。</p></div>
  </section>;
}

export function EffectChainView({ title, effects, onAdd, onEdit, onToggle, onBypassAll, onRemove, onMove, onCopy, compact = false }: EffectChainViewProps) {
  const chainTitle = title.endsWith('效果链') ? title : `${title} · 效果链`;
  return <section className={`fx-surface fx-chain ${compact ? 'compact' : ''}`} aria-label={chainTitle}>
    <div className="fx-chain-heading">
      <h3>{chainTitle}</h3>
      <div className="fx-chain-heading-actions">
        <small>{effects.length} 个处理器</small>
        <button type="button" className="fx-button subtle fx-chain-bypass-all" title="旁路此链的全部效果，保留插件及其参数"
          disabled={!effects.some(effect => effect.enabled)} onClick={onBypassAll}><Power size={11} />全部旁路</button>
      </div>
    </div>
    {effects.length > 0 && <div className="fx-chain-flow"><span>输入</span><i /><ArrowDown size={11} /><i /><span>输出</span></div>}
    <ol className="fx-chain-list">{effects.map((effect, index) => { const definition = effect.type === 'vst3' ? { name: getEffectDisplayName(effect), subtitle: 'VST3 插件' } : getEffectDefinition(effect.type); return <li key={effect.id}>
      <div className={`fx-chain-item ${effect.enabled ? '' : 'is-disabled'}`} data-effect-id={effect.id}><span className="fx-chain-index">{String(index + 1).padStart(2, '0')}</span>
        <button type="button" className="fx-chain-open" title={`打开${definition.name}独立编辑窗口`} onClick={() => onEdit(effect.id)}><EffectIcon type={effect.type} size={17} /><span className="fx-chain-label"><span className="fx-chain-name">{getEffectDisplayName(effect)}</span><small>{effect.enabled ? definition.subtitle : '已旁路 · BYPASS'}</small></span><ExternalLink size={11} /></button>
        <IconButton title={`${effect.enabled ? '旁路' : '启用'}${definition.name}`} active={effect.enabled} className="fx-power" onClick={() => onToggle(effect.id)}><Power size={12} /></IconButton>
      </div><div className="fx-chain-tools"><IconButton title={`上移${definition.name}`} onClick={() => onMove(effect.id, -1)} disabled={index === 0}><ArrowUp size={11} /></IconButton><IconButton title={`下移${definition.name}`} onClick={() => onMove(effect.id, 1)} disabled={index === effects.length - 1}><ArrowDown size={11} /></IconButton><IconButton title={`复制${definition.name}`} onClick={() => onCopy(effect.id)}><Copy size={11} /></IconButton><IconButton title={`删除${definition.name}`} className="danger" onClick={() => onRemove(effect.id)}><Trash2 size={11} /></IconButton></div>
    </li>; })}</ol>
    {!effects.length && <div className="fx-chain-empty"><Waves size={25} strokeWidth={1.2} /><strong>还没有效果</strong><p>添加内置效果，在独立窗口中调整参数。</p></div>}
    <button type="button" className="fx-button subtle fx-chain-add" onClick={onAdd}><Plus size={12} />添加效果</button>
  </section>;
}

interface ParameterControlProps { parameter: DawEffectParameter; value: number; onChange: (value: number) => void; begin: () => void; commit: () => void; atomic: (value: number) => void }
function ParameterControl({ parameter: p, value, onChange, begin, commit, atomic }: ParameterControlProps) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const editBase = useRef(value), cancelled = useRef(false);
  useEffect(() => { editBase.current = value; setDraft(String(Number(value.toFixed(6)))); }, [value]);
  const normalize = (number: number) => clamp(Math.round((number - p.min) / p.step) * p.step + p.min, p.min, p.max);
  const log = p.scale === 'log' && p.min > 0;
  const unit = log ? Math.log(clamp(value, p.min, p.max) / p.min) / Math.log(p.max / p.min) : (value - p.min) / (p.max - p.min);
  if (p.min === 0 && p.max === 1 && p.step === 1 && (!p.options || p.options[0] === '关')) return <div className="fx-control"><span className="fx-control-head">{p.label}</span><button type="button" role="switch" aria-checked={!!value} aria-label={p.label} className="fx-control-toggle" title={p.description} onClick={() => atomic(value ? 0 : 1)}><span className="fx-switch"><i /></span><span>{value ? '已启用' : '已关闭'}</span></button></div>;
  if (p.options?.length) return <label className="fx-control" title={p.description}><span className="fx-control-head"><span>{p.label}</span></span><select aria-label={p.label} value={value} onChange={event => atomic(Number(event.target.value))}>{p.options.map((label, index) => <option key={index} value={index + p.min}>{label}</option>)}</select></label>;
  return <div className="fx-control" title={p.description}>
    <div className="fx-control-head"><label htmlFor={id}>{p.label}</label><output className="fx-control-value" htmlFor={id}>{formatEffectParameter(p, value)}</output></div>
    <input id={id} aria-label={p.label} aria-valuetext={formatEffectParameter(p, value)} type="range" min={0} max={1000} step={1} value={clamp(unit, 0, 1) * 1000}
      onPointerDown={begin} onPointerUp={commit} onPointerCancel={commit} onBlur={commit}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) begin(); }} onKeyUp={commit}
      onChange={event => { const u = Number(event.target.value) / 1000; onChange(normalize(log ? p.min * (p.max / p.min) ** u : p.min + u * (p.max - p.min))); }}
      onDoubleClick={() => atomic(p.default)} />
    <div className="fx-control-limits"><span>{formatEffectParameter(p, p.min)}</span><div className="fx-number-wrap"><input className="fx-number-entry" aria-label={`${p.label}精确数值`} type="number" step={p.step} min={p.min} max={p.max} value={draft}
      onFocus={() => { editBase.current = value; cancelled.current = false; }} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); } }}
      onBlur={() => { if (cancelled.current || editBase.current !== value || !draft.trim() || !Number.isFinite(Number(draft))) { setDraft(String(value)); return; } const next = normalize(Number(draft)); setDraft(String(Number(next.toFixed(6)))); if (next !== value) atomic(next); }} /><span>{p.unit}</span></div><span>{formatEffectParameter(p, p.max)}</span></div>
  </div>;
}

function LevelMeter({ label, value }: { label: string; value?: number }) {
  return <div className="fx-level"><span>{label}</span><div className="fx-level-bar" role="meter" aria-label={`${label}电平 dBFS`} aria-valuemin={-90} aria-valuemax={0} aria-valuenow={Math.min(0, finiteDb(value))} aria-valuetext={`${dbText(value)} dBFS`}><i style={{ transform: `scaleX(${clamp((finiteDb(value) + 60) / 60, 0, 1)})` }} /></div><output>{dbText(value)}</output></div>;
}
function ReductionMeter({ value }: { value?: number }) {
  const reduction = Number.isFinite(value) ? Math.abs(value!) : 0;
  return <div className="fx-reduction"><span>GR</span><div className="fx-level-bar"><i style={{ transform: `scaleX(${clamp(reduction / 24, 0, 1)})` }} /></div><output>{reduction.toFixed(1)} <small>dB</small></output></div>;
}
const GRAPH = { width: 640, height: 220, left: 40, right: 18, top: 18, bottom: 29 };
const graphX = (frequency: number) => GRAPH.left + Math.log(clamp(frequency, 20, 20000) / 20) / Math.log(1000) * (GRAPH.width - GRAPH.left - GRAPH.right);
const EQ_BANDS = [1, 2, 3, 4, 5, 6, 7, 8];
const EQ_DISPLAY_RATIOS = [1, 2, 4] as const;
const eqGraphY = (db: number, limit: number) => GRAPH.top + (limit - db) / (2 * limit) * (GRAPH.height - GRAPH.top - GRAPH.bottom);
function eqCurve(params: DawEffect['params'], sampleRate: number, maxHz: number, limit: number, reductions?: readonly number[]) {
  const trim = (params.inputDb ?? 0) + (params.outputDb ?? 0);
  return Array.from({ length: 192 }, (_, index) => {
    const frequency = 20 * (maxHz / 20) ** (index / 191);
    const response = EQ_BANDS.reduce((db, band) => db + eqBandResponse(frequency, params, band, sampleRate, reductions?.[band - 1]), trim + eqMatchResponse(frequency, params, sampleRate));
    return `${index ? 'L' : 'M'}${graphX(frequency).toFixed(2)},${eqGraphY(response, limit).toFixed(2)}`;
  }).join(' ');
}
const readParam = (params: Record<string, number>, keys: string[], fallback: number) => { for (const key of keys) if (Number.isFinite(params[key])) return params[key]; return fallback; };
function spectrumPoints(readings: EffectMeterReadings, y: (db: number) => number): string {
  const bins = readings.spectrum ?? [], maxHz = Math.max(21, readings.spectrumMaxHz ?? 24000);
  return bins.map((db, index) => ({ frequency: 20 * (maxHz / 20) ** (index / Math.max(1, bins.length - 1)), db }))
    .filter(bin => bin.frequency <= 20000).map(bin => `L${graphX(bin.frequency)},${y(bin.db)}`).join(' ');
}

function EqGraph({ effect, selected, setSelected, change, begin, commit, readings, sampleRate }: { effect: DawEffect; selected: number; setSelected: (band: number) => void; change: (patch: Record<string, number>) => void; begin: () => void; commit: () => void; readings?: EffectMeterReadings; sampleRate: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointer: number; band: number; x: number; y: number; frequency: number; gain: number } | null>(null);
  const [ratio, setRatio] = useState<typeof EQ_DISPLAY_RATIOS[number]>(1);
  const clipId = useId();
  const limit = 6 * ratio, maxFrequency = Math.min(20000, sampleRate / 2), plotBottom = GRAPH.height - GRAPH.bottom;
  const params = effect.params, graphY = (db: number) => eqGraphY(db, limit);
  const enabledBands = useMemo(() => describeEnabledEqBands(params), [params]);
  const reductions = effect.enabled && !params.soloBand ? readings?.bandReductionDb : undefined;
  const isDynamicBand = (band: number) => !!params[`band${band}Dyn`] && eqSupportsDynamics(params[`band${band}Type`] ?? 0);
  const hasDynamics = EQ_BANDS.some(band => params[`band${band}Enabled`] && isDynamicBand(band));
  const hasReduction = hasDynamics && reductions?.some(value => value > .03);
  const curve = useMemo(() => eqCurve(params, sampleRate, maxFrequency, limit), [params, sampleRate, maxFrequency, limit]);
  const effective = useMemo(() => hasReduction ? eqCurve(params, sampleRate, maxFrequency, limit, reductions) : undefined, [hasReduction, params, sampleRate, maxFrequency, limit, reductions]);
  const plotPoint = (event: ReactPointerEvent<SVGElement>) => {
    const svg = svgRef.current, transform = svg?.getScreenCTM();
    if (!svg || !transform) return undefined;
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(transform.inverse());
  };
  const updateDrag = (event: ReactPointerEvent<SVGElement>) => {
    const start = drag.current, point = plotPoint(event);
    if (start?.pointer !== event.pointerId || !point) return;
    const frequency = start.frequency * 1000 ** ((point.x - start.x) / (GRAPH.width - GRAPH.left - GRAPH.right));
    const gain = clamp(start.gain - (point.y - start.y) / (plotBottom - GRAPH.top) * (2 * limit), -24, 24);
    change({ [`band${start.band}Freq`]: Math.round(eqCutoffHz(frequency, sampleRate)), [`band${start.band}Gain`]: Math.round(gain * 10) / 10 });
  };
  const endDrag = (event: ReactPointerEvent<SVGElement>) => { if (drag.current?.pointer !== event.pointerId) return; drag.current = null; commit(); };
  return <div className="fx-graph-panel"><div className="fx-graph-caption fx-eq-display"><span>纵轴范围：±{limit} dB</span><div className="fx-segments" role="group" aria-label="EQ 纵轴倍率">{EQ_DISPLAY_RATIOS.map(value => <button key={value} type="button" title={`显示 ±${6 * value} dB`} className={ratio === value ? 'active' : ''} aria-pressed={ratio === value} onClick={() => setRatio(value)}>{value}×</button>)}</div></div>
    <svg ref={svgRef} viewBox={`0 0 ${GRAPH.width} ${GRAPH.height}`} className="fx-graph" aria-label="八段均衡频率响应，拖动节点调节频率与增益" onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) { drag.current = null; commit(); } }}>
    <defs><clipPath id={clipId}><rect x={GRAPH.left} y={GRAPH.top} width={GRAPH.width - GRAPH.left - GRAPH.right} height={plotBottom - GRAPH.top} /></clipPath></defs>
    {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map(frequency => <g key={frequency}><line className="fx-gridline" x1={graphX(frequency)} x2={graphX(frequency)} y1={GRAPH.top} y2={GRAPH.height - GRAPH.bottom} /><text x={graphX(frequency)} y={GRAPH.height - 10} textAnchor="middle">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text></g>)}
    {[-limit, -limit / 2, 0, limit / 2, limit].map(db => <g key={db}><line className={db === 0 ? 'fx-zeroline' : 'fx-gridline'} x1={GRAPH.left} x2={GRAPH.width - GRAPH.right} y1={graphY(db)} y2={graphY(db)} /><text x={GRAPH.left - 9} y={graphY(db) + 3} textAnchor="end">{db > 0 ? '+' : ''}{db}</text></g>)}
    <g clipPath={`url(#${clipId})`}>{readings?.spectrum && readings.spectrum.length > 1 && <path fill="#79c8b518" stroke="#83c6b349" strokeWidth="1" d={`M${GRAPH.left},${plotBottom} ${spectrumPoints(readings, db => GRAPH.top + (1 - clamp((db + 90) / 90, 0, 1)) * (plotBottom - GRAPH.top))} L${graphX(maxFrequency)},${plotBottom}Z`} />}<path className="fx-curve-fill" d={`${effective ?? curve} L${graphX(maxFrequency)},${graphY(0)} L${GRAPH.left},${graphY(0)} Z`} /><path className={effective ? 'fx-curve fx-eq-static' : 'fx-curve'} d={curve} />{effective && <path className="fx-curve fx-eq-dynamic" d={effective} />}</g>
    {EQ_BANDS.map(band => { const frequency = eqCutoffHz(params[`band${band}Freq`] ?? 1000, sampleRate), gain = params[`band${band}Gain`] ?? 0; return <g key={band} className={`fx-eq-handle ${selected === band ? 'selected' : ''} ${params[`band${band}Enabled`] === 0 || (params.soloBand && params.soloBand !== band) ? 'disabled' : ''}`} tabIndex={0} role="slider" aria-label={`均衡第${band}段`} aria-valuemin={-24} aria-valuemax={24} aria-valuenow={gain} aria-valuetext={`${Math.round(frequency)} Hz，${gain.toFixed(1)} dB`} transform={`translate(${graphX(frequency)},${graphY(clamp(gain, -limit, limit))})`}
      onFocus={() => setSelected(band)} onPointerDown={event => { const point = plotPoint(event); if (event.button !== 0 || drag.current || !point) return; event.preventDefault(); event.stopPropagation(); setSelected(band); begin(); if (!params[`band${band}Enabled`]) change({ [`band${band}Enabled`]: 1 }); drag.current = { pointer: event.pointerId, band, x: point.x, y: point.y, frequency, gain }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); begin(); const amount = event.shiftKey ? 1 : .1; change(event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? { [`band${band}Freq`]: Math.round(eqCutoffHz(frequency * (event.key === 'ArrowRight' ? 1.04 : 1 / 1.04), sampleRate)) } : { [`band${band}Gain`]: Math.round(clamp(gain + (event.key === 'ArrowUp' ? amount : -amount), -24, 24) * 10) / 10 }); }} onKeyUp={commit} onBlur={commit}>
      <circle className="fx-eq-halo" r={16} /><circle className="fx-eq-dot" r={8} /><text y={3}>{band}</text></g>; })}
  </svg>
    {hasDynamics && <div className="fx-graph-caption"><span>动态 EQ{!effect.enabled ? ' · 效果已旁路' : params.soloBand ? ' · 独听时不应用动态衰减' : ''}</span><strong>{effective ? '虚线：静态 · 实线：实时' : '当前显示静态响应'}</strong></div>}
    <div className="fx-eq-tabs" aria-label="选择均衡频段">{EQ_BANDS.map(band => <button type="button" key={band} className={`${selected === band ? 'active' : ''} ${!params[`band${band}Enabled`] ? 'is-disabled' : ''} ${isDynamicBand(band) ? 'is-dynamic' : ''}`} title={isDynamicBand(band) ? `频段 ${band} · 动态衰减已开启` : `频段 ${band}`} aria-pressed={selected === band} onClick={() => setSelected(band)}>B{band}</button>)}</div>
    {enabledBands.length > 0 && <div className="fx-eq-summary" role="group" aria-label="已启用频段的参数">
      {enabledBands.map(({ band, filter, details }) => <button type="button" key={band}
        data-eq-active-band={band} aria-pressed={selected === band} onClick={() => setSelected(band)}>
        <strong>B{band} · {filter}</strong><small>{details}</small>
      </button>)}
    </div>}
  </div>;
}

function DynamicsGraph({ effect, readings }: { effect: DawEffect; readings?: EffectMeterReadings }) {
  const p = effect.params, threshold = readParam(p, ['thresholdDb', 'threshold'], -18), ratio = Math.max(1, readParam(p, ['ratio'], 4)), knee = readParam(p, ['kneeDb', 'knee'], 6), makeup = readParam(p, ['makeupDb', 'outputDb'], 0);
  const gate = effect.type === 'gate', limiter = effect.type === 'limiter';
  const truePeak = limiter && p.truePeak === 1, ceiling = readParam(p, ['ceilingDb'], -1), drive = readParam(p, ['inputDb'], 0);
  const transfer = (input: number) => {
    if (gate) return input < threshold ? Math.max(-72, input - Math.min(readParam(p, ['rangeDb', 'range'], 48), (threshold - input) * (ratio - 1))) : input;
    if (limiter) return Math.min(input + drive, ceiling) + readParam(p, ['outputDb'], 0);
    return compressorTransfer(input, threshold, ratio, knee, makeup, readParam(p, ['mix'], 100));
  };
  const x = (db: number) => 48 + (db + 60) / 60 * 548, y = (db: number) => 182 - clamp((db + 60) / 60, 0, 1) * 164;
  const path = Array.from({ length: 181 }, (_, i) => { const input = -60 + i / 3; return `${i ? 'L' : 'M'}${x(input)},${y(transfer(input))}`; }).join(' ');
  const unit = truePeak ? 'dBTP' : 'dBFS';
  return <div className="fx-graph-panel"><svg viewBox="0 0 640 220" className="fx-graph" role="img" aria-label={gate ? '门限扩展曲线' : limiter ? '限幅输入输出曲线' : '压缩输入输出曲线'}>{[-60, -48, -36, -24, -12, 0].map(db => <g key={db}><line className="fx-gridline" x1={x(db)} x2={x(db)} y1={18} y2={182} /><line className="fx-gridline" x1={48} x2={596} y1={y(db)} y2={y(db)} /><text x={x(db)} y={200} textAnchor="middle">{db}</text><text x={34} y={y(db) + 3} textAnchor="end">{db}</text></g>)}
    <path className="fx-diagonal" d="M48,182L596,18" /><path className="fx-curve" d={path} />
    {limiter ? <><line stroke="#b48acf77" strokeDasharray="3 4" x1={48} x2={596} y1={y(ceiling)} y2={y(ceiling)} /><text x={586} y={Math.max(32, y(ceiling) - 5)} textAnchor="end">上限 {ceiling.toFixed(1)} {unit}</text></> : <><line stroke="#b48acf77" strokeDasharray="3 4" x1={x(threshold)} x2={x(threshold)} y1={18} y2={182} /><text x={x(threshold) + 5} y={31}>THR {threshold.toFixed(1)}</text></>}
    {(gate || limiter) && !truePeak && readings?.inputDb !== undefined && readings.inputDb > -60 && <circle cx={x(clamp(readings.inputDb, -60, 0))} cy={y(transfer(clamp(readings.inputDb, -60, 0)))} r={5} fill="#91dfc6" />}<text x={600} y={214} textAnchor="end">INPUT {unit} →</text><text x={48} y={12}>OUTPUT {unit}</text></svg><div className="fx-graph-caption"><span>{gate ? '低于门限时衰减，保留干净的间隙' : truePeak ? '真峰值模式 · 8× 检测采样间峰值' : limiter ? '采样峰值模式 · 保护采样点输出' : `稳态示意 · 比率 ${ratio.toFixed(1)}:1 · 混合 ${readParam(p, ['mix'], 100)}% · 超出坐标范围处截断`}</span><ReductionMeter value={readings?.reductionDb} /></div></div>;
}
function SpaceGraph({ effect, tempoBpm }: { effect: DawEffect; tempoBpm: number }) {
  const p = effect.params;
  if (effect.type === 'reverb') {
    const decay = readParam(p, ['decaySec'], 1.8), predelay = readParam(p, ['preDelayMs'], 20);
    const size = .45 + readParam(p, ['size'], 60) * .011, earlySize = readParam(p, ['earlySize'], 100) / 100;
    const earlyMix = readParam(p, ['earlyMix'], 25) / 100;
    // Time coefficients mirror the native reflection patterns; heights and tail are illustrative.
    const patterns = [
      [[.0297, .31, .5], [.0411, .47, .3]],
      [[.0297, .19, .38], [.0371, .31, .25], [.0437, .43, .17]],
      [[.0371, .34, .32], [.0531, .58, .24], [.0793, .95, .16]],
      [[.0297, .28, .28], [.0371, .29, .23], [.0411, .32, .19], [.0437, .35, .10]],
    ];
    const taps = (patterns[Math.round(readParam(p, ['earlyPattern'], 0))] ?? patterns[0]).map(([line, factor, gain]) => ({ time: predelay + line * size * factor * earlySize * 1000, gain }));
    const earlyEnd = Math.max(40, predelay + 20, ...taps.map(tap => tap.time + 10));
    const earlyX = (time: number) => 42 + time / earlyEnd * 250;
    const tailStart = predelay / 1000 + .0297 * size, tailEnd = Math.max(tailStart + .1, predelay / 1000 + decay);
    const tailX = (time: number) => 338 + (time - predelay / 1000) / (tailEnd - predelay / 1000) * 260;
    const tailPath = Array.from({ length: 81 }, (_, i) => { const time = tailStart + (tailEnd - tailStart) * i / 80; const amplitude = (1 - earlyMix) * Math.exp(-Math.log(1000) * (time - tailStart) / decay); return `${i ? 'L' : 'M'}${tailX(time)},${146 - amplitude * 100}`; }).join(' ');
    return <div className="fx-graph-panel"><svg viewBox="0 0 640 200" className="fx-graph fx-reverb-graph" role="img" aria-label={`混响近似示意：预延迟 ${predelay.toFixed(0)} 毫秒，衰减 ${decay.toFixed(2)} 秒，早反射与尾音使用不同时间尺度`}>
      <text x={42} y={23}>早期反射 · 毫秒</text><text x={338} y={23}>后期尾音 · 秒</text>
      <line className="fx-gridline" x1={42} x2={292} y1={146} y2={146} /><line className="fx-gridline" x1={338} x2={598} y1={146} y2={146} />
      <line x1={earlyX(predelay)} x2={earlyX(predelay)} y1={41} y2={146} stroke="#80bfc577" strokeDasharray="3 3" />
      <line x1={earlyX(0)} x2={earlyX(0)} y1={54} y2={146} stroke="#779eae" strokeWidth="2" />
      {taps.map((tap, index) => <line key={index} x1={earlyX(tap.time)} x2={earlyX(tap.time)} y1={146 - tap.gain * earlyMix * 185} y2={146} stroke="#e0b7f4" strokeWidth="3" />)}
      <path d={tailPath} fill="none" stroke="#82c2d0" strokeWidth="2" /><path d={`${tailPath} L${tailX(tailEnd)},146 L${tailX(tailStart)},146 Z`} fill="#82c2d01b" />
      <text x={42} y={168}>0</text><text x={292} y={168} textAnchor="end">{Math.round(earlyEnd)} ms</text>
      <text x={338} y={168}>{(predelay / 1000).toFixed(2)} s</text><text x={598} y={168} textAnchor="end">{tailEnd.toFixed(2)} s</text>
      <text x={42} y={187}>预延迟 {predelay.toFixed(0)} ms · 间距 {Math.round(earlySize * 100)}%</text><text x={338} y={187}>预延迟后衰减 {decay.toFixed(2)} s</text>
    </svg><div className="fx-graph-caption"><span>紫色：早反射</span><strong>近似示意 · 非实时测量</strong><span>蓝色：尾音包络</span></div></div>;
  }
  const sync = !!p.sync, noteOptions = getEffectDefinition('delay').parameters.find(parameter => parameter.key === 'noteL')?.options ?? [];
  const left = sync ? 60000 / tempoBpm * (DAW_DELAY_NOTE_BEATS[p.noteL ?? 8] ?? .75) : readParam(p, ['timeMs'], 375);
  const right = sync ? 60000 / tempoBpm * (DAW_DELAY_NOTE_BEATS[p.noteR ?? 9] ?? 1) : readParam(p, ['timeRightMs'], 500);
  const feedback = readParam(p, ['feedback'], 30), mix = readParam(p, ['mix'], 20), pingPong = !!p.pingPong;
  const events = delayEvents(left, right, feedback, mix, pingPong), maxTime = Math.max(1, ...events.map(event => event.time));
  const x = (time: number) => 58 + time / maxTime * 530;
  return <div className="fx-graph-panel"><svg viewBox="0 0 640 200" className="fx-graph" role="img" aria-label={`单声道脉冲延迟示意，左 ${Math.round(left)} 毫秒，右 ${Math.round(right)} 毫秒，反馈 ${feedback}%，混合 ${mix}%`}>
    <text x={58} y={22}>左 L</text><text x={58} y={91}>右 R</text>
    {[75, 144].map(y => <line key={y} className="fx-gridline" x1={58} x2={588} y1={y} y2={y} />)}
    {events.filter(event => event.amplitude > 0).map((event, index) => { const base = event.side === 'L' ? 75 : 144; return <line key={index} x1={x(event.time)} x2={x(event.time)} y1={base} y2={base - event.amplitude * 48} stroke={event.side === 'L' ? '#d9bcf7' : '#80c7cf'} strokeWidth="4" />; })}
    <text x={58} y={166}>0 ms</text><text x={588} y={166} textAnchor="end">{Math.round(maxTime)} ms</text>
    <text x={58} y={185}>{pingPong ? '乒乓：左 → 右交替' : '左右独立重复'} · 反馈 {feedback}% · 湿声 {mix}% / 干声 {100 - mix}%</text>
  </svg><div className="fx-graph-caption fx-graph-caption-wrap"><span>L {Math.round(left)} ms{sync ? ` · ${noteOptions[p.noteL ?? 8] ?? ''}` : ''}</span><span>R {Math.round(right)} ms{sync ? ` · ${noteOptions[p.noteR ?? 9] ?? ''}` : ''}</span><strong>单声道脉冲示意 · 非实时</strong></div><div className="fx-graph-note">首个回声按湿声混合；后续按反馈衰减。未绘制滤波、宽度和输出增益。</div></div>;
}
function SaturationGraph({ effect }: { effect: DawEffect }) {
  const p = effect.params, drive = readParam(p, ['driveDb'], 3), bias = readParam(p, ['bias'], 0), mix = readParam(p, ['mix'], 100), output = readParam(p, ['outputDb'], -3), mode = Math.round(readParam(p, ['mode'], 0));
  const values = Array.from({ length: 201 }, (_, i) => { const input = -1 + i / 100; return { input, output: saturationTransfer(input, drive, bias, mode, mix, output) }; });
  const limit = Math.max(1, ...values.map(point => Math.abs(point.output)));
  const x = (value: number) => 48 + (value + 1) * 272, y = (value: number) => 100 - value / limit * 77;
  const path = values.map((point, i) => `${i ? 'L' : 'M'}${x(point.input)},${y(point.output)}`).join(' ');
  return <div className="fx-graph-panel"><svg viewBox="0 0 640 205" className="fx-graph" role="img" aria-label="饱和器静态输入输出传递曲线">
    <line className="fx-gridline" x1={48} x2={592} y1={y(0)} y2={y(0)} /><line className="fx-gridline" x1={x(0)} x2={x(0)} y1={23} y2={177} />
    <path className="fx-diagonal" d={`M${x(-1)},${y(-1)}L${x(1)},${y(1)}`} /><path d={path} className="fx-curve" />
    <text x={48} y={195}>输入 −1</text><text x={592} y={195} textAnchor="end">输入 +1</text><text x={53} y={20}>输出 ±{limit.toFixed(2)}</text>
  </svg><div className="fx-graph-caption fx-graph-caption-wrap"><span>虚线：输入参考</span><strong>{['软饱和', 'Tanh', '硬削波'][mode] ?? '软饱和'} · 静态传递</strong><span>驱动 {drive} dB · 混合 {mix}%</span></div><div className="fx-graph-note">包含偏置、混合与输出增益；不显示音色滤波、直流滤波或过采样的时间效应。</div></div>;
}
function StereoGraph({ effect, readings }: { effect: DawEffect; readings?: EffectMeterReadings }) {
  const width = readParam(effect.params, ['width', 'widthPct'], 100), unit = effect.params.mono ? 0 : width / 100, balance = readParam(effect.params, ['balance', 'pan'], 0) / 100, correlation = readings?.correlation;
  return <div className="fx-graph-panel"><svg viewBox="0 0 640 205" className="fx-graph" role="img" aria-label={`立体声声场宽度${Math.round(unit * 100)}%`}><line className="fx-gridline" x1={100} x2={540} y1={165} y2={165} /><line className="fx-gridline" x1={320} x2={320} y1={25} y2={180} /><path d={`M${320 + balance * 120},165 L${320 - unit * 105 + balance * 120},60 Q${320 + balance * 120},${-5 + unit * 20} ${320 + unit * 105 + balance * 120},60 Z`} fill="#b78ddd17" stroke="#ad83d0" strokeWidth={1.5} /><path className="fx-diagonal" d="M320,165L215,60Q320,15 425,60Z" /><circle cx={320 + balance * 120} cy={165} r={5} fill="#c5a0ea" /><text x={80} y={185}>LEFT</text><text x={560} y={185} textAnchor="end">RIGHT</text><text x={320} y={195} textAnchor="middle">MID</text><text x={320} y={20} textAnchor="middle">声场宽度 {Math.round(unit * 100)}%</text></svg><div className="fx-graph-caption"><span>声场 · 参数示意</span><strong>相关度 {correlation === undefined ? '—' : clamp(correlation, -1, 1).toFixed(2)}</strong><span>{correlation === undefined ? '等待音频测量' : correlation < 0 ? '反相成分较多' : '同相成分较多'}</span></div></div>;
}
function DeesserGraph({ effect, readings, sampleRate }: { effect: DawEffect; readings?: EffectMeterReadings; sampleRate: number }) {
  const p = effect.params, freq = readParam(p, ['freqHz'], 6500), bandwidth = readParam(p, ['bandwidthOct'], 1), range = readParam(p, ['rangeDb'], 6), mix = readParam(p, ['mix'], 100), split = (p.mode ?? 1) > .5, listen = !!p.listen;
  const actual = deesserResponse(freq, freq, bandwidth, sampleRate), maxHz = Math.min(20000, sampleRate / 2);
  const y = (db: number) => 20 + (0 - clamp(db, -30, 0)) / 30 * 145;
  const points = Array.from({ length: 180 }, (_, i) => 20 * (maxHz / 20) ** (i / 179));
  const detector = points.map((frequency, i) => { const h = deesserResponse(frequency, freq, bandwidth, sampleRate); return `${i ? 'L' : 'M'}${graphX(frequency)},${y(20 * Math.log10(Math.max(1e-12, Math.hypot(h.re, h.im))))}`; }).join(' ');
  const limit = points.map((frequency, i) => `${i ? 'L' : 'M'}${graphX(frequency)},${y(deesserLimitDb(frequency, freq, bandwidth, sampleRate, range, mix, split))}`).join(' ');
  return <div className="fx-graph-panel"><svg viewBox="0 0 640 205" className="fx-graph" role="img" aria-label={`去齿音检测带通与最大抑制示意，中心 ${Math.round(actual.hz)} Hz`}>
    {[100, 1000, 5000, 10000, 20000].filter(f => f <= maxHz).map(f => <g key={f}><line className="fx-gridline" x1={graphX(f)} x2={graphX(f)} y1={20} y2={165} /><text x={graphX(f)} y={188} textAnchor="middle">{f >= 1000 ? `${f / 1000}k` : f}</text></g>)}
    {[0, -15, -30].map(db => <g key={db}><line className="fx-gridline" x1={40} x2={graphX(maxHz)} y1={y(db)} y2={y(db)} /><text x={34} y={y(db) + 3} textAnchor="end">{db}</text></g>)}
    <path d={detector} className="fx-curve" /><path d={limit} className="fx-deesser-limit" /><text x={42} y={12}>dB</text>
  </svg><div className="fx-graph-caption fx-graph-caption-wrap"><span>实线：检测带通 · {Math.round(actual.hz)} Hz · Q {actual.q.toFixed(2)}</span><span>虚线：{split ? '分频' : '宽带'}最大抑制</span><ReductionMeter value={readings?.reductionDb} /></div><div className="fx-graph-note">最大抑制是静态极限，实际衰减随信号和启动 / 释放变化。{listen ? '当前独听检测信号，不应用抑制输出。' : ''}</div></div>;
}
function MeterOverview({ effect, readings }: { effect: DawEffect; readings?: EffectMeterReadings }) {
  const view = effect.params.view ?? 0;
  const lufsText = (value?: number) => Number.isFinite(value) ? value!.toFixed(1) : '—';
  return <div className="fx-graph-panel">{view === 0 ? <svg viewBox="0 0 640 210" className="fx-graph" role="img" aria-label="实时频谱，等待信号时不显示频谱曲线">
    <defs><linearGradient id={`spectrum-fill-${effect.id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b995e4" stopOpacity=".45" /><stop offset="1" stopColor="#b995e4" stopOpacity=".02" /></linearGradient></defs>
    {[-72, -48, -24, 0].map(db => <g key={db}><line className="fx-gridline" x1={40} x2={622} y1={18 + -db / 90 * 160} y2={18 + -db / 90 * 160} /><text x={31} y={22 + -db / 90 * 160} textAnchor="end">{db}</text></g>)}
    {[20, 100, 1000, 10000, 20000].map(frequency => <g key={frequency}><line className="fx-gridline" x1={graphX(frequency)} x2={graphX(frequency)} y1={18} y2={178} /><text x={graphX(frequency)} y={199} textAnchor="middle">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text></g>)}
    {readings?.spectrum && readings.spectrum.length > 1 ? <path stroke="#c1a0e6" strokeWidth={1.5} fill={`url(#spectrum-fill-${effect.id})`} d={`M40,178 ${spectrumPoints(readings, db => 18 + (1 - clamp((db + 90) / 90, 0, 1)) * 160)} L622,178Z`} /> : <text x={320} y={101} textAnchor="middle">播放音频以查看频谱</text>}
  </svg> : view === 1 ? <><div className="fx-meter-overview"><div className="fx-meter-stat"><span>INTEGRATED</span><strong>{lufsText(readings?.integratedLufs)}</strong><small>LUFS · 综合响度</small></div><div className="fx-meter-stat"><span>SHORT TERM</span><strong>{lufsText(readings?.shortTermLufs)}</strong><small>LUFS · 短期响度</small></div><div className="fx-meter-stat"><span>TRUE PEAK</span><strong>{lufsText(readings?.truePeakDb)}</strong><small>dBTP · 真峰值</small></div></div><div className="fx-loudness-details"><span>瞬时 <strong>{lufsText(readings?.momentaryLufs)} LUFS</strong></span><span>响度范围 <strong>{lufsText(readings?.loudnessRange)} LU</strong></span><span>参考目标 <strong>{effect.params.targetLufs.toFixed(1)} LUFS</strong></span></div><div className="fx-loudness-target"><span>−36</span><div><i style={{ left: `${(effect.params.targetLufs + 36) / 31 * 100}%` }} title={`响度目标 ${effect.params.targetLufs} LUFS`} />{Number.isFinite(readings?.integratedLufs) && <b style={{ width: `${clamp((readings!.integratedLufs! + 36) / 31 * 100, 0, 100)}%` }} />}</div><span>−5 LUFS</span></div></> : <><div className="fx-meter-overview"><div className="fx-meter-stat"><span>PEAK</span><strong>{dbText(readings?.peakDb ?? readings?.outputDb)}</strong><small>dBFS · 峰值保持</small></div><div className="fx-meter-stat"><span>RMS</span><strong>{dbText(readings?.rmsDb ?? readings?.outputRmsDb)}</strong><small>dBFS · 400 ms 平均</small></div><div className="fx-meter-stat"><span>CORRELATION</span><strong>{readings?.correlation === undefined ? '—' : readings.correlation.toFixed(2)}</strong><small>−1 反相 · +1 同相</small></div></div><div className="fx-meter-full-bars"><LevelMeter label="L" value={readings?.leftDb ?? readings?.outputDb} /><LevelMeter label="R" value={readings?.rightDb ?? readings?.outputDb} /></div></>}
    <div className="fx-graph-caption"><span>{readings ? '音频引擎实时测量' : '播放音频后显示真实测量值'}</span><span>{view === 0 ? 'SPECTRUM · dBFS / Hz' : view === 1 ? 'LUFS / dBTP / LU' : 'PEAK / RMS / PHASE'}</span></div></div>;
}

function TransientOverview({ readings }: { readings?: EffectMeterReadings }) {
  const actual = readings?.transientGainDb;
  const position = clamp((actual ?? 0) / 18, -1, 1) * 50;
  return <div className="fx-graph-panel fx-diagram">
    <div className="fx-transient-panel">
      <div><span>实时塑形增益</span><strong>{actual === undefined ? '—' : `${actual > 0 ? '+' : ''}${actual.toFixed(1)} dB`}</strong></div>
      <div className="fx-transient-track" aria-hidden="true"><i /><b style={{ left: `${50 + Math.min(position, 0)}%`, width: `${Math.abs(position)}%` }} /></div>
      <div className="fx-transient-scale"><span>−18 dB</span><span>0</span><span>+18 dB</span></div>
    </div>
    <div className="fx-graph-caption"><span>{actual === undefined ? '播放音频以查看变化' : '增益随起音与延续变化'}</span><span>立体声联动</span></div>
  </div>;
}

const MULTIBAND_NAMES = ['低频', '中频', '高频'] as const;
function MultibandOverview({ effect, selected, setSelected, readings, sampleRate }: { effect: DawEffect; selected: number; setSelected: (band: number) => void; readings?: EffectMeterReadings; sampleRate: number }) {
  const low = effect.params.crossoverLowHz, high = Math.min(effect.params.crossoverHighHz, sampleRate * .475);
  const freq = (hz: number) => hz >= 1000 ? `${Math.round(hz / 100) / 10} kHz` : `${Math.round(hz)} Hz`;
  const ranges = [`≤ ${freq(low)}`, `${freq(low)} – ${freq(high)}`, `≥ ${freq(high)}`];
  return <div className="fx-graph-panel fx-diagram fx-multiband-panel">
    <div className="fx-multiband-bands" role="group" aria-label="选择压缩频段">{MULTIBAND_NAMES.map((name, index) => {
      const value = readings?.multibandReductionDb?.[index];
      const reduction = value !== undefined && Number.isFinite(value) ? Math.abs(value) : undefined;
      return <button type="button" key={name} className={`fx-multiband-band ${selected === index + 1 ? 'active' : ''}`} aria-pressed={selected === index + 1} onClick={() => setSelected(index + 1)}>
        <strong>{name}</strong><small>{ranges[index]}</small><span className="fx-multiband-meter" aria-hidden="true"><i style={{ width: `${clamp((reduction ?? 0) / 24 * 100, 0, 100)}%` }} /></span><span>增益衰减 {reduction === undefined ? '—' : `${reduction.toFixed(1)} dB`}</span>
      </button>;
    })}</div>
    <div className="fx-graph-note">干湿两路共用分频重组。分频会改变相位。</div>
  </div>;
}
function ConvolutionOverview({ effect, sampleRate }: { effect: DawEffect; sampleRate: number }) {
  const space = clamp(Math.round(effect.params.space), 0, 3);
  const lengths = ['0.45', '1.0', '1.45', '2.1'];
  const names = getEffectDefinition('convolution').parameters.find(parameter => parameter.key === 'space')?.options;
  let latencySamples = 128;
  while (latencySamples < sampleRate * 512 / 48000) latencySamples *= 2;
  return <div className="fx-graph-panel fx-diagram fx-convolution-panel"><div><span>内置合成脉冲响应</span><strong>{names?.[space]}</strong><small>脉冲响应长度 {lengths[space]} 秒</small></div><p>处理延迟 {(latencySamples * 1000 / sampleRate).toFixed(1)} ms，工程自动补偿。预延迟与滤波仅作用于混响声。</p></div>;
}

function CreativeOverview({ effect, readings }: { effect: DawEffect; readings?: EffectMeterReadings }) {
  if (effect.type === 'denoise') {
    const profile = effect.noiseProfile;
    const top = profile ? Math.min(40, Math.ceil((Math.max(...profile) + 5) / 10) * 10) : -20;
    const bottom = profile ? Math.max(-180, Math.min(top - 40, Math.floor((Math.min(...profile) - 5) / 10) * 10)) : -120;
    const x = (hz: number) => hz <= 20 ? 41 : 41 + Math.log(hz / 20) / Math.log(1200) * 570;
    const y = (db: number) => 13 + (top - db) / (top - bottom) * 78;
    const points = profile?.map((value, i) => `${x(i === 0 ? 0 : 23.4375 * 1024 ** ((i - 1) / 126))},${y(value)}`).join(' ');
    return <div className="fx-graph-panel"><svg className="fx-graph" viewBox="0 0 640 113" role="img" aria-label="已学习噪声频谱，频率横轴为对数刻度，纵轴单位为 dB">
      {[top, (top + bottom) / 2, bottom].map(db => <g key={db}><line className="fx-gridline" x1="41" x2="611" y1={y(db)} y2={y(db)} /><text x="6" y={y(db) + 3}>{db} dB</text></g>)}
      {[20, 100, 1000, 10000, 24000].map(hz => <g key={hz}><line className="fx-gridline" x1={x(hz)} x2={x(hz)} y1="13" y2="91" /><text x={x(hz)} y="105" textAnchor={hz === 24000 ? 'end' : hz === 20 ? 'start' : 'middle'}>{hz < 1000 ? `${hz} Hz` : `${hz / 1000} kHz`}</text></g>)}
      {points && <polyline className="fx-curve" points={points} />}
    </svg><div className="fx-graph-caption"><span>{profile ? '已学习噪声曲线' : '尚未学习噪声'}</span></div></div>;
  }
  const mode = effect.type === 'lofi' ? 'style' : 'mode';
  const parameter = effect.type === 'vst3' ? undefined : getEffectDefinition(effect.type).parameters.find(item => item.key === mode);
  const label = parameter?.options?.[(effect.params[mode] ?? 0) - (parameter?.min ?? 0)] ?? '';
  if (effect.type === 'modulation') {
    const depth = (effect.params.depth ?? 45) / 100;
    const offset = (effect.params.phaseDegrees ?? 90) / 360;
    const waveform = effect.params.mode === 3 ? effect.params.waveform : 0;
    const cycle = (phaseOffset: number) => Array.from({ length: 101 }, (_, index) => {
      const sine = Math.sin(2 * Math.PI * (index / 100 + phaseOffset));
      const wave = waveform === 1 ? Math.asin(sine) * 2 / Math.PI : waveform === 2 ? Math.tanh(3 * sine) / Math.tanh(3) : sine;
      return `${index * 4},${39 - depth * wave * 28}`;
    }).join(' ');
    return <div className="fx-graph-panel fx-creative-overview fx-modulation-overview">
      <div><strong>{label}</strong><small>一个调制周期 · 左／右声道</small></div>
      <svg className="fx-graph" role="img" aria-label="低频振荡器的左右声道波形" viewBox="0 0 400 78">
        <path d="M0 39H400" className="fx-gridline" />
        <polyline className="fx-curve" points={cycle(0)} /><polyline className="fx-curve fx-modulation-right" points={cycle(offset)} />
      </svg>
    </div>;
  }
  return <div className="fx-graph-panel fx-creative-overview"><strong>{label}</strong>{effect.type === 'pedal' && <small>输入 → 驱动 → 音色 → 箱体 → 输出</small>}</div>;
}

function NoiseSelectionWave({ preview, start, duration, onSelect }: { preview: NoiseSelectionPreview; start: number; duration: number; onSelect: (start: number, duration: number) => void }) {
  const anchor = useRef<number | null>(null);
  const span = preview.end - preview.start;
  const fraction = (time: number) => clamp((time - preview.start) / span, 0, 1);
  const select = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = preview.start + span * clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    if (anchor.current === null) return point;
    const length = clamp(Math.abs(point - anchor.current), .5, Math.min(3, span));
    onSelect(clamp(Math.min(point, anchor.current), preview.start, preview.end - length), length);
    return point;
  };
  const left = fraction(start), right = fraction(start + duration);
  const largest = Math.max(.002, ...preview.peaks);
  return <div className="fx-noise-wave"><svg viewBox="0 0 480 48" preserveAspectRatio="none" role="img" aria-label="底噪选区源波形，拖动选取区间，也可在下方输入时间"
    onPointerDown={event => { if (event.button !== 0) return; anchor.current = select(event); event.currentTarget.setPointerCapture(event.pointerId); select(event); }}
    onPointerMove={event => { if (anchor.current !== null) select(event); }}
    onPointerUp={() => { anchor.current = null; }} onPointerCancel={() => { anchor.current = null; }}>
    <rect x={left * 480} width={Math.max(0, right - left) * 480} y="0" height="48" className="fx-noise-selection" />
    <path d="M0 24H480" className="fx-noise-wave-baseline" />
    {preview.peaks.map((peak, i) => { const height = 21 * Math.sqrt(peak / largest), x = (i + .5) / preview.peaks.length * 480; return <line key={i} x1={x} x2={x} y1={24 - height} y2={24 + height} />; })}
  </svg><small>{preview.start.toFixed(2)} s</small><small>{preview.end.toFixed(2)} s</small></div>;
}

const matchReferenceKey = (reference: MatchReferenceId) => `${reference.kind}:${reference.id}`;

function MatchEqPanel({ input, onAnalyze, onAudition, onApply, onClear, strength, applied, strengthControl, sampleRate }: {
  input: MatchEqInput; onAnalyze: (source: string, reference: MatchReferenceId) => void; onAudition?: () => void;
  onApply: (params: Record<string, number>) => void; onClear: () => void;
  strength: number; applied: boolean; strengthControl: ReactNode; sampleRate: number;
}) {
  const [sourceChoice, setSource] = useState(input.result?.sourceTarget ?? input.owner.target);
  const [referenceChoice, setReference] = useState(() => input.result ? matchReferenceKey(input.result.reference) : '');
  const [external, setExternal] = useState<MatchEqReference>();
  const [dragging, setDragging] = useState(false), [importing, setImporting] = useState(false), [error, setError] = useState('');
  const [auditioning, setAuditioning] = useState(false);
  const uploader = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null), audio = useRef<HTMLAudioElement>(null);
  const source = input.sources.find(item => item.target === sourceChoice)?.target ?? input.owner.target;
  const references = input.references.filter(clip => clipEffectTarget(clip.id) !== source);
  if (external) references.push(external);
  const reference = references.find(item => matchReferenceKey(item) === referenceChoice);
  const assetId = reference?.assetId, start = reference?.start ?? 0, end = start + (reference?.duration ?? 0);
  const result = reference && input.result?.sourceTarget === source && matchReferenceKey(input.result.reference) === referenceChoice ? input.result : undefined;
  const suggested = result?.gains && Object.fromEntries(result.gains.map((gain, index) => [`matchGain${index + 1}`, gain]));
  const stopAtReferenceEnd = useCallback((player: HTMLAudioElement) => {
    if (player.currentTime < end) return;
    player.pause();
    if (player.currentTime > end + .001) player.currentTime = end;
  }, [end]);
  useEffect(() => () => uploader.current?.abort(), []);
  useEffect(() => { setAuditioning(false); }, [referenceChoice, assetId, start, end]);
  useEffect(() => {
    if (audio.current) audio.current.volume = Math.min(1, 10 ** ((input.monitorDb ?? 0) / 20));
  }, [input.monitorDb, referenceChoice, assetId, start, end]);
  useEffect(() => { if (input.transportPlaying) audio.current?.pause(); }, [input.transportPlaying]);
  useEffect(() => {
    const player = audio.current;
    if (!auditioning || !player) return;
    const timer = window.setInterval(() => stopAtReferenceEnd(player), 20);
    return () => window.clearInterval(timer);
  }, [auditioning, referenceChoice, assetId, start, stopAtReferenceEnd]);

  const stopAudition = () => { audio.current?.pause(); setAuditioning(false); };
  const selectReference = (choice: string) => {
    stopAudition(); uploader.current?.abort(); uploader.current = null;
    setImporting(false); setError(''); setReference(choice);
  };
  const importReference = async (file: File) => {
    stopAudition(); uploader.current?.abort();
    const controller = new AbortController(); uploader.current = controller;
    setImporting(true); setError('');
    try {
      const asset = await importDawAudio(file, controller.signal);
      if (!controller.signal.aborted) {
        const item: MatchEqReference = { kind: 'asset', id: asset.id, assetId: asset.id, name: asset.name, start: 0, duration: asset.duration };
        setExternal(item); setReference(matchReferenceKey(item));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取参考音频。');
    } finally {
      if (uploader.current === controller) { uploader.current = null; setImporting(false); }
    }
  };
  const dropReference = (event: ReactDragEvent) => {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    const transfer = event.dataTransfer;
    if (transfer.files.length) {
      if (transfer.files.length === 1) void importReference(transfer.files[0]);
      else setError('每次拖入一个参考音频文件。');
      return;
    }
    const plain = transfer.getData('text/plain'), prefix = `${MATCH_CLIP_MIME}:`;
    const payload = transfer.getData(MATCH_CLIP_MIME) || (plain.startsWith(prefix) ? plain.slice(prefix.length) : '');
    try {
      const data = JSON.parse(payload) as unknown;
      if (Array.isArray(data) && data[0] === input.sessionId) {
        const clip = references.find(item => item.kind === 'clip' && item.id === data[1]);
        if (clip) { selectReference(matchReferenceKey(clip)); return; }
      }
    } catch { /* Files and project clips are the supported drop targets. */ }
    setError('请拖入音频文件，或拖动本工程中另一个片段的音符图标。');
  };
  const audition = async () => {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) { stopAudition(); return; }
    setError('');
    if (player.currentTime < start || player.currentTime >= end - .005) player.currentTime = start;
    onAudition?.();
    try { await player.play(); }
    catch (cause) { if (player === audio.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError('无法试听参考音频，请检查素材是否可用。'); }
  };
  return <details className="fx-match-eq" onToggle={event => { if (!event.currentTarget.open) stopAudition(); }}>
    <summary>音色匹配 EQ {applied && <small>已应用 · {strength}%</small>}</summary>
    <p>比较最多 8 秒的原始音频，生成可叠加到当前 EQ 的建议曲线。</p>
    <label className="fx-match-source">待处理素材<select aria-label="待处理素材" value={source} disabled={!input.owner.hasAudio || !input.sources.length} onChange={event => setSource(event.target.value)}>
      <option value={input.owner.target}>{input.owner.name}{input.owner.hasAudio ? '（挂载位置）' : '（暂无音频）'}</option>
      {input.sources.map(choice => <option key={choice.target} value={choice.target}>{choice.name}</option>)}
    </select></label>
    <div className={`fx-match-drop${dragging ? ' is-dragging' : ''}`} aria-label="参考片段拖放区"
      onDragOver={event => {
        if (!event.dataTransfer.types.some(type => type === 'Files' || type === MATCH_CLIP_MIME || type === 'text/plain')) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragging(true);
      }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={dropReference}>
      <Upload size={15} /><span>{importing ? '正在读取参考音频…' : '拖入音频文件，或用片段的音符图标拖入'}</span>
      <button type="button" className="fx-button small" onClick={() => fileInput.current?.click()}>选择文件</button>
      <input type="file" hidden ref={fileInput} aria-label="选择参考音频文件" accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.aiff,.aif,.wma"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importReference(file); }} />
    </div>
    <div className="fx-noise-actions">
      <label>参考片段<select aria-label="参考片段" value={reference ? referenceChoice : ''} onChange={event => selectReference(event.target.value)}>
        <option value="">选择工程片段或拖入音频</option>
        {references.map(item => <option key={matchReferenceKey(item)} value={matchReferenceKey(item)}>{item.name}</option>)}
      </select></label>
      <button type="button" className="fx-button small" disabled={!reference || importing} aria-pressed={auditioning} onClick={() => void audition()}><Headphones size={12} />{auditioning ? '暂停参考' : '试听参考'}</button>
      <button type="button" className="fx-button small" disabled={!input.owner.hasAudio || !reference || importing || !!result?.pending}
        onClick={() => { if (reference) { setError(''); onAnalyze(source, { id: reference.id, kind: reference.kind }); } }}>{result?.pending ? '分析中…' : '分析音色'}</button>
    </div>
    {assetId && <audio key={`${referenceChoice}:${assetId}:${start}:${end}`} ref={audio} hidden preload="metadata"
      src={`/api/daw/assets/${encodeURIComponent(assetId)}#t=${start.toFixed(6)},${end.toFixed(6)}`}
      onPlaying={() => setAuditioning(true)} onPause={() => setAuditioning(false)} onEnded={() => setAuditioning(false)}
      onTimeUpdate={event => stopAtReferenceEnd(event.currentTarget)} />}
    {error && <p role="alert">{error}</p>}
    {result?.message && <p role="status">{result.message}</p>}
    {suggested && <div className="fx-match-preview">
      <span>建议曲线 · 60% 强度</span>
      <svg className="fx-graph" viewBox="0 0 640 220" role="img" aria-label="建议频率响应曲线">
        {[-12, -6, 0, 6, 12].map(gain => <g key={gain}><line className="fx-gridline" x1={GRAPH.left} x2={GRAPH.width - GRAPH.right} y1={eqGraphY(gain, 12)} y2={eqGraphY(gain, 12)} /><text x="7" y={eqGraphY(gain, 12) + 3}>{gain} dB</text></g>)}
        <path className="fx-curve" d={eqCurve({ ...suggested, matchStrength: 60 }, sampleRate, Math.min(20000, sampleRate * .475), 12)} />
        {EQ_MATCH_FREQUENCIES.filter(frequency => frequency < sampleRate * .475).map(frequency => <text key={frequency} x={graphX(frequency)} y="211" textAnchor="middle">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text>)}
      </svg>
      <button type="button" className="fx-button small" onClick={() => onApply({ ...suggested, matchStrength: 60 })}>应用匹配曲线</button>
    </div>}
    {applied && <div className="fx-match-current"><div className="fx-controls">{strengthControl}</div><button type="button" className="fx-button small" onClick={onClear}>清除匹配</button></div>}
  </details>;
}

const DENOISE_CONTROLS = {
  spectralEnabled: ['reductionDb', 'sensitivity', 'transient', 'smoothing', 'lowHz', 'highHz'],
  humEnabled: ['humFrequency', 'humHarmonics', 'humStrength', 'humQ'],
  dereverbEnabled: ['reverbReductionDb', 'reverbDecayMs', 'reverbProtect'],
};

export function EffectEditor({ effect, ownerName = '效果链', sidechainTracks = [], onChange, onBeginGesture, onCommitGesture, onUndo, onRedo, canUndo = false, canRedo = false, readings, sampleRate = 48000, tempoBpm = 120, onResetMeters, onClose, comparison, onToggleComparison, onLearnNoise, noiseLearning = false, noiseLearnStart = 0, noiseLearnEnd, noiseLearnMessage, noisePreview, onListenNoise, listeningNoise = false, matchEq, onAnalyzeMatch, onAuditionMatch }: EffectEditorProps) {
  if (effect.type === 'vst3') throw new Error('VST3 应使用通用参数编辑器');
  const builtInType = effect.type;
  const definition = getEffectDefinition(builtInType);
  const initialBand = effect.type === 'multiband' ? 2 : effect.type === 'eq' && !effect.params.band3Enabled
    ? EQ_BANDS.find(band => effect.params[`band${band}Enabled`]) ?? 3 : 3;
  const initialBandRef = useRef(initialBand); initialBandRef.current = initialBand;
  const [selection, setSelection] = useState(() => ({ id: effect.id, type: effect.type, band: initialBand }));
  const band = selection.id === effect.id && selection.type === effect.type ? selection.band : initialBand;
  const setBand = (next: number) => setSelection({ id: effect.id, type: effect.type, band: next });
  const [advanced, setAdvanced] = useState(false), [savingPreset, setSavingPreset] = useState(false), [presetName, setPresetName] = useState('');
  const [userPresets, setUserPresets] = useStoredList(DAW_PRESETS_KEY, isDawUserPreset);
  const [learnStart, setLearnStart] = useState(String(Math.max(0, noiseLearnStart)));
  const [learnDuration, setLearnDuration] = useState(String(Math.max(.5, Math.min(1, (noiseLearnEnd ?? 1) - noiseLearnStart))));
  useEffect(() => { setLearnStart(String(Math.max(0, noiseLearnStart))); }, [effect.id, noiseLearnStart]);
  const current = useRef(effect); current.current = effect;
  const gesture = useRef(false);
  const commitGestureRef = useRef(onCommitGesture); commitGestureRef.current = onCommitGesture;
  const begin = () => { if (!gesture.current) { gesture.current = true; onBeginGesture?.(); } };
  const commit = useCallback(() => { if (gesture.current) { gesture.current = false; commitGestureRef.current?.(); } }, []);
  const changeHistory = (action: 'undo' | 'redo') => { commit(); (action === 'undo' ? onUndo : onRedo)?.(); };
  useEffect(() => {
    window.addEventListener('blur', commit);
    return () => { window.removeEventListener('blur', commit); commit(); };
  }, [effect.id, commit]);
  useEffect(() => { setSelection({ id: effect.id, type: effect.type, band: initialBandRef.current }); setAdvanced(false); setSavingPreset(false); }, [effect.id, effect.type]);
  const emit = (next: DawEffect) => { current.current = next; onChange(next); };
  const atomic = (next: DawEffect) => { begin(); emit(next); commit(); };
  const changeParams = (patch: Record<string, number>) => { const before = current.current; emit({ ...before, params: { ...before.params, ...patch }, presetId: undefined }); };
  const atomicParams = (patch: Record<string, number>) => { begin(); changeParams(patch); commit(); };
  const presets = userPresets.filter(item => item.type === effect.type);
  const duckMode = effect.type === 'ducker' ? effect.params.mode ?? 0 : 0;
  const repair = effect.type === 'denoise' ? denoiseModes(effect.params) : undefined;
  const control = (parameter: DawEffectParameter, override?: number) => {
    let display = parameter;
    if (effect.type === 'limiter' && parameter.key === 'ceilingDb') display = { ...parameter, unit: effect.params.truePeak === 1 ? 'dBTP' : 'dBFS' };
    if (duckMode > 0 && parameter.key === 'depthDb') display = { ...parameter, label: '最大衰减', description: '允许的最大衰减量。' };
    if (duckMode > 0 && effect.params.smoothTrigger === 1 && parameter.key === 'thresholdDb') display = { ...parameter, unit: 'dBFS RMS' };
    return <ParameterControl key={parameter.key} parameter={display} value={override ?? effect.params[parameter.key] ?? parameter.default}
      onChange={value => changeParams({ [parameter.key]: value })} begin={begin} commit={commit} atomic={value => atomicParams({ [parameter.key]: value })} />;
  };
  const prefix = `band${band}`;
  const bandType = effect.params[`${prefix}Type`] ?? 0;
  const supportsDynamics = effect.type === 'eq' && eqSupportsDynamics(bandType);
  const dynamicsOn = supportsDynamics && effect.params[`${prefix}Dyn`] === 1;
  const bandReduction = readings?.bandReductionDb?.[band - 1];
  const dynamicStatus = !dynamicsOn ? '只在超过阈值时衰减'
    : !effect.enabled ? '效果已旁路' : !effect.params[`${prefix}Enabled`] ? '频段未启用'
      : effect.params.soloBand ? '独听不应用衰减' : bandReduction === undefined ? '播放后显示实际衰减'
        : `当前衰减 ${bandReduction.toFixed(1)} dB`;
  const isBandParam = (parameter: DawEffectParameter, ...suffixes: string[]) => suffixes.some(suffix => parameter.key === `${prefix}${suffix}`);
  const parameters = definition.parameters;
  const isPrimary = (parameter: DawEffectParameter) => !parameter.advanced || duckMode === 2 && parameter.key === 'bandHz';
  const modeKeys: Record<string, string[][]> = { modulation: [['delayMs', 'phaseDegrees'], ['flangeMs', 'feedback'], ['stages', 'centerHz', 'feedback'], ['waveform', 'phaseDegrees'], ['vibratoMs']], lofi: [['tone', 'saturation', 'wow', 'flutter'], ['tone', 'noiseDb', 'crackle'], ['bits', 'rateHz', 'smooth'], ['lowCutHz', 'highCutHz', 'mono', 'noiseDb', 'saturation']] };
  const visible = (parameter: DawEffectParameter) => {
    if (effect.type === 'modulation') { if (parameter.key === 'rateHz') return !effect.params.sync; if (parameter.key === 'note') return !!effect.params.sync; return ['mode', 'depth', 'mix', 'sync'].includes(parameter.key) || (modeKeys.modulation[effect.params.mode] ?? []).includes(parameter.key); }
    if (effect.type === 'lofi') return ['style', 'amount', 'mix'].includes(parameter.key) || (modeKeys.lofi[effect.params.style] ?? []).includes(parameter.key);
    if (effect.type === 'ducker') {
      if (parameter.key === 'marginDb' || parameter.key === 'smoothTrigger') return duckMode > 0;
      if (parameter.key === 'bandHz' || parameter.key === 'bandQ') return duckMode === 2;
    }
    if (repair) return false;
    return true;
  };
  const learnAt = Number(learnStart), learnLength = Number(learnDuration);
  const canLearn = effect.enabled && repair?.spectralEnabled && !!onLearnNoise && !noiseLearning && !!learnStart.trim() &&
    Number.isFinite(learnAt) && learnAt >= (noisePreview?.lowerBound ?? 0) && Number.isFinite(learnLength) && learnLength >= .5 && learnLength <= 3 &&
    (noiseLearnEnd === undefined || learnAt + learnLength <= noiseLearnEnd + .5 / sampleRate);
  const basic = effect.type === 'eq' ? parameters.filter(parameter => isBandParam(parameter, 'Freq', 'Gain', 'Q', 'Type', 'Enabled') || parameter.key === 'outputDb') : effect.type === 'multiband' ? parameters.filter(parameter => isBandParam(parameter, 'ThresholdDb', 'Ratio', 'AttackMs', 'ReleaseMs', 'MakeupDb')) : parameters.filter(parameter => isPrimary(parameter) && visible(parameter));
  const dynamic = supportsDynamics ? parameters.filter(parameter => isBandParam(parameter, 'Dyn') || (dynamicsOn && isBandParam(parameter, 'Threshold', 'Range'))) : [];
  const extra = effect.type === 'eq' ? parameters.filter(parameter => (bandType === 3 || bandType === 4) && isBandParam(parameter, 'Slope') || dynamicsOn && isBandParam(parameter, 'Attack', 'Release') || parameter.key === 'inputDb' || parameter.key === 'soloBand') : effect.type === 'multiband' ? [] : parameters.filter(parameter => !isPrimary(parameter) && visible(parameter));
  const abSlot = effect.abSlot ?? 'A';
  const switchAB = (slot: 'A' | 'B') => { if (slot === abSlot) return; const before = current.current; atomic({ ...before, params: { ...getEffectDefaultParams(builtInType), ...(before.bState ?? before.params) }, bState: { ...before.params }, noiseProfile: before.bState ? before.bNoiseProfile : before.noiseProfile, bNoiseProfile: before.noiseProfile, sidechainTrackId: before.bState ? before.bSidechainTrackId : before.sidechainTrackId, bSidechainTrackId: before.sidechainTrackId, abSlot: slot, presetId: undefined }); };
  const applyPreset = (presetId: string) => { if (!presetId) return; const preset = [...definition.presets, ...presets].find(item => item.id === presetId); if (preset) atomic({ ...current.current, params: { ...getEffectDefaultParams(builtInType), ...preset.params }, presetId: preset.id.startsWith('user-') ? undefined : preset.id }); };
  const savePreset = () => { const name = presetName.trim().slice(0, 80); if (!name) return; setUserPresets([...userPresets, createDawUserPreset(current.current, name)]); setSavingPreset(false); setPresetName(''); };
  const currentPreset = [...definition.presets, ...presets].find(preset => {
    if (repair && DENOISE_SWITCHES.some(key => repair[key] !== denoiseModes(preset.params)[key])) return false;
    return parameters.every(({ key, default: fallback }) => (repair && (key === 'repairMode' || DENOISE_SWITCHES.some(switchKey => switchKey === key))) ||
      (effect.params[key] ?? fallback) === (preset.params[key] ?? fallback));
  });
  return <section className="fx-surface fx-editor" aria-label={`${definition.name}效果编辑器`} data-effect-type={effect.type} onKeyDown={event => {
    const action = dawHistoryShortcut(event.nativeEvent);
    if (!action || !(action === 'undo' ? onUndo : onRedo)) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) changeHistory(action);
  }}>
    <header className="fx-editor-head"><div className="fx-effect-icon" style={{ color: definition.color }}><EffectIcon type={effect.type} size={23} /></div><div className="fx-editor-title"><h2>{getEffectDisplayName(effect)}</h2><small>{ownerName} <span aria-hidden="true">/</span> {definition.subtitle}</small></div><span className="fx-tag">BUILT-IN</span><button type="button" aria-pressed={!effect.enabled} className={`fx-button fx-bypass ${effect.enabled ? '' : 'is-bypassed'}`} onClick={() => atomic({ ...current.current, enabled: !effect.enabled })}><Power size={12} />{effect.enabled ? '已启用' : '已旁路'}</button>{onClose && <IconButton title="关闭效果窗口" onClick={onClose}><X size={17} /></IconButton>}</header>
    <div className="fx-editor-toolbar"><label className="fx-preset"><span className="fx-screen-reader">效果预设</span><SlidersHorizontal size={13} /><select aria-label="效果预设" value={currentPreset?.id ?? ''} onChange={event => applyPreset(event.target.value)}><option value="">{effect.presetId ? '已修改 · Custom' : '自定义 · Custom'}</option><optgroup label="出厂预设">{definition.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup>{presets.length > 0 && <optgroup label="我的预设">{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup>}</select><IconButton title="保存为我的预设" active={savingPreset} onClick={() => setSavingPreset(!savingPreset)}><Save size={13} /></IconButton></label>
      <div className="fx-toolbar-divider" /><div className="fx-segments" role="group" aria-label="A/B 比较"><button type="button" aria-pressed={abSlot === 'A'} className={abSlot === 'A' ? 'active' : ''} onClick={() => switchAB('A')}>A</button><button type="button" aria-pressed={abSlot === 'B'} className={abSlot === 'B' ? 'active' : ''} onClick={() => switchAB('B')}>B</button></div><IconButton title={`复制 ${abSlot} 到 ${abSlot === 'A' ? 'B' : 'A'}`} onClick={() => atomic(copyActiveEffectSlot(current.current))}><GitCompareArrows size={14} /></IconButton>
      {effect.type !== 'meter' && onToggleComparison && <button type="button" aria-pressed={!!comparison} disabled={!effect.enabled || !effect.bState} className={`fx-button small fx-ab-match ${comparison ? 'is-active' : ''}`} title={effect.bState ? '测量游标附近最多 5 秒，补偿仅用于监听' : '先切换 A/B 或复制设置，准备两组参数'} onClick={onToggleComparison}><Headphones size={12} />{comparison?.status === 'measuring' ? '测量中 · 点击取消' : '等响度 A/B'}</button>}
      <div className="fx-toolbar-divider" /><IconButton title="撤销效果编辑" onClick={() => changeHistory('undo')} disabled={!canUndo || !onUndo}><Undo2 size={14} /></IconButton><IconButton title="重做效果编辑" onClick={() => changeHistory('redo')} disabled={!canRedo || !onRedo}><Redo2 size={14} /></IconButton><IconButton title="重置当前效果参数" onClick={() => atomic({ ...current.current, params: getEffectDefaultParams(builtInType), presetId: undefined })}><RotateCcw size={13} /></IconButton>{effect.type === 'meter' && onResetMeters && <button type="button" className="fx-button small subtle" onClick={onResetMeters}><RotateCcw size={11} />重置计量</button>}<span className="fx-editor-brand">VISIKI AUDIO</span>
    </div>
    {savingPreset && <form className="fx-preset-save" onSubmit={event => { event.preventDefault(); savePreset(); }}><input autoFocus value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="输入预设名称…" maxLength={80} aria-label="我的预设名称" /><button type="submit" className="fx-button small" disabled={!presetName.trim()}><Check size={12} />保存</button>{currentPreset?.id.startsWith('user-') && <button type="button" className="fx-button subtle small fx-preset-delete" onClick={() => { setUserPresets(userPresets.filter(preset => preset.id !== currentPreset.id)); setSavingPreset(false); }}><Trash2 size={12} />删除当前预设</button>}<IconButton title="取消保存预设" onClick={() => setSavingPreset(false)}><X size={13} /></IconButton></form>}
    {!effect.enabled && <div className="fx-bypass-banner">当前效果已旁路，声音将直接通过。参数仍可编辑。</div>}
    {comparison?.status === 'ready' && <div className="fx-ab-result" role="status"><span>A {comparison.aLufs?.toFixed(1)} LUFS · B {comparison.bLufs?.toFixed(1)} LUFS</span><span>当前监听 {comparison.trimDb?.toFixed(1)} dB · {comparison.start?.toFixed(1)}–{comparison.end?.toFixed(1)} 秒</span></div>}
    <div className="fx-editor-scroll">
      {effect.type === 'eq' && matchEq && onAnalyzeMatch && <MatchEqPanel key={`${matchEq.sessionId}:${effect.id}`} input={matchEq} onAnalyze={onAnalyzeMatch} onAudition={onAuditionMatch} onApply={atomicParams}
        onClear={() => atomicParams(Object.fromEntries(parameters.filter(parameter => parameter.key.startsWith('match')).map(parameter => [parameter.key, 0])))}
        strength={effect.params.matchStrength ?? 0} applied={!!effect.params.matchStrength || EQ_MATCH_FREQUENCIES.some((_, index) => !!effect.params[`matchGain${index + 1}`])}
        strengthControl={parameters.filter(parameter => parameter.key === 'matchStrength').map(parameter => control(parameter))} sampleRate={sampleRate} />}
      {!repair && <><div className="fx-visual-heading"><span>{effect.type === 'ducker' ? '触发与衰减' : effect.type === 'modulation' || effect.type === 'lofi' || effect.type === 'pedal' ? '当前音色' : effect.type === 'eq' ? '频率响应' : effect.type === 'multiband' ? '频段与增益衰减' : effect.type === 'convolution' ? '卷积空间' : effect.type === 'meter' ? '电平与相位' : effect.type === 'reverb' ? '空间衰减' : effect.type === 'delay' ? '重复与反馈' : effect.type === 'stereo' ? '立体声声场' : effect.type === 'saturation' ? '谐波塑形' : effect.type === 'deesser' ? '齿音检测' : effect.type === 'transient' ? '起音与延续' : '动态传递曲线'}</span><small>{effect.type === 'eq' ? '拖动节点 · ← → 频率 · ↑ ↓ 增益' : effect.type === 'transient' || effect.type === 'multiband' || effect.type === 'ducker' ? '音频引擎实时测量' : effect.type === 'modulation' || effect.type === 'lofi' || effect.type === 'pedal' ? '当前参数' : effect.type === 'convolution' ? 'IR' : '由当前参数计算'}</small></div>
      {effect.type === 'ducker' ? <div className="fx-ducker-panel">
        <label>触发音轨<select aria-label="触发音轨" value={effect.sidechainTrackId ?? ''} onChange={event => atomic({ ...current.current, sidechainTrackId: event.target.value || undefined })}>
          <option value="">未选择触发音轨</option>
          {effect.sidechainTrackId && !sidechainTracks.some(track => track.id === effect.sidechainTrackId) && <option value={effect.sidechainTrackId}>触发音轨不可用</option>}
          {sidechainTracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}
        </select></label>
        {duckMode === 2 ? <p>比较两路在 {effect.params.bandHz ?? 1800} Hz 附近的电平，只降低当前声音在这个频段的增益。</p> : duckMode === 1 ? <p>动态比较人声和伴奏的短时电平，目标让触发音轨领先 {effect.params.marginDb ?? 3} dB。比较计入两路音量推子，触发信号取自触发轨的效果之前。</p> : <p>在触发轨的效果和推子之前检测电平。触发随当前试听的静音与独奏状态变化。</p>}
        <div className="fx-graph-caption fx-graph-caption-wrap">{duckMode > 0 ? <><span>触发{duckMode === 2 ? '频带' : '音轨'} {readings?.duckerKeyDb === undefined ? '—' : `${dbText(readings.duckerKeyDb)} dBFS`}</span><span>当前{duckMode === 2 ? '频带' : '声音'} {readings?.duckerProgramDb === undefined ? '—' : `${dbText(readings.duckerProgramDb)} dBFS`}</span></> : <span>触发电平 {readings?.sidechainInputDb === undefined ? '—' : `${dbText(readings.sidechainInputDb)} dBFS`}</span>}<ReductionMeter value={readings?.reductionDb} /></div>
      </div> : ['modulation', 'lofi', 'pedal'].includes(effect.type) ? <CreativeOverview effect={effect} readings={readings} /> : effect.type === 'multiband' ? <MultibandOverview effect={effect} selected={band} setSelected={setBand} readings={readings} sampleRate={sampleRate} /> : effect.type === 'convolution' ? <ConvolutionOverview effect={effect} sampleRate={sampleRate} /> : effect.type === 'eq' ? <EqGraph effect={effect} selected={band} setSelected={setBand} change={changeParams} begin={begin} commit={commit} readings={readings} sampleRate={sampleRate} /> : ['compressor', 'gate', 'limiter'].includes(effect.type) ? <DynamicsGraph effect={effect} readings={readings} /> : ['reverb', 'delay'].includes(effect.type) ? <SpaceGraph effect={effect} tempoBpm={clamp(tempoBpm, 20, 300)} /> : effect.type === 'saturation' ? <SaturationGraph effect={effect} /> : effect.type === 'stereo' ? <StereoGraph effect={effect} readings={readings} /> : effect.type === 'deesser' ? <DeesserGraph effect={effect} readings={readings} sampleRate={sampleRate} /> : effect.type === 'transient' ? <TransientOverview readings={readings} /> : <MeterOverview effect={effect} readings={readings} />}</>}
      {repair && <div className="fx-repair">
        <div className="fx-controls fx-repair-switches">{DENOISE_SWITCHES.map(key => control(parameters.find(parameter => parameter.key === key)!, Number(repair[key])))}</div>
        <div className="fx-repair-output">
          <div className="fx-controls">{parameters.filter(parameter => parameter.key === 'mix').map(parameter => control(parameter))}</div>
          <button type="button" className="fx-button small" disabled={!onListenNoise || !canAuditionDenoise(effect)} aria-pressed={listeningNoise} onClick={onListenNoise}>{listeningNoise ? '停止试听移除声' : '试听移除声'}</button>
        </div>
        {DENOISE_SWITCHES.filter(key => repair[key]).map(key => <section className="fx-repair-stage" key={key}>
          <h3>{parameters.find(parameter => parameter.key === key)?.label}</h3>
          {key === 'spectralEnabled' && <><CreativeOverview effect={effect} readings={readings} /><div className="fx-noise-learn">
        <p>选取 0.5–3 秒纯底噪。可拖动波形选区或输入工程时间。</p>
        {noisePreview && <NoiseSelectionWave preview={noisePreview} start={learnAt} duration={learnLength} onSelect={(start, length) => {
          setLearnStart(String(Math.floor(start * 1e6) / 1e6)); setLearnDuration(String(Math.floor(length * 1e6) / 1e6));
        }} />}
        <div className="fx-noise-actions"><label>开始（秒）<input aria-label="底噪开始时间（秒）" type="number" min="0" step="0.001" value={learnStart} onChange={event => setLearnStart(event.target.value)} /></label><label>时长（秒）<input aria-label="底噪时长（秒）" type="number" min="0.5" max="3" step="0.001" value={learnDuration} onChange={event => setLearnDuration(event.target.value)} /></label>
          <button type="button" className="fx-button small" disabled={!canLearn} onClick={() => onLearnNoise?.(learnAt, learnLength)}>{noiseLearning ? '学习中…' : effect.noiseProfile ? '重新学习' : '学习噪声'}</button>
          <button type="button" className="fx-button small" disabled={!effect.noiseProfile || noiseLearning} onClick={() => { const { noiseProfile: _profile, ...next } = current.current; atomic(next); }}>清除曲线</button></div>
        {noiseLearnMessage && <p role="status">{noiseLearnMessage}</p>}
          </div></>}
          <div className="fx-controls">{parameters.filter(parameter => DENOISE_CONTROLS[key].includes(parameter.key)).map(parameter => control(parameter))}</div>
        </section>)}
      </div>}
      {effect.type === 'multiband' && <><div className="fx-eq-band-heading"><span>分频与输出</span></div><div className="fx-controls fx-multiband-global">{parameters.filter(parameter => !parameter.group).map(parameter => control(parameter))}</div><div className="fx-eq-band-heading"><span>{MULTIBAND_NAMES[band - 1]}压缩</span></div></>}
      {effect.type === 'eq' && <div className="fx-eq-band-heading"><span role="status" aria-live="polite">频段 {band} <small className="fx-muted">/ 8 · {effect.params[`band${band}Enabled`] ? '已启用' : '未启用'}</small></span><span className="fx-tag">双击滑块恢复默认</span></div>}
      {!!basic.length && <div className="fx-controls">{basic.map(parameter => control(parameter))}</div>}
      {dynamic.length > 0 && <div className="fx-eq-dynamics"><div className="fx-eq-band-heading"><strong>动态 EQ</strong><span className="fx-muted">{dynamicStatus}</span></div><div className="fx-controls">{dynamic.map(parameter => control(parameter))}</div></div>}
      {extra.length > 0 && <><div className="fx-section-divider" /><button type="button" className="fx-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><span><SlidersHorizontal size={12} />高级参数 <small>{extra.length} 项</small></span>{advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{advanced && <div className="fx-controls fx-advanced-controls">{extra.map(parameter => control(parameter))}</div>}</>}
      <div className="fx-editor-shortcuts"><span>双击滑块：默认值</span><span>数值框：精确输入</span><span>A / B：比较两组设置</span></div>
    </div><footer className="fx-editor-foot"><LevelMeter label="IN" value={readings?.inputDb} /><LevelMeter label="OUT" value={readings?.outputDb} /><span className={`fx-meter-source ${readings ? 'active' : ''}`}><i />{readings ? '实时音频' : '等待音频'}</span></footer>
  </section>;
}
