import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDawRhythm, DAW_RHYTHM_ALGORITHM_VERSION } from '../src/daw/rhythm-analysis'

function clicks(bpm: number, options: { pattern?: number[]; duration?: number; rate?: number; offset?: number; noise?: number; hats?: boolean } = {}): Float32Array {
  const { pattern = [1], duration = 30, rate = 8000, offset = .37, noise = 0, hats = false } = options
  const samples = new Float32Array(Math.round(duration * rate))
  let seed = 42
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000 * 2 - 1 }
  for (let index = 0; index < samples.length; index++) samples[index] = noise * random()
  for (let beat = 0; offset + beat * 60 / bpm < duration; beat++) {
    const first = Math.round((offset + beat * 60 / bpm) * rate)
    const amplitude = pattern[beat % pattern.length]
    for (let index = 0; index < rate * .04 && first + index < samples.length; index++) {
      samples[first + index] += (Math.sin(index * 2 * Math.PI * 135 / rate) + .4 * Math.sin(index * 2 * Math.PI * 1800 / rate)) * Math.exp(-index / (rate * .008)) * amplitude
    }
    if (hats) {
      for (let subdivision = 0; subdivision < 2; subdivision++) {
        const start = Math.round((offset + (beat + subdivision / 2) * 60 / bpm) * rate)
        for (let index = 0; index < rate * .018 && start + index < samples.length; index++) samples[start + index] += .12 * random() * Math.exp(-index / (rate * .003))
      }
    }
  }
  return samples
}
const near = (actual: number | null, expected: number, tolerance = .2) => assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `expected ${expected} BPM, got ${actual}`)

test('tempo estimation retains fractional BPM instead of rounding to an autocorrelation lag', () => {
  for (const bpm of [60, 90, 120, 137.5, 220]) {
    const result = analyzeDawRhythm(clicks(bpm), 8000)
    near(result.bpm, bpm)
    assert.ok(result.confidence >= .65)
    assert.equal(result.algorithmVersion, DAW_RHYTHM_ALGORITHM_VERSION)
    assert.ok(result.tempoCandidates.length > 0 && result.tempoCandidates.length <= 4)
    assert.ok(result.tempoCandidates.every((candidate, index, all) => candidate.score >= 0 && candidate.score <= 1 && (!index || all[index - 1].score >= candidate.score)))
  }
})

test('sample rates not divisible by envelope frequency do not bias the estimated tempo', () => {
  for (const rate of [11025, 22050, 44100]) near(analyzeDawRhythm(clicks(123.45, { rate, duration: 20 }), rate).bpm, 123.45)
})

test('a stable four-pulse accent yields a conservative 4/4 suggestion', () => {
  const result = analyzeDawRhythm(clicks(120, { pattern: [1, .3, .3, .3] }), 8000)
  near(result.bpm, 120)
  assert.equal(result.meter?.beatsPerBar, 4)
  assert.equal(result.meter?.beatUnit, 4)
  assert.ok(result.meter!.confidence >= .6 && result.meter!.confidence < 1)
  assert.ok(result.warnings.some(warning => warning.includes('手动确认')))
})

test('a triple accent suggests 3/4 but exposes the compound-meter ambiguity', () => {
  const result = analyzeDawRhythm(clicks(120, { pattern: [1, .3, .3] }), 8000)
  near(result.bpm, 120)
  assert.equal(result.meter?.beatsPerBar, 3)
  assert.equal(result.meter?.beatUnit, 4)
  assert.ok(result.meter!.confidence <= .72)
  assert.ok(result.meterCandidates.some(candidate => candidate.beatsPerBar === 6 && candidate.beatUnit === 8))
  assert.ok(result.warnings.some(warning => warning.includes('6/8')))
})

test('a regular unaccented pulse does not fabricate a 4/4 time signature', () => {
  for (const bpm of [90, 120, 137.5]) {
    const result = analyzeDawRhythm(clicks(bpm), 8000)
    near(result.bpm, bpm)
    assert.equal(result.meter, null)
    assert.ok(result.warnings.some(warning => warning.includes('拍号') || warning.includes('歧义')))
  }
})

test('alternating accents preserve 2/4 versus 4/4 ambiguity and octave tempo candidates', () => {
  const result = analyzeDawRhythm(clicks(120, { pattern: [1, .3] }), 8000)
  near(result.bpm, 120)
  assert.equal(result.meter, null)
  assert.ok(result.meterCandidates.some(candidate => candidate.beatsPerBar === 2 && candidate.beatUnit === 4))
  assert.ok(result.meterCandidates.some(candidate => candidate.beatsPerBar === 4 && candidate.beatUnit === 4))
  assert.ok(result.tempoCandidates.some(candidate => Math.abs(candidate.bpm - 60) < .2))
  assert.ok(result.warnings.some(warning => warning.includes('半速')))
})

test('transient rhythm survives a continuous noise bed and weaker eighth-note hats', () => {
  const result = analyzeDawRhythm(clicks(120, { noise: .025, hats: true, pattern: [1, .5, .65, .5] }), 8000)
  near(result.bpm, 120)
  assert.ok(result.confidence >= .5)
})

test('leading silence and excerpt offsets produce absolute ordered beat hints', () => {
  const result = analyzeDawRhythm(clicks(90, { offset: 3.37, duration: 36 }), 8000, { startTime: 17.25 })
  near(result.bpm, 90)
  assert.ok(result.beatTimes.length > 40)
  assert.ok(Math.abs(result.beatTimes[0] - (17.25 + 3.37)) < .04)
  assert.ok(result.beatTimes.every((time, index, all) => Number.isFinite(time) && time >= 17.25 && time <= 53.25 && (!index || time > all[index - 1])))
})

test('silence, DC and stationary tones abstain rather than returning a default BPM', () => {
  const rate = 8000, length = rate * 20
  const silence = new Float32Array(length)
  const dc = new Float32Array(length).fill(.25)
  const tone = Float32Array.from({ length }, (_, index) => .25 * Math.sin(index * 2 * Math.PI * 440 / rate))
  for (const samples of [silence, dc, tone]) {
    const result = analyzeDawRhythm(samples, rate)
    assert.equal(result.bpm, null)
    assert.equal(result.confidence, 0)
    assert.equal(result.meter, null)
    assert.ok(result.warnings.length > 0)
  }
})

test('continuous unmodulated noise is not mistaken for a rhythmic pulse', () => {
  let seed = 3
  const noise = Float32Array.from({ length: 8000 * 30 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return .2 * (seed / 0x100000000 * 2 - 1)
  })
  const result = analyzeDawRhythm(noise, 8000)
  assert.equal(result.bpm, null)
  assert.equal(result.meter, null)
  assert.ok(result.warnings.length)
})

test('short excerpts do not return unsupported tempo or meter estimates', () => {
  const result = analyzeDawRhythm(clicks(120, { duration: 5.9 }), 8000)
  assert.equal(result.bpm, null)
  assert.equal(result.meter, null)
  assert.equal(result.analyzedSeconds, 5.9)
  assert.ok(result.warnings[0].includes('6 秒'))
})

test('invalid sampling rates reject explicitly and isolated nonfinite samples cannot poison analysis', () => {
  for (const rate of [0, -100, NaN, Infinity, 999, 384001]) assert.throws(() => analyzeDawRhythm(new Float32Array(0), rate), /采样率/)
  const samples = clicks(120)
  samples[900] = NaN
  samples[901] = Infinity
  near(analyzeDawRhythm(samples, 8000, { startTime: NaN }).bpm, 120)
})

test('analysis bounds long buffers to 90 seconds and limits beat hint payloads', () => {
  const result = analyzeDawRhythm(clicks(120, { duration: 95 }), 8000, { startTime: -10 })
  near(result.bpm, 120)
  assert.equal(result.analyzedSeconds, 90)
  assert.ok(result.beatTimes.length <= 512)
  assert.ok(result.beatTimes.every(time => time >= 0 && time <= 90))
})

test('changing tempo is rejected or flagged rather than represented as one confident fixed grid', () => {
  const render = (tempo: (time: number) => number) => {
    const rate = 8000, duration = 30
    const samples = new Float32Array(rate * duration)
    let beat = 0
    for (let time = .37; time < duration; time += 60 / tempo(time), beat++) {
      const first = Math.round(time * rate), amplitude = beat % 4 === 0 ? 1 : .3
      for (let index = 0; index < rate * .04 && first + index < samples.length; index++) {
        samples[first + index] += (Math.sin(index * 2 * Math.PI * 135 / rate) + .4 * Math.sin(index * 2 * Math.PI * 1800 / rate)) * Math.exp(-index / (rate * .008)) * amplitude
      }
    }
    return analyzeDawRhythm(samples, rate)
  }
  const stepped = render(time => time < 15 ? 120 : 140)
  assert.ok(stepped.bpm === null || stepped.confidence < .55)
  assert.ok(stepped.warnings.some(warning => warning.includes('置信度较低') || warning.includes('周期不稳定')))
  const ramped = render(time => 90 + time * 2)
  assert.equal(ramped.bpm, null)
  assert.equal(ramped.meter, null)
  assert.ok(ramped.warnings.some(warning => warning.includes('周期不稳定')))
})
