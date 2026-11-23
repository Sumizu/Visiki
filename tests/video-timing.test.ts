import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import { moveVideoLayer, resizeProjectDuration, setVideoRate, setVideoSourceRange, splitVideoLayer, stretchVideoLayer, trimVideoLayer, videoSourceTime } from '../src/video-timing';
import type { DemoProject, Layer, MediaAsset } from '../src/types';

const asset: MediaAsset = { id: 'video-1', name: 'test.mp4', type: 'video', url: '/api/assets/video-1', duration: 10, width: 640, height: 360, fps: 30 };
const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} must be close to ${expected}`);
function clip(reverse = false): Layer {
  const layer = makeLayer('video', 4);
  return { ...layer, id: 'clip-1', start: 2, end: 6, params: { ...layer.params, videoId: asset.id, sourceIn: 1, sourceOut: 7, playbackRate: 1.5, reverse } };
}
function project(layer = clip()): DemoProject {
  return { ...createDefaultProject(), duration: 12, videos: [asset], layers: [layer] };
}
function invariant(layer: Layer): void {
  assert.ok(layer.start >= 0 && layer.end <= 3600 && layer.end > layer.start);
  assert.ok(Number(layer.params.sourceIn) >= 0 && Number(layer.params.sourceOut) <= asset.duration!, JSON.stringify(layer));
  assert.ok(Number(layer.params.sourceOut) > Number(layer.params.sourceIn));
  assert.ok(Number(layer.params.playbackRate) >= .1 && Number(layer.params.playbackRate) <= 8);
  close(layer.end - layer.start, (Number(layer.params.sourceOut) - Number(layer.params.sourceIn)) / Number(layer.params.playbackRate));
}

test('video frame mapping uses timeline placement, speed and source fps without seeking EOF', () => {
  const layer = clip();
  close(videoSourceTime(layer, 2, asset), 1);
  close(videoSourceTime(layer, 3, asset), 2.5);
  close(videoSourceTime(layer, 6, asset), 7 - 1 / 30);
  close(videoSourceTime(layer, -100, asset), 1);
  const moved = moveVideoLayer(layer, 8);
  close(videoSourceTime(moved, 9, asset), 2.5);
  assert.equal(layer.start, 2, 'editing returns a separate layer');
  close(videoSourceTime({ ...layer, end: 8, params: { ...layer.params, sourceOut: 10 } }, 99, asset), 10 - 1 / 30);
});

test('reverse mapping begins at the last source frame and responds deterministically to arbitrary seeks', () => {
  const layer = clip(true);
  close(videoSourceTime(layer, 2, asset), 7 - 1 / 30);
  close(videoSourceTime(layer, 3, asset), 5.5 - 1 / 30);
  close(videoSourceTime(layer, 6, asset), 1);
  const expected = videoSourceTime(layer, 4.28, asset);
  videoSourceTime(layer, 5.8, asset); videoSourceTime(layer, 2.01, asset);
  close(videoSourceTime(layer, 4.28, asset), expected);
  assert.ok(videoSourceTime(layer, 2.01, asset) < 7);
});

test('forward and reverse trims edit opposite source edges while preserving playback rate', () => {
  const forward = clip(); const reverse = clip(true);
  const forwardStart = trimVideoLayer(forward, 'start', 3, asset);
  const reverseStart = trimVideoLayer(reverse, 'start', 3, asset);
  close(Number(forwardStart.params.sourceIn), 2.5); close(Number(forwardStart.params.sourceOut), 7);
  close(Number(reverseStart.params.sourceIn), 1); close(Number(reverseStart.params.sourceOut), 5.5);
  close(videoSourceTime(forwardStart, 3, asset), videoSourceTime(forward, 3, asset));
  close(videoSourceTime(reverseStart, 3, asset), videoSourceTime(reverse, 3, asset));
  const forwardEnd = trimVideoLayer(forward, 'end', 5, asset);
  const reverseEnd = trimVideoLayer(reverse, 'end', 5, asset);
  close(Number(forwardEnd.params.sourceOut), 5.5); close(Number(reverseEnd.params.sourceIn), 2.5);
  for (const next of [forwardStart, reverseStart, forwardEnd, reverseEnd]) { invariant(next); close(Number(next.params.playbackRate), 1.5); }
  const extended = trimVideoLayer(reverse, 'start', -20, asset);
  close(Number(extended.params.sourceOut), 10); close(extended.start, 0);
  close(Number(trimVideoLayer(reverse, 'end', 100, asset).params.sourceIn), 0);
});

test('stretching and changing speed preserve source range and respect bounds', () => {
  const layer = clip();
  const stretch = stretchVideoLayer(layer, 'end', 10, asset);
  close(Number(stretch.params.playbackRate), .75); close(stretch.end, 10);
  const faster = setVideoRate(layer, 2, asset);
  close(faster.start, 2); close(faster.end, 5);
  const fastest = setVideoRate(layer, 100, asset);
  close(Number(fastest.params.playbackRate), 8);
  const slowest = setVideoRate(layer, 0, asset);
  close(Number(slowest.params.playbackRate), .1);
  for (const next of [stretch, faster, fastest, slowest, stretchVideoLayer(layer, 'start', -1, asset)]) {
    invariant(next); close(Number(next.params.sourceIn), 1); close(Number(next.params.sourceOut), 7);
  }
  const nearEnd = moveVideoLayer(layer, 3596);
  const bounded = setVideoRate(nearEnd, .1, asset);
  close(bounded.end, 3600); invariant(bounded);
  const changedRange = setVideoSourceRange(layer, 2, 8, asset);
  close(changedRange.end, 6); close(Number(changedRange.params.sourceIn), 2);
  invariant(setVideoSourceRange(layer, 99, -100, asset));
});

test('splitting forward and reverse clips preserves the original sequence without duplicate boundary frames', () => {
  for (const reverse of [false, true]) for (const at of [4, 3.37]) {
    const layer = clip(reverse); const halves = splitVideoLayer(layer, at, asset);
    assert.ok(halves); const [left, right] = halves;
    assert.equal(left.id, layer.id); assert.notEqual(right.id, layer.id);
    close(left.end, right.start); close(right.end, layer.end);
    for (let frame = 0; frame < 120; frame++) {
      const time = layer.start + frame / 30;
      close(videoSourceTime(time < at ? left : right, time, asset), videoSourceTime(layer, time, asset));
    }
    assert.notEqual(videoSourceTime(left, at - 1 / 30, asset), videoSourceTime(right, at, asset));
    invariant(left); invariant(right);
    assert.equal(splitVideoLayer(layer, layer.start, asset), null);
    assert.equal(splitVideoLayer(layer, layer.end - 1 / 60, asset), null);
  }
});

test('shortening project duration trims video source mapping, bounds other layers and removes later clips', () => {
  const original = project(clip(true));
  const title = { ...makeLayer('title', 12), id: 'title' };
  const later = moveVideoLayer(clip(), 8); later.id = 'later';
  original.layers.push(title, later);
  const shortened = resizeProjectDuration(original, 4);
  assert.equal(shortened.duration, 4); assert.deepEqual(shortened.layers.map(layer => layer.id), ['clip-1', 'title']);
  close(shortened.layers[0].end, 4); close(Number(shortened.layers[0].params.sourceIn), 4);
  close(shortened.layers[1].end, 4);
  assert.equal(validateProject(shortened).layers.length, 2);
  close(original.layers[0].end, 6);
});

test('video projects normalize local URLs and persist independent clip source ranges across save and reopen', () => {
  const p = project(); p.videos = [{ ...asset, url: 'https://untrusted.invalid/video.mp4', posterUrl: 'file:///outside' }];
  const halves = splitVideoLayer(clip(true), 4, asset)!; p.layers = halves;
  const saved = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(saved.videos?.[0].url, '/api/assets/video-1');
  assert.equal(saved.videos?.[0].posterUrl, '/api/video/video-1/poster');
  assert.deepEqual(saved.layers, halves);
  const old = createDefaultProject(); delete old.videos;
  assert.deepEqual(validateProject(old).videos, []);
  assert.throws(() => validateProject({ ...p, videos: [asset, asset] }), /ID 重复/);
  assert.throws(() => validateProject({ ...p, videos: [{ ...asset, fps: 0 }] }), /帧率无效/);
  assert.throws(() => validateProject({ ...p, videos: [] }), /不在视频库/);
  assert.throws(() => validateProject({ ...p, layers: [{ ...clip(), end: 9 }] }), /不一致/);
  assert.throws(() => validateProject({ ...p, layers: [{ ...clip(), params: { ...clip().params, reverse: 'true' } }] }), /倒放参数无效/);
});

test('legacy background and card freeze cover bindings, while explicit follow-cover layers remain linked', () => {
  const p = createDefaultProject(); delete p.images;
  p.layers.forEach(layer => { if (layer.type === 'background' || layer.type === 'image') { delete layer.params.imageId; delete layer.params.followCover; } });
  p.cover = { id: 'cover-one', type: 'image', name: 'one.png', url: '/api/assets/cover-one' };
  const explicit = makeLayer('image'); explicit.params.imageId = 'other';
  const follow = makeLayer('background'); follow.params.followCover = true;
  p.images = [{ id: 'other', type: 'image', name: 'two.png', url: '/api/assets/other' }];
  p.layers.push(explicit, follow);
  const opened = validateProject(p);
  assert.equal(opened.layers.find(layer => layer.type === 'background')?.params.imageId, 'cover-one');
  assert.equal(opened.layers.find(layer => layer.type === 'image')?.params.imageId, 'cover-one');
  assert.equal(opened.layers.find(layer => layer.id === explicit.id)?.params.imageId, 'other');
  assert.equal(opened.layers.find(layer => layer.id === follow.id)?.params.imageId, '');
  assert.equal(validateProject(opened).layers.find(layer => layer.id === explicit.id)?.params.imageId, 'other');
  const unselected = makeLayer('image');
  opened.layers.push(unselected);
  assert.equal(validateProject(opened).layers.find(layer => layer.id === unselected.id)?.params.imageId, '', 'an explicit empty image selection survives save and reopen');
});

test('video renderer uses the clip-specific frame, honors its range and stays transparent while loading', () => {
  const p = project(); const layer = p.layers[0];
  const frame = { width: 640, height: 360 } as CanvasImageSource;
  const cover = { width: 10, height: 10 } as CanvasImageSource;
  const draws: unknown[] = []; const noop = (): void => {};
  const context = new Proxy({ canvas: { width: 1920, height: 1080 }, globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === 'drawImage') return (image: unknown) => draws.push(image);
      return noop;
    }, set(target, key, value) { return Reflect.set(target, key, value); }
  }) as unknown as CanvasRenderingContext2D;
  const resources = { cover, analysis: null, videos: new Map([[layer.id, frame]]) };
  renderScene(context, p, 3, resources); assert.deepEqual(draws, [frame]);
  draws.length = 0; renderScene(context, p, 6, resources); assert.deepEqual(draws, []);
  renderScene(context, p, 3, { ...resources, videos: new Map([['another-clip', frame]]) }); assert.deepEqual(draws, []);
  layer.visible = false; renderScene(context, p, 3, resources); assert.deepEqual(draws, []);
});

test('editing fractional clips at speed, frame and one-hour boundaries always yields reopenable projects', () => {
  for (const fps of [1, 24, 30, 60]) for (const rate of [.1, .37, 1, 1.5, 8]) for (const start of [0, 2.013, 3599.5]) for (const reverse of [false, true]) {
    const span = Math.min(5.137, (3600 - start) * rate);
    if (span / rate < 1 / fps) continue;
    const layer = { ...clip(reverse), start, end: start + span / rate,
      params: { ...clip(reverse).params, sourceIn: .013, sourceOut: .013 + span, playbackRate: rate } };
    const edits = [moveVideoLayer(layer, -50), moveVideoLayer(layer, 4000), setVideoRate(layer, .1, asset, fps), setVideoRate(layer, 8, asset, fps),
      stretchVideoLayer(layer, 'start', -100, asset, fps), stretchVideoLayer(layer, 'start', layer.end, asset, fps),
      stretchVideoLayer(layer, 'end', start, asset, fps), stretchVideoLayer(layer, 'end', 4000, asset, fps),
      trimVideoLayer(layer, 'start', -100, asset, fps), trimVideoLayer(layer, 'start', layer.end, asset, fps),
      trimVideoLayer(layer, 'end', start, asset, fps), trimVideoLayer(layer, 'end', 4000, asset, fps),
      setVideoSourceRange(layer, .021, 9.999, asset, fps), setVideoSourceRange(layer, 99, -99, asset, fps)];
    for (const edited of edits) {
      invariant(edited);
      const next = { ...project(edited), fps, duration: Math.max(1 / fps, edited.end) };
      assert.doesNotThrow(() => validateProject(next), `fps ${fps}, rate ${rate}, start ${start}, reverse ${reverse}: ${JSON.stringify(edited)}`);
    }
  }
  const longAsset = { ...asset, duration: 86400 };
  const bounded = setVideoSourceRange(clip(), 0, 86400, longAsset);
  assert.ok(bounded.end <= 3600); assert.ok(Number(bounded.params.playbackRate) <= 8);
  assert.doesNotThrow(() => validateProject({ ...project(bounded), duration: 3600, videos: [longAsset] }));
});
