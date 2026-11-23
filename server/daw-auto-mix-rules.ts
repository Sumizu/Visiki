import type { DawSession, DawTrack } from '../src/daw/model'
import type { AutoMixChange, AutoMixOptions, AutoMixPlan, AutoMixRange, AutoMixScan, AutoMixSection } from '../src/daw/auto-mix'
import { remainingDawEffectSlots } from '../src/daw/effects'
import { sessionDuration } from '../src/daw/model'
import { createHash } from 'node:crypto'

// The scanner's track tap is aligned, post inserts and pan, but pre fader.
// A sidechain detector, in contrast, listens to the raw pre-insert signal.
type Frame = AutoMixScan['tracks'][number]['frames'][number]
type Role = 'lead' | 'harmony' | 'backing'
type Row = { time: number; duration: number; lead?: Frame; harmony?: Frame; backing?: Frame }
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const round = (n: number) => Math.round(n * 10) / 10
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const quantile = (values: number[], q: number): number | undefined => {
  const xs = values.filter(finite).sort((a, b) => a - b)
  if (!xs.length) return undefined
  const i = (xs.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)
}
const inRange = (time: number, ranges: AutoMixRange[]) => ranges.some(r => time >= r.start && time < r.end)
const level = (f: Frame, t: DawTrack) => f.kDb + t.volumeDb
const changeId = (kind: string, id: string) => `automix-${kind}-${id.slice(0, 80)}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`

/** Find a quiet, stationary passage for the existing spectral noise learner. */
export function findAutoMixNoiseRange(frames: Frame[]): AutoMixRange | undefined {
  const vocalDb = quantile(frames.map(frame => frame.rmsDb).filter(db => db > -82), .85)
  if (vocalDb === undefined) return undefined
  const quietLimit = Math.min(-38, vocalDb - 17)
  let range: AutoMixRange | undefined
  let quietest = Infinity
  // Four 200 ms windows leave enough material after trimming the boundaries.
  for (let index = 3; index < frames.length; index++) {
    const quiet = frames.slice(index - 3, index + 1)
    if (!quiet.every((frame, i) => frame.duration >= .17 && frame.rmsDb > -82 &&
        frame.rmsDb <= quietLimit && frame.peakDb - frame.rmsDb <= 18 &&
        (!i || Math.abs(frame.time - quiet[i - 1].time - quiet[i - 1].duration) < .01))) continue
    const levels = quiet.map(frame => frame.rmsDb)
    const average = levels.reduce((sum, db) => sum + db, 0) / quiet.length
    if (average >= quietest || Math.max(...levels) - Math.min(...levels) > 3) continue
    const stable = quiet[0].bandsDb.every((_, band) => {
      const relative = quiet.map(frame => frame.bandsDb[band] - frame.rmsDb)
      const highest = Math.max(...relative)
      return highest < -24 || highest - Math.min(...relative) <= 6
    })
    if (!stable) continue
    const last = quiet[quiet.length - 1]
    range = { start: quiet[0].time + .06, end: last.time + last.duration - .06 }
    quietest = average
  }
  return range
}

/** Calculate track chains from the measured signal and conservative role defaults. */
export function proposeAutoMix(session: DawSession, options: AutoMixOptions, scan: AutoMixScan): AutoMixPlan {
  const notes: string[] = []
  const changes: AutoMixChange[] = []
  const sections: AutoMixSection[] = []
  const duration = sessionDuration(session)
  const excluded = new Set(options.excludedChangeIds)
  const roles = ['lead', 'harmony', 'backing'] as const
  const tracks: Partial<Record<Role, DawTrack>> = {}
  const roleFrames: Record<Role, Frame[]> = { lead: [], harmony: [], backing: [] }
  const assignedIds = new Set<string>()
  for (const role of roles) {
    const id = options.roles[role]
    if (!id || assignedIds.has(id)) continue
    assignedIds.add(id)
    const track = session.tracks.find(t => t.id === id)
    const measured = scan.tracks.find(t => t.id === id)
    if (track && measured) { tracks[role] = track; roleFrames[role] = measured.frames }
  }
  const { lead, harmony, backing } = tracks
  const output = scan.output
  if (!scan.complete || !lead || !backing || (options.roles.harmony && !harmony)) {
    return { changes, sections, handoffs: [], notes: ['扫描不完整或音轨角色无效，未生成混音调整。'], output }
  }

  // Frames have project-time positions: join by overlapping intervals, not by ordinal
  // array position. This remains correct when a source begins late or has gaps.
  const rows: Row[] = []
  const cursors: Record<Role, number> = { lead: 0, harmony: 0, backing: 0 }
  const sorted = Object.fromEntries(roles.map(role => [role, [...roleFrames[role]].filter(f => finite(f.time) && finite(f.duration) && f.duration > 0).sort((a, b) => a.time - b.time)])) as Record<Role, Frame[]>
  const thresholds = {} as Record<Role, number>
  for (const role of roles) {
    const values = sorted[role].map(frame => frame.rmsDb)
    const loud = quantile(values, .92) ?? -120, floor = quantile(values, .22) ?? -120
    const noiseGate = loud - floor > 20 ? floor + 8 : -120
    thresholds[role] = Math.max(role === 'backing' ? -66 : -70, loud - 33, noiseGate)
  }
  const active = (frame: Frame | undefined, role: Role) =>
    !!frame && finite(frame.kDb) && finite(frame.rmsDb) && frame.rmsDb > thresholds[role] && frame.kDb > -73
  const times = [...new Set(Object.values(sorted).flatMap(fs => fs.map(f => f.time)))].sort((a, b) => a - b)
  for (const time of times) {
    const row: Row = { time, duration: Math.max(.001, scan.hopSec) }
    for (const role of roles) {
      const fs = sorted[role]
      while (cursors[role] < fs.length && fs[cursors[role]].time + fs[cursors[role]].duration <= time + 1e-7) cursors[role]++
      const f = fs[cursors[role]]
      if (f && f.time <= time + 1e-7 && f.time + f.duration > time + 1e-7) { row[role] = f; row.duration = Math.min(row.duration, f.time + f.duration - time) }
    }
    rows.push(row)
  }
  const requestedHandoffs = harmony
    ? (options.handoffs ?? []).filter(r => finite(r.start) && finite(r.end) && r.start >= 0 && r.end > r.start) : []
  const autoHandoffs: AutoMixRange[] = []
  if (harmony && options.harmony !== 'support') {
    let lastSolo: { role: 'lead' | 'harmony'; end: number } | undefined
    for (const row of rows) {
      const l = active(row.lead, 'lead'), h = active(row.harmony, 'harmony')
      if (l === h) continue
      const role = l ? 'lead' : 'harmony'
      if (lastSolo && role !== lastSolo.role && row.time - lastSolo.end <= 1.2) {
        const candidate = { start: Math.max(0, row.time - .6), end: Math.min(duration, row.time + .6) }
        if (autoHandoffs.length < 32 && candidate.end - candidate.start >= .02 &&
            !autoHandoffs.some(x => candidate.start <= x.end)) autoHandoffs.push(candidate)
      }
      lastSolo = { role, end: row.time + row.duration }
    }
  }
  const handoffs = options.handoffs === undefined ? autoHandoffs : requestedHandoffs
  const labelFor: Record<AutoMixSection['kind'], string> = { lead: '主唱', harmony: '和声', handoff: '人声交接', backing: '伴奏', ending: '尾段' }
  for (const row of rows) {
    const l = active(row.lead, 'lead'), h = active(row.harmony, 'harmony'), b = active(row.backing, 'backing')
    if (!l && !h && !b) continue
    const kind: AutoMixSection['kind'] = inRange(row.time + row.duration / 2, handoffs) && (l || h) ? 'handoff' : l && !h ? 'lead' : h ? 'harmony' : 'backing'
    const prev = sections[sections.length - 1]
    if (prev && prev.kind === kind && row.time <= prev.end + .05) prev.end = row.time + row.duration
    else sections.push({ id: `automix-section-${sections.length + 1}`, kind, label: labelFor[kind], start: row.time, end: row.time + row.duration })
  }
  const representatives: AutoMixSection[] = []
  for (const kind of ['lead', 'harmony', 'handoff', 'backing'] as const) {
    const candidates = sections.filter(section => section.kind === kind).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    for (const candidate of candidates.slice(0, kind === 'handoff' ? 4 : 2)) {
      if (candidate.end - candidate.start >= .4) representatives.push(candidate)
    }
  }
  const dense = rows.filter(row => active(row.lead, 'lead') && active(row.backing, 'backing'))
  const loudBacking = quantile(dense.map(row => row.backing!.kDb), .85)
  const denseRow = loudBacking === undefined ? undefined : dense.find(row => row.backing!.kDb >= loudBacking)
  if (denseRow) representatives.push({ id: 'automix-section-dense', kind: 'lead', label: '伴奏较密', start: Math.max(0, denseRow.time - 2), end: Math.min(duration, denseRow.time + 6) })
  if (duration > .02) representatives.push({ id: 'automix-section-ending', kind: 'ending', label: '尾段', start: Math.max(0, duration - 8), end: duration })

  // Use paired active windows only. Median rejection keeps a few loud notes from
  // determining the balance and never tries to normalize unrelated song sections.
  const adjustment: Record<Role, number> = { lead: 0, harmony: 0, backing: 0 }
  const sufficient = (rs: Row[]) => rs.length >= 8 && rs.reduce((n, row) => n + row.duration, 0) >= 1.5
  const pair = (a: Role, b: Role, excludeHandoffs = false) => rows.filter(row => active(row[a], a) && active(row[b], b) && (!excludeHandoffs || !inRange(row.time + row.duration / 2, handoffs)))
  const balance = (a: Role, b: Role, target: number, excludeHandoffs = false) => {
    const first = tracks[a], second = tracks[b]
    if (!first || !second) return
    const rs = pair(a, b, excludeHandoffs)
    if (!sufficient(rs)) return
    const diffs = rs.map(row => level(row[a]!, first) + adjustment[a] - level(row[b]!, second) - adjustment[b])
    const median = quantile(diffs, .5)!, spread = quantile(diffs, .8)! - quantile(diffs, .2)!
    if (spread > 12 || Math.abs(median - target) < 1.5) return
    // Attenuation-first keeps peak headroom. One bounded fader change per role.
    if (median < target) adjustment[b] -= clamp(target - median, 0, 4)
    else adjustment[a] -= clamp(median - target, 0, 3)
  }
  const genreOffset = options.genre === 'rock' ? .5 : options.genre === 'pop' ? .3 : options.genre === 'acoustic' ? -.5 : 0
  const backingMargin = (options.direction === 'forward' ? 4 : options.direction === 'natural' ? 1.5 : -.5) + genreOffset
  const leadOverlap = sufficient(pair('lead', 'backing'))
  const hasAlternateLead = !!harmony && options.harmony !== 'support'
  if (leadOverlap) balance('lead', 'backing', backingMargin)
  else if (hasAlternateLead) balance('harmony', 'backing', backingMargin)
  if (harmony) {
    const vocalMargin = options.harmony === 'support' ? 3 : options.harmony === 'duet' ? 0 : 1.5
    balance('lead', 'harmony', vocalMargin, hasAlternateLead)
  }
  if (harmony && hasAlternateLead && adjustment.harmony < 0) {
    const alternateLead = pair('harmony', 'backing').filter(row => !active(row.lead, 'lead') || inRange(row.time + row.duration / 2, handoffs))
    if (sufficient(alternateLead)) {
      const relative = quantile(alternateLead.map(row => level(row.harmony!, harmony) -
        level(row.backing!, backing) - adjustment.backing), .5)!
      const minimum = backingMargin - 4
      adjustment.harmony = Math.max(adjustment.harmony, Math.min(0, minimum - relative))
      if (relative + adjustment.harmony < minimum + .5) notes.push('已保留接唱段的和声电平，可试听接唱与伴奏的平衡。')
    }
  }
  for (const role of roles) {
    const track = tracks[role]
    if (!track) continue
    const deltaDb = round(clamp(adjustment[role], -4, 0))
    const id = changeId('fader', track.id)
    if (deltaDb <= -.5) changes.push({ id, kind: 'fader', target: track.id, label: `${track.name}音量`, reason: '依据同时有声片段的 K 加权电平中位差，保留各段原有动态。', deltaDb })
    adjustment[role] = excluded.has(id) ? 0 : deltaDb
  }
  if (!leadOverlap) notes.push(hasAlternateLead && sufficient(pair('harmony', 'backing')) ? '主唱与伴奏的重叠不足，平衡参考了另一人声与伴奏的重叠片段。' : '主唱与伴奏同时有声的有效片段不足，未自动调整两者平衡。')
  if (autoHandoffs.length && !requestedHandoffs.length) notes.push('已标出可能的人声交接位置；请试听确认。')

  // Effects are planned from the bypassed track signal. Clip effects remain part of
  // that signal, but never substitute for a track insert or alter clip contents.
  for (const role of ['lead', 'harmony'] as const) {
    const t = tracks[role]
    if (!t) continue
    const activeFrames = sorted[role].filter(frame => active(frame, role))
    const fs = activeFrames.length ? activeFrames : sorted[role].filter(frame => finite(frame.rmsDb) && frame.rmsDb > -75)
    if (!fs.length) notes.push(`${t.name}可测人声不足，使用轻度人声链的默认参数。`)
    if (fs.some(f => finite(f.peakDb) && f.peakDb >= -.1)) notes.push(`${t.name}扫描点出现接近或超过满刻度的峰值；请试听并检查录音。`)
    if (role === 'lead') {
      changes.push({ id: changeId('denoise', t.id), kind: 'effect', target: t.id, type: 'denoise',
        params: { spectralEnabled: 1, humEnabled: 0, dereverbEnabled: 0, reductionDb: 5, sensitivity: 45, transient: 82, smoothing: 1, mix: 80 },
        label: `${t.name}轻度去噪`, reason: '未找到可用的稳定底噪样本。可在去噪窗口选取一段底噪进行学习。' })
    }
    const vocalLow = quantile(fs.map(f => f.peakDb), .1) ?? -55
    const typicalVocalDb = quantile(fs.map(f => f.rmsDb), .65) ?? -62
    const quiet = sorted[role].filter(f => finite(f.rmsDb) && f.rmsDb > -90 && f.rmsDb < typicalVocalDb - 15 && finite(f.peakDb))
    const noisePeak = quiet.length >= 6 ? quantile(quiet.map(f => f.peakDb), .8) : undefined
    // The gate detects peaks, so use peak measurements and leave ample room for
    // soft syllables. A modest range avoids hard-cutting breaths and tails.
    const gateThreshold = finite(noisePeak) ? Math.min(noisePeak + 3, vocalLow - 10) : Math.min(-65, vocalLow - 10)
    changes.push({ id: changeId('gate', t.id), kind: 'effect', target: t.id, type: 'gate',
      params: { thresholdDb: round(clamp(gateThreshold, -90, -40)), rangeDb: 6, ratio: 1.5, attackMs: 2, holdMs: 180, releaseMs: 320, hysteresisDb: 4, sidechainHpHz: 35, sidechainLpHz: 20000 },
      label: `${t.name}门限／扩展器`, reason: finite(noisePeak) ? '根据停顿噪声和较轻的人声峰值设置低门限，减轻间隙噪声并保留气声与尾音。' : '使用低门限和有限衰减保护轻声歌词。' })

    const support = role === 'harmony' && options.harmony === 'support'
    const body = quantile(fs.map(frame => frame.bandsDb[2] - frame.rmsDb), .6)
    const lowMid = quantile(fs.map(frame => frame.bandsDb[3] - frame.rmsDb), .65)
    const bass = quantile(fs.map(frame => frame.bandsDb[1] - frame.rmsDb), .85)
    const presence = quantile(fs.map(frame => frame.bandsDb[6] - frame.rmsDb), .6)
    const cutoff = finite(bass) && bass > -10 ? 45 : support ? 70 : 55
    const warmth = round(clamp((lowMid ?? -14) + 15, .7, support ? 1.9 : 1.5))
    const presenceGain = support ? -.8 : (presence ?? -16) > -8 ? -.4 : .7
    changes.push({ id: changeId('eq', t.id), kind: 'effect', target: t.id, type: 'eq',
      params: { band1Enabled: 1, band1Type: 3, band1Freq: cutoff, band1Slope: 0,
        band3Enabled: 1, band3Type: 0, band3Freq: (body ?? -16) > -7 ? 360 : 300, band3Q: .85, band3Gain: -warmth,
        band5Enabled: 1, band5Type: 0, band5Freq: 2700, band5Q: .8, band5Gain: presenceGain, outputDb: 0 },
      label: `${t.name}参数 EQ`, reason: support ? '浅削低中频与清晰度频段，为主唱留出空间。' : '高通去除过低频率，并轻调低中频与清晰度。' })

    const detector = fs.map(f => f.detectorDb).filter(finite)
    const low = quantile(detector, .3), high = quantile(detector, .9)
    const fallbackLevel = quantile(fs.map(f => f.rmsDb), .8) ?? -35
    const ratio = options.genre === 'acoustic' ? 1.5 : options.genre === 'rock' ? 1.8 : 1.6
    const threshold = finite(low) && finite(high) ? Math.max(low + .5, high - (role === 'harmony' ? 1.2 : 1.5) / (1 - 1 / ratio)) : fallbackLevel + 3
    const compressorPosition = changes.length
    changes.push({ id: changeId('compressor', t.id), kind: 'effect', target: t.id, type: 'compressor',
      params: { thresholdDb: round(clamp(threshold, -60, 0)), ratio, attackMs: 20, releaseMs: 160, kneeDb: 6, makeupDb: 0, detector: 1, mix: 100 },
      label: `${t.name}轻度压缩`, reason: detector.length >= 6 ? '依据检测电平设置温和压缩，保留人声自然动态。' : '检测证据有限，采用保守阈值及低压缩比。' })

    const candidate = [0, 1, 2].map(index => {
      const ratio = (f: Frame) => f.sibilance?.[index]?.ratioDb ?? -120
      const envelope = (f: Frame) => f.sibilance?.[index]?.envelopeDb ?? -120
      const typical = quantile(fs.map(ratio).filter(value => value > -119), .5) ?? -120
      const transient = fs.filter(f => ratio(f) > Math.max(-17, typical + 7) && envelope(f) > -59)
      const events = transient.filter((frame, i) => !i || frame.time - transient[i - 1].time > scan.hopSec * 1.5)
      const ordinaryPeak = quantile(fs.filter(frame => ratio(frame) <= typical + 5).map(envelope), .85) ?? -120
      const essPeak = quantile(transient.map(envelope), .5) ?? -120
      return { index, events, ordinaryPeak, essPeak, contrast: quantile(events.map(ratio), .5) ?? -120, fraction: transient.length / Math.max(1, fs.length) }
    }).filter(item => item.events.length >= 2 && item.fraction <= .52 && item.essPeak >= item.ordinaryPeak + 2.5)
      .sort((a, b) => b.contrast - a.contrast || b.events.length - a.events.length)[0]
    const fallbackEnvelope = quantile(fs.map(f => f.sibilance?.[1]?.envelopeDb ?? -120).filter(v => v > -119), .9)
    const deessThreshold = candidate ? Math.max(candidate.ordinaryPeak + .5, candidate.essPeak - 3.2) : finite(fallbackEnvelope) ? fallbackEnvelope + 3 : -18
    const deesser: AutoMixChange = { id: changeId('deesser', t.id), kind: 'effect', target: t.id, type: 'deesser',
      params: { freqHz: candidate ? Math.round([Math.sqrt(4000 * 6000), Math.sqrt(6000 * 8000), Math.sqrt(8000 * 12000)][candidate.index]) : 6500,
        bandwidthOct: 1.7, thresholdDb: round(clamp(deessThreshold, -60, 0)), rangeDb: candidate ? 2 : 1, attackMs: 1, releaseMs: 80, mode: 1, mix: 100 },
      label: `${t.name}轻度齿音控制`, reason: candidate ? '根据重复齿音的检测包络设置频率与阈值。' : '齿音证据有限，使用较高阈值和较小抑制范围。' }
    const loudEvents = candidate?.events.filter(frame => (frame.detectorDb ?? frame.rmsDb) > (high ?? -20)).length ?? 0
    if (candidate && loudEvents >= candidate.events.length * .5) changes.splice(compressorPosition, 0, deesser)
    else changes.push(deesser)

    if (role === 'harmony') {
      const correlation = quantile(fs.map(frame => frame.stereo?.correlation ?? NaN), .5) ?? 1
      const width = correlation < .2 ? 92 : correlation < .65 ? 100 : support ? 112 : 106
      changes.push({ id: changeId('modulation', t.id), kind: 'effect', target: t.id, type: 'modulation',
        params: { mode: 0, rateHz: .33, depth: support ? 20 : 14, delayMs: 17, phaseDegrees: 108, mix: support ? 10 : 6, sync: 0 },
        label: `${t.name}轻合唱`, reason: '低比例混合合唱声，为和声增加层次并保留主要字头。' })
      changes.push({ id: changeId('stereo', t.id), kind: 'effect', target: t.id, type: 'stereo',
        params: { width, balance: 0, monoBelowHz: 120 },
        label: `${t.name}立体声工具`, reason: width > 100 ? '轻微展开集中的和声，低频保持居中。' : '约束已有的立体声宽度，低频保持居中。' })
    }

    if (options.space !== 'unchanged' && options.spaceAmount > 0) {
      const plate = options.space === 'plate'
      const gaps = fs.slice(1).map((frame, i) => frame.time - fs[i].time - fs[i].duration).filter(gap => gap >= .16 && gap <= 2)
      const gap = quantile(gaps, .35)
      const decay = plate ? clamp((gap ?? .65) * 2, .65, 1.8) : clamp(gap ?? .55, .25, .65)
      const amount = clamp(options.spaceAmount, 0, 100) * (support ? .24 : .18)
      const delayTimes = support ? [95, 131] : plate ? [105, 147] : [73, 101]
      changes.push({ id: changeId('delay', t.id), kind: 'effect', target: t.id, type: 'delay',
        params: { timeMs: delayTimes[0], timeRightMs: delayTimes[1], sync: 0, feedback: 8, lowCutHz: 250, highCutHz: 5000, pingPong: 0, width: 100, mix: Math.round(clamp(options.spaceAmount * (plate ? .17 : .12), 1, 12)), outputDb: 0 },
        label: `${t.name}短立体声延迟`, reason: '用低混合比例和滤波后的短延迟增加空间，不掩盖歌词。' })
      changes.push({ id: changeId('reverb', t.id), kind: 'effect', target: t.id, type: 'reverb',
        params: { size: plate ? 65 : 25, decaySec: round(decay), preDelayMs: plate ? role === 'lead' ? 32 : 22 : 8, earlyMix: plate ? 20 : 55, earlyPattern: plate ? 3 : 1, lowCutHz: plate ? 180 : 150, mix: Math.max(1, Math.round(amount)) },
        label: `${t.name}${plate ? '板式' : '房间'}混响`, reason: '按空间选项和发声间隔设置混响。' })
    }
  }

  // Native sidechain listens to the raw source before inserts. Its smooth
  // trigger uses post-fader RMS, rather than spectral peak detector levels.
  const leadFrames = sorted.lead.filter(frame => active(frame, 'lead'))
  const measuredLead = leadFrames.map(frame => frame.keyRmsDb ?? frame.rmsDb).filter(finite)
  const leadLow = quantile(measuredLead, .2) ?? -38
  const idle = sorted.lead.map(frame => frame.keyRmsDb ?? frame.rmsDb).filter(db => db > -85 && db < leadLow - 12)
  const floor = idle.length >= 4 ? quantile(idle, .8) : undefined
  const rawThreshold = finite(floor) ? clamp(leadLow - 8, floor + 6, leadLow - 5) : leadLow - 8
  const keyThreshold = round(clamp(rawThreshold + lead.volumeDb + adjustment.lead, -60, -18))
  if (harmony) {
    const overlap = pair('lead', 'harmony')
    const support = options.harmony === 'support'
    const harmonyBalance: AutoMixChange = { id: changeId('ducker', harmony.id), kind: 'effect', target: harmony.id, type: 'ducker', sidechainTrackId: lead.id,
      params: { mode: 1, smoothTrigger: 1, thresholdDb: keyThreshold, depthDb: support ? 4.5 : 2, marginDb: support ? 5 : 1, attackMs: 42, holdMs: 75, releaseMs: 230, hysteresisDb: 4 },
      label: `${harmony.name}动态人声平衡`, reason: sufficient(overlap) ? '主唱发声时轻柔调整重叠人声，独唱与接唱自然恢复。' : '按保守幅度设置动态平衡，主唱停顿时恢复原声。' }
    const harmonyChorus = changes.findIndex(change => change.target === harmony.id && change.kind === 'effect' && change.type === 'modulation')
    changes.splice(harmonyChorus, 0, harmonyBalance)
  }

  {
    const backingFrames = sorted.backing.filter(frame => active(frame, 'backing'))
    const channelDifferences = backingFrames.flatMap(({ stereo }) =>
      stereo && stereo.leftDb > -74 && stereo.rightDb > -74 ? [stereo.leftDb - stereo.rightDb] : [])
    const channelDelta = quantile(channelDifferences, .5) ?? 0
    const persistent = channelDifferences.filter(delta => Math.sign(channelDelta) * delta >= 2).length
    if (Math.abs(backing.pan) <= .05 && Math.abs(channelDelta) >= 3 &&
        channelDifferences.length >= 8 && persistent >= channelDifferences.length * .75) {
      // Stereo.balance attenuates the louder side linearly. Correct only part
      // of the measured difference to preserve the original stereo image.
      const correctionDb = Math.min(3, Math.abs(channelDelta) * .65)
      const balance = Math.round(100 * Math.sign(channelDelta) * (1 - 10 ** (-correctionDb / 20)))
      changes.push({ id: changeId('stereo', backing.id), kind: 'effect', target: backing.id, type: 'stereo',
        params: { width: 100, balance }, label: `${backing.name}立体声工具`,
        reason: `伴奏持续偏${channelDelta > 0 ? '左' : '右'}约 ${round(Math.abs(channelDelta))} dB，轻调偏响声道。` })
    } else {
      const lowMid = quantile(backingFrames.map(frame => frame.bandsDb[3] - frame.rmsDb), .65)
      const gain = -round(clamp((lowMid ?? -18) + 18, .5, 1.2))
      changes.push({ id: changeId('eq', backing.id), kind: 'effect', target: backing.id, type: 'eq',
        params: { band3Enabled: 1, band3Type: 0, band3Freq: 360, band3Q: .8, band3Gain: gain, outputDb: 0 },
        label: `${backing.name}参数 EQ`, reason: '小幅整理伴奏的低中频，减轻它与人声的堆叠。' })
    }

    const rs = pair('lead', 'backing')
    const bands = [5, 6].map(index => {
      const values = rs.filter(row => finite(row.lead!.bandsDb?.[index]) && finite(row.backing!.bandsDb?.[index]))
        .map(row => Math.min(row.lead!.bandsDb[index] - row.lead!.rmsDb, row.backing!.bandsDb[index] - row.backing!.rmsDb))
      return { index, score: quantile(values, .5), count: values.length }
    }).filter(item => item.count >= 8 && finite(item.score) && item.score > -26).sort((a, b) => b.score! - a.score!)
    const bandHz = sufficient(rs) && bands.length ? (bands[0].index === 5 ? 1414 : 2828) : 2100
    changes.push({ id: changeId('ducker', backing.id), kind: 'effect', target: backing.id, type: 'ducker', sidechainTrackId: lead.id,
      params: { mode: 2, smoothTrigger: 1, bandHz, bandQ: .95, thresholdDb: keyThreshold, depthDb: 2.8, marginDb: 2, attackMs: 43, holdMs: 105, releaseMs: 280, hysteresisDb: 5 },
      label: `${backing.name}人声频段让位`, reason: sufficient(rs) && bands.length ? '依据重叠人声和伴奏频段选择宽缓的动态让位，仅在人声发声时轻微衰减。' : '重叠频谱证据有限，使用保守的人声频段与浅幅动态让位。' })
  }
  const available = new Map(Object.values(tracks).map(track => [track.id, remainingDawEffectSlots(track.effects ?? [])]))
  const filtered = changes.filter(change => {
    if (change.kind !== 'effect' || excluded.has(change.id)) return true
    const remaining = available.get(change.target) ?? 0
    if (remaining <= 0) {
      notes.push(`${change.label}未添加，轨道效果链已满。`)
      return false
    }
    available.set(change.target, remaining - 1)
    return true
  })
  return { changes: filtered, sections: representatives, handoffs, notes, output }
}
