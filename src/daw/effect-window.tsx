import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, LoaderCircle, Play, X } from 'lucide-react';
import { EffectEditor } from './effects-view';
import { EFFECT_WINDOW_PROTOCOL, effectWindowChannel } from './effect-window-bridge';
import type { EffectWindowMessage, EffectWindowSnapshot } from './effect-window-bridge';
import { getEffectDisplayName, type DawEffect } from './effects';
import { dawHistoryShortcut } from './history-shortcuts';

/** Standalone route: this view never creates a session, transport or audio engine. */
export function DawEffectWindow() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get('owner') ?? '', target = params.get('target') ?? '', id = params.get('effect') ?? '';
  const [client] = useState(() => globalThis.crypto.randomUUID());
  const [snapshot, setSnapshot] = useState<EffectWindowSnapshot | null>(null), [error, setError] = useState('');
  const channel = useRef<BroadcastChannel | null>(null), connected = useRef(false), gesture = useRef(false);
  const post = (kind: EffectWindowMessage['kind'], payload?: Pick<EffectWindowMessage, 'effect' | 'noiseRange' | 'matchClips'>) => { try { channel.current?.postMessage({ protocol: EFFECT_WINDOW_PROTOCOL, kind, target, id, client, ...payload } satisfies EffectWindowMessage); } catch { /* Parent may close before this child. */ } };
  const commit = () => { if (gesture.current) { gesture.current = false; post('commit'); } };
  const changeHistory = (action: 'undo' | 'redo') => { commit(); post(action); };
  const close = () => { commit(); post('closed'); window.close(); };
  useEffect(() => {
    document.title = 'Visiki · 音频效果';
    if (!owner || !target || !id || typeof BroadcastChannel === 'undefined') { setError('缺少效果连接信息，请从主窗口的效果链重新打开。'); return; }
    const connection = new BroadcastChannel(effectWindowChannel(owner)); channel.current = connection;
    connection.onmessage = event => {
      const message = event.data as EffectWindowMessage;
      if (!message || message.protocol !== EFFECT_WINDOW_PROTOCOL || message.target !== target || message.id !== id || message.client && message.client !== client) return;
      if (message.kind === 'snapshot' && message.snapshot) { connected.current = true; setSnapshot(message.snapshot); setError(''); document.title = `${getEffectDisplayName(message.snapshot.effect)} · ${message.snapshot.ownerName} · Visiki`; }
      else if (message.kind === 'meters') setSnapshot(previous => previous ? { ...previous, readings: message.readings } : previous);
      else if (message.kind === 'error') setError(message.error ?? '效果连接出错');
      else if (message.kind === 'close') { commit(); window.close(); setError('此效果或主窗口已关闭。'); setSnapshot(null); }
    };
    post('ready');
    const retry = window.setInterval(() => { if (!connected.current) post('ready'); }, 1500);
    const timeout = window.setTimeout(() => { if (!connected.current) setError('正在等待主窗口连接。请保持混音工程窗口打开。'); }, 7000);
    const unload = () => { commit(); post('closed'); };
    const keydown = (event: KeyboardEvent) => {
      if (!connected.current) return;
      const action = dawHistoryShortcut(event);
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) changeHistory(action);
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('beforeunload', unload);
    return () => { unload(); window.clearInterval(retry); window.clearTimeout(timeout); window.removeEventListener('keydown', keydown); window.removeEventListener('beforeunload', unload); connection.close(); channel.current = null; };
  }, [owner, target, id, client]);
  return <main className="fx-surface fx-window" onKeyDown={event => {
    if (event.code !== 'Space' || !snapshot?.transportAvailable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    const node = event.target;
    if (node instanceof HTMLElement) {
      if (node.isContentEditable || node.closest('textarea,[role="textbox"]')) return;
      const input = node.closest('input');
      if (input && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden'].includes(input.type)) return;
    }
    event.preventDefault();
    if (!event.repeat) post('transport');
  }}>
    {error && <div className="fx-window-error" role="alert"><AlertCircle size={14} /><span>{error}</span><button type="button" className="fx-icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={12} /></button></div>}
    {snapshot ? <><div className="fx-window-context"><span><AudioLines size={12} />{snapshot.ownerName}</span><small>所有更改同步到主工程</small>{snapshot.transportAvailable && <button type="button" onClick={() => post('transport')} title="播放 / 暂停 · 空格"><Play size={10} />播放 / 暂停</button>}</div><EffectEditor effect={snapshot.effect} ownerName={snapshot.ownerName} sidechainTracks={snapshot.sidechainTracks} tempoBpm={snapshot.tempoBpm} sampleRate={snapshot.sampleRate} canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} readings={snapshot.readings}
      onChange={effect => { setSnapshot(previous => previous ? { ...previous, effect } : previous); post('change', { effect }); }}
      onBeginGesture={() => { if (!gesture.current) { gesture.current = true; post('begin'); } }} onCommitGesture={commit}
      onUndo={() => changeHistory('undo')} onRedo={() => changeHistory('redo')} onResetMeters={snapshot.resetMetersAvailable ? () => post('resetMeters') : undefined} comparison={snapshot.comparison} onToggleComparison={() => { commit(); post('compare'); }} onClose={close}
      onLearnNoise={snapshot.noise ? (start, duration) => { commit(); post('learnNoise', { noiseRange: { start, duration } }); } : undefined}
      matchEq={snapshot.matchEq} onAnalyzeMatch={snapshot.matchEq ? (sourceTarget, reference) => { commit(); post('matchEq', { matchClips: { sourceTarget, reference } }); } : undefined}
      onAuditionMatch={snapshot.matchEq ? () => post('auditionMatch') : undefined}
      noiseLearning={snapshot.noise?.learning} noiseLearnStart={snapshot.noise?.start} noiseLearnEnd={snapshot.noise?.end} noiseLearnMessage={snapshot.noise?.message} noisePreview={snapshot.noise?.preview}
      onListenNoise={snapshot.noise ? () => post('listenNoise') : undefined} listeningNoise={snapshot.noise?.listening} /></> : <div className="fx-window-loading"><AudioLines size={35} strokeWidth={1.3} /><h1>Visiki Audio</h1><p><LoaderCircle size={13} />连接主工程中的效果实例…</p>{error && <button type="button" className="fx-button" onClick={close}>关闭窗口</button>}</div>}
  </main>;
}
