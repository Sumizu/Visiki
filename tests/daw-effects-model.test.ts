import test from 'node:test'
import assert from 'node:assert/strict'
import { DawValidationError, addAssetToSession, addClip, addTrack, createSession, createTrack, duplicateClip, moveClip, splitClip, trimClip, parseSession, serializeSession, validateSession } from '../src/daw/model'
import {
  DAW_DELAY_NOTE_BEATS, DAW_EFFECT_CATALOG, DAW_EFFECT_TYPES, DAW_MAX_EFFECTS,
  addEffect, applyEffectPreset, bypassEffectChain, clipEffectTarget, resolveEffectTarget, copyEffect, copyEffectAToB, copyEffectChain, createEffect,
  formatEffectParameter, getEffect, getEffectChain, getEffectDefaultParams, getEffectDefinition,
  getEffectParameters, moveEffect, removeEffect, resetEffect, switchEffectAB, updateEffect,
  validateEffectChain, type DawEffect, type DawEffectPatch,
} from '../src/daw/effects'

function fixture() {
  let session = addTrack(createSession('内置效果'), createTrack('主唱'))
  session = addTrack(session, createTrack('伴奏'))
  return { session, target: session.tracks[0].id, other: session.tracks[1].id }
}

test('catalogue covers the native types and exposes complete units, ranges and useful presets', () => {
  assert.deepEqual(DAW_EFFECT_CATALOG.map(item => item.type), [...DAW_EFFECT_TYPES])
  const parameterCount = DAW_EFFECT_CATALOG.reduce((count, item) => count + item.parameters.length, 0)
  assert.ok(parameterCount >= 100)
  for (const definition of DAW_EFFECT_CATALOG) {
    assert.ok(definition.description && definition.category && definition.subtitle)
    const simple = getEffectParameters(definition.type)
    assert.ok(simple.length >= (['transient', 'lofi'].includes(definition.type) ? 3 : 4) && simple.length <= 6, `${definition.type}: ${simple.length} simple controls`)
    assert.equal(getEffectParameters(definition.type, true).length, definition.parameters.length)
    assert.equal(new Set(definition.parameters.map(item => item.key)).size, definition.parameters.length)
    for (const parameter of definition.parameters) {
      assert.ok(Number.isFinite(parameter.min) && Number.isFinite(parameter.max))
      assert.ok(parameter.default >= parameter.min && parameter.default <= parameter.max)
      assert.ok(parameter.step > 0 && parameter.description)
      assert.equal(typeof parameter.unit, 'string')
    }
    assert.ok(definition.presets.length >= 3)
    for (const preset of definition.presets) assert.deepEqual(validateEffectChain([createEffect(definition.type, preset.id)]), [], `${definition.type}/${preset.id}`)
  }
  assert.ok(Object.isFrozen(DAW_EFFECT_CATALOG))
  assert.ok(Object.isFrozen(getEffectDefinition('delay').parameters))
})

test('EQ has eight independently restored bands, explicit slope choices and stable defaults', () => {
  const definition = getEffectDefinition('eq'), params = getEffectDefaultParams('eq')
  for (let band = 1; band <= 8; band++) for (const suffix of ['Freq', 'Gain', 'Q', 'Type', 'Enabled', 'Slope']) assert.ok(Object.hasOwn(params, `band${band}${suffix}`))
  assert.deepEqual(definition.parameters.find(item => item.key === 'band1Type')!.options, ['Bell', '低架', '高架', '高通', '低通', '陷波'])
  assert.deepEqual(definition.parameters.find(item => item.key === 'band1Slope')!.options, ['12 dB/oct', '24 dB/oct', '36 dB/oct', '48 dB/oct'])
  assert.equal(params.band3Enabled, 1)
  assert.equal(params.band1Enabled, 0)
  assert.equal(params.outputDb, 0)
  params.band3Gain = 12
  assert.equal(getEffectDefaultParams('eq').band3Gain, 0)
})

test('ducking source survives saves and copies, and follows each A/B slot independently', () => {
  const { session, target, other } = fixture()
  const fx = { ...createEffect('ducker'), sidechainTrackId: other }
  const inserted = addEffect(session, target, fx)
  const initialized = switchEffectAB(inserted, target, fx.id)
  assert.equal(getEffect(initialized, target, fx.id).sidechainTrackId, other)
  const different = updateEffect(initialized, target, fx.id, { sidechainTrackId: null })
  const back = switchEffectAB(different, target, fx.id)
  const restored = parseSession(serializeSession(back))
  assert.equal(getEffect(restored, target, fx.id).sidechainTrackId, other)
  assert.equal(getEffect(restored, target, fx.id).bSidechainTrackId, undefined)
  const copied = copyEffect(restored, target, fx.id)
  assert.equal(getEffectChain(copied, target)[1].sidechainTrackId, other)
  assert.ok(validateEffectChain([{ ...createEffect('compressor'), sidechainTrackId: other }]).length)
})

test('existing ducking projects load with fixed depth and can select the adaptive preset', () => {
  const { session, target, other } = fixture()
  const original = createEffect('ducker')
  delete original.params.mode
  delete original.params.marginDb
  original.sidechainTrackId = other
  const restored = parseSession(serializeSession(addEffect(session, target, original)))
  assert.equal(getEffect(restored, target, original.id).params.mode ?? 0, 0)
  const switched = applyEffectPreset(restored, target, original.id, 'adaptive-dialogue')
  assert.equal(getEffect(switched, target, original.id).params.mode, 1)
  assert.equal(getEffect(switched, target, original.id).params.marginDb, 3)
  assert.equal(getEffect(switched, target, original.id).sidechainTrackId, other)
})

test('noise profiles follow A/B, copies and project saves while malformed profiles are rejected', () => {
  const { session, target, other } = fixture()
  const denoise = createEffect('denoise')
  const profile = Array.from({ length: 128 }, (_, index) => -180 + index)
  let next = addEffect(session, target, { ...denoise, noiseProfile: profile })
  next = switchEffectAB(next, target, denoise.id)
  assert.deepEqual(getEffect(next, target, denoise.id).noiseProfile, profile)
  next = updateEffect(next, target, denoise.id, { noiseProfile: null })
  next = switchEffectAB(next, target, denoise.id)
  const restored = parseSession(serializeSession(next))
  assert.deepEqual(getEffect(restored, target, denoise.id).noiseProfile, profile)
  const copied = copyEffectChain(restored, target, other)
  assert.notEqual(getEffectChain(copied, other)[0].noiseProfile, getEffect(restored, target, denoise.id).noiseProfile)
  assert.ok(validateEffectChain([{ ...denoise, noiseProfile: [0, 1] }]).length)
  assert.ok(validateEffectChain([{ ...createEffect('lofi'), noiseProfile: profile }]).length)
})

test('pre-dynamic EQ documents keep both static A/B banks and new dynamic fields remain range checked', () => {
  const legacy = createEffect('eq', 'vocal-cleanup')
  const dynamicKeys = getEffectDefinition('eq').parameters.filter(parameter => parameter.optional).map(parameter => parameter.key)
  for (const key of dynamicKeys) delete legacy.params[key]
  legacy.bState = { ...legacy.params, band3Gain: 2.5 }
  legacy.abSlot = 'A'
  const { session, target } = fixture()
  const restored = parseSession(serializeSession(addEffect(session, target, legacy)))
  const after = getEffect(restored, target, legacy.id)
  assert.equal(after.params.band3Gain, -2.5)
  assert.equal(after.bState?.band3Gain, 2.5)
  assert.deepEqual(validateEffectChain([{ ...after, params: { ...after.params, band3Dyn: 1, band3Threshold: -28 } }]), [])
  assert.ok(validateEffectChain([{ ...after, bState: { ...after.bState, band3Range: 19 } }]).some(issue => issue.path === 'effects[0].bState.band3Range'))
  const femalePop = createEffect('eq', 'vocal-female-pop'), femaleRock = createEffect('eq', 'vocal-female-rock'), maleClassical = createEffect('eq', 'vocal-male-classical')
  assert.equal(femalePop.params.band6Dyn, 1)
  assert.equal(femaleRock.params.band5Dyn, 1)
  assert.equal(maleClassical.params.band1Slope, 0)
  assert.ok(dynamicKeys.every(key => !key.endsWith('Dyn') || maleClassical.params[key] === 0))
})

test('schema-1 saves preserve omitted effects while restoring track and master instances by value', () => {
  const old = fixture(), before = parseSession(serializeSession(old.session))
  assert.ok(!Object.hasOwn(before, 'masterEffects'))
  assert.ok(before.tracks.every(track => !Object.hasOwn(track, 'effects')))
  assert.ok(!serializeSession(before).includes('"effects"'))
  let session = addEffect(old.session, old.target, 'compressor')
  session = addEffect(session, 'master', 'limiter')
  const id = session.tracks[0].effects![0].id
  session = updateEffect(session, old.target, id, { enabled: false, name: '人声动态', bState: { ...getEffect(session, old.target, id).params, thresholdDb: -24 }, abSlot: 'B' })
  const parsed = parseSession(serializeSession(session))
  assert.deepEqual(parsed, session)
  assert.notEqual(parsed.tracks[0].effects, session.tracks[0].effects)
  assert.notEqual(parsed.tracks[0].effects![0].params, session.tracks[0].effects![0].params)
  assert.notEqual(parsed.tracks[0].effects![0].bState, session.tracks[0].effects![0].bState)
  assert.notEqual(parsed.masterEffects![0].params, session.masterEffects![0].params)
  parsed.tracks[0].effects![0].params.thresholdDb = -50
  assert.equal(getEffect(session, old.target, id).params.thresholdDb, -18)
})

test('legacy limiter saves keep sample peak in both A/B states, with true peak opt-in', () => {
  const { session, target } = fixture(), old = createEffect('limiter', 'safe');
  delete old.params.truePeak;
  old.bState = { ...old.params, ceilingDb: -2 };
  old.abSlot = 'A';
  const restored = parseSession(serializeSession(addEffect(session, target, old)));
  const loaded = getEffect(restored, target, old.id);
  assert.equal(loaded.params.truePeak ?? 0, 0);
  assert.equal(loaded.bState?.truePeak ?? 0, 0);
  assert.equal(loaded.bState?.ceilingDb, -2);
  assert.equal(createEffect('limiter', 'delivery-true-peak').params.truePeak, 1);
  assert.ok(validateEffectChain([{ ...loaded, params: { ...loaded.params, truePeak: .5 } }]).some(issue => issue.path === 'effects[0].params.truePeak'));
});

test('untrusted saves reject unknown effects, unknown fields, missing parameters and malformed numeric values', () => {
  const { session, target } = fixture()
  const valid = addEffect(session, target, 'compressor')
  const malformed: ((effect: Record<string, unknown>) => void)[] = [
    effect => { effect.type = 'vst3' },
    effect => { effect.binaryState = 'unrecognized' },
    effect => { effect.enabled = 1 },
    effect => { effect.name = '' },
    effect => { effect.abSlot = 'C' },
    effect => { effect.presetId = 'does-not-exist' },
    effect => { (effect.params as Record<string, unknown>).thresholdDb = NaN },
    effect => { (effect.params as Record<string, unknown>).thresholdDb = Infinity },
    effect => { (effect.params as Record<string, unknown>).thresholdDb = '-18' },
    effect => { (effect.params as Record<string, unknown>).thresholdDb = -100 },
    effect => { (effect.params as Record<string, unknown>).detector = .5 },
    effect => { (effect.params as Record<string, unknown>).unknownParameter = 1 },
    effect => { delete (effect.params as Record<string, unknown>).ratio },
    effect => { effect.bState = {} },
    effect => { effect.params = [] },
    effect => { effect.params = Object.assign(Object.create({ thresholdDb: -18 }), effect.params) },
  ]
  for (const mutate of malformed) {
    const document = structuredClone(valid)
    mutate(document.tracks[0].effects![0] as unknown as Record<string, unknown>)
    assert.ok(validateSession(document).some(issue => issue.path.startsWith('tracks[0].effects[0]')))
    assert.throws(() => parseSession(document), DawValidationError)
  }
  assert.throws(() => createEffect('vst3' as 'eq'), DawValidationError)
})

test('effect IDs are unique throughout the project, and each chain is bounded at twelve', () => {
  const { session, target, other } = fixture(), effect = createEffect('eq')
  let next = addEffect(session, target, effect)
  assert.throws(() => addEffect(next, 'master', effect), DawValidationError)
  assert.throws(() => addTrack(next, { ...createTrack(), effects: [effect] }), DawValidationError)
  for (const place of ['master', other]) {
    const duplicate = structuredClone(next)
    if (place === 'master') duplicate.masterEffects = [structuredClone(effect)]
    else duplicate.tracks[1].effects = [structuredClone(effect)]
    assert.ok(validateSession(duplicate).some(issue => issue.message.includes('标识重复')))
  }
  for (let index = 1; index < DAW_MAX_EFFECTS; index++) next = addEffect(next, target, 'meter')
  assert.equal(getEffectChain(next, target).length, 12)
  assert.throws(() => addEffect(next, target, 'meter'), DawValidationError)
  assert.throws(() => copyEffect(next, target, effect.id), DawValidationError)
  const oversized = structuredClone(next)
  oversized.tracks[0].effects!.push(createEffect('meter'))
  assert.throws(() => parseSession(oversized), DawValidationError)
  assert.throws(() => parseSession({ ...session, masterEffects: {} }), DawValidationError)
})

test('immutable insertion, parameter edits, bypass and ordering preserve unrelated tracks and original values', () => {
  const { session, target } = fixture(), source = createEffect('eq')
  const added = addEffect(session, target, source)
  source.params.band3Gain = 20
  assert.equal(getEffect(added, target, source.id).params.band3Gain, 0)
  assert.equal(session.tracks[0].effects, undefined)
  const second = addEffect(added, target, 'compressor', 0), id = second.tracks[0].effects![0].id
  const patch = { thresholdDb: -26 }, changed = updateEffect(second, target, id, { params: patch, enabled: false })
  patch.thresholdDb = -50
  assert.equal(getEffect(changed, target, id).params.thresholdDb, -26)
  assert.equal(getEffect(changed, target, id).params.ratio, 3)
  assert.equal(getEffect(changed, target, id).enabled, false)
  assert.equal(getEffect(changed, target, id).presetId, undefined)
  assert.equal(getEffect(second, target, id).params.thresholdDb, -18)
  assert.equal(changed.tracks[1], session.tracks[1])
  assert.equal(changed.assets, session.assets)
  const moved = moveEffect(changed, target, id, 1)
  assert.deepEqual(getEffectChain(moved, target).map(effect => effect.id), [source.id, id])
  assert.equal(moveEffect(moved, target, id, 1), moved)
  const bypassed = bypassEffectChain(moved, target)
  assert.deepEqual(getEffectChain(bypassed, target), getEffectChain(moved, target).map(effect => ({ ...effect, enabled: false })))
  assert.equal(getEffectChain(bypassed, target)[1], getEffectChain(moved, target)[1])
  assert.equal(bypassed.tracks[1], moved.tracks[1])
  assert.equal(bypassEffectChain(bypassed, target), bypassed)
  assert.equal(getEffectChain(removeEffect(moved, target, id), target).length, 1)
  assert.deepEqual(validateSession(changed), [])
})

test('copies use new stable IDs, include comparison snapshots and never share mutable parameter records', () => {
  const { session, target, other } = fixture()
  let next = addEffect(session, target, 'delay')
  const first = getEffectChain(next, target)[0]
  next = updateEffect(next, target, first.id, { bState: { ...first.params, feedback: 60 }, abSlot: 'A' })
  const copied = copyEffect(next, target, first.id)
  const [original, duplicate] = getEffectChain(copied, target)
  assert.notEqual(original.id, duplicate.id)
  assert.notEqual(original.params, duplicate.params)
  assert.notEqual(original.bState, duplicate.bState)
  assert.deepEqual(original.params, duplicate.params)
  const full = copyEffectChain(copied, target, other)
  assert.equal(getEffectChain(full, other).length, 2)
  assert.ok(getEffectChain(full, other).every(effect => ![original.id, duplicate.id].includes(effect.id)))
  assert.deepEqual(validateSession(full), [])
  const master = copyEffect(full, target, first.id, 'master')
  assert.equal(master.masterEffects!.length, 1)
})

test('presets and reset change the active parameters without changing instance identity or bypass', () => {
  const { session, target } = fixture()
  let next = addEffect(session, target, 'reverb')
  const id = getEffectChain(next, target)[0].id
  next = updateEffect(next, target, id, { enabled: false })
  next = applyEffectPreset(next, target, id, 'vocal-hall')
  assert.equal(getEffect(next, target, id).params.decaySec, 2.8)
  assert.equal(getEffect(next, target, id).presetId, 'vocal-hall')
  next = resetEffect(next, target, id)
  assert.deepEqual(getEffect(next, target, id).params, getEffectDefaultParams('reverb'))
  assert.equal(getEffect(next, target, id).enabled, false)
  assert.equal(getEffect(next, target, id).presetId, 'default')
  assert.throws(() => applyEffectPreset(next, target, id, 'missing'), DawValidationError)
})

test('pre-enhancement reverb saves restore both A/B spaces and new controls keep their defaults in the legacy slot', () => {
  const { session, target } = fixture()
  const legacy = createEffect('reverb', 'short-room')
  const optional = getEffectDefinition('reverb').parameters.filter(parameter => parameter.optional)
  assert.equal(optional.length, 7)
  for (const parameter of optional) {
    assert.ok(parameter.advanced)
    delete legacy.params[parameter.key]
  }
  legacy.bState = { ...legacy.params, earlyPattern: 2, earlySize: 168, bassDecay: .48, modDepthMs: .72 }
  const a = parseSession(serializeSession(addEffect(session, target, legacy)))
  assert.deepEqual(getEffect(a, target, legacy.id).params, legacy.params)
  const b = switchEffectAB(a, target, legacy.id)
  assert.equal(getEffect(b, target, legacy.id).params.earlyPattern, 2)
  assert.equal(getEffect(b, target, legacy.id).params.earlySize, 168)
  const restored = getEffect(switchEffectAB(b, target, legacy.id), target, legacy.id)
  assert.equal(restored.params.earlyPattern, 0)
  assert.equal(restored.params.modDepthMs, .12)
  assert.equal(restored.params.bassDecay, 1)
  assert.equal(restored.params.decaySec, .55)
  const copied = getEffect(copyEffectAToB(b, target, legacy.id), target, legacy.id)
  assert.equal(copied.params.earlyPattern, 0)
  assert.equal(copied.params.earlySize, 100)
  assert.throws(() => updateEffect(b, target, legacy.id, { params: { earlyPattern: 1.5 } }), DawValidationError)
})

test('A/B swaps a single active state and survives save, independent edits and A to B copy from either slot', () => {
  const { session, target } = fixture()
  let next = addEffect(session, target, 'compressor')
  const id = getEffectChain(next, target)[0].id
  next = switchEffectAB(next, target, id)
  assert.equal(getEffect(next, target, id).abSlot, 'B')
  next = updateEffect(next, target, id, { params: { thresholdDb: -30 } })
  next = switchEffectAB(parseSession(serializeSession(next)), target, id)
  assert.equal(getEffect(next, target, id).abSlot, 'A')
  assert.equal(getEffect(next, target, id).params.thresholdDb, -18)
  assert.equal(getEffect(next, target, id).bState!.thresholdDb, -30)
  next = copyEffectAToB(next, target, id)
  assert.equal(getEffect(next, target, id).bState!.thresholdDb, -18)
  next = switchEffectAB(next, target, id)
  next = updateEffect(next, target, id, { params: { thresholdDb: -40 } })
  next = copyEffectAToB(next, target, id)
  assert.equal(getEffect(next, target, id).abSlot, 'B')
  assert.equal(getEffect(next, target, id).params.thresholdDb, -18)
  assert.equal(getEffect(next, target, id).bState!.thresholdDb, -18)
})

test('mutation APIs reject bad targets, ranges, enums, unknown keys and malformed input without changing documents', () => {
  const { session, target } = fixture(), next = addEffect(session, target, 'eq')
  const id = getEffectChain(next, target)[0].id, snapshot = serializeSession(next)
  const invalidParams: Record<string, number>[] = [{ band3Freq: 0 }, { band3Gain: Infinity }, { band3Type: 6 }, { band3Type: .5 }, { band3Enabled: 2 }, { soloBand: 1.5 }, { unexpected: 1 }]
  for (const params of invalidParams) assert.throws(() => updateEffect(next, target, id, { params }), DawValidationError)
  assert.throws(() => updateEffect(next, target, id, { params: null } as unknown as DawEffectPatch), DawValidationError)
  assert.throws(() => updateEffect(next, target, id, { unexpected: 1 } as unknown as DawEffectPatch), DawValidationError)
  assert.throws(() => addEffect(next, target, { ...createEffect('eq'), unexpected: 1 } as DawEffect), DawValidationError)
  assert.throws(() => getEffectChain(next, 'missing'), DawValidationError)
  assert.throws(() => removeEffect(next, target, 'missing'), DawValidationError)
  assert.throws(() => moveEffect(next, target, id, 99), DawValidationError)
  assert.throws(() => addEffect(next, target, 'eq', .5), DawValidationError)
  assert.equal(serializeSession(next), snapshot)
})

test('delay divisions include straight, dotted and triplets and displays retain meaningful units', () => {
  assert.equal(DAW_DELAY_NOTE_BEATS[9], 1)
  assert.equal(DAW_DELAY_NOTE_BEATS[8], .75)
  assert.equal(DAW_DELAY_NOTE_BEATS[4], 1 / 3)
  const eq = getEffectDefinition('eq')
  assert.equal(formatEffectParameter(eq.parameters.find(item => item.key === 'band3Freq')!, 2500), '2.5 kHz')
  assert.equal(formatEffectParameter(eq.parameters.find(item => item.key === 'band3Gain')!, -2.5), '-2.5 dB')
  assert.equal(formatEffectParameter(eq.parameters.find(item => item.key === 'band3Type')!, 3), '高通')
})


test('clip effects resolve independently and survive project serialization', () => {
  let { session, target, other } = fixture()
  session = addAssetToSession(session, { id: 'asset', name: 'audio', url: '/api/daw/assets/asset', duration: 10, sampleRate: 48000, channels: 1, peaks: [], peakHopSec: .01 })
  session = addClip(session, target, 'asset')
  const clip = session.tracks[0].clips[0], clipTarget = clipEffectTarget(clip.id)
  const effect = createEffect('denoise')
  effect.noiseProfile = Array(128).fill(-60)
  effect.bNoiseProfile = Array(128).fill(-70)
  effect.bState = { ...effect.params }
  session = addEffect(session, clipTarget, effect)
  session = addEffect(session, target, 'eq')
  session = addEffect(session, 'master', 'limiter')
  assert.deepEqual(resolveEffectTarget(session, 'master'), { kind: 'master' })
  assert.equal(resolveEffectTarget(session, target)?.kind, 'track')
  const resolved = resolveEffectTarget(session, clipTarget)
  assert.equal(resolved?.kind, 'clip')
  if (resolved?.kind === 'clip') { assert.equal(resolved.track.id, target); assert.equal(resolved.clip.id, clip.id) }
  assert.equal(resolveEffectTarget(session, clipEffectTarget('missing')), undefined)
  assert.throws(() => updateEffect(session, target, effect.id, { enabled: false }), DawValidationError)
  assert.throws(() => addEffect(session, other, effect), DawValidationError)
  const loaded = parseSession(serializeSession(session))
  assert.deepEqual(getEffect(loaded, clipTarget, effect.id), getEffect(session, clipTarget, effect.id))
  assert.notEqual(getEffect(loaded, clipTarget, effect.id).noiseProfile, getEffect(session, clipTarget, effect.id).noiseProfile)
  const corrupt = structuredClone(session)
  corrupt.tracks[1].effects = [structuredClone(effect)]
  assert.ok(validateSession(corrupt).some(issue => issue.path.endsWith('.id')))
  assert.throws(() => parseSession(corrupt), DawValidationError)
  assert.throws(() => addTrack(session, { ...createTrack('duplicate'), effects: [structuredClone(effect)] }), DawValidationError)
})

test('split and duplicate clone clip effect data and assign globally unique IDs', () => {
  let { session, target, other } = fixture()
  session = addAssetToSession(session, { id: 'asset', name: 'audio', url: '/api/daw/assets/asset', duration: 10, sampleRate: 48000, channels: 1, peaks: [], peakHopSec: .01 })
  session = addClip(session, target, 'asset')
  const clipId = session.tracks[0].clips[0].id
  const effect = createEffect('denoise')
  effect.noiseProfile = Array(128).fill(-60)
  effect.bNoiseProfile = Array(128).fill(-70)
  effect.bState = { ...effect.params }
  session = addEffect(session, clipEffectTarget(clipId), effect)
  session = splitClip(session, target, clipId, 5)
  const [left, right] = session.tracks[0].clips
  assert.equal(left.effects![0].id, effect.id)
  assert.notEqual(right.effects![0].id, effect.id)
  assert.deepEqual({ ...right.effects![0], id: effect.id }, left.effects![0])
  assert.notEqual(right.effects![0].params, left.effects![0].params)
  assert.notEqual(right.effects![0].bState, left.effects![0].bState)
  assert.notEqual(right.effects![0].noiseProfile, left.effects![0].noiseProfile)
  assert.notEqual(right.effects![0].bNoiseProfile, left.effects![0].bNoiseProfile)
  session = duplicateClip(session, target, right.id)
  const duplicate = session.tracks[0].clips[2]
  assert.notEqual(duplicate.effects![0].id, right.effects![0].id)
  session = trimClip(session, target, right.id, 'end', 8)
  session = moveClip(session, target, right.id, 6, other)
  assert.equal(session.tracks[1].clips[0].effects![0].id, right.effects![0].id)
  assert.deepEqual(validateSession(session), [])
  assert.deepEqual(parseSession(serializeSession(session)), session)
})
