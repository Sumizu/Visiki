import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { clearSceneCache, renderScene } from '../src/scene';
import { collectExportImageAssets, loadExportImages } from '../src/services';
import type { DemoProject, Layer, MediaAsset } from '../src/types';

const asset = (id: string): MediaAsset => ({ id, type: 'image', name: `${id}.png`, url: `/api/assets/${id}` });
const source = (id: string): CanvasImageSource => ({ id, width: 640, height: 480 } as unknown as CanvasImageSource);
function projectWithImages(): DemoProject {
  const project = createDefaultProject();
  project.cover = asset('default'); project.images = [project.cover, asset('red'), asset('blue'), asset('missing')];
  project.layers = [];
  return project;
}
function imageLayer(imageId: string, type: Layer['type'] = 'image'): Layer {
  const layer = makeLayer(type);
  layer.params = { ...layer.params, imageId, shadow: false, tonearm: false };
  return layer;
}

type DrawOperation = { name: string; args: unknown[] };
function fakeContext(operations: DrawOperation[]): CanvasRenderingContext2D {
  const noop = (): void => {};
  const gradient = { addColorStop: noop };
  return new Proxy({ canvas: { width: 1920, height: 1080 }, globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
      return (...args: unknown[]) => { operations.push({ name: String(key), args }); };
    },
    set(target, key, value) { return Reflect.set(target, key, value); }
  }) as unknown as CanvasRenderingContext2D;
}

test('old saved projects migrate their cover into the image library and normalize asset URLs', () => {
  const old = createDefaultProject();
  delete old.images; delete old.audioMuted;
  old.cover = { ...asset('old-cover'), url: 'https://untrusted.invalid/cover.png' };
  const loaded = validateProject(old);
  assert.deepEqual(loaded.images, [{ ...old.cover, url: '/api/assets/old-cover' }]);
  assert.equal(loaded.cover?.url, '/api/assets/old-cover');
  assert.equal(loaded.audioMuted, false);
  assert.equal(validateProject({ ...loaded, images: loaded.images }).images?.length, 1, 'cover is not duplicated on a second open');
  assert.deepEqual(createDefaultProject().images, []);
});

test('saved image libraries reject duplicate IDs, wrong media types, and missing layer references', () => {
  const project = projectWithImages();
  project.layers = [imageLayer('red')];
  assert.equal(validateProject(project).layers[0].params.imageId, 'red');
  assert.equal(validateProject({ ...project, images: project.images?.map(image => ({ ...image, url: 'file:///elsewhere' })) }).images?.[1].url, '/api/assets/red');
  assert.throws(() => validateProject({ ...project, images: [asset('red'), asset('red')] }), /ID 重复/);
  assert.throws(() => validateProject({ ...project, images: [{ ...asset('red'), type: 'audio' }] }), /素材引用无效/);
  assert.throws(() => validateProject({ ...project, layers: [imageLayer('not-in-library')] }), /图片不在素材库/);
  assert.throws(() => validateProject({ ...project, layers: [{ ...imageLayer('red'), params: { imageId: 3 } }] }), /图片不在素材库/);
  assert.throws(() => validateProject({ ...project, audioMuted: 'yes' }), /静音参数无效/);
});

test('two image layers draw independently, while only an explicit follow-cover layer uses the cover', () => {
  const project = projectWithImages();
  const follow = imageLayer(''); follow.params.followCover = true;
  project.layers = [imageLayer('red'), imageLayer('blue'), follow];
  const red = source('red'); const blue = source('blue'); const cover = source('default');
  const operations: DrawOperation[] = [];
  renderScene(fakeContext(operations), project, 0, { cover, images: new Map([['red', red], ['blue', blue]]), analysis: null });
  assert.deepEqual(operations.filter(op => op.name === 'drawImage').map(op => op.args[0]), [red, blue, cover]);
});

test('background and disc bind independent images and their static caches include the resolved image identity', () => {
  const priorCanvas = globalThis.OffscreenCanvas;
  const operations: DrawOperation[] = [];
  class FakeCanvas {
    constructor(public width: number, public height: number) {}
    getContext(): CanvasRenderingContext2D { return fakeContext(operations); }
  }
  Object.assign(globalThis, { OffscreenCanvas: FakeCanvas });
  try {
    clearSceneCache();
    const project = projectWithImages();
    project.layers = [imageLayer('red', 'background'), imageLayer('blue', 'disc')];
    const red = source('red'); const blue = source('blue');
    const resources = { cover: source('default'), images: new Map([['red', red], ['blue', blue]]), analysis: null };
    renderScene(fakeContext(operations), project, 0, resources);
    assert.deepEqual(operations.filter(op => op.name === 'drawImage' && (op.args[0] === red || op.args[0] === blue)).map(op => op.args[0]), [red, blue]);
    operations.length = 0;
    const replacement = source('replacement-red');
    resources.images.set('red', replacement);
    renderScene(fakeContext(operations), project, 0, resources);
    assert.ok(operations.some(op => op.name === 'drawImage' && op.args[0] === replacement), 'replacing a decoded image invalidates the background cache');
    assert.ok(!operations.some(op => op.name === 'drawImage' && op.args[0] === blue), 'the unchanged disc surface is reused');
    operations.length = 0;
    resources.images.set('blue', source('replacement-blue'));
    renderScene(fakeContext(operations), project, 0, resources);
    assert.ok(operations.some(op => op.name === 'drawImage' && op.args[0] === resources.images.get('blue')), 'replacing the disc label invalidates its cache');
  } finally {
    clearSceneCache();
    if (priorCanvas === undefined) Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    else Object.assign(globalThis, { OffscreenCanvas: priorCanvas });
  }
});

test('a bound image still loading never displays the unrelated default cover', () => {
  const project = projectWithImages(); project.layers = [imageLayer('red')];
  const cover = source('default'); const operations: DrawOperation[] = [];
  renderScene(fakeContext(operations), project, 0, { cover, images: new Map(), analysis: null });
  assert.ok(!operations.some(op => op.name === 'drawImage' && op.args[0] === cover));
});

test('export decodes only visible referenced images in range and fails for a required unreadable image', async () => {
  const project = projectWithImages();
  const hidden = imageLayer('missing'); hidden.visible = false;
  const later = imageLayer('missing'); later.start = 15;
  const transparent = imageLayer('missing'); transparent.opacity = 0;
  project.layers = [imageLayer('red'), hidden, later, transparent];
  const range = { start: 0, end: 10 };
  assert.deepEqual(collectExportImageAssets(project, range).map(image => image.id), ['red']);
  const decoded: string[] = [];
  const load = async (image: MediaAsset): Promise<CanvasImageSource> => {
    decoded.push(image.id);
    if (image.id === 'missing') throw new Error('image unavailable');
    return source(image.id);
  };
  const resources = await loadExportImages(project, range, load);
  assert.deepEqual(decoded, ['red']); assert.equal(resources.images?.size, 1); assert.equal(resources.cover, null);
  hidden.visible = true;
  await assert.rejects(loadExportImages(project, range, load), /image unavailable/);
  hidden.params.imageId = 'not-in-library';
  assert.throws(() => collectExportImageAssets(project, range), /引用的图片已丢失/);
});

test('legacy cover export waits for decoding and a coverless new project uses the procedural fallback', async () => {
  const project = projectWithImages(); delete project.images;
  project.layers = [imageLayer('')];
  delete project.layers[0].params.imageId; delete project.layers[0].params.followCover;
  const expected = source('default');
  const resources = await loadExportImages(project, { start: 0, end: 3 }, async () => expected);
  assert.equal(resources.cover, expected);
  assert.equal(resources.images?.get('default'), expected);
  project.cover = null;
  assert.deepEqual(collectExportImageAssets(project, { start: 0, end: 3 }), []);
});

test('image masks clip before drawing, keep the layer box, and preserve rounded legacy images', () => {
  const project = projectWithImages(); const layer = imageLayer('red'); layer.width = 400; layer.height = 200;
  project.layers = [layer];
  const resources = { cover: null, images: new Map([['red', source('red')]]), analysis: null };
  const expected: [string, string][] = [['rectangle', 'rect'], ['rounded', 'roundRect'], ['circle', 'arc'], ['ellipse', 'ellipse'], ['diamond', 'lineTo'], ['hexagon', 'lineTo']];
  for (const [mask, path] of expected) {
    layer.params.mask = mask; layer.params.radius = 25;
    const operations: DrawOperation[] = []; renderScene(fakeContext(operations), project, 0, resources);
    const clip = operations.findIndex(op => op.name === 'clip'); const draw = operations.findIndex(op => op.name === 'drawImage');
    assert.ok(operations.slice(0, clip).some(op => op.name === path), `${mask} creates its clipping path`);
    assert.ok(clip < draw, `${mask} clips before painting`);
    if (mask === 'circle') assert.deepEqual(operations.find(op => op.name === 'arc')?.args.slice(0, 3), [0, 0, 100], 'circle uses the shorter dimension');
    if (mask === 'ellipse') assert.deepEqual(operations.find(op => op.name === 'ellipse')?.args.slice(0, 4), [0, 0, 200, 100]);
    assert.equal(layer.width, 400); assert.equal(layer.height, 200);
  }
  delete layer.params.mask;
  const legacy: DrawOperation[] = []; renderScene(fakeContext(legacy), project, 0, resources);
  assert.ok(legacy.some(op => op.name === 'roundRect' && op.args[4] === 25));
  layer.params.mask = 'invalid'; assert.throws(() => validateProject(project), /蒙版形状无效/);
  layer.params.mask = 'rounded'; layer.params.radius = -1; assert.throws(() => validateProject(project), /圆角数值无效/);
});
