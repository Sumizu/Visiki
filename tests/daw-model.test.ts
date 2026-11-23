import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DAW_MAX_ASSETS, DAW_MAX_CLIPS, DAW_MAX_TRACKS, DawValidationError,
  addAssetToSession, addClip, addTrack, clipEnvelopeAt, createSession, createTrack,
  deleteClip, deleteTrack, duplicateClip, moveClip, parseSession, serializeSession,
  sessionDuration, splitClip, trimClip, updateClip, updateMaster, updateTrack, validateSession, getMusicalGrid, updateMusicalGrid,
  type DawAsset, type DawClip, type DawSession,
} from '../src/daw/model'

const asset = (duration = 10, sampleRate = 48000): DawAsset => ({
  id: 'asset-1', name: '主唱.wav', url: '/api/daw/assets/asset-1', duration, sampleRate,
  sampleCount: Math.round(duration * sampleRate), channels: 2, peakHopSec: .01,
  peaks: [{ min: [-.8, -.2], max: [.5, .9] }, { min: [-.5, -.1], max: [.4, .7] }],
})
function fixture(duration = 10, sampleRate = 48000): { session: DawSession; trackId: string; clipId: string } {
  let session = addAssetToSession(createSession('测试混音'), asset(duration, sampleRate))
  session = addTrack(session, createTrack('主唱'))
  const trackId = session.tracks[0].id
  session = addClip(session, trackId, session.assets[0].id, 2)
  return { session, trackId, clipId: session.tracks[0].clips[0].id }
}
const near = (actual: number, expected: number, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)
const getClip = (session: DawSession, trackId: string, clipId: string): DawClip => session.tracks.find(track => track.id === trackId)!.clips.find(clip => clip.id === clipId)!

test('empty document, duration and sharing remain independent from the video project', () => {
  const empty = createSession()
  assert.equal(empty.schema, 'visiki-daw')
  assert.equal(empty.version, 1)
  assert.equal(empty.sampleRate, 48000)
  assert.equal(sessionDuration(empty), 0)
  assert.deepEqual(validateSession(empty), [])
  const source = asset()
  const loaded = addAssetToSession(empty, source)
  assert.equal(loaded.assets[0], source)
  assert.equal(empty.assets.length, 0)
  assert.equal(sessionDuration(fixture().session), 12)
})

test('splitting preserves source sample continuity and only modifies its own track', () => {
  const { session, trackId, clipId } = fixture(10, 44100)
  const withOther = addTrack(session, createTrack('伴奏'))
  const split = splitClip(withOther, trackId, clipId, 5.123456)
  const [left, right] = split.tracks[0].clips
  assert.equal(left.id, clipId)
  assert.notEqual(right.id, clipId)
  near(left.start + left.duration, right.start)
  near(left.sourceIn + left.duration, right.sourceIn)
  near(left.duration + right.duration, 10)
  near(right.sourceIn * 44100, Math.round(right.sourceIn * 44100), 1e-7)
  assert.equal(split.tracks[1], withOther.tracks[1])
  assert.equal(split.assets, withOther.assets)
  assert.equal(withOther.tracks[0].clips.length, 1)
  assert.deepEqual(validateSession(split), [])
  assert.equal(splitClip(session, trackId, clipId, 2), session)
  assert.equal(splitClip(session, trackId, clipId, 12), session)
})

test('splits inside fades preserve the original gain curve on both sides', () => {
  for (const splitTime of [2.4, 4, 9, 11.7]) {
    const { session: original, trackId, clipId } = fixture()
    const faded = updateClip(original, trackId, clipId, { fadeIn: 3, fadeOut: 2 })
    const before = getClip(faded, trackId, clipId)
    const split = splitClip(faded, trackId, clipId, splitTime)
    const [left, right] = split.tracks[0].clips
    for (let index = 0; index <= 100; index++) {
      const time = before.duration * index / 100
      const chosen = time <= left.duration ? left : right
      const local = time <= left.duration ? time : time - left.duration
      near(clipEnvelopeAt(chosen, local), clipEnvelopeAt(before, time))
    }
    near(clipEnvelopeAt(left, left.duration), clipEnvelopeAt(right, 0))
    assert.deepEqual(validateSession(split), [])
  }
})

test('trimming preserves retained fade gains and is non-destructive when extended', () => {
  const { session, trackId, clipId } = fixture()
  const faded = updateClip(session, trackId, clipId, { fadeIn: 3, fadeOut: 2 })
  const before = getClip(faded, trackId, clipId)
  const left = trimClip(faded, trackId, clipId, 'start', 3)
  const trimmed = getClip(left, trackId, clipId)
  near(trimmed.start, 3); near(trimmed.sourceIn, 1); near(trimmed.duration, 9)
  for (let index = 0; index <= 100; index++) {
    const time = trimmed.duration * index / 100
    near(clipEnvelopeAt(trimmed, time), clipEnvelopeAt(before, time + 1))
  }
  const shortened = trimClip(left, trackId, clipId, 'end', 11)
  const ended = getClip(shortened, trackId, clipId)
  near(ended.duration, 8)
  for (let time = 0; time <= 8; time += .125) near(clipEnvelopeAt(ended, time), clipEnvelopeAt(before, time + 1))
  const restored = trimClip(shortened, trackId, clipId, 'start', 2)
  near(getClip(restored, trackId, clipId).sourceIn, 0)
  assert.deepEqual(validateSession(restored), [])
  const reset = updateClip(shortened, trackId, clipId, { fadeIn: .5, fadeOut: .5 })
  assert.equal(getClip(reset, trackId, clipId).envelope, undefined)
  near(clipEnvelopeAt(getClip(reset, trackId, clipId), .25), .5)
})

test('trim clamps to at least one sample, source boundaries and the zero timeline edge', () => {
  const { session, trackId, clipId } = fixture()
  const tiny = trimClip(session, trackId, clipId, 'end', -999)
  near(getClip(tiny, trackId, clipId).duration, 1 / 48000)
  const last = trimClip(session, trackId, clipId, 'start', 999)
  near(getClip(last, trackId, clipId).duration, 1 / 48000)
  const extended = trimClip(session, trackId, clipId, 'end', 999)
  near(getClip(extended, trackId, clipId).duration, 10)
  const beforeStart = trimClip(session, trackId, clipId, 'start', -999)
  near(getClip(beforeStart, trackId, clipId).start, 2)
  assert.deepEqual(validateSession(tiny), [])
  assert.deepEqual(validateSession(last), [])
})

test('move, duplicate and delete preserve assets and allow intentional overlap', () => {
  const { session, trackId, clipId } = fixture()
  const more = addTrack(session, createTrack('伴奏'))
  const destination = more.tracks[1].id
  const moved = moveClip(more, trackId, clipId, -200, destination)
  assert.equal(moved.tracks[0].clips.length, 0)
  const clip = getClip(moved, destination, clipId)
  assert.equal(clip.start, 0)
  const repeated = duplicateClip(moved, destination, clipId, .5)
  assert.equal(repeated.tracks[1].clips.length, 2)
  assert.notEqual(repeated.tracks[1].clips[1].id, clipId)
  assert.equal(repeated.assets[0], session.assets[0])
  const deleted = deleteClip(repeated, destination, clipId)
  assert.equal(deleted.tracks[1].clips.length, 1)
  assert.equal(deleteTrack(deleted, destination).tracks.length, 1)
  assert.deepEqual(validateSession(repeated), [])
})

test('parameter edits reject nonfinite values and clamp legal controls', () => {
  const { session, trackId, clipId } = fixture()
  const mixed = updateTrack(session, trackId, { pan: 4, volumeDb: -300, muted: true, solo: true })
  assert.equal(mixed.tracks[0].pan, 1)
  assert.equal(mixed.tracks[0].volumeDb, -96)
  assert.equal(mixed.tracks[0].muted, true)
  assert.equal(updateMaster(mixed, 500).masterDb, 12)
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => moveClip(session, trackId, clipId, bad), DawValidationError)
    assert.throws(() => trimClip(session, trackId, clipId, 'start', bad), DawValidationError)
    assert.throws(() => splitClip(session, trackId, clipId, bad), DawValidationError)
    assert.throws(() => updateClip(session, trackId, clipId, { gainDb: bad }), DawValidationError)
    assert.throws(() => updateTrack(session, trackId, { pan: bad }), DawValidationError)
  }
  const fades = updateClip(session, trackId, clipId, { fadeIn: 8, fadeOut: 8 })
  near(getClip(fades, trackId, clipId).fadeIn + getClip(fades, trackId, clipId).fadeOut, 10)
  assert.deepEqual(validateSession(fades), [])
})

test('save omits derived peaks but retains inherited envelopes and complete editor data', () => {
  const { session, trackId, clipId } = fixture()
  const faded = updateClip(session, trackId, clipId, { fadeIn: 3, fadeOut: 2, gainDb: -2 })
  const split = splitClip(faded, trackId, clipId, 2.5)
  const text = serializeSession(split)
  const restored = parseSession(text)
  assert.deepEqual(restored.assets[0].peaks, [])
  assert.deepEqual(restored.tracks, split.tracks)
  assert.equal(restored.assets[0].url, '/api/daw/assets/asset-1')
  const cloned = parseSession(split)
  cloned.assets[0].peaks[0].min[0] = -.3
  assert.equal(split.assets[0].peaks[0].min[0], -.8)
  assert.deepEqual(validateSession(restored), [])
})

test('untrusted documents reject broken references, ranges, URLs, channels and unknown schema', () => {
  const { session } = fixture()
  const malformed: unknown[] = [null, [], {}, '{broken', { ...session, version: 3 }, { ...session, sampleRate: NaN }]
  for (const bad of malformed) assert.throws(() => parseSession(bad), DawValidationError)
  for (const url of ['https://remote.test/audio', 'javascript:alert(1)', 'file:///C:/x.wav', '/api/daw/assets/../secret', '/api/daw/assets/id?url=x']) {
    assert.throws(() => parseSession({ ...session, assets: [{ ...session.assets[0], url }] }), /素材地址/)
  }
  const invalid = structuredClone(session)
  invalid.tracks[0].clips[0].sourceIn = 50
  invalid.tracks[0].clips[0].assetId = 'missing'
  invalid.assets[0].channels = 6
  assert.ok(validateSession(invalid).some(issue => issue.path.endsWith('assetId')))
  assert.throws(() => parseSession(invalid), DawValidationError)
  const duplicate = structuredClone(session)
  duplicate.tracks[0].clips.push({ ...duplicate.tracks[0].clips[0] })
  assert.throws(() => parseSession(duplicate), /片段标识重复/)
  const offSample = structuredClone(session)
  offSample.tracks[0].clips[0].sourceIn = .000001
  assert.throws(() => parseSession(offSample), /采样边界/)
})

test('floating point audio waveform peaks can exceed full scale without normalization', () => {
  const source = asset()
  source.peaks[0] = { min: [-2.5, -.1], max: [3.2, .9] }
  const session = addAssetToSession(createSession(), source)
  assert.equal(session.assets[0].peaks[0].max[0], 3.2)
  assert.deepEqual(validateSession(session), [])
})

test('document capacity limits fail clearly before edit/render disagreement', () => {
  assert.equal(DAW_MAX_TRACKS, 32); assert.equal(DAW_MAX_CLIPS, 512); assert.equal(DAW_MAX_ASSETS, 64)
  let session = createSession()
  for (let index = 0; index < DAW_MAX_TRACKS; index++) session = addTrack(session, createTrack(String(index)))
  assert.throws(() => addTrack(session), /32/)
  const { session: withClip, trackId, clipId } = fixture()
  const full = { ...withClip, tracks: [{ ...withClip.tracks[0], clips: Array.from({ length: DAW_MAX_CLIPS }, (_, index) => ({ ...withClip.tracks[0].clips[0], id: `clip-${index}` })) }] }
  assert.throws(() => duplicateClip(full, trackId, 'clip-0'), /512/)
  const moved = moveClip(withClip, trackId, clipId, 1e7)
  near(sessionDuration(moved), 3600)
  assert.deepEqual(validateSession(moved), [])
})

test('tempo and signature metadata round-trip without moving, stretching or copying audio', () => {
  const { session } = fixture(10, 44100)
  const before = structuredClone(session.tracks)
  const changed = updateMusicalGrid(session, { bpm: 137.5, beatsPerBar: 6, beatUnit: 8 })
  assert.deepEqual(getMusicalGrid(session), { bpm: 120, beatsPerBar: 4, beatUnit: 4 })
  assert.deepEqual(getMusicalGrid(changed), { bpm: 137.5, beatsPerBar: 6, beatUnit: 8 })
  assert.equal(changed.assets, session.assets)
  assert.equal(changed.tracks, session.tracks)
  assert.deepEqual(changed.tracks, before)
  assert.deepEqual(parseSession(serializeSession(changed)).musicalGrid, changed.musicalGrid)
  const parsed = parseSession(changed)
  parsed.musicalGrid!.bpm = 90
  assert.equal(changed.musicalGrid!.bpm, 137.5)
  assert.deepEqual(parseSession({ ...changed, musicalGrid: { ...changed.musicalGrid, unknown: 'discard' } }).musicalGrid, changed.musicalGrid)
  assert.equal(updateMusicalGrid(changed, { bpm: 137.5 }), changed)
  assert.deepEqual(validateSession(changed), [])
})

test('older schema-1 sessions obtain a default grid while preserving their original times', () => {
  const { session } = fixture()
  const older = { ...session }
  delete older.musicalGrid
  assert.deepEqual(validateSession(older), [])
  const restored = parseSession(JSON.stringify(older))
  assert.deepEqual(restored.musicalGrid, { bpm: 120, beatsPerBar: 4, beatUnit: 4 })
  assert.deepEqual(restored.tracks, older.tracks)
  assert.deepEqual(getMusicalGrid(older), { bpm: 120, beatsPerBar: 4, beatUnit: 4 })
  const grid = getMusicalGrid(restored)
  grid.bpm = 40
  assert.equal(restored.musicalGrid!.bpm, 120)
})

test('untrusted musical metadata rejects invalid tempo and signature values', () => {
  const session = createSession()
  for (const bpm of [NaN, Infinity, -1, 0, 19.9, 300.1]) {
    assert.throws(() => updateMusicalGrid(session, { bpm }), DawValidationError)
    assert.throws(() => parseSession({ ...session, musicalGrid: { bpm, beatsPerBar: 4, beatUnit: 4 } }), DawValidationError)
  }
  for (const patch of [{ beatsPerBar: 1 }, { beatsPerBar: 3.5 }, { beatsPerBar: 13 }, { beatUnit: 3 }, { beatUnit: 0 }, { beatUnit: NaN }]) {
    assert.throws(() => updateMusicalGrid(session, patch), DawValidationError)
    assert.throws(() => parseSession({ ...session, musicalGrid: { ...session.musicalGrid, ...patch } }), DawValidationError)
  }
  for (const malformed of [null, [], '4/4', { bpm: 120 }, { bpm: 120, beatsPerBar: 4 }]) {
    assert.throws(() => parseSession({ ...session, musicalGrid: malformed }), DawValidationError)
  }
  for (const beatUnit of [2, 4, 8, 16]) assert.deepEqual(validateSession(updateMusicalGrid(session, { bpm: 20, beatsPerBar: 12, beatUnit })), [])
})
