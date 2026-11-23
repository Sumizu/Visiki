import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import express from 'express';
import { buildSync } from 'esbuild';
import { analyzeDawRhythmFile, rhythmAnalysisRange, runRhythmWorker } from '../server/daw-rhythm';
import { readRhythmAudio, type RhythmWavInfo } from '../server/daw-rhythm-audio';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'visiki-rhythm-test-'));
process.env.VISIKI_DATA_DIR = temporaryRoot;
const sourceRoot = path.join(temporaryRoot, 'daw', 'sources');
await fs.mkdir(sourceRoot, { recursive: true });
const assetId = randomUUID();
const sourceFile = path.join(sourceRoot, `${assetId}.wav`);
const rate = 22050;
const duration = 24;

function floatWav(channels: 1 | 2, sampleRate: number, frames: number, at: (frame: number, channel: number) => number): Buffer {
  const buffer = Buffer.alloc(44 + frames * channels * 4);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 4, 28); buffer.writeUInt16LE(channels * 4, 32); buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * channels * 4, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) buffer.writeFloatLE(at(frame, channel), 44 + (frame * channels + channel) * 4);
  return buffer;
}

await fs.writeFile(sourceFile, floatWav(1, rate, rate * duration, frame => {
  const phase = frame % (rate / 2); const beat = Math.floor(frame / (rate / 2));
  return phase < rate * .04 ? Math.sin(2 * Math.PI * 430 * phase / rate) * Math.exp(-phase / (rate * .012)) * (beat % 4 === 0 ? .9 : .45) : 0;
}));
await fs.writeFile(path.join(sourceRoot, `${assetId}.json`), JSON.stringify({ peaks: [{ min: [-.8], max: [.8] }] }));
await fs.writeFile(path.join(temporaryRoot, 'daw', 'assets.json'), JSON.stringify({ version: 1, assets: [{ id: assetId, name: 'rhythm.wav', sampleRate: rate,
  sampleCount: rate * duration, channels: 1, peakHopSec: duration }] }));

const workerPath = path.join(temporaryRoot, 'daw-rhythm-worker.cjs');
// Test the production worker bundle rather than assuming worker_threads inherits tsx.
buildSync({ entryPoints: [path.resolve('server/daw-rhythm-worker.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const { dawRouter, readFloatWavInfo, killDawJobs } = await import('../server/daw');
const info = await readFloatWavInfo(sourceFile);

after(async () => {
  killDawJobs();
  assert(temporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(path.basename(temporaryRoot).startsWith('visiki-rhythm-test-'));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

test('analysis ranges are sample-aligned, bounded, and never exceed cached source data', () => {
  assert.deepEqual(rhythmAnalysisRange(info, {}), { startSample: 0, sampleCount: duration * rate });
  assert.deepEqual(rhythmAnalysisRange(info, { start: 10.00001, duration: 8 }), { startSample: 220500, sampleCount: 176400 });
  assert.deepEqual(rhythmAnalysisRange(info, { start: 18, duration: 20 }), { startSample: 396900, sampleCount: 132300 });
  for (const input of [null, [], { start: NaN }, { start: -1 }, { start: 24 }, { duration: 0 }, { duration: 90.1 }, { duration: '30' }]) {
    assert.throws(() => rhythmAnalysisRange(info, input), /无效|范围|时长/);
  }
  assert.throws(() => rhythmAnalysisRange(info, { start: 22, duration: 1 }), /至少需要 6 秒/);
});

test('worker preprocessing preserves anti-phase stereo and a right-only rhythm without whole-file reads', async () => {
  const file = path.join(temporaryRoot, 'opposite.wav');
  const frames = 8000 * 6;
  const wave = floatWav(2, 8000, frames, (frame, channel) => (channel ? -1 : 1) * (frame % 40 < 20 ? .6 : -.6));
  await fs.writeFile(file, wave);
  const wavInfo = await readFloatWavInfo(file);
  const job = { file, info: wavInfo, startSample: 8000, sampleCount: 8000 * 4 };
  const opposite = await readRhythmAudio(job);
  assert.equal(opposite.sampleRate, 8000);
  assert.deepEqual(opposite.channels.map(channel => channel.length), [32000, 32000]);
  assert(opposite.channels[0].every((value, frame) => Math.abs(value) > .59 && value === -opposite.channels[1][frame]));
  await fs.writeFile(file, floatWav(2, 8000, frames, (frame, channel) => channel ? Math.sin(frame / 20) * .7 : 0));
  const right = await readRhythmAudio(job);
  assert(right.channels[0].every(value => value === 0));
  assert(right.channels[1].some(value => Math.abs(value) > .69), 'Silent L does not erase R');
  await fs.writeFile(file, wave.subarray(0, 70));
  await assert.rejects(() => readRhythmAudio(job), /不完整/);
});

test('the rhythm worker finds quiet percussion alongside a loud sustained channel', async () => {
  const file = path.join(temporaryRoot, 'quiet-percussion.wav');
  await fs.writeFile(file, floatWav(2, rate, rate * 20, (frame, channel) => {
    if (!channel) return .85 * Math.sin(2 * Math.PI * 440 * frame / rate);
    const phase = frame % (rate / 2);
    return phase < rate * .045 ? .065 * Math.sin(2 * Math.PI * 260 * phase / rate) * Math.exp(-phase / (rate * .012)) : 0;
  }));
  const stereo = await readFloatWavInfo(file);
  const analysis = await runRhythmWorker({ file, info: stereo, startSample: 0, sampleCount: stereo.sampleCount }, new AbortController().signal, workerPath);
  assert(analysis.bpm !== null && Math.abs(analysis.bpm - 120) < 2, `Expected 120 BPM, got ${analysis.bpm}`);
});

test('production worker analyzes a bounded excerpt, caches results and leaves source audio untouched', async () => {
  const before = await fs.readFile(sourceFile);
  const source = { assetId, file: sourceFile, info };
  const first = await analyzeDawRhythmFile(source, { start: 2, duration: 16 }, new AbortController().signal, workerPath);
  assert.equal(first.assetId, assetId); assert.equal(first.start, 2); assert.equal(first.cached, false);
  assert(first.bpm !== null && Math.abs(first.bpm - 120) < 2, `Expected 120 BPM, got ${first.bpm}`);
  assert.equal(first.analyzedSeconds, 16); assert(first.beatTimes.every(time => time >= 2 && time <= 18));
  first.warnings.push('caller mutation');
  const second = await analyzeDawRhythmFile(source, { start: 2, duration: 16 }, new AbortController().signal, 'not-used-because-cached.cjs');
  assert.equal(second.cached, true); assert(!second.warnings.includes('caller mutation'));
  assert.deepEqual(await fs.readFile(sourceFile), before);
});

test('worker cancellation terminates work and pre-aborted jobs do not start', async () => {
  const waitingWorker = path.join(temporaryRoot, 'waiting-worker.cjs');
  await fs.writeFile(waitingWorker, 'setInterval(() => {}, 1000);');
  const job = { file: sourceFile, info, startSample: 0, sampleCount: info.sampleCount };
  const abort = new AbortController();
  const pending = runRhythmWorker(job, abort.signal, waitingWorker);
  const timer = setTimeout(() => abort.abort(), 30);
  try { await assert.rejects(pending, error => (error as { status?: number }).status === 499); } finally { clearTimeout(timer); }
  const already = new AbortController(); already.abort();
  assert.throws(() => runRhythmWorker(job, already.signal, 'not-a-worker.cjs'), /abort/i);
});

test('a cancelled worker keeps its task pending until termination has completed', async () => {
  const waitingWorker = path.join(temporaryRoot, 'termination-worker.cjs');
  await fs.writeFile(waitingWorker, 'setInterval(() => {}, 1000);');
  const originalTerminate = Worker.prototype.terminate;
  let releaseTermination!: () => void;
  const released = new Promise<void>(resolve => { releaseTermination = resolve; });
  let didTerminate!: () => void;
  const terminating = new Promise<void>(resolve => { didTerminate = resolve; });
  let workerExited = false;
  Worker.prototype.terminate = function () {
    const pending = originalTerminate.call(this);
    didTerminate();
    return pending.then(async code => { workerExited = true; await released; return code; });
  };
  const controller = new AbortController();
  let settled = false;
  const pending = runRhythmWorker({ file: sourceFile, info, startSample: 0, sampleCount: info.sampleCount }, controller.signal, waitingWorker)
    .then(() => { settled = true; return undefined; }, error => { settled = true; return error as Error & { status?: number }; });
  try {
    controller.abort(); await terminating;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Cancellation must await terminate(), so the API task gate cannot reopen early');
    releaseTermination();
    const error = await pending;
    assert.equal(error?.status, 499); assert.equal(workerExited, true);
  } finally {
    releaseTermination(); Worker.prototype.terminate = originalTerminate; await pending;
  }
});

test('analysis router accepts only existing internal UUID assets and validates requested ranges', async () => {
  await analyzeDawRhythmFile({ assetId, file: sourceFile, info }, { start: 3, duration: 16 }, new AbortController().signal, workerPath);
  const app = express(); app.use(express.json()); app.use('/api/daw', dawRouter);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/daw/analyze-rhythm`;
  const post = (input: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  try {
    for (const input of [null, {}, { assetId: '../private' }, { assetId, start: -1 }, { assetId, duration: 100 }, { assetId, start: 23 }]) {
      assert.equal((await post(input)).status, 400);
    }
    assert.equal((await post({ assetId: randomUUID(), file: sourceFile })).status, 404);
    // Precomputed production-worker output also proves that the route cannot
    // read request-supplied paths or URLs.
    const response = await post({ assetId, start: 3, duration: 16, file: 'C:/private/ignored.wav', url: 'https://example.invalid/ignored' });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.assetId, assetId); assert.equal(result.cached, true); assert(Math.abs(result.bpm - 120) < 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the audio task gate rejects a retry until the cancelled analysis worker has exited', async () => {
  await analyzeDawRhythmFile({ assetId, file: sourceFile, info }, { start: 3, duration: 16 }, new AbortController().signal, workerPath);
  const app = express(); app.use(express.json()); app.use('/api/daw', dawRouter);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/daw/analyze-rhythm`;
  const post = (start: number, signal?: AbortSignal) => fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId, start, duration: 16 }) });
  const originalOnce = Worker.prototype.once;
  const originalTerminate = Worker.prototype.terminate;
  let announceWorker!: () => void;
  const created = new Promise<void>(resolve => { announceWorker = resolve; });
  let announceTermination!: () => void;
  const terminating = new Promise<void>(resolve => { announceTermination = resolve; });
  let releaseTermination!: () => void;
  const released = new Promise<void>(resolve => { releaseTermination = resolve; });
  let announceComplete!: () => void;
  const completed = new Promise<void>(resolve => { announceComplete = resolve; });
  Worker.prototype.once = function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
    if (event === 'message') announceWorker();
    return originalOnce.call(this, event, listener);
  } as typeof originalOnce;
  Worker.prototype.terminate = function () {
    const pending = originalTerminate.call(this); announceTermination();
    return pending.then(async code => { await released; announceComplete(); return code; });
  };
  const controller = new AbortController();
  const request = post(1, controller.signal).then(response => response, error => error as Error);
  const timeout = setTimeout(() => { controller.abort(); releaseTermination(); announceWorker(); announceTermination(); announceComplete(); }, 5000);
  try {
    await created; controller.abort(); await terminating;
    assert.equal((await post(3)).status, 409, 'A still-terminating worker keeps the shared import/render/analysis slot occupied');
    releaseTermination(); await completed;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await post(3)).status, 200, 'The slot becomes available once termination really completes');
    assert((await request) instanceof Error);
  } finally {
    clearTimeout(timeout); controller.abort(); releaseTermination();
    Worker.prototype.once = originalOnce; Worker.prototype.terminate = originalTerminate;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
