import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { addEffect, clipEffectTarget, createEffect, getEffectChain, getEffectDefinition, type DawEffect } from '../src/daw/effects'
import { eqBandResponse, eqMatchResponse } from '../src/daw/eq-response'
import { addTrack, createSession, createTrack, parseSession, serializeSession, splitClip, type DawAsset, type DawSession } from '../src/daw/model'
import { applyAutoMixPlan, bypassAutoMixInserts, defaultAutoMixOptions, type AutoMixPlan } from '../src/daw/auto-mix'
import { createDefaultProject } from '../src/default-project'
import { validateProject } from '../src/project-io'

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'visiki-daw-native-test-'))
process.env.VISIKI_DATA_DIR = temporaryRoot
const gainSample = process.env.VISIKI_VST3_TEST_AGAIN
if (gainSample) process.env.VISIKI_VST3_SCAN_ROOTS = gainSample
const { nativeAudioAvailable, nativeSession, renderNativeAudio, learnNativeNoise, measureNativeComparison, nativeCommand, nativeStatus, killNativeAudio } = await import('../server/daw-native')
const { dawRouter, initializeDaw, killDawJobs, importDawAudio } = await import('../server/daw')
const { initializeMedia, getAsset, assetFile } = await import('../server/media')
after(async () => {
  killNativeAudio(); killDawJobs()
  assert(temporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep))
  assert(path.basename(temporaryRoot).startsWith('visiki-daw-native-test-'))
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

const RATE = 48000
const ready = nativeAudioAvailable()
const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0
function floatWav(channels: 1 | 2, frames: number, at: (frame: number, channel: number) => number, sampleRate = RATE): Buffer {
  const result = Buffer.alloc(44 + frames * channels * 4)
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16)
  result.writeUInt16LE(3, 20); result.writeUInt16LE(channels, 22); result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * channels * 4, 28)
  result.writeUInt16LE(channels * 4, 32); result.writeUInt16LE(32, 34); result.write('data', 36); result.writeUInt32LE(frames * channels * 4, 40)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) result.writeFloatLE(at(frame, channel), 44 + (frame * channels + channel) * 4)
  return result
}
function asset(id = randomUUID(), channels: 1 | 2 = 2, frames = 4800, sampleRate = RATE): DawAsset {
  return { id, name: '原生测试.wav', url: `/api/daw/assets/${id}`, duration: frames / sampleRate, sampleRate, sampleCount: frames, channels, peaks: [], peakHopSec: .01 }
}
function sessionWith(source: DawAsset): DawSession {
  const session = addTrack(createSession('原生测试'), createTrack('音频'))
  session.assets = [source]
  session.tracks[0].clips = [{ id: randomUUID(), assetId: source.id, name: source.name, start: 0, sourceIn: 0, duration: source.duration, gainDb: 0, fadeIn: 0, fadeOut: 0 }]
  return session
}
function effect(type: DawEffect['type'], params: Record<string, number>): DawEffect {
  const value = createEffect(type); value.params = { ...value.params, ...params }; delete value.presetId; return value
}
function readPcm24(buffer: Buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
  let position = 12, sampleRate = 0
  while (position + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', position, position + 4), size = buffer.readUInt32LE(position + 4)
    if (tag === 'fmt ') { assert.equal(buffer.readUInt16LE(position + 8), 1); assert.equal(buffer.readUInt16LE(position + 10), 2); assert.equal(buffer.readUInt16LE(position + 22), 24); sampleRate = buffer.readUInt32LE(position + 12) }
    if (tag === 'data') {
      const samples = buffer.subarray(position + 8, position + 8 + size)
      assert.equal(samples.length, size)
      return { sampleRate, frames: size / 6, at: (frame: number, channel = 0) => samples.readIntLE(frame * 6 + channel * 3, 3) / 8388608 }
    }
    position += 8 + size + size % 2
  }
  throw new Error('WAV output has no data chunk')
}

test('completed DAW renders register the original WAV as a persistent editor asset', async () => {
  await initializeDaw(); await initializeMedia()
  const app = express(); app.use(express.json()); app.use('/api/daw', dawRouter)
  app.get('/api/assets/:id', (req, res) => {
    const record = getAsset(String(req.params.id)); if (!record) { res.sendStatus(404); return }
    res.type(record.contentType).sendFile(assetFile(record), { dotfiles: 'allow' })
  })
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const root = `http://127.0.0.1:${address.port}`, id = randomUUID(), directory = path.join(temporaryRoot, 'daw', 'renders')
  const wav = Buffer.alloc(44 + 6 * 32)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 6, 28)
  wav.writeUInt16LE(6, 32); wav.writeUInt16LE(24, 34); wav.write('data', 36); wav.writeUInt32LE(6 * 32, 40)
  for (let index = 44; index < wav.length; index++) wav[index] = index % 251
  const post = (renderId: string) => fetch(`${root}/api/daw/renders/${renderId}/to-editor`, { method: 'POST' })
  try {
    await fs.writeFile(path.join(directory, `${id}.wav`), wav)
    assert.equal((await post(id)).status, 404, 'a WAV without completed render metadata is not a completed export')
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ name: '原始混音.wav', sampleRate: RATE, sampleCount: 32 }))
    const responses = await Promise.all([post(id), post(id)])
    const first = await responses[0].json(), second = await responses[1].json()
    assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 200); assert.deepEqual(first, second)
    assert.equal(first.id, id); assert.equal(first.name, '原始混音.wav'); assert.equal(first.duration, 32 / RATE)
    assert.equal(validateProject({ ...createDefaultProject(), audio: first }).audio?.duration, first.duration)
    const download = await fetch(`${root}/api/daw/renders/${id}`), media = await fetch(`${root}${first.url}`)
    assert.equal(download.status, 200); assert.equal(media.status, 200)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), wav); assert.deepEqual(Buffer.from(await media.arrayBuffer()), wav)
    const manifest = JSON.parse(await fs.readFile(path.join(temporaryRoot, 'assets.json'), 'utf8'))
    assert.equal(manifest.find((entry: { asset: { id: string } }) => entry.asset.id === id)?.file, path.relative(temporaryRoot, path.join(directory, `${id}.wav`)))
    const incomplete = randomUUID()
    await fs.writeFile(path.join(directory, `${incomplete}.json`), JSON.stringify({ name: 'missing.wav', sampleRate: RATE, sampleCount: 32 }))
    assert.equal((await post(incomplete)).status, 404)
    await fs.writeFile(path.join(directory, `${incomplete}.wav`), wav.subarray(0, wav.length - 1))
    assert.equal((await post(incomplete)).status, 400, 'truncated WAV must not be registered')
    assert.equal(getAsset(incomplete), undefined)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
async function render(session: DawSession, files: Map<string, string>, includeTail = false, unicodePaths = false) {
  const resolved = await nativeSession(session, async id => {
    const source = session.assets.find(item => item.id === id), file = files.get(id)
    return source && file ? { file, sampleRate: source.sampleRate, channels: source.channels, sampleCount: source.sampleCount!, duration: source.duration, dataOffset: 44 } : undefined
  }, false)
  const directory = unicodePaths ? path.join(temporaryRoot, '中文 导出 🎵') : temporaryRoot
  await fs.mkdir(directory, { recursive: true })
  const id = randomUUID(), job = path.join(directory, `${id}.json`), output = path.join(directory, `${id}.wav`)
  const result = await renderNativeAudio({ ...resolved, includeTail }, job, output, new AbortController().signal)
  const pcm = readPcm24(await fs.readFile(output))
  assert.equal(pcm.sampleRate, session.sampleRate); assert.equal(pcm.frames, result.sampleCount)
  return { result, pcm }
}
async function sourceFile(source: DawAsset, at: (frame: number, channel: number) => number): Promise<string> {
  const file = path.join(temporaryRoot, `中文 音源-${source.id}.wav`)
  await fs.writeFile(file, floatWav(source.channels as 1 | 2, source.sampleCount!, at, source.sampleRate)); return file
}

function toneGain(pcm: ReturnType<typeof readPcm24>, frequency: number, inputAmplitude: number, from = .1, to = .4): number {
  const start = Math.round(from * pcm.sampleRate), end = Math.round(to * pcm.sampleRate);
  let real = 0, imaginary = 0;
  for (let frame = start; frame < end; frame++) {
    const phase = 2 * Math.PI * frequency * frame / pcm.sampleRate, sample = pcm.at(frame);
    real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase);
  }
  return 20 * Math.log10(Math.max(1e-12, 2 * Math.hypot(real, imaginary) / ((end - start) * inputAmplitude)));
}

test('scanned Steinberg VST3 instances process track and master audio independently', { skip: !ready || !gainSample }, async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/daw', dawRouter)
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  try {
    const root = `http://127.0.0.1:${address.port}/api/daw/vst3`
    const scanned = await fetch(`${root}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const listing = await scanned.json()
    assert.equal(scanned.status, 200)
    const classId = 'C18D3C1E719E4E29924D3ECAA5E4DA18'
    const gain = listing.plugins.find((item: { classId: string }) => item.classId === classId)
    assert(gain, JSON.stringify(listing.issues))
    assert(gain.parameters.some((parameter: { id: number; name: string }) => parameter.id === 1 && parameter.name === 'Gain'))
    assert.equal(gain.modulePath, undefined, 'public scan metadata must not carry a native loader path')
    const probe = (patch: object) => fetch(`${root}/parameters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, sampleRate: RATE, params: { '1': .25 }, ...patch }),
    })
    const metadata = await probe({ query: 'Gain', limit: 1 })
    assert.equal(metadata.status, 200)
    const described = await metadata.json()
    assert.equal(described.classId, classId)
    assert.equal(described.parameters[0].normalizedValue, .25)
    assert.equal(described.nextOffset, null)
    assert.equal(described.modulePath, undefined)
    const prepared = await probe({ updates: [{ paramId: 1, format: 'plain', value: .5 }] })
    assert.equal(prepared.status, 200)
    assert.deepEqual((await prepared.json()).resolved, { '1': .5 })
    const unknown = await probe({ updates: [{ paramId: 4294967294, format: 'normalized', value: .5 }] })
    assert.equal(unknown.status, 422)
    assert.match((await unknown.json()).error, /Unknown VST3 parameter/)
    const forgedModule = await probe({ modulePath: gainSample })
    assert.equal(forgedModule.status, 400)
    const source = asset(undefined, 2, RATE)
    const file = await sourceFile(source, frame => .3 * Math.sin(2 * Math.PI * 440 * frame / RATE))
    const project = sessionWith(source)
    const trackId = project.tracks[0].id
    const trackEffect: DawEffect = { id: randomUUID(), type: 'vst3', vst3: { classId }, enabled: true, name: gain.name, params: { '1': .5 } }
    const masterEffect: DawEffect = { ...trackEffect, id: randomUUID(), params: { '1': .25 } }
    const byTrack = addEffect(project, trackId, trackEffect)
    const both = parseSession(serializeSession(addEffect(byTrack, 'master', masterEffect)))
    const files = new Map([[source.id, file]])
    const dry = await render(project, files)
    const track = await render(byTrack, files)
    const mix = await render(both, files)
    for (const frame of [4800, 6001, 9822, 20301]) {
      assert(Math.abs(track.pcm.at(frame) - dry.pcm.at(frame) * .5) < 1e-6)
      assert(Math.abs(mix.pcm.at(frame) - dry.pcm.at(frame) * .125) < 1e-6)
    }
    const missing = { ...both, masterEffects: [{ ...masterEffect, vst3: { classId: 'F'.repeat(32) } }] }
    await assert.rejects(() => render(missing, files), /VST3.+不可用/)
    missing.masterEffects[0].enabled = false
    const bypassed = await render(missing, files)
    assert.equal(bypassed.pcm.at(6001), track.pcm.at(6001))
    assert.throws(() => addEffect(both, clipEffectTarget(both.tracks[0].clips[0].id), { ...trackEffect, id: randomUUID() }), /片段/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('frequency ducking responds to the selected band and preserves distant frequencies in the WAV', { skip: !ready }, async () => {
  const music = asset(randomUUID(), 2, RATE), voice = asset(randomUUID(), 2, RATE);
  const tone = (frame: number, hz: number) => Math.sin(2 * Math.PI * hz * frame / RATE);
  const musicFile = await sourceFile(music, (frame, channel) => channel ? 0 : .30 * tone(frame, 1800) + .10 * (tone(frame, 125) + tone(frame, 7200)));
  const voiceFile = await sourceFile(voice, (frame, channel) => channel ? .13 * tone(frame, frame < RATE * .5 ? 1800 : 125) : 0);
  let session = sessionWith(music);
  const key = createTrack('对白');
  key.clips = sessionWith(voice).tracks[0].clips;
  session.assets.push(voice);
  session = addTrack(session, key);
  const duck = effect('ducker', { mode: 2, thresholdDb: -30, depthDb: 6, bandHz: 1800, bandQ: .8, attackMs: 4, holdMs: 5, releaseMs: 25 });
  duck.sidechainTrackId = key.id;
  const mix = addEffect(session, session.tracks[0].id, duck);
  const { pcm } = await render(mix, new Map([[music.id, musicFile], [voice.id, voiceFile]]));
  assert(Math.abs(toneGain(pcm, 1800, .30) + 6) < .1);
  assert(Math.abs(toneGain(pcm, 125, .10)) < .1);
  assert(Math.abs(toneGain(pcm, 7200, .10)) < .6);
  assert(Math.abs(toneGain(pcm, 1800, .30, .75, .95)) < .1, 'out-of-band trigger held the cut');
});

test('hum removal rejects harmonics and room-tail reduction preserves onset alignment', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE);
  const tone = (frame: number, hz: number) => Math.sin(2 * Math.PI * hz * frame / RATE);
  const hum = await sourceFile(source, frame => .15 * (tone(frame, 50) + tone(frame, 100) + tone(frame, 1000)));
  const session = sessionWith(source);
  session.masterEffects = [effect('denoise', { repairMode: 1, humHarmonics: 2 })];
  const filtered = await render(session, new Map([[source.id, hum]]));
  assert.equal(filtered.result.latencySamples, 0);
  assert(toneGain(filtered.pcm, 50, .15, .6, .9) < -30);
  assert(toneGain(filtered.pcm, 100, .15, .6, .9) < -40);
  assert(Math.abs(toneGain(filtered.pcm, 1000, .15)) < .04);

  const onset = RATE * .10, release = RATE * .27;
  const room = await sourceFile(source, frame => frame < onset ? 0 : .2 * Math.exp(-Math.max(0, frame - release) / (.10 * RATE)) * (tone(frame, 240) + tone(frame, 1200)));
  const files = new Map([[source.id, room]]);
  session.masterEffects = [effect('denoise', { repairMode: 2, reverbReductionDb: 0 })];
  const dry = await render(session, files);
  session.masterEffects = [effect('denoise', { repairMode: 2, reverbReductionDb: 12, reverbProtect: 80 })];
  const treated = await render(session, files);
  assert.equal(treated.result.latencySamples, 2048);
  assert.equal(treated.pcm.frames, source.sampleCount);
  const rms = (pcm: typeof dry.pcm, start: number, end: number) => {
    let sum = 0;
    for (let frame = start; frame < end; frame++) sum += pcm.at(frame) ** 2;
    return Math.sqrt(sum / (end - start));
  };
  assert(rms(treated.pcm, 0, onset) < .0001);
  assert(rms(treated.pcm, onset, onset + .03 * RATE) / rms(dry.pcm, onset, onset + .03 * RATE) > .9);
  assert(rms(treated.pcm, .45 * RATE, .65 * RATE) / rms(dry.pcm, .45 * RATE, .65 * RATE) < .6, 'late decay was not attenuated');
});

test('match EQ uses the same bell responses in the graph and export and composes with manual EQ', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE);
  const session = sessionWith(source);
  const frequency = 1000, amplitude = .18;
  const file = await sourceFile(source, frame => amplitude * Math.sin(2 * Math.PI * frequency * frame / RATE));
  const eq = effect('eq', { band3Freq: 1000, band3Gain: -2, matchGain4: 6, matchStrength: 60 });
  session.masterEffects = [eq];
  const files = new Map([[source.id, file]]);
  const first = await render(session, files);
  const graph = eqBandResponse(frequency, eq.params, 3, RATE) + eqMatchResponse(frequency, eq.params, RATE);
  assert(Math.abs(toneGain(first.pcm, frequency, amplitude) - graph) < .02);
  assert(Math.abs(graph - 1.6) < .02);
  eq.params.matchStrength = 0;
  assert(Math.abs(toneGain((await render(session, files)).pcm, frequency, amplitude) + 2) < .02);
});

test('Ducking follows the selected pre-fader track in project time, including on a latency-compensated clip', { skip: !ready }, async () => {
  const music = asset(randomUUID(), 2, 2 * RATE), voice = asset(randomUUID(), 2, 2 * RATE);
  const musicFile = await sourceFile(music, frame => .2 * Math.sin(2 * Math.PI * 600 * frame / RATE));
  const voiceFile = await sourceFile(voice, (frame, channel) => channel === 1 && frame >= RATE * .5 && frame < RATE * 1.12 ? .4 : 0);
  const files = new Map([[music.id, musicFile], [voice.id, voiceFile]]);
  let session = sessionWith(music);
  const key = createTrack('对白');
  key.volumeDb = -96;
  key.effects = [effect('stereo', { gainDb: -24 })];
  key.clips = sessionWith(voice).tracks[0].clips;
  session.assets.push(voice);
  session = addTrack(session, key);
  const musicTrack = session.tracks[0];
  const duck = effect('ducker', { depthDb: 12, attackMs: 2, holdMs: 20, releaseMs: 45 });
  duck.sidechainTrackId = key.id;
  duck.bState = { ...duck.params };
  duck.bSidechainTrackId = randomUUID();
  const latency = effect('convolution', { mix: 0 });
  const trackMix = addEffect(addEffect(session, musicTrack.id, latency), musicTrack.id, duck);
  const full = await render(trackMix, files);
  const at = (pcm: typeof full.pcm, time: number) => pcm.at(Math.round(time * RATE) + 20);
  assert.equal(full.result.latencySamples, 512);
  assert(Math.abs(at(full.pcm, .49) - .2) < 3e-7, 'ducking starts before the trigger');
  assert(Math.abs(at(full.pcm, .7) / .2 - 10 ** (-12 / 20)) < 3e-5);
  assert(Math.abs(at(full.pcm, 1.75) - .2) < .0001, 'the gain did not recover');
  const muted = { ...trackMix, tracks: [trackMix.tracks[0], { ...key, muted: true }] };
  assert(Math.abs(at((await render(muted, files)).pcm, .7) - .2) < 3e-7);

  const twoPieces = splitClip(session, musicTrack.id, musicTrack.clips[0].id, .85);
  const threePieces = splitClip(twoPieces, musicTrack.id, twoPieces.tracks[0].clips[0].id, .35);
  const target = clipEffectTarget(threePieces.tracks[0].clips[1].id);
  const clipMix = addEffect(addEffect(threePieces, target, latency), target, duck);
  const local = await render(clipMix, files);
  assert.equal(local.result.latencySamples, 512);
  assert(Math.abs(at(local.pcm, .7) / .2 - 10 ** (-12 / 20)) < 3e-5);
  assert(Math.abs(at(local.pcm, 1) - .2) < 3e-7, 'sidechain leaked outside the target clip');
  const resolved = await nativeSession(clipMix, async id => ({
    file: files.get(id)!, sampleRate: RATE, channels: 2, sampleCount: 2 * RATE, duration: 2, dataOffset: 44,
  }), true);
  const measured = await measureNativeComparison({ ...resolved, compareId: duck.id, comparePosition: 0 },
    path.join(temporaryRoot, `${randomUUID()}.compare.json`), new AbortController().signal);
  assert(measured.otherLufs! - measured.activeLufs! > 2, 'A/B did not restore the trigger track for each slot');
});

test('adaptive ducking balances both faders and audio levels within its reduction limit', { skip: !ready }, async () => {
  const music = asset(randomUUID(), 2, 4 * RATE), voice = asset(randomUUID(), 2, 4 * RATE);
  const musicLevel = (t: number) => t < .6 ? .04 : t < 1.4 ? .12 : t < 2.2 ? .4 : .16;
  const tone = (frame: number) => Math.sin(2 * Math.PI * 600 * frame / RATE);
  const musicFile = await sourceFile(music, (frame, channel) => channel ? 0 : musicLevel(frame / RATE) * tone(frame));
  const voiceFile = await sourceFile(voice, (frame, channel) => channel ? (frame < 2.2 * RATE ? .24 : frame < 3.0 * RATE ? .64 : 0) * tone(frame) : 0);
  const files = new Map([[music.id, musicFile], [voice.id, voiceFile]]);
  let session = sessionWith(music);
  const key = createTrack('对白');
  key.volumeDb = 20 * Math.log10(.5);
  key.clips = sessionWith(voice).tracks[0].clips;
  session.assets.push(voice);
  session = addTrack(session, key);
  const musicTrack = session.tracks[0];
  const duck = effect('ducker', { mode: 1, marginDb: 3, depthDb: 6, attackMs: 12, holdMs: 60, releaseMs: 40 });
  duck.sidechainTrackId = key.id;
  const result = await render(addEffect(session, musicTrack.id, duck), files);
  const reduction = (at: number, output = result.pcm, faderGain = 1) =>
    -20 * Math.log10(output.at(Math.round(at * RATE) + 20) / (musicLevel(at) * faderGain));
  assert(Math.abs(reduction(.5)) < .015, 'quiet music should pass at full level');
  assert(Math.abs(reduction(1.25) - 3) < .08, 'equal levels should duck by the requested headroom');
  assert(Math.abs(reduction(2.05) - 6) < .03, 'loud music must respect the attenuation cap');
  assert(Math.abs(reduction(2.85)) < .015, 'a stronger voice should already sit above the music');
  assert(Math.abs(reduction(3.5)) < .015, 'music must recover in the gap');

  const lowerMusic = { ...session, tracks: [{ ...musicTrack, volumeDb: key.volumeDb }, key] };
  const lowered = await render(addEffect(lowerMusic, musicTrack.id, duck), files);
  assert(Math.abs(reduction(1.25, lowered.pcm, .5)) < .015, 'already lowering the music fader should reduce the ducking');
  assert.equal(result.result.latencySamples, 0);
});

test('clip inserts preserve adjacent and overlapping clips and compensate their delay without extending the mix', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE), input = await sourceFile(source, frame =>
    .2 * Math.sin(2 * Math.PI * 625 * frame / RATE) + (frame === 31000 ? .2 : 0));
  let session = sessionWith(source), track = session.tracks[0];
  session = splitClip(session, track.id, track.clips[0].id, .25);
  session = splitClip(session, track.id, session.tracks[0].clips[1].id, .75);
  track = session.tracks[0];
  const center = track.clips[1];
  track.clips.push({ ...track.clips[0], id: randomUUID(), start: .4, duration: .1, sourceIn: .8, envelope: undefined, gainDb: -12 });
  const files = new Map([[source.id, input]]);
  const dry = (await render(session, files)).pcm;
  const gain = createEffect('stereo'); gain.params.gainDb = -6; delete gain.presetId;
  const trim = addEffect(addEffect(session, clipEffectTarget(center.id), gain), clipEffectTarget(center.id), effect('convolution', { mix: 0 }));
  const changed = await render(trim, files, true);
  assert.equal(changed.result.latencySamples, 512);
  assert.equal(changed.result.tailSeconds, 0);
  for (let i = 0; i < RATE; i++) {
    if (i < RATE / 4 || i >= .75 * RATE) assert.equal(changed.pcm.at(i), dry.at(i), `adjacent sample ${i}`);
  }
  const probe = 20335, centerValue = .2 * Math.sin(2 * Math.PI * 625 * probe / RATE);
  const expected = dry.at(probe) + centerValue * (10 ** (-6 / 20) - 1);
  assert(Math.abs(changed.pcm.at(probe) - expected) < 4e-7, 'overlap on the same track was processed or shifted');
  const echo = addEffect(session, clipEffectTarget(center.id), effect('delay', { timeMs: 70, timeRightMs: 70, mix: 100, feedback: 70 }));
  const delayed = await render(echo, files, true);
  assert.equal(delayed.result.tailSeconds, 0);
  assert.equal(delayed.pcm.frames, RATE);
  assert(Math.abs(delayed.pcm.at(probe) - dry.at(probe)) > .005);
  for (let i = .75 * RATE; i < RATE; i++) assert.equal(delayed.pcm.at(i), dry.at(i), 'clip delay leaked through the cut');
});

test('native denoise learns the aligned effect input and restores spectral reduction in export and A/B', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, 2 * RATE), session = sessionWith(source);
  let rng = 127;
  const file = await sourceFile(source, (frame, channel) => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    if (frame >= RATE * 1.4) return 0;
    const noise = (rng / 0x100000000 - .5) * .02;
    return noise + (frame >= RATE ? (channel ? .16 : .3) * Math.sin(2 * Math.PI * 700 * frame / RATE) : 0);
  });
  const files = new Map([[source.id, file]]);
  const dry = (await render(session, files)).pcm;
  session.tracks[0].effects = [effect('convolution', { mix: 0 })];
  const denoise = createEffect('denoise');
  session.masterEffects = [denoise];
  const aligned = await render(session, files, true);
  assert.equal(aligned.pcm.frames, dry.frames);
  assert.equal(aligned.result.latencySamples, 2560);
  assert.equal(aligned.pcm.at(800), dry.at(800));
  const resolved = await nativeSession(session, async () => ({
    file, sampleRate: RATE, channels: 2, sampleCount: source.sampleCount!, duration: source.duration, dataOffset: 44,
  }), true);
  const job = path.join(temporaryRoot, `${randomUUID()}.noise.json`);
  const analysis = { ...resolved, noiseEffect: denoise.id, noiseTarget: 'master', noiseStart: .05, noiseDuration: .7 };
  const signal = new AbortController().signal;
  const profile = await learnNativeNoise(analysis, job, signal);
  assert.equal(profile.length, 128);
  await assert.rejects(learnNativeNoise({ ...analysis, noiseStart: 1.5, noiseDuration: .5 }, job, signal), /底噪/);
  denoise.noiseProfile = profile;
  denoise.bState = { ...denoise.params };
  const processed = (await render(session, files)).pcm;
  const power = (pcm: typeof dry, from: number, to: number) => {
    let sum = 0;
    for (let i = Math.round(RATE * from); i < RATE * to; i++) sum += pcm.at(i) ** 2;
    return sum;
  };
  assert(10 * Math.log10(power(processed, .2, .8) / power(dry, .2, .8)) < -6);
  assert(Math.abs(10 * Math.log10(power(processed, 1.1, 1.3) / power(dry, 1.1, 1.3))) < 1);
  const comparisonSession = { ...resolved, masterEffects: [denoise], compareId: denoise.id, comparePosition: 0,
    tracks: resolved.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, duration: .9 })) })),
  };
  const a = await measureNativeComparison(comparisonSession, path.join(temporaryRoot, `${randomUUID()}.comparison.json`), signal);
  assert(Number.isFinite(a.activeLufs) && Number.isFinite(a.otherLufs) && a.otherLufs! - a.activeLufs! > 6);
});

test('modulation follows a two-bar 3/4 cycle, Lo-Fi repeats sample-for-sample, and pedal keeps the dry track aligned', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE * 6), session = sessionWith(source);
  const file = await sourceFile(source, frame => .12 * Math.sin(2 * Math.PI * 600 * frame / RATE));
  const files = new Map([[source.id, file]]);
  session.musicalGrid = { bpm: 120, beatsPerBar: 3, beatUnit: 4 };
  session.masterEffects = [effect('modulation', { mode: 3, depth: 100, mix: 100, phaseDegrees: 0, sync: 1, note: 15 })];
  const tremolo = (await render(session, files)).pcm;
  const index = Math.floor(.75 * RATE) + 15;
  assert(Math.abs(tremolo.at(index)) > .1);
  assert(Math.abs(tremolo.at(index) - tremolo.at(index + RATE * 3)) < 2e-7);
  assert(Math.abs(tremolo.at(index + RATE * 1.5)) < .0001);
  session.masterEffects = [createEffect('lofi', 'vinyl')];
  const vinyl = (await render(session, files)).pcm, replay = (await render(session, files)).pcm;
  for (let frame = 0; frame < vinyl.frames; frame += 13) assert.equal(vinyl.at(frame), replay.at(frame));
  const dryLeft = (await render({ ...session, masterEffects: [] }, files)).pcm;
  assert(Math.abs(vinyl.at(10531) - dryLeft.at(10531)) > .0001);
  session.masterEffects = [effect('pedal', { mode: 2, oversample: 2, mix: 0 })];
  const pedal = await render(session, files, true);
  assert.equal(pedal.result.latencySamples, 16);
  assert.equal(pedal.pcm.frames, dryLeft.frames);
  assert.equal(pedal.pcm.at(991), dryLeft.at(991));
  session.masterEffects = [createEffect('pedal', 'tight-distortion')];
  const distorted = (await render(session, files)).pcm;
  assert(Math.abs(distorted.at(991) - dryLeft.at(991)) > .005);
});

test('native A/B measures the same source passage through both slots without changing WAV gain', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, 2 * RATE), session = sessionWith(source);
  const file = await sourceFile(source, frame => .12 * Math.sin(2 * Math.PI * 1000 * frame / RATE));
  const fx = effect('stereo', { gainDb: 0 }); fx.bState = { ...fx.params, gainDb: 9 }; session.masterEffects = [fx];
  const resolved = await nativeSession(session, async () => ({ file, dataOffset: 44, sampleCount: source.sampleCount!, channels: 2, sampleRate: RATE, duration: source.duration }), true);
  const measured = await measureNativeComparison({ ...resolved, compareId: fx.id, comparePosition: 1.5 }, path.join(temporaryRoot, 'comparison.json'), new AbortController().signal);
  assert.equal(measured.start, 0); assert.equal(measured.end, 2);
  assert.notEqual(measured.activeLufs, null); assert.notEqual(measured.otherLufs, null);
  assert(Math.abs(measured.otherLufs! - measured.activeLufs! - 9) < .03);
  const b = { ...session, masterEffects: [{ ...fx, params: fx.bState!, bState: fx.params, abSlot: 'B' as const }] };
  const { pcm } = await render(b, new Map([[source.id, file]]));
  assert(Math.abs(toneGain(pcm, 1000, .12) - 9) < .02);
});

test('three-band native export recombines at unity and attenuates a targeted low band', { skip: !ready }, async () => {
  const input = .24, source = asset(randomUUID(), 2, RATE / 2), session = sessionWith(source);
  const frequency = [70, 160, 950, 3200, 7200];
  const file = await sourceFile(source, frame => frequency.reduce((sum, hz) => sum + input * .4 * Math.sin(2 * Math.PI * hz * frame / RATE), 0));
  const files = new Map([[source.id, file]]);
  session.masterEffects = [createEffect('multiband')];
  const neutral = await render(session, files);
  for (const hz of frequency) assert(Math.abs(toneGain(neutral.pcm, hz, input * .4)) < .08, `neutral magnitude at ${hz} Hz`);
  assert.equal(neutral.result.latencySamples, 0);
  session.masterEffects = [effect('multiband', { band1ThresholdDb: -50, band1Ratio: 8, band1AttackMs: .1 })];
  const compressed = (await render(session, files)).pcm;
  assert(toneGain(compressed, 70, input * .4) < -10, 'bass peak was not controlled');
  assert(Math.abs(toneGain(compressed, 7200, input * .4)) < .1, 'high band was not targeted');
});

test('convolution native export compensates dry path on both tracks and renders the selected stereo tail', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, 4800), session = sessionWith(source), hit = 1200;
  const file = await sourceFile(source, (frame, channel) => frame === hit ? (channel ? .08 : .16) : 0), files = new Map([[source.id, file]]);
  session.tracks[0].effects = [effect('convolution', { mix: 0 })];
  const second = createTrack('同期'); second.clips = [{ ...session.tracks[0].clips[0], id: randomUUID() }]; session.tracks.push(second);
  const dry = await render(session, files, true);
  assert(dry.result.latencySamples > 0);
  assert.equal(dry.result.tailSeconds, 0);
  assert.equal(dry.pcm.frames, 4800);
  assert(Math.abs(dry.pcm.at(hit) - .32) < 1e-6 && Math.abs(dry.pcm.at(hit, 1) - .16) < 1e-6);
  assert(Math.abs(dry.pcm.at(hit - 1)) < 1e-6 && Math.abs(dry.pcm.at(hit + 1)) < 1e-6);
  session.tracks.pop();
  session.tracks[0].effects = [effect('convolution', { space: 3, preDelayMs: 60, mix: 100 })];
  const wet = await render(session, files, true), trimmed = await render(session, files, false);
  assert(wet.result.tailSeconds > 2 && wet.pcm.frames > 100_000);
  assert.equal(trimmed.pcm.frames, 4800);
  let maxTail = 0, stereoEnergy = 0;
  for (let i = 4800; i < wet.pcm.frames; i++) {
    const [l, r] = [wet.pcm.at(i), wet.pcm.at(i, 1) * 2];
    maxTail = Math.max(maxTail, Math.abs(l));
    stereoEnergy += (l - r) ** 2;
  }
  assert(maxTail > .0008 && stereoEnergy > .00001, 'the export needs a nontrivial left/right convolution tail');
  for (let i = hit; i < hit + 2880; i++) assert(Math.abs(wet.pcm.at(i)) < 1e-6, 'wet audio starts before the selected pre-delay');
});

test('native sample-rate conversion rejects aliased tones and preserves the 20 kHz passband', { skip: !ready }, async () => {
  for (const [sourceRate, targetRate, tone, measured, rejected] of [
    [192000, 48000, 30000, 18000, true], [96000, 48000, 30000, 18000, true],
    [48000, 8000, 10000, 2000, true], [44100, 48000, 20000, 20000, false],
  ] as const) {
    const source = asset(randomUUID(), 2, sourceRate / 2, sourceRate), session = sessionWith(source);
    session.sampleRate = targetRate; session.masterEffects = [createEffect('meter')];
    const file = await sourceFile(source, frame => .5 * Math.sin(2 * Math.PI * tone * frame / sourceRate));
    const { pcm } = await render(session, new Map([[source.id, file]]));
    const gain = toneGain(pcm, measured, .5);
    assert(rejected ? gain < -85 : Math.abs(gain) < .3, `${sourceRate} -> ${targetRate} Hz, ${tone} Hz: ${gain.toFixed(2)} dB`);
  }
});

test('long synchronized delay tails are capped before converting the WAV frame count', { skip: !ready }, async () => {
  const rate = 192000, source = asset(randomUUID(), 2, 1920, rate), session = sessionWith(source);
  session.sampleRate = rate; session.musicalGrid = { ...session.musicalGrid!, bpm: 20 };
  session.masterEffects = Array.from({ length: 7 }, () => effect('delay', { sync: 1, noteL: 14, noteR: 14, feedback: 95 }));
  const file = await sourceFile(source, frame => frame === 0 ? .5 : 0);
  const { result } = await render(session, new Map([[source.id, file]]), true);
  assert.equal(result.sampleCount, 1920 + 30 * rate);
  assert.equal(result.tailSeconds, 30);
});

test('EQ response matches the native cutoff in a low-rate session', { skip: !ready }, async () => {
  for (const [sampleRate, frequency, params] of [
    [16000, 7500, { band1Freq: 12000, soloBand: 0, band1Type: 4, band1Slope: 2 }],
  ] as [number, number, Record<string, number>][]) {
    const source = asset(randomUUID(), 2, sampleRate / 2, sampleRate), session = sessionWith(source);
    session.sampleRate = sampleRate;
    const equalizer = effect('eq', { band2Enabled: 0, band3Enabled: 0, band4Enabled: 0, band5Enabled: 0, band6Enabled: 0, band7Enabled: 0, band8Enabled: 0, band1Enabled: 1, ...params });
    session.masterEffects = [equalizer];
    const file = await sourceFile(source, frame => .5 * Math.sin(2 * Math.PI * frequency * frame / sampleRate));
    const measured = toneGain((await render(session, new Map([[source.id, file]]))).pcm, frequency, .5);
    const graph = eqBandResponse(frequency, equalizer.params, 1, sampleRate);
    assert(Math.abs(measured - graph) < .03, `Audio ${measured.toFixed(3)} dB, graph ${graph.toFixed(3)} dB`);
  }
});

test('EQ solo remains active for preview A/B while the response graph matches it', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE * 2), session = sessionWith(source);
  const equalizer = effect('eq', { band2Enabled: 0, band3Enabled: 0, band4Enabled: 0, band5Enabled: 0, band6Enabled: 0, band7Enabled: 0, band8Enabled: 0, band1Enabled: 1, band1Freq: 250, soloBand: 1, band1Type: 0, band1Gain: 0, band1Q: .707 });
  equalizer.bState = { ...equalizer.params, soloBand: 0 }; session.masterEffects = [equalizer];
  const file = await sourceFile(source, frame => .5 * Math.sin(2 * Math.PI * 1000 * frame / RATE));
  const resolved = await nativeSession(session, async () => ({ file, dataOffset: 44, sampleCount: source.sampleCount!, channels: 2, sampleRate: RATE, duration: source.duration }), true);
  const measured = await measureNativeComparison({ ...resolved, compareId: equalizer.id, comparePosition: 0 }, path.join(temporaryRoot, `${randomUUID()}.json`), new AbortController().signal);
  assert.notEqual(measured.activeLufs, null); assert.notEqual(measured.otherLufs, null);
  const expected = eqBandResponse(1000, equalizer.params, 1, RATE) - eqBandResponse(1000, equalizer.bState, 1, RATE);
  assert(Math.abs(measured.activeLufs! - measured.otherLufs! - expected) < .12, `A/B difference ${measured.activeLufs! - measured.otherLufs!} dB, expected ${expected} dB`);
});

test('stereo monitor mode remains audible in preview A/B', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE * 2), session = sessionWith(source);
  const stereo = effect('stereo', { listen: 3 }); stereo.bState = { ...stereo.params, listen: 0 }; session.masterEffects = [stereo];
  const file = await sourceFile(source, (frame, channel) => Math.sin(2 * Math.PI * 1000 * frame / RATE) * (channel ? .05 : .2));
  const resolved = await nativeSession(session, async () => ({ file, dataOffset: 44, sampleCount: source.sampleCount!, channels: 2, sampleRate: RATE, duration: source.duration }), true);
  const measured = await measureNativeComparison({ ...resolved, compareId: stereo.id, comparePosition: 0 }, path.join(temporaryRoot, `${randomUUID()}.json`), new AbortController().signal);
  assert.notEqual(measured.activeLufs, null); assert.notEqual(measured.otherLufs, null);
  const expected = 10 * Math.log10(2 * .2 ** 2 / (.2 ** 2 + .05 ** 2));
  assert(Math.abs(measured.activeLufs! - measured.otherLufs! - expected) < .12);
});

test('offline rendering strips audition controls without changing saved state or real processing', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE / 2), session = sessionWith(source);
  const file = await sourceFile(source, (frame, channel) => .16 * Math.sin(2 * Math.PI * (channel ? 7000 : 1000) * frame / RATE));
  const files = new Map([[source.id, file]]);
  const cases: [DawEffect['type'], Record<string, number>, Record<string, number>][] = [
    ['eq', { band1Enabled: 1, band1Freq: 1000, band1Gain: 9 }, { soloBand: 1 }],
    ['gate', { thresholdDb: -6, rangeDb: 30, attackMs: .1 }, { listen: 1 }],
    ['deesser', { thresholdDb: -50, rangeDb: 12 }, { listen: 1 }],
    ...[1, 2, 3, 4].map(listen => ['stereo', { gainDb: -6, width: 70, swapChannels: 1, phaseLeft: 1, monoBelowHz: 120 }, { listen }] as [DawEffect['type'], Record<string, number>, Record<string, number>]),
    ['stereo', { gainDb: -6, width: 70, swapChannels: 1, phaseLeft: 1, monoBelowHz: 120 }, { mono: 1 }],
  ];
  const dry = (await render(session, files)).pcm;
  for (const [index, [type, processing, monitor]] of cases.entries()) {
    const monitored = effect(type, { ...processing, ...monitor });
    const clean = effect(type, processing);
    // Exercise both track and master conversion paths.
    const key = index % 2 ? 'effects' : 'masterEffects';
    if (key === 'effects') session.tracks[0].effects = [monitored]; else session.masterEffects = [monitored];
    const saved = JSON.stringify(session), actual = (await render(session, files)).pcm;
    assert.equal(JSON.stringify(session), saved);
    if (key === 'effects') session.tracks[0].effects = [clean]; else session.masterEffects = [clean];
    const expected = (await render(session, files)).pcm;
    let processingDifference = 0;
    for (let frame = 5000; frame < 5100; frame++) for (let channel = 0; channel < 2; channel++) {
      assert.equal(actual.at(frame, channel), expected.at(frame, channel), `${type} ${JSON.stringify(monitor)} leaked into export`);
      processingDifference += Math.abs(actual.at(frame, channel) - dry.at(frame, channel));
    }
    assert(processingDifference > .01, `${type} processing was lost`);
    if (key === 'effects') session.tracks[0].effects = []; else session.masterEffects = [];
  }
});

test('explicit stereo channel conversion is written to export after width and phase processing', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, RATE / 2), session = sessionWith(source);
  const file = await sourceFile(source, (frame, channel) => Math.sin(2 * Math.PI * 1000 * frame / RATE) * (channel ? .05 : .2));
  const files = new Map([[source.id, file]]);
  const legacy = effect('stereo', { listen: 2, mono: 1 }); delete legacy.params.channelMode; legacy.bState = { ...legacy.params };
  session.masterEffects = [legacy];
  const legacyOutput = (await render(session, files)).pcm;
  assert(Math.abs(legacyOutput.at(4812, 0) - .2) < .00001);
  assert(Math.abs(legacyOutput.at(4812, 1) - .05) < .00001);
  for (const [mode, left, right] of [[0, -.0125, -.1375], [1, -.075, -.075], [2, .0625, .0625], [3, -.0125, -.0125], [4, -.1375, -.1375]] as const) {
    session.masterEffects = [effect('stereo', { channelMode: mode, phaseLeft: 1, swapChannels: 1, width: 50 })];
    const pcm = (await render(session, files)).pcm;
    const frame = 4812; // sine is +1 at this frame
    assert(Math.abs(pcm.at(frame, 0) - left) < .00001, `mode ${mode} left`);
    assert(Math.abs(pcm.at(frame, 1) - right) < .00001, `mode ${mode} right`);
  }
});

test('native loudness distinguishes silence, incomplete windows and measured audio', { skip: !ready }, async () => {
  for (const [duration, amplitude] of [[.1, .2], [4.2, .2], [4.2, 0]]) {
    const source = asset(randomUUID(), 2, Math.round(RATE * duration)), session = sessionWith(source);
    const file = await sourceFile(source, frame => amplitude * Math.sin(2 * Math.PI * 1000 * frame / RATE));
    const { result: { loudness } } = await render(session, new Map([[source.id, file]]));
    if (duration < .4) {
      for (const key of ['integrated', 'momentary', 'shortTerm', 'lra'] as const) assert.equal(loudness[key], null);
    } else if (amplitude === 0) {
      assert.equal(loudness.integrated, null); assert.equal(loudness.lra, null);
      assert(loudness.momentary < -120 && loudness.shortTerm < -120, '24-bit dither stays below the loudness gate');
    } else {
      for (const key of ['integrated', 'momentary', 'shortTerm', 'lra'] as const) assert(Number.isFinite(loudness[key]));
      assert(Math.abs(loudness.integrated! + 14) < .2);
    }
    if (amplitude === 0) assert(loudness.truePeak < -120);
    else assert(Math.abs(loudness.truePeak! + 14) < .2);
  }
});

test('true peak limiting controls intersample peaks in the exported 24-bit WAV', { skip: !ready }, async () => {
  const ceilingDb = -3, amplitude = Math.pow(10, ceilingDb / 20);
  const phases: number[][] = [];
  const radius = 84, factor = 16;
  for (let phase = 1; phase < factor; phase++) {
    const taps = Array.from({ length: radius * 2 }, (_, k) => {
      const t = k - radius + 1 - phase / factor;
      return (Math.sin(Math.PI * t) / (Math.PI * t)) * (.42 + .5 * Math.cos(Math.PI * t / radius) + .08 * Math.cos(2 * Math.PI * t / radius));
    });
    const sum = taps.reduce((a, b) => a + b);
    phases.push(taps.map(tap => tap / sum));
  }
  function reconstructedPeak(pcm: ReturnType<typeof readPcm24>) {
    let peak = 0;
    for (let channel = 0; channel < 2; channel++) {
      const samples = Float64Array.from({ length: pcm.frames }, (_, i) => pcm.at(i, channel));
      for (let i = 0; i < samples.length; i++) {
        peak = Math.max(peak, Math.abs(samples[i]));
        for (const coeffs of phases) {
          let value = 0;
          const start = i - radius + 1, from = Math.max(0, -start), to = Math.min(coeffs.length, samples.length - start);
          for (let k = from; k < to; k++) value += coeffs[k] * samples[start + k];
          peak = Math.max(peak, Math.abs(value));
        }
      }
    }
    return 20 * Math.log10(peak);
  }
  for (const sampleRate of [44100, 48000, 96000]) {
    const length = 4096, source = asset(randomUUID(), 2, length, sampleRate), session = sessionWith(source);
    session.sampleRate = sampleRate;
    const file = await sourceFile(source, (frame, channel) => {
      if (frame < 384 || frame > 3840) return 0;
      const envelope = Math.min(1, (frame - 384) / 96, (3840 - frame) / 96);
      if (frame < 1400) return envelope * (channel ? .55 : 1) * Math.sin(Math.PI / 2 * frame + Math.PI / 4);
      if (frame < 2400) return .77 * Math.sin(2 * Math.PI * .466 * frame + (channel ? .6 : .2));
      const impulse = frame % (channel ? 57 : 37) === 13 ? .83 : 0;
      return envelope * (.52 * Math.sin(2 * Math.PI * .331 * frame + channel) + impulse);
    });
    const files = new Map([[source.id, file]]);
    const settings = { ceilingDb, lookaheadMs: 0, releaseMs: 5, stereoLink: 40 };
    session.masterEffects = [effect('limiter', settings)];
    const sample = await render(session, files);
    session.masterEffects = [effect('limiter', { ...settings, truePeak: 1 })];
    const limited = await render(session, files);
    assert.equal(limited.result.latencySamples, 126);
    assert.equal(limited.pcm.frames, length);
    assert(Math.abs(sample.pcm.at(700)) <= amplitude + 3e-7, 'sample peak ceiling');
    assert(sample.result.loudness.truePeak > ceilingDb + 1, 'input must actually produce intersample overs');
    assert(limited.result.loudness.truePeak <= ceilingDb + .03, 'libebur128 measure');
    const peak = reconstructedPeak(limited.pcm);
    assert(peak <= ceilingDb + .03 && peak > ceilingDb - 1, 'independent reconstruction exceeds ceiling or is overly quiet: ' + peak);
  }
});

test('native session resolves cache paths from trusted lookup and discards submitted file metadata', async () => {
  const source = asset(), session = sessionWith(source)
  Object.assign(source, { file: 'C:/private/never-open.wav', dataOffset: 0, path: '../../escape', __unknown: true })
  const lookedUp: string[] = []
  const resolved = await nativeSession(session, async id => { lookedUp.push(id); return { file: 'G:/trusted/cache.wav', dataOffset: 44, sampleRate: RATE, sampleCount: 4800, channels: 2, duration: .1 } }, false)
  assert.deepEqual(lookedUp, [source.id])
  assert.deepEqual(resolved.assets, [{ id: source.id, file: 'G:/trusted/cache.wav', dataOffset: 44, sampleRate: RATE, sampleCount: 4800, channels: 2, duration: .1 }])
  assert.ok(!JSON.stringify(resolved).includes('private'))
  assert.ok(!JSON.stringify(resolved).includes('escape'))
  assert.equal(session.assets[0], source)
})

test('solo audition ignores inaccessible unsolo sources while export still includes them', async () => {
  const source = asset(), missing = asset(), session = sessionWith(source)
  session.assets.push(missing); session.tracks[0].solo = true
  const second = createTrack('失联的伴奏'); second.clips = [{ ...session.tracks[0].clips[0], id: randomUUID(), assetId: missing.id }]; session.tracks.push(second)
  const lookup = async (id: string) => id === source.id ? { file: 'G:/trusted/cache.wav', dataOffset: 44, sampleRate: RATE, sampleCount: 4800, channels: 2, duration: .1 } : undefined
  assert.equal((await nativeSession(session, lookup, true)).assets.length, 1)
  await assert.rejects(() => nativeSession(session, lookup, false), /失联/)
  session.tracks[1].muted = true
  assert.equal((await nativeSession(session, lookup, false)).assets.length, 1)
})

test('trusted cache bounds and untrusted effects are checked before a host process can read audio', async () => {
  const source = asset(), session = sessionWith(source)
  await assert.rejects(() => nativeSession(session, async () => ({ file: 'G:/trusted/cache.wav', dataOffset: 44, sampleRate: RATE, sampleCount: 100, channels: 2, duration: 100 / RATE }), false), /缓存范围/)
  const invalid = addEffect(session, 'master', 'eq')
  invalid.masterEffects![0].params.band1Freq = Infinity
  await assert.rejects(() => nativeSession(invalid, async () => undefined, false), /band1Freq/)
})

test('native command controls reject malformed operations, values and client identifiers', async () => {
  const id = randomUUID()
  assert.throws(() => nativeStatus('../escape'), /标识/)
  await assert.rejects(() => nativeCommand(id, { op: 'shell' }), /不支持/)
  await assert.rejects(() => nativeCommand(id, { op: 'seek', position: NaN }), /位置/)
  await assert.rejects(() => nativeCommand(id, { op: 'play', position: -1 }), /位置/)
  await assert.rejects(() => nativeCommand(id, { op: 'monitor', db: 1 }), /音量/)
  await assert.rejects(() => nativeCommand(id, { op: 'monitor', db: '-6' }), /音量/)
  assert.equal((await nativeCommand(id, { op: 'dispose' })).ok, true)
})

test('native PCM preserves trim, fades and mono level when a later stereo clip shares the track', { skip: !ready }, async () => {
  const mono = asset(randomUUID(), 1), stereo = asset(), session = sessionWith(mono)
  session.assets.push(stereo)
  session.tracks[0].clips[0] = { ...session.tracks[0].clips[0], start: .01, sourceIn: .02, duration: .04, gainDb: -6, fadeIn: .01, fadeOut: .01 }
  session.tracks[0].clips.push({ ...session.tracks[0].clips[0], id: randomUUID(), assetId: stereo.id, start: .08, sourceIn: 0, duration: .02, fadeIn: 0, fadeOut: 0, gainDb: 0 })
  session.tracks[0].effects = [effect('stereo', { gainDb: -6 })]
  const files = new Map([[mono.id, await sourceFile(mono, frame => frame / RATE)], [stereo.id, await sourceFile(stereo, () => 0)]])
  const { pcm } = await render(session, files)
  assert.equal(pcm.frames, 4800)
  assert.ok(Math.abs(pcm.at(100)) < 2e-7)
  const expected = .04 * Math.pow(10, -12 / 20) * Math.SQRT1_2
  assert.ok(Math.abs(pcm.at(1440) - expected) < 3e-7, `${pcm.at(1440)} != ${expected}`)
  const duringFade = .025 * .5 * Math.pow(10, -12 / 20) * Math.SQRT1_2
  assert.ok(Math.abs(pcm.at(720) - duringFade) < 3e-7)
  assert.ok(Math.abs(pcm.at(2600)) < 2e-7)
})

test('native graph compensates unequal track and master lookahead without moving the impulse or padding length', { skip: !ready }, async () => {
  const source = asset(), session = sessionWith(source)
  const second = createTrack('对齐轨'); second.clips = session.tracks[0].clips.map(clip => ({ ...clip, id: randomUUID() })); session.tracks.push(second)
  session.tracks[0].effects = [effect('limiter', { ceilingDb: 0, lookaheadMs: 5 })]
  session.masterEffects = [effect('limiter', { ceilingDb: 0, lookaheadMs: 2 })]
  const { pcm, result } = await render(session, new Map([[source.id, await sourceFile(source, frame => frame === 100 ? .2 : 0)]]))
  assert.equal(result.latencySamples, 336)
  assert.equal(pcm.frames, 4800)
  let peak = 0, position = -1
  for (let frame = 0; frame < pcm.frames; frame++) if (Math.abs(pcm.at(frame)) > peak) { peak = Math.abs(pcm.at(frame)); position = frame }
  assert.equal(position, 100)
  assert.ok(Math.abs(peak - .4) < 3e-7)
  assert.ok(Math.abs(pcm.at(99)) < 2e-7 && Math.abs(pcm.at(101)) < 2e-7, `Neighbor samples: ${pcm.at(99)}, ${pcm.at(101)}`)
})

test('native insert chains preserve mono and stereo pan laws, including overlapping mixed clips', { skip: !ready }, async () => {
  const mono = asset(randomUUID(), 1), stereo = asset(), files = new Map([
    [mono.id, await sourceFile(mono, () => .2)],
    [stereo.id, await sourceFile(stereo, (_frame, channel) => channel ? .1 : .2)],
  ])
  for (const pan of [-1, -.5, .5, 1]) for (const mode of ['mono', 'stereo', 'mixed']) {
    const session = sessionWith(mode === 'mono' ? mono : stereo)
    session.tracks[0].pan = pan
    session.tracks[0].effects = [effect('meter', {})]
    if (mode === 'mixed') {
      session.assets.push(mono)
      session.tracks[0].clips.push({ ...session.tracks[0].clips[0], id: randomUUID(), assetId: mono.id })
    }
    let left = 0, right = 0
    if (mode !== 'stereo') {
      const angle = (pan + 1) * Math.PI / 4
      left += .2 * Math.cos(angle); right += .2 * Math.sin(angle)
    }
    if (mode !== 'mono') {
      const angle = Math.abs(pan) * Math.PI / 2
      if (pan > 0) { left += .2 * Math.cos(angle); right += .1 + .2 * Math.sin(angle) }
      else { left += .2 + .1 * Math.sin(angle); right += .1 * Math.cos(angle) }
    }
    const { pcm } = await render(session, files)
    assert.ok(Math.abs(pcm.at(2000) - left) < 3e-7, `${mode} pan ${pan}: left ${pcm.at(2000)} != ${left}`)
    assert.ok(Math.abs(pcm.at(2000, 1) - right) < 3e-7, `${mode} pan ${pan}: right ${pcm.at(2000, 1)} != ${right}`)
  }
})

test('native export uses effect order and respects a master limiter ceiling after master drive', { skip: !ready }, async () => {
  const source = asset(), session = sessionWith(source), file = await sourceFile(source, () => .4), files = new Map([[source.id, file]])
  const boost = effect('stereo', { gainDb: 12 }), clip = effect('saturation', { driveDb: 0, mode: 2, outputDb: -12, dcBlock: 0, oversample: 0 })
  session.tracks[0].effects = [boost, clip]
  const first = await render(session, files)
  session.tracks[0].effects = [clip, boost]
  const second = await render(session, files)
  assert.ok(Math.abs(first.pcm.at(2000) - Math.pow(10, -12 / 20)) < 3e-7)
  assert.ok(Math.abs(second.pcm.at(2000) - .4) < 3e-7)
  session.tracks[0].effects = []
  session.masterDb = 12
  session.masterEffects = [effect('limiter', { ceilingDb: -6, lookaheadMs: 5 })]
  const limited = await render(session, files), ceiling = Math.pow(10, -6 / 20)
  for (let frame = 0; frame < limited.pcm.frames; frame++) assert.ok(Math.abs(limited.pcm.at(frame)) <= ceiling + 3e-7)
  assert.ok(limited.pcm.at(2000) > .45)
})

test('native delay tail is rendered beyond the last clip and can be explicitly excluded', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, 2400), session = sessionWith(source), file = await sourceFile(source, frame => frame === 100 ? .2 : 0), files = new Map([[source.id, file]])
  session.tracks[0].effects = [effect('delay', { mix: 100, timeMs: 100, timeRightMs: 150, feedback: 0, lowCutHz: 20, highCutHz: 20000 })]
  const dryLength = await render(session, files, false), withTail = await render(session, files, true)
  assert.equal(dryLength.pcm.frames, 2400)
  assert.equal(dryLength.result.tailSeconds, 0)
  assert.ok(withTail.pcm.frames > dryLength.pcm.frames)
  assert.ok(withTail.result.tailSeconds > 0)
  let tailPeak = 0
  for (let frame = 2400; frame < withTail.pcm.frames; frame++) tailPeak = Math.max(tailPeak, Math.abs(withTail.pcm.at(frame)), Math.abs(withTail.pcm.at(frame, 1)))
  assert.ok(tailPeak > .02)
})

test('native reverb presets deliver distinct wet impulse responses and export audible room tails', { skip: !ready }, async () => {
  const source = asset(randomUUID(), 2, 4800), session = sessionWith(source)
  const impulse = 400, file = await sourceFile(source, (frame, channel) => frame === impulse ? (channel === 0 ? .35 : .16) : 0)
  const presets = getEffectDefinition('reverb').presets
  const added = presets.filter(item => item.params.earlyPattern > 0)
  assert.ok(added.length >= 8)
  const profiles = new Set<number>(), responses = new Set<string>()
  const evaluate = async (id: string) => {
    const reverb = createEffect('reverb', id);
    reverb.params.mix = 100;
    session.tracks[0].effects = [reverb];
    const { pcm, result } = await render(session, new Map([[source.id, file]]), true)
    let onset = -1, afterHalfSecond = 0, peak = 0
    const windows = Array.from({ length: 8 }, () => 0)
    for (let frame = 0; frame < pcm.frames; frame++) {
      const a = pcm.at(frame), b = pcm.at(frame, 1)
      const magnitude = Math.max(Math.abs(a), Math.abs(b)), energy = a * a + b * b
      peak = Math.max(peak, magnitude)
      if (onset < 0 && magnitude > .00005) onset = frame
      if (frame >= impulse + RATE / 2) afterHalfSecond += energy
      const bin = Math.floor((frame - impulse) / (RATE / 20))
      if (bin >= 0 && bin < windows.length) windows[bin] += energy
    }
    assert(peak > .001 && peak <= 1 && onset > impulse, id)
    assert(result.tailSeconds > 0 && pcm.frames > source.sampleCount!, id)
    return { afterHalfSecond, signature: [onset, ...windows.map(value => Math.round(value * 1e6))].join(':') }
  }
  for (const preset of added) {
    profiles.add(preset.params.earlyPattern)
    const { signature } = await evaluate(preset.id)
    assert(!responses.has(signature), preset.id)
    responses.add(signature)
  }
  assert.deepEqual([...profiles].sort(), [1, 2, 3])
  const order = [...added].sort((a, b) => a.params.decaySec - b.params.decaySec)
  const short = await evaluate(order[0].id), long = await evaluate(order.at(-1)!.id)
  assert(long.afterHalfSecond > 10 * short.afterHalfSecond && long.afterHalfSecond > 1e-5)
})

test('native render reads Unicode source, job and output paths including spaces and supplementary characters', { skip: !ready }, async () => {
  const source = asset(), session = sessionWith(source), file = await sourceFile(source, () => .2)
  const { pcm } = await render(session, new Map([[source.id, file]]), false, true)
  assert.equal(pcm.frames, 4800)
  assert.ok(Math.abs(pcm.at(2000) - .2) < 3e-7)
})

test('already cancelled native export does not create a job or output file', { skip: !ready }, async () => {
  const controller = new AbortController(); controller.abort()
  const job = path.join(temporaryRoot, 'cancelled.json'), output = path.join(temporaryRoot, 'cancelled.wav')
  await assert.rejects(() => renderNativeAudio({}, job, output, controller.signal), { name: 'AbortError' })
  await assert.rejects(() => fs.stat(job), { code: 'ENOENT' })
  await assert.rejects(() => fs.stat(output), { code: 'ENOENT' })
})

test('two- and three-track auto mix measures, auditions and exports the same selectable proposal', { skip: !ready || !hasFfmpeg }, async () => {
  await initializeDaw()
  const hz = 1_414
  const tone = (frame: number, frequency = hz) => Math.sin(2 * Math.PI * frequency * frame / RATE)
  const fixtures = [
    ['主唱', (frame: number) => frame >= RATE && frame < 10 * RATE ?
      (Math.floor(frame / RATE) % 2 === 0 ? .18 : .048) * (tone(frame) + .23 * tone(frame, 280)) : 0],
    ['和声', (frame: number) => frame >= 2 * RATE ? .095 * tone(frame, 470) : 0],
    ['伴奏', (frame: number) => .31 * tone(frame) + .16 * tone(frame, 105)],
  ] as const
  let session = createSession('三轨自动混音')
  for (const [name, sample] of fixtures) {
    const source = await importDawAudio(await sourceFile(asset(randomUUID(), 2, 12 * RATE), sample), `${name}.wav`)
    const track = { ...sessionWith(source).tracks[0], name }
    session = addTrack({ ...session, assets: [...session.assets, source] }, track)
  }
  const userEffect = effect('eq', { band3Freq: hz, band3Gain: -10, band3Q: .8 })
  userEffect.bState = { ...userEffect.params, band3Gain: 3 }
  const masterEffect = effect('stereo', { gainDb: -6 })
  const clipEffect = effect('stereo', { gainDb: -.3 })
  const other = createTrack('其他音轨')
  session = addTrack(session, other)
  session = addEffect(session, 'master', masterEffect)
  session = addEffect(session, other.id, effect('stereo', { gainDb: -10 }))
  const lead = session.tracks[0].id
  session = addEffect(session, lead, userEffect)
  session = addEffect(session, clipEffectTarget(session.tracks[0].clips[0].id), clipEffect)
  for (let i = 0; i < 11; i++) session = addEffect(session, lead, { ...createEffect('meter'), enabled: false })
  const options = { ...defaultAutoMixOptions(session), space: 'room' as const,
    delivery: { mode: 'peak' as const, ceilingDb: -12, targetLufs: -14 } }
  assert.equal(options.roles.lead, session.tracks[0].id)
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/daw', dawRouter)
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const post = (endpoint: string, body: unknown) => fetch(`${base}/api/daw/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const duplicate = await post('auto-mix/analyze', { session, options: { ...options, roles: { ...options.roles, harmony: options.roles.lead } } })
    assert.equal(duplicate.status, 400)
    await duplicate.json()

    const backingId = options.roles.backing
    const twoTrackRoles = { lead, backing: backingId }
    const twoTracks = { ...session, tracks: session.tracks.filter(track => track.id === lead || track.id === backingId) }
    assert.deepEqual(defaultAutoMixOptions(twoTracks).roles, twoTrackRoles)
    const twoTrackAnalysis = await post('auto-mix/analyze', { session: twoTracks, options: {
      ...options, roles: twoTrackRoles, harmony: 'mixed', handoffs: [{ start: 3, end: 4 }],
    } })
    const twoTrackPlan: AutoMixPlan = await twoTrackAnalysis.json()
    assert.equal(twoTrackAnalysis.status, 200, JSON.stringify(twoTrackPlan))
    assert.deepEqual(twoTrackPlan.handoffs, [])
    assert(twoTrackPlan.sections.every(section => section.kind !== 'harmony' && section.kind !== 'handoff'))
    const twoTrackMix = applyAutoMixPlan(twoTracks, twoTrackPlan, new Set(twoTrackPlan.changes.map(change => change.id)))
    const leadChain = twoTrackMix.tracks[0].effects?.filter(fx => fx.enabled) ?? []
    for (const type of ['denoise', 'gate', 'eq', 'compressor', 'deesser', 'reverb']) assert(leadChain.some(fx => fx.type === type), type)
    const backingDucker = twoTrackMix.tracks[1].effects?.find(fx => fx.type === 'ducker' && fx.enabled)
    assert(backingDucker && backingDucker.params.mode === 2 && backingDucker.sidechainTrackId === lead)
    assert(twoTrackMix.masterEffects?.some(fx => fx.enabled && fx.type === 'limiter'))
    assert((twoTrackPlan.proposedOutput?.truePeak ?? 0) <= -11.9)
    const twoTrackPreview = await post('auto-mix/preview', { session: twoTrackMix, range: { start: 3, end: 4 } })
    assert.equal(twoTrackPreview.status, 200)
    assert.equal(readPcm24(Buffer.from(await twoTrackPreview.arrayBuffer())).frames, RATE)

    const response = await post('auto-mix/analyze', { session, options })
    const plan: AutoMixPlan = await response.json()
    assert.equal(response.status, 200, JSON.stringify(plan))
    assert(plan.changes.some(change => change.kind === 'fader'))
    assert(plan.changes.some(change => change.kind === 'effect' && change.type === 'compressor'))
    assert(plan.changes.some(change => change.kind === 'effect' && change.type === 'reverb'))
    assert(plan.changes.some(change => change.kind === 'effect' && change.type === 'ducker' && change.params.depthDb <= 3))
    assert(plan.sections.some(section => section.kind === 'backing'))
    assert((plan.proposedOutput?.truePeak ?? 0) <= -11.9)
    const selected = new Set(plan.changes.map(change => change.id))
    const draft = applyAutoMixPlan(session, plan, selected)
    assert.deepEqual(draft.tracks[0].effects?.[0], { ...userEffect, enabled: false })
    assert.deepEqual(draft.masterEffects?.[0], { ...masterEffect, enabled: false })
    assert.equal(draft.tracks[3].effects?.[0].enabled, false)
    assert.deepEqual(draft.tracks.map(track => track.clips), session.tracks.map(track => track.clips))
    assert.deepEqual(session.tracks[0].effects?.[0], userEffect)
    assert.deepEqual(session.masterEffects, [masterEffect])
    assert.equal(draft.tracks[0].effects?.length, 19, 'new inserts fit even when the old track chain had 12 slots occupied')
    const leadEffects = draft.tracks[0].effects!.filter(fx => fx.enabled)
    const denoiseIndex = leadEffects.findIndex(fx => fx.type === 'denoise')
    assert(denoiseIndex >= 0 && denoiseIndex < leadEffects.findIndex(fx => fx.type === 'gate'))
    assert(denoiseIndex < leadEffects.findIndex(fx => fx.type === 'eq'))
    const leadDenoise = leadEffects[denoiseIndex]
    assert.equal(leadDenoise.name, '自动混音·去噪')
    const proposedDenoise = plan.changes.find(change => change.kind === 'effect' && change.id === leadDenoise.id)
    assert(proposedDenoise?.kind === 'effect' && proposedDenoise.type === 'denoise')
    assert.deepEqual(leadDenoise.noiseProfile, proposedDenoise.noiseProfile)
    assert.equal(leadDenoise.noiseProfile, undefined, 'digital silence is not a noise sample')
    const harmonyEffects = draft.tracks.find(track => track.id === options.roles.harmony)!.effects!.filter(fx => fx.enabled)
    const chorus = harmonyEffects.find(fx => fx.type === 'modulation')
    assert(chorus && chorus.params.mode === 0 && chorus.params.mix > 0, 'harmony needs audible chorus')
    assert.deepEqual(harmonyEffects.slice(harmonyEffects.indexOf(chorus) - 1).map(fx => fx.type),
      ['ducker', 'modulation', 'stereo', 'delay', 'reverb'])
    const backingEffects = draft.tracks.find(track => track.id === options.roles.backing)!.effects!.filter(fx => fx.enabled && (fx.type === 'eq' || fx.type === 'stereo'))
    assert.deepEqual(backingEffects.map(fx => fx.type), ['eq'], 'centered backing defaults to EQ only')
    assert(backingEffects[0].params.band3Enabled === 1 && backingEffects[0].params.band3Gain < 0)
    assert(draft.tracks[0].effects?.some(fx => fx.enabled && fx.type === 'eq'))
    assert.deepEqual(draft.masterEffects?.filter(effect => effect.enabled).slice(-2).map(effect => effect.type), ['limiter', 'meter'])
    assert.deepEqual(parseSession(serializeSession(draft)).tracks[0].effects, draft.tracks[0].effects)

    const bypassOnly = bypassAutoMixInserts(session)
    const repeated = await post('auto-mix/analyze', { session: bypassOnly, options })
    const repeatedPlan: AutoMixPlan = await repeated.json()
    assert.equal(repeated.status, 200, JSON.stringify(repeatedPlan))
    assert.deepEqual(repeatedPlan.changes, plan.changes, 'analysis should use the bypassed signal')
    assert.notDeepEqual(repeatedPlan.output, plan.output, 'the original measurement still includes the old effects')

    const rerun = await post('auto-mix/analyze', { session: draft, options })
    const rerunPlan: AutoMixPlan = await rerun.json()
    assert.equal(rerun.status, 200, JSON.stringify(rerunPlan))
    const reapplication = applyAutoMixPlan(draft, rerunPlan, new Set(rerunPlan.changes.map(change => change.id)))
    const olderInserts = draft.tracks[0].effects!
    assert.deepEqual(reapplication.tracks[0].effects?.slice(0, olderInserts.length), olderInserts.map(fx => ({ ...fx, enabled: false })))
    assert.equal(reapplication.tracks[0].effects?.filter(fx => fx.type === 'eq' && fx.enabled).length, 1)

    const previews = await post('auto-mix/preview', { session: draft, range: { start: 2, end: 4 } })
    assert.equal(previews.status, 200)
    assert(Number.isFinite(Number(previews.headers.get('X-Visiki-LUFS'))))
    const pcm = readPcm24(Buffer.from(await previews.arrayBuffer()))
    assert.equal(pcm.frames, 2 * RATE)
    const trimmedPreview = await post('auto-mix/preview', { session: draft, range: { start: 2, end: 4 }, monitorTrimDb: -6 })
    assert.equal(trimmedPreview.status, 200)
    const trimmed = readPcm24(Buffer.from(await trimmedPreview.arrayBuffer()))
    assert.equal(trimmed.frames, pcm.frames)
    assert(Math.abs(Number(trimmedPreview.headers.get('X-Visiki-LUFS')) - Number(previews.headers.get('X-Visiki-LUFS')) + 6) < .1)
    for (let frame = 0; frame < pcm.frames; frame += 223) assert(Math.abs(pcm.at(frame) * 10 ** (-6 / 20) - trimmed.at(frame)) < 1e-6)
    const exported = await post('render', { session: draft, includeTail: false })
    const metadata = await exported.json()
    assert.equal(exported.status, 200, JSON.stringify(metadata))
    const final = readPcm24(Buffer.from(await (await fetch(base + metadata.url)).arrayBuffer()))
    for (let frame = 0; frame < pcm.frames; frame += 223) {
      assert(Math.abs(pcm.at(frame) - final.at(2 * RATE + frame)) < .00002)
    }
    const harmonyTrack = draft.tracks.find(track => track.id === options.roles.harmony)!
    const harmonyBalance = harmonyTrack.effects?.find(fx => fx.type === 'ducker')!
    assert.equal(harmonyBalance.sidechainTrackId, options.roles.lead)
    assert.equal(harmonyBalance.params.mode, 1)
    assert.equal(harmonyBalance.params.smoothTrigger, 1)
    const withoutBalance = structuredClone(draft)
    withoutBalance.tracks.find(track => track.id === harmonyTrack.id)!.effects!.find(fx => fx.id === harmonyBalance.id)!.enabled = false
    const reference = await post('auto-mix/preview', { session: withoutBalance, range: { start: 0, end: 12 } })
    assert.equal(reference.status, 200)
    const without = readPcm24(Buffer.from(await reference.arrayBuffer()))
    assert(toneGain(final, 470, .095, 3.2, 3.8) - toneGain(without, 470, .095, 3.2, 3.8) < -.6, 'harmony must make room when lead is present')
    assert(Math.abs(toneGain(final, 470, .095, 11.25, 11.85) - toneGain(without, 470, .095, 11.25, 11.85)) < .3, 'harmony must recover in the lead gap')

    const omitted = plan.changes.find(change => change.kind === 'fader')!
    const retry = await post('auto-mix/analyze', { session, options: { ...options, excludedChangeIds: [omitted.id] } })
    const recalculated: AutoMixPlan = await retry.json()
    assert.equal(retry.status, 200, JSON.stringify(recalculated))
    assert(recalculated.changes.some(change => change.id === omitted.id))
    assert((recalculated.proposedOutput?.truePeak ?? 0) <= -11.9)

    const limited = await post('auto-mix/analyze', { session, options: {
      ...options, space: 'unchanged', delivery: { mode: 'custom', ceilingDb: -12, targetLufs: -8 },
    } })
    const delivery: AutoMixPlan = await limited.json()
    assert.equal(limited.status, 200, JSON.stringify(delivery))
    assert(delivery.changes.some(change => change.kind === 'effect' && change.type === 'limiter'))
    assert((delivery.proposedOutput?.truePeak ?? 0) <= -11.9)
    assert((delivery.proposedOutput?.limitingDb ?? 0) > 0)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('auto mix handles moderate vocal dynamics and short sibilants with a controllable default space', { skip: !ready || !hasFfmpeg }, async () => {
  await initializeDaw()
  const duration = 12
  const tone = (frame: number, hz: number) => Math.sin(2 * Math.PI * hz * frame / RATE)
  // Alternating phrases differ by 6 dB. A 12 ms tapered 6.5 kHz burst occurs
  // every 1.4 s. The first second is a noise-only pause, followed by
  // phrases over stationary broadband noise and 50 Hz hum.
  const lead = (frame: number) => {
    let hash = Math.imul(frame ^ 0x51ed270b, 0x45d9f3b)
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
    const noise = (((hash ^ (hash >>> 16)) >>> 0) / 0x100000000 - .5) * .008 + .003 * tone(frame, 50)
    const time = frame / RATE, phrase = time % 2, voiced = time >= 1 && phrase < 1.45
    const amplitude = Math.floor(time / 2) % 2 ? .12 : .06
    const voice = voiced ? amplitude * (tone(frame, 220) + .55 * tone(frame, 440) + .3 * tone(frame, 880) + .15 * tone(frame, 1760)) : 0
    const burstTime = (time - .45) % 1.4
    const burst = voiced && burstTime >= 0 && burstTime < .012 ? .09 * Math.sin(Math.PI * burstTime / .012) * tone(frame, 6500) : 0
    return voice + burst + noise
  }
  const harmony = (frame: number) => .055 * (tone(frame, 330) + .4 * tone(frame, 660) + .2 * tone(frame, 1320))
  const backing = (frame: number) => .065 * tone(frame, 110) + .045 * tone(frame, 550)
  let session = createSession('温和动态与短齿音')
  for (const [name, sample] of [['主唱', lead], ['和声', harmony], ['伴奏', backing]] as const) {
    const source = await importDawAudio(await sourceFile(asset(randomUUID(), 2, duration * RATE), sample), `${name}.wav`)
    session = addTrack({ ...session, assets: [...session.assets, source] }, { ...sessionWith(source).tracks[0], name })
  }
  const options = defaultAutoMixOptions(session)
  assert(options.roles.harmony)
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/daw', dawRouter)
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const analyze = async (requestOptions: typeof options, input = session) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/daw/auto-mix/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: input, options: requestOptions }),
    })
    const result: AutoMixPlan = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  try {
    const plan = await analyze(options)
    const effectFor = (type: string, target: string) => plan.changes.find(change => change.kind === 'effect' && change.type === type && change.target === target)
    const denoise = effectFor('denoise', options.roles.lead)
    assert(denoise?.kind === 'effect' && denoise.noiseProfile?.length === 128, 'stationary noise-only pause should yield a learned profile')
    assert(denoise.noiseProfile.every(value => Number.isFinite(value) && value >= -180 && value <= 40))
    const compressor = effectFor('compressor', options.roles.lead)
    assert(compressor && compressor.kind === 'effect', `moderate dynamics need a compressor: ${JSON.stringify(plan)}`)
    assert(compressor.params.ratio > 1 && compressor.params.ratio <= 2)
    assert(Number.isFinite(compressor.params.thresholdDb))
    const deesser = effectFor('deesser', options.roles.lead)
    assert(deesser && deesser.kind === 'effect', `short sibilants need a de-esser: ${JSON.stringify(plan)}`)
    assert(Number.isFinite(deesser.params.freqHz) && Number.isFinite(deesser.params.thresholdDb) && deesser.params.rangeDb > 0)
    const cleanHarmony = effectFor('deesser', options.roles.harmony)
    assert(cleanHarmony?.kind === 'effect' && cleanHarmony.params.rangeDb === 1, 'clean harmony should use a mild fallback')
    const eq = effectFor('eq', options.roles.lead)
    assert(eq && eq.kind === 'effect' && eq.params.band1Enabled === 1 && eq.params.band1Type === 3)
    assert(eq.params.band3Enabled === 1 && eq.params.band3Gain < 0 && eq.params.band5Enabled === 1 && eq.params.band5Gain !== 0)
    for (const target of [options.roles.lead, options.roles.harmony]) {
      const gate = effectFor('gate', target)
      assert(gate?.kind === 'effect' && Number.isFinite(gate.params.thresholdDb) && gate.params.rangeDb > 0)
      const delay = effectFor('delay', target)
      assert(delay?.kind === 'effect' && delay.params.timeMs !== delay.params.timeRightMs && delay.params.mix > 0)
      const reverb = effectFor('reverb', target)
      assert(reverb && reverb.kind === 'effect', `voiced track needs the default space: ${JSON.stringify(plan)}`)
      assert(reverb.params.mix > 0 && reverb.params.decaySec > 0)
    }
    const applied = applyAutoMixPlan(session, plan, new Set(plan.changes.map(change => change.id)))
    const storedDenoise = applied.tracks.find(track => track.id === options.roles.lead)!.effects!.find(fx => fx.id === denoise.id)!
    assert.deepEqual(storedDenoise.noiseProfile, denoise.noiseProfile)
    assert.deepEqual(parseSession(serializeSession(applied)).tracks.find(track => track.id === options.roles.lead)!.effects!.find(fx => fx.id === denoise.id)!.noiseProfile, denoise.noiseProfile)
    const stored = applied.tracks.find(track => track.id === options.roles.lead)!.effects!.find(fx => fx.id === deesser.id)!
    assert.equal(stored.params.freqHz, deesser.params.freqHz)
    assert.equal(stored.params.thresholdDb, deesser.params.thresholdDb)
    const storedEq = applied.tracks.find(track => track.id === options.roles.lead)!.effects!.find(fx => fx.id === eq.id)!
    assert.equal(storedEq.params.band1Freq, eq.params.band1Freq)
    assert.equal(storedEq.params.band3Gain, eq.params.band3Gain)
    assert.equal(storedEq.params.band5Gain, eq.params.band5Gain)
    const imbalancedSource = await importDawAudio(await sourceFile(asset(randomUUID(), 2, duration * RATE),
      (frame, channel) => backing(frame) * (channel ? .2 : 1)), '偏置伴奏.wav')
    const imbalanced = structuredClone(session)
    imbalanced.assets.push(imbalancedSource)
    const imbalancedTrack = imbalanced.tracks.find(track => track.id === options.roles.backing)!
    imbalancedTrack.clips = sessionWith(imbalancedSource).tracks[0].clips
    const imbalancedPlan = await analyze(options, imbalanced)
    const backingChoices = imbalancedPlan.changes.filter(change => change.kind === 'effect' && change.target === options.roles.backing && (change.type === 'eq' || change.type === 'stereo'))
    assert.deepEqual(backingChoices.map(change => change.kind === 'effect' && change.type), ['stereo'], 'sustained channel imbalance needs stereo only')
    const correction = backingChoices[0]
    assert(correction.kind === 'effect' && correction.params.balance > 0 && correction.params.balance <= 30)
    assert.equal(correction.params.width, 100)
    const imbalancedDraft = applyAutoMixPlan(imbalanced, imbalancedPlan, new Set(imbalancedPlan.changes.map(change => change.id)))
    assert.deepEqual(imbalancedDraft.tracks.map(track => track.clips), imbalanced.tracks.map(track => track.clips))
    const dry = await analyze({ ...options, space: 'unchanged' })
    assert(!dry.changes.some(change => change.kind === 'effect' && ['delay', 'reverb'].includes(change.type)), 'unchanged space skips delay and reverb')
    assert(dry.changes.some(change => change.kind === 'effect' && change.target === options.roles.harmony && change.type === 'modulation'))
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('real native DAW endpoints reject file injection and render the saved built-in chain to downloadable PCM', { skip: !ready || !hasFfmpeg }, async () => {
  await initializeDaw(); await initializeMedia()
  const original = asset(), input = await sourceFile(original, () => .2), imported = await importDawAudio(input, '中文 原生集成.wav')
  const session = sessionWith(imported), target = session.tracks[0].id
  const saved = addEffect(session, target, effect('stereo', { gainDb: -6 }))
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/daw', dawRouter)
  app.get('/api/assets/:id', (req, res) => {
    const record = getAsset(String(req.params.id)); if (!record) { res.sendStatus(404); return }
    res.type(record.contentType).sendFile(assetFile(record), { dotfiles: 'allow' })
  })
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert(address && typeof address !== 'string'); const root = `http://127.0.0.1:${address.port}/api/daw`, client = randomUUID()
  const post = (endpoint: string, body: unknown) => fetch(`${root}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await fetch(`${root}/native/status/${client}`)).status, 200)
    const injection = structuredClone(saved); injection.assets[0].id = randomUUID(); injection.assets[0].url = `/api/daw/assets/${injection.assets[0].id}`; injection.tracks[0].clips[0].assetId = injection.assets[0].id
    Object.assign(injection.assets[0], { file: input, dataOffset: 44 })
    const denied = await post(`/native/command/${client}`, { op: 'session', session: injection })
    assert.equal(denied.status, 404)
    const loaded = await post(`/native/command/${client}`, { op: 'session', session: saved }); assert.equal(loaded.status, 200, JSON.stringify(await loaded.json()))
    const invalid = await post(`/native/command/${client}`, { op: 'monitor', db: 12 }); assert.equal(invalid.status, 400)
    const response = await post('/render', { session: saved, includeTail: false }), result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.sampleCount, 4800); assert.equal(result.tailSeconds, 0)
    assert.equal(result.loudness.integrated, null)
    assert(Number.isFinite(result.loudness.truePeak))
    const download = await fetch(`${root.replace('/api/daw', '')}${result.url}`), downloadedWav = Buffer.from(await download.arrayBuffer()), pcm = readPcm24(downloadedWav)
    assert.equal(download.status, 200); assert.equal(pcm.frames, 4800)
    const transfer = await post(`/renders/${result.id}/to-editor`, {}), editorAsset = await transfer.json()
    assert.equal(transfer.status, 200, JSON.stringify(editorAsset)); assert.equal(editorAsset.sampleCount, result.sampleCount)
    const media = await fetch(`${root.replace('/api/daw', '')}${editorAsset.url}`)
    assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), downloadedWav)
    const plainResponse = await post('/render', { session }), plainRender = await plainResponse.json()
    assert.equal(plainResponse.status, 200, JSON.stringify(plainRender))
    const plainTransfer = await post(`/renders/${plainRender.id}/to-editor`, {}), plainAsset = await plainTransfer.json()
    assert.equal(plainTransfer.status, 200, JSON.stringify(plainAsset))
    const plainDownload = await fetch(`${root.replace('/api/daw', '')}${plainRender.url}`)
    const plainMedia = await fetch(`${root.replace('/api/daw', '')}${plainAsset.url}`)
    assert.equal(plainDownload.status, 200); assert.equal(plainMedia.status, 200)
    assert.deepEqual(Buffer.from(await plainMedia.arrayBuffer()), Buffer.from(await plainDownload.arrayBuffer()))
    assert.ok(Math.abs(pcm.at(2000) - .2 * Math.pow(10, -6 / 20)) < 3e-7)
    const twoClips = splitClip(session, target, session.tracks[0].clips[0].id, .05)
    const part = twoClips.tracks[0].clips[1].id
    const clipOnly = addEffect(twoClips, clipEffectTarget(part), effect('stereo', { gainDb: -9 }))
    const clipResponse = await post('/render', { session: clipOnly }), clipResult = await clipResponse.json()
    assert.equal(clipResponse.status, 200, JSON.stringify(clipResult))
    const clipDownload = await fetch(`${root.replace('/api/daw', '')}${clipResult.url}`)
    const piece = readPcm24(Buffer.from(await clipDownload.arrayBuffer()))
    assert(Math.abs(piece.at(1300) - .2) < 3e-7)
    assert(Math.abs(piece.at(3400) - .2 * 10 ** (-9 / 20)) < 3e-7)
    const tones = asset(randomUUID(), 2, RATE)
    const matchFile = await sourceFile(tones, (frame, channel) => {
      const tone = (hz: number) => Math.sin(2 * Math.PI * hz * frame / RATE)
      const upper = frame < RATE / 2 ? .08 : .24
      return (channel ? -1 : 1) * (.18 * tone(250) + upper * tone(2500))
    })
    const matchAsset = await importDawAudio(matchFile, '音色匹配.wav')
    const pair = sessionWith(matchAsset)
    const matchTrack = pair.tracks[0].id
    const targetClip = pair.tracks[0].clips[0], referenceClip = { ...targetClip, id: randomUUID(), start: .5, sourceIn: .5, duration: .5 }
    targetClip.duration = .5
    const referenceTrack = createTrack('参考'); referenceTrack.muted = true; referenceTrack.clips = [referenceClip]
    const matchSession = addTrack(pair, referenceTrack)
    const match = await post('/match-eq', { session: matchSession, targetClipId: targetClip.id, referenceClipId: referenceClip.id })
    const suggestion = await match.json()
    assert.equal(match.status, 200, JSON.stringify(suggestion))
    assert(suggestion.gains.length === 6 && suggestion.gains.every((gain: number) => Number.isFinite(gain) && Math.abs(gain) <= 6))
    assert(suggestion.gains[4] > suggestion.gains[1] + 2, JSON.stringify(suggestion))
    assert.equal((await post('/match-eq', { session: matchSession, targetClipId: targetClip.id, referenceClipId: targetClip.id })).status, 400)
    const ownedClip = await post('/match-eq', { session: matchSession, sourceTarget: clipEffectTarget(targetClip.id), referenceClipId: referenceClip.id })
    assert.equal(ownedClip.status, 200)
    assert.deepEqual((await ownedClip.json()).gains, suggestion.gains)
    const outsideAsset = await post('/match-eq', { session: matchSession, sourceTarget: matchTrack, referenceAssetId: imported.id })
    assert.equal(outsideAsset.status, 200, JSON.stringify(await outsideAsset.json()))
    assert.equal((await post('/match-eq', { session: matchSession, sourceTarget: matchTrack, referenceAssetId: '../input.wav' })).status, 400)
    assert.equal((await post('/match-eq', { session: matchSession, sourceTarget: matchTrack, referenceAssetId: imported.id, referenceClipId: referenceClip.id })).status, 400)
    const mixedSession = structuredClone(matchSession)
    mixedSession.tracks[0].clips.push({ ...referenceClip, start: .5 })
    mixedSession.tracks[1].clips = []
    const trackMatch = await post('/match-eq', { session: mixedSession, sourceTarget: matchTrack, referenceAssetId: matchAsset.id })
    const trackSuggestion = await trackMatch.json()
    assert.equal(trackMatch.status, 200, JSON.stringify(trackSuggestion))
    const singleMatch = await post('/match-eq', { session: matchSession, sourceTarget: matchTrack, referenceAssetId: matchAsset.id })
    const singleSuggestion = await singleMatch.json()
    assert.equal(singleMatch.status, 200, JSON.stringify(singleSuggestion))
    assert.notDeepEqual(trackSuggestion.gains, singleSuggestion.gains)
    const masterMatch = await post('/match-eq', { session: mixedSession, sourceTarget: 'master', referenceAssetId: matchAsset.id })
    assert.equal(masterMatch.status, 200)
    assert.deepEqual((await masterMatch.json()).gains, trackSuggestion.gains)
    mixedSession.tracks[0].clips[0].gainDb = -96
    const quietFirst = await post('/match-eq', { session: mixedSession, sourceTarget: matchTrack, referenceAssetId: matchAsset.id })
    const secondOnly = await post('/match-eq', { session: mixedSession, sourceTarget: clipEffectTarget(referenceClip.id), referenceAssetId: matchAsset.id })
    assert.equal(quietFirst.status, 200)
    assert.equal(secondOnly.status, 200)
    assert.deepEqual((await quietFirst.json()).gains, (await secondOnly.json()).gains)
    const disposed = await post(`/native/command/${client}`, { op: 'dispose' }); assert.equal(disposed.status, 200)
    assert.equal((await fetch(`${root}/native/status/${client}`)).status, 200)
    assert.equal(getEffectChain(saved, target)[0].params.gainDb, -6)
  } finally { await nativeCommand(client, { op: 'dispose' }); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
