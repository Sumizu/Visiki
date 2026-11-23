import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayer } from '../src/default-project';
import { moveLayer } from '../src/layer-timing';
import { videoSourceTime } from '../src/video-timing';
import type { LayerType, MediaAsset } from '../src/types';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('all visual components move at frame boundaries while keeping length and component state', () => {
  const types: LayerType[] = ['background', 'image', 'video', 'disc', 'lyrics', 'spectrum', 'player', 'title'];
  for (const type of types) {
    const original = { ...makeLayer(type, 30), locked: false, start: 2, end: 8.25 };
    const moved = moveLayer(original, 10.049, 30);
    near(moved.start, 10 + 1 / 30); near(moved.end - moved.start, 6.25);
    assert.equal(moved.params, original.params, `${type} params must retain their own timing and styles`);
    assert.equal(moved.x, original.x); assert.equal(moved.width, original.width);
    assert.equal(original.start, 2); assert.equal(original.end, 8.25);
  }
});

test('movement clamps both ends without shortening a layer and does not move locked layers', () => {
  const original = { ...makeLayer('title', 30), start: 2, end: 8.25 };
  const beforeStart = moveLayer(original, -99); near(beforeStart.start, 0); near(beforeStart.end, 6.25);
  const beyondEnd = moveLayer(original, 3600); near(beyondEnd.start, Math.floor(3593.75 * 30) / 30);
  near(beyondEnd.end - beyondEnd.start, 6.25); assert.ok(beyondEnd.end <= 3600); assert.ok(3600 - beyondEnd.end < 1 / 30);
  const shorterProject = moveLayer(original, 100, 30, 20); assert.ok(shorterProject.end <= 20); near(shorterProject.start * 30, Math.round(shorterProject.start * 30));
  const locked = { ...original, locked: true }; assert.equal(moveLayer(locked, 12), locked);
  assert.equal(moveLayer(original, Number.NaN), original);
});

test('video movement leaves source mapping relative to the clip intact', () => {
  const asset: MediaAsset = { id: 'video', type: 'video', name: 'clip.mp4', url: '/api/assets/video', duration: 10, width: 320, height: 180, fps: 30 };
  for (const reverse of [false, true]) {
    const original = { ...makeLayer('video', 30), start: 2, end: 6, params: { videoId: asset.id, sourceIn: 1, sourceOut: 7, playbackRate: 1.5, reverse } };
    const moved = moveLayer(original, 20);
    for (const elapsed of [0, .25, 1.5, 3.9]) near(videoSourceTime(moved, moved.start + elapsed, asset), videoSourceTime(original, original.start + elapsed, asset));
  }
});
