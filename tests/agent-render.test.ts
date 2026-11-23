import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject } from '../src/default-project';
import { agentExportSettings, waitForAgent } from '../src/agent-render';

test('agent export keeps portrait geometry and uses explicit song-time range', () => {
  const project = { ...createDefaultProject(), width: 1080, height: 1920, fps: 24, duration: 12 };
  assert.deepEqual(agentExportSettings(project, { start: 2, end: 4 }), { width: 1080, height: 1920, fps: 24, start: 2, end: 4 });
  assert.deepEqual(agentExportSettings({ ...project, width: 3840, height: 2160 }, {}), { width: 1920, height: 1080, fps: 24, start: 0, end: 12 });
  // An extreme portrait cannot fit the encoder's minimum width and maximum
  // height simultaneously. Require explicit dimensions rather than distort it.
  assert.throws(() => agentExportSettings({ ...project, width: 320, height: 3840 }, {}));
});

test('agent export rejects malformed settings before starting an encoder', () => {
  const project = createDefaultProject();
  for (const args of [{ width: 1281 }, { height: 0 }, { width: Infinity }, { fps: 29 }, { start: 5, end: 4 }, { start: -1 }, { end: 31 }, { fps: '30' }, { end: null }]) {
    assert.throws(() => agentExportSettings(project, args));
  }
});

test('agent resource wait releases a command on cancellation even when browser decoding stalls', async () => {
  const controller = new AbortController();
  const pending = waitForAgent(new Promise<number>(() => {}), controller.signal);
  controller.abort(new Error('cancelled resource wait'));
  await assert.rejects(pending, /cancelled resource wait/);
  assert.equal(await waitForAgent(Promise.resolve(42), new AbortController().signal), 42);
});
