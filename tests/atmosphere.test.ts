import test from 'node:test';
import assert from 'node:assert/strict';
import { ATMOSPHERE_KINDS, ATMOSPHERE_PRESETS, ATMOSPHERE_LIMITS, atmosphereDefaults,
  resolveAtmosphereParams, sampleAtmosphere, atmosphereFade, drawAtmosphere,
  clearAtmosphereCache, atmosphereCacheStats } from '../src/atmosphere';
import type { Layer, LayerParams } from '../src/types';

const layer = (params: LayerParams = atmosphereDefaults()): Layer => ({
  id: 'atmosphere-test', type: 'atmosphere', name: '光影氛围', x: 320, y: 180,
  width: 640, height: 360, rotation: 0, opacity: .7, visible: true, locked: false,
  start: 4, end: 20, params,
});

test('three atmosphere types offer distinct presets with complete safe scalar defaults', () => {
  assert.deepEqual(ATMOSPHERE_KINDS.map(item => item.value), ['leak', 'fog', 'rays']);
  const samples = new Set<string>();
  for (const kind of ATMOSPHERE_KINDS) {
    const presets = ATMOSPHERE_PRESETS.filter(item => item.kind === kind.value);
    assert.ok(presets.length >= 2);
    for (const preset of presets) {
      const p = atmosphereDefaults(kind.value, preset.value);
      assert.equal(p.preset, preset.value); assert.equal(p.kind, kind.value);
      assert.equal(p.blendMode, kind.value === 'fog' ? 'normal' : 'screen');
      for (const [key, [min, max]] of Object.entries(ATMOSPHERE_LIMITS)) {
        assert.equal(typeof p[key], 'number'); assert.ok(Number(p[key]) >= min && Number(p[key]) <= max);
      }
      const frame = sampleAtmosphere(p, 2.5, 1920, 1080)!;
      samples.add(JSON.stringify(frame));
      assert.equal(frame.kind, kind.value);
      assert.equal(frame.glows.length > 0, kind.value === 'leak');
      assert.equal(frame.fog.length > 0, kind.value === 'fog');
      assert.equal(frame.beams.length > 0, kind.value === 'rays');
      assert.equal(JSON.stringify(p).includes('null'), false);
    }
  }
  assert.equal(samples.size, ATMOSPHERE_PRESETS.length);
});

test('invalid parameters fall back, finite numerics clamp and integer values round', () => {
  for (const [key, [min, max]] of Object.entries(ATMOSPHERE_LIMITS)) {
    assert.equal(resolveAtmosphereParams({ [key]: min - 9999999 })[key], min);
    assert.equal(resolveAtmosphereParams({ [key]: max + 9999999 })[key], max);
    for (const raw of [NaN, Infinity, -Infinity, true, '3']) assert.equal(resolveAtmosphereParams({ [key]: raw })[key], atmosphereDefaults()[key]);
  }
  assert.equal(resolveAtmosphereParams({ kind: 'unknown', preset: 'cool-mist', blendMode: 'multiply', color: 'red' }).kind, 'leak');
  assert.equal(resolveAtmosphereParams({ kind: 'fog', preset: 'warm-haze' }).color, atmosphereDefaults('fog', 'warm-haze').color);
  assert.equal(resolveAtmosphereParams({ color: '#aBcD09', secondaryColor: '#112233' }).color, '#aBcD09');
  assert.equal(resolveAtmosphereParams({ seed: 17.8, rayCount: 6.7 }).seed, 18);
  assert.equal(resolveAtmosphereParams({ seed: 17.8, rayCount: 6.7 }).rayCount, 7);
  assert.equal(resolveAtmosphereParams({ blendMode: 'add' }).blendMode, 'add');
});

test('atmosphere sampling is seek deterministic and the zero speed freezes its motion', () => {
  for (const { value } of ATMOSPHERE_KINDS) {
    const p = atmosphereDefaults(value); const snapshot = sampleAtmosphere(p, 12.345, 800, 450);
    for (const time of [4000, .1, 0, 25]) sampleAtmosphere(p, time, 800, 450);
    assert.deepEqual(sampleAtmosphere(p, 12.345, 800, 450), snapshot);
    assert.notDeepEqual(sampleAtmosphere({ ...p, seed: p.seed + 1 }, 12.345, 800, 450), snapshot);
    assert.notDeepEqual(sampleAtmosphere(p, 20, 800, 450), snapshot);
    assert.deepEqual(sampleAtmosphere({ ...p, speed: 0 }, 0, 800, 450), sampleAtmosphere({ ...p, speed: 0 }, 10000, 800, 450));
    assert.ok(!JSON.stringify(sampleAtmosphere(p, 100000000, 800, 450)).includes('null'));
    const before = structuredClone(p); sampleAtmosphere(p, 7, 800, 450); assert.deepEqual(p, before);
  }
  for (const bad of [-1, NaN, Infinity]) assert.equal(sampleAtmosphere({}, bad, 640, 360), null);
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(sampleAtmosphere({}, 1, bad, 360), null); assert.equal(sampleAtmosphere({}, 1, 640, bad), null);
  }
});

test('visible source and shape controls affect the relevant physical samples', () => {
  for (const kind of ['leak', 'rays'] as const) {
    const p = atmosphereDefaults(kind); const first = sampleAtmosphere(p, 2, 800, 450)!;
    const moved = sampleAtmosphere({ ...p, sourceX: .7, sourceY: .5 }, 2, 800, 450)!;
    assert.notDeepEqual(first, moved);
    if (kind === 'leak') {
      assert.notEqual(first.glows[0].x, moved.glows[0].x); assert.notEqual(first.glows[0].y, moved.glows[0].y);
    } else {
      assert.notEqual(first.sourceX, moved.sourceX); assert.notEqual(first.sourceY, moved.sourceY);
      const wide = sampleAtmosphere({ ...p, spread: 120, rayCount: 20, length: 2, scale: 2 }, 2, 800, 450)!;
      assert.equal(wide.beams.length, 20); assert.ok(wide.beams[0].length > first.beams[0].length);
      assert.ok(Math.abs(wide.beams.at(-1)!.angle - wide.beams[0].angle) > Math.abs(first.beams.at(-1)!.angle - first.beams[0].angle));
    }
  }
  const fog = atmosphereDefaults('fog');
  const light = sampleAtmosphere({ ...fog, density: .1 }, 2, 800, 450)!;
  const dense = sampleAtmosphere({ ...fog, density: .9 }, 2, 800, 450)!;
  assert.ok(light.fog.every((item, i) => item.alpha < dense.fog[i].alpha));
});

test('fades honor clip-local time and compress proportionally without overlapping short clips', () => {
  const clip = layer({ ...atmosphereDefaults(), fadeIn: 1, fadeOut: 2 });
  assert.equal(atmosphereFade(clip, 4), 0); assert.equal(atmosphereFade(clip, 5), 1);
  assert.equal(atmosphereFade(clip, 18), 1); assert.equal(atmosphereFade(clip, 19), .5);
  assert.equal(atmosphereFade(clip, 20), 0);
  const short = { ...clip, start: 0, end: .3 };
  assert.ok(Math.abs(atmosphereFade(short, .1) - 1) < 1e-12);
  assert.ok(atmosphereFade(short, .05) > .49 && atmosphereFade(short, .05) < .51);
  assert.ok(atmosphereFade(short, .2) > .49 && atmosphereFade(short, .2) < .51);
  const noFade = { ...clip, params: { ...clip.params, fadeIn: 0, fadeOut: 0 } };
  assert.equal(atmosphereFade(noFade, 4), 1);
  for (const time of [-1, 3.9, 20, NaN, Infinity]) assert.equal(atmosphereFade(clip, time), 0);
});

function recordedCanvas() {
  const calls: { kind: string; alpha: number; blend: string; args: unknown[] }[] = [];
  const state: Record<string, any> = { globalAlpha: .35, globalCompositeOperation: 'multiply', fillStyle: '#123456',
    filter: 'blur(2px)', tx: 0, ty: 0, angle: 0, sx: 1, sy: 1 };
  const stack: Record<string, any>[] = [];
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => stack.push({ ...target });
    if (key === 'restore') return () => {
      const original = stack.pop()!; for (const name of Object.keys(target)) delete target[name]; Object.assign(target, original);
    };
    if (key === 'translate') return (x: number, y: number) => { target.tx += x; target.ty += y; };
    if (key === 'rotate') return (angle: number) => { target.angle += angle; };
    if (key === 'scale') return (x: number, y: number) => { target.sx *= x; target.sy *= y; };
    if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop: () => {} });
    if (key === 'createPattern') return (...args: unknown[]) => {
      calls.push({ kind: key, alpha: target.globalAlpha, blend: target.globalCompositeOperation, args });
      return { type: 'pattern' };
    };
    if (key === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    if (['drawImage', 'fill', 'fillRect', 'putImageData', 'rect', 'clip', 'clearRect'].includes(key)) return (...args: unknown[]) => {
      calls.push({ kind: key, alpha: target.globalAlpha, blend: target.globalCompositeOperation, args });
    };
    return () => {};
  } }) as unknown as CanvasRenderingContext2D;
  return { ctx, state, stack, calls };
}

test('fallback drawing preserves alpha/blend/transform and moving a clip preserves animation', () => {
  for (const { value } of ATMOSPHERE_KINDS) {
    const first = recordedCanvas(); const second = recordedCanvas(); const before = { ...first.state };
    const clip = layer(atmosphereDefaults(value)); const moved = { ...clip, start: 10, end: 26 };
    drawAtmosphere(first.ctx, clip, 6.5); drawAtmosphere(second.ctx, moved, 12.5);
    assert.deepEqual(first.calls, second.calls);
    assert.deepEqual(first.calls.find(item => item.kind === 'rect')?.args, [0, 0, 640, 360]);
    assert.ok(first.calls.some(item => item.kind === 'fill' || item.kind === 'fillRect'));
    assert.ok(first.calls.every(item => item.alpha <= .35));
    assert.deepEqual(first.state, before); assert.equal(first.stack.length, 0);
  }
  const empty = recordedCanvas(); const clip = layer();
  for (const time of [3, 4, 20, NaN, Infinity]) drawAtmosphere(empty.ctx, clip, time);
  drawAtmosphere(empty.ctx, layer({ ...clip.params, intensity: 0 }), 8);
  drawAtmosphere(empty.ctx, layer({ ...atmosphereDefaults('fog'), density: 0 }), 8);
  drawAtmosphere(empty.ctx, { ...clip, width: 0 }, 8);
  assert.equal(empty.calls.length, 0);
});

test('renderer errors restore caller state', () => {
  for (const kind of ATMOSPHERE_KINDS) {
    const { ctx, state, stack } = recordedCanvas();
    state[kind.value === 'rays' ? 'fill' : 'fillRect'] = () => { throw new Error('draw failed'); };
    const before = { ...state };
    assert.throws(() => drawAtmosphere(ctx, layer(atmosphereDefaults(kind.value)), 8), /draw failed/);
    assert.deepEqual(state, before); assert.equal(stack.length, 0);
  }
});

test('offscreen work is reused, cached clouds are continuous textures and one composite applies alpha', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const created: { width: number; height: number; recorded: ReturnType<typeof recordedCanvas> }[] = [];
  class FakeCanvas {
    width: number; height: number; recorded = recordedCanvas();
    constructor(width: number, height: number) { this.width = width; this.height = height; created.push(this); }
    getContext() { return this.recorded.ctx; }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: FakeCanvas });
  clearAtmosphereCache();
  try {
    const p = { ...atmosphereDefaults('fog'), blendMode: 'add' }; const clip = layer(p);
    const target = recordedCanvas(); const before = { ...target.state };
    drawAtmosphere(target.ctx, clip, 8); drawAtmosphere(target.ctx, clip, 9);
    assert.equal(created.length, 4, 'one work surface and three independent seeded cloud textures');
    assert.equal(target.calls.filter(item => item.kind === 'drawImage').length, 2, 'each frame composites the component just once');
    assert.ok(target.calls.filter(item => item.kind === 'drawImage').every(item => item.blend === 'lighter' && Math.abs(item.alpha - .35 * Number(p.intensity)) < 1e-12));
    assert.deepEqual(target.state, before);
    const cloud = created.find(item => item.width === 128)!.recorded.calls.find(item => item.kind === 'putImageData')!.args[0] as { data: Uint8ClampedArray };
    const alphas = Array.from(cloud.data).filter((_, index) => index % 4 === 3);
    assert.ok(new Set(alphas).size > 80, 'clouds are a continuous field rather than opaque shapes or point particles');
    assert.ok(Math.max(...alphas) < 255 && Math.min(...alphas) > 0, 'the texture has no opaque backing');
    assert.ok(created[0].recorded.calls.some(item => item.blend === 'destination-out'), 'soft feathering only removes the border of its private surface');
    assert.equal(created[0].recorded.calls.filter(item => item.kind === 'createPattern').length, 6, 'three periodic cloud fields are filled once per frame');
    assert.equal(created[0].recorded.calls.filter(item => item.kind === 'drawImage').length, 0, 'individual rotated image tiles cannot introduce seams');
    drawAtmosphere(recordedCanvas().ctx, { ...clip, width: 3840, height: 2160 }, 8);
    assert.ok(created.every(item => item.width <= 640 && item.height <= 640), 'rendering never creates a full-resolution effect surface');
    for (const [width, height] of [[1, 640], [640, 1]]) {
      drawAtmosphere(recordedCanvas().ctx, { ...clip, width, height }, 8);
      const work = created.find(item => item.width === width && item.height === height)!;
      assert.equal(work.recorded.calls.filter(item => item.kind === 'createPattern').length, 3, 'even extreme aspect ratios retain three constant-cost cloud fills');
      assert.equal(work.recorded.calls.filter(item => item.kind === 'fillRect').length, 7, 'three cloud fills and four border masks, independent of virtual tile count');
      assert.equal(work.recorded.calls.filter(item => item.kind === 'drawImage').length, 0);
    }
    for (let seed = 1; seed <= 40; seed++) drawAtmosphere(recordedCanvas().ctx, layer({ ...p, seed }), 8);
    const stats = atmosphereCacheStats(); assert.ok(stats.bytes <= stats.byteBudget); assert.ok(stats.entries <= stats.entryLimit);
    const count = created.length; drawAtmosphere(recordedCanvas().ctx, clip, 8);
    assert.ok(created.length > count, 'old seeds are evicted');
    clearAtmosphereCache(); assert.equal(atmosphereCacheStats().bytes, 0); assert.equal(atmosphereCacheStats().entries, 0);
  } finally {
    clearAtmosphereCache();
    if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original); else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  }
});
