import { DAW_MAX_ASSETS, DAW_MAX_CLIPS, DAW_MAX_DURATION, DAW_MAX_TRACKS, DAW_SCHEMA, DAW_VERSION, DAW_TRACK_COLORS, DawValidationError, addTrack, createTrack, updateTrack, deleteTrack, addClip, updateClip, moveClip, trimClip, splitClip, duplicateClip, deleteClip, updateMaster, updateMusicalGrid, validateSession, type DawSession } from './model'
import { DAW_EFFECT_CATALOG, DAW_MAX_EFFECTS, DAW_MAX_STORED_EFFECTS, isDawEffectType, getEffectDefinition, getEffectChain, getEffect, createEffect, addEffect, updateEffect, removeEffect, moveEffect, copyEffect, copyEffectChain, bypassEffectChain, resetEffect, applyEffectPreset, switchEffectAB, copyActiveEffectSlot, resolveEffectTarget, type DawEffectType, type DawEffectPatch } from './effects'
import { DAW_GRID_DIVISIONS } from './grid-division'
import { createVst3Effect, type Vst3Plugin, type Vst3ParamUpdate } from './vst3'

/** Flat operation fields are deliberately explicit: misspellings must never be ignored. */
export const DAW_AGENT_OPERATION_FIELDS = {
  update_session: ['name', 'sampleRate', 'masterDb', 'bpm', 'beatsPerBar', 'beatUnit'],
  add_track: ['name', 'color'], update_track: ['trackId', 'name', 'color', 'volumeDb', 'pan', 'muted', 'solo'],
  delete_track: ['trackId'], reorder_track: ['trackId', 'index'],
  add_clip: ['trackId', 'assetId', 'start'], update_clip: ['trackId', 'clipId', 'name', 'gainDb', 'fadeIn', 'fadeOut'],
  move_clip: ['trackId', 'clipId', 'start', 'targetTrackId'], trim_clip: ['trackId', 'clipId', 'edge', 'time'],
  split_clip: ['trackId', 'clipId', 'time'], duplicate_clip: ['trackId', 'clipId', 'start', 'targetTrackId'],
  delete_clip: ['trackId', 'clipId'], remove_asset: ['assetId'],
  add_effect: ['target', 'type', 'presetId', 'params', 'name', 'enabled', 'sidechainTrackId', 'index'],
  add_vst3: ['target', 'classId', 'index', 'name', 'enabled', 'params', 'vst3Params'],
  update_effect: ['target', 'effectId', 'enabled', 'name', 'params', 'vst3Params', 'presetId', 'sidechainTrackId'],
  remove_effect: ['target', 'effectId'], move_effect: ['target', 'effectId', 'index'],
  copy_effect: ['target', 'effectId', 'destination'], copy_effect_chain: ['target', 'destination'],
  bypass_effect_chain: ['target'], effect_reset: ['target', 'effectId'], effect_preset: ['target', 'effectId', 'presetId'],
  effect_ab: ['target', 'effectId', 'slot'], effect_copy_ab: ['target', 'effectId']
} as const
export const DAW_AGENT_OPERATION_NAMES = Object.keys(DAW_AGENT_OPERATION_FIELDS)
type Op = keyof typeof DAW_AGENT_OPERATION_FIELDS
const required: Record<Op, readonly string[]> = {
  update_session: [], add_track: [], update_track: ['trackId'], delete_track: ['trackId'], reorder_track: ['trackId', 'index'],
  add_clip: ['trackId', 'assetId'], update_clip: ['trackId', 'clipId'], move_clip: ['trackId', 'clipId', 'start'],
  trim_clip: ['trackId', 'clipId', 'edge', 'time'], split_clip: ['trackId', 'clipId', 'time'],
  duplicate_clip: ['trackId', 'clipId'], delete_clip: ['trackId', 'clipId'], remove_asset: ['assetId'],
  add_effect: ['target', 'type'], add_vst3: ['target', 'classId'], update_effect: ['target', 'effectId'], remove_effect: ['target', 'effectId'],
  move_effect: ['target', 'effectId', 'index'], copy_effect: ['target', 'effectId'], copy_effect_chain: ['target', 'destination'],
  bypass_effect_chain: ['target'], effect_reset: ['target', 'effectId'], effect_preset: ['target', 'effectId', 'presetId'],
  effect_ab: ['target', 'effectId', 'slot'], effect_copy_ab: ['target', 'effectId']
}
const fail = (path: string, message: string): never => { throw new DawValidationError([{ path, message }]) }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const numRanges: Record<string, [number, number, boolean?]> = { sampleRate: [8000, 192000, true], masterDb: [-96, 12], bpm: [20, 300], beatsPerBar: [2, 12, true], beatUnit: [2, 16, true], volumeDb: [-96, 24], pan: [-1, 1], gainDb: [-96, 24], fadeIn: [0, DAW_MAX_DURATION], fadeOut: [0, DAW_MAX_DURATION], start: [0, DAW_MAX_DURATION], time: [0, DAW_MAX_DURATION], index: [0, DAW_MAX_CLIPS, true] }
const strings = new Set(['name', 'color', 'trackId', 'clipId', 'assetId', 'targetTrackId', 'target', 'destination', 'effectId', 'type', 'classId', 'presetId', 'edge', 'slot', 'sidechainTrackId'])
const idFields = new Set(['trackId', 'clipId', 'assetId', 'targetTrackId', 'target', 'destination', 'effectId', 'sidechainTrackId'])
const booleans = new Set(['muted', 'solo', 'enabled'])
function parseOperation(input: unknown, index: number, results: Record<string, unknown>[]): { op: Op; fields: Record<string, any> } {
  const path = `operations[${index}]`
  if (!obj(input)) return fail(path, '操作必须是普通对象')
  if (typeof input.op !== 'string' || !Object.hasOwn(DAW_AGENT_OPERATION_FIELDS, input.op)) return fail(`${path}.op`, '未知操作')
  const op = input.op as Op, allowed: readonly string[] = DAW_AGENT_OPERATION_FIELDS[op]
  const fields: Record<string, any> = {}
  for (const [key, original] of Object.entries(input)) {
    if (key === 'op') continue
    if (!allowed.includes(key)) fail(`${path}.${key}`, '未知操作字段')
    let value = original
    if (typeof value === 'string' && idFields.has(key)) {
      const ref = /^\$(\d+)\.(trackId|clipId|effectId|assetId)$/.exec(value)
      if (ref) {
        const previous = results[Number(ref[1])]
        value = previous?.[ref[2]]
        if (typeof value !== 'string') fail(`${path}.${key}`, '引用的操作结果不存在')
      } else if (value.startsWith('clip:$')) {
        const match = /^clip:\$(\d+)\.clipId$/.exec(value)
        if (!match || typeof results[Number(match[1])]?.clipId !== 'string') fail(`${path}.${key}`, '引用的片段结果不存在')
        value = `clip:${results[Number(match![1])].clipId}`
      }
    }
    if (strings.has(key)) {
      if (key === 'sidechainTrackId' && value === null) { fields[key] = null; continue }
      if (typeof value !== 'string' || !value.trim() || value.length > 240) fail(`${path}.${key}`, '必须为 1–240 字符的文字')
      if (key === 'name') value = (value as string).trim()
    } else if (booleans.has(key)) {
      if (typeof value !== 'boolean') fail(`${path}.${key}`, '必须为布尔值')
    } else if (key in numRanges) {
      const [min, max, integer] = numRanges[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${path}.${key}`, `必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}`)
    } else if (key === 'params') {
      if (!obj(value) || Object.values(value).some(v => typeof v !== 'number' || !Number.isFinite(v))) fail(`${path}.params`, '必须是有限数字参数对象')
    }
    if (key === 'vst3Params') {
      if (!Array.isArray(value)) fail(`${path}.vst3Params`, '必须为参数更新数组')
      const ids = new Set<number>()
      for (const [j, update] of (value as unknown[]).entries()) {
        const at = `${path}.vst3Params[${j}]`
        if (!obj(update) || Object.keys(update).some(k => !['paramId', 'format', 'value', 'unit'].includes(k))) fail(at, '参数更新格式无效')
        const u = update as Record<string, unknown>
        if (!Number.isInteger(u.paramId) || (u.paramId as number) < 0 || (u.paramId as number) > 4294967295 || ids.has(u.paramId as number)) fail(`${at}.paramId`, '参数 ID 无效或重复')
        ids.add(u.paramId as number)
        if (!['normalized', 'plain', 'text', 'choice'].includes(u.format as string)) fail(`${at}.format`, '参数格式无效')
        if (u.format === 'normalized' || u.format === 'plain') {
          if (typeof u.value !== 'number' || !Number.isFinite(u.value) || (u.format === 'normalized' && (u.value < 0 || u.value > 1))) fail(`${at}.value`, '参数值无效')
        } else if (u.format === 'choice' && typeof u.value === 'number') {
          if (!Number.isSafeInteger(u.value) || u.value < 0) fail(`${at}.value`, '选项索引必须为非负整数')
        } else if (typeof u.value !== 'string' || !u.value.trim()) fail(`${at}.value`, '参数值必须为非空文字')
        if (u.unit !== undefined && (typeof u.unit !== 'string' || !u.unit.trim())) fail(`${at}.unit`, '单位无效')
      }
    }
    fields[key] = value
  }
  for (const key of required[op]) if (!(key in fields)) fail(`${path}.${key}`, '缺少必填字段')
  if (fields.params !== undefined && fields.vst3Params !== undefined) fail(`${path}.vst3Params`, 'params 和 vst3Params 只能选一个')
  if (fields.beatUnit !== undefined && ![2, 4, 8, 16].includes(fields.beatUnit)) fail(`${path}.beatUnit`, '必须为 2、4、8 或 16')
  if (fields.edge !== undefined && !['start', 'end'].includes(fields.edge)) fail(`${path}.edge`, '必须为 start 或 end')
  if (fields.slot !== undefined && !['A', 'B'].includes(fields.slot)) fail(`${path}.slot`, '必须为 A 或 B')
  if (fields.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(fields.color)) fail(`${path}.color`, '必须为六位十六进制颜色')
  return { op, fields }
}
const pick = (fields: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => key in fields).map(key => [key, fields[key]]))
const track = (s: DawSession, id: string) => s.tracks.find(t => t.id === id) ?? fail('trackId', '找不到音轨')
const clip = (s: DawSession, trackId: string, id: string) => track(s, trackId).clips.find(c => c.id === id) ?? fail('clipId', '找不到片段')
function checkSidechain(s: DawSession, f: Record<string, any>) {
  if (typeof f.sidechainTrackId !== 'string') return
  const source = track(s, f.sidechainTrackId)
  const owner = resolveEffectTarget(s, f.target)
  if (owner && owner.kind !== 'master' && owner.track.id === source.id) fail('sidechainTrackId', '回避触发源须为另一条轨道')
}
function createdClip(before: DawSession, after: DawSession): string | undefined {
  const ids = new Set(before.tracks.flatMap(t => t.clips.map(c => c.id)))
  return after.tracks.flatMap(t => t.clips).find(c => !ids.has(c.id))?.id
}
function createdEffect(before: DawSession, after: DawSession, destination: string): string | undefined {
  const ids = new Set(getEffectChain(before, destination).map(e => e.id))
  return getEffectChain(after, destination).find(e => !ids.has(e.id))?.id
}
export type DawVst3ResolutionRequest = { kind: 'add'; session: DawSession; classId: string; params?: Record<string, number>; vst3Params?: Vst3ParamUpdate[] } | { kind: 'update'; session: DawSession; effect: ReturnType<typeof getEffect>; params?: Record<string, number>; vst3Params?: Vst3ParamUpdate[] }
export type DawVst3Resolution = { plugin?: Vst3Plugin; params: Record<string, number> }
type BatchResult = { session: DawSession; results: Record<string, unknown>[] }
/** Shared immutable reducer; VST3 resolution pauses before the relevant mutation. */
function* reduceDawAgentOperations(session: DawSession, operations: unknown): Generator<DawVst3ResolutionRequest, BatchResult, DawVst3Resolution> {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 256) fail('operations', '必须为包含 1–256 项的数组')
  const batch = operations as unknown[]
  let next = session
  const results: Record<string, unknown>[] = []
  for (let i = 0; i < batch.length; i++) {
    const { op, fields: f } = parseOperation(batch[i], i, results)
    const before = next, result: Record<string, unknown> = { op }
    switch (op) {
      case 'update_session': {
        if (f.name !== undefined || f.sampleRate !== undefined) next = { ...next, ...pick(f, ['name', 'sampleRate']) }
        if (f.masterDb !== undefined) next = updateMaster(next, f.masterDb)
        if (['bpm', 'beatsPerBar', 'beatUnit'].some(k => k in f)) next = updateMusicalGrid(next, pick(f, ['bpm', 'beatsPerBar', 'beatUnit']))
        break
      }
      case 'add_track': {
        const t = createTrack(f.name ?? `音轨 ${next.tracks.length + 1}`, f.color ?? DAW_TRACK_COLORS[next.tracks.length % DAW_TRACK_COLORS.length])
        next = addTrack(next, t); result.trackId = t.id; break
      }
      case 'update_track': next = updateTrack(next, f.trackId, pick(f, ['name', 'color', 'volumeDb', 'pan', 'muted', 'solo'])); break
      case 'delete_track': next = deleteTrack(next, f.trackId); break
      case 'reorder_track': {
        const t = track(next, f.trackId)
        if (f.index >= next.tracks.length) fail('index', '排序位置超出范围')
        if (next.tracks[f.index] === t) break
        const tracks = next.tracks.filter(x => x.id !== t.id); tracks.splice(f.index, 0, t); next = { ...next, tracks }; break
      }
      case 'add_clip': next = addClip(next, f.trackId, f.assetId, f.start); result.clipId = createdClip(before, next); result.trackId = f.trackId; break
      case 'update_clip': next = updateClip(next, f.trackId, f.clipId, pick(f, ['name', 'gainDb', 'fadeIn', 'fadeOut'])); break
      case 'move_clip': next = moveClip(next, f.trackId, f.clipId, f.start, f.targetTrackId); break
      case 'trim_clip': next = trimClip(next, f.trackId, f.clipId, f.edge, f.time); break
      case 'split_clip': {
        const c = clip(next, f.trackId, f.clipId)
        if (f.time <= c.start || f.time >= c.start + c.duration) fail('time', '分割点必须位于片段内部')
        next = splitClip(next, f.trackId, f.clipId, f.time)
        result.clipId = createdClip(before, next)
        if (!result.clipId) fail('time', '分割点须至少距边界一个采样点')
        result.trackId = f.trackId; break
      }
      case 'duplicate_clip': {
        if (f.targetTrackId) track(next, f.targetTrackId)
        next = duplicateClip(next, f.trackId, f.clipId, f.start)
        const id = createdClip(before, next)!
        if (f.targetTrackId && f.targetTrackId !== f.trackId) next = moveClip(next, f.trackId, id, clip(next, f.trackId, id).start, f.targetTrackId)
        result.clipId = id; result.trackId = f.targetTrackId ?? f.trackId; break
      }
      case 'delete_clip': next = deleteClip(next, f.trackId, f.clipId); break
      case 'remove_asset': {
        if (!next.assets.some(a => a.id === f.assetId)) fail('assetId', '找不到素材')
        if (next.tracks.some(t => t.clips.some(c => c.assetId === f.assetId))) fail('assetId', '素材仍被片段引用')
        next = { ...next, assets: next.assets.filter(a => a.id !== f.assetId) }; break
      }
      case 'add_effect': {
        if (!isDawEffectType(f.type)) fail('type', '未知效果类型')
        checkSidechain(next, f)
        const e = createEffect(f.type as DawEffectType, f.presetId)
        if (f.params !== undefined) { e.params = { ...e.params, ...f.params }; delete e.presetId }
        if (f.name !== undefined) e.name = f.name
        if (f.enabled !== undefined) e.enabled = f.enabled
        if (f.sidechainTrackId != null) e.sidechainTrackId = f.sidechainTrackId
        next = addEffect(next, f.target, e, f.index)
        result.effectId = e.id; break
      }
      case 'add_vst3': {
        const resolved = yield { kind: 'add', session: next, classId: f.classId, params: f.params, vst3Params: f.vst3Params }
        if (!resolved.plugin) fail('classId', '找不到 VST3 插件')
        const e = createVst3Effect(resolved.plugin!)
        e.params = { ...e.params, ...resolved.params }
        if (f.name !== undefined) e.name = f.name
        if (f.enabled !== undefined) e.enabled = f.enabled
        next = addEffect(next, f.target, e, f.index)
        result.effectId = e.id; result.vst3ParamIds = Object.keys(resolved.params).map(Number); break
      }
      case 'update_effect': {
        const effect = getEffect(next, f.target, f.effectId)
        if (effect.type === 'vst3' && (f.params !== undefined || f.vst3Params !== undefined)) {
          const resolved = yield { kind: 'update', session: next, effect, params: f.params, vst3Params: f.vst3Params }
          f.params = resolved.params
          result.effectId = effect.id; result.vst3ParamIds = Object.keys(resolved.params).map(Number)
        } else if (f.vst3Params !== undefined) fail('vst3Params', '仅 VST3 效果支持 vst3Params')
        checkSidechain(next, f)
        if (f.presetId !== undefined) next = applyEffectPreset(next, f.target, f.effectId, f.presetId)
        const patch = pick(f, ['enabled', 'name', 'params', 'sidechainTrackId']) as DawEffectPatch
        if (Object.keys(patch).length) next = updateEffect(next, f.target, f.effectId, patch)
        else getEffect(next, f.target, f.effectId)
        break
      }
      case 'remove_effect': next = removeEffect(next, f.target, f.effectId); break
      case 'move_effect': next = moveEffect(next, f.target, f.effectId, f.index); break
      case 'copy_effect': {
        const destination = f.destination ?? f.target
        next = copyEffect(next, f.target, f.effectId, destination)
        result.effectId = createdEffect(before, next, destination); break
      }
      case 'copy_effect_chain': next = copyEffectChain(next, f.target, f.destination); result.effectIds = getEffectChain(next, f.destination).map(e => e.id); break
      case 'bypass_effect_chain': next = bypassEffectChain(next, f.target); break
      case 'effect_reset': next = resetEffect(next, f.target, f.effectId); break
      case 'effect_preset': next = applyEffectPreset(next, f.target, f.effectId, f.presetId); break
      case 'effect_ab': if ((getEffect(next, f.target, f.effectId).abSlot ?? 'A') !== f.slot) next = switchEffectAB(next, f.target, f.effectId); break
      case 'effect_copy_ab': {
        const copied = copyActiveEffectSlot(getEffect(next, f.target, f.effectId))
        next = updateEffect(next, f.target, f.effectId, { bState: copied.bState, bNoiseProfile: copied.bNoiseProfile ?? null, bSidechainTrackId: copied.bSidechainTrackId ?? null })
        break
      }
    }
    results.push(result)
  }
  // Existing waveform peaks may be very large and cannot be changed by these operations.
  const issues = validateSession({ ...next, assets: next.assets.map(a => ({ ...a, peaks: [] })) })
  if (issues.length) throw new DawValidationError(issues)
  return { session: next, results }
}


/** Built-in-only batches remain synchronous. VST3 writes require SDK resolution. */
export function applyDawAgentOperations(session: DawSession, operations: unknown): BatchResult {
  const iterator = reduceDawAgentOperations(session, operations)
  const step = iterator.next()
  if (step.done) return step.value
  return fail('operations', 'VST3 参数编辑需要异步插件解析')
}
export async function applyDawAgentOperationsAsync(session: DawSession, operations: unknown, resolve: (request: DawVst3ResolutionRequest) => Promise<DawVst3Resolution>): Promise<BatchResult> {
  const iterator = reduceDawAgentOperations(session, operations)
  let step = iterator.next()
  while (!step.done) step = iterator.next(await resolve(step.value))
  return step.value
}

export function dawAgentCatalog(effectType?: DawEffectType) {
  if (effectType !== undefined && !isDawEffectType(effectType)) fail('effectType', '未知效果类型')
  return {
    schema: DAW_SCHEMA, version: DAW_VERSION,
    limits: { tracks: DAW_MAX_TRACKS, clips: DAW_MAX_CLIPS, assets: DAW_MAX_ASSETS, durationSeconds: DAW_MAX_DURATION, activeEffectsPerChain: DAW_MAX_EFFECTS, storedEffectsPerChain: DAW_MAX_STORED_EFFECTS, operationsPerBatch: 256, sampleRate: [8000, 192000], masterDb: [-96, 12], trackDb: [-96, 24], clipDb: [-96, 24], pan: [-1, 1] },
    musicalGrid: { bpm: [20, 300], beatsPerBar: [2, 12], beatUnit: [2, 4, 8, 16], divisions: DAW_GRID_DIVISIONS },
    operationFields: DAW_AGENT_OPERATION_FIELDS, requiredFields: required,
    references: 'Use $0.trackId, $1.clipId or $2.effectId to refer to an earlier result; clip:$1.clipId is a clip effect target.',
    effects: effectType ? getEffectDefinition(effectType) : DAW_EFFECT_CATALOG.map(({ type, name, category, presets }) => ({ type, name, category, presets: presets.map(({ id, name }) => ({ id, name })) }))
  }
}
