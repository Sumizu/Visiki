import test from 'node:test';
import assert from 'node:assert/strict';
import { clearParticleCache, drawParticles, PARTICLE_LIMITS, PARTICLE_PRESETS,
  particleDefaults, resolveParticleParams, sampleParticles } from '../src/particles';
import type { Layer, LayerParams } from '../src/types';

const layer = (params: LayerParams = particleDefaults()): Layer => ({
  id: 'particles-test', type: 'particles', name: '氛围粒子', x: 320, y: 180,
  width: 640, height: 360, rotation: 0, opacity: .7, visible: true, locked: false,
  start: 4, end: 20, params,
});

test('all six presets have distinct defaults, stable identities and finite samples', () => {
  assert.deepEqual(PARTICLE_PRESETS.map(item => item.value), ['stardust', 'firefly', 'snow', 'rain', 'petals', 'bokeh']);
  const signatures = new Set<string>();
  for (const { value } of PARTICLE_PRESETS) {
    const params = particleDefaults(value);
    assert.equal(params.preset, value); assert.equal(params.count, 80);
    signatures.add(JSON.stringify(sampleParticles(params, 1.25, 1920, 1080)));
    for (const time of [0, .001, 5.5, 10000]) {
      const items = sampleParticles(params, time, 1920, 1080);
      assert.equal(items.length, 80); assert.ok(items.some(item => item.alpha > .01));
      for (const item of items) {
        assert.equal(item.preset, value);
        assert.ok(Object.values(item).filter(part => typeof part === 'number').every(Number.isFinite));
        assert.ok(item.x >= 0 && item.x < 1920 && item.y >= 0 && item.y < 1080);
        assert.ok(item.alpha >= 0 && item.alpha <= params.particleOpacity);
        assert.ok(item.size >= 0 && item.size <= params.size);
      }
    }
  }
  assert.equal(signatures.size, 6);
});

test('sampling is deterministic across seeks, export order and density changes', () => {
  const params = { ...particleDefaults('snow'), seed: 713 };
  const snapshot = sampleParticles(params, 12.345, 800, 450);
  for (const t of [17, 1, 100, 0, 5]) sampleParticles(params, t, 800, 450);
  assert.deepEqual(sampleParticles(params, 12.345, 800, 450), snapshot);
  assert.notDeepEqual(sampleParticles({ ...params, seed: 714 }, 12.345, 800, 450), snapshot);
  assert.deepEqual(sampleParticles({ ...params, count: 10 }, 12.345, 800, 450), snapshot.slice(0, 10));
  assert.notDeepEqual(sampleParticles(params, 12.4, 800, 450), snapshot);
  const stable = structuredClone(params); sampleParticles(params, 0, 800, 450); assert.deepEqual(params, stable);
});

test('presets have distinct physical motion and rain streaks lean with their drift', () => {
  for (const { value } of PARTICLE_PRESETS) {
    const params = { ...particleDefaults(value), count: 10, wind: 1, turbulence: 0, speed: 1 };
    const a = sampleParticles(params, 0, 100000, 100000);
    const b = sampleParticles(params, .1, 100000, 100000);
    const id = b.findIndex((item, i) => Math.abs(item.x - a[i].x) < 1000 && Math.abs(item.y - a[i].y) < 1000);
    assert.ok(id >= 0);
    const dy = b[id].y - a[id].y;
    if (value === 'rain') {
      assert.ok(dy >= 40, 'rain falls quickly');
      assert.ok(b[id].length >= b[id].size * 5, 'rain is an elongated streak');
      assert.ok(b[id].x > a[id].x && b[id].rotation < 0, 'the downward rain vector leans right with positive wind');
    } else if (value === 'snow' || value === 'petals') assert.ok(dy > 0 && dy < 10, 'snow and petals drift slowly down');
    else assert.ok(dy < 0 && dy > -10, 'light particles drift gently up');
    if (value === 'petals') {
      assert.ok(b[id].aspect >= .18 && b[id].aspect <= 1);
      assert.notEqual(b[id].aspect, a[id].aspect, 'petals tumble in depth');
    }
  }
});

test('numeric settings are clamped, integral settings rounded and malformed settings use defaults', () => {
  for (const [key, [min, max]] of Object.entries(PARTICLE_LIMITS)) {
    assert.equal(resolveParticleParams({ [key]: min - 10000000 })[key], min);
    assert.equal(resolveParticleParams({ [key]: max + 10000000 })[key], max);
    for (const raw of [NaN, Infinity, -Infinity, true, '3']) {
      assert.equal(resolveParticleParams({ [key]: raw })[key], particleDefaults()[key]);
    }
  }
  assert.equal(resolveParticleParams({ count: 17.6, seed: 800.7 }).count, 18);
  assert.equal(resolveParticleParams({ count: 17.6, seed: 800.7 }).seed, 801);
  assert.equal(resolveParticleParams({ preset: 'unknown', color: '#00ff' }).preset, 'stardust');
  assert.equal(resolveParticleParams({ color: '#aBc013' }).color, '#aBc013');
  assert.equal(resolveParticleParams({ color: 'url(unsafe)' }).color, particleDefaults().color);
  assert.equal(sampleParticles({ count: 900000 }, 1, 100, 100).length, 400);
  assert.ok(sampleParticles({ particleOpacity: 0 }, 1, 100, 100).every(item => item.alpha === 0));
});

test('invalid times and extents produce no particles', () => {
  for (const time of [-1, NaN, Infinity]) assert.deepEqual(sampleParticles({}, time, 640, 360), []);
  for (const extent of [-1, 0, NaN, Infinity]) {
    assert.deepEqual(sampleParticles({}, 1, extent, 360), []);
    assert.deepEqual(sampleParticles({}, 1, 640, extent), []);
  }
});

test('particle wraps occur while invisible instead of jumping across the visible rectangle', () => {
  const params = { ...particleDefaults('rain'), count: 30, size: 8, speed: 4, wind: 2, twinkle: 0 };
  let previous = sampleParticles(params, 0, 120, 80); let wraps = 0;
  for (let tick = 1; tick <= 300; tick++) {
    const current = sampleParticles(params, tick * .0001, 120, 80);
    for (let id = 0; id < current.length; id++) {
      if (Math.abs(current[id].x - previous[id].x) > 60 || Math.abs(current[id].y - previous[id].y) > 40) {
        wraps++;
        assert.ok(Math.max(previous[id].alpha, current[id].alpha) < .01, 'both sides of a wrap fade out');
      }
    }
    previous = current;
  }
  assert.ok(wraps > 10, 'the sample crosses enough real loop boundaries to test continuity');
});

function recordedCanvas() {
  const calls: { kind: string; alpha: number; args: unknown[] }[] = [];
  const state: Record<string, any> = { globalAlpha: .35, fillStyle: '#123456', strokeStyle: '#654321',
    lineWidth: 7, lineCap: 'butt', filter: 'none', tx: 0, ty: 0, angle: 0, sx: 1, sy: 1 };
  const stack: Record<string, any>[] = [];
  let clipped = false;
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => { stack.push({ ...target }); };
    if (key === 'restore') return () => {
      const original = stack.pop()!; for (const name of Object.keys(target)) delete target[name]; Object.assign(target, original);
    };
    if (key === 'translate') return (x: number, y: number) => { target.tx += x; target.ty += y; };
    if (key === 'rotate') return (r: number) => { target.angle += r; };
    if (key === 'scale') return (x: number, y: number) => { target.sx *= x; target.sy *= y; };
    if (key === 'clip') return () => { clipped = true; calls.push({ kind: 'clip', alpha: target.globalAlpha, args: [] }); };
    if (key === 'rect') return (...args: number[]) => calls.push({ kind: 'rect', alpha: target.globalAlpha, args });
    if (key === 'createRadialGradient') return () => ({ addColorStop: () => {} });
    if (['drawImage', 'fill', 'stroke'].includes(key)) return (...args: unknown[]) => {
      assert.ok(clipped || key === 'fill', 'drawing occurs within the layer clipping scope');
      calls.push({ kind: key, alpha: target.globalAlpha, args });
    };
    return () => {};
  } }) as unknown as CanvasRenderingContext2D;
  return { ctx, state, stack, calls };
}

test('drawing uses clip-relative animation, combines alpha and restores the caller state', () => {
  for (const { value } of PARTICLE_PRESETS) {
    const a = recordedCanvas(); const b = recordedCanvas();
    const original = { ...a.state }; const first = layer(particleDefaults(value));
    const moved = { ...first, start: 10, end: 26 };
    drawParticles(a.ctx, first, 6.5); drawParticles(b.ctx, moved, 12.5);
    assert.deepEqual(a.calls, b.calls, 'moving a clip must preserve the same local animation');
    assert.deepEqual(a.calls.find(call => call.kind === 'rect')?.args, [0, 0, 640, 360]);
    assert.ok(a.calls.filter(call => call.kind !== 'rect' && call.kind !== 'clip').every(call => call.alpha <= .35));
    assert.deepEqual(a.state, original); assert.equal(a.stack.length, 0);
  }
  const empty = recordedCanvas(); const clip = layer();
  for (const time of [3, 20, NaN, Infinity]) drawParticles(empty.ctx, clip, time);
  drawParticles(empty.ctx, layer({ ...particleDefaults(), particleOpacity: 0 }), 5);
  assert.equal(empty.calls.length, 0);
});

test('canvas state is restored when a particle renderer fails', () => {
  const { ctx, state, stack } = recordedCanvas();
  state.stroke = () => { throw new Error('renderer failure'); };
  const before = { ...state };
  assert.throws(() => drawParticles(ctx, layer(particleDefaults('rain')), 5), /renderer failure/);
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});

test('soft sprite caching is reused, bounded and explicitly released', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  let created = 0;
  class FakeCanvas {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; created++; }
    getContext() { return recordedCanvas().ctx; }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: FakeCanvas });
  clearParticleCache();
  try {
    const { ctx } = recordedCanvas();
    const clip = layer(particleDefaults('firefly'));
    drawParticles(ctx, clip, 5); drawParticles(ctx, clip, 8);
    assert.equal(created, 1, 'all particles share one cached soft sprite');
    for (let i = 0; i < 30; i++) drawParticles(ctx, layer({ ...clip.params, color: `#${(i + 1).toString(16).padStart(6, '0')}` }), 5);
    const afterColors = created;
    drawParticles(ctx, clip, 5);
    assert.equal(created, afterColors + 1, 'old colors are evicted instead of growing canvas memory without limit');
    clearParticleCache(); drawParticles(ctx, clip, 5);
    assert.equal(created, afterColors + 2, 'clearing the scene releases its soft sprites');
  } finally {
    clearParticleCache();
    if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original);
    else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  }
});
