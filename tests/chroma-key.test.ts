import test from 'node:test';
import assert from 'node:assert/strict';
import { chromaKeySettingsKey, keyChromaPixels, resolveChromaKeySettings } from '../src/chroma-key';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import type { LayerParams, MediaAsset } from '../src/types';

const enabled = { chromaEnabled: true, chromaSpill: 0 };
function pixel(rgb: number[], params: LayerParams): number[] {
  return Array.from(keyChromaPixels(new Uint8ClampedArray([...rgb, rgb.length === 3 ? 255 : undefined].filter(value => value !== undefined) as number[]), params));
}

test('green, blue and custom keys remove their screen while retaining neutral and opposite-color foreground', () => {
  for (const [color, screen, opposite] of [
    ['#00ff00', [0, 255, 0], [255, 0, 0]],
    ['#0000ff', [0, 0, 255], [255, 0, 0]],
    ['#ff00ff', [255, 0, 255], [0, 255, 0]],
  ] as [string, number[], number[]][]) {
    const params = { ...enabled, chromaColor: color };
    assert.equal(pixel(screen, params)[3], 0);
    for (const foreground of [[0, 0, 0], [255, 255, 255], [120, 120, 120], opposite]) assert.deepEqual(pixel(foreground, params), [...foreground, 255]);
    assert.equal(pixel([0, 0, 0], { ...params, chromaTolerance: 1, chromaSoftness: 1 })[3], 255);
    assert.equal(pixel([255, 255, 255], { ...params, chromaTolerance: 1, chromaSoftness: 1 })[3], 255);
  }
});

test('neutral key colors include luminance so black and white screens can be keyed independently', () => {
  const black = { ...enabled, chromaColor: '#000000', chromaTolerance: .05, chromaSoftness: .1 };
  const white = { ...black, chromaColor: '#ffffff' };
  assert.equal(pixel([0, 0, 0], black)[3], 0);
  assert.equal(pixel([255, 255, 255], black)[3], 255);
  assert.equal(pixel([255, 255, 255], white)[3], 0);
  assert.equal(pixel([0, 0, 0], white)[3], 255);
  const gray = { ...black, chromaColor: '#808080' };
  assert.equal(pixel([128, 128, 128], gray)[3], 0);
  assert.equal(pixel([0, 0, 0], gray)[3], 255);
  assert.equal(pixel([255, 255, 255], gray)[3], 255);
});

test('gray and near-gray keys retain saturated foreground at the same luminance', () => {
  for (const [color, screen] of [['#808080', [128, 128, 128]], ['#807c80', [128, 124, 128]]] as [string, number[]][]) {
    const params = { ...enabled, chromaColor: color };
    assert.equal(pixel(screen, params)[3], 0);
    assert.equal(pixel([140, 140, 140], params)[3], 0, 'nearby gray screen variations are removed');
    for (const foreground of [[255, 88, 0], [0, 190, 143], [255, 0, 0]]) {
      assert.deepEqual(pixel(foreground, params), [...foreground, 255], 'a neutral key must compare color as well as brightness');
    }
  }
});

test('softness yields a monotone continuous matte and multiplies existing transparency', () => {
  const params = { ...enabled, chromaColor: '#00ff00', chromaTolerance: .1, chromaSoftness: .2 };
  const alpha = [255, 230, 210, 190, 170, 140].map(g => pixel([0, g, 0], params)[3]);
  assert.ok(alpha[0] === 0 && alpha.at(-1) === 255);
  assert.ok(alpha.some(value => value > 0 && value < 255));
  for (let i = 1; i < alpha.length; i++) assert.ok(alpha[i] >= alpha[i - 1]);
  const opaque = pixel([0, 210, 0, 255], params)[3];
  const transparent = pixel([0, 210, 0, 128], params)[3];
  assert.ok(Math.abs(transparent - opaque * 128 / 255) <= 1);
  assert.equal(pixel([255, 0, 0, 0], params)[3], 0);
});

test('spill suppression reduces the key-color contamination without changing neutral and opposite hues', () => {
  const params = { ...enabled, chromaColor: '#00ff00', chromaTolerance: .05, chromaSoftness: .1, chromaSpill: 1 };
  const untreated = pixel([80, 180, 80], { ...params, chromaSpill: 0 });
  const treated = pixel([80, 180, 80], params);
  assert.ok(treated[1] - treated[0] < untreated[1] - untreated[0]);
  assert.equal(treated[3], untreated[3], 'spill only changes the color, never the matte');
  for (const rgb of [[255, 0, 0], [120, 120, 120], [255, 255, 255], [0, 0, 0]]) assert.deepEqual(pixel(rgb, params), [...rgb, 255]);
});

test('disabled keying preserves exact bytes and changing settings generates an independent cache key', () => {
  const data = new Uint8ClampedArray([0, 255, 0, 71, 200, 170, 120, 255]);
  const original = [...data];
  assert.equal(keyChromaPixels(data, {}), data); assert.deepEqual([...data], original);
  assert.equal(chromaKeySettingsKey({}), 'off');
  assert.notEqual(chromaKeySettingsKey(enabled), chromaKeySettingsKey({ ...enabled, chromaTolerance: .3 }));
  assert.deepEqual(resolveChromaKeySettings({ chromaEnabled: true, chromaColor: 'invalid', chromaTolerance: Infinity, chromaSoftness: -1, chromaSpill: 4 }),
    { enabled: true, color: '#00ff00', tolerance: .18, softness: 0, spill: 1 });
});

test('project validation accepts old video projects, retains stretch/key settings and rejects malformed effects', () => {
  const video: MediaAsset = { id: 'screen', name: 'screen.mp4', type: 'video', url: '/api/assets/screen', duration: 2, width: 320, height: 180, fps: 30 };
  const layer = makeLayer('video', 2); layer.params.videoId = video.id;
  const project = { ...createDefaultProject(), videos: [video], layers: [layer] };
  assert.equal(validateProject(project).layers[0].params.chromaEnabled, undefined, 'old projects retain their unkeyed appearance');
  layer.params = { ...layer.params, ...enabled, fit: 'stretch', chromaColor: '#ff00ff', chromaSoftness: .2 };
  assert.deepEqual(validateProject(project).layers[0].params, layer.params);
  for (const malformed of [{ chromaEnabled: 'true' }, { chromaColor: 'green' }, { chromaTolerance: -.1 }, { chromaSoftness: 1.01 }, { chromaSpill: NaN }]) {
    assert.throws(() => validateProject({ ...project, layers: [{ ...layer, params: { ...layer.params, ...malformed } }] }));
  }
});

test('stretch renders the entire video frame at independent width and height without a source crop', () => {
  const video: MediaAsset = { id: 'wide-video', name: 'wide.mp4', type: 'video', url: '', duration: 2, width: 640, height: 360, fps: 30 };
  const layer = { ...makeLayer('video', 2), width: 200, height: 300, params: { videoId: video.id, sourceIn: 0, sourceOut: 2, playbackRate: 1, reverse: false, fit: 'stretch' } };
  const project = { ...createDefaultProject(), videos: [video], layers: [layer] };
  const frame = { width: 640, height: 360 } as CanvasImageSource;
  const draws: unknown[][] = []; const noop = (): void => {};
  const context = new Proxy({ canvas: { width: 1920, height: 1080 } }, {
    get(target, key) { return key in target ? Reflect.get(target, key) : key === 'drawImage' ? (...args: unknown[]) => draws.push(args) : noop; },
    set(target, key, value) { return Reflect.set(target, key, value); },
  }) as unknown as CanvasRenderingContext2D;
  renderScene(context, project, .5, { cover: null, analysis: null, videos: new Map([[layer.id, frame]]) });
  assert.deepEqual(draws, [[frame, -100, -150, 200, 300]]);
});
