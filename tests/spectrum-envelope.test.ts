import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../src/audio-analysis';
import { drawSpectrumEnvelope, sampleSpectrumEnvelope } from '../src/spectrum-envelope';
import type { AudioAnalysis, Layer, LayerParams } from '../src/types';

const layer = (params: LayerParams = {}): Layer => ({ id: 'envelope-test', type: 'spectrum', name: '振幅包络',
  x: 320, y: 180, width: 640, height: 180, rotation: 0, opacity: .7,
  visible: true, locked: false, start: 0, end: 20, params });

function analysis(peak = .8): AudioAnalysis {
  return { duration: 20, hopSec: .02, bands: 64, sampleRate: 8000,
    frames: Array.from({ length: 1001 }, () => new Float32Array(64).fill(.5)),
    peaks: new Float32Array(1001).fill(peak), waveform: new Float32Array(200).fill(peak) };
}
const extent = (points: { y: number }[]): number => Math.max(...points.map(point => Math.abs(point.y)));

test('constant music forms one rounded silhouette with tapered ends and no flat top', () => {
  const shape = sampleSpectrumEnvelope(layer(), 4, analysis());
  for (const points of [shape.upper, shape.lower]) {
    assert.equal(points[0].y, 0); assert.equal(points.at(-1)!.y, 0);
    let changes = 0;
    for (let i = 2; i < points.length - 2; i++) {
      const before = Math.abs(points[i - 1].y) - Math.abs(points[i - 2].y);
      const after = Math.abs(points[i].y) - Math.abs(points[i - 1].y);
      if (before * after < 0) changes++;
      assert.ok(Math.abs(points[i].y - points[i - 1].y) < 3);
    }
    assert.equal(changes, 1);
    assert.ok(Math.abs(points[points.length >> 1].y) > Math.abs(points[(points.length >> 1) - 1].y));
  }
  assert.ok(extent(shape.upper) > extent(shape.lower));
  assert.deepEqual(shape, sampleSpectrumEnvelope(layer(), 7, analysis()));
});

test('silence and missing analysis stay flat, including source boundaries and zero gain', () => {
  for (const source of [null, analysis(0)]) for (const time of [0, .01, 4, 19.99, 20]) {
    const shape = sampleSpectrumEnvelope(layer(), time, source);
    assert.ok([...shape.upper, ...shape.lower].every(point => point.y === 0));
  }
  for (const time of [-1, 0, 20, 30]) assert.equal(extent(sampleSpectrumEnvelope(layer(), time, analysis()).upper), 0);
  assert.equal(extent(sampleSpectrumEnvelope(layer({ gain: 0 }), 4, analysis()).upper), 0);
});

test('real analysed quiet and loud recordings preserve their amplitude difference', async () => {
  async function tone(amplitude: number): Promise<AudioAnalysis> {
    const sampleRate = 8000;
    const signal = Float32Array.from({ length: sampleRate * 3 }, (_, i) => amplitude * Math.sin(i / sampleRate * 220 * Math.PI * 2));
    return analyzeAudio({ sampleRate, numberOfChannels: 1, length: signal.length,
      getChannelData: () => signal } as unknown as AudioBuffer);
  }
  const quiet = sampleSpectrumEnvelope(layer(), 1.5, await tone(.03));
  const loud = sampleSpectrumEnvelope(layer(), 1.5, await tone(.8));
  assert.ok(extent(loud.upper) > extent(quiet.upper) * 4);
});

test('an isolated transient moves left with audio time and the window changes the sampled interval', () => {
  const source = analysis(0);
  source.peaks.fill(.9, 250, 257); // 5.00–5.12 s.
  const component = layer({ smoothing: .4, envelopeWindow: 1.5 });
  const peakX = (time: number): number => {
    const points = sampleSpectrumEnvelope(component, time, source).upper;
    return points.reduce((best, point) => point.y < best.y ? point : best).x;
  };
  assert.ok(peakX(4.9) > 0); assert.ok(peakX(5.35) < 0);
  const narrow = sampleSpectrumEnvelope(layer({ envelopeWindow: .25 }), 4.6, source);
  const wide = sampleSpectrumEnvelope(layer({ envelopeWindow: 4 }), 4.6, source);
  assert.equal(extent(narrow.upper), 0); assert.ok(extent(wide.upper) > 5);
});

test('continuous frames, seeking, and source boundary easing remain deterministic and smooth', () => {
  const source = analysis(0);
  for (let i = 150; i < 450; i++) source.peaks[i] = .2 + .6 * Math.sin((i - 150) / 60) ** 2;
  const snapshot = sampleSpectrumEnvelope(layer(), 4.125, source);
  for (const time of [10, 1, 8, 4, 0, 19.9]) sampleSpectrumEnvelope(layer(), time, source);
  assert.deepEqual(snapshot, sampleSpectrumEnvelope(layer(), 4.125, source));
  let previous = sampleSpectrumEnvelope(layer(), 4, source).upper;
  for (let frame = 1; frame <= 60; frame++) {
    const next = sampleSpectrumEnvelope(layer(), 4 + frame / 60, source).upper;
    assert.ok(Math.max(...next.map((point, index) => Math.abs(point.y - previous[index].y))) < 6);
    previous = next;
  }
  const steady = analysis();
  assert.ok(extent(sampleSpectrumEnvelope(layer(), .002, steady).upper) < extent(sampleSpectrumEnvelope(layer(), .04, steady).upper));
  assert.ok(extent(sampleSpectrumEnvelope(layer(), 19.998, steady).upper) < extent(sampleSpectrumEnvelope(layer(), 19.96, steady).upper));
});

test('extreme parameters, malformed peaks and tiny components remain finite and stroke-safe', () => {
  const source = analysis(); source.peaks[100] = NaN; source.peaks[101] = Infinity;
  for (const width of [.2, 3, 120, 640]) for (const height of [.2, 3, 20, 180]) {
    for (const params of [{ gain: 1e6, barCount: 1e6, lineWidth: 50, envelopeWindow: 0, smoothing: 5 },
      { gain: NaN, barCount: Infinity, lineWidth: NaN, envelopeWindow: Infinity, smoothing: NaN }]) {
      const geometry = sampleSpectrumEnvelope({ ...layer(params), width, height }, 2, source);
      assert.ok(geometry.upper.length >= 65 && geometry.upper.length <= 513);
      for (const point of [...geometry.upper, ...geometry.lower]) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(Math.abs(point.x) + geometry.lineWidth / 2 <= width / 2 + 1e-8);
        assert.ok(Math.abs(point.y) + geometry.lineWidth / 2 <= height / 2 + 1e-8);
      }
    }
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.deepEqual(sampleSpectrumEnvelope({ ...layer(), width: value }, 2, source).upper, []);
    assert.deepEqual(sampleSpectrumEnvelope({ ...layer(), height: value }, 2, source).upper, []);
  }
  for (const time of [NaN, Infinity]) assert.deepEqual(sampleSpectrumEnvelope(layer(), time, source).upper, []);
});

function recordingCanvas() {
  const state: Record<string, unknown> = { strokeStyle: '#abc123', fillStyle: '#123456', globalAlpha: .37,
    lineWidth: 9, lineCap: 'butt', lineJoin: 'bevel', shadowBlur: 20, shadowColor: 'red', shadowOffsetX: 5, shadowOffsetY: 3, filter: 'blur(2px)' };
  const stack: Record<string, unknown>[] = [];
  const calls: { name: string; args: number[]; state: Record<string, unknown> }[] = [];
  const ctx = new Proxy(state, { get(target, key: string) {
    if (key in target) return target[key];
    if (key === 'save') return () => stack.push({ ...target });
    if (key === 'restore') return () => { for (const name of Object.keys(target)) delete target[name]; Object.assign(target, stack.pop()); };
    return (...args: number[]) => calls.push({ name: key, args, state: { ...target } });
  } }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, state, stack };
}

test('rendering uses one translucent fill and one shadow-free outline while preserving state', () => {
  const { ctx, calls, state, stack } = recordingCanvas(); const before = { ...state };
  drawSpectrumEnvelope(ctx, layer({ lineWidth: 4.5 }), 4.2, analysis());
  const fill = calls.filter(call => call.name === 'fill'); const stroke = calls.filter(call => call.name === 'stroke');
  assert.equal(fill.length, 1); assert.equal(stroke.length, 1);
  assert.equal(fill[0].state.globalAlpha, .37 * .18); assert.equal(stroke[0].state.globalAlpha, .37);
  assert.equal(stroke[0].state.lineWidth, 4.5);
  assert.equal(calls.filter(call => call.name === 'closePath').length, 1);
  for (const call of calls) {
    assert.equal(call.state.fillStyle, before.fillStyle); assert.equal(call.state.strokeStyle, before.strokeStyle);
    assert.equal(call.state.shadowBlur, 0); assert.equal(call.state.filter, 'none');
    assert.ok(call.args.every(Number.isFinite));
  }
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});

test('all cubic controls and rounded strokes stay inside the component bounds', () => {
  for (const width of [.2, 120]) for (const height of [.2, 20]) {
    const { ctx, calls } = recordingCanvas(); const component = { ...layer({ gain: 10, lineWidth: 8 }), width, height };
    drawSpectrumEnvelope(ctx, component, 4, analysis());
    for (const call of calls.filter(call => ['moveTo', 'bezierCurveTo'].includes(call.name))) {
      for (let i = 0; i < call.args.length; i += 2) {
        const pad = (call.state.lineWidth as number) / 2;
        assert.ok(Math.abs(call.args[i]) + pad <= width / 2 + 1e-8);
        assert.ok(Math.abs(call.args[i + 1]) + pad <= height / 2 + 1e-8);
      }
    }
  }
});

test('rendering restores canvas state if filling throws', () => {
  const { ctx, state, stack } = recordingCanvas();
  state.fill = () => { throw new Error('fill failure'); }; const before = { ...state };
  assert.throws(() => drawSpectrumEnvelope(ctx, layer(), 2, analysis()), /fill failure/);
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});
