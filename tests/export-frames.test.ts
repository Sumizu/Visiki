import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { frameBatchCount, MAX_FRAME_BATCH_BYTES, writeFrameBatch, type FrameWriteState } from '../server/export-frames';

const state = (overrides: Partial<FrameWriteState> = {}): FrameWriteState => ({
  width: 320, height: 180, total: 20, expected: 0, writing: false,
  state: 'rendering', lastActivity: 0, ...overrides,
});
const frameBytes = 320 * 180 * 4;

test('frame batches enforce whole frames, request size, ordered indexes and the remaining frame count', () => {
  const job = state();
  assert.equal(frameBatchCount(job, 0, frameBytes * 4), 4);
  assert.equal(frameBatchCount(state({ width: 1920, height: 1920 }), 0, 1920 * 1920 * 4), 1, 'largest supported frame still fits the request limit');
  for (const size of [0, -1, frameBytes - 1, frameBytes + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => frameBatchCount(job, 0, size), /字节数/);
  }
  assert.throws(() => frameBatchCount(state({ total: 1000 }), 0, Math.ceil(MAX_FRAME_BATCH_BYTES / frameBytes) * frameBytes), /16 MiB/);
  assert.throws(() => frameBatchCount(state({ expected: 19 }), 19, frameBytes * 2), /总帧数/);
  for (const index of [-1, 1, .5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => frameBatchCount(job, index, frameBytes), /帧顺序/);
  }
  assert.throws(() => frameBatchCount(state({ expected: 20 }), 20, frameBytes), /帧顺序/);
});

test('a bounded batch is written exactly once and acknowledged only after pipe backpressure clears', async () => {
  const job = state(); const writes: Buffer[] = [];
  let release: ((error?: Error | null) => void) | undefined;
  const input = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    writes.push(chunk); release = callback;
  } });
  const bytes = Buffer.concat([Buffer.alloc(frameBytes, 17), Buffer.alloc(frameBytes, 33)]);
  const pending = writeFrameBatch(job, 0, bytes, input);
  assert.equal(job.writing, true); assert.equal(job.expected, 0);
  await assert.rejects(writeFrameBatch(job, 0, bytes, input), /帧顺序/);
  assert.equal(writes.length, 1); assert.equal(writes[0], bytes, 'the batch is not copied or split into a server queue');
  release!();
  assert.equal(await pending, 2); assert.equal(job.expected, 2); assert.equal(job.writing, false);
  input.end();
});

test('failed and cancelled writes cannot acknowledge frames or leave the writer locked', async () => {
  const failed = state(); const input = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('pipe failed')); } });
  input.on('error', () => {});
  await assert.rejects(writeFrameBatch(failed, 0, Buffer.alloc(frameBytes), input), /pipe failed/);
  assert.equal(failed.expected, 0); assert.equal(failed.writing, false);
  const cancelled = state(); let release: (() => void) | undefined;
  const pendingInput = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
  const pending = writeFrameBatch(cancelled, 0, Buffer.alloc(frameBytes * 2), pendingInput);
  cancelled.state = 'cancelled'; release!();
  await assert.rejects(pending, /取消/);
  assert.equal(cancelled.expected, 0); assert.equal(cancelled.writing, false);
  pendingInput.end();
  for (const ended of ['encoding', 'complete', 'error', 'cancelled'] as const) {
    assert.throws(() => frameBatchCount(state({ state: ended }), 0, frameBytes), /结束或取消/);
  }
});
