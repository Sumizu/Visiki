import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundVideoSourceTime, isVideoBackground } from '../src/background-video';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { collectExportImageAssets, loadExportImages } from '../src/services';
import { VideoFramePool } from '../src/video-frames';
import type { Layer, MediaAsset } from '../src/types';

const asset: MediaAsset = { id: 'background-movie', name: 'background.mp4', type: 'video', url: '/api/assets/background-movie', duration: 2, fps: 24 };
const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} must be close to ${expected}`);
function background(): Layer {
  return { ...makeLayer('background', 10), start: 3, end: 10,
    params: { backgroundType: 'video', videoId: asset.id } };
}

test('video backgrounds use a layer-relative source clock and ignore unrelated trim controls', () => {
  const layer = background();
  layer.params = { ...layer.params, sourceIn: 1, sourceOut: 1.5 };
  close(backgroundVideoSourceTime(layer, 3, asset), 0);
  close(backgroundVideoSourceTime(layer, 3.5, asset), .5);
  close(backgroundVideoSourceTime(layer, 3 + 1 / 24 + .001, asset), 1 / 24);
  close(backgroundVideoSourceTime(layer, -10, asset), 0);
  const arbitrary = backgroundVideoSourceTime(layer, 7.231, asset);
  backgroundVideoSourceTime(layer, 8.99, asset); backgroundVideoSourceTime(layer, 3.2, asset);
  close(backgroundVideoSourceTime(layer, 7.231, asset), arbitrary);
  close(backgroundVideoSourceTime({ ...layer, start: 5, end: 12 }, 5.5, asset), .5);
  assert.equal(isVideoBackground(makeLayer('background')), false, 'legacy backgrounds remain images');
  assert.equal(isVideoBackground({ ...layer, type: 'video' }), false, 'ordinary clips keep their original timing path');
});

test('background playback speed changes the source clock without changing the layer span', () => {
  for (const rate of [.1, .5, 1, 2, 8]) {
    const layer = background(); layer.params.playbackRate = rate;
    const snapshot = JSON.stringify(layer);
    close(backgroundVideoSourceTime(layer, layer.start + .5 / rate, asset), .5);
    close(backgroundVideoSourceTime(layer, layer.start + 2 / rate, asset), 0);
    close(backgroundVideoSourceTime({ ...layer, start: 8 }, 8 + .5 / rate, asset), .5);
    layer.params.videoLoop = false;
    close(backgroundVideoSourceTime(layer, layer.start + 10 / rate, asset), 2 - 1 / 24);
    delete layer.params.videoLoop;
    assert.equal(JSON.stringify(layer), snapshot, 'mapping never mutates timeline bounds or parameters');
  }
});

test('reverse backgrounds start on the last frame, loop at scaled boundaries and hold zero when exhausted', () => {
  for (const rate of [.1, .5, 1, 2, 8]) {
    const layer = background(); layer.params = { ...layer.params, playbackRate: rate, reverse: true };
    close(backgroundVideoSourceTime(layer, -99, asset), 2 - 1 / 24);
    close(backgroundVideoSourceTime(layer, layer.start, asset), 2 - 1 / 24);
    close(backgroundVideoSourceTime(layer, layer.start + .5 / rate, asset), 1.5 - 1 / 24);
    for (const cycle of [1, 3, 7, 1000]) close(backgroundVideoSourceTime(layer, layer.start + cycle * 2 / rate, asset), 2 - 1 / 24);
    close(backgroundVideoSourceTime(layer, layer.start + (2 - 1 / 24) / rate, asset), 0);
    layer.params.videoLoop = false;
    close(backgroundVideoSourceTime(layer, layer.start + 2 / rate, asset), 0);
    close(backgroundVideoSourceTime(layer, layer.start + 10 / rate, asset), 0);
  }
});

test('reverse fractional EOF preserves the partial last frame with source-fps quantization', () => {
  const fractional = { ...asset, duration: 1.013, fps: 30 };
  const layer = background(); layer.params = { ...layer.params, playbackRate: 2, reverse: true };
  close(backgroundVideoSourceTime(layer, layer.start, fractional), 1);
  close(backgroundVideoSourceTime(layer, layer.start + .005, fractional), 1);
  close(backgroundVideoSourceTime(layer, layer.start + .01, fractional), 29 / 30);
  for (const cycle of [1, 3, 7, 100, 1000]) {
    close(backgroundVideoSourceTime(layer, layer.start + cycle * fractional.duration / 2, fractional), 1);
    close(backgroundVideoSourceTime(layer, layer.start + (cycle * fractional.duration + .02) / 2, fractional), 29 / 30);
  }
  layer.params.videoLoop = false;
  close(backgroundVideoSourceTime(layer, 99, fractional), 0);
  close(backgroundVideoSourceTime(layer, layer.start, { ...fractional, duration: .01 }), 0);
  for (const fps of [23.976, 24, 29.97, 60, 120]) {
    const source = { ...asset, fps };
    const last = (Math.ceil(source.duration! * fps - 1e-8) - 1) / fps;
    close(backgroundVideoSourceTime(layer, layer.start, source), last);
    const at = layer.start + .25;
    const expected = Math.ceil((source.duration! - 1 / fps - .5 - 1e-8) * fps) / fps;
    close(backgroundVideoSourceTime(layer, at, source), expected);
  }
});

test('background speed and direction are deterministic under arbitrary seeks with safe malformed-parameter defaults', () => {
  for (const reverse of [false, true]) for (const videoLoop of [false, true]) {
    const layer = background(); layer.params = { ...layer.params, playbackRate: 1.7, reverse, videoLoop };
    const times = [3, 3.001, 3.4, 4.201, 7.231, 99, 3.5];
    const expected = times.map(time => backgroundVideoSourceTime(layer, time, asset));
    for (const time of [...times].reverse()) {
      const actual = backgroundVideoSourceTime(layer, time, asset);
      close(actual, expected[times.indexOf(time)]);
      assert.ok(actual >= 0 && actual < asset.duration!);
      close(actual * asset.fps!, Math.round(actual * asset.fps!));
    }
  }
  for (const playbackRate of [undefined, '2', true, NaN, Infinity, -Infinity]) {
    const layer = background(); layer.params.playbackRate = playbackRate as number; layer.params.reverse = 'true' as unknown as boolean;
    close(backgroundVideoSourceTime(layer, layer.start + .5, asset), .5);
  }
  const bounded = background(); bounded.params.playbackRate = 100;
  close(backgroundVideoSourceTime(bounded, bounded.start + .0625, asset), .5);
  bounded.params.playbackRate = -10;
  close(backgroundVideoSourceTime(bounded, bounded.start + 5, asset), .5);
  close(backgroundVideoSourceTime(bounded, NaN, asset), 0);
});

test('background loops wrap exact repeated and fractional boundaries to the first source frame', () => {
  const layer = background();
  close(backgroundVideoSourceTime(layer, 5, asset), 0);
  close(backgroundVideoSourceTime(layer, 7.5, asset), .5);
  close(backgroundVideoSourceTime(layer, 5 - 1 / 24, asset), 2 - 1 / 24);
  const fractional = { ...asset, duration: 1.013, fps: 30 };
  for (const cycle of [1, 3, 7, 100, 1000]) close(backgroundVideoSourceTime(layer, layer.start + cycle * fractional.duration, fractional), 0);
  close(backgroundVideoSourceTime(layer, layer.start + 7 * fractional.duration + .27, fractional), 8 / 30);
  const explicit = { ...layer, params: { ...layer.params, videoLoop: true } };
  close(backgroundVideoSourceTime(explicit, 5.5, asset), .5);
});

test('non-looping backgrounds hold the last valid source frame without seeking EOF', () => {
  const layer = background(); layer.params.videoLoop = false;
  for (const time of [5, 7, 10000]) close(backgroundVideoSourceTime(layer, time, asset), 2 - 1 / 24);
  close(backgroundVideoSourceTime(layer, 3.5, asset), .5);
  const fractional = { ...asset, duration: 1.013, fps: 30 };
  close(backgroundVideoSourceTime(layer, 99, fractional), 1);
  close(backgroundVideoSourceTime(layer, 99, { ...asset, duration: .01 }), 0);
  assert.throws(() => backgroundVideoSourceTime(layer, 3, { ...asset, duration: 0 }), /有效的视频素材/);
  assert.throws(() => backgroundVideoSourceTime(layer, 3, { ...asset, type: 'image' }), /有效的视频素材/);
});

test('the video frame pool skips unselected, hidden, transparent and inactive backgrounds but reports selected missing assets', async () => {
  const pool = new VideoFramePool();
  const p = createDefaultProject(); p.videos = [];
  p.layers = [
    { ...background(), id: 'empty', params: { backgroundType: 'video', videoId: '' } },
    { ...background(), id: 'hidden', visible: false },
    { ...background(), id: 'transparent', opacity: 0 },
    { ...background(), id: 'later', start: 8, end: 10 },
    { ...background(), id: 'past', start: 0, end: 4 },
    { ...background(), id: 'still-image', params: { backgroundType: 'image', videoId: asset.id } },
  ];
  assert.equal((await pool.prepare(p, 4)).size, 0, 'no browser decoders are needed for inactive backgrounds');
  p.layers.push(background());
  await assert.rejects(pool.prepare(p, 4), /引用的视频已丢失/);
  p.layers = [{ ...makeLayer('video', 10), params: { videoId: 'missing-clip' } }];
  await assert.rejects(pool.prepare(p, 4), /引用的视频已丢失/, 'ordinary clip references are still checked');
  pool.dispose();
});

test('export image loading ignores inactive image bindings in video backgrounds while retaining other contributing images', async () => {
  const p = createDefaultProject();
  const image: MediaAsset = { id: 'card-image', name: 'card.png', type: 'image', url: '/api/assets/card-image' };
  const videoBackground = background(); videoBackground.params.imageId = 'missing-old-background-image';
  const card = makeLayer('image', 10); card.params.imageId = image.id; card.params.followCover = false;
  p.images = [image]; p.layers = [videoBackground, card];
  assert.deepEqual(collectExportImageAssets(p, { start: 3, end: 6 }), [image]);
  const loaded: string[] = []; const bitmap = { width: 16, height: 16 } as CanvasImageSource;
  const resources = await loadExportImages(p, { start: 3, end: 6 }, async item => { loaded.push(item.id); return bitmap; });
  assert.deepEqual(loaded, [image.id]); assert.equal(resources.images?.get(image.id), bitmap);
  videoBackground.params.backgroundType = 'image';
  assert.throws(() => collectExportImageAssets(p, { start: 3, end: 6 }), /引用的图片已丢失/, 'switching back to an unavailable image still reports the problem');
});
