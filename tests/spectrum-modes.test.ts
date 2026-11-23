import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import type { AudioAnalysis, Layer } from '../src/types';

const analysis: AudioAnalysis = { hopSec: 1 / 30, bands: 64,
  frames: Array.from({ length: 61 }, () => new Float32Array(64).fill(.8)),
  peaks: new Float32Array(61).fill(.65), waveform: new Float32Array(100), sampleRate: 48000, duration: 2 };

function render(layer: Layer, time = .5) {
  const operations: { name: string; alpha: number; args: unknown[] }[] = [];
  const states: Record<string, unknown>[] = [];
  const state: Record<string, unknown> = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === 'save') return () => states.push({ ...state });
      if (key === 'restore') return () => { const saved = states.pop()!; for (const k of Object.keys(state)) delete state[k]; Object.assign(state, saved); };
      return (...args: unknown[]) => operations.push({ name: String(key), alpha: Number(state.globalAlpha), args });
    },
    set(target, key, value) {
      if (key === 'shadowBlur' && Number(value) > 0) operations.push({ name: 'shadow', alpha: Number(state.globalAlpha), args: [value] });
      return Reflect.set(target, key, value);
    },
  }) as unknown as CanvasRenderingContext2D;
  const project = createDefaultProject(); project.layers = [layer];
  renderScene(ctx, project, time, { analysis, cover: null });
  return operations;
}

test('all five spectrum styles save independently without migrating existing spectrum modes', () => {
  for (const mode of ['bars', 'ecg-wave', 'dual-wave', 'wave', 'ring']) {
    const project = createDefaultProject(); const layer = makeLayer('spectrum');
    layer.params = { ...layer.params, mode, color: '#a6ddff', gain: 2, barCount: 96 }; project.layers = [layer];
    const loaded = validateProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(loaded.layers[0], layer);
    assert.equal(loaded.layers[0].params.mode, mode);
  }
});

test('scene dispatch draws two open wave strokes and one filled envelope contour', () => {
  const layer = makeLayer('spectrum'); layer.params.mode = 'dual-wave'; layer.opacity = .6;
  const fresh = render(layer);
  const strokes = fresh.filter(op => op.name === 'stroke');
  assert.equal(strokes.length, 2);
  assert.ok(strokes.every(op => op.alpha > 0 && op.alpha <= .6));
  assert.equal(strokes[0].alpha, .6);
  assert.ok(!fresh.some(op => ['fill', 'closePath', 'shadow'].includes(op.name)));
  layer.params.mode = 'wave'; const legacy = render(layer);
  assert.equal(legacy.filter(op => op.name === 'fill').length, 1);
  assert.equal(legacy.filter(op => op.name === 'closePath').length, 1);
  assert.equal(legacy.filter(op => op.name === 'stroke').length, 1);
  layer.params.mode = 'ecg-wave'; const single = render(layer);
  assert.equal(single.filter(op => op.name === 'stroke').length, 1);
  assert.equal(single.find(op => op.name === 'stroke')?.alpha, .6);
  assert.ok(!single.some(op => ['fill', 'closePath', 'shadow'].includes(op.name)));
});

test('new spectrum style obeys shared layer visibility and time ranges without affecting other styles', () => {
  const layer = makeLayer('spectrum'); layer.start = .25; layer.end = 1.5;
  for (const [mode, strokes] of [['dual-wave', 2], ['ecg-wave', 1]] as const) {
    layer.params.mode = mode; layer.visible = true;
    assert.equal(render(layer, .1).filter(op => op.name === 'stroke').length, 0);
    assert.equal(render(layer, 1.5).filter(op => op.name === 'stroke').length, 0);
    assert.equal(render(layer, 1).filter(op => op.name === 'stroke').length, strokes);
    layer.visible = false; assert.equal(render(layer).filter(op => op.name === 'stroke').length, 0);
  }
  layer.visible = true; layer.params.mode = 'bars'; assert.ok(render(layer).filter(op => op.name === 'fillRect').length > 2);
  layer.params.mode = 'ring'; assert.equal(render(layer).filter(op => op.name === 'stroke').length, Number(layer.params.barCount));
});
