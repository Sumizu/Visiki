import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { DawAudioEngine } from '../src/daw/native-engine';
import { addEffect, clipEffectTarget, createEffect, removeEffect, updateEffect } from '../src/daw/effects';
import { createSession, createTrack, type DawSession } from '../src/daw/model';

const fixture = (): DawSession => {
  const session = createSession('传输测试'), track = createTrack('音轨');
  session.assets = [{ id: 'test-audio', name: 'test.wav', url: '/api/daw/assets/test-audio', duration: 10, channels: 2, sampleRate: 48000, peakHopSec: .1, peaks: [] }];
  track.clips = [{ id: 'test-clip', assetId: 'test-audio', name: 'test', start: 0, sourceIn: 0, duration: 10, gainDb: 0, fadeIn: 0, fadeOut: 0 }];
  track.effects = [createEffect('meter')]; session.tracks = [track]; return session;
};
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async (engine: DawAudioEngine) => { await (engine as any).serial; await new Promise<void>(resolve => setImmediate(resolve)); };
function mocked() {
  const original = globalThis.fetch, commands: Record<string, any>[] = [];
  let status = { position: 0, playing: false };
  const hooks: { session?: () => Promise<void>; mix?: () => Promise<void>; play?: () => Response | undefined; pause?: () => Promise<number>; status?: () => Promise<Response>; compare?: () => Promise<Response>; openEditor?: () => Response } = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!init) return hooks.status ? hooks.status() : Response.json(status);
    const command = JSON.parse(String(init.body)); commands.push(command);
    if (url === '/api/daw/native/compare') return hooks.compare!();
    if (command.op === 'vst3-open' && hooks.openEditor) return hooks.openEditor();
    if (command.op === 'session') await hooks.session?.();
    if (command.op === 'mix') await hooks.mix?.();
    if (command.op === 'play') {
      const failed = hooks.play?.(); if (failed) return failed;
      status = { position: command.position, playing: true };
    }
    if (command.op === 'seek') status.position = command.position;
    if (command.op === 'pause') status = { position: hooks.pause ? await hooks.pause() : status.position, playing: false };
    return Response.json({ ok: true, revision: command.revision ?? 1, ...status });
  }) as typeof fetch;
  return { hooks, commands, setStatus: (next: typeof status) => { status = next; }, restore: () => { globalThis.fetch = original; } };
}

test('A/B gain matching preserves the two slots, synchronizes attenuation to the mix and clears after an audible edit', async () => {
  const mock = mocked(), states: import('../src/daw/effect-comparison').EffectComparison[] = [];
  const engine = new DawAudioEngine(undefined, value => { if (value) states.push(value); else states.length = 0; });
  try {
    const session = fixture(), track = session.tracks[0];
    const fx = createEffect('stereo'); fx.bState = { ...fx.params, gainDb: 9 }; track.effects = [fx];
    mock.hooks.compare = async () => Response.json({ activeLufs: -20, otherLufs: -11, start: 0, end: 5 });
    engine.setSession(session); await engine.play();
    await engine.toggleComparison(fx.id);
    assert.equal(states.at(-1)?.trimDb, 0);
    const b = updateEffect(session, track.id, fx.id, { abSlot: 'B', params: fx.bState, bState: fx.params });
    engine.setSession(b); engine.commitSession(); await settle(engine);
    const mix = mock.commands.filter(command => command.op === 'mix').at(-1);
    assert.equal(mix?.compareDb, -9);
    assert.equal(mix?.mix.tracks[0].effects[0].params.gainDb, 9);
    assert.equal(states.at(-1)?.trimDb, -9);
    engine.setMonitorGain(-12); await settle(engine);
    assert.deepEqual(mock.commands.at(-1), { op: 'monitor', db: -12 });
    const edit = updateEffect(b, track.id, fx.id, { params: { gainDb: 8 } });
    engine.setSession(edit); engine.commitSession(); await settle(engine);
    assert.equal(mock.commands.filter(command => command.op === 'mix').at(-1)?.compareDb, 0);
    assert.equal(states.length, 0);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('native Auto Return ignores an old pause reply after seeking to the edit cursor', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  try {
    engine.setSession(fixture()); engine.setPlaybackRestartMode('from-cursor');
    await engine.play(2); assert.equal(engine.getEditPosition(), 2);
    mock.setStatus({ position: 5, playing: true }); await (engine as any).poll();
    const pause = deferred<number>(); mock.hooks.pause = () => pause.promise;
    engine.pauseTransport(); assert.equal(engine.getPosition(), 2);
    pause.resolve(5); await settle(engine);
    assert.equal(engine.getPosition(), 2); assert.equal(engine.isPlaying(), false);
    await engine.play(); assert.equal(mock.commands.filter(value => value.op === 'play').at(-1)?.position, 2);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('a VST3 window reloads an expired native host and syncs each edit once while stopped', async () => {
  const mock = mocked();
  let session = fixture();
  const track = session.tracks[0];
  const effect = { id: 'vendor-effect', type: 'vst3' as const, vst3: { classId: 'A'.repeat(32) }, enabled: true, params: { '100': 1 } };
  track.effects = [effect];
  const vst3HostId = crypto.randomUUID();
  let opens = 0;
  let nativeEdits: Array<{ seq: number; effectId: string; params: Record<string, number> }> = [];
  const received: number[] = [];
  mock.hooks.openEditor = () => Response.json(++opens === 1
    ? { loaded: false, editorOpened: false }
    : { loaded: true, editorOpened: true, vst3HostId, vst3Editors: [effect.id] });
  mock.hooks.status = async () => Response.json({ loaded: true, playing: false, vst3HostId, vst3Editors: [effect.id], vst3Edits: nativeEdits });
  const engine = new DawAudioEngine(undefined, undefined, undefined, (sessionId, edit) => {
    assert.equal(sessionId, session.id);
    received.push(edit.seq);
    session = updateEffect(session, track.id, effect.id, { params: edit.params });
    engine.setSession(session);
  });
  try {
    engine.setSession(session);
    assert.equal((await engine.openVst3Editor(effect.id)).opened, true);
    assert.deepEqual(mock.commands.map(command => command.op).slice(0, 4), ['session', 'vst3-open', 'session', 'vst3-open']);
    assert.equal(engine.isPlaying(), false);
    nativeEdits = [{ seq: 1, effectId: effect.id, params: { '100': .5 } }];
    await engine.syncVst3Editors();
    await engine.syncVst3Editors();
    engine.commitSession();
    await settle(engine);
    assert.deepEqual(received, [1]);
    const mix = mock.commands.filter(command => command.op === 'mix').at(-1);
    assert.equal(mix?.vst3After, 1);
    assert.equal(mix?.vst3HostId, vst3HostId);
    assert.equal(mix?.mix.tracks[0].effects[0].params['100'], .5);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('ongoing effect drag sends live snapshots, and release flushes the latest exact value', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  let session = fixture();
  const track = session.tracks[0];
  const effect = createEffect('delay'); track.effects = [effect];
  try {
    engine.setSession(session); await engine.play();
    for (let value = 1; value <= 14; value++) {
      session = updateEffect(session, track.id, effect.id, { params: { mix: value } }); engine.setSession(session);
      if (value < 14) await wait(12);
    }
    const updates = () => mock.commands.filter(command => command.op === 'mix');
    assert(updates().length >= 2, 'several changes reached the host without releasing the slider');
    assert.equal(mock.commands.filter(command => command.op === 'session').length, 1);
    const blocked = deferred<void>(); mock.hooks.mix = () => blocked.promise;
    engine.commitSession(); await wait(5);
    const pending = updates().length;
    for (let value = 15; value <= 19; value++) {
      session = updateEffect(session, track.id, effect.id, { params: { mix: value } }); engine.setSession(session);
      await wait(12);
    }
    engine.commitSession();
    assert.equal(updates().length, pending, 'a slow host retains just the latest unsent snapshot');
    blocked.resolve(); await settle(engine); await settle(engine);
    assert.equal(updates().at(-1)?.mix.tracks[0].effects[0].params.mix, 19);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('convolution mix edits reuse the graph but changing IR schedules a graph transition', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  let session = fixture();
  const track = session.tracks[0], impulse = createEffect('convolution'); track.effects = [impulse];
  try {
    engine.setSession(session); await engine.play();
    session = updateEffect(session, track.id, impulse.id, { params: { mix: 40 } });
    engine.setSession(session); engine.commitSession(); await settle(engine);
    assert.equal(mock.commands.filter(command => command.op === 'mix').at(-1)?.mix.tracks[0].effects[0].params.mix, 40);
    session = updateEffect(session, track.id, impulse.id, { params: { space: 3 } });
    engine.setSession(session); engine.commitSession(); await settle(engine);
    assert.equal(mock.commands.filter(command => command.op === 'session').at(-1)?.session.tracks[0].effects[0].params.space, 3);
    assert.equal(mock.commands.filter(command => command.op === 'play').length, 1);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('clip effect parameter updates address the clip while structural changes reload the graph', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  const original = fixture();
  const target = clipEffectTarget(original.tracks[0].clips[0].id), fx = createEffect('convolution');
  let session = addEffect(original, target, fx);
  try {
    engine.setSession(session); await engine.play();
    session = updateEffect(session, target, fx.id, { params: { mix: 52 } });
    engine.setSession(session); engine.commitSession(); await settle(engine);
    const patch = mock.commands.find(command => command.op === 'mix')?.mix.tracks[0];
    assert.equal(patch.effects, undefined);
    assert.equal(patch.clipEffects[0].id, session.tracks[0].clips[0].id);
    assert.equal(patch.clipEffects[0].effects[0].params.mix, 52);
    session = updateEffect(session, target, fx.id, { params: { space: 3 } });
    engine.setSession(session); engine.commitSession(); await settle(engine);
    assert.equal(mock.commands.filter(command => command.op === 'session').at(-1)?.session.tracks[0].clips[0].effects[0].params.space, 3);
    assert.equal(mock.commands.filter(command => command.op === 'play').length, 1);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('pause stops polling, and play restores an expired host once at the requested position', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  let statusCalls = 0;
  try {
    engine.setSession(fixture()); await engine.play(2);
    engine.pause(); await settle(engine);
    mock.hooks.status = async () => { statusCalls++; return Response.json({ loaded: true, position: 3, playing: true }); };
    await wait(125); assert.equal(statusCalls, 0);
    let expired = true;
    mock.hooks.play = () => {
      if (!expired) return;
      expired = false;
      return Response.json({ code: 'DAW_SESSION_REQUIRED', error: '当前会话未加载' }, { status: 409 });
    };
    await engine.play(3);
    assert.equal(engine.isPlaying(), true);
    assert.equal(mock.commands.filter(command => command.op === 'session').length, 2);
    assert.deepEqual(mock.commands.filter(command => command.op === 'play').map(command => command.position), [2, 3, 3]);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('inserting and removing the only effect keeps a running native preview on one device', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  try {
    const clean = fixture(), track = clean.tracks[0], inserted = createEffect('limiter');
    track.effects = [];
    mock.hooks.status = async () => Response.json({ available: true, position: 1, playing: true });
    engine.setSession(clean); await engine.play(1);
    engine.setSession(addEffect(clean, track.id, inserted)); engine.commitSession(); await settle(engine);
    engine.setSession(removeEffect(addEffect(clean, track.id, inserted), track.id, inserted.id)); engine.commitSession(); await settle(engine);
    assert.equal(engine.isPlaying(), true);
    assert.equal(mock.commands.filter(command => command.op === 'play').length, 1);
    assert.deepEqual(mock.commands.filter(command => command.op === 'session').map(command => command.session.tracks[0].effects?.length), [0, 1, 0]);
    assert(!mock.commands.some(command => command.op === 'pause' || command.op === 'dispose'));
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('the analyzer uses stereo window RMS and held peak when the last block is silent', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  try {
    const session = fixture(), effect = session.tracks[0].effects![0]; engine.setSession(session);
    mock.hooks.status = async () => Response.json({ position: 1, playing: true, loaded: true, effects: { [effect.id]: {
      outputPeak: 0, outputRms: 0, peakLeft: .5, peakRight: .25, rmsLeft: .3, rmsRight: .1,
      loudness: { integrated: null, shortTerm: null, truePeak: -6, momentary: null, lra: null },
    } } });
    await engine.play();
    const reading = engine.getEffectReading(effect.id)!;
    assert.equal(reading.outputRmsDb, -120);
    assert(Math.abs(reading.peakDb! - 20 * Math.log10(.5)) < 1e-6);
    assert(Math.abs(reading.rmsDb! - 10 * Math.log10(.05)) < 1e-6);
    assert.equal(reading.integratedLufs, undefined);
    assert.equal(reading.truePeakDb, -6);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('canceling play while the native session is loading never sends a late play command', async () => {
  const mock = mocked(), engine = new DawAudioEngine(), load = deferred<void>();
  try {
    mock.hooks.session = () => load.promise;
    engine.setSession(fixture()); const play = engine.play(); engine.pause();
    load.resolve(); await play; await settle(engine);
    assert.equal(engine.isPlaying(), false); assert.equal(mock.commands.some(command => command.op === 'play'), false);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('a stale poll error cannot interrupt a newer seek or report a transport failure', async () => {
  const mock = mocked(), errors: string[] = [], engine = new DawAudioEngine(message => errors.push(message));
  try {
    engine.setSession(fixture()); await (engine as any).flushSession();
    const pending = deferred<Response>(); mock.hooks.status = () => pending.promise;
    const poll = (engine as any).poll(); engine.seek(3);
    pending.reject(new Error('stale connection')); await poll; await settle(engine);
    assert.equal(engine.getPosition(), 3); assert.deepEqual(errors, []);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});

test('opening a new session keeps its zero cursor when the previous pause arrives late', async () => {
  const mock = mocked(), engine = new DawAudioEngine();
  try {
    engine.setSession(fixture()); await engine.play(4);
    const pause = deferred<number>(); mock.hooks.pause = () => pause.promise;
    engine.setSession(fixture()); pause.resolve(4); await settle(engine);
    assert.equal(engine.getPosition(), 0); assert.equal(engine.getEditPosition(), 0); assert.equal(engine.isPlaying(), false);
    engine.seek(2, { editPosition: NaN }); assert.equal(engine.getEditPosition(), 2);
  } finally { engine.dispose(); await settle(engine); mock.restore(); }
});
