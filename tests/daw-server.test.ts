import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'visiki-daw-test-'));
process.env.VISIKI_DATA_DIR = temporaryRoot;
const { buildDawRenderPlan, buildFloatPeaks, readFloatWavInfo, dawRouter, killDawJobs, initializeDaw } = await import('../server/daw');
after(async () => {
  killDawJobs();
  assert(temporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(path.basename(temporaryRoot).startsWith('visiki-daw-test-'));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

const assetId = 'd6b5c951-8433-4f12-bdd3-abaf68782433';
function session(tracks: unknown[] = [{ id: 'one', name: '音轨', color: '#aaaaaa', volumeDb: -6, pan: 0, muted: false, solo: false,
  clips: [{ id: 'clip', name: '片段', assetId, start: 2, sourceIn: 1, duration: 3, gainDb: -3, fadeIn: .25, fadeOut: .5 }] }]) {
  return { schema: 'visiki-daw', version: 1, id: 'session', name: '中文混音', sampleRate: 48000, masterDb: -1, assets: [], tracks };
}
const lookup = (id: string) => id === assetId ? { id, channels: 1 as const, duration: 8, sampleRate: 48000, file: 'G:/internal-cache/opaque.wav' } : undefined;

function floatWav(channels: number, sampleRate: number, frames: number, at: (frame: number, channel: number) => number): Buffer {
  const buffer = Buffer.alloc(44 + frames * channels * 4);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 4, 28); buffer.writeUInt16LE(channels * 4, 32); buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * channels * 4, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) buffer.writeFloatLE(at(frame, channel), 44 + (frame * channels + channel) * 4);
  return buffer;
}

test('render uses internal assets and bakes trim, timeline delay, fades, track and master gains', () => {
  const input = session() as ReturnType<typeof session> & { url?: string; path?: string };
  input.url = 'https://example.invalid/track.wav'; input.path = 'C:/private/not-read.wav';
  const result = buildDawRenderPlan(input, lookup);
  assert.deepEqual(result.args, ['-y', '-filter_complex_threads', '2']);
  assert.match(result.filterGraph, new RegExp(`amovie=filename=${assetId}\\.wav:seek_point=0\\.95:dec_threads=1`));
  assert.doesNotMatch(result.filterGraph, /https:|private|opaque/);
  assert.match(result.filterGraph, /atrim=start_pts=48000:end_pts=192000,asetpts=PTS-STARTPTS/);
  assert.match(result.filterGraph, /pan=stereo\|c0=0\.707106781\*c0\|c1=0\.707106781\*c0/);
  assert.match(result.filterGraph, /volume=0\.707945784/);
  assert.match(result.filterGraph, /afade=t=in:st=0:d=0\.25:curve=tri/);
  assert.match(result.filterGraph, /afade=t=out:st=2\.5:d=0\.5:curve=tri/);
  assert.match(result.filterGraph, /anullsrc=r=48000:cl=stereo,atrim=end_sample=96000\[silence0\]/);
  assert.match(result.filterGraph, /\[silence0\]\[body0\]concat=n=2:v=0:a=1/);
  assert.doesNotMatch(result.filterGraph, /adelay=|asplit=/);
  assert.match(result.filterGraph, /volume=0\.501187234\[t0\]/);
  assert.match(result.filterGraph, /volume=0\.891250938,apad=whole_len=240000,atrim=end_sample=240000/);
  assert.equal(result.duration, 5); assert.equal(result.sampleCount, 240000); assert.equal(result.name, '中文混音.wav');
});

test('solo remains audition-only and muted tracks retain timeline duration as silence', () => {
  const tracks = [{ id: 'one', volumeDb: 0, pan: 0, muted: false, solo: false, clips: [{ id: 'a', assetId, start: 0, sourceIn: 0, duration: 1 }] },
    { id: 'two', volumeDb: 0, pan: 0, muted: false, solo: true, clips: [{ id: 'b', assetId, start: 1, sourceIn: 0, duration: 1 }] },
    { id: 'three', volumeDb: 0, pan: 0, muted: true, clips: [{ id: 'c', assetId: randomUUID(), start: 7, sourceIn: 0, duration: 1 }] }];
  const result = buildDawRenderPlan(session(tracks), lookup);
  assert.equal(result.filterGraph.match(/amovie=filename=/g)?.length, 2);
  assert.doesNotMatch(result.filterGraph, /asplit=/);
  assert.match(result.filterGraph, /\[t0\]\[t1\]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/);
  assert.equal(result.duration, 8);
  const silent = buildDawRenderPlan(session([{ ...tracks[2], muted: true }]), () => undefined);
  assert.deepEqual(silent.args, ['-y', '-filter_complex_threads', '2']); assert.match(silent.filterGraph, /anullsrc=r=48000:cl=stereo,atrim=end_sample=384000/);
});

test('stereo pan uses the same equal-power channel matrix as StereoPannerNode', () => {
  const t = { id: 'one', volumeDb: 0, pan: 1, clips: [{ id: 'a', assetId, start: 0, sourceIn: 0, duration: 1 }] };
  const stereo = (id: string) => ({ ...lookup(id)!, channels: 2 as const });
  assert.match(buildDawRenderPlan(session([t]), stereo).filterGraph, /pan=stereo\|c0=0\*c0\|c1=c1\+1\*c0/);
  assert.match(buildDawRenderPlan(session([{ ...t, pan: -1 }]), stereo).filterGraph, /pan=stereo\|c0=c0\+1\*c1\|c1=0\*c1/);
});

test('render rejects malformed identifiers, nonfinite controls, missing assets and source overruns', () => {
  const base = { id: 'one', volumeDb: 0, pan: 0, clips: [{ id: 'a', assetId, start: 0, sourceIn: 0, duration: 1 }] };
  assert.throws(() => buildDawRenderPlan(session([{ ...base, pan: NaN }]), lookup), /声像/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], assetId: '../private' }] }]), lookup), /标识/);
  assert.throws(() => buildDawRenderPlan(session([base]), () => undefined), /失联素材/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], sourceIn: 7, duration: 2 }] }]), lookup), /原始音频范围/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], start: 3600 }] }]), lookup), /60 分钟/);
  assert.throws(() => buildDawRenderPlan(session(Array.from({ length: 33 }, () => base)), lookup), /32/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], fadeIn: .7, fadeOut: .7 }] }]), lookup), /总长/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], envelope: [{ time: .1, gain: 0 }, { time: 1, gain: 1 }] }] }]), lookup), /覆盖整个片段/);
  assert.throws(() => buildDawRenderPlan(session([{ ...base, clips: [{ ...base.clips[0], envelope: [{ time: 0, gain: 0 }, { time: .5, gain: 1 }, { time: .5, gain: 0 }, { time: 1, gain: 0 }] }] }]), lookup), /递增/);
});

test('inherited split/trim envelopes use sample-level evaluation instead of applying fades twice', () => {
  const result = buildDawRenderPlan(session([{ id: 'one', volumeDb: 0, pan: 0, clips: [{ id: 'a', assetId, start: 0, sourceIn: 0,
    duration: 1, fadeIn: .2, fadeOut: .3, envelope: [{ time: 0, gain: .5 }, { time: .5, gain: 1 }, { time: 1, gain: 0 }] }] }]), lookup);
  assert.match(result.filterGraph, /aeval=exprs='val\(0\)\*/); assert.match(result.filterGraph, /\|val\(1\)\*/);
  assert.doesNotMatch(result.filterGraph, /afade=/);
});

test('streamed waveform cache preserves signed peaks, source rate, stereo channels and float headroom', async () => {
  const file = path.join(temporaryRoot, 'signed.wav');
  await fs.writeFile(file, floatWav(2, 44100, 1000, (frame, channel) => channel === 0 ? (frame % 2 ? 1.5 : -.75) : (frame % 2 ? .25 : -1.25)));
  const info = await readFloatWavInfo(file); assert.equal(info.channels, 2); assert.equal(info.sampleRate, 44100); assert.equal(info.sampleCount, 1000);
  const wave = await buildFloatPeaks(file, info);
  assert.equal(wave.peaks.length, 2); assert.equal(wave.peaks[0].min.length, 4); assert.equal(wave.peakHopSec, 256 / 44100);
  assert.deepEqual(wave.peaks[0].min, [-.75, -.75, -.75, -.75]); assert.deepEqual(wave.peaks[0].max, [1.5, 1.5, 1.5, 1.5]);
  assert.deepEqual(wave.peaks[1].min, [-1.25, -1.25, -1.25, -1.25]); assert.deepEqual(wave.peaks[1].max, [.25, .25, .25, .25]);
  const abort = new AbortController(); abort.abort(); await assert.rejects(() => buildFloatPeaks(file, info, abort.signal));
});

test('waveform bin count is bounded and invalid/truncated caches fail explicitly', async () => {
  const large = path.join(temporaryRoot, 'bounded.wav');
  await fs.writeFile(large, floatWav(1, 48000, 3_100_000, frame => frame % 256 === 0 ? -.6 : .2));
  const info = await readFloatWavInfo(large); const wave = await buildFloatPeaks(large, info);
  assert(wave.peaks[0].min.length <= 12000); assert.equal(wave.peaks[0].min[0], -.6);
  const invalid = path.join(temporaryRoot, 'invalid.wav'); await fs.writeFile(invalid, floatWav(3, 48000, 3, () => 0));
  await assert.rejects(() => readFloatWavInfo(invalid), /单声道或双声道/);
  await fs.writeFile(invalid, floatWav(1, 48000, 3, () => NaN));
  await assert.rejects(async () => buildFloatPeaks(invalid, await readFloatWavInfo(invalid)), /浮点样本/);
  const short = floatWav(1, 48000, 3, () => 0).subarray(0, 46); await fs.writeFile(invalid, short);
  await assert.rejects(() => readFloatWavInfo(invalid), /不完整/);
});

test('RF64 float cache metadata reads the 64-bit data chunk length', async () => {
  const basic = floatWav(1, 48000, 100, () => .4);
  const ds64 = Buffer.alloc(36); ds64.write('ds64'); ds64.writeUInt32LE(28, 4); ds64.writeBigUInt64LE(BigInt(basic.length + 36 - 8), 8); ds64.writeBigUInt64LE(400n, 16); ds64.writeBigUInt64LE(100n, 24);
  const rf64 = Buffer.concat([basic.subarray(0, 12), ds64, basic.subarray(12)]); rf64.write('RF64'); rf64.writeUInt32LE(0xffffffff, 4); rf64.writeUInt32LE(0xffffffff, 76);
  const file = path.join(temporaryRoot, 'rf64.wav'); await fs.writeFile(file, rf64);
  const info = await readFloatWavInfo(file); assert.equal(info.sampleCount, 100); assert.equal(info.dataOffset, 80);
});

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0;
test('real DAW router imports float audio, serves ranges, restores metadata and renders a 24-bit mix', { skip: !hasFfmpeg }, async t => {
  await initializeDaw();
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/daw', dawRouter);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  try {
    const upload = new FormData(); upload.append('file', new Blob([new Uint8Array(floatWav(1, 44100, 4410, () => 1.5))], { type: 'audio/wav' }), 'headroom.wav');
    const imported = await fetch(`${url}/api/daw/assets`, { method: 'POST', body: upload }); assert.equal(imported.status, 200);
    const asset = await imported.json(); assert.equal(asset.channels, 1); assert.equal(asset.sampleRate, 44100); assert.equal(asset.sampleCount, 4410); assert.equal(asset.peaks[0].max[0], 1.5);
    const sourceFiles = await fs.readdir(path.join(temporaryRoot, 'daw', 'sources'));
    const unsupported = new FormData(); unsupported.append('file', new Blob([new Uint8Array(floatWav(3, 48000, 1000, () => .2))], { type: 'audio/wav' }), 'multichannel.wav');
    const rejected = await fetch(`${url}/api/daw/assets`, { method: 'POST', body: unsupported }); assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /单声道或双声道/);
    assert.deepEqual(await fs.readdir(path.join(temporaryRoot, 'daw', 'sources')), sourceFiles, 'Rejected import does not leave partial files');
    assert.equal((await (await fetch(`${url}/api/daw/assets/${asset.id}/metadata`)).json()).id, asset.id);
    assert.equal((await (await fetch(`${url}/api/daw/assets?ids=${asset.id}`)).json()).assets.length, 1);
    const range = await fetch(`${url}${asset.url}`, { headers: { Range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    const exportSession = session([{ id: 'one', name: '测试', color: '#aaaaaa', volumeDb: -6, pan: 0, muted: false, solo: false,
      clips: [{ id: 'a', assetId: asset.id, name: '片段', start: .1, sourceIn: 0, duration: .1, gainDb: -6, fadeIn: 0, fadeOut: 0 }] }]);
    exportSession.masterDb = 0;
    const rendered = await fetch(`${url}/api/daw/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: exportSession }) });
    const result = await rendered.json(); assert.equal(rendered.status, 200, JSON.stringify(result)); assert.equal(result.sampleCount, 9600); assert.equal(result.duration, .2);
    assert.equal(result.clippedSamples, 0);
    assert.equal(result.loudness.integrated, null);
    assert(Number.isFinite(result.loudness.truePeak));
    const download = await fetch(`${url}${result.url}`); assert.equal(download.status, 200); const mixed = Buffer.from(await download.arrayBuffer());
    assert.equal(mixed.toString('ascii', 0, 4), 'RIFF');
    let offset = 12, dataOffset = 0, dataSize = 0;
    while (offset + 8 <= mixed.length) { const tag = mixed.toString('ascii', offset, offset + 4), size = mixed.readUInt32LE(offset + 4); if (tag === 'fmt ') { assert.equal(mixed.readUInt16LE(offset + 22), 24); assert.equal(mixed.readUInt32LE(offset + 12), 48000); } if (tag === 'data') { dataOffset = offset + 8; dataSize = size; break; } offset += 8 + size + size % 2; }
    assert.equal(dataSize, 9600 * 2 * 3); assert.equal(mixed.readIntLE(dataOffset + 100 * 6, 3), 0);
    const expected = 1.5 * Math.pow(10, -12 / 20) * Math.SQRT1_2;
    assert(Math.abs(mixed.readIntLE(dataOffset + 7200 * 6, 3) / 8388608 - expected) < .0001);
    const qualityUpload = new FormData();
    qualityUpload.append('file', new Blob([new Uint8Array(floatWav(2, 48000, 24000, (frame, channel) => {
      if (!channel && frame < 1200) return 1.25;
      if (channel && frame % 3 === 0) return -1.25;
      return .2 * Math.sin(2 * Math.PI * 1000 * frame / 48000);
    }))], { type: 'audio/wav' }), 'known-clipping.wav');
    const qualityImport = await fetch(`${url}/api/daw/assets`, { method: 'POST', body: qualityUpload });
    const qualityAsset = await qualityImport.json(); assert.equal(qualityImport.status, 200, JSON.stringify(qualityAsset));
    const qualitySession = session([{ id: 'one', volumeDb: 0, pan: 0, clips: [{ id: 'quality', assetId: qualityAsset.id, start: 0, sourceIn: 0, duration: .5 }] }]);
    qualitySession.masterDb = 0;
    const qualityResponse = await fetch(`${url}/api/daw/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: qualitySession }) });
    const quality = await qualityResponse.json();
    assert.equal(qualityResponse.status, 200, JSON.stringify(quality));
    assert.equal(quality.sampleCount, 24000);
    assert.equal(quality.clippedSamples, 1200 + 8000);
    assert(Number.isFinite(quality.loudness.integrated));
    assert(Number.isFinite(quality.loudness.truePeak) && quality.loudness.truePeak >= -.01);
    const renderAudio = async (clips: unknown[], sampleRate = 48000) => {
      const s = session([{ id: 'one', volumeDb: -12, pan: 0, clips }]); s.masterDb = 0;
      s.sampleRate = sampleRate;
      const response = await fetch(`${url}/api/daw/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: s }) });
      const render = await response.json(); assert.equal(response.status, 200, JSON.stringify(render));
      const file = Buffer.from(await (await fetch(`${url}${render.url}`)).arrayBuffer());
      let position = 12;
      while (position + 8 <= file.length) { const length = file.readUInt32LE(position + 4); if (file.toString('ascii', position, position + 4) === 'data') return file.subarray(position + 8, position + 8 + length); position += 8 + length + length % 2; }
      throw new Error('Missing WAV data');
    };
    const originalFade = await renderAudio([{ id: 'full', assetId: asset.id, start: 0, sourceIn: 0, duration: .1, fadeIn: .04, fadeOut: .04 }]);
    const splitFade = await renderAudio([{ id: 'first', assetId: asset.id, start: 0, sourceIn: 0, duration: .05, envelope: [{ time: 0, gain: 0 }, { time: .04, gain: 1 }, { time: .05, gain: 1 }] },
      { id: 'second', assetId: asset.id, start: .05, sourceIn: .05, duration: .05, envelope: [{ time: 0, gain: 1 }, { time: .01, gain: 1 }, { time: .05, gain: 0 }] }]);
    assert.equal(originalFade.length, splitFade.length);
    let maximumDifference = 0;
    for (let sample = 0; sample < originalFade.length; sample += 3) maximumDifference = Math.max(maximumDifference, Math.abs(originalFade.readIntLE(sample, 3) - splitFade.readIntLE(sample, 3)));
    assert(maximumDifference <= 3, `Split fade differs by ${maximumDifference} 24-bit units`);
    const rampUpload = new FormData();
    rampUpload.append('file', new Blob([new Uint8Array(floatWav(1, 44100, 44100, frame => frame / 44100 * .8 - .4))], { type: 'audio/wav' }), 'non-periodic-ramp.wav');
    const rampResponse = await fetch(`${url}/api/daw/assets`, { method: 'POST', body: rampUpload }); const ramp = await rampResponse.json(); assert.equal(rampResponse.status, 200);
    const rampStart = 7777, rampLength = 12345;
    const trimmedRamp = await renderAudio([{ id: 'ramp', assetId: ramp.id, start: 0, sourceIn: rampStart / 44100, duration: rampLength / 44100 }], 44100);
    assert.equal(trimmedRamp.length, rampLength * 2 * 3);
    for (const frame of [0, 1, 99, 1023, 4095, rampLength - 1]) {
      const expectedValue = Math.fround((rampStart + frame) / 44100 * .8 - .4) * Math.pow(10, -12 / 20) * Math.SQRT1_2;
      assert(Math.abs(trimmedRamp.readIntLE(frame * 6, 3) / 8388608 - expectedValue) < .0000003, `Source frame ${rampStart + frame} is preserved`);
    }
    const rampSplit = 6001;
    const repeatedRamp = await renderAudio([{ id: 'ramp-first', assetId: ramp.id, start: 0, sourceIn: rampStart / 44100, duration: rampSplit / 44100 },
      { id: 'ramp-second', assetId: ramp.id, start: rampSplit / 44100, sourceIn: (rampStart + rampSplit) / 44100, duration: (rampLength - rampSplit) / 44100 }], 44100);
    assert.equal(repeatedRamp.length, trimmedRamp.length);
    for (let sample = 0; sample < trimmedRamp.length; sample += 3) assert(Math.abs(trimmedRamp.readIntLE(sample, 3) - repeatedRamp.readIntLE(sample, 3)) <= 1, `Same-source split sample ${sample / 6}`);
    const latePlan = buildDawRenderPlan({ ...exportSession, sampleRate: 8000, masterDb: 0, tracks: [{ id: 'late', volumeDb: 0, pan: 0, clips: [{ id: 'late', assetId: asset.id, start: 3599.9, sourceIn: 0, duration: .1 }] }] },
      id => id === asset.id ? { ...asset, file: path.join(temporaryRoot, 'daw', 'sources', `${id}.wav`) } : undefined);
    const late = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-benchmark', ...latePlan.args, '-filter_complex', `${latePlan.filterGraph};[mix]atrim=start=3599.9,asetpts=PTS-STARTPTS[tail]`, '-map', '[tail]', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
      { windowsHide: true, cwd: path.join(temporaryRoot, 'daw', 'sources'), timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(late.status, 0, late.stderr.toString()); assert.equal(late.stdout.length, 800 * 2 * 4);
    assert(Math.abs(late.stdout.readFloatLE(200 * 8) - 1.5 * Math.SQRT1_2) < .00001);
    const maximumRss = /maxrss=(\d+)kB/.exec(late.stderr.toString());
    if (maximumRss && Number(maximumRss[1])) assert(Number(maximumRss[1]) < 256 * 1024, 'Long timeline stays below 256 MiB RSS');
    t.diagnostic(`3599.9s late clip: 800 tail frames correct; FFmpeg max RSS ${maximumRss?.[1] || 'unreported'} kB`);
    assert.equal((await fs.readdir(path.join(temporaryRoot, 'daw', 'renders'))).some(file => file.endsWith('.filter.txt')), false);
    const malicious = { ...exportSession, tracks: [{ ...exportSession.tracks[0] as object, clips: [{ id: 'p', assetId: '../private', start: 0, sourceIn: 0, duration: 1 }] }] };
    assert.equal((await fetch(`${url}/api/daw/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: malicious }) })).status, 400);
    const existingRenders = new Set(await fs.readdir(path.join(temporaryRoot, 'daw', 'renders')));
    const abort = new AbortController();
    const cancelled = fetch(`${url}/api/daw/render`, { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: { ...exportSession, duration: 600 } }) });
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fs.readdir(path.join(temporaryRoot, 'daw', 'renders'))).some(file => file.endsWith('.filter.txt'))) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(started, 'The cancel test reached a live render'); abort.abort(); await assert.rejects(cancelled);
    let leftovers: string[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      leftovers = (await fs.readdir(path.join(temporaryRoot, 'daw', 'renders'))).filter(file => !existingRenders.has(file));
      if (!leftovers.length) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(leftovers, [], 'Cancelled WAV, metadata and filter graph are removed');
    await fs.unlink(path.join(temporaryRoot, 'daw', 'sources', `${asset.id}.wav`));
    assert.equal((await fetch(`${url}/api/daw/assets/${asset.id}/metadata`)).status, 404);
    assert.equal((await (await fetch(`${url}/api/daw/assets?ids=${asset.id}`)).json()).assets.length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
