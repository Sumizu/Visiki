import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { ATMOSPHERE_KINDS, ATMOSPHERE_PRESETS, ATMOSPHERE_LIMITS, atmosphereDefaults } from '../src/atmosphere';
import { validateProject } from '../src/project-io';
import { renderScene } from '../src/scene';
import { collectExportImageAssets } from '../src/services';
import { moveLayer } from '../src/layer-timing';
import type { Layer } from '../src/types';

test('atmosphere presets save independently and old fades migrate once into an editable effect', () => {
  const original = createDefaultProject(); assert.deepEqual(validateProject(structuredClone(original)), original);
  original.layers = ATMOSPHERE_PRESETS.map((preset, index) => {
    const layer = makeLayer('atmosphere'); layer.params = { ...atmosphereDefaults(preset.kind, preset.value), seed: 400 + index };
    delete layer.effects;
    layer.x = 300 + index * 20; layer.width = 720; layer.height = 480; layer.start = 1; layer.end = 20; layer.opacity = .6;
    return layer;
  });
  const migrated=validateProject(JSON.parse(JSON.stringify(original)));
  migrated.layers.forEach((layer,index)=>{
    assert.deepEqual(layer.params,{...original.layers[index].params,fadeIn:0,fadeOut:0});
    assert.equal(layer.effects!.length,1);assert.equal(layer.effects![0].type,'fade');
    assert.equal(layer.effects![0].params.fadeIn,original.layers[index].params.fadeIn);
    assert.equal(layer.effects![0].params.fadeOut,original.layers[index].params.fadeOut);
  });
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(migrated))),migrated);
  original.layers = [makeLayer('atmosphere')]; original.layers[0].params = {};
  assert.deepEqual(validateProject(original).layers[0].params, {...atmosphereDefaults(),fadeIn:0,fadeOut:0});
  for (const { value } of ATMOSPHERE_KINDS) {
    original.layers[0].params = { kind: value };
    assert.deepEqual(validateProject(original).layers[0].params, {...atmosphereDefaults(value),fadeIn:0,fadeOut:0});
  }
});

test('atmosphere validation checks kind, matching preset, scalar bounds and integral settings', () => {
  const project = createDefaultProject(); project.layers = [makeLayer('atmosphere')];
  const bad = (key: string, value: string | number | boolean) => {
    const copy = structuredClone(project); copy.layers[0].params[key] = value;
    assert.throws(() => validateProject(copy), /光影氛围/);
  };
  bad('kind', 'unknown'); bad('preset', 'unknown'); bad('blendMode', 'overlay'); bad('color', 'red'); bad('secondaryColor', '#12345'); bad('seed', 1.5); bad('rayCount', 4.5);
  const other = ATMOSPHERE_PRESETS.find(value => value.kind !== project.layers[0].params.kind)!; bad('preset', other.value);
  for (const [key, [min, max]] of Object.entries(ATMOSPHERE_LIMITS)) {
    for (const value of [min, max]) {
      const copy = structuredClone(project); copy.layers[0].params[key] = value;
      const result=validateProject(copy).layers[0];
      assert.equal(result.params[key],key==='fadeIn'||key==='fadeOut'?0:value);
      if((key==='fadeIn'||key==='fadeOut')&&value>0)assert.equal(result.effects!.at(-1)!.params[key],value);
    }
    bad(key, min - 1); bad(key, max + 1); bad(key, String(min));
  }
});

function operations(layer: Layer, time: number, editor = false) {
  const names: string[] = [];
  const states: Record<string, unknown>[] = [];
  const state: Record<string, unknown> = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1, globalCompositeOperation: 'source-over' };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === 'save') return () => states.push({ ...state });
      if (key === 'restore') return () => { const saved = states.pop()!; for (const k of Object.keys(state)) delete state[k]; Object.assign(state, saved); };
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient;
      return () => { names.push(String(key)); };
    }, set: Reflect.set,
  }) as unknown as CanvasRenderingContext2D;
  const project = createDefaultProject(); project.layers = [layer];
  renderScene(ctx, project, time, { cover: null, analysis: null }, { editor, selectionId: layer.id });
  return names;
}

test('atmosphere dispatch obeys visibility and clip times and leaves selection out of exports', () => {
  const layer = makeLayer('atmosphere'); layer.start = 1; layer.end = 4;
  for (const kind of ATMOSPHERE_KINDS) {
    layer.params = atmosphereDefaults(kind.value);
    const inside = operations(layer, 2);
    assert.ok(inside.some(name => name === 'fill' || name === 'drawImage') || inside.filter(name => name === 'fillRect').length > 1);
    assert.equal(inside.filter(name => name === 'strokeRect').length, 0);
    assert.ok(operations(layer, 2, true).some(name => name === 'strokeRect'));
    for (const time of [.5, 4]) assert.deepEqual(operations(layer, time), ['setTransform', 'fillRect']);
    layer.visible = false; assert.deepEqual(operations(layer, 2), ['setTransform', 'fillRect']); layer.visible = true;
  }
});

test('atmosphere needs no image assets and moving its timeline clip retains appearance settings', () => {
  const project = createDefaultProject(); const layer = makeLayer('atmosphere'); layer.start = 2; layer.end = 5; project.layers = [layer];
  project.cover = { id: 'unused-cover', type: 'image', name: 'unused.png', url: '/api/assets/unused-cover' };
  assert.deepEqual(collectExportImageAssets(project, { start: 0, end: 10 }), []);
  const moved = moveLayer(layer, 8, 30);
  assert.equal(moved.start, 8); assert.equal(moved.end, 11); assert.deepEqual(moved.params, layer.params);
  assert.equal(validateProject({ ...project, layers: [moved] }).layers[0].start, 8);
});
