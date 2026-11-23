import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LayerEffect } from '../src/types';
import { audioGainAtTime } from '../src/fade-effect';

const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean) as string[];
const ffmpeg = candidates.find(candidate => candidate === 'ffmpeg' ? spawnSync(candidate, ['-version'], { windowsHide: true }).status === 0 : existsSync(candidate));
const fade = (params: Record<string, number> = {}): LayerEffect => ({ id: 'audio-edge', type: 'fade', enabled: true, strength: 1,
  params: { fadeIn: .5, fadeOut: .5, style: 0, timing: 0, curve: 0, distance: 24, ...params } });

test('audio export validates effects and decodes fades relative to actual/project duration, including partial exports and mute', { skip: !ffmpeg, timeout: 60000 }, async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'echo-audio-fade-'));
  const oldData = process.env.VISIKI_DATA_DIR; const oldFFmpeg = process.env.FFMPEG_PATH;
  process.env.VISIKI_DATA_DIR = temporary; process.env.FFMPEG_PATH = ffmpeg!;
  const media = await import('../server/media');
  const exporter = await import('../server/export');
  try {
    await media.initializeMedia();
    const input = path.join(temporary, 'music.wav');
    const generated = spawnSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000:duration=3', '-ac', '2', input], { windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr.toString());
    const audio = await media.importAudio(input, 'fixture.wav');
    const settings = { audioId: audio.id, width: 320, height: 180, fps: 24, start: 0, end: 1 };
    for (const value of [NaN, Infinity, -1, 0, '2', true]) {
      assert.throws(() => exporter.createExportJob({ ...settings, projectDuration: value as number }), /工程时长/);
    }
    for (const value of [null, {}, [ { ...fade(), type: 'film' } ], Array(9).fill(fade()), [fade({ fadeIn: 11 })]]) {
      assert.throws(() => exporter.createExportJob({ ...settings, audioEffects: value as LayerEffect[] }), /效果/);
    }
    const decode = async (start: number, end: number, effects?: LayerEffect[], projectDuration?: number, muted = false) => {
      const created = exporter.createExportJob({ ...settings, start, end, audioEffects: effects, projectDuration, audioMuted: muted });
      const frame = Buffer.alloc(320 * 180 * 4, 160);
      try {
        for (let index = 0; index < created.total; index++) await exporter.writeFrame(created.jobId, index, frame);
      } catch (error) {
        const failed = exporter.getExportJob(created.jobId)!;
        await failed.closed.catch(() => {});
        throw new Error(`${String(error)} at ${start}..${end}, effects=${JSON.stringify(effects)}\n${failed.stderr}`, { cause: error });
      }
      await exporter.finishExport(created.jobId);
      const job = exporter.getExportJob(created.jobId)!;
      const result = spawnSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-i', job.file, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    };
    const rms = (data: Buffer, time: number) => {
      let squares = 0; const first = Math.round(time * 48000); const count = 960;
      for (let n = 0; n < count; n++) squares += data.readFloatLE((first + n) * 4) ** 2;
      return Math.sqrt(squares / count);
    };
    const baseline = await decode(0, 1);
    const baselineRms = rms(baseline, .5);
    assert.ok(baselineRms > .03, 'legacy audio export remains audible');
    const partial = await decode(1, 2, [fade()], 3);
    for (const time of [.05, .5, .95]) assert.ok(Math.abs(rms(partial, time) / baselineRms - 1) < .08, 'partial export must not restart fade-in or fade out at export end');
    const projectTrimmed = await decode(1, 2.5, [fade()], 2);
    assert.ok(rms(projectTrimmed, .9) / baselineRms < .12, 'fade-out uses the shorter project end');
    assert.ok(rms(projectTrimmed, 1.2) < .0001, 'music after project end is silent');
    const realEnd = await decode(2, 3, [fade()], 9);
    assert.ok(rms(realEnd, .9) / baselineRms < .12, 'longer project uses registered audio end');
    const entering = await decode(0, 1, [fade({ fadeIn: 1, fadeOut: 0, curve: 1 })], 3);
    for (const time of [.1, .4, .8]) {
      const expected = audioGainAtTime([fade({ fadeIn: 1, fadeOut: 0, curve: 1 })], time + .01, 3);
      assert.ok(Math.abs(rms(entering, time) / baselineRms - expected) < .05, 'AAC decoded fade follows preview gain');
    }
    const muted = await decode(0, 1, [fade()], 3, true);
    assert.ok(rms(muted, .5) < .000001, 'mute wins over the effect stack');
  } finally {
    exporter.killExports();
    if (oldData === undefined) delete process.env.VISIKI_DATA_DIR; else process.env.VISIKI_DATA_DIR = oldData;
    if (oldFFmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = oldFFmpeg;
    rmSync(temporary, { recursive: true, force: true });
  }
});
