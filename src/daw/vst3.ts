import type { DawEffect } from './effects'

export interface Vst3Parameter { id: number; name: string; unit: string; defaultValue: number; stepCount: number; readOnly: boolean }
export interface Vst3Plugin { classId: string; name: string; vendor: string; version: string; category: string; parameters: Vst3Parameter[]; latencySamples?: number; tailSamples?: number }
export interface Vst3ScanResult { plugins: Vst3Plugin[]; issues: unknown[]; available: boolean; scanning: boolean }
export type Vst3ParamUpdate =
  | { paramId: number; format: 'normalized'; value: number }
  | { paramId: number; format: 'choice'; value: number | string }
  | { paramId: number; format: 'plain'; value: number; unit?: string }
  | { paramId: number; format: 'text'; value: string }
export interface Vst3ParameterRequest {
  classId: string
  sampleRate: number
  params: Record<string, number>
  query?: string
  offset?: number
  limit?: number
  paramIds?: number[]
  includeChoices?: boolean
  updates?: Vst3ParamUpdate[]
}
export interface Vst3ParameterDetails extends Vst3Parameter {
  shortName?: string
  unitId?: number
  group?: string
  hidden?: boolean
  automatable?: boolean
  programChange?: boolean
  bypass?: boolean
  normalizedValue: number
  plainValue?: number
  displayValue?: string
  choices?: { index: number; label: string; normalizedValue: number }[]
}
export interface Vst3ParameterResult {
  classId: string
  parameters: Vst3ParameterDetails[]
  total: number
  nextOffset: number | null
  resolved?: Record<string, number>
}
export interface Vst3ValueRequest { effectId: string; paramIds: number[] }
export interface Vst3ValueResult {
  effectId: string
  state: 'active' | 'bypassed' | 'unavailable'
  values: { id: number; normalizedValue: number; displayValue?: string; processed: boolean }[]
}
const validParam = (p: Vst3Parameter) => !!p && typeof p === 'object' && Number.isInteger(p.id) && p.id >= 0 && p.id <= 4294967295 && typeof p.name === 'string' && typeof p.unit === 'string' && Number.isFinite(p.defaultValue) && p.defaultValue >= 0 && p.defaultValue <= 1 && Number.isInteger(p.stepCount) && p.stepCount >= 0 && typeof p.readOnly === 'boolean'
export function validVst3Plugin(p: Vst3Plugin): boolean {
  return !!p && /^[0-9A-F]{32}$/.test(p.classId) && typeof p.name === 'string' && !!p.name.trim() && p.name.length <= 240 && typeof p.vendor === 'string' && typeof p.version === 'string' && typeof p.category === 'string' && Array.isArray(p.parameters) && p.parameters.every(validParam) && new Set(p.parameters.map(param => param.id)).size === p.parameters.length
}
export function createVst3Effect(plugin: Vst3Plugin): DawEffect {
  if (!validVst3Plugin(plugin)) throw new Error('无效的 VST3 插件信息')
  return { id: globalThis.crypto.randomUUID(), type: 'vst3', name: plugin.name, enabled: true, vst3: { classId: plugin.classId }, params: Object.fromEntries(plugin.parameters.filter(p => !p.readOnly).map(p => [String(p.id), p.defaultValue])) }
}
export async function getVst3Plugins(scan = false, force = false, signal?: AbortSignal): Promise<Vst3ScanResult> {
  const response = await fetch(scan ? '/api/daw/vst3/scan' : '/api/daw/vst3/plugins', scan ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }), signal } : { signal })
  if (!response.ok) { let message = `请求失败 (${response.status})`; try { const body = await response.json(); if (typeof body.error === 'string') message = body.error } catch { /* retain HTTP status */ } throw new Error(message) }
  const data = await response.json()
  if (!data || !Array.isArray(data.plugins) || !Array.isArray(data.issues) || typeof data.available !== 'boolean') throw new Error('VST3 插件列表格式无效')
  const plugins = data.plugins.filter(validVst3Plugin)
  return { plugins, issues: [...data.issues, ...(plugins.length === data.plugins.length ? [] : ['部分插件的信息无效，已跳过。'])], available: data.available, scanning: data.scanning === true }
}

export async function inspectVst3Parameters(input: Vst3ParameterRequest, signal?: AbortSignal): Promise<Vst3ParameterResult> {
  const response = await fetch('/api/daw/vst3/parameters', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error || 'VST3 参数查询失败'), { code: data.code })
  if (data.classId !== input.classId || !Array.isArray(data.parameters) || !Number.isInteger(data.total)) {
    throw new Error('VST3 参数查询返回无效结果')
  }
  return data
}
