import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { audioGainAtTime, buildAudioFadeFilter, fadeAtTime, fadeCurve, fadeDurations } from '../src/fade-effect';
import type { LayerEffect } from '../src/types';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const fade = (params: Record<string, number> = {}, strength = 1): LayerEffect => ({
  id: 'fade-test', type: 'fade', enabled: true, strength, params: { fadeIn: .5, fadeOut: .5, style: 0, curve: 0, timing: 0, distance: 24, ...params },
});

test('fade timing is absolute, seek-safe, and preserves asymmetric edge ratios on short clips', () => {
  const effect = fade({ fadeIn: 2, fadeOut: 6 });
  assert.deepEqual(fadeDurations(effect, 2, 6), { fadeIn: 1, fadeOut: 3 });
  close(fadeAtTime(effect, 2, 6, 2).opacity, 0);
  close(fadeAtTime(effect, 2, 6, 2.25).opacity, .15625);
  close(fadeAtTime(effect, 2, 6, 3).opacity, 1);
  close(fadeAtTime(effect, 2, 6, 5.25).opacity, .15625);
  for (const time of [6, 2.25, 2, 5.25, 3, 1, 7]) assert.deepEqual(fadeAtTime(effect, 2, 6, time), fadeAtTime(effect, 2, 6, time));
  assert.equal(fadeAtTime(effect, 2, 6, 6).opacity, 0);
  for (const time of [NaN, Infinity]) close(fadeAtTime(effect, 2, 6, time).opacity, 0);
});

test('all styles mix opacity and motion with strength; entering and exiting share travel direction', () => {
  for (let style = 0; style <= 5; style++) {
    const effect = fade({ style, curve: 1, distance: 40 }, .5);
    const incoming = fadeAtTime(effect, 4, 10, 4.25);
    const outgoing = fadeAtTime(effect, 4, 10, 9.75);
    close(incoming.opacity, .75); close(outgoing.opacity, .75);
    const expected = [
      [0, 0, 1], [0, 10, 1], [0, -10, 1], [10, 0, 1], [-10, 0, 1], [0, 0, .985],
    ][style];
    assert.deepEqual([incoming.offsetX, incoming.offsetY, incoming.scale], expected);
    close(outgoing.offsetX, -incoming.offsetX); close(outgoing.offsetY, -incoming.offsetY); close(outgoing.scale, incoming.scale);
    close(fadeAtTime({ ...effect, enabled: false }, 4, 10, 4).opacity, 1);
    close(fadeAtTime({ ...effect, strength: 0 }, 4, 10, 4).opacity, 1);
  }
});

test('audio envelopes independently disable edges, support three curves and stack without motion', () => {
  close(fadeCurve(.25, 0), .15625); close(fadeCurve(.25, 1), .25); close(fadeCurve(.25, 2), Math.sin(Math.PI / 8));
  close(audioGainAtTime([fade({ fadeIn: 0 })], 0, 4), 1);
  close(audioGainAtTime([fade({ fadeOut: 0 })], 3.9999, 4), 1);
  close(audioGainAtTime([fade({ fadeIn: 0, fadeOut: 0 })], 0, 4), 1);
  close(audioGainAtTime([fade(), fade()], .25, 4), .25);
  close(audioGainAtTime([fade({}, .5)], 0, 4), .5);
  close(audioGainAtTime([fade({ style: 5, timing: 1 })], .25, 4), .5);
  for (const time of [-1, 4, 5, NaN]) close(audioGainAtTime(undefined, time, 4), 0);
  close(audioGainAtTime(undefined, 1, 4), 1);
  assert.equal(buildAudioFadeFilter([], 1, 4), 'apad');
  assert.equal(buildAudioFadeFilter([{ ...fade(), enabled: false }], 1, 4), 'apad');
});

const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean) as string[];
const ffmpeg = candidates.find(candidate => candidate === 'ffmpeg' ? spawnSync(candidate, ['-version'], { windowsHide: true }).status === 0 : existsSync(candidate));

test('FFmpeg decodes sample-accurate fades matching preview for every curve, partial exports and stacked strength', { skip: !ffmpeg }, () => {
  const sampleRate = 48000;
  const variants = [
    ...[0, 1, 2].map(curve => ({ effects: [fade({ fadeIn: .3, fadeOut: .7, curve })], start: 0, end: 1.4, duration: 1.4 })),
    { effects: [fade({ fadeIn: .8, fadeOut: .7 })], start: .23, end: 1.4, duration: .9 },
    { effects: [fade({ fadeIn: .8, fadeOut: 1.7, curve: 2 }, .6), fade({ fadeIn: 0, fadeOut: .6, curve: 1 }, .4)], start: .13, end: .9, duration: 1.1 },
    { effects: [fade({ fadeIn: 0, fadeOut: 0 }, .8)], start: 0, end: .8, duration: 1 },
  ];
  for (const { effects, start, end, duration } of variants) {
    const filter = buildAudioFadeFilter(effects, start, end);
    const result = spawnSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=1|0.5:s=${sampleRate}:d=${duration}`, '-af', filter, '-t', String(duration), '-f', 'f64le', '-c:a', 'pcm_f64le', 'pipe:1'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    const frames = result.stdout.length / 16;
    assert.equal(frames, Math.round(duration * sampleRate));
    for (let n = 0; n < frames; n += 17) {
      const gain = audioGainAtTime(effects, start + n / sampleRate, end);
      close(result.stdout.readDoubleLE(n * 16), gain, 2e-10);
      close(result.stdout.readDoubleLE(n * 16 + 8), .5 * gain, 2e-10);
    }
  }
});
