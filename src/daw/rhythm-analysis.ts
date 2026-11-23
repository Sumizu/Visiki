/**
 * Lightweight, dependency-free rhythm suggestions for a bounded mono excerpt.
 *
 * This is an original implementation of the usual onset-envelope / normalized
 * autocorrelation approach, followed by pulse phase fitting. It does not perform
 * source separation, neural downbeat tracking or infer musical notation from
 * audio. In particular, a regular pulse is not evidence of a time signature.
 * The caller should present the result for confirmation rather than apply it
 * silently. Source audio stays untouched.
 */
export const DAW_RHYTHM_ALGORITHM_VERSION = 'onset-acf-2'

export interface DawTempoCandidate { bpm: number; score: number }
export interface DawMeterCandidate { beatsPerBar: number; beatUnit: 4 | 8; score: number }
export interface DawRhythmAnalysis {
  bpm: number | null
  confidence: number
  tempoCandidates: DawTempoCandidate[]
  meter: { beatsPerBar: number; beatUnit: 4 | 8; confidence: number } | null
  meterCandidates: DawMeterCandidate[]
  beatTimes: number[]
  analyzedSeconds: number
  warnings: string[]
  algorithmVersion: string
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const mean = (values: ArrayLike<number>) => {
  let sum = 0
  for (let index = 0; index < values.length; index++) sum += values[index]
  return sum / Math.max(1, values.length)
}
function quantile(values: ArrayLike<number>, fraction: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0
}
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

interface Envelopes { onset: Float64Array; accent: Float64Array; rms: Float64Array; rate: number }

/** Three inexpensive one-pole bands keep bass pulses from being hidden by hats. */
function onsetEnvelopes(samples: Float32Array, sampleRate: number): Envelopes {
  const hop = Math.max(1, Math.round(sampleRate / 100))
  const count = Math.floor(samples.length / hop)
  const bands = [new Float64Array(count), new Float64Array(count), new Float64Array(count)]
  const rms = new Float64Array(count)
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate)
  const highAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(1800, sampleRate * .35) / sampleRate)
  let low = 0, high = 0
  for (let frame = 0; frame < count; frame++) {
    let e0 = 0, e1 = 0, e2 = 0, total = 0
    const end = (frame + 1) * hop
    for (let sample = frame * hop; sample < end; sample++) {
      // Ignore corrupt samples without allowing them to poison every later band.
      const x = Number.isFinite(samples[sample]) ? clamp(samples[sample], -1e6, 1e6) : 0
      low += lowAlpha * (x - low)
      high += highAlpha * (x - high)
      e0 += low * low
      e1 += (high - low) ** 2
      e2 += (x - high) ** 2
      total += x * x
    }
    bands[0][frame] = Math.sqrt(e0 / hop)
    bands[1][frame] = Math.sqrt(e1 / hop)
    bands[2][frame] = Math.sqrt(e2 / hop)
    rms[frame] = Math.sqrt(total / hop)
  }
  const flux = new Float64Array(count)
  const accent = new Float64Array(count)
  const bandWeights = [.42, .36, .22]
  for (let band = 0; band < bands.length; band++) {
    const energies = bands[band]
    const level = Math.sqrt(mean(energies.map(value => value * value)))
    if (level < 1e-9) continue
    let previous = energies[0]
    for (let frame = 1; frame < count; frame++) {
      const increase = Math.max(0, energies[frame] - previous)
      flux[frame] += bandWeights[band] * increase / level
      accent[frame] += bandWeights[band] * increase / level
      previous = energies[frame] * .8 + previous * .2
    }
  }
  const floor = quantile(flux, .5) * 1.5
  const onset = new Float64Array(count)
  for (let frame = 1; frame < count - 1; frame++) {
    // Compression retains weak beats; a short smoother reduces frame quantization.
    onset[frame] = Math.sqrt(Math.max(0, (flux[frame - 1] + 2 * flux[frame] + flux[frame + 1]) / 4 - floor))
  }
  return { onset, accent, rms, rate: sampleRate / hop }
}

function normalizedCorrelation(envelope: Float64Array, lag: number): number {
  if (lag <= 0 || lag >= envelope.length - 2) return 0
  let dot = 0, left = 0, right = 0
  const baseline = mean(envelope) * .65
  for (let index = lag; index < envelope.length; index++) {
    const a = envelope[index] - baseline
    const b = envelope[index - lag] - baseline
    dot += a * b
    left += a * a
    right += b * b
  }
  return left > 0 && right > 0 ? clamp(dot / Math.sqrt(left * right), -1, 1) : 0
}

interface PulseFit { period: number; phase: number; coverage: number; precision: number; explained: number; positions: number[] }

function peakAround(envelope: Float64Array, center: number, radius: number): { position: number; value: number } {
  let position = Math.max(0, Math.round(center)), value = 0
  const first = Math.max(1, Math.floor(center - radius))
  const last = Math.min(envelope.length - 2, Math.ceil(center + radius))
  for (let index = first; index <= last; index++) {
    if (envelope[index] > value) { value = envelope[index]; position = index }
  }
  if (position > 0 && position < envelope.length - 1) {
    const left = envelope[position - 1], middle = envelope[position], right = envelope[position + 1]
    const denominator = left - 2 * middle + right
    if (denominator < -1e-9) position += clamp(.5 * (left - right) / denominator, -.5, .5)
  }
  return { position, value }
}

function fitPulse(envelope: Float64Array, initialPeriod: number): PulseFit {
  const maximum = Math.max(...envelope)
  const threshold = Math.max(quantile(envelope, .7) * .65, maximum * .06)
  let phase = 0, best = -Infinity
  // Search a single beat for phase, then fit absolute event times by regression.
  for (let candidate = 0; candidate < initialPeriod; candidate += .5) {
    let score = 0, count = 0
    for (let time = candidate; time < envelope.length; time += initialPeriod) {
      score += peakAround(envelope, time, 1.25).value
      count++
    }
    score /= Math.max(1, count)
    if (score > best) { best = score; phase = candidate }
  }
  let period = initialPeriod
  for (let pass = 0; pass < 3; pass++) {
    const pairs: [number, number][] = []
    const radius = Math.min(period * .13, pass ? 4 : 6)
    for (let beat = Math.ceil(-phase / period); phase + beat * period < envelope.length; beat++) {
      const peak = peakAround(envelope, phase + beat * period, radius)
      if (peak.value > threshold) pairs.push([beat, peak.position])
    }
    if (pairs.length < 4) break
    const xMean = mean(pairs.map(pair => pair[0])), yMean = mean(pairs.map(pair => pair[1]))
    let numerator = 0, denominator = 0
    for (const [x, y] of pairs) { numerator += (x - xMean) * (y - yMean); denominator += (x - xMean) ** 2 }
    const refined = numerator / denominator
    if (!Number.isFinite(refined) || Math.abs(refined - initialPeriod) > initialPeriod * .06) break
    period = refined
    phase = yMean - period * xMean
  }
  const positions: number[] = []
  let covered = 0, error = 0, explained = 0, total = 0
  for (const value of envelope) total += value
  for (let beat = Math.ceil(-phase / period); phase + beat * period < envelope.length; beat++) {
    const time = phase + beat * period
    positions.push(time)
    const peak = peakAround(envelope, time, Math.min(period * .12, 4))
    if (peak.value > threshold) { covered++; error += Math.min(1, Math.abs(peak.position - time) / (period * .08)) }
    const radius = Math.min(period * .15, 5)
    for (let index = Math.max(0, Math.ceil(time - radius)); index <= Math.min(envelope.length - 1, Math.floor(time + radius)); index++) explained += envelope[index]
  }
  return { period, phase, positions, coverage: covered / Math.max(1, positions.length), precision: covered ? 1 - error / covered : 0, explained: clamp(explained / Math.max(1e-9, total)) }
}

function estimateMeter(accent: Float64Array, pulse: PulseFit): {
  meter: DawRhythmAnalysis['meter']; candidates: DawMeterCandidate[]; warnings: string[]
} {
  const strengths = pulse.positions.map(time => peakAround(accent, time, Math.min(5, pulse.period * .14)).value)
  if (strengths.length < 16) return { meter: null, candidates: [], warnings: ['有效节拍不足，暂不估计拍号。'] }
  // Divide by a local average so a gradual crescendo cannot invent a bar accent.
  const normalized = strengths.map((value, index) => {
    const first = Math.max(0, index - 6), last = Math.min(strengths.length, index + 7)
    return value / Math.max(1e-9, mean(strengths.slice(first, last)))
  })
  const center = mean(normalized)
  const variance = mean(normalized.map(value => (value - center) ** 2))
  if (variance < .018) return { meter: null, candidates: [], warnings: ['节拍重音不明显，无法可靠判断拍号。'] }
  const periods = [2, 3, 4, 6, 8].filter(period => strengths.length >= period * 4).map(period => {
    const sums = new Array<number>(period).fill(0), counts = new Array<number>(period).fill(0)
    normalized.forEach((value, index) => { sums[index % period] += value; counts[index % period]++ })
    const profile = sums.map((sum, index) => sum / counts[index])
    const explained = mean(profile.map(value => (value - center) ** 2)) / variance
    const sorted = [...profile].sort((a, b) => b - a)
    const contrast = (sorted[0] - sorted[1]) / Math.max(1e-9, sorted[0])
    // A repeated 2-beat pattern should not be promoted to a 4/4 bar prediction.
    return { period, score: clamp(explained), contrast, quality: clamp(explained) - period * .008 }
  }).sort((a, b) => b.quality - a.quality)
  const candidates: DawMeterCandidate[] = []
  for (const value of periods) {
    if (value.period === 2 || value.period === 3 || value.period === 4) candidates.push({ beatsPerBar: value.period, beatUnit: 4, score: round(value.score, 3) })
    if (value.period === 3 || value.period === 6) candidates.push({ beatsPerBar: 6, beatUnit: 8, score: round(value.score * .95, 3) })
  }
  const unique = candidates.filter((item, index) => candidates.findIndex(other => other.beatsPerBar === item.beatsPerBar && other.beatUnit === item.beatUnit) === index)
    .sort((a, b) => b.score - a.score).slice(0, 4)
  const best = periods[0]
  if (!best || best.score < .48 || best.contrast < .18 || ![3, 4].includes(best.period)) {
    return { meter: null, candidates: unique, warnings: ['重音分组存在歧义，请试听确认拍号；规则节拍本身不能区分 2/4、4/4 或复合拍。'] }
  }
  const confidence = clamp(.42 + best.score * .3 + best.contrast * .14, 0, best.period === 3 ? .72 : .85)
  return {
    meter: { beatsPerBar: best.period, beatUnit: 4, confidence: round(confidence, 3) }, candidates: unique,
    warnings: [best.period === 3 ? '三拍重音也可能来自 6/8 等复合拍，请试听确认拍号。' : '拍号根据重音分组估计；切分、弱起和变拍音乐需要手动确认。'],
  }
}

/** Analyze at most 90 seconds; BPM is a suggestion in the 40–240 BPM range. */
export function analyzeDawRhythmChannels(channels: readonly Float32Array[], sampleRate: number, options: { startTime?: number } = {}): DawRhythmAnalysis {
  const [left, right] = channels
  const primary = analyzeDawRhythm(left ?? new Float32Array(), sampleRate, options)
  if (!right) return primary
  const secondary = analyzeDawRhythm(right, sampleRate, options)
  if (secondary.bpm === null) return primary
  if (primary.bpm === null || secondary.confidence > primary.confidence) return secondary
  if (secondary.bpm === primary.bpm && !primary.meter && secondary.meter) return secondary
  return primary
}

export function analyzeDawRhythm(samples: Float32Array, sampleRate: number, options: { startTime?: number } = {}): DawRhythmAnalysis {
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new Error('节奏分析采样率无效。')
  const startTime = Number.isFinite(options.startTime) ? Math.max(0, options.startTime!) : 0
  const bounded = samples.subarray(0, Math.min(samples.length, Math.floor(sampleRate * 90)))
  const result: DawRhythmAnalysis = {
    bpm: null, confidence: 0, tempoCandidates: [], meter: null, meterCandidates: [], beatTimes: [],
    analyzedSeconds: round(bounded.length / sampleRate, 3), warnings: [], algorithmVersion: DAW_RHYTHM_ALGORITHM_VERSION,
  }
  if (bounded.length < sampleRate * 6) { result.warnings.push('音频不足 6 秒，请选择更长且节奏清晰的片段。'); return result }
  const { onset, accent, rms, rate } = onsetEnvelopes(bounded, sampleRate)
  const level = Math.sqrt(mean(rms.map(value => value * value)))
  const loud = quantile(rms, .98), quiet = quantile(rms, .1)
  const active = rms.filter(value => value > Math.max(level * .1, 1e-7)).length / rate
  if (level < 1e-7 || active < .25 || (loud - quiet) / Math.max(1e-9, loud) < .025) {
    result.warnings.push('未检测到足够清晰的节奏瞬态，静音或持续音无法可靠估计 BPM 和拍号。')
    return result
  }
  const minLag = Math.floor(rate * 60 / 240), maxLag = Math.ceil(rate * 60 / 40)
  const correlation = new Float64Array(maxLag * 4 + 3)
  for (let lag = minLag - 1; lag < correlation.length; lag++) correlation[lag] = normalizedCorrelation(onset, lag)
  const scores = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * rate / lag
    // A mild tempo prior resolves octave ties without forcing everything to 120.
    const prior = Math.exp(-.18 * Math.log2(bpm / 120) ** 2)
    scores[lag] = (.55 * Math.max(0, correlation[lag]) + .24 * Math.max(0, correlation[lag * 2]) + .13 * Math.max(0, correlation[lag * 3]) + .08 * Math.max(0, correlation[lag * 4])) * prior
  }
  const initial: { lag: number; score: number }[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] >= (scores[lag - 1] || 0) && scores[lag] >= (scores[lag + 1] || 0)) {
      const denominator = scores[lag - 1] - 2 * scores[lag] + scores[lag + 1]
      const offset = denominator < -1e-9 ? clamp(.5 * (scores[lag - 1] - scores[lag + 1]) / denominator, -.5, .5) : 0
      initial.push({ lag: lag + offset, score: scores[lag] })
    }
  }
  initial.sort((a, b) => b.score - a.score)
  const fitted = initial.slice(0, 8).map(candidate => {
    const fit = fitPulse(onset, candidate.lag)
    const bpm = 60 * rate / fit.period
    return { bpm, fit, score: candidate.score * (.6 + .25 * fit.coverage + .15 * fit.precision) * (.5 + .5 * fit.explained) }
  }).filter(item => Number.isFinite(item.bpm) && item.bpm >= 39.5 && item.bpm <= 240.5)
    .sort((a, b) => b.score - a.score)
  const distinct = fitted.filter((candidate, index) => fitted.findIndex(other => Math.abs(Math.log2(other.bpm / candidate.bpm)) < .025) === index)
  const best = distinct[0]
  if (!best || best.score < .19 || best.fit.coverage < .42 || best.fit.precision < .4) {
    result.warnings.push('节奏周期不稳定或瞬态不足，无法可靠估计 BPM。')
    return result
  }
  result.bpm = round(best.bpm)
  result.tempoCandidates = distinct.slice(0, 4).map(candidate => ({ bpm: round(candidate.bpm), score: round(clamp(candidate.score), 3) }))
  const unrelated = distinct.find(candidate => {
    const octave = Math.log2(candidate.bpm / best.bpm)
    return Math.abs(octave - Math.round(octave)) > .05
  })
  const ambiguity = unrelated ? clamp((best.score - unrelated.score) / Math.max(.01, best.score)) : 1
  result.confidence = round(clamp(best.score * .62 + best.fit.coverage * .18 + best.fit.precision * .12 + ambiguity * .08), 3)
  result.beatTimes = best.fit.positions.filter(position => peakAround(onset, position, Math.min(4, best.fit.period * .12)).value > Math.max(...onset) * .04)
    .slice(0, 512).map(position => round(startTime + position / rate, 4))
  if (distinct.some(candidate => candidate !== best && Math.abs(Math.abs(Math.log2(candidate.bpm / best.bpm)) - 1) < .05 && candidate.score > best.score * .72)) {
    result.warnings.push('存在半速或倍速解释，请试听并核对 BPM 候选。')
  }
  if (result.confidence < .55) result.warnings.push('BPM 置信度较低，请试听确认。')
  const meter = estimateMeter(accent, best.fit)
  result.meter = meter.meter
  result.meterCandidates = meter.candidates
  result.warnings.push(...meter.warnings)
  return result
}
