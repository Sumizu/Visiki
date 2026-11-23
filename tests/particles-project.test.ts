import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { PARTICLE_LIMITS, PARTICLE_PRESETS, particleDefaults } from '../src/particles';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import { moveLayer } from '../src/layer-timing';
import { resizeProjectDuration } from '../src/video-timing';
import type { Layer } from '../src/types';

test('independent particle layers round-trip all presets and parameters without changing old projects', () => {
  const original = createDefaultProject();
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(original))), original);
  original.layers = PARTICLE_PRESETS.map(({ value }, index) => {
    const layer = makeLayer('particles', original.duration);
    layer.params = { ...particleDefaults(value), seed: 1234 + index };
    layer.x = 300 + index * 100; layer.width = 640; layer.height = 360;
    layer.start = index; layer.end = 20; layer.rotation = index * 5; layer.opacity = .65;
    return layer;
  });
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(original))).layers, original.layers);
  const minimal = makeLayer('particles'); minimal.params = { preset: 'snow' };
  original.layers = [minimal];
  assert.deepEqual(validateProject(original).layers[0].params, particleDefaults('snow'));
});

test('particle project validation rejects corrupt values and accepts every published boundary', () => {
  const project = createDefaultProject(); const layer = makeLayer('particles'); project.layers = [layer];
  const invalid = (key: string, value: string | number | boolean) => {
    const candidate = structuredClone(project); candidate.layers[0].params[key] = value;
    assert.throws(() => validateProject(candidate), /氛围粒子/);
  };
  invalid('preset', 'unknown'); invalid('preset', false); invalid('color', 'url(https://example.invalid)');
  invalid('count', 10.5); invalid('seed', 3.25);
  for (const [key, [min, max]] of Object.entries(PARTICLE_LIMITS)) {
    for (const value of [min, max]) {
      const candidate = structuredClone(project); candidate.layers[0].params[key] = value;
      assert.equal(validateProject(candidate).layers[0].params[key], value);
    }
    invalid(key, min - 1); invalid(key, max + 1); invalid(key, String(min));
  }
});

type Operation = { name: string; args: unknown[] };
function drawing(layer: Layer, time: number, editor = false): Operation[] {
  const operations: Operation[] = [];
  const state = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      return (...args: unknown[]) => operations.push({ name: String(key), args });
    },
    set: Reflect.set,
  }) as unknown as CanvasRenderingContext2D;
  const project = createDefaultProject(); project.layers = [layer];
  renderScene(ctx, project, time, { cover: null, analysis: null }, { editor, selectionId: layer.id });
  return operations;
}

test('scene dispatch honors particle visibility and time range, and keeps selection out of export', () => {
  const layer = makeLayer('particles'); layer.params = particleDefaults('rain'); layer.start = 2; layer.end = 5;
  const strokes = (time: number) => drawing(layer, time).filter(op => op.name === 'stroke').length;
  assert.equal(strokes(1.9), 0); assert.ok(strokes(3) > 0); assert.equal(strokes(5), 0);
  assert.equal(drawing(layer, 3).filter(op => op.name === 'strokeRect').length, 0);
  assert.ok(drawing(layer, 3, true).some(op => op.name === 'strokeRect'));
  layer.visible = false; assert.equal(strokes(3), 0);
});

test('moving and resizing a particle clip preserves its local animation and arbitrary-seek result', () => {
  const layer = makeLayer('particles'); layer.params = particleDefaults('rain'); layer.start = 2; layer.end = 5;
  const lines = (item: Layer, time: number) => drawing(item, time).filter(op => op.name === 'moveTo' || op.name === 'lineTo');
  const before = lines(layer, 3.25); assert.ok(before.length > 0);
  lines(layer, 4.75); lines(layer, 2.1);
  assert.deepEqual(lines(layer, 3.25), before);
  const moved = moveLayer(layer, 8, 30);
  assert.deepEqual(lines(moved, 9.25), before);
  const project = createDefaultProject(); project.layers = [moved];
  const shorter = resizeProjectDuration(project, 9);
  assert.ok(shorter.layers[0].end <= 9);
  assert.deepEqual(shorter.layers[0].params, moved.params);
});
