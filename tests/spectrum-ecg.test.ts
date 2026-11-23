import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSpectrumEcg, sampleSpectrumEcg } from '../src/spectrum-ecg';
import type { AudioAnalysis, Layer, LayerParams } from '../src/types';

const layer = (params: LayerParams = {}): Layer => ({ id: 'ecg-test', type: 'spectrum', name: '心电单曲线',
  x: 320, y: 180, width: 640, height: 180, rotation: 0, opacity: .7,
  visible: true, locked: false, start: 0, end: 10, params });
function analysis(peak = 0): AudioAnalysis {
  return { duration: 10, hopSec: .02, bands: 64, sampleRate: 8000,
    frames: Array.from({ length: 501 }, () => new Float32Array(64).fill(.5)),
    peaks: new Float32Array(501).fill(peak), waveform: new Float32Array(200).fill(peak) };
}
function transient(start = 2, amplitude = .9): AudioAnalysis {
  const source = analysis(); source.peaks.fill(amplitude, Math.round(start / .02), Math.round(start / .02) + 5); return source;
}
const extent = (points: { y: number }[]): number => Math.max(...points.map(point => Math.abs(point.y)));

test('a musical transient makes a single trace with a sharp upward/downward excursion and quiet shoulders', () => {
  const { points } = sampleSpectrumEcg(layer(), 2.7, transient());
  assert.ok(Math.min(...points.map(point => point.y)) < -30);
  assert.ok(Math.max(...points.map(point => point.y)) > 15);
  assert.ok(points.filter(point => Math.abs(point.y) < 2).length > points.length * .70, 'most of the trace stays calm between transients');
  assert.equal(points[0].y, 0); assert.equal(points.at(-1)!.y, 0);
  for (let i = 1; i < points.length; i++) assert.ok(points[i].x > points[i - 1].x);
});

test('missing/silent audio, zero gain and invalid source times stay exactly flat', () => {
  for (const source of [null, analysis()]) for (const time of [0, .02, 4, 9.99, 10]) {
    assert.ok(sampleSpectrumEcg(layer(), time, source).points.every(point => point.y === 0));
  }
  for (const time of [-1, 10, 11]) assert.equal(extent(sampleSpectrumEcg(layer(), time, analysis(.8)).points), 0);
  assert.equal(extent(sampleSpectrumEcg(layer({ gain: 0 }), 2.7, transient()).points), 0);
});

test('the first audio interval is retained, quiet recordings remain quieter, sustained notes invent no large heartbeat', () => {
  const firstInterval = analysis(); firstInterval.peaks[0] = .9;
  assert.ok(extent(sampleSpectrumEcg(layer(), .16, firstInterval).points) > 15, 'first-frame-only audio is not discarded');
  const quiet = extent(sampleSpectrumEcg(layer(), 2.7, transient(2, .03)).points);
  const loud = extent(sampleSpectrumEcg(layer(), 2.7, transient()).points);
  assert.ok(quiet > 0 && loud > quiet * 4);
  assert.ok(extent(sampleSpectrumEcg(layer(), 6, analysis(.8)).points) < 2, 'constant music has only a very weak baseline shimmer');
  assert.equal(extent(sampleSpectrumEcg(layer(), 6, transient()).points), 0, 'the silent interval after history has passed is flat');
});

test('low precision and long windows retain the same sharp peak and fine smoothing changes remain continuous', () => {
  const source = transient();
  for (const window of [.25, 1.5, 4]) {
    const time = window === .25 ? 2.21 : 2.7;
    const low = sampleSpectrumEcg(layer({ barCount: 8, envelopeWindow: window }), time, source);
    const high = sampleSpectrumEcg(layer({ barCount: 256, envelopeWindow: window }), time, source);
    assert.ok(extent(low.points) > extent(high.points) * .98, 'event knots prevent low-density sampling from swallowing the narrow R spike');
    assert.ok(low.points.length < high.points.length);
  }
  const energies = [.59, .60, .61].map(smoothing => extent(sampleSpectrumEcg(layer({ smoothing }), 2.7, source).points));
  assert.ok(Math.abs(energies[1] - energies[0]) < 1 && Math.abs(energies[2] - energies[1]) < 1);
});

test('fixed musical spikes travel right to left at constant speed, without seek/order dependence or loop resets', () => {
  const source = transient(); const component = layer({ envelopeWindow: 1.5 });
  const snapshot = sampleSpectrumEcg(component, 2.7, source);
  for (const time of [8, 1, 0, 4, 2.2, 9.99]) sampleSpectrumEcg(component, time, source);
  assert.deepEqual(snapshot, sampleSpectrumEcg(component, 2.7, source));
  const peakX = (time: number): number => sampleSpectrumEcg(component, time, source).points.reduce((best, point) => point.y < best.y ? point : best).x;
  const pixelsPerSec = (component.width - snapshot.lineWidth) / 1.5;
  for (let frame = 0; frame < 30; frame++) {
    const time = 2.3 + frame / 120;
    assert.ok(Math.abs(peakX(time + 1 / 120) - peakX(time) + pixelsPerSec / 120) < 1e-7);
  }
  assert.ok(peakX(2.3) > peakX(2.6));
});

test('edge entry/exit and EOF ease continuously rather than appearing as a full-height spike', () => {
  const source = transient(0); const component = layer({ envelopeWindow: .25 });
  assert.equal(extent(sampleSpectrumEcg(component, 0, source).points), 0);
  const early = extent(sampleSpectrumEcg(component, .001, source).points);
  assert.ok(early < .1);
  const final = analysis(); final.peaks.fill(.9, 490);
  const before = extent(sampleSpectrumEcg(layer(), 9.96, final).points);
  const nearEnd = extent(sampleSpectrumEcg(layer(), 9.999, final).points);
  assert.ok(nearEnd < before * .01); assert.equal(extent(sampleSpectrumEcg(layer(), 10, final).points), 0);
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

test('rendering uses exactly one open shadow-free stroke, with no fill/additional baseline and complete state restoration', () => {
  const { ctx, calls, state, stack } = recordingCanvas(); const before = { ...state };
  drawSpectrumEcg(ctx, layer(), 2.7, transient());
  assert.equal(calls.filter(call => call.name === 'stroke').length, 1);
  assert.equal(calls.filter(call => call.name === 'moveTo').length, 1);
  assert.ok(calls.some(call => call.name === 'bezierCurveTo'));
  assert.ok(calls.every(call => ['beginPath', 'moveTo', 'bezierCurveTo', 'stroke'].includes(call.name)));
  for (const call of calls) {
    assert.equal(call.state.strokeStyle, before.strokeStyle); assert.equal(call.state.globalAlpha, before.globalAlpha);
    assert.equal(call.state.shadowBlur, 0); assert.equal(call.state.filter, 'none'); assert.ok(call.args.every(Number.isFinite));
  }
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});

test('tiny layers, malformed peaks and maximum gain keep all stroke geometry inside the component', () => {
  const source = transient(); source.peaks[110] = NaN; source.peaks[111] = Infinity;
  for (const width of [.2, 3, 120, 640]) for (const height of [.2, 3, 20, 180]) {
    const component = { ...layer({ gain: 1e6, barCount: 1e6, lineWidth: 1e6, smoothing: 1e6, envelopeWindow: 1e6 }), width, height };
    const shape = sampleSpectrumEcg(component, 2.7, source);
    assert.ok(shape.points.length >= 97 && shape.points.length < 1300);
    const { ctx, calls } = recordingCanvas(); drawSpectrumEcg(ctx, component, 2.7, source);
    for (const call of calls.filter(call => ['moveTo', 'bezierCurveTo'].includes(call.name))) for (let i = 0; i < call.args.length; i += 2) {
      assert.ok(Number.isFinite(call.args[i]) && Number.isFinite(call.args[i + 1]));
      assert.ok(Math.abs(call.args[i]) + shape.lineWidth / 2 <= width / 2 + 1e-8);
      assert.ok(Math.abs(call.args[i + 1]) + shape.lineWidth / 2 <= height / 2 + 1e-8);
    }
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.deepEqual(sampleSpectrumEcg({ ...layer(), width: value }, 2, source).points, []);
    assert.deepEqual(sampleSpectrumEcg({ ...layer(), height: value }, 2, source).points, []);
  }
  for (const time of [NaN, Infinity]) assert.deepEqual(sampleSpectrumEcg(layer(), time, source).points, []);
});

test('canvas state is restored even if stroking fails', () => {
  const { ctx, state, stack } = recordingCanvas();
  state.stroke = () => { throw new Error('stroke failure'); }; const before = { ...state };
  assert.throws(() => drawSpectrumEcg(ctx, layer(), 2.7, transient()), /stroke failure/);
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});
