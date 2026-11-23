import test from 'node:test';
import assert from 'node:assert/strict';
import { activeLyricIndex, mergeBilingual, parseLyrics } from '../src/lyrics';
import { analyzeAudio, sampleFeatures } from '../src/audio-analysis';
import { discAngleAtTime, renderScene } from '../src/scene';
import type { AudioAnalysis, DemoProject } from '../src/types';

test('LRC handles document offset, repeated timestamp tags, metadata, and bilingual rows', () => {
  const cues = parseLyrics('[ar:Artist]\n[00:01.50][00:05.000]Hello\n[00:01.500]你好\n[offset:250]');
  assert.deepEqual(cues, [{ time: 1.25, text: 'Hello', translation: '你好' }, { time: 4.75, text: 'Hello' }]);
  assert.equal(parseLyrics('[offset:1500]\n[00:01.00]Before zero')[0].time, -0.5);
  const corrected = parseLyrics('[offset:500]\n[00:02.00]Aligned');
  assert.equal(activeLyricIndex(corrected, 2 - 500 / 1000), 0, 'positive project delay cancels a positive LRC file offset');
  assert.equal(activeLyricIndex(corrected, 1.99 - 500 / 1000), -1);
});

test('separate translated LRC is joined by timestamp rather than line number', () => {
  const cues = mergeBilingual('[00:01.00]one\n[00:02.00]two\n[00:03.00]three', '[00:00.00]译者信息\n[00:02.03]二\n[00:03.00]三');
  assert.equal(cues[0].translation, undefined);
  assert.equal(cues[1].translation, '二');
  assert.equal(cues[2].translation, '三');
});

test('SRT reads bilingual content and respects subtitle gaps on arbitrary seek', () => {
  const cues = parseLyrics('1\n00:00:01,000 --> 00:00:02,500\nHello\n你好\n\n2\n00:00:04.000 --> 00:00:06.000\nWorld\n');
  assert.deepEqual(cues, [{ time: 1, end: 2.5, text: 'Hello', translation: '你好' }, { time: 4, end: 6, text: 'World' }]);
  assert.equal(activeLyricIndex(cues, 5), 1);
  assert.equal(activeLyricIndex(cues, 0.9), -1);
  assert.equal(activeLyricIndex(cues, 1.4), 0);
  assert.equal(activeLyricIndex(cues, 3), -1);
});

test('frequency cache interpolates at seek time and cannot be mutated through sampling', () => {
  const analysis: AudioAnalysis = { hopSec: 0.5, bands: 2, frames: [new Float32Array([0, 1]), new Float32Array([1, 0]), new Float32Array([0.2, 0.8])], peaks: new Float32Array(3), waveform: new Float32Array(1), sampleRate: 48000, duration: 1 };
  const first = sampleFeatures(analysis, 0.25);
  assert.deepEqual(Array.from(first), [0.5, 0.5]);
  first[0] = 0;
  sampleFeatures(analysis, 0.9);
  assert.deepEqual(Array.from(sampleFeatures(analysis, 0.25)), [0.5, 0.5]);
  assert.deepEqual(Array.from(sampleFeatures(analysis, -1)), [0, 0]);
  assert.deepEqual(Array.from(sampleFeatures(analysis, 2)), [0, 0]);
});

test('disc angle is absolute, periodic, and independent of frame history', () => {
  assert.ok(Math.abs(discAngleAtTime(7.5, 8)) < 1e-12);
  assert.ok(Math.abs(discAngleAtTime(1.875, 8) - Math.PI / 2) < 1e-12);
  discAngleAtTime(111, 33);
  assert.ok(Math.abs(discAngleAtTime(1.875, 8) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(discAngleAtTime(-1.875, 8) - Math.PI * 1.5) < 1e-12);
});

test('selection outlines never leak into exported frames, and layer time spans apply', () => {
  const project: DemoProject = { format: 'echo-demo', version: 1, width: 1920, height: 1080, fps: 30, duration: 5, title: 'Title', artist: 'Artist', audio: null, cover: null, lyrics: [], lyricsOffsetMs: 0,
    layers: [{ id: 'title', type: 'title', name: 'Title', x: 300, y: 200, width: 500, height: 70, rotation: 0, opacity: 1, visible: true, locked: false, start: 1, end: 3, params: {} }] };
  let outlines = 0;
  const text: string[] = [];
  const noop = (): void => {};
  const ctx = { canvas: { width: 960, height: 540 }, save: noop, restore: noop, setTransform: noop, fillRect: noop, translate: noop, rotate: noop, beginPath: noop, rect: noop, clip: noop, setLineDash: noop,
    measureText: (value: string) => ({ width: value.length * 10 }), fillText: (value: string) => text.push(value), strokeRect: () => outlines++ } as unknown as CanvasRenderingContext2D;
  const resources = { cover: null, analysis: null };
  renderScene(ctx, project, 2, resources, { selectionId: 'title' });
  assert.deepEqual(text, ['Title', 'Artist']);
  assert.equal(outlines, 0);
  renderScene(ctx, project, 2, resources, { editor: true, selectionId: 'title' });
  assert.ok(outlines > 0);
  text.length = 0;
  renderScene(ctx, project, 3, resources);
  assert.deepEqual(text, []);
});

function audioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return { length: channels[0].length, numberOfChannels: channels.length, sampleRate, duration: channels[0].length / sampleRate, getChannelData: (i: number) => channels[i] } as AudioBuffer;
}

test('real FFT finds tone energy and preserves opposite phase stereo power', async () => {
  const sampleRate = 12000;
  const signal = Float32Array.from({ length: sampleRate / 4 }, (_, i) => 0.7 * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
  const opposite = Float32Array.from(signal, value => -value);
  const mono = await analyzeAudio(audioBuffer([signal], sampleRate));
  const stereo = await analyzeAudio(audioBuffer([signal, opposite], sampleRate));
  const features = sampleFeatures(stereo, 0.1);
  assert.ok(Math.max(...features) > 0.8, 'a clear tone produces measurable spectral energy');
  const strongestBand = features.indexOf(Math.max(...features));
  const expectedBand = Math.floor(Math.log(1000 / 35) / Math.log(6000 / 35) * 64);
  assert.ok(Math.abs(strongestBand - expectedBand) <= 2, 'the spectral peak is near the actual 1000 Hz tone');
  assert.ok(Math.abs(Math.max(...features) - Math.max(...sampleFeatures(mono, 0.1))) < 0.0001, 'anti-phase channels preserve power');
  assert.ok(Math.max(...stereo.peaks) > 0.69);
  assert.ok(Math.max(...stereo.waveform) > 0.69);
  const silence = await analyzeAudio(audioBuffer([new Float32Array(sampleRate / 10)], sampleRate));
  assert.ok(sampleFeatures(silence, 0.05).every(value => value === 0));
});
