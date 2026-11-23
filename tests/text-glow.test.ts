import test from 'node:test';
import assert from 'node:assert/strict';
import { paintTextGlow, resolveTextGlow } from '../src/text-glow';
import type { LayerParams } from '../src/types';

test('glow is opt-in and resolves bounded independent controls', () => {
  assert.deepEqual(resolveTextGlow({}), { enabled: false, color: '#ffffff', intensity: 1, radius: 18 });
  assert.deepEqual(resolveTextGlow({ glowEnabled: true, glowColor: '#aBc012', glowIntensity: 9, glowRadius: -1 }),
    { enabled: true, color: '#aBc012', intensity: 2, radius: 0 });
  assert.deepEqual(resolveTextGlow({ glowEnabled: 'true', glowColor: 'invalid', glowIntensity: NaN, glowRadius: Infinity }),
    { enabled: false, color: '#ffffff', intensity: 1, radius: 18 });
});

function fakeContext() {
  const calls: { kind: string; alpha: number; matrix: number[]; args: unknown[] }[] = [];
  const stack: Record<string, any>[] = [];
  const initial = { a: .8, b: .6, c: -.6, d: .8, e: 160, f: 90 };
  const state: Record<string, any> = { globalAlpha: .24, font: 'italic 700 40px serif', textAlign: 'center', direction: 'ltr',
    filter: 'blur(3px)', shadowColor: '#111111', shadowBlur: 4, shadowOffsetX: 5, shadowOffsetY: 9, fillStyle: '#abcdef',
    strokeStyle: '#123456', lineWidth: 3, matrix: Object.values(initial) };
  Object.assign(state, {
    save: () => { stack.push({ ...state, matrix: [...state.matrix] }); },
    restore: () => { Object.assign(state, stack.pop()); },
    getTransform: () => initial,
    setTransform: (...values: number[]) => { state.matrix = values; },
    measureText: () => ({ width: 120, actualBoundingBoxLeft: 63, actualBoundingBoxRight: 65, actualBoundingBoxAscent: 32, actualBoundingBoxDescent: 7 }),
    fillText: (...args: unknown[]) => { calls.push({ kind: 'fill', alpha: state.globalAlpha, matrix: [...state.matrix], args }); },
    strokeText: (...args: unknown[]) => { calls.push({ kind: 'stroke', alpha: state.globalAlpha, matrix: [...state.matrix], args }); },
  });
  return { ctx: state as unknown as CanvasRenderingContext2D, state, calls };
}

test('disabled, zero strength and zero radius never access or repaint text', () => {
  const ctx = new Proxy({}, { get: () => { throw new Error('disabled glow touched canvas'); } }) as CanvasRenderingContext2D;
  const options: LayerParams[] = [{}, { glowEnabled: true, glowIntensity: 0 }, { glowEnabled: true, glowRadius: 0 }];
  for (const params of options) {
    paintTextGlow(ctx, '旧项目', 0, 0, resolveTextGlow(params));
  }
});

test('halo moves source glyphs offscreen while preserving font, alpha and all caller state', () => {
  const { ctx, state, calls } = fakeContext();
  const before = { ...state, matrix: [...state.matrix] };
  paintTextGlow(ctx, 'Light 光', 3, 7, resolveTextGlow({ glowEnabled: true, glowColor: '#ff0088', glowIntensity: 1.5 }), 2, 95);
  assert.deepEqual(calls.map(call => call.kind), ['fill', 'stroke', 'fill', 'stroke']);
  assert.deepEqual(calls.map(call => call.alpha), [.24, .24, .12, .12]);
  assert.ok(calls.every(call => call.matrix[4] < -150), 'original text is displaced outside the canvas');
  assert.ok(calls.every(call => call.args[3] === 95), 'optional maximum width applies equally to fill and outline');
  assert.deepEqual(state, before, 'no shadow, alpha, font, transform or filter leaks into another line');
});

test('context state is restored even if the underlying text renderer throws', () => {
  const { ctx, state } = fakeContext();
  state.fillText = () => { throw new Error('draw failed'); };
  const before = { ...state, matrix: [...state.matrix] };
  assert.throws(() => paintTextGlow(ctx, 'text', 0, 0, resolveTextGlow({ glowEnabled: true })), /draw failed/);
  assert.deepEqual(state, before);
});
