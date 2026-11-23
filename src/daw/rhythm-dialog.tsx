import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DawAsset, DawClip, DawMusicalGrid } from './model';
import { analyzeDawAudioRhythm, type DawRhythmResult } from './services';
import './rhythm-dialog.css';

type AnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'unknown' | 'cancelled' | 'error';
const MAX_SECONDS = 90;
const MIN_SECONDS = 6;
const scoreLabel = (score: number) => score >= .7 ? '较高' : score >= .45 ? '一般' : '较低';
const roundBpm = (bpm: number) => Math.round(bpm * 10) / 10;

/** Suggestions are deliberately kept outside session history until Apply. */
export function DawRhythmDialog({ assets, selectedClip, currentGrid, onApply, onClose }: {
  assets: DawAsset[];
  selectedClip?: DawClip;
  currentGrid: DawMusicalGrid;
  onApply: (patch: Partial<DawMusicalGrid>) => void;
  onClose: () => void;
}) {
  const initialAsset = assets.find(asset => asset.id === selectedClip?.assetId) ?? assets[0];
  const useInitialClip = !!selectedClip && selectedClip.assetId === initialAsset?.id && selectedClip.duration >= MIN_SECONDS;
  const [assetId, setAssetId] = useState(initialAsset?.id ?? '');
  const [clipOnly, setClipOnly] = useState(useInitialClip);
  const [start, setStart] = useState(String(useInitialClip ? selectedClip!.sourceIn : 0));
  const [seconds, setSeconds] = useState(String(Math.min(MAX_SECONDS, useInitialClip ? selectedClip!.duration : initialAsset?.duration ?? 0)));
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [result, setResult] = useState<DawRhythmResult | null>(null);
  const [error, setError] = useState('');
  const [bpm, setBpm] = useState('');
  const [applyMeter, setApplyMeter] = useState(false);
  const [meter, setMeter] = useState('4/4');
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const asset = assets.find(item => item.id === assetId);
  const matchingClip = selectedClip?.assetId === assetId ? selectedClip : undefined;
  const lowerBound = clipOnly && matchingClip ? matchingClip.sourceIn : 0;
  const upperBound = Math.min(asset?.duration ?? 0, clipOnly && matchingClip ? matchingClip.sourceIn + matchingClip.duration : Infinity);
  const rangeValid = !!asset && !!start.trim() && !!seconds.trim() && Number.isFinite(Number(start)) && Number.isFinite(Number(seconds))
    && Number(start) >= lowerBound && Number(seconds) >= MIN_SECONDS && Number(seconds) <= MAX_SECONDS && Number(start) + Number(seconds) <= upperBound + 1e-5;
  const running = status === 'analyzing';
  const validBpm = !!bpm.trim() && Number.isFinite(Number(bpm)) && Number(bpm) >= 20 && Number(bpm) <= 300;
  const canApply = status === 'ready' && result?.bpm != null && validBpm;

  const reset = useCallback(() => {
    sequence.current++; request.current?.abort(); request.current = null;
    setStatus('idle'); setResult(null); setError(''); setBpm(''); setApplyMeter(false);
  }, []);
  const analyze = useCallback(async () => {
    if (!rangeValid) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const id = ++sequence.current;
    setStatus('analyzing'); setResult(null); setError(''); setBpm(''); setApplyMeter(false);
    try {
      const next = await analyzeDawAudioRhythm({ assetId, start: Number(start), duration: Number(seconds) }, controller.signal);
      if (id !== sequence.current || controller.signal.aborted) return;
      setResult(next); setStatus(next.bpm == null ? 'unknown' : 'ready');
      setBpm(next.bpm == null ? '' : String(roundBpm(next.bpm)));
      setMeter(next.meter ? `${next.meter.beatsPerBar}/${next.meter.beatUnit}` : '4/4');
      setApplyMeter(!!next.meter && next.meter.confidence >= .65);
    } catch (cause) {
      if (id !== sequence.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : '分析失败，请重试'); setStatus('error');
    } finally { if (id === sequence.current) request.current = null; }
  }, [assetId, start, seconds, rangeValid]);
  const initialAnalysis = useRef(analyze);
  useEffect(() => {
    // One request even under React StrictMode's mount / cleanup replay.
    const frame = requestAnimationFrame(() => void initialAnalysis.current());
    return () => { cancelAnimationFrame(frame); sequence.current++; request.current?.abort(); };
  }, []);
  const changeTempo = (value: string) => {
    setBpm(value);
    if (result?.bpm == null || Math.abs(Number(value) - roundBpm(result.bpm)) > .05) setApplyMeter(false);
  };

  return <div className="daw-rhythm" data-daw-rhythm-status={status} data-daw-rhythm-bpm={result?.bpm ?? undefined}>
    <p className="daw-rhythm-intro">从音频估计速度与拍号，确认后应用到工程网格。</p>
    <div className="daw-rhythm-source">
      <label className="daw-rhythm-asset"><span>音频素材</span><select aria-label="分析素材" value={assetId} onChange={event => {
        reset(); const next = assets.find(item => item.id === event.target.value);
        setAssetId(event.target.value); setClipOnly(false); setStart('0'); setSeconds(String(Math.min(MAX_SECONDS, next?.duration ?? 0)));
      }}>{assets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {matchingClip && <label className="daw-rhythm-check"><input type="checkbox" checked={clipOnly} onChange={event => {
        reset(); setClipOnly(event.target.checked); setStart(String(event.target.checked ? matchingClip.sourceIn : 0));
        setSeconds(String(Math.min(MAX_SECONDS, event.target.checked ? matchingClip.duration : asset?.duration ?? 0)));
      }} />仅分析所选片段</label>}
      <div className="daw-rhythm-range"><label>起点 / 秒<input type="number" aria-label="分析起点 / 秒" min={lowerBound} max={upperBound} step="0.01" value={start} onChange={event => { reset(); setStart(event.target.value); }} /></label>
        <label>时长 / 秒<input type="number" aria-label="分析时长 / 秒" min={MIN_SECONDS} max={Math.min(MAX_SECONDS, Math.max(0, upperBound - Number(start)))} step="0.01" value={seconds} onChange={event => { reset(); setSeconds(event.target.value); }} /></label>
        <button className="daw-btn" disabled={!rangeValid || running} onClick={() => void analyze()}>{running ? <RefreshCw size={13} /> : <AudioLines size={13} />}{result ? '重新分析' : '开始分析'}</button></div>
      <small className="daw-rhythm-hint">本地快速分析 · 每次 6–90 秒。可选节奏清晰的段落，避开长前奏。</small>
      {!rangeValid && <p className="daw-rhythm-warning">请选择素材范围内至少 6 秒、至多 90 秒的音频。</p>}
    </div>
    <div className={`daw-rhythm-result${running ? ' analyzing' : ''}`} aria-live="polite" aria-busy={running}>
      {running ? <div className="daw-rhythm-pending"><LoaderCircle size={23} className="spin" /><div><strong>正在分析节奏</strong><small>提取瞬态、匹配节拍与重音规律…</small></div><button className="daw-btn small ghost" onClick={() => { reset(); setStatus('cancelled'); }}>取消分析</button></div>
        : status === 'error' ? <p className="daw-rhythm-warning" role="alert">{error}</p>
          : result ? <>
            <div className="daw-rhythm-cards"><div className="daw-rhythm-tempo"><span className="daw-rhythm-eyebrow">速度 · BPM</span>
              {result.bpm == null ? <strong className="daw-rhythm-unavailable">未检测到稳定节拍</strong> : <><div className="daw-rhythm-bpm"><input type="number" aria-label="分析 BPM" min="20" max="300" step="0.1" value={bpm} onChange={event => changeTempo(event.target.value)} /><div><button aria-label="BPM 减半" title="半速" disabled={!validBpm || Number(bpm) / 2 < 20} onClick={() => changeTempo(String(roundBpm(Number(bpm) / 2)))}>÷ 2</button><button aria-label="BPM 加倍" title="倍速" disabled={!validBpm || Number(bpm) * 2 > 300} onClick={() => changeTempo(String(roundBpm(Number(bpm) * 2)))}>× 2</button></div></div><small>节奏清晰度：{scoreLabel(result.confidence)}</small></>}
            </div><div className="daw-rhythm-meter"><span className="daw-rhythm-eyebrow">拍号建议</span><strong>{result.meter ? `${result.meter.beatsPerBar}/${result.meter.beatUnit}` : '暂不能可靠判断'}</strong><small>{result.meter ? `重音规律：${scoreLabel(result.meter.confidence)}` : '弱拍、切分与复合拍可能产生歧义'}</small></div></div>
            {result.tempoCandidates.length > 1 && <div className="daw-rhythm-candidates"><span>速度候选</span>{result.tempoCandidates.slice(0, 4).map((candidate, index) => <button key={index} className={`daw-btn small${Math.abs(Number(bpm) - roundBpm(candidate.bpm)) < .05 ? ' active' : ' ghost'}`} onClick={() => changeTempo(String(roundBpm(candidate.bpm)))}>{roundBpm(candidate.bpm)}</button>)}</div>}
            <div className="daw-rhythm-meter-choice"><label className="daw-rhythm-check"><input type="checkbox" checked={applyMeter} disabled={!result.meter} onChange={event => setApplyMeter(event.target.checked)} />应用拍号建议</label><select aria-label="分析拍号" disabled={!result.meter || !applyMeter} value={meter} onChange={event => setMeter(event.target.value)}>{['2/4', '3/4', '4/4', '6/8'].map(item => <option key={item} value={item}>{item}</option>)}</select><small>当前 {currentGrid.beatsPerBar}/{currentGrid.beatUnit}</small></div>
            <div className="daw-rhythm-footnote"><span>已分析 {result.analyzedSeconds.toFixed(1)} 秒{result.cached ? ' · 已使用缓存' : ''}</span><span>拍号为估计值，请结合试听确认。</span></div>
            {!!result.warnings.length && <ul className="daw-rhythm-warnings">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          </> : <p className="daw-rhythm-empty">{status === 'cancelled' ? '已取消分析，可调整范围后重新开始。' : '选择音频与范围，开始分析节奏。'}</p>}
    </div>
    <p className="daw-note">结果是单一速度参考，变速或自由速度音乐请手动确认。应用后切换为小节标尺，只更新 BPM 与勾选的拍号；片段位置与长度保持不变，可一次撤销。</p>
    <div className="daw-modal-actions"><button className="daw-btn" onClick={onClose}>关闭</button><button className="daw-btn primary" disabled={!canApply || running} onClick={() => {
      if (!canApply) return;
      const [beatsPerBar, beatUnit] = meter.split('/').map(Number);
      onApply({ bpm: roundBpm(Number(bpm)), ...(applyMeter && result?.meter ? { beatsPerBar, beatUnit } : {}) });
    }}>应用到工程</button></div>
  </div>;
}
