import { useEffect, useState } from 'react'
import type { DawEffect } from './effects'
import { getVst3Plugins, type Vst3Plugin, type Vst3ScanResult } from './vst3'

function issueText(issue: unknown): string {
  if (typeof issue === 'string') return issue
  if (issue && typeof issue === 'object') {
    const item = issue as Record<string, unknown>
    return [item.name ?? item.plugin ?? item.module ?? item.path, item.message ?? item.error ?? item.reason].filter(value => typeof value === 'string').join('：') || '扫描时遇到未知问题'
  }
  return '扫描时遇到未知问题'
}
export function Vst3Browser({ onAdd, disabled }: { onAdd: (plugin: Vst3Plugin) => void; disabled?: boolean }) {
  const [result, setResult] = useState<Vst3ScanResult>(), [pending, setPending] = useState(false), [error, setError] = useState('')
  useEffect(() => { const controller = new AbortController(); getVst3Plugins(false, false, controller.signal).then(setResult).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)) }); return () => controller.abort() }, [])
  useEffect(() => {
    if (!result?.scanning || pending) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => { getVst3Plugins(false, false, controller.signal).then(setResult).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)) }) }, 1500)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [result, pending])
  const scan = async (force: boolean) => { setPending(true); setError(''); try { setResult(await getVst3Plugins(true, force)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setPending(false) } }
  const scanning = pending || !!result?.scanning
  return <section className="fx-surface fx-browser" aria-label="VST3 插件库">
    <div className="fx-vst-actions"><button type="button" className="fx-button" disabled={scanning} onClick={() => void scan(false)}>{scanning ? '正在扫描…' : '扫描 VST3'}</button><button type="button" className="fx-button subtle" disabled={scanning} onClick={() => void scan(true)}>重新扫描全部</button></div>
    <div className="fx-library-results">
      <p className="fx-browser-foot">VST3 插件可添加到轨道或主输出。首次扫描可能需要一些时间。</p>
      {disabled && <p role="status">片段效果链暂不支持 VST3，请选择轨道或主输出。</p>}
      {error && <p role="alert">VST3 扫描服务：{error}</p>}
      {result && !result.available && <p role="status">VST3 扫描服务当前不可用。</p>}
      {result?.issues.length ? <details>
        <summary>扫描问题（{result.issues.length}）</summary>
        <ul>{result.issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ul>
      </details> : null}
      {result && !result.plugins.length && <p>暂无已发现的 VST3 插件，请点击扫描。</p>}
      <div className="fx-library-grid">
        {result?.plugins.map(plugin => <article className="fx-library-card" key={plugin.classId}>
          <div className="fx-library-info">
            <h3>{plugin.name}</h3>
            <small>{plugin.vendor} {plugin.version} · {plugin.category}</small>
            <div className="fx-library-actions">
              <span className="fx-tag">VST3</span>
              <button type="button" className="fx-button small" disabled={disabled || scanning || !result.available} onClick={() => onAdd(plugin)}>添加</button>
            </div>
          </div>
        </article>)}
      </div>
    </div>
  </section>
}
export function Vst3Editor({ effect, nativeError, onRetryNative, onChange, onBeginGesture, onCommitGesture, onUndo, onRedo, canUndo, canRedo }: { effect: DawEffect; nativeError: string; onRetryNative: () => void; onChange: (effect: DawEffect) => void; onBeginGesture: () => void; onCommitGesture: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }) {
  const [plugin, setPlugin] = useState<Vst3Plugin>(), [error, setError] = useState('')
  useEffect(() => { const controller = new AbortController(); setPlugin(undefined); setError(''); getVst3Plugins(false, false, controller.signal).then(result => { const found = result.plugins.find(item => item.classId === effect.vst3?.classId); if (found) setPlugin(found); else setError('插件未找到，请在效果库重新扫描。') }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)) }); return () => controller.abort() }, [effect.vst3?.classId])
  return <section className="fx-surface fx-vst-editor"><header className="fx-editor-head"><div className="fx-editor-title"><h2>{effect.name || 'VST3 插件'}</h2><small>{plugin?.vendor || 'VST3'} · 通用参数</small></div><span className="fx-tag">VST3</span><button type="button" className="fx-button" onClick={() => onChange({ ...effect, enabled: !effect.enabled })}>{effect.enabled ? '已启用' : '已旁路'}</button></header>
    <div className="fx-vst-actions"><button type="button" className="fx-button small" disabled={!canUndo} onClick={onUndo}>撤销</button><button type="button" className="fx-button small" disabled={!canRedo} onClick={onRedo}>重做</button></div>
    <p role="status">原生窗口不可用：{nativeError} 当前显示通用参数。</p>
    <button type="button" className="fx-button small" onClick={onRetryNative}>重试打开原生窗口</button>
    {error && <p role="status">{error}</p>}
    {plugin && !plugin.parameters.some(p => !p.readOnly) && <p>此插件没有可编辑参数。</p>}
    <div className="fx-vst-parameters">
      {plugin?.parameters.filter(parameter => !parameter.readOnly).map(parameter => {
        const key = String(parameter.id)
        const value = effect.params[key] ?? parameter.defaultValue
        return <label className="fx-control" key={parameter.id}>
          <span className="fx-control-head">
            <span>{parameter.name}</span>
            <span className="fx-vst-value">{value.toFixed(3)}</span>
          </span>
          <input type="range" aria-label={parameter.name} min={0} max={1}
            step={parameter.stepCount > 0 ? 1 / parameter.stepCount : .001}
            value={value}
            onPointerDown={onBeginGesture} onPointerUp={onCommitGesture}
            onPointerCancel={onCommitGesture} onBlur={onCommitGesture}
            onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onBeginGesture()
            }}
            onKeyUp={onCommitGesture}
            onChange={event => onChange({ ...effect, params: { ...effect.params, [key]: Number(event.target.value) } })}
          />
          {parameter.unit && <small>{parameter.unit}</small>}
        </label>
      })}
    </div>
  </section>
}
