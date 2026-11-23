import { useEffect, useRef, useState } from 'react';
import { AudioLines, LoaderCircle, Play } from 'lucide-react';
import { sessionDuration, type DawSession } from './model';
import { analyzeDawAutoMix, applyAutoMixPlan, countAutoMixBypassedEffects, defaultAutoMixOptions, isBalanceChange, previewDawAutoMix, type AutoMixChange, type AutoMixOptions, type AutoMixPlan, type AutoMixRange } from './auto-mix';
import { describeEnabledEqBands, formatEffectParameter, getAutoMixEffectName, getEffectDefinition, type DawEffectType } from './effects';
import './auto-mix.css';

type Variant = 'original' | 'balance' | 'full';
type Preview = { url: string; integrated: number | null; truePeak: number | null };
type Handoff = AutoMixRange & { enabled: boolean };
const variants: { id: Variant; label: string }[] = [{ id: 'original', label: '原工程' }, { id: 'balance', label: '仅平衡' }, { id: 'full', label: '平衡＋效果链' }];
const fmt = (value: number | null | undefined, unit: string) => value != null && Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : '未测得';
const numberOk = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const previewParameters: Partial<Record<DawEffectType, string[]>> = {
  denoise: ['reductionDb', 'mix'], modulation: ['mode', 'rateHz', 'depth', 'mix'], stereo: ['width', 'balance'],
  gate: ['thresholdDb', 'rangeDb', 'ratio'], compressor: ['thresholdDb', 'ratio'],
  deesser: ['freqHz', 'thresholdDb', 'rangeDb'], delay: ['timeMs', 'timeRightMs', 'mix'], reverb: ['decaySec', 'mix'],
  ducker: ['mode', 'thresholdDb', 'bandHz', 'depthDb'], limiter: ['ceilingDb'], meter: ['targetLufs'],
};

function effectSummary(change: AutoMixChange, session: DawSession): string {
  if (change.kind !== 'effect') return '';
  const { params, type } = change;
  if (type === 'eq') {
    return describeEnabledEqBands(params).map(({ band, filter, details }) => `B${band} ${filter} · ${details}`).join(' / ');
  }
  const visible = previewParameters[type] ?? [];
  const definition = getEffectDefinition(type);
  const result = visible.flatMap(key => {
    const parameter = definition.parameters.find(item => item.key === key);
    if (!parameter || params[key] === undefined) return [];
    const unit = key === 'thresholdDb' ? (type === 'ducker' && params.smoothTrigger ? 'dBFS RMS' : 'dBFS') : key === 'ceilingDb' ? 'dBTP' : '';
    if (key === 'depthDb' && type === 'ducker') return [`最大衰减 ${formatEffectParameter(parameter, params[key])}`];
    return [`${parameter.label} ${unit ? fmt(params[key], unit) : formatEffectParameter(parameter, params[key])}`];
  });
  if (type === 'denoise') result.push(change.noiseProfile ? '已学习底噪' : '等待底噪样本');
  if (type === 'ducker' && change.sidechainTrackId) {
    const key = session.tracks.find(track => track.id === change.sidechainTrackId);
    if (key) result.push(`触发轨 ${key.name}`);
  }
  return result.join(' · ');
}

/** Suggestions and audition renders stay outside the document until the user applies them. */
export function DawAutoMixDialog({ session, onApply, onPauseTransport, onClose, monitorDb = 0 }: {
  session: DawSession; onApply: (next: DawSession) => void; onPauseTransport: () => void; onClose: () => void; monitorDb?: number;
}) {
  const [snapshot] = useState(session);
  const [options, setOptions] = useState<AutoMixOptions>(() => defaultAutoMixOptions(session));
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [handoffsEdited, setHandoffsEdited] = useState(false);
  const [plan, setPlan] = useState<AutoMixPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [needsRecalculation, setNeedsRecalculation] = useState(false);
  const [busy, setBusy] = useState<'analysis' | 'preview' | null>(null);
  const [error, setError] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [customRange, setCustomRange] = useState<AutoMixRange>({ start: 0, end: Math.min(20, sessionDuration(session)) });
  const [variant, setVariant] = useState<Variant>('original');
  const [matchLoudness, setMatchLoudness] = useState(true);
  const [previews, setPreviews] = useState<Partial<Record<Variant, Preview>>>({});
  const audio = useRef<HTMLAudioElement>(null);
  const playback = useRef<{ time: number; playing: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const previewRefs = useRef<Partial<Record<Variant, Preview>>>({});
  const duration = sessionDuration(snapshot);
  const bypassCount = countAutoMixBypassedEffects(snapshot);
  const delivery = options.delivery ?? { mode: 'preserve' as const, ceilingDb: -1, targetLufs: -14 };
  const validDelivery = numberOk(delivery.ceilingDb, -12, 0) && numberOk(delivery.targetLufs, -36, -8);
  const { lead, harmony, backing } = options.roles;
  const roleIds = harmony ? [lead, harmony, backing] : [lead, backing];
  const validTracks = snapshot.tracks.filter(track => !track.muted && track.clips.length);
  const rolesValid = roleIds.every(id => validTracks.some(track => track.id === id)) && new Set(roleIds).size === roleIds.length;
  const editHandoffs = !!harmony && options.harmony === 'mixed';
  const rangesValid = !editHandoffs || handoffs.every(range => !range.enabled || (numberOk(range.start, 0, duration) && numberOk(range.end, 0, duration) && range.end - range.start >= .02));
  const section = plan?.sections.find(item => item.id === sectionId);
  const range = sectionId === 'custom' ? customRange
    : section ? { start: section.start, end: Math.min(duration, section.end, section.start + 20) } : undefined;
  const rangeValid = !!range && numberOk(range.start, 0, duration) && numberOk(range.end, 0, duration) &&
    range.end - range.start >= .02 && range.end - range.start <= 20 + 1e-6;

  const clearPreviews = () => {
    audio.current?.pause(); playback.current = null;
    Object.values(previewRefs.current).forEach(item => { if (item) URL.revokeObjectURL(item.url); });
    previewRefs.current = {}; setPreviews({});
  };
  const cancel = () => { sequence.current++; controller.current?.abort(); controller.current = null; setBusy(null); };
  const invalidate = () => { cancel(); clearPreviews(); setPlan(null); setSelected(new Set()); setNeedsRecalculation(false); setError(''); };
  useEffect(() => () => {
    sequence.current++; controller.current?.abort(); audio.current?.pause();
    Object.values(previewRefs.current).forEach(item => { if (item) URL.revokeObjectURL(item.url); });
  }, []);
  const update = (patch: Partial<AutoMixOptions>) => { invalidate(); setOptions(previous => ({ ...previous, ...patch })); };
  const resetHandoffs = () => { setHandoffs([]); setHandoffsEdited(false); };
  const updateRole = (role: keyof AutoMixOptions['roles'], id: string) => {
    update({ roles: { ...options.roles, [role]: id } });
    if (role === 'harmony') resetHandoffs();
  };
  const updateHandoffs = (next: Handoff[]) => { invalidate(); setHandoffs(next); setHandoffsEdited(true); };
  const analyze = async () => {
    if (!rolesValid || !rangesValid || !validDelivery || busy) return;
    clearPreviews(); setError('');
    const excluded = plan ? plan.changes.filter(change => !selected.has(change.id)).map(change => change.id) : [];
    const request = new AbortController(); controller.current = request; const id = ++sequence.current;
    setBusy('analysis');
    try {
      const next = await analyzeDawAutoMix(snapshot, { ...options, delivery, excludedChangeIds: excluded,
        ...(editHandoffs && (handoffs.length || handoffsEdited) ?
          { handoffs: handoffs.filter(item => item.enabled).map(({ start, end }) => ({ start, end })) } : {}) }, request.signal);
      if (id !== sequence.current || request.signal.aborted) return;
      setPlan(next); setSelected(new Set(next.changes.filter(change => !excluded.includes(change.id)).map(change => change.id))); setNeedsRecalculation(false);
      setSectionId(previous => previous === 'custom' || next.sections.some(item => item.id === previous)
        ? previous : next.sections[0]?.id ?? 'custom');
      if (editHandoffs && !handoffs.length && !handoffsEdited) {
        setHandoffs(next.handoffs.map(item => ({ ...item, enabled: true })));
      }
    } catch (cause) { if (id === sequence.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : '分析失败，请重试'); }
    finally { if (id === sequence.current) { controller.current = null; setBusy(null); } }
  };
  const toggleChange = (id: string, checked: boolean) => {
    cancel(); clearPreviews(); setNeedsRecalculation(true); setSelected(previous => { const next = new Set(previous); checked ? next.add(id) : next.delete(id); return next; });
  };
  const renderPreviews = async () => {
    if (!plan || !range || !rangeValid || busy || needsRecalculation) return;
    onPauseTransport(); clearPreviews(); setError('');
    const request = new AbortController(); controller.current = request; const id = ++sequence.current; setBusy('preview');
    const balanceIds = new Set(plan.changes.filter(change => selected.has(change.id) && isBalanceChange(change)).map(change => change.id));
    const documents = { original: snapshot, balance: applyAutoMixPlan(snapshot, plan, balanceIds), full: applyAutoMixPlan(snapshot, plan, selected) };
    const next: Partial<Record<Variant, Preview>> = {};
    try {
      for (const item of variants) {
        const rendered = await previewDawAutoMix(documents[item.id], range, request.signal);
        if (id !== sequence.current || request.signal.aborted) return;
        const preview = { url: URL.createObjectURL(rendered.blob), integrated: rendered.integrated, truePeak: rendered.truePeak };
        next[item.id] = preview; previewRefs.current = { ...next }; setPreviews({ ...next });
      }
    } catch (cause) { if (id === sequence.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : '试听渲染失败，请重试'); }
    finally { if (id === sequence.current) { controller.current = null; setBusy(null); } }
  };
  const levels = Object.values(previews).map(item => item?.integrated).filter((value): value is number => value != null && Number.isFinite(value));
  const currentPreview = previews[variant];
  const attenuation = matchLoudness && levels.length === 3 && currentPreview?.integrated != null && Number.isFinite(currentPreview.integrated) ? Math.min(0, Math.min(...levels) - currentPreview.integrated) : 0;
  const volume = Math.max(0, Math.min(1, 10 ** ((Math.min(0, monitorDb) + attenuation) / 20)));
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume, currentPreview]);
  const apply = (balanceOnly: boolean) => {
    if (!plan || busy || needsRecalculation) return;
    const ids = new Set(plan.changes.filter(change => selected.has(change.id) && (!balanceOnly || isBalanceChange(change))).map(change => change.id));
    if (ids.size || bypassCount) { onPauseTransport(); onApply(applyAutoMixPlan(snapshot, plan, ids)); }
  };
  const editRange = (patch: Partial<AutoMixRange>) => {
    cancel(); clearPreviews(); setCustomRange(previous => ({ ...previous, ...patch }));
  };
  return <div className="daw-auto-mix">
    <div className="daw-auto-mix-section">
      <h3>确认音轨</h3>
      <div className="daw-auto-mix-grid">
        {([{ key: 'lead', label: '主唱' }, { key: 'harmony', label: '和声（可选）' }, { key: 'backing', label: '伴奏' }] as const).map(role =>
          <label className="daw-auto-mix-field" key={role.key}>{role.label}
            <select value={options.roles[role.key] ?? ''} onChange={event => updateRole(role.key, event.target.value)}>
              <option value="">{role.key === 'harmony' ? '无和声' : '选择音轨'}</option>
              {validTracks.map(track => <option value={track.id} key={track.id}>{track.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {!rolesValid && <p className="daw-auto-mix-warning">请选择不同的主唱和伴奏音轨。若选择和声，请指定另一条音轨。所选音轨需含音频且未静音。</p>}
    </div>
    {bypassCount > 0 && <p className="daw-auto-mix-bypass">
      当前有 {bypassCount} 个轨道或主输出效果处于启用状态。新方案的分析和试听会旁路这些效果，应用时保留实例和参数。
    </p>}

    <div className="daw-auto-mix-section">
      <h3>混音方向</h3>
      <div className="daw-auto-mix-grid">
        {harmony && <label className="daw-auto-mix-field">和声用途
          <select value={options.harmony} onChange={event => {
            update({ harmony: event.target.value as AutoMixOptions['harmony'] });
            resetHandoffs();
          }}>
            <option value="support">衬托主唱</option>
            <option value="duet">接唱／对唱</option>
            <option value="mixed">混合 · 按段确认接唱</option>
          </select>
        </label>}
        <label className="daw-auto-mix-field">人声位置
          <select value={options.direction} onChange={event => update({ direction: event.target.value as AutoMixOptions['direction'] })}>
            <option value="natural">自然均衡</option>
            <option value="forward">主唱靠前</option>
            <option value="blended">人声融入</option>
          </select>
        </label>
        <label className="daw-auto-mix-field">曲风
          <select value={options.genre} onChange={event => update({ genre: event.target.value as AutoMixOptions['genre'] })}>
            <option value="none">不指定</option>
            <option value="pop">流行</option>
            <option value="rock">摇滚</option>
            <option value="acoustic">抒情／原声</option>
          </select>
        </label>
        <label className="daw-auto-mix-field">人声空间
          <select value={options.space} onChange={event => update({ space: event.target.value as AutoMixOptions['space'] })}>
            <option value="unchanged">保持原样</option><option value="room">短房间</option><option value="plate">轻板式</option>
          </select>
        </label>
        <label className="daw-auto-mix-field">空间强度（%）
          <input type="number" min="0" max="100" value={options.spaceAmount} disabled={options.space === 'unchanged'}
            onChange={event => update({ spaceAmount: Math.max(0, Math.min(100, Number(event.target.value))) })} />
        </label>
      </div>
      {editHandoffs && <div className="daw-auto-mix-handoffs">
        <div className="daw-auto-mix-inline">
          <span className="daw-auto-mix-hint">接唱区间可在分析后确认，也可手动添加。</span>
          <button className="daw-btn small" disabled={handoffs.length >= 64}
            onClick={() => updateHandoffs([...handoffs, { start: 0, end: Math.min(5, duration), enabled: true }])}>添加区间</button>
        </div>
        <div className="daw-auto-mix-ranges">{handoffs.map((item, index) => {
          const editHandoff = (patch: Partial<Handoff>) => updateHandoffs(handoffs.map((range, i) => i === index ? { ...range, ...patch } : range));
          return <div className="daw-auto-mix-range" key={index}>
            <input type="checkbox" aria-label={`接受接唱区间 ${index + 1}`} checked={item.enabled} onChange={event => editHandoff({ enabled: event.target.checked })} />
            <input type="number" aria-label={`接唱 ${index + 1} 起点`} min="0" max={duration} step="0.1" value={item.start} onChange={event => editHandoff({ start: Number(event.target.value) })} />
            —
            <input type="number" aria-label={`接唱 ${index + 1} 终点`} min="0" max={duration} step="0.1" value={item.end} onChange={event => editHandoff({ end: Number(event.target.value) })} />
            <span>秒</span>
            <button className="daw-btn small ghost" onClick={() => updateHandoffs(handoffs.filter((_, i) => i !== index))}>移除</button>
          </div>;
        })}</div>
        {!rangesValid && <p className="daw-auto-mix-warning">接唱区间须位于工程内，至少持续 0.02 秒。</p>}
      </div>}
    </div>

    <details className="daw-auto-mix-section">
      <summary>交付设置</summary>
      <div className="daw-auto-mix-grid">
        <label className="daw-auto-mix-field">成品电平
          <select value={delivery.mode} onChange={event => update({ delivery: { ...delivery, mode: event.target.value as typeof delivery.mode } })}>
            <option value="preserve">保留混音动态</option>
            <option value="peak">仅设真峰值上限</option>
            <option value="custom">自定义响度与真峰值</option>
          </select>
        </label>
        {delivery.mode !== 'preserve' && <label className="daw-auto-mix-field">峰值上限（dBTP）
          <input type="number" min="-12" max="0" step="0.1" value={delivery.ceilingDb}
            onChange={event => update({ delivery: { ...delivery, ceilingDb: Number(event.target.value) } })} />
        </label>}
        {delivery.mode === 'custom' && <label className="daw-auto-mix-field">目标响度（LUFS）
          <input type="number" min="-36" max="-8" step="0.1" value={delivery.targetLufs}
            onChange={event => update({ delivery: { ...delivery, targetLufs: Number(event.target.value) } })} />
        </label>}
      </div>
      {!validDelivery && <p className="daw-auto-mix-warning">峰值上限可设为 −12 至 0 dBTP，目标响度可设为 −36 至 −8 LUFS。</p>}
    </details>

    <div className="daw-auto-mix-inline">
      <button className="daw-btn primary" disabled={!rolesValid || !rangesValid || !validDelivery || !!busy} onClick={() => void analyze()}>
        <AudioLines size={13} />{plan ? (needsRecalculation ? '重新计算参数' : '重新分析') : '开始分析'}
      </button>
      {busy && <>
        <span role="status" className="daw-auto-mix-busy"><LoaderCircle size={14} className="spin" />{busy === 'analysis' ? '正在分析' : '正在渲染试听'}</span>
        <button className="daw-btn small ghost" onClick={cancel}>取消{busy === 'analysis' ? '分析' : '试听'}</button>
      </>}
    </div>
    {error && <p role="alert" className="daw-auto-mix-warning">{error}</p>}

    {plan && <>
      <div className="daw-auto-mix-section">
        <h3>建议变更</h3>
        {needsRecalculation && <p className="daw-auto-mix-warning">勾选已更改，请先重新计算参数，再试听或应用。</p>}
        <div className="daw-auto-mix-result">
          {plan.changes.map(change => {
            const name = change.kind === 'fader' ? change.label : getAutoMixEffectName(change.kind === 'effect' ? change.type : 'outputGain');
            const targetName = change.target === 'master' ? '主输出' : snapshot.tracks.find(track => track.id === change.target)?.name;
            return <label className="daw-auto-mix-row" key={change.id}>
              <input type="checkbox" checked={selected.has(change.id)} onChange={event => toggleChange(change.id, event.target.checked)} />
              <div>
                <strong>{name}{'deltaDb' in change ? ` · ${change.deltaDb > 0 ? '+' : ''}${change.deltaDb.toFixed(1)} dB` : ''}</strong>
                {change.kind !== 'fader' && targetName && <small>应用到 {targetName}</small>}
                {change.kind === 'effect' && <small className="daw-auto-mix-effect-values">{effectSummary(change, snapshot)}</small>}
                <small>{change.reason}</small>
              </div>
            </label>;
          })}
          {!plan.changes.length && <span className="daw-auto-mix-hint">未发现需要调整的项目。</span>}
        </div>
        {plan.notes.map((note, index) => <p className="daw-auto-mix-hint" key={index}>{note}</p>)}
        <div className="daw-auto-mix-quality">
          <span><b>原工程</b>{fmt(plan.output.integrated, 'LUFS')} · {fmt(plan.output.truePeak, 'dBTP')}</span>
          {plan.proposedOutput && <span><b>所选建议</b>{fmt(plan.proposedOutput.integrated, 'LUFS')} · {fmt(plan.proposedOutput.truePeak, 'dBTP')}
            {plan.proposedOutput.limitingDb != null && ` · 最大限幅约 ${plan.proposedOutput.limitingDb.toFixed(1)} dB`}
          </span>}
        </div>
      </div>

      <div className="daw-auto-mix-section daw-auto-mix-preview">
        <h3>分段试听</h3>
        <div className="daw-auto-mix-inline">
          <label className="daw-auto-mix-field">试听段落
            <select value={sectionId} onChange={event => { cancel(); clearPreviews(); setSectionId(event.target.value); }}>
              {plan.sections.map(item => <option key={item.id} value={item.id}>{item.label} · {item.start.toFixed(1)}–{Math.min(item.end, item.start + 20, duration).toFixed(1)} 秒</option>)}
              <option value="custom">自定义区间</option>
            </select>
          </label>
          {sectionId === 'custom' && <>
            <label className="daw-auto-mix-field daw-auto-mix-time">起点（秒）<input type="number" min="0" max={duration} step=".1" value={customRange.start} onChange={event => editRange({ start: Number(event.target.value) })} /></label>
            <label className="daw-auto-mix-field daw-auto-mix-time">终点（秒）<input type="number" min="0" max={duration} step=".1" value={customRange.end} onChange={event => editRange({ end: Number(event.target.value) })} /></label>
          </>}
          <button className="daw-btn" disabled={!rangeValid || !!busy || needsRecalculation} onClick={() => void renderPreviews()}><Play size={13} />生成试听</button>
          <label className="daw-auto-mix-check"><input type="checkbox" checked={matchLoudness} onChange={event => setMatchLoudness(event.target.checked)} />响度匹配</label>
        </div>
        <div className="daw-auto-mix-options">
          {variants.map(item => <button key={item.id} className={`daw-btn small${variant === item.id ? ' active' : ''}`}
            aria-pressed={variant === item.id} disabled={!previews[item.id] || !!busy} onClick={() => {
              if (variant === item.id) return;
              if (audio.current) {
                playback.current = { time: audio.current.currentTime, playing: !audio.current.paused };
                audio.current.pause();
              }
              setVariant(item.id);
            }}>{item.label}</button>)}
        </div>
        {currentPreview && <audio key={currentPreview.url} ref={audio} controls src={currentPreview.url} preload="metadata" onLoadedMetadata={event => {
          const pending = playback.current; playback.current = null;
          if (!pending) return;
          event.currentTarget.currentTime = Math.min(pending.time, event.currentTarget.duration || pending.time);
          if (pending.playing) void event.currentTarget.play().catch(() => {});
        }} />}
        <span className="daw-auto-mix-hint">同一段落最多试听 20 秒。{matchLoudness && levels.length === 3 ? '试听响度匹配已启用。' : ''}</span>
      </div>
    </>}

    <div className="daw-modal-actions">
      <button className="daw-btn" onClick={onClose}>关闭</button>
      <button className="daw-btn" disabled={!plan || !!busy || needsRecalculation || (!bypassCount && !plan.changes.some(change => selected.has(change.id) && isBalanceChange(change)))} onClick={() => apply(true)}>仅应用平衡</button>
      <button className="daw-btn primary" disabled={!plan || !!busy || needsRecalculation || (!selected.size && !bypassCount)} onClick={() => apply(false)}>应用所选建议</button>
    </div>
  </div>;
}
