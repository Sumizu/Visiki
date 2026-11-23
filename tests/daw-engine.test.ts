import test from 'node:test';
import assert from 'node:assert/strict';
import { DawPlaybackEngine, audibleDawTracks, DAW_MASTER_METER } from '../src/daw/engine';
import type { DawSession } from '../src/daw/model';

class Param { value = 1; setTargetAtTime(value: number) { this.value = value; } }
class Node {
  gain = new Param(); pan = new Param(); fftSize = 0; connectedGain = 0; connections: Node[] = []; outputs: number[] = []; disconnected = false;
  connect(node?: Node, output = 0) { this.connectedGain = this.gain.value; if (node) { this.connections.push(node); this.outputs.push(output); } }
  disconnect() { this.disconnected = true; this.connections = []; }
  getFloatTimeDomainData(data: Float32Array) { data.fill(.25); }
}
class Context {
  static last: Context; static count = 0;
  currentTime = 0; state = 'running'; destination = new Node(); gains: Node[] = []; panners: Node[] = []; analysers: Node[] = []; splitters: Node[] = [];
  constructor() { Context.last = this; Context.count++; }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createAnalyser() { const node = new Node(); this.analysers.push(node); return node; }
  createChannelSplitter() { const node = new Node(); this.splitters.push(node); return node; }
  createMediaElementSource() { return new Node(); }
  createStereoPanner() { const node = new Node(); this.panners.push(node); return node; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class Media {
  static instances: Media[] = [];
  preload = ''; src = ''; readyState = 4; currentTime = 0; paused = true;
  onloadedmetadata: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { Media.instances.push(this); }
  load() {}
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}
const fixture = (): DawSession => ({ schema: 'visiki-daw', version: 1, id: 'test-session', name: '测试混音', sampleRate: 48000, masterDb: 0,
  assets: [{ id: 'asset-a', name: '音频.wav', url: '/api/daw/assets/asset-a', duration: 20, sampleRate: 48000, channels: 1, peakHopSec: .1, peaks: [] }],
  tracks: [{ id: 'track-a', name: '人声', color: '#aabbcc', volumeDb: 0, pan: -.5, muted: false, solo: false, clips: [
    { id: 'clip-a', assetId: 'asset-a', name: '片段', start: 2, sourceIn: 3, duration: 5, gainDb: 0, fadeIn: 1, fadeOut: 1 },
    { id: 'clip-b', assetId: 'asset-a', name: '较晚片段', start: 15, sourceIn: 0, duration: 3, gainDb: 0, fadeIn: 0, fadeOut: 0 },
  ] }],
});

function mocked() {
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Media });
  Media.instances = []; Context.count = 0;
  return () => {
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext); else Reflect.deleteProperty(globalThis, 'AudioContext');
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio); else Reflect.deleteProperty(globalThis, 'Audio');
  };
}
const tick = (engine: DawPlaybackEngine) => (engine as unknown as { tick(): void }).tick();

test('streaming transport is lazy, schedules only nearby clips, seeks source offsets and releases on pause', async () => {
  const restore = mocked(), errors: string[] = [], engine = new DawPlaybackEngine(message => errors.push(message));
  try {
    engine.setSession(fixture()); assert.equal(Context.count, 0);
    await engine.play(2.5); await Promise.resolve();
    assert.equal(engine.isPlaying(), true); assert.equal(Media.instances.length, 1);
    assert.equal(Media.instances[0].currentTime, 3.5); assert.equal(Media.instances[0].paused, false);
    assert.equal(Context.last.panners[0].pan.value, -.5);
    Context.last.currentTime = 1; assert.equal(engine.getPosition(), 3.5);
    engine.pause(); assert.equal(engine.isPlaying(), false); assert.equal(engine.getPosition(), 3.5);
    assert.equal(Media.instances[0].paused, true); assert.equal(Media.instances[0].src, '');
    assert.deepEqual(errors, []);
  } finally { engine.dispose(); restore(); }
});

test('seeking rebuilds the active streaming voice without moving the document', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine(); const session = fixture();
  try {
    engine.setSession(session); await engine.play(3); await Promise.resolve();
    const original = Media.instances[0]; engine.seek(16); await Promise.resolve();
    assert.equal(original.paused, true); assert.equal(original.src, '');
    assert.equal(Media.instances.at(-1)!.currentTime, 1);
    assert.equal(engine.getPosition(), 16); assert.equal(session.tracks[0].clips[1].start, 15);
    engine.seek(100); assert.equal(engine.getPosition(), 18); assert.equal(engine.isPlaying(), false);
  } finally { engine.dispose(); restore(); }
});

test('mute/solo only affect audition buses; monitor gain remains outside session master', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    const session = fixture(); session.tracks.push({ ...session.tracks[0], id: 'track-b', clips: [], solo: true });
    assert.deepEqual([...audibleDawTracks(session)], ['track-b']);
    engine.setSession(session); await engine.play(3); await Promise.resolve();
    assert.equal(Context.last.gains[2].gain.value, 0);
    assert.equal(Media.instances.length, 0, 'inaudible clips must not decode or fail the rest of the mix');
    engine.setMonitorGain(-12); assert.ok(Math.abs(Context.last.gains[1].gain.value - 10 ** (-12 / 20)) < 1e-8);
    assert.equal(session.masterDb, 0);
    const muted = { ...session, tracks: session.tracks.map(t => ({ ...t, muted: true })) };
    assert.deepEqual([...audibleDawTracks(muted)], []);
    engine.setSession(muted); assert.equal(Context.last.gains[3].gain.value, 0);
    assert.deepEqual(engine.getLevels(), { 'track-a': .25, 'track-b': .25 });
  } finally { engine.dispose(); restore(); }
});

test('media failure pauses audition and a canceled pending play cannot restart it', async () => {
  const restore = mocked(), errors: string[] = [], engine = new DawPlaybackEngine(message => errors.push(message));
  try {
    engine.setSession(fixture()); await engine.play(3); await Promise.resolve();
    Media.instances[0].onerror?.(); assert.equal(engine.isPlaying(), false); assert.match(errors[0], /无法试听/);
    const pending = engine.play(3); engine.pause(); await pending;
    assert.equal(engine.isPlaying(), false);
    engine.dispose(); await engine.play(3); assert.equal(engine.isPlaying(), false);
  } finally { engine.dispose(); restore(); }
});

test('transport reaches the end and session switches never carry audio into another session', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); await engine.play(16); await Promise.resolve();
    Context.last.currentTime = 3; tick(engine);
    assert.equal(engine.isPlaying(), false); assert.equal(engine.getPosition(), 18);
    await engine.play(3); await Promise.resolve();
    engine.setSession({ ...fixture(), id: 'other-session' });
    assert.equal(engine.isPlaying(), false); assert.equal(engine.getPosition(), 0);
    assert.equal(Media.instances.at(-1)!.paused, true);
  } finally { engine.dispose(); restore(); }
});


test('new track and master buses start at their configured level before connecting', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    const session = fixture(); session.masterDb = -24; session.tracks[0].volumeDb = -40;
    engine.setSession(session); await engine.play(3); await Promise.resolve();
    assert.ok(Math.abs(Context.last.gains[0].connectedGain - 10 ** (-24 / 20)) < 1e-8);
    assert.ok(Math.abs(Context.last.gains[2].connectedGain - .01) < 1e-8);
  } finally { engine.dispose(); restore(); }
});

test('default transport resumes the paused position while retaining the user edit cursor', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); engine.seek(3.25);
    await engine.play(); Context.last.currentTime = 2;
    engine.pauseTransport();
    assert.equal(engine.getPosition(), 5.25);
    assert.equal(engine.getEditPosition(), 3.25);
    await engine.play();
    assert.equal(engine.getPosition(), 5.25);
    Context.last.currentTime = 3;
    assert.equal(engine.getPosition(), 6.25);
  } finally { engine.dispose(); restore(); }
});

test('from-cursor transport returns to the original cursor for repeated playback', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); engine.setPlaybackRestartMode('from-cursor'); engine.seek(3.25);
    await engine.play(); Context.last.currentTime = 2;
    assert.equal(engine.getPosition(), 5.25);
    engine.pauseTransport();
    assert.equal(engine.isPlaying(), false);
    assert.equal(engine.getPosition(), 3.25);
    assert.equal(engine.getEditPosition(), 3.25);
    await engine.play();
    assert.equal(engine.getPosition(), 3.25);
    Context.last.currentTime = 2.75;
    engine.pauseTransport();
    assert.equal(engine.getPosition(), 3.25);
  } finally { engine.dispose(); restore(); }
});

test('seeking while playing establishes a new edit cursor, independent of playback progress', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); engine.setPlaybackRestartMode('from-cursor');
    await engine.play(3); Context.last.currentTime = 1;
    engine.seek(4.5); Context.last.currentTime = 2;
    assert.equal(engine.getPosition(), 5.5);
    assert.equal(engine.getEditPosition(), 4.5);
    engine.pauseTransport(); assert.equal(engine.getPosition(), 4.5);
    await engine.play(15.5);
    assert.equal(engine.getEditPosition(), 15.5);
    assert.equal(engine.getPosition(), 15.5);
  } finally { engine.dispose(); restore(); }
});

test('canceling a cursor scrub restores both the playback head and the retained edit cursor', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); engine.setPlaybackRestartMode('from-cursor'); await engine.play(3);
    Context.last.currentTime = 2;
    const originalPosition = engine.getPosition(), originalEdit = engine.getEditPosition();
    assert.equal(originalPosition, 5); assert.equal(originalEdit, 3);
    engine.seek(7);
    engine.seek(originalPosition, { editPosition: originalEdit });
    assert.equal(engine.isPlaying(), true);
    assert.equal(engine.getPosition(), 5); assert.equal(engine.getEditPosition(), 3);
    engine.pauseTransport(); assert.equal(engine.getPosition(), 3);
    await engine.play(); assert.equal(engine.getPosition(), 3);
    engine.seek(4, { editPosition: -1 }); assert.equal(engine.getEditPosition(), 0);
    engine.seek(4, { editPosition: 100 }); assert.equal(engine.getEditPosition(), 18);
    engine.seek(4, { editPosition: NaN }); assert.equal(engine.getEditPosition(), 4);
    engine.seek(5); assert.equal(engine.getEditPosition(), 5, 'ordinary seeks still place a new edit cursor');
  } finally { engine.dispose(); restore(); }
});

test('internal pause and policy changes preserve the frozen head until the next user play action', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); await engine.play(3);
    Context.last.currentTime = 1.5; engine.pause();
    assert.equal(engine.getPosition(), 4.5);
    engine.setPlaybackRestartMode('from-cursor');
    assert.equal(engine.getPosition(), 4.5, 'changing preference does not seek immediately');
    await engine.play(); assert.equal(engine.getPosition(), 3);
    Context.last.currentTime = 2.5; engine.pause();
    assert.equal(engine.getPosition(), 4, 'internal pause always freezes the actual head');
    engine.setPlaybackRestartMode('resume');
    await engine.play(); assert.equal(engine.getPosition(), 4);
  } finally { engine.dispose(); restore(); }
});

test('natural end restarts from the edit cursor or the beginning according to playback policy', async () => {
  const restore = mocked();
  try {
    for (const mode of ['resume', 'from-cursor'] as const) {
      const engine = new DawPlaybackEngine();
      try {
        engine.setSession(fixture()); engine.setPlaybackRestartMode(mode);
        await engine.play(16); Context.last.currentTime = 3; tick(engine);
        assert.equal(engine.isPlaying(), false); assert.equal(engine.getPosition(), 18);
        assert.equal(engine.getEditPosition(), 16);
        await engine.play();
        assert.equal(engine.getPosition(), mode === 'from-cursor' ? 16 : 0);
      } finally { engine.dispose(); }
    }
  } finally { restore(); }
});

test('edit cursor clamps to shortened sessions and clears when another document opens', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    const session = fixture(); engine.setSession(session); engine.seek(16);
    engine.setSession({ ...session, tracks: [{ ...session.tracks[0], clips: session.tracks[0].clips.slice(0, 1) }] });
    assert.equal(engine.getPosition(), 7); assert.equal(engine.getEditPosition(), 7);
    engine.setSession({ ...fixture(), id: 'other-session' });
    assert.equal(engine.getPosition(), 0); assert.equal(engine.getEditPosition(), 0);
    engine.setPlaybackRestartMode('from-cursor'); engine.seek(18); await engine.play();
    assert.equal(engine.getPosition(), 0); assert.equal(engine.getEditPosition(), 0);
  } finally { engine.dispose(); restore(); }
});

test('from-cursor transport cancels pending playback without losing the original cursor', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); engine.setPlaybackRestartMode('from-cursor'); engine.seek(3.5);
    const pending = engine.play(); engine.pauseTransport(); await pending;
    assert.equal(engine.isPlaying(), false);
    assert.equal(engine.getPosition(), 3.5); assert.equal(engine.getEditPosition(), 3.5);
  } finally { engine.dispose(); restore(); }
});

test('actual peak and RMS are sampled for tracks and post-master output only while playing', async () => {
  const restore = mocked(), engine = new DawPlaybackEngine();
  try {
    engine.setSession(fixture()); assert.deepEqual(engine.getMeterLevels(), {});
    await engine.play(3); await Promise.resolve();
    const [masterLeft, masterRight, trackLeft, trackRight] = Context.last.analysers;
    assert.equal(Context.last.gains[0].connections[0], Context.last.gains[1]);
    assert.equal(Context.last.gains[0].connections[1], Context.last.splitters[0]);
    assert.equal(Context.last.gains[2].connections[0], Context.last.gains[0]);
    assert.equal(Context.last.gains[2].connections[1], Context.last.splitters[1]);
    assert.deepEqual(Context.last.splitters[0].connections, [masterLeft, masterRight]);
    assert.deepEqual(Context.last.splitters[0].outputs, [0, 1]);
    masterLeft.getFloatTimeDomainData = data => { data.fill(0); data[0] = -2; };
    masterRight.getFloatTimeDomainData = data => { data.fill(0); data[0] = 2; };
    trackLeft.getFloatTimeDomainData = data => { data.fill(.5); };
    trackRight.getFloatTimeDomainData = data => { data.fill(-.5); };
    const levels = engine.getMeterLevels();
    assert.deepEqual(levels['track-a'], { peak: .5, rms: .5 });
    assert.deepEqual(levels[DAW_MASTER_METER], { peak: 2, rms: 2 / Math.sqrt(1024) });
    trackRight.getFloatTimeDomainData = data => { data.fill(0); };
    assert.equal(engine.getMeterLevels()['track-a'].peak, .5, 'hard pan does not halve the peak');
    assert.ok(Math.abs(engine.getMeterLevels()['track-a'].rms - .5 / Math.sqrt(2)) < 1e-12);
    assert.deepEqual(engine.getLevels(), { 'track-a': .5 }, 'legacy peak API remains track-only');
    const beforeMonitor = engine.getMeterLevels();
    engine.setMonitorGain(-40);
    assert.deepEqual(engine.getMeterLevels(), beforeMonitor, 'monitor volume does not alter the mix readout');
    engine.pause(); assert.deepEqual(engine.getMeterLevels(), {});
    engine.dispose(); assert.equal(masterLeft.disconnected, true); assert.equal(masterRight.disconnected, true);
    assert.ok(Context.last.splitters.every(node => node.disconnected));
  } finally { engine.dispose(); restore(); }
});
