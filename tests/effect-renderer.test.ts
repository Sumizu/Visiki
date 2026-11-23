import test from 'node:test';
import assert from 'node:assert/strict';
import type { EffectType, LayerEffect, LayerParams } from '../src/types';
import { effectDefaults } from '../src/effects';
import { applyLayerEffects, clearEffectRendererCache, effectAnimationFrame, effectRendererStats, renderEffectsPixels, sampleEffectNoise } from '../src/effect-renderer';
import type { EffectBounds } from '../src/effect-renderer';

const effect = (type: EffectType, params: LayerParams = {}, strength = 1): LayerEffect => ({ id: type, type, enabled: true, strength, params: { ...effectDefaults(type), ...params } });
const bounds = (width: number, height: number): EffectBounds => ({ x: width / 2, y: height / 2, width, height, rotation: 0 });
const solid = (width: number, height: number, color = [148, 98, 63, 255]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(width * height * 4); for (let i = 0; i < data.length; i += 4) data.set(color, i); return data;
};
const pixel = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] => Array.from(data.slice((y * width + x) * 4, (y * width + x + 1) * 4));
const neutralFilm = { grain: 0, faded: 0, vignette: 0, flicker: 0, scratches: 0 };
const neutralCrt = { scanlines: 0, vignette: 0, curvature: 0, flicker: 0 };

test('effect noise and frame clocks are deterministic, bounded, and freeze at speed zero', () => {
  const before = sampleEffectNoise(7, 13, 41729, 100);
  for (const x of [-1000, -1, 0, 100, 1000]) for (const frame of [0, 17, 4092, 100000]) {
    const value = sampleEffectNoise(x, 4, 72, frame); assert.ok(value >= 0 && value < 1);
  }
  assert.equal(sampleEffectNoise(7, 13, 41729, 100), before);
  assert.notEqual(sampleEffectNoise(7, 13, 41730, 100), before);
  assert.equal(effectAnimationFrame(10000000, 0), 0);
  assert.equal(effectAnimationFrame(-10, 1), 0); assert.equal(effectAnimationFrame(NaN, 1), 0);
  assert.equal(effectAnimationFrame(2, 1, 8), 16);
});

test('neutral, disabled, or zero strength stacks preserve exact source identity', () => {
  const source = {} as CanvasImageSource; const b = bounds(10, 10);
  const inactive = [effect('color'), effect('film', neutralFilm), effect('rgb-split', { offset: 0 }), effect('glitch', { amount: 0 }), effect('crt', neutralCrt)];
  assert.equal(applyLayerEffects(source, 10, 10, inactive, 1, b), source);
  assert.equal(applyLayerEffects(source, 10, 10, [effect('film', {}, 0)], 1, b), source);
  assert.equal(applyLayerEffects(source, 10, 10, [{ ...effect('film'), enabled: false }], 1, b), source);
  const data = solid(2, 2, [133, 57, 241, 93]); assert.deepEqual(renderEffectsPixels(data, 2, 2, inactive, 1, bounds(2, 2)), data);
});

test('grading changes straight color, preserves alpha and keeps transparent pixels empty', () => {
  const data = new Uint8ClampedArray([180, 100, 30, 128, 20, 30, 40, 0, 230, 230, 230, 255]);
  const result = renderEffectsPixels(data, 3, 1, [effect('color', { saturation: 0, exposure: .25, shadows: .2 })], 0, bounds(3, 1));
  assert.equal(result[0], result[1]); assert.equal(result[1], result[2]); assert.equal(result[3], 128);
  assert.deepEqual(Array.from(result.slice(4, 8)), [0, 0, 0, 0]); assert.equal(result[11], 255);
  assert.notEqual(result[0], data[0]); assert.deepEqual(Array.from(data.slice(0, 4)), [180, 100, 30, 128]);
});

test('grade strength blends in premultiplied space and does not double alpha', () => {
  const data = new Uint8ClampedArray([80, 110, 140, 101]); const b = bounds(1, 1);
  const full = renderEffectsPixels(data, 1, 1, [effect('color', { brightness: .2 })], 0, b);
  const half = renderEffectsPixels(data, 1, 1, [effect('color', { brightness: .2 }, .5)], 0, b);
  assert.equal(half[3], 101); assert.equal(full[3], 101);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(half[c] - (data[c] + full[c]) / 2) <= 1);
});

test('effects execute in the given order and never mutate pixels or settings', () => {
  const data = solid(3, 2, [160, 100, 50, 200]); const original = data.slice();
  const first = effect('color', { exposure: 1.6 }); const second = effect('film', { ...neutralFilm, faded: .35 });
  const settings = structuredClone([first, second]);
  const a = renderEffectsPixels(data, 3, 2, [first, second], 1, bounds(3, 2));
  const b = renderEffectsPixels(data, 3, 2, [second, first], 1, bounds(3, 2));
  assert.notDeepEqual(a, b); assert.deepEqual(data, original); assert.deepEqual([first, second], settings);
});

test('all effect types keep a fully transparent isolated layer transparent', () => {
  const data = new Uint8ClampedArray(48 * 24 * 4);
  for (const type of ['color', 'film', 'rgb-split', 'glitch', 'crt'] as const) {
    const result = renderEffectsPixels(data, 48, 24, [effect(type, type === 'color' ? { brightness: .5 } : {})], 1.25, bounds(48, 24));
    assert.ok(result.every(value => value === 0), type);
  }
});

test('film grain supports random seeking, frozen speed, and independent seeds', () => {
  const data = solid(24, 16); const b = bounds(24, 16); const film = effect('film');
  const snapshot = renderEffectsPixels(data, 24, 16, [film], 3.5, b);
  renderEffectsPixels(data, 24, 16, [film], .1, b);
  assert.deepEqual(renderEffectsPixels(data, 24, 16, [film], 3.5, b), snapshot);
  assert.notDeepEqual(renderEffectsPixels(data, 24, 16, [film], 7, b), snapshot);
  assert.notDeepEqual(renderEffectsPixels(data, 24, 16, [effect('film', { seed: 52893 })], 3.5, b), snapshot);
  assert.deepEqual(renderEffectsPixels(data, 24, 16, [effect('film', { speed: 0 })], 0, b), renderEffectsPixels(data, 24, 16, [effect('film', { speed: 0 })], 1000, b));
});

test('vignettes follow the layer center, aspect ratio, and rotation', () => {
  const data = solid(31, 21, [200, 200, 200, 255]); const film = effect('film', { ...neutralFilm, vignette: .9 });
  const b = { x: 15.5, y: 10.5, width: 20, height: 10, rotation: 90 };
  const rotated = renderEffectsPixels(data, 31, 21, [film], 0, b);
  const equivalent = renderEffectsPixels(data, 31, 21, [film], 0, { ...b, width: 10, height: 20, rotation: 0 });
  for (let i = 0; i < rotated.length; i++) assert.ok(Math.abs(rotated[i] - equivalent[i]) <= 1);
  assert.equal(pixel(rotated, 31, 15, 10)[0], 200);
  assert.ok(pixel(rotated, 31, 22, 10)[0] < pixel(rotated, 31, 15, 17)[0]);
});

test('RGB separation produces red and blue transparent ghosts without stretching canvas edges', () => {
  const data = new Uint8ClampedArray(17 * 4); data.set([255, 255, 255, 128], 8 * 4);
  const result = renderEffectsPixels(data, 17, 1, [effect('rgb-split', { offset: 3, animated: 0 })], 0, bounds(17, 1));
  assert.deepEqual(pixel(result, 17, 11, 0), [255, 0, 0, 128]); assert.deepEqual(pixel(result, 17, 8, 0), [0, 255, 0, 128]); assert.deepEqual(pixel(result, 17, 5, 0), [0, 0, 255, 128]);
  for (const x of [0, 1, 2, 14, 15, 16]) assert.deepEqual(pixel(result, 17, x, 0), [0, 0, 0, 0]);
  const edge = new Uint8ClampedArray(17 * 4); edge.set([255, 255, 255, 255], 0);
  const moved = renderEffectsPixels(edge, 17, 1, [effect('rgb-split', { offset: 3, animated: 0 })], 0, bounds(17, 1));
  assert.equal(pixel(moved, 17, 1, 0)[3], 0); assert.equal(pixel(moved, 17, 2, 0)[3], 0);
});

test('RGB direction rotates with the layer and fractional sampling keeps transparent edges colorful', () => {
  const data = new Uint8ClampedArray(17 * 17 * 4); data.set([255, 255, 255, 128], (8 * 17 + 8) * 4);
  const result = renderEffectsPixels(data, 17, 17, [effect('rgb-split', { offset: 3, animated: 0 })], 0, { ...bounds(17, 17), rotation: 90 });
  assert.deepEqual(pixel(result, 17, 8, 11), [255, 0, 0, 128]); assert.deepEqual(pixel(result, 17, 8, 5), [0, 0, 255, 128]);
  const fractional = renderEffectsPixels(data, 17, 17, [effect('rgb-split', { offset: 2.5, animated: 0 })], 0, bounds(17, 17));
  assert.deepEqual(pixel(fractional, 17, 10, 8), [255, 0, 0, 64]);
});

test('glitch is a deterministic local-time slice effect and amount zero disables its color shift', () => {
  const data = solid(48, 36); const b = bounds(48, 36);
  const glitch = effect('glitch', { amount: .9, blockSize: 4, colorShift: 10 });
  const snapshot = renderEffectsPixels(data, 48, 36, [glitch], 2.75, b);
  assert.deepEqual(renderEffectsPixels(data, 48, 36, [glitch], 2.75, b), snapshot);
  assert.notDeepEqual(renderEffectsPixels(data, 48, 36, [glitch], 8.5, b), snapshot);
  assert.deepEqual(renderEffectsPixels(data, 48, 36, [effect('glitch', { speed: 0 })], 0, b), renderEffectsPixels(data, 48, 36, [effect('glitch', { speed: 0 })], 555, b));
  assert.deepEqual(renderEffectsPixels(data, 48, 36, [effect('glitch', { amount: 0, colorShift: 30 })], 2, b), data);
});

test('CRT scanning keeps source alpha, while curvature remaps into transparent source boundaries', () => {
  const data = solid(32, 24, [220, 220, 220, 140]); const b = bounds(32, 24);
  const scanning = renderEffectsPixels(data, 32, 24, [effect('crt', { ...neutralCrt, scanlines: 1, lineSpacing: 4 })], 0, b);
  for (let i = 3; i < scanning.length; i += 4) assert.equal(scanning[i], 140);
  assert.notEqual(pixel(scanning, 32, 16, 0)[0], pixel(scanning, 32, 16, 1)[0]);
  const curved = renderEffectsPixels(data, 32, 24, [effect('crt', { ...neutralCrt, curvature: .3 })], 0, b);
  assert.equal(pixel(curved, 32, 0, 0)[3], 0); assert.equal(pixel(curved, 32, 16, 12)[3], 140);
});

test('invalid pixel dimensions are rejected and cache teardown is safe without a DOM', () => {
  assert.throws(() => renderEffectsPixels(new Uint8ClampedArray(3), 1, 1, [], 0, bounds(1, 1)), /尺寸/);
  assert.throws(() => renderEffectsPixels(new Uint8ClampedArray(0), 0, 1, [], 0, bounds(1, 1)), /尺寸/);
  clearEffectRendererCache(); clearEffectRendererCache();
  assert.deepEqual(effectRendererStats(), { backend: 'none', width: 0, height: 0, textures: 0, framebuffers: 0, cpuBytes: 0 });
});

test('lost GPU pipelines stay retired after automatic restoration and cache reset builds fresh resources', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const contexts: { canvas: FakeCanvas; lost: boolean; draws: number }[] = [];
  class FakeCanvas extends EventTarget {
    width: number; height: number;
    constructor(width: number, height: number) { super(); this.width = width; this.height = height; }
    getContext(type: string): unknown {
      if (type === '2d') return {
        setTransform() {}, clearRect() {}, drawImage() {}, putImageData() {},
        getImageData: () => ({ data: solid(this.width, this.height) }),
      };
      if (type !== 'webgl') return null;
      const status = { canvas: this, lost: false, draws: 0 }; contexts.push(status);
      const operations: Record<string, unknown> = {
        MAX_TEXTURE_SIZE: 1, FRAMEBUFFER_COMPLETE: 2,
        getParameter: () => 4096, getShaderParameter: () => true, getProgramParameter: () => true,
        createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}), createFramebuffer: () => ({}),
        getUniformLocation: () => ({}), getAttribLocation: () => 0, checkFramebufferStatus: () => 2,
        isContextLost: () => status.lost, drawArrays: () => { status.draws++; },
        getExtension: () => ({ loseContext: () => { status.lost = true; } }),
      };
      return new Proxy(operations, { get: (target, key) => typeof key === 'string' && key in target ? target[key] : typeof key === 'string' && /^[A-Z_0-9]+$/.test(key) ? 0 : () => undefined });
    }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: FakeCanvas });
  try {
    clearEffectRendererCache();
    const source = {} as CanvasImageSource; const effects = [effect('color', { brightness: .1 })]; const b = bounds(2, 2);
    applyLayerEffects(source, 2, 2, effects, 0, b);
    assert.equal(effectRendererStats().backend, 'webgl'); assert.equal(contexts.length, 1); assert.equal(contexts[0].draws, 1);
    contexts[0].lost = true;
    const loss = new Event('webglcontextlost', { cancelable: true }); contexts[0].canvas.dispatchEvent(loss);
    assert.equal(loss.defaultPrevented, true);
    applyLayerEffects(source, 2, 2, effects, 0, b);
    assert.equal(effectRendererStats().backend, 'cpu'); assert.equal(contexts[0].draws, 1);
    contexts[0].lost = false; contexts[0].canvas.dispatchEvent(new Event('webglcontextrestored'));
    applyLayerEffects(source, 2, 2, effects, 0, b);
    assert.equal(effectRendererStats().backend, 'cpu'); assert.equal(contexts[0].draws, 1);
    clearEffectRendererCache();
    applyLayerEffects(source, 2, 2, effects, 0, b);
    assert.equal(effectRendererStats().backend, 'webgl'); assert.equal(contexts.length, 2); assert.equal(contexts[1].draws, 1);
  } finally {
    clearEffectRendererCache();
    if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original); else delete (globalThis as unknown as Record<string, unknown>).OffscreenCanvas;
  }
});
