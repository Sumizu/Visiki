import { cloneEffectChain, validateEffectChain, type DawEffect } from './effects'

/** Serializable, immutable DAW document. Audio buffers and engine state live elsewhere. */
export const DAW_SCHEMA = 'visiki-daw' as const
export const DAW_VERSION = 1 as const
export const DAW_MAX_TRACKS = 32
export const DAW_MAX_DURATION = 3600
export const DAW_MAX_CLIPS = 512
export const DAW_MAX_ASSETS = 64
export const DAW_TRACK_COLORS = ['#ab9bff', '#68cfc2', '#f1aa83', '#7daaf6', '#d68fc2', '#c9c477'] as const

export interface DawPeakChannel { min: number[]; max: number[] }
export interface DawEnvelopePoint { time: number; gain: number }
/** Ruler metadata only: tempo changes never move or stretch audio. BPM counts quarter notes. */
export interface DawMusicalGrid { bpm: number; beatsPerBar: number; beatUnit: number }
export const DEFAULT_DAW_MUSICAL_GRID: Readonly<DawMusicalGrid> = Object.freeze({ bpm: 120, beatsPerBar: 4, beatUnit: 4 })
export interface DawAsset {
  id: string
  name: string
  url: string
  duration: number
  sampleRate: number
  sampleCount?: number
  channels: number
  peaks: DawPeakChannel[]
  peakHopSec: number
}
export interface DawClip {
  id: string
  assetId: string
  name: string
  start: number
  sourceIn: number
  duration: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  /** Piecewise linear inherited envelope after a non-destructive cut/trim. */
  envelope?: DawEnvelopePoint[]
  /** Optional per-clip effect chain; absent in older schema-1 projects. */
  effects?: DawEffect[]
}
export interface DawTrack {
  id: string
  name: string
  color: string
  volumeDb: number
  pan: number
  muted: boolean
  solo: boolean
  clips: DawClip[]
  /** Omitted in existing schema-1 documents and when no effects have been inserted. */
  effects?: DawEffect[]
}
export interface DawSession {
  schema: typeof DAW_SCHEMA
  version: typeof DAW_VERSION
  id: string
  name: string
  sampleRate: number
  assets: DawAsset[]
  tracks: DawTrack[]
  masterDb: number
  /** Optional for compatibility with existing schema-1 projects. */
  musicalGrid?: DawMusicalGrid
  masterEffects?: DawEffect[]
}
export interface DawValidationIssue { path: string; message: string }
export class DawValidationError extends Error {
  readonly issues: DawValidationIssue[]
  constructor(issues: DawValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'DawValidationError'
    this.issues = issues
  }
}

type TrackPatch = Partial<Pick<DawTrack, 'name' | 'color' | 'volumeDb' | 'pan' | 'muted' | 'solo'>>
type ClipPatch = Partial<Pick<DawClip, 'name' | 'gainDb' | 'fadeIn' | 'fadeOut'>>
const MAX_ASSETS = DAW_MAX_ASSETS
const MAX_PEAKS = 500000
const MAX_JSON_LENGTH = 24 * 1024 * 1024
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/
const assetUrlPattern = /^\/api\/daw\/assets\/[a-zA-Z0-9_-]+(?:\/(?:audio|file))?$/
const colorPattern = /^#[0-9a-fA-F]{6}$/
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const clean = (name: string, fallback: string) => name.trim().slice(0, 240) || fallback
const newId = () => globalThis.crypto.randomUUID()
const fail = (path: string, message: string): never => { throw new DawValidationError([{ path, message }]) }
const number = (value: number, path: string) => finite(value) ? value : fail(path, '必须是有限数字')
const samples = (seconds: number, sampleRate: number) => Math.round(seconds * sampleRate)
const quantize = (seconds: number, sampleRate: number) => samples(seconds, sampleRate) / sampleRate
const sourceSamples = (asset: DawAsset) => asset.sampleCount ?? Math.floor(asset.duration * asset.sampleRate + 1e-6)

export function createSession(name = '未命名混音'): DawSession {
  return { schema: DAW_SCHEMA, version: DAW_VERSION, id: newId(), name: clean(name, '未命名混音'), sampleRate: 48000, assets: [], tracks: [], masterDb: 0, musicalGrid: { ...DEFAULT_DAW_MUSICAL_GRID } }
}
export function getMusicalGrid(session: Pick<DawSession, 'musicalGrid'>): DawMusicalGrid {
  const grid = session.musicalGrid ?? DEFAULT_DAW_MUSICAL_GRID
  return { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, beatUnit: grid.beatUnit }
}
export function updateMusicalGrid(session: DawSession, patch: Partial<DawMusicalGrid>): DawSession {
  const grid = { ...getMusicalGrid(session), ...patch }
  if (!finite(grid.bpm) || grid.bpm < 20 || grid.bpm > 300) fail('musicalGrid.bpm', '速度必须是 20–300 范围内的有限数字')
  if (!Number.isInteger(grid.beatsPerBar) || grid.beatsPerBar < 2 || grid.beatsPerBar > 12) fail('musicalGrid.beatsPerBar', '每小节拍数必须是 2–12 范围内的整数')
  if (![2, 4, 8, 16].includes(grid.beatUnit)) fail('musicalGrid.beatUnit', '拍号分母必须是 2、4、8 或 16')
  const before = getMusicalGrid(session)
  if (session.musicalGrid && grid.bpm === before.bpm && grid.beatsPerBar === before.beatsPerBar && grid.beatUnit === before.beatUnit) return session
  return { ...session, musicalGrid: grid }
}
export function createTrack(name = '音轨', color: string = DAW_TRACK_COLORS[0]): DawTrack {
  if (!colorPattern.test(color)) fail('track.color', '颜色必须为六位十六进制值')
  return { id: newId(), name: clean(name, '音轨'), color, volumeDb: 0, pan: 0, muted: false, solo: false, clips: [] }
}
export function createClip(asset: DawAsset, start = 0, name = asset.name): DawClip {
  number(start, 'clip.start')
  if (sourceSamples(asset) < 1) fail('asset.duration', '素材至少需要一个采样点')
  const duration = sourceSamples(asset) / asset.sampleRate
  return { id: newId(), assetId: asset.id, name: clean(name, '音频片段'), start: quantize(clamp(start, 0, DAW_MAX_DURATION - duration), asset.sampleRate), sourceIn: 0, duration, gainDb: 0, fadeIn: 0, fadeOut: 0 }
}
export function sessionDuration(session: DawSession): number {
  let end = 0
  for (const track of session.tracks) for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
  return end
}
const findTrack = (session: DawSession, trackId: string) => session.tracks.find(track => track.id === trackId) ?? fail('trackId', '找不到音轨')
const findClip = (track: DawTrack, clipId: string) => track.clips.find(clip => clip.id === clipId) ?? fail('clipId', '找不到片段')
const findAsset = (session: DawSession, assetId: string) => session.assets.find(asset => asset.id === assetId) ?? fail('assetId', '找不到素材')
const replaceTrack = (session: DawSession, track: DawTrack): DawSession => ({ ...session, tracks: session.tracks.map(item => item.id === track.id ? track : item) })
const replaceClip = (session: DawSession, track: DawTrack, clip: DawClip) => replaceTrack(session, { ...track, clips: track.clips.map(item => item.id === clip.id ? clip : item) })
const clipCount = (session: DawSession) => session.tracks.reduce((count, track) => count + track.clips.length, 0)

export function addAssetToSession(session: DawSession, asset: DawAsset): DawSession {
  if (session.assets.length >= MAX_ASSETS) fail('assets', `最多允许 ${MAX_ASSETS} 个素材`)
  if (session.assets.some(item => item.id === asset.id)) fail('asset.id', '素材标识重复')
  // Existing immutable assets are already validated; do not rescan all their peaks.
  const issues = validateSession({ ...session, assets: [asset], tracks: [] })
  if (issues.length) throw new DawValidationError(issues)
  return { ...session, assets: [...session.assets, asset] }
}
export function addTrack(session: DawSession, track: DawTrack = createTrack(`音轨 ${session.tracks.length + 1}`, DAW_TRACK_COLORS[session.tracks.length % DAW_TRACK_COLORS.length])): DawSession {
  if (session.tracks.length >= DAW_MAX_TRACKS) fail('tracks', `最多允许 ${DAW_MAX_TRACKS} 条音轨`)
  if (session.tracks.some(item => item.id === track.id)) fail('track.id', '音轨标识重复')
  if (clipCount(session) + track.clips.length > DAW_MAX_CLIPS) fail('clips', `最多允许 ${DAW_MAX_CLIPS} 个片段`)
  const existingClipIds = new Set(session.tracks.flatMap(item => item.clips.map(clip => clip.id)))
  if (track.clips.some(clip => existingClipIds.has(clip.id))) fail('track.clips', '片段标识重复')
  const effectIds = new Set([...session.masterEffects ?? [], ...session.tracks.flatMap(item => [...item.effects ?? [], ...item.clips.flatMap(clip => clip.effects ?? [])])].map(effect => effect.id))
  if (track.effects) {
    const effectIssues = validateEffectChain(track.effects, 'track.effects', effectIds)
    if (effectIssues.length) throw new DawValidationError(effectIssues)
  }
  for (const [index, clip] of track.clips.entries()) if (clip.effects !== undefined) {
    const effectIssues = validateEffectChain(clip.effects, `track.clips[${index}].effects`, effectIds)
    if (effectIssues.length) throw new DawValidationError(effectIssues)
  }
  const issues = validateSession({ ...session, assets: session.assets.map(asset => ({ ...asset, peaks: [] })), tracks: [track] })
  if (issues.length) throw new DawValidationError(issues)
  return { ...session, tracks: [...session.tracks, track] }
}
export function addClip(session: DawSession, trackId: string, assetId: string, start = 0): DawSession {
  if (clipCount(session) >= DAW_MAX_CLIPS) fail('clips', `最多允许 ${DAW_MAX_CLIPS} 个片段`)
  const track = findTrack(session, trackId)
  const clip = createClip(findAsset(session, assetId), start)
  return replaceTrack(session, { ...track, clips: [...track.clips, clip] })
}
export function updateTrack(session: DawSession, trackId: string, patch: TrackPatch): DawSession {
  const track = findTrack(session, trackId)
  const next = { ...track }
  if (patch.name !== undefined) next.name = clean(patch.name, '音轨')
  if (patch.color !== undefined) {
    if (!colorPattern.test(patch.color)) fail('track.color', '颜色必须为六位十六进制值')
    next.color = patch.color
  }
  if (patch.volumeDb !== undefined) next.volumeDb = clamp(number(patch.volumeDb, 'track.volumeDb'), -96, 24)
  if (patch.pan !== undefined) next.pan = clamp(number(patch.pan, 'track.pan'), -1, 1)
  if (patch.muted !== undefined) next.muted = patch.muted
  if (patch.solo !== undefined) next.solo = patch.solo
  return replaceTrack(session, next)
}
export function updateMaster(session: DawSession, volumeDb: number): DawSession {
  return { ...session, masterDb: clamp(number(volumeDb, 'masterDb'), -96, 12) }
}
/** Fade overlap is proportionally reduced, preserving the requested relative lengths. */
function constrainFades(clip: DawClip, sampleRate: number): DawClip {
  const durationSamples = Math.max(1, samples(clip.duration, sampleRate))
  let fadeInSamples = Math.max(0, samples(clip.fadeIn, sampleRate))
  let fadeOutSamples = Math.max(0, samples(clip.fadeOut, sampleRate))
  const total = fadeInSamples + fadeOutSamples
  if (total > durationSamples) {
    fadeInSamples = Math.round(fadeInSamples * durationSamples / total)
    fadeOutSamples = durationSamples - fadeInSamples
  }
  return { ...clip, fadeIn: fadeInSamples / sampleRate, fadeOut: fadeOutSamples / sampleRate }
}
export function updateClip(session: DawSession, trackId: string, clipId: string, patch: ClipPatch): DawSession {
  const track = findTrack(session, trackId)
  const clip = findClip(track, clipId)
  const next = { ...clip }
  if (patch.name !== undefined) next.name = clean(patch.name, '音频片段')
  if (patch.gainDb !== undefined) next.gainDb = clamp(number(patch.gainDb, 'clip.gainDb'), -96, 24)
  if (patch.fadeIn !== undefined) next.fadeIn = clamp(number(patch.fadeIn, 'clip.fadeIn'), 0, clip.duration)
  if (patch.fadeOut !== undefined) next.fadeOut = clamp(number(patch.fadeOut, 'clip.fadeOut'), 0, clip.duration)
  if (patch.fadeIn !== undefined || patch.fadeOut !== undefined) delete next.envelope
  return replaceClip(session, track, constrainFades(next, findAsset(session, clip.assetId).sampleRate))
}
/** Shared by live preview and rendering. Out-of-range positions hold their edge gain. */
export function clipEnvelopeAt(clip: DawClip, localSec: number): number {
  if (!Number.isFinite(localSec)) return 0
  const time = clamp(localSec, 0, clip.duration)
  const points = clip.envelope
  if (!points?.length) return Math.min(clip.fadeIn > 0 ? time / clip.fadeIn : 1, clip.fadeOut > 0 ? (clip.duration - time) / clip.fadeOut : 1, 1)
  if (time <= points[0].time) return points[0].gain
  for (let index = 1; index < points.length; index++) {
    const right = points[index]
    if (time <= right.time) {
      const left = points[index - 1]
      return left.gain + (right.gain - left.gain) * ((time - left.time) / (right.time - left.time))
    }
  }
  return points[points.length - 1].gain
}
/** Slice a linear envelope exactly; no re-fading is introduced at an edit boundary. */
function sliceEnvelope(clip: DawClip, from: number, duration: number, rate: number): DawEnvelopePoint[] {
  const original = clip.envelope ?? [
    { time: 0, gain: clip.fadeIn > 0 ? 0 : 1 },
    ...(clip.fadeIn > 0 ? [{ time: clip.fadeIn, gain: 1 }] : []),
    ...(clip.fadeOut > 0 ? [{ time: clip.duration - clip.fadeOut, gain: 1 }] : []),
    { time: clip.duration, gain: clip.fadeOut > 0 ? 0 : 1 }
  ]
  const positions = [0, duration, ...original.map(point => quantize(point.time - from, rate)).filter(time => time > 0 && time < duration)]
  const sorted = [...new Set(positions)].sort((a, b) => a - b)
  const points = sorted.map(time => ({ time, gain: clipEnvelopeAt(clip, time + from) }))
  // Repeated trim/extend operations must not accumulate redundant constant/linear nodes.
  for (let index = points.length - 2; index > 0; index--) {
    const left = points[index - 1], middle = points[index], right = points[index + 1]
    const expected = left.gain + (right.gain - left.gain) * (middle.time - left.time) / (right.time - left.time)
    if (Math.abs(expected - middle.gain) < 1e-12) points.splice(index, 1)
  }
  return points
}
export function moveClip(session: DawSession, trackId: string, clipId: string, start: number, targetTrackId = trackId): DawSession {
  const from = findTrack(session, trackId)
  const target = findTrack(session, targetTrackId)
  const clip = findClip(from, clipId)
  const asset = findAsset(session, clip.assetId)
  const next = { ...clip, start: quantize(clamp(number(start, 'clip.start'), 0, DAW_MAX_DURATION - clip.duration), asset.sampleRate) }
  if (from.id === target.id) return replaceClip(session, from, next)
  return { ...session, tracks: session.tracks.map(track => track.id === from.id ? { ...track, clips: track.clips.filter(item => item.id !== clip.id) } : track.id === target.id ? { ...track, clips: [...track.clips, next] } : track) }
}
/** Non-destructive edge trim. Start can extend into source material preceding sourceIn. */
export function trimClip(session: DawSession, trackId: string, clipId: string, edge: 'start' | 'end', timelineTime: number): DawSession {
  const track = findTrack(session, trackId)
  const clip = findClip(track, clipId)
  const asset = findAsset(session, clip.assetId)
  const rate = asset.sampleRate
  number(timelineTime, 'clip.trimTime')
  let next: DawClip
  if (edge === 'start') {
    const oldFrames = samples(clip.duration, rate)
    const availableBefore = Math.min(samples(clip.sourceIn, rate), samples(clip.start, rate))
    const delta = clamp(samples(timelineTime - clip.start, rate), -availableBefore, oldFrames - 1)
    next = { ...clip, start: clip.start + delta / rate, sourceIn: (samples(clip.sourceIn, rate) + delta) / rate, duration: (oldFrames - delta) / rate }
    // Trimming moves the clip edge: preserve the fade boundary anchored to its source.
    next.fadeIn = Math.max(0, clip.fadeIn - delta / rate)
  } else if (edge === 'end') {
    const maxFrames = Math.min(sourceSamples(asset) - samples(clip.sourceIn, rate), Math.floor((DAW_MAX_DURATION - clip.start) * rate + 1e-6))
    const durationFrames = clamp(samples(timelineTime - clip.start, rate), 1, maxFrames)
    next = { ...clip, duration: durationFrames / rate, fadeOut: Math.max(0, clip.fadeOut + (durationFrames / rate - clip.duration)) }
  } else return fail('clip.edge', '裁切边缘必须为 start 或 end')
  next.envelope = sliceEnvelope(clip, next.sourceIn - clip.sourceIn, next.duration, rate)
  return replaceClip(session, track, constrainFades(next, rate))
}
/** Split preserves sample continuity and only carries edge fades on their original edges. */
export function splitClip(session: DawSession, trackId: string, clipId: string, timelineTime: number): DawSession {
  const track = findTrack(session, trackId)
  const clip = findClip(track, clipId)
  const rate = findAsset(session, clip.assetId).sampleRate
  number(timelineTime, 'clip.splitTime')
  const frames = samples(clip.duration, rate)
  const leftFrames = samples(timelineTime - clip.start, rate)
  if (leftFrames < 1 || leftFrames >= frames) return session
  if (clipCount(session) >= DAW_MAX_CLIPS) fail('clips', `最多允许 ${DAW_MAX_CLIPS} 个片段`)
  const leftDuration = leftFrames / rate
  const rightDuration = (frames - leftFrames) / rate
  const left = constrainFades({ ...clip, duration: leftDuration, fadeIn: Math.min(clip.fadeIn, leftDuration), fadeOut: Math.max(0, clip.fadeOut - rightDuration), envelope: sliceEnvelope(clip, 0, leftDuration, rate) }, rate)
  const right = constrainFades({ ...clip, ...(clip.effects === undefined ? {} : { effects: cloneEffectChain(clip.effects, true) }), id: newId(), start: clip.start + leftDuration, sourceIn: (samples(clip.sourceIn, rate) + leftFrames) / rate, duration: rightDuration, fadeIn: Math.max(0, clip.fadeIn - leftDuration), fadeOut: Math.min(clip.fadeOut, rightDuration), envelope: sliceEnvelope(clip, leftDuration, rightDuration, rate) }, rate)
  return replaceTrack(session, { ...track, clips: track.clips.flatMap(item => item.id === clip.id ? [left, right] : [item]) })
}
export function duplicateClip(session: DawSession, trackId: string, clipId: string, start?: number): DawSession {
  const track = findTrack(session, trackId)
  const clip = findClip(track, clipId)
  const rate = findAsset(session, clip.assetId).sampleRate
  if (clipCount(session) >= DAW_MAX_CLIPS) fail('clips', `最多允许 ${DAW_MAX_CLIPS} 个片段`)
  const position = start ?? clip.start + clip.duration
  const duplicate = { ...clip, ...(clip.effects === undefined ? {} : { effects: cloneEffectChain(clip.effects, true) }), id: newId(), start: quantize(clamp(number(position, 'clip.start'), 0, DAW_MAX_DURATION - clip.duration), rate) }
  return replaceTrack(session, { ...track, clips: [...track.clips, duplicate] })
}
export function deleteClip(session: DawSession, trackId: string, clipId: string): DawSession {
  const track = findTrack(session, trackId)
  findClip(track, clipId)
  return replaceTrack(session, { ...track, clips: track.clips.filter(clip => clip.id !== clipId) })
}
export function deleteTrack(session: DawSession, trackId: string): DawSession {
  findTrack(session, trackId)
  return { ...session, tracks: session.tracks.filter(track => track.id !== trackId) }
}

/** Validate untrusted saved documents without allowing malformed data into the engine. */
export function validateSession(input: unknown): DawValidationIssue[] {
  const issues: DawValidationIssue[] = []
  const error = (path: string, message: string) => { if (issues.length < 100) issues.push({ path, message }) }
  const numeric = (value: unknown, path: string, min: number, max: number, integer = false) => {
    if (!finite(value) || value < min || value > max || (integer && !Number.isInteger(value))) { error(path, `必须是 ${min}–${max} 范围内的${integer ? '整数' : '有限数字'}`); return false }
    return true
  }
  const text = (value: unknown, path: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 240) error(path, '必须是 1–240 字符的文字') }
  const id = (value: unknown, path: string) => { if (typeof value !== 'string' || !idPattern.test(value)) error(path, '标识格式不合法') }
  if (!object(input)) return [{ path: 'session', message: '工程必须是对象' }]
  if (input.schema !== DAW_SCHEMA) error('schema', '不是 Visiki DAW 工程')
  if (input.version !== DAW_VERSION) error('version', `不支持的工程版本：${String(input.version)}`)
  id(input.id, 'id'); text(input.name, 'name')
  numeric(input.sampleRate, 'sampleRate', 8000, 192000, true)
  numeric(input.masterDb, 'masterDb', -96, 12)
  const effectIds = new Set<string>()
  if (input.masterEffects !== undefined) for (const issue of validateEffectChain(input.masterEffects, 'masterEffects', effectIds)) error(issue.path, issue.message)
  if (input.musicalGrid !== undefined) {
    if (!object(input.musicalGrid)) error('musicalGrid', '小节网格设置必须为对象')
    else {
      numeric(input.musicalGrid.bpm, 'musicalGrid.bpm', 20, 300)
      numeric(input.musicalGrid.beatsPerBar, 'musicalGrid.beatsPerBar', 2, 12, true)
      if (![2, 4, 8, 16].includes(input.musicalGrid.beatUnit as number)) error('musicalGrid.beatUnit', '拍号分母必须是 2、4、8 或 16')
    }
  }
  if (!Array.isArray(input.assets) || input.assets.length > MAX_ASSETS) error('assets', `素材列表必须为数组且不超过 ${MAX_ASSETS} 项`)
  if (!Array.isArray(input.tracks) || input.tracks.length > DAW_MAX_TRACKS) error('tracks', `音轨列表必须为数组且不超过 ${DAW_MAX_TRACKS} 项`)
  const assets = new Map<string, Record<string, unknown>>()
  for (const [index, raw] of (Array.isArray(input.assets) ? input.assets.slice(0, MAX_ASSETS + 1) : []).entries()) {
    const path = `assets[${index}]`
    if (!object(raw)) { error(path, '素材必须是对象'); continue }
    id(raw.id, `${path}.id`); text(raw.name, `${path}.name`)
    if (typeof raw.id === 'string') { if (assets.has(raw.id)) error(`${path}.id`, '素材标识重复'); assets.set(raw.id, raw) }
    if (typeof raw.url !== 'string' || !assetUrlPattern.test(raw.url)) error(`${path}.url`, '仅允许本地 DAW 素材地址 /api/daw/assets/:id')
    numeric(raw.duration, `${path}.duration`, 1 / 192000, DAW_MAX_DURATION)
    numeric(raw.sampleRate, `${path}.sampleRate`, 8000, 192000, true)
    numeric(raw.channels, `${path}.channels`, 1, 2, true)
    if (raw.sampleCount !== undefined) {
      numeric(raw.sampleCount, `${path}.sampleCount`, 1, DAW_MAX_DURATION * 192000, true)
      if (finite(raw.sampleCount) && finite(raw.duration) && finite(raw.sampleRate) && Math.abs(raw.sampleCount - raw.duration * raw.sampleRate) > 1.01) error(`${path}.sampleCount`, '采样数量与素材时长不一致')
    }
    numeric(raw.peakHopSec, `${path}.peakHopSec`, 1 / 192000, DAW_MAX_DURATION)
    if (!Array.isArray(raw.peaks) || (raw.peaks.length !== 0 && raw.peaks.length !== raw.channels)) { error(`${path}.peaks`, '波形应为空或与声道数量一致'); continue }
    for (const [channelIndex, channel] of raw.peaks.entries()) {
      const channelPath = `${path}.peaks[${channelIndex}]`
      if (!object(channel) || !Array.isArray(channel.min) || !Array.isArray(channel.max) || channel.min.length !== channel.max.length || channel.min.length > MAX_PEAKS) { error(channelPath, '波形 min/max 必须是长度相同的数组'); continue }
      for (let point = 0; point < channel.min.length; point++) {
        const low = channel.min[point], high = channel.max[point]
        if (!finite(low) || !finite(high) || low < -1e6 || high > 1e6 || low > high) { error(`${channelPath}[${point}]`, '波形采样必须是 ±1e6 内的有限数字且 min ≤ max'); break }
      }
    }
  }
  const trackIds = new Set<string>(), clipIds = new Set<string>()
  let count = 0
  for (const [index, raw] of (Array.isArray(input.tracks) ? input.tracks.slice(0, DAW_MAX_TRACKS + 1) : []).entries()) {
    const path = `tracks[${index}]`
    if (!object(raw)) { error(path, '音轨必须是对象'); continue }
    id(raw.id, `${path}.id`); text(raw.name, `${path}.name`)
    if (typeof raw.id === 'string') { if (trackIds.has(raw.id)) error(`${path}.id`, '音轨标识重复'); trackIds.add(raw.id) }
    if (typeof raw.color !== 'string' || !colorPattern.test(raw.color)) error(`${path}.color`, '颜色必须为六位十六进制值')
    numeric(raw.volumeDb, `${path}.volumeDb`, -96, 24); numeric(raw.pan, `${path}.pan`, -1, 1)
    if (typeof raw.muted !== 'boolean') error(`${path}.muted`, '静音状态必须为布尔值')
    if (typeof raw.solo !== 'boolean') error(`${path}.solo`, '独奏状态必须为布尔值')
    if (raw.effects !== undefined) for (const issue of validateEffectChain(raw.effects, `${path}.effects`, effectIds)) error(issue.path, issue.message)
    if (!Array.isArray(raw.clips)) { error(`${path}.clips`, '片段列表必须为数组'); continue }
    count += raw.clips.length
    for (const [clipIndex, clip] of raw.clips.slice(0, DAW_MAX_CLIPS + 1).entries()) {
      const clipPath = `${path}.clips[${clipIndex}]`
      if (!object(clip)) { error(clipPath, '片段必须是对象'); continue }
      id(clip.id, `${clipPath}.id`); id(clip.assetId, `${clipPath}.assetId`); text(clip.name, `${clipPath}.name`)
      if (clip.effects !== undefined) {
        for (const issue of validateEffectChain(clip.effects, `${clipPath}.effects`, effectIds)) error(issue.path, issue.message)
        if (Array.isArray(clip.effects) && clip.effects.some(effect => object(effect) && effect.type === 'vst3')) error(`${clipPath}.effects`, 'VST3 暂不支持片段效果链')
      }
      if (typeof clip.id === 'string') { if (clipIds.has(clip.id)) error(`${clipPath}.id`, '片段标识重复'); clipIds.add(clip.id) }
      const asset = typeof clip.assetId === 'string' ? assets.get(clip.assetId) : undefined
      if (!asset) error(`${clipPath}.assetId`, '片段引用的素材不存在')
      numeric(clip.start, `${clipPath}.start`, 0, DAW_MAX_DURATION)
      numeric(clip.sourceIn, `${clipPath}.sourceIn`, 0, DAW_MAX_DURATION)
      const sampleRate = asset && finite(asset.sampleRate) ? asset.sampleRate : 192000
      numeric(clip.duration, `${clipPath}.duration`, 1 / sampleRate, DAW_MAX_DURATION)
      numeric(clip.gainDb, `${clipPath}.gainDb`, -96, 24)
      numeric(clip.fadeIn, `${clipPath}.fadeIn`, 0, DAW_MAX_DURATION)
      numeric(clip.fadeOut, `${clipPath}.fadeOut`, 0, DAW_MAX_DURATION)
      const tolerance = 1 / sampleRate + 1e-8
      if (finite(clip.start) && finite(clip.duration) && clip.start + clip.duration > DAW_MAX_DURATION + 1e-8) error(clipPath, '片段结束位置超过 1 小时工程上限')
      if (asset && finite(asset.duration) && finite(clip.sourceIn) && finite(clip.duration) && clip.sourceIn + clip.duration > asset.duration + tolerance) error(clipPath, '片段超出源素材范围')
      if (finite(clip.fadeIn) && finite(clip.fadeOut) && finite(clip.duration) && clip.fadeIn + clip.fadeOut > clip.duration + 1e-8) error(clipPath, '淡入与淡出总长不能超过片段时长')
      for (const field of ['start', 'sourceIn', 'duration', 'fadeIn', 'fadeOut'] as const) if (finite(clip[field]) && Math.abs(clip[field] * sampleRate - Math.round(clip[field] * sampleRate)) > 1e-4) error(`${clipPath}.${field}`, '时间必须位于源采样边界')
      if (clip.envelope !== undefined) {
        if (!Array.isArray(clip.envelope) || clip.envelope.length < 2 || clip.envelope.length > 16) error(`${clipPath}.envelope`, '继承包络必须包含 2–16 个节点')
        else {
          let previousTime = -1
          for (const [pointIndex, point] of clip.envelope.entries()) {
            const pointPath = `${clipPath}.envelope[${pointIndex}]`
            if (!object(point)) { error(pointPath, '包络节点必须是对象'); continue }
            numeric(point.time, `${pointPath}.time`, 0, finite(clip.duration) ? clip.duration : DAW_MAX_DURATION)
            numeric(point.gain, `${pointPath}.gain`, 0, 1)
            if (finite(point.time)) {
              if (point.time <= previousTime) error(`${pointPath}.time`, '包络时间必须严格递增')
              if (Math.abs(point.time * sampleRate - Math.round(point.time * sampleRate)) > 1e-4) error(`${pointPath}.time`, '包络必须位于源采样边界')
              if ((pointIndex === 0 && point.time !== 0) || (pointIndex === clip.envelope.length - 1 && finite(clip.duration) && Math.abs(point.time - clip.duration) > 1e-8)) error(`${pointPath}.time`, '包络必须包含片段开始和结束节点')
              previousTime = point.time
            }
          }
        }
      }
    }
  }
  if (count > DAW_MAX_CLIPS) error('clips', `最多允许 ${DAW_MAX_CLIPS} 个片段`)
  return issues
}

/** Rebuild known fields only; no input object references or unknown properties survive. */
export function parseSession(input: string | unknown): DawSession {
  let document: unknown = input
  if (typeof input === 'string') {
    if (input.length > MAX_JSON_LENGTH) fail('session', '工程文件过大（上限 24 MiB）')
    try { document = JSON.parse(input) } catch { fail('session', '工程 JSON 格式损坏，无法读取') }
  }
  const issues = validateSession(document)
  if (issues.length) throw new DawValidationError(issues)
  const data = document as DawSession
  return {
    schema: DAW_SCHEMA, version: DAW_VERSION, id: data.id, name: data.name, sampleRate: data.sampleRate, masterDb: data.masterDb,
    musicalGrid: getMusicalGrid(data),
    ...(data.masterEffects === undefined ? {} : { masterEffects: cloneEffectChain(data.masterEffects) }),
    assets: data.assets.map(asset => ({ id: asset.id, name: asset.name, url: asset.url, duration: asset.duration, sampleRate: asset.sampleRate, ...(asset.sampleCount === undefined ? {} : { sampleCount: asset.sampleCount }), channels: asset.channels, peakHopSec: asset.peakHopSec, peaks: asset.peaks.map(channel => ({ min: [...channel.min], max: [...channel.max] })) })),
    tracks: data.tracks.map(track => ({ id: track.id, name: track.name, color: track.color, volumeDb: track.volumeDb, pan: track.pan, muted: track.muted, solo: track.solo, ...(track.effects === undefined ? {} : { effects: cloneEffectChain(track.effects) }), clips: track.clips.map(clip => ({ id: clip.id, assetId: clip.assetId, name: clip.name, start: clip.start, sourceIn: clip.sourceIn, duration: clip.duration, gainDb: clip.gainDb, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, ...(clip.effects === undefined ? {} : { effects: cloneEffectChain(clip.effects) }), ...(clip.envelope ? { envelope: clip.envelope.map(point => ({ time: point.time, gain: point.gain })) } : {}) })) }))
  }
}
/** Waveforms are a derived server cache, never duplicated into project saves/history. */
export function withoutDawWaveforms(session: DawSession): DawSession {
  return { ...session, assets: session.assets.map(asset => ({ ...asset, peaks: [] })) }
}
export function serializeSession(session: DawSession): string {
  const document = withoutDawWaveforms(session)
  const issues = validateSession(document)
  if (issues.length) throw new DawValidationError(issues)
  return JSON.stringify(document, null, 2)
}
