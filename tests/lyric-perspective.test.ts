import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { renderScene, clearSceneCache } from '../src/scene';
import type { DemoProject } from '../src/types';

interface TextPaint { text: string; x: number; y: number; inkTop: number; inkBottom: number; font: string; synthesis: string; matrix: number[] }
interface PlanePaint { text: TextPaint; sourceTransform: number[]; strips: number[][]; destination: number[]; placement: number[]; density: number; opacity: number }
const near = (a: number, b: number, tolerance = 1e-8): void => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

function drawingContext() {
  const planes: PlanePaint[] = []; const created: any[] = []; const mainText: TextPaint[] = [];
  let measured = 0; let clips = 0;
  const owner: any = { body: { append() {} }, createElement: () => makeCanvas(false) };
  function makeCanvas(main: boolean): any {
    const declarations = new Map<string, string>([['font-synthesis', 'none']]);
    const style = { cssText: '', getPropertyValue: (key: string) => declarations.get(key) ?? '', getPropertyPriority: () => '',
      setProperty: (key: string, value: string) => declarations.set(key, value), removeProperty: (key: string) => declarations.delete(key) };
    const canvas: any = { width: main ? 1920 : 1, height: main ? 1080 : 1, style, dataset: {}, ownerDocument: owner, setAttribute() {}, remove() {} };
    const state: any = { canvas, font: '400 16px serif', globalAlpha: 1, globalCompositeOperation: 'source-over', textAlign: 'center', textBaseline: 'top',
      matrix: [1, 0, 0, 1, 0, 0], filter: 'none', shadowColor: '#00000000', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 };
    const stack: any[] = []; const texts: TextPaint[] = []; const strips: number[][] = [];
    const methods: any = {
      save: () => stack.push({ ...state, matrix: [...state.matrix] }), restore: () => Object.assign(state, stack.pop()),
      setTransform: (...matrix: number[]) => { state.matrix = matrix; },
      translate: (x: number, y: number) => { const m = state.matrix; state.matrix = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y]; },
      rotate: (angle: number) => { const m = state.matrix, c = Math.cos(angle), s = Math.sin(angle); state.matrix = [m[0]*c+m[2]*s, m[1]*c+m[3]*s, m[2]*c-m[0]*s, m[3]*c-m[1]*s, m[4], m[5]]; },
      scale: (x: number, y: number) => { const m = state.matrix; state.matrix = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]]; },
      getTransform: () => Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => [key, state.matrix[i]])),
      getLineDash: () => [],
      clearRect: () => { texts.length = 0; strips.length = 0; },
      clip: () => { if (main) clips++; },
      measureText: (text: string) => {
        measured++;
        const size = Number(/([\d.]+)px/.exec(state.font)?.[1]) || 16;
        const width = size * .8 * [...text].length; const ink = width - size * .1;
        const align = state.textAlign === 'center' ? .5 : state.textAlign === 'right' ? 1 : 0;
        return { width, actualBoundingBoxLeft: width * align - size * .05, actualBoundingBoxRight: ink - width * align + size * .05,
          actualBoundingBoxAscent: -size * .16, actualBoundingBoxDescent: size * .94 };
      },
      fillText: (text: string, x: number, y: number) => {
        const size = Number(/([\d.]+)px/.exec(state.font)?.[1]) || 16;
        const paint = { text, x, y, inkTop: y + size * .16, inkBottom: y + size * .94,
          font: state.font, synthesis: style.getPropertyValue('font-synthesis'), matrix: [...state.matrix] };
        texts.push(paint); if (main) mainText.push(paint);
      },
      drawImage: (image: any, ...args: number[]) => {
        if (main) {
          const source = image.context.strips.length ? image.source : undefined;
          if (source) planes.push({ text: { ...source.context.texts.at(-1) }, sourceTransform: [...source.context.texts.at(-1).matrix],
            strips: image.context.strips.map((strip: number[]) => [...strip]), destination: [...args], placement: [...state.matrix], density: image.width / args[2], opacity: state.globalAlpha });
        } else { strips.push(args); canvas.source = image; }
      },
    };
    const context = new Proxy(state, { get(target, key: string) {
      if (key === 'texts') return texts; if (key === 'strips') return strips; if (key === 'state') return state;
      return key in target ? target[key] : methods[key] ?? (() => {});
    } });
    canvas.context = context; canvas.getContext = () => context;
    if (!main) created.push(canvas);
    return canvas;
  }
  const canvas = makeCanvas(true);
  return { ctx: canvas.context as CanvasRenderingContext2D, planes, created, mainText, measurementCount: () => measured, clipCount: () => clips };
}

function project(): DemoProject {
  const p = createDefaultProject(); const layer = makeLayer('lyrics'); layer.width = 1100; layer.height = 900;
  layer.params = { ...layer.params, mode: 'scroll', lines: 3, planeYaw: 45, planePerspective: 72,
    fontSize: 80, translationSize: 30, inactiveFontSize: 32, inactiveTranslationSize: 18,
    activeShadowEnabled: false, inactiveShadowEnabled: false, activeOpacity: .8, inactiveOpacity: .3 };
  p.layers = [layer]; p.lyrics = [0, 5, 10].map(time => ({ time, text: '共用朝向', translation: 'same plane' }));
  return p;
}

/** Recover the visible glyph midline from the drawn ink box and column geometry.
 * Canvas's top baseline is not a visible line and masked the old cy/W error. */
function inkCenterSlope(plane: PlanePaint, fraction = .5): number {
  const rows = plane.strips.filter(row => row[6] > 0);
  const points = [rows[Math.floor(rows.length / 4)], rows[Math.floor(rows.length * 3 / 4)]].map(row => {
    const sourceMiddle = plane.sourceTransform[3] * (plane.text.inkTop + fraction * (plane.text.inkBottom - plane.text.inkTop)) + plane.sourceTransform[5];
    const y = plane.destination[1] + (row[5] + (sourceMiddle - row[1]) / row[3] * row[7]) / plane.density;
    const x = plane.destination[0] + (row[4] + row[6] / 2) / plane.density;
    return { x, y };
  });
  return (points[1].y - points[0].y) / (points[1].x - points[0].x);
}

/** Recover centre foreshortening and depth from the actual sampled columns.
 * A line camera is normalized to its own visible width, so compare depth at
 * corresponding endpoints rather than comparing project-pixel gradients. */
function cameraField(plane: PlanePaint) {
  const rows = plane.strips.filter(row => row[6] > 0);
  const a = rows[Math.floor(rows.length / 4)]; const b = rows[Math.floor(rows.length * 3 / 4)];
  const projectedX = (row: number[]) => plane.destination[0] + (row[4] + row[6] / 2) / plane.density;
  const gradient = (a[7] / a[3] - b[7] / b[3]) / (projectedX(b) - projectedX(a));
  const edge = rows.find(row => Math.abs((row[0] - plane.sourceTransform[4]) / plane.sourceTransform[0]) > 1e-5)!;
  const sourceX = (edge[0] - plane.sourceTransform[4]) / plane.sourceTransform[0];
  const outputX = plane.destination[0] + edge[4] / plane.density;
  const cosine = outputX / (sourceX * (1 - gradient * outputX));
  const depth = gradient * cosine;
  return { gradient, cosine, depth, origin: plane.placement[4],
    at: (x: number, y: number) => {
      const denominator = 1 + depth * x;
      return { horizontal: cosine / denominator ** 2, vertical: 1 / denominator,
        slope: inkCenterSlope(plane) - gradient * y };
    } };
}

const visibleSlope = (yaw: number): number => -Math.tan(Math.PI / 12) * Math.tan(yaw * Math.PI / 180);
const inkWidth = (plane: PlanePaint): number => {
  const size = Number(/([\d.]+)px/.exec(plane.text.font)![1]);
  return Math.max(1, size * (.8 * [...plane.text.text].length - .1));
};
function assertLineCamera(plane: PlanePaint, yaw: number, perspective: number): void {
  const field = cameraField(plane), width = inkWidth(plane);
  const q = Math.sin(yaw * Math.PI / 180) * perspective / (100 + perspective);
  near(inkCenterSlope(plane), visibleSlope(yaw), 1e-7);
  near(field.cosine, Math.cos(yaw * Math.PI / 180), 1e-7);
  near(field.depth * width / 2, q, 1e-7);
  near(field.at(0, 0).horizontal, Math.cos(yaw * Math.PI / 180), 1e-7);
  near(field.at(0, 0).vertical, 1, 1e-7);
  near(field.at(-width / 2, 0).vertical / field.at(width / 2, 0).vertical, (1 + q) / (1 - q), 1e-7);
}

test('lyric originals/translations and independent active/inactive sizes retain one visible midline orientation', () => {
  const p = project(); const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
  assert.equal(fake.planes.length, 6, 'each original and translated line receives its own plane');
  fake.planes.forEach(plane => assertLineCamera(plane, 45, 72));
  for (const size of [80, 32, 30, 18]) assert.ok(fake.planes.some(plane => plane.text.font.includes(`${size}px`)));
  assert.deepEqual(fake.planes.map(plane => plane.opacity), [.3, .3, .8, .8, .3, .3], 'state opacity is applied once after projecting');
  assert.equal(fake.created.length, 2, 'successive lines reuse one bounded scratch pair');
});

test('scrolling, cue switches and text alignment cannot change midline angle or normalized near/far scale', () => {
  for (const align of ['left', 'center', 'right']) for (const time of [5.01, 5.2, 6, 10.01, 10.2]) {
    const p = project(); p.layers[0].params.align = align;
    const fake = drawingContext(); renderScene(fake.ctx, p, time, { cover: null, analysis: null });
    assert.equal(fake.planes.length, 6);
    fake.planes.forEach(plane => assertLineCamera(plane, 45, 72));
  }
});

test('projected source re-resolves each independent font synthesis after fitting', () => {
  const p = project(); Object.assign(p.layers[0].params, { activeFontWeight: 900, activeItalic: true, activeTranslationFontWeight: 300,
    inactiveFontWeight: 200, inactiveTranslationFontWeight: 700, inactiveTranslationItalic: true });
  const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
  const [previous, previousTranslation, current, currentTranslation] = fake.planes.map(plane => plane.text);
  assert.match(previous.font, /^200 32px /); assert.equal(previous.synthesis, 'weight');
  assert.match(previousTranslation.font, /^italic 700 18px /); assert.equal(previousTranslation.synthesis, 'weight style');
  assert.match(current.font, /^italic 900 80px /); assert.equal(current.synthesis, 'weight style');
  assert.match(currentTranslation.font, /^300 30px /); assert.equal(currentTranslation.synthesis, 'weight');
  assert.equal((fake.ctx.canvas as HTMLCanvasElement).style.getPropertyValue('font-synthesis'), 'none');
  fake.created.forEach(canvas => assert.equal(canvas.style.getPropertyValue('font-synthesis'), 'none'));
});

test('zero yaw preserves direct legacy painting and measurement without scratch allocation', () => {
  for (const yaw of [undefined, 0]) {
    const p = project();
    if (yaw === undefined) delete p.layers[0].params.planeYaw;
    else p.layers[0].params.planeYaw = yaw;
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    assert.equal(fake.created.length, 0); assert.equal(fake.planes.length, 0); assert.equal(fake.mainText.length, 6);
    assert.equal(fake.measurementCount(), 6, 'only the legacy fitted-font measurement runs');
    assert.equal(fake.clipCount(), 0, 'visible rows are not masked by the unchanged rectangular editor selection');
    assert.deepEqual(fake.mainText.map(paint => paint.x), [0, 0, 0, 0, 0, 0]);
  }
});

test('single-character extreme glow and shadow padding stays finite without changing its line camera', () => {
  const p = project(); p.lyrics = [{ time: 0, text: '字' }]; p.layers[0].params = { ...p.layers[0].params, planeYaw: -75, planePerspective: 100,
    mode: 'single', fontSize: 8, glowEnabled: true, glowIntensity: 2, glowRadius: 80,
    activeStrokeWidth: 30, activeShadowEnabled: true, activeShadowBlur: 100, activeShadowX: 100, activeShadowY: -100 };
  const fake = drawingContext(); renderScene(fake.ctx, p, 1, { cover: null, analysis: null });
  assert.equal(fake.planes.length, 1);
  assertLineCamera(fake.planes[0], -75, 100);
  fake.created.forEach(canvas => {
    assert.ok(canvas.width <= 4096 && canvas.height <= 4096 && canvas.width * canvas.height <= 4 * 1024 * 1024);
    canvas.context.strips.forEach((row: number[]) => assert.ok(row.every(Number.isFinite)));
  });
});

test('sentence length and independent font sizes preserve midline angle and endpoint scale ratio', () => {
  const p = project();
  p.lyrics = [{ time: 0, text: '短句', translation: 'A long translated sentence' },
    { time: 5, text: '这是一句更长的歌词', translation: 'Hi' },
    { time: 10, text: '字', translation: 'A different line with many words' }];
  for (const time of [1, 6, 11]) {
    const fake = drawingContext(); renderScene(fake.ctx, p, time, { cover: null, analysis: null });
    assert.equal(fake.planes.length, 6);
    fake.planes.forEach(plane => assertLineCamera(plane, 45, 72));
  }
});

test('perspective strength changes true near/far scale while leaving yaw foreshortening and midline angle fixed', () => {
  for (const yaw of [-75, -45, 45, 75]) {
    let lastRatio = 1;
    for (const perspective of [0, 25, 50, 100, 150, 200, 300]) {
      const p = project(); Object.assign(p.layers[0].params, { planeYaw: yaw, planePerspective: perspective });
      const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
      fake.planes.forEach(plane => assertLineCamera(plane, yaw, perspective));
      const field = cameraField(fake.planes[0]), width = inkWidth(fake.planes[0]);
      const scales = [-width / 2, width / 2].map(x => field.at(x, 0).vertical);
      const ratio = Math.max(...scales) / Math.min(...scales);
      assert.ok(ratio >= lastRatio - 1e-8, 'the near/far size ratio increases monotonically'); lastRatio = ratio;
      if (perspective === 300) assert.ok(ratio > 3, 'maximum strength visibly enlarges the near side');
    }
  }
});

test('line-local width normalization survives font sizes, alignments, yaw signs and fitted long sentences', () => {
  for (const yaw of [-75, -45, 45, 75]) for (const perspective of [0, 80, 100, 300]) for (const align of ['left', 'center', 'right']) {
    const p = project(); Object.assign(p.layers[0].params, { planeYaw: yaw, planePerspective: perspective, align });
    p.lyrics = [{ time: 0, text: '字', translation: 'A longer sentence' },
      { time: 5, text: '这是比较长的一句歌词', translation: 'Hi' }, { time: 10, text: '短句', translation: 'One more line' }];
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    assert.equal(fake.planes.length, 6);
    fake.planes.forEach(plane => assertLineCamera(plane, yaw, perspective));
    if (perspective > 0) assert.ok(Math.abs(inkCenterSlope(fake.planes[0], 0) - inkCenterSlope(fake.planes[0], 1)) > .001,
      'a real perspective line has converging upper/lower edges rather than an affine-only slant');
  }
});

test('changing cue lengths and playback styles cannot dilute the normalized camera during scrolling or cue switches', () => {
  const p = project(); Object.assign(p.layers[0].params, { planeYaw: -55, planePerspective: 300 });
  p.lyrics = [{ time: 0, text: 'H' }, { time: 5, text: 'HHHHHHHHHH' }, { time: 10, text: 'HHH' }];
  for (const time of [1, 5.01, 5.2, 6, 10.01, 10.2, 11]) {
    const fake = drawingContext(); renderScene(fake.ctx, p, time, { cover: null, analysis: null });
    fake.planes.forEach(plane => assertLineCamera(plane, -55, 300));
  }
});

test('different-sized lyric midlines retain one direction after layer rotation and font fitting', () => {
  for (const rotation of [-35, 0, 25]) for (const yaw of [-65, 65]) {
    const p = project(); p.layers[0].rotation = rotation;
    Object.assign(p.layers[0].params, { planeYaw: yaw, planePerspective: 300, fontSize: 250, inactiveFontSize: 48 });
    p.lyrics[1].text = 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    const expected = rotation * Math.PI / 180 + Math.atan(visibleSlope(yaw));
    for (const plane of fake.planes) {
      assertLineCamera(plane, yaw, 300);
      const m = plane.placement, slope = inkCenterSlope(plane);
      near(Math.atan2(m[1] + m[3] * slope, m[0] + m[2] * slope), expected);
    }
  }
});

test('hidden long and punctuation cues cannot change visible projection or increase per-frame measurement work', () => {
  const p = project(); p.layers[0].params.planePerspective = 300;
  const capture = () => {
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    return { measured: fake.measurementCount(), cameras: fake.planes.map(plane => ({
      text: plane.text.text, cosine: cameraField(plane).cosine, depth: cameraField(plane).depth,
      slope: inkCenterSlope(plane), source: plane.sourceTransform, destination: plane.destination, strips: plane.strips })) };
  };
  const before = capture();
  p.lyrics = [...p.lyrics, ...Array.from({ length: 1000 }, (_, index) => ({ time: 100 + index * 5,
    text: index % 2 ? '。'.repeat(200) : 'A very long hidden line '.repeat(40), translation: '…'.repeat(200) }))];
  const after = capture();
  assert.deepEqual(after.cameras, before.cameras, 'off-screen cues cannot set or dilute a visible line camera');
  assert.equal(before.measured, 12); assert.equal(after.measured, 12, 'measurement work depends on six visible lines, not song length');
  clearSceneCache(); assert.equal(capture().measured, 12, 'clearing scene caches does not trigger whole-song calibration');
});

test('left/right visible text edges remain anchored after line-width-normalized perspective', () => {
  for (const align of ['left', 'right']) for (const yaw of [-65, 65]) {
    const p = project(); Object.assign(p.layers[0].params, { align, planeYaw: yaw, planePerspective: 300 });
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    for (const plane of fake.planes) {
      const field = cameraField(plane), size = Number(/([\d.]+)px/.exec(plane.text.font)![1]);
      const sourceEdge = (align === 'left' ? -1 : 1) * inkWidth(plane) / 2;
      const actual = plane.placement[4] + field.cosine * sourceEdge / (1 + field.depth * sourceEdge);
      const expected = p.layers[0].x + (align === 'left' ? -1 : 1) * (p.layers[0].width / 2 - 12 - size * .05);
      near(actual, expected, 1e-7);
    }
  }
});

test('turned lyrics paint complete first/last rows outside the logical selection rectangle', () => {
  for (const yaw of [-65, 65]) {
    const p = project(); p.layers[0].height = 40;
    Object.assign(p.layers[0].params, { planeYaw: yaw, planePerspective: 300 });
    const fake = drawingContext(); renderScene(fake.ctx, p, 6, { cover: null, analysis: null });
    assert.equal(fake.planes.length, 6);
    assert.equal(fake.clipCount(), 0, 'turned lyrics cannot be clipped to the unchanged rectangular editor selection');
    const top = p.layers[0].y - p.layers[0].height / 2, bottom = p.layers[0].y + p.layers[0].height / 2;
    assert.ok(fake.planes.some(plane => plane.placement[5] + plane.destination[1] < top));
    assert.ok(fake.planes.some(plane => plane.placement[5] + plane.destination[1] + plane.destination[3] > bottom));
  }
});
