import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { renderScene } from '../src/scene';
import { DEFAULT_TEXT_TRANSITION_DURATION, MAX_TEXT_TRANSITION_DURATION, MIN_TEXT_TRANSITION_DURATION,
  TEXT_TRANSITIONS, textTransitionAtTime, withTextTransition } from '../src/text-transition';
import type { Layer } from '../src/types';

const close = (actual: number, expected: number, message?: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} != ${expected}`);
const clip = (mode = 'fade', duration = .5): Pick<Layer, 'params' | 'start' | 'end'> => ({
  params: { textTransition: mode, textTransitionDuration: duration, fontSize: 48 }, start: 4, end: 10,
});

test('all seven modes have deterministic clip-relative fades and a fully visible middle', () => {
  assert.equal(TEXT_TRANSITIONS.length, 7);
  for (const mode of TEXT_TRANSITIONS) {
    const layer = clip(mode);
    for (const time of [3, 4, 4.125, 4.5, 6, 9.5, 9.875, 10, 11]) {
      const actual = textTransitionAtTime(layer, time);
      assert.deepEqual(actual, textTransitionAtTime(layer, time));
      const expected = mode === 'none' ? 1 : time <= 4 || time >= 10 ? 0 : time === 4.125 || time === 9.875 ? .15625 : 1;
      close(actual.opacity, expected, `${mode} at ${time}`);
    }
    const changedOrder = [9.875, 4.125, 6, 4, 10].map(time => textTransitionAtTime(layer, time));
    assert.deepEqual(changedOrder[0].opacity, changedOrder[1].opacity, 'seeking must not retain animation state');
  }
});

test('directional entrances and exits continue in the named direction while zoom remains centered', () => {
  for (const mode of TEXT_TRANSITIONS) {
    const entering = textTransitionAtTime(clip(mode), 4.25);
    const exiting = textTransitionAtTime(clip(mode), 9.75);
    const expected: Record<string, [number, number, number]> = {
      none: [0, 0, 1], fade: [0, 0, 1], 'fade-up': [0, 12, 1], 'fade-down': [0, -12, 1],
      'fade-left': [12, 0, 1], 'fade-right': [-12, 0, 1], 'fade-zoom': [0, 0, .97],
    };
    assert.deepEqual([entering.offsetX, entering.offsetY, entering.scale], expected[mode]);
    close(exiting.offsetX, -entering.offsetX); close(exiting.offsetY, -entering.offsetY); close(exiting.scale, entering.scale);
  }
  const small = clip('fade-up'); small.params.fontSize = 1;
  const large = clip('fade-up'); large.params.fontSize = 1000;
  close(textTransitionAtTime(small, 4).offsetY, 8);
  close(textTransitionAtTime(large, 4).offsetY, 60);
});

test('duration defaults and limits are safe and short clips have nonoverlapping transitions', () => {
  assert.deepEqual([MIN_TEXT_TRANSITION_DURATION, MAX_TEXT_TRANSITION_DURATION, DEFAULT_TEXT_TRANSITION_DURATION], [.05, 3, .5]);
  const missing = clip(); delete missing.params.textTransitionDuration;
  assert.equal(textTransitionAtTime(missing, 5).duration, .5);
  assert.equal(textTransitionAtTime(clip('fade', 999), 5).duration, 3);
  assert.equal(textTransitionAtTime(clip('fade', -3), 5).duration, .05);
  for (const mode of TEXT_TRANSITIONS.filter(value => value !== 'none')) {
    const short = clip(mode, 3); short.start = 2.1; short.end = 2.17;
    const midpoint = (short.start + short.end) / 2;
    close(textTransitionAtTime(short, midpoint).duration, .035);
    close(textTransitionAtTime(short, midpoint).opacity, 1);
    close(textTransitionAtTime(short, short.start).opacity, 0);
    close(textTransitionAtTime(short, short.end).opacity, 0);
    const state = textTransitionAtTime(short, short.start + .00875);
    close(state.opacity, .15625);
  }
});

test('malformed raw settings fall back safely without introducing NaN transforms', () => {
  const layer = clip(); layer.params.textTransition = 'unexpected';
  assert.equal(textTransitionAtTime(layer, 4).opacity, 1);
  assert.equal(textTransitionAtTime(layer, 4).mode, 'none');
  layer.params.textTransition = 'fade-up';
  for (const value of [NaN, Infinity, '2', true]) {
    layer.params.textTransitionDuration = value;
    assert.equal(textTransitionAtTime(layer, 4.25).duration, .5);
  }
  for (const value of [NaN, Infinity, '48', true]) {
    layer.params.fontSize = value;
    close(textTransitionAtTime(layer, 4.25).offsetY, 12);
  }
  assert.equal(textTransitionAtTime(layer, NaN).opacity, 0);
  layer.end = layer.start; assert.equal(textTransitionAtTime(layer, 4).opacity, 0);
  layer.end = Infinity; assert.equal(textTransitionAtTime(layer, 4).opacity, 0);
});

test('legacy and none modes preserve the direct paint path and animated scopes restore alpha on errors', () => {
  let saves = 0; let restores = 0; let paints = 0;
  let alpha = .6;
  const ctx = { get globalAlpha() { return alpha; }, set globalAlpha(value: number) { alpha = value; },
    save: () => { saves++; }, restore: () => { restores++; alpha = .6; },
    translate: () => assert.fail('a simple fade must not translate'), scale: () => assert.fail('a simple fade must not scale'),
  } as unknown as CanvasRenderingContext2D;
  const legacy = clip(); legacy.params = {};
  withTextTransition(ctx, legacy, 4, () => { paints++; assert.equal(ctx.globalAlpha, .6); });
  withTextTransition(ctx, clip('none'), 4, () => { paints++; });
  withTextTransition(ctx, clip('fade'), 6, () => { paints++; });
  assert.deepEqual([paints, saves, restores], [3, 0, 0]);
  withTextTransition(ctx, clip('fade'), 4, () => assert.fail('fully transparent text should not paint'));
  assert.throws(() => withTextTransition(ctx, clip('fade'), 4.25, () => {
    close(ctx.globalAlpha, .3); throw new Error('paint failure');
  }), /paint failure/);
  assert.deepEqual([saves, restores], [1, 1]);
  close(ctx.globalAlpha, .6);
});

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
type Draw = { text: string; alpha: number; matrix: Matrix; shadowOffsetX: number };
function recordedCanvas() {
  const drawn: Draw[] = []; const selections: { alpha: number; matrix: Matrix }[] = [];
  const state: Record<string, any> = { canvas: { width: 1920, height: 1080 }, globalAlpha: 1, font: '10px sans-serif',
    shadowOffsetX: 0, matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
  const stack: Record<string, any>[] = [];
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => stack.push({ ...target, matrix: { ...target.matrix } });
    if (key === 'restore') return () => { const previous = stack.pop()!; for (const name of Object.keys(target)) delete target[name]; Object.assign(target, previous); };
    if (key === 'getTransform') return () => ({ ...target.matrix });
    if (key === 'setTransform') return (a: number, b: number, c: number, d: number, e: number, f: number) => { target.matrix = { a, b, c, d, e, f }; };
    if (key === 'translate') return (x: number, y: number) => { const m = target.matrix; m.e += m.a * x + m.c * y; m.f += m.b * x + m.d * y; };
    if (key === 'rotate') return (angle: number) => {
      const m = target.matrix; const cos = Math.cos(angle); const sin = Math.sin(angle);
      target.matrix = { ...m, a: m.a * cos + m.c * sin, b: m.b * cos + m.d * sin, c: -m.a * sin + m.c * cos, d: -m.b * sin + m.d * cos };
    };
    if (key === 'scale') return (x: number, y: number) => { const m = target.matrix; m.a *= x; m.b *= x; m.c *= y; m.d *= y; };
    if (key === 'measureText') return (text: string) => ({ width: text.length * 20, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 20, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 40 });
    if (key === 'fillText') return (text: string) => drawn.push({ text, alpha: target.globalAlpha, matrix: { ...target.matrix }, shadowOffsetX: target.shadowOffsetX });
    if (key === 'strokeRect') return () => selections.push({ alpha: target.globalAlpha, matrix: { ...target.matrix } });
    return () => {};
  } }) as unknown as CanvasRenderingContext2D;
  return { ctx, drawn, selections, state, stack };
}

test('title, subtitle, text lines and glows share the transition while selection and later layers stay unchanged', () => {
  const { ctx, drawn, selections, state, stack } = recordedCanvas();
  const project = createDefaultProject(); project.title = 'main title'; project.artist = 'subtitle';
  const title = makeLayer('title'); title.opacity = .8; title.start = 4; title.end = 10;
  title.params = { ...title.params, textTransition: 'fade-up', textTransitionDuration: .5, fontSize: 48, glowEnabled: true, glowIntensity: 1 };
  const text = makeLayer('text'); text.opacity = .6; text.start = 4; text.end = 10;
  text.params = { ...text.params, text: 'first\nsecond', textTransition: 'fade-zoom', textTransitionDuration: .5, glowEnabled: true, glowIntensity: 1 };
  const marker = makeLayer('text'); marker.opacity = .4; marker.params = { ...marker.params, text: 'unaffected', textTransition: 'none' };
  project.layers = [title, text, marker];
  renderScene(ctx, project, 4.25, { cover: null, analysis: null }, { editor: true, selectionId: text.id });
  const body = (value: string) => drawn.find(item => item.text === value && item.shadowOffsetX === 0)!;
  const halo = (value: string) => drawn.find(item => item.text === value && item.shadowOffsetX > 0)!;
  close(body('main title').alpha, .4); close(body('subtitle').alpha, .4 * .54);
  close(body('first').alpha, .3); close(body('second').alpha, .3);
  close(body('unaffected').alpha, .4);
  close(body('main title').matrix.f, title.y + 12);
  close(body('subtitle').matrix.f, title.y + 12);
  for (const label of ['main title', 'subtitle', 'first', 'second']) {
    close(halo(label).alpha, body(label).alpha);
    close(halo(label).matrix.a, body(label).matrix.a);
    close(halo(label).matrix.f, body(label).matrix.f);
  }
  close(body('first').matrix.a, .97); close(body('second').matrix.d, .97);
  close(body('unaffected').matrix.a, 1); close(body('unaffected').matrix.f, marker.y);
  assert.equal(selections.length, 5, 'selection remains a rectangle with four handles');
  for (const selection of selections) {
    close(selection.alpha, 1); close(selection.matrix.a, 1); close(selection.matrix.d, 1);
    close(selection.matrix.e, text.x); close(selection.matrix.f, text.y);
  }
  close(state.globalAlpha, 1); assert.equal(stack.length, 0);
});

test('a fully transparent title keeps its rectangular editor selection visible', () => {
  const { ctx, drawn, selections } = recordedCanvas(); const project = createDefaultProject();
  const title = makeLayer('title'); title.start = 4; title.end = 10; title.rotation = 30;
  title.params.textTransition = 'fade-zoom'; project.layers = [title];
  renderScene(ctx, project, 4, { cover: null, analysis: null }, { editor: true, selectionId: title.id });
  assert.equal(drawn.length, 0); assert.equal(selections.length, 5);
  close(selections[0].matrix.a, Math.cos(Math.PI / 6));
  close(selections[0].matrix.b, Math.sin(Math.PI / 6));
  close(selections[0].alpha, 1);
});
