import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../src/audio-analysis';
import { drawDualSpectrumWave, sampleDualSpectrumWave } from '../src/spectrum-wave';
import type { AudioAnalysis, Layer, LayerParams } from '../src/types';

const layer = (params: LayerParams = {}): Layer => ({ id: 'wave-test', type: 'spectrum', name: '波浪曲线',
  x: 320, y: 180, width: 640, height: 180, rotation: 0, opacity: .7,
  visible: true, locked: false, start: 0, end: 20, params });

function analysis(peak = .8, frequency = .7): AudioAnalysis {
  return { duration: 20, hopSec: .1, bands: 64, sampleRate: 44100,
    frames: Array.from({ length: 201 }, () => new Float32Array(64).fill(frequency)),
    peaks: new Float32Array(201).fill(peak), waveform: new Float32Array(200).fill(peak) };
}

const extent = (points: { x: number; y: number }[]): number => Math.max(...points.map(point => Math.abs(point.y)));

test('the two flowing lines have several interior crossings and taper at both ends', () => {
  const [first, second] = sampleDualSpectrumWave(layer(), 2.4, analysis());
  assert.equal(first.length, second.length); assert.ok(first.length > 64);
  let crossings = 0;
  for (let i = 2; i < first.length - 2; i++) {
    const before = first[i - 1].y - second[i - 1].y; const after = first[i].y - second[i].y;
    if (before * after < 0) crossings++;
  }
  assert.ok(crossings >= 3 && crossings <= 5, 'several broad lobes rather than a single arch or jagged noise');
  assert.ok(extent(first) > 20 && extent(second) > 20);
  for (const points of [first, second]) {
    assert.ok(Math.abs(points[0].y) < 1e-6 && Math.abs(points.at(-1)!.y) < 1e-6);
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i].x > points[i - 1].x);
      assert.ok(Math.abs(points[i].y - points[i - 1].y) < 12, 'adjacent samples form a smooth contour');
    }
  }
  const mirrorError = first.reduce((sum, point, index) => sum + Math.abs(point.y + second[index].y), 0) / first.length;
  assert.ok(mirrorError > extent(first) * .08, 'the following line has its own phase and shape rather than copying a mirror');
});

test('silence, missing audio and times outside audio do not invent animated amplitude', () => {
  for (const source of [null, analysis(0, 0)]) {
    for (const time of [0, 4, 18]) {
      const curves = sampleDualSpectrumWave(layer(), time, source);
      assert.ok(curves.flat().every(point => point.y === 0));
    }
  }
  for (const time of [-1, 20, 30]) assert.equal(extent(sampleDualSpectrumWave(layer(), time, analysis())[0]), 0);
  assert.equal(extent(sampleDualSpectrumWave(layer({ gain: 0 }), 4, analysis())[0]), 0);
});

test('real analysed quiet and strong tones produce visibly different amplitude', async () => {
  const sampleRate = 8000;
  async function tone(amplitude: number): Promise<AudioAnalysis> {
    const signal = Float32Array.from({ length: sampleRate }, (_, i) => amplitude * Math.sin(i / sampleRate * 220 * Math.PI * 2));
    return analyzeAudio({ sampleRate, numberOfChannels: 1, length: signal.length,
      getChannelData: () => signal } as unknown as AudioBuffer);
  }
  const quiet = sampleDualSpectrumWave(layer(), .5, await tone(.03));
  const strong = sampleDualSpectrumWave(layer(), .5, await tone(.8));
  assert.ok(extent(strong[0]) > extent(quiet[0]) * 2, 'the source amplitude is not lost in dB-normalised display bands');
});

test('frequency distribution shapes the curves and fixed-time seeking remains deterministic', () => {
  const bass = analysis(.7, 0); const treble = analysis(.7, 0);
  for (const frame of bass.frames) frame.fill(.9, 0, 20);
  for (const frame of treble.frames) frame.fill(.9, 44);
  const snapshot = sampleDualSpectrumWave(layer(), 8.125, bass);
  assert.notDeepEqual(snapshot, sampleDualSpectrumWave(layer(), 8.125, treble));
  for (const time of [4, 15, 2, 0, 18]) sampleDualSpectrumWave(layer(), time, bass);
  assert.deepEqual(sampleDualSpectrumWave(layer(), 8.125, bass), snapshot);
  assert.notDeepEqual(sampleDualSpectrumWave(layer(), 8.375, bass), snapshot);
});

test('flow can freeze or accelerate the carrier without freezing energy response', () => {
  const frozen = layer({ flowSpeed: 0 });
  assert.deepEqual(sampleDualSpectrumWave(frozen, 2, analysis()), sampleDualSpectrumWave(frozen, 9, analysis()));
  assert.ok(extent(sampleDualSpectrumWave(frozen, 3, analysis(.85))[0]) > extent(sampleDualSpectrumWave(frozen, 3, analysis(.12))[0]) * 1.6);
  assert.deepEqual(sampleDualSpectrumWave(layer({ flowSpeed: 2 }), 2.5, analysis()), sampleDualSpectrumWave(layer({ flowSpeed: 1 }), 5, analysis()));
});

test('stronger passages retain amplitude differences through the soft shoulder', () => {
  const component = layer({ gain: 3, flowSpeed: 0 });
  const medium = extent(sampleDualSpectrumWave(component, 2, analysis(.35))[0]);
  const loud = extent(sampleDualSpectrumWave(component, 2, analysis(.65))[0]);
  const strongest = extent(sampleDualSpectrumWave(component, 2, analysis(.95))[0]);
  assert.ok(loud > medium * 1.06 && strongest > loud * 1.025, 'high drive does not flatten different musical levels into one ceiling');
  const points = sampleDualSpectrumWave(component, 2, analysis(.95))[0];
  const nearTop = points.filter(point => Math.abs(point.y) > strongest * .995);
  assert.ok(nearTop.length < points.length * .08, 'lobes keep rounded tips instead of flat clipped sections');
});

test('continuous playback remains smooth at the carrier cycle boundary and at high flow', () => {
  const source = analysis();
  for (const speed of [1, 3]) {
    const component = layer({ flowSpeed: speed });
    const period = Math.PI / speed;
    const before = sampleDualSpectrumWave(component, period - 1 / 240, source);
    const centre = sampleDualSpectrumWave(component, period, source);
    const after = sampleDualSpectrumWave(component, period + 1 / 240, source);
    for (let curve = 0; curve < 2; curve++) for (let i = 0; i < centre[curve].length; i++) {
      const deltaBefore = centre[curve][i].y - before[curve][i].y;
      const deltaAfter = after[curve][i].y - centre[curve][i].y;
      assert.ok(Math.abs(deltaBefore - deltaAfter) < .15, 'no position or velocity jump when the carrier wraps visually');
    }
    const initial = sampleDualSpectrumWave(component, 1, source);
    const repeated = sampleDualSpectrumWave(component, 1 + period, source);
    for (let curve = 0; curve < 2; curve++) for (let i = 0; i < initial[curve].length; i++) {
      assert.ok(Math.abs(initial[curve][i].y - repeated[curve][i].y) < 1e-10);
    }
  }
});

test('higher smoothing reduces visible frame-to-frame pumping during continuous music', () => {
  const source = analysis(.8, .7);
  for (let i = 0; i < source.peaks.length; i++) source.peaks[i] = i % 2 ? .85 : .08;
  const jumps = (smoothing: number): number => {
    const component = layer({ flowSpeed: 0, smoothing });
    const levels = Array.from({ length: 241 }, (_, i) => extent(sampleDualSpectrumWave(component, 2 + i / 120, source)[0]));
    return Math.max(...levels.slice(1).map((value, i) => Math.abs(value - levels[i])));
  };
  assert.ok(jumps(1) < jumps(0) * .8, 'a smoother setting damps alternating analysis frames while retaining musical movement');
});

test('extreme gains, density and tiny components stay finite and within their bounds', () => {
  for (const width of [.5, 3, 120, 640]) for (const height of [.5, 3, 20, 180]) {
    for (const params of [{ gain: 10000, barCount: 10000, lineWidth: 100, flowSpeed: 100, smoothing: 100 },
      { gain: -1, barCount: -100, lineWidth: -100, flowSpeed: -100, smoothing: -100 },
      { gain: NaN, barCount: Infinity, lineWidth: NaN, flowSpeed: NaN, smoothing: NaN }]) {
      const component = { ...layer(params), width, height };
      const curves = sampleDualSpectrumWave(component, 3.7, analysis());
      assert.ok(curves[0].length >= 65 && curves[0].length <= 513);
      for (const point of curves.flat()) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(Math.abs(point.x) <= width / 2 && Math.abs(point.y) <= height / 2);
      }
    }
  }
  for (const time of [NaN, Infinity]) assert.deepEqual(sampleDualSpectrumWave(layer(), time, analysis()), [[], []]);
  for (const dimension of [0, -1, NaN, Infinity]) {
    assert.deepEqual(sampleDualSpectrumWave({ ...layer(), width: dimension }, 2, analysis()), [[], []]);
    assert.deepEqual(sampleDualSpectrumWave({ ...layer(), height: dimension }, 2, analysis()), [[], []]);
  }
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

test('rendering produces exactly two open strokes without fill or shadow and preserves canvas state', () => {
  const { ctx, calls, state, stack } = recordingCanvas(); const before = { ...state };
  drawDualSpectrumWave(ctx, layer(), 4.2, analysis());
  assert.equal(calls.filter(call => call.name === 'stroke').length, 2);
  assert.equal(calls.filter(call => call.name === 'moveTo').length, 2);
  assert.ok(calls.some(call => call.name === 'bezierCurveTo'));
  assert.ok(calls.every(call => ['beginPath', 'moveTo', 'bezierCurveTo', 'stroke'].includes(call.name)));
  for (const call of calls) {
    assert.equal(call.state.globalAlpha, before.globalAlpha); assert.equal(call.state.strokeStyle, before.strokeStyle);
    assert.equal(call.state.shadowBlur, 0); assert.equal(call.state.filter, 'none');
    assert.ok(call.args.every(Number.isFinite));
  }
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
  const strokes = calls.filter(call => call.name === 'stroke');
  assert.ok(Number(strokes[0].state.lineWidth) > Number(strokes[1].state.lineWidth), 'leading and following strokes have a subtle weight hierarchy');
});

test('Bezier controls keep the complete strokes within the component, even at maximum gain', () => {
  const { ctx, calls } = recordingCanvas(); const component = { ...layer({ gain: 10, lineWidth: 8 }), width: 120, height: 20 };
  drawDualSpectrumWave(ctx, component, 4.2, analysis());
  for (const call of calls.filter(call => call.name === 'moveTo' || call.name === 'bezierCurveTo')) {
    const halfStroke = (call.state.lineWidth as number) / 2;
    for (let i = 0; i < call.args.length; i += 2) {
      assert.ok(Math.abs(call.args[i]) + halfStroke <= component.width / 2 + 1e-8);
      assert.ok(Math.abs(call.args[i + 1]) + halfStroke <= component.height / 2 + 1e-8);
    }
  }
});

test('canvas state is restored when a stroke throws', () => {
  const { ctx, state, stack } = recordingCanvas();
  state.stroke = () => { throw new Error('stroke failure'); }; const before = { ...state };
  assert.throws(() => drawDualSpectrumWave(ctx, layer(), 2, analysis()), /stroke failure/);
  assert.deepEqual(state, before); assert.equal(stack.length, 0);
});
