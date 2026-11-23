import test from 'node:test';
import assert from 'node:assert/strict';
import { clampTrackHeight, DEFAULT_AUDIO_TRACK_HEIGHT, DEFAULT_TRACK_HEIGHT,
  MAX_TIMELINE_ZOOM, MAX_TRACK_HEIGHT, MIN_TIMELINE_ZOOM, MIN_TRACK_HEIGHT,
  normalizeTrackHeights, reorderTimelineLayer, zoomTimelineAtCursor } from '../src/timeline-layout';
import type { Layer } from '../src/types';

const layer = (id: string, locked = false): Layer => ({ id, locked, type: 'text', name: id,
  x: 0, y: 0, width: 100, height: 40, rotation: 0, opacity: 1, visible: true,
  start: 0, end: 10, params: { text: id } });
const ids = (layers: Layer[]) => layers.map(item => item.id);
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('track heights use pixel bounds, rounding and finite defaults', () => {
  assert.equal(DEFAULT_TRACK_HEIGHT, 24); assert.equal(DEFAULT_AUDIO_TRACK_HEIGHT, 36);
  assert.equal(clampTrackHeight(1), MIN_TRACK_HEIGHT);
  assert.equal(clampTrackHeight(999), MAX_TRACK_HEIGHT);
  assert.equal(clampTrackHeight(40.7), 41);
  assert.equal(clampTrackHeight(NaN, 70), 70);
  assert.equal(clampTrackHeight(Infinity, Infinity), DEFAULT_TRACK_HEIGHT);
  assert.equal(clampTrackHeight(NaN, -20), MIN_TRACK_HEIGHT);
});

test('local height preferences sanitize input without invoking accessors or inheriting prototype properties', () => {
  for (const invalid of [null, undefined, 12, 'bad', [], false]) assert.deepEqual(normalizeTrackHeights(invalid), {});
  const raw = Object.assign(Object.create({ inherited: 80 }), JSON.parse('{"__proto__":88,"prototype":90,"constructor":90,"__audio__":36,"top":50.8,"small":-10,"large":999}'));
  raw.nan = NaN; raw.inf = Infinity; raw.numericString = '35'; raw.bool = true; raw[''] = 60;
  Object.defineProperty(raw, 'accessor', { enumerable: true, get() { throw new Error('must not invoke preferences getter'); } });
  assert.deepEqual(normalizeTrackHeights(raw), { __audio__: 36, top: 51, small: 24, large: 160 });
  assert.equal(Object.getPrototypeOf(normalizeTrackHeights(raw)), Object.prototype);
});

test('height preferences have a bounded count and do not mutate their input', () => {
  const raw = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`layer-${i}`, 32 + i % 7]));
  const before = structuredClone(raw); const normalized = normalizeTrackHeights(raw);
  assert.equal(Object.keys(normalized).length, 2000); assert.deepEqual(raw, before);
});

test('track insertion uses screen order while preserving the render-order convention', () => {
  const layers = [layer('bottom'), layer('middle'), layer('top')];
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'bottom', 'top', 'before')), ['middle', 'top', 'bottom']);
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'top', 'bottom', 'after')), ['top', 'bottom', 'middle']);
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'bottom', 'top', 'after')), ['middle', 'bottom', 'top']);
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'top', 'bottom', 'before')), ['bottom', 'top', 'middle']);
});

test('reordering inserts only once, keeps object identity, and never edits layer data', () => {
  const layers = [layer('a'), layer('b'), layer('c'), layer('d')]; const snapshot = structuredClone(layers);
  for (const source of layers) for (const target of layers) for (const placement of ['before', 'after'] as const) {
    const reordered = reorderTimelineLayer(layers, source.id, target.id, placement);
    assert.equal(reordered.length, layers.length); assert.equal(new Set(reordered).size, layers.length);
    assert.ok(reordered.every(item => layers.includes(item)));
    if (source !== target) {
      const visible = reordered.slice().reverse();
      assert.equal(visible.indexOf(source) - visible.indexOf(target), placement === 'before' ? -1 : 1);
    }
  }
  assert.deepEqual(layers, snapshot);
});

test('locked sources cannot move, locked targets can be crossed, and no-ops preserve the array', () => {
  const layers = [layer('a'), layer('b', true), layer('c')];
  assert.equal(reorderTimelineLayer(layers, 'b', 'c', 'before'), layers);
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'a', 'b', 'before')), ['b', 'a', 'c']);
  assert.deepEqual(ids(reorderTimelineLayer(layers, 'c', 'b', 'after')), ['a', 'c', 'b']);
  assert.equal(reorderTimelineLayer(layers, 'a', 'a', 'before'), layers);
  assert.equal(reorderTimelineLayer(layers, 'a', 'b', 'after'), layers);
  assert.equal(reorderTimelineLayer(layers, 'c', 'b', 'before'), layers);
  assert.equal(reorderTimelineLayer(layers, 'missing', 'b', 'before'), layers);
  assert.equal(reorderTimelineLayer(layers, 'a', 'missing', 'before'), layers);
  assert.equal(reorderTimelineLayer([], 'a', 'b', 'before').length, 0);
});

const zoomBase = { zoom: 2, deltaY: -120, deltaMode: 0, clientX: 530, viewportLeft: 30,
  viewportWidth: 800, scrollLeft: 300, labelWidth: 150 };

test('Alt wheel zooms in/out continuously and anchors the exact timeline time under the cursor', () => {
  for (const labelWidth of [0, 88, 150, 240]) {
    const input = { ...zoomBase, labelWidth }; const result = zoomTimelineAtCursor(input);
    assert.ok(result.zoom > input.zoom && result.zoom < MAX_TIMELINE_ZOOM);
    const offset = input.clientX - input.viewportLeft - labelWidth;
    close((input.scrollLeft + offset) / (input.viewportWidth * input.zoom - labelWidth),
      (result.scrollLeft + offset) / (input.viewportWidth * result.zoom - labelWidth));
    const reverse = zoomTimelineAtCursor({ ...input, ...result, deltaY: -input.deltaY });
    close(reverse.zoom, input.zoom); close(reverse.scrollLeft, input.scrollLeft);
  }
  assert.ok(zoomTimelineAtCursor({ ...zoomBase, deltaY: 120 }).zoom < zoomBase.zoom);
  assert.notEqual(zoomTimelineAtCursor({ ...zoomBase, deltaY: -1 }).zoom, zoomBase.zoom);
});

test('wheel line and page delta modes match their CSS-pixel equivalents', () => {
  assert.deepEqual(zoomTimelineAtCursor({ ...zoomBase, deltaY: -2, deltaMode: 1 }),
    zoomTimelineAtCursor({ ...zoomBase, deltaY: -32, deltaMode: 0 }));
  assert.deepEqual(zoomTimelineAtCursor({ ...zoomBase, deltaY: -.1, deltaMode: 2 }),
    zoomTimelineAtCursor({ ...zoomBase, deltaY: -80, deltaMode: 0 }));
});

test('wheel over the sticky labels anchors the visible time-area left edge', () => {
  const input = { ...zoomBase, clientX: zoomBase.viewportLeft + 20 }; const result = zoomTimelineAtCursor(input);
  close(input.scrollLeft / (input.viewportWidth * input.zoom - input.labelWidth),
    result.scrollLeft / (input.viewportWidth * result.zoom - input.labelWidth));
  assert.deepEqual(result, zoomTimelineAtCursor({ ...input, clientX: input.viewportLeft + input.labelWidth }));
});

test('zoom bounds and scroll bounds hold at timeline ends and extreme wheel deltas', () => {
  const maxed = zoomTimelineAtCursor({ ...zoomBase, deltaY: -Number.MAX_VALUE, scrollLeft: 999999 });
  assert.equal(maxed.zoom, MAX_TIMELINE_ZOOM);
  assert.ok(maxed.scrollLeft >= 0 && maxed.scrollLeft <= zoomBase.viewportWidth * (maxed.zoom - 1));
  const minned = zoomTimelineAtCursor({ ...zoomBase, deltaY: Number.MAX_VALUE });
  assert.deepEqual(minned, { zoom: MIN_TIMELINE_ZOOM, scrollLeft: 0 });
  assert.equal(zoomTimelineAtCursor({ ...zoomBase, zoom: 5, scrollLeft: 3200, clientX: 830, deltaY: -50 }).scrollLeft, 3200);
  assert.equal(zoomTimelineAtCursor({ ...zoomBase, scrollLeft: 0, clientX: 180 }).scrollLeft, 0);
  assert.deepEqual(zoomTimelineAtCursor({ ...zoomBase, deltaY: 0 }), { zoom: 2, scrollLeft: 300 });
});

test('invalid wheel/layout inputs never produce non-finite or negative outputs', () => {
  for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) for (const key of Object.keys(zoomBase) as (keyof typeof zoomBase)[]) {
    const result = zoomTimelineAtCursor({ ...zoomBase, [key]: invalid });
    assert.ok(Number.isFinite(result.zoom) && result.zoom >= 1 && result.zoom <= 5, key);
    assert.ok(Number.isFinite(result.scrollLeft) && result.scrollLeft >= 0, key);
  }
  assert.equal(zoomTimelineAtCursor({ ...zoomBase, viewportWidth: 0 }).scrollLeft, 0);
  assert.equal(zoomTimelineAtCursor({ ...zoomBase, viewportWidth: -1 }).scrollLeft, 0);
  assert.equal(zoomTimelineAtCursor({ ...zoomBase, labelWidth: 800, zoom: 1 }).scrollLeft, 0);
});
