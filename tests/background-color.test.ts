import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { clearSceneCache, renderScene } from '../src/scene';
import { collectExportImageAssets, loadExportImages } from '../src/services';
import type { MediaAsset } from '../src/types';

const cover: MediaAsset = { id: 'color-test-cover', name: 'cover.png', type: 'image', url: '/api/assets/color-test-cover' };
function fixture() {
  const project = createDefaultProject(), background = makeLayer('background');
  Object.assign(background.params, { backgroundType: 'color', color: '#f5f1e9', followCover: true, imageId: cover.id, blur: 100, brightness: 0 });
  project.cover = cover; project.images = [cover]; project.layers = [background];
  return { project, background };
}

test('a solid template background paints its exact color without borrowing the cover, darkening or adding a vignette', () => {
  clearSceneCache();
  const { project } = fixture();
  const calls: { name: string; color: unknown }[] = [];
  const state: Record<string, unknown> = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1 };
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => stack.push({ ...state });
    if (key === 'restore') return () => Object.assign(state, stack.pop());
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => { throw new Error('A solid background has no gradient'); };
    return () => calls.push({ name: key, color: state.fillStyle });
  } }) as unknown as CanvasRenderingContext2D;
  renderScene(ctx, project, 1, { cover: { width: 100, height: 100 } as CanvasImageSource, analysis: null });
  assert.equal(calls.filter(call => call.name === 'drawImage').length, 0);
  assert.equal(calls.filter(call => call.name === 'fillRect').at(-1)?.color, '#f5f1e9');
  assert.equal(calls.filter(call => call.name === 'fillRect').length, 2, 'only the scene base and the selected color are painted');
  assert.equal(stack.length, 0);
});

test('pure color backgrounds save and export without requiring unused images; switching back restores image dependencies', async () => {
  const { project, background } = fixture();
  const reopened = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reopened.layers[0].params, background.params);
  assert.deepEqual(collectExportImageAssets(reopened, { start: 0, end: 2 }), []);
  const loaded = await loadExportImages(reopened, { start: 0, end: 2 }, async () => { throw new Error('Unused images must not be decoded'); });
  assert.equal(loaded.images?.size, 0); assert.equal(loaded.cover, null);
  reopened.layers[0].params.backgroundType = 'image';
  assert.deepEqual(collectExportImageAssets(reopened, { start: 0, end: 2 }), [cover]);
  reopened.layers[0].params.backgroundType = 'unknown';
  assert.throws(() => validateProject(reopened), /背景素材类型/);
});
