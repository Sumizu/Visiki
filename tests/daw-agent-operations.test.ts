import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDawAgentOperations, applyDawAgentOperationsAsync, dawAgentCatalog } from '../src/daw/agent-operations'
import { addAssetToSession, createSession, clipEnvelopeAt, validateSession } from '../src/daw/model'
import { getEffectChain } from '../src/daw/effects'
import { createDawAgentBridge, type DawAgentWorkspace } from '../src/daw/agent-bridge'

function fixture() {
  return addAssetToSession(createSession(), { id: 'audio1', name: 'source', url: '/api/daw/assets/audio1', duration: 4, sampleRate: 48000, sampleCount: 192000, channels: 1, peaks: [], peakHopSec: .01 })
}

test('batch creates and references IDs, slices envelopes, and copies clips across tracks', () => {
  const initial = fixture(), original = JSON.stringify(initial)
  const { session, results } = applyDawAgentOperations(initial, [
    { op: 'add_track', name: 'One' }, { op: 'add_track', name: 'Two' },
    { op: 'add_clip', trackId: '$0.trackId', assetId: 'audio1', start: 1 },
    { op: 'update_clip', trackId: '$0.trackId', clipId: '$2.clipId', fadeIn: 2 },
    { op: 'split_clip', trackId: '$0.trackId', clipId: '$2.clipId', time: 2 },
    { op: 'duplicate_clip', trackId: '$0.trackId', clipId: '$4.clipId', targetTrackId: '$1.trackId', start: 8 },
    { op: 'add_effect', target: 'clip:$5.clipId', type: 'eq', params: { band1Gain: 3 } }
  ])
  assert.equal(JSON.stringify(initial), original)
  assert.equal(session.tracks[1].clips[0].id, results[5].clipId)
  assert.equal(session.tracks[1].clips[0].start, 8)
  assert.equal(clipEnvelopeAt(session.tracks[0].clips[1], 0), .5)
  assert.equal(clipEnvelopeAt(session.tracks[1].clips[0], 0), .5)
  assert.equal(getEffectChain(session, `clip:${results[5].clipId}`)[0].id, results[6].effectId)
  assert.deepEqual(validateSession(session), [])
})

test('effects use actual presets, A/B slots, copying and chain capacity', () => {
  const ops: unknown[] = [{ op: 'add_track' }, { op: 'add_track' }, { op: 'add_effect', target: '$0.trackId', type: 'compressor' },
    { op: 'update_effect', target: '$0.trackId', effectId: '$2.effectId', params: { thresholdDb: -12 } },
    { op: 'effect_copy_ab', target: '$0.trackId', effectId: '$2.effectId' },
    { op: 'effect_ab', target: '$0.trackId', effectId: '$2.effectId', slot: 'B' },
    { op: 'copy_effect', target: '$0.trackId', effectId: '$2.effectId', destination: '$1.trackId' },
    { op: 'bypass_effect_chain', target: '$0.trackId' }]
  const { session, results } = applyDawAgentOperations(fixture(), ops)
  assert.equal(getEffectChain(session, results[0].trackId as string)[0].enabled, false)
  const copied = getEffectChain(session, results[1].trackId as string)[0]
  assert.equal(copied.id, results[6].effectId)
  assert.equal(copied.params.thresholdDb, -12)
  assert.equal(copied.abSlot, 'B')
  const capacity = [{ op: 'add_track' }, ...Array.from({ length: 12 }, () => ({ op: 'add_effect', target: '$0.trackId', type: 'eq' })), { op: 'add_effect', target: '$0.trackId', type: 'eq', enabled: false }]
  const full = applyDawAgentOperations(fixture(), capacity)
  assert.equal(getEffectChain(full.session, full.results[0].trackId as string).length, 13)
})

test('invalid batches are rejected without modifying the source', () => {
  const source = fixture(), before = JSON.stringify(source)
  for (const ops of [
    [{ op: 'add_track' }, { op: 'update_track', trackId: '$0.trackId', muted: 'yes' }],
    [{ op: 'add_track', typo: true }], [{ op: 'update_session', bpm: Infinity }],
    [{ op: 'add_track' }, { op: 'add_effect', target: '$0.trackId', type: 'eq', params: { typo: 1 } }],
    [{ op: 'add_track' }, { op: 'add_clip', trackId: '$0.trackId', assetId: 'audio1' }, { op: 'remove_asset', assetId: 'audio1' }],
    [{ op: 'add_effect', target: 'missing', type: 'ducker', sidechainTrackId: 'missing' }],
    [{ op: 'add_track' }, { op: 'add_effect', target: '$0.trackId', type: 'ducker', sidechainTrackId: '$0.trackId' }]
  ]) assert.throws(() => applyDawAgentOperations(source, ops))
  assert.equal(JSON.stringify(source), before)
})

test('copying while listening to B keeps B audible and copies it to A', () => {
  const target = 'master', effectId = '$0.effectId'
  const { session } = applyDawAgentOperations(fixture(), [
    { op: 'add_effect', target, type: 'stereo', params: { gainDb: -9 } },
    { op: 'effect_ab', target, effectId, slot: 'B' },
    { op: 'update_effect', target, effectId, params: { gainDb: -3 } },
    { op: 'effect_copy_ab', target, effectId },
  ])
  const effect = getEffectChain(session, target)[0]
  assert.equal(effect.abSlot, 'B')
  assert.equal(effect.params.gainDb, -3)
  assert.equal(effect.bState?.gainDb, -3)
})

test('catalog lists operation schemas and detailed effect definitions on demand', () => {
  const general = dawAgentCatalog(), detailed = dawAgentCatalog('eq')
  assert.ok(general.operationFields.split_clip.includes('time'))
  assert.equal(general.limits.activeEffectsPerChain, 12)
  assert.ok(!Array.isArray(detailed.effects) && detailed.effects.parameters.length > 0)
  assert.throws(() => dawAgentCatalog('invalid' as never))
})


test('VST3 additions and typed updates share one staged batch and reference created IDs', async () => {
  const source = fixture(), before = JSON.stringify(source)
  const plugin = { classId: 'A'.repeat(32), name: 'Example', vendor: '', version: '', category: '', parameters: [{ id: 7, name: 'Gain', unit: 'dB', defaultValue: .25, stepCount: 0, readOnly: false }] }
  const seen: unknown[] = []
  const result = await applyDawAgentOperationsAsync(source, [
    { op: 'add_track' },
    { op: 'add_vst3', target: '$0.trackId', classId: plugin.classId },
    { op: 'update_effect', target: '$0.trackId', effectId: '$1.effectId', vst3Params: [{ paramId: 7, format: 'plain', value: -6, unit: 'dB' }] },
  ], async request => { seen.push(request); return { plugin, params: request.kind === 'update' ? { '7': .4 } : {} as Record<string, number> } })
  assert.equal(JSON.stringify(source), before)
  assert.equal(seen.length, 2)
  assert.equal(getEffectChain(result.session, result.results[0].trackId as string)[0].params['7'], .4)
  assert.equal(result.results[2].effectId, result.results[1].effectId)
  await assert.rejects(applyDawAgentOperationsAsync(source, [
    { op: 'add_vst3', target: 'master', classId: plugin.classId },
    { op: 'update_effect', target: 'master', effectId: '$0.effectId', vst3Params: [{ paramId: 7, format: 'plain', value: 1 }, { paramId: 7, format: 'normalized', value: .1 }] },
  ], async () => ({ plugin, params: {} })))
  assert.equal(JSON.stringify(source), before)
})

test('VST3 parameter input rejects conflicts and malformed formats before resolution', async () => {
  for (const op of [
    { op: 'add_vst3', target: 'master', classId: 'A'.repeat(32), params: {}, vst3Params: [] },
    { op: 'add_vst3', target: 'master', classId: 'A'.repeat(32), vst3Params: [{ paramId: 1, format: 'normalized', value: 2 }] },
    { op: 'add_vst3', target: 'master', classId: 'A'.repeat(32), vst3Params: [{ paramId: 1, format: 'text', value: 'x', typo: true }] },
  ]) await assert.rejects(applyDawAgentOperationsAsync(fixture(), [op], async () => { throw new Error('resolver should not run') }), /参数|params/)
})


test('bridge commits once after SDK resolution, exposes pending readback, and rejects invalid updates atomically', async () => {
  const plugin = { classId: 'B'.repeat(32), name: 'Example', vendor: '', version: '', category: '', parameters: [{ id: 7, name: 'Gain', unit: 'dB', defaultValue: .25, stepCount: 0, readOnly: false }] }
  const originalFetch = globalThis.fetch
  let current = fixture(), revision = 0, commits = 0
  const engine = { syncVst3Editors: async () => {}, readVst3Values: async (requests: { effectId: string }[]) => requests.map(r => ({ ...r, state: 'active', values: [{ id: 7, normalizedValue: .5, processed: false }] })), getComparison: () => undefined, getNoiseListenId: () => undefined }
  const workspace = { session: () => current, revision: () => revision, editing: () => false, history: () => ({ canUndo: !!commits, canRedo: false }), commit: (next: typeof current) => { current = next; revision++; commits++ }, engine: () => engine, view: () => ({}), transport: () => ({}) } as unknown as DawAgentWorkspace
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/plugins')) return Response.json({ plugins: [plugin], issues: [], available: true })
    const request = JSON.parse(String(init?.body))
    if (request.updates?.some((update: { paramId: number }) => update.paramId !== 7)) return Response.json({ error: 'unknown parameter' }, { status: 400 })
    return Response.json({ classId: plugin.classId, parameters: [], total: 1, nextOffset: null, resolved: { '7': .5 } })
  }
  try {
    const bridge = createDawAgentBridge(() => workspace)
    const result = await bridge.execute({ type: 'edit', args: { operations: [
      { op: 'add_vst3', target: 'master', classId: plugin.classId },
      { op: 'update_effect', target: 'master', effectId: '$0.effectId', vst3Params: [{ paramId: 7, format: 'plain', value: -6 }] },
    ] } } as never, new AbortController().signal) as any
    assert.equal(commits, 1)
    assert.equal(result.vst3Readback.status, 'pending')
    assert.equal(getEffectChain(current, 'master')[0].params['7'], .5)
    const saved = JSON.stringify(current)
    await assert.rejects(bridge.execute({ type: 'edit', args: { operations: [{ op: 'update_effect', target: 'master', effectId: result.results[0].effectId, params: { '999': .5 } }] } } as never, new AbortController().signal))
    assert.equal(commits, 1)
    assert.equal(JSON.stringify(current), saved)
    bridge.dispose()
  } finally { globalThis.fetch = originalFetch }
})
