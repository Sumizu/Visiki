import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { dataRoot, ffmpegPath, registerDawRender } from './media';
import { analyzeDawRhythmFile } from './daw-rhythm';
import { matchEqSources, type MatchEqSource } from './daw-match-eq';
import { appendDawClipCounter, readDawClipCount, readDawLoudnessScan } from './daw-export-quality';
import { killNativeAudio, learnNativeNoise, measureNativeComparison, nativeAudioAvailable, nativeCommand, nativeSession, nativeStatus, renderNativeAudio, renderNativeAutoMixPreview, scanNativeAutoMix } from './daw-native';
import { parseSession, sessionDuration } from '../src/daw/model';
import { denoiseModes, resolveEffectTarget } from '../src/daw/effects';
import { analyzeAutoMix, readAutoMixOptions, readAutoMixRange } from './daw-auto-mix';
import { killVst3Scans, vst3Router } from './daw-vst3';

const MAX_DURATION = 3600;
const MAX_BINS = 12000;
const MAX_TRACKS = 32;
const MAX_CLIPS = 512;
const MAX_ASSETS = 64;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const dawRoot = path.join(dataRoot, 'daw');
const sourceRoot = path.join(dawRoot, 'sources');
const uploadRoot = path.join(dawRoot, 'uploads');
const renderRoot = path.join(dawRoot, 'renders');
const manifestPath = path.join(dawRoot, 'assets.json');
const ffmpegExecutable = path.isAbsolute(ffmpegPath) || !/[\\/]/.test(ffmpegPath) ? ffmpegPath : path.resolve(ffmpegPath);

export interface DawPeakChannel { min: number[]; max: number[] }
export interface DawAssetMetadata {
  id: string; name: string; url: string; duration: number; sampleRate: number;
  channels: 1 | 2; sampleCount: number; peakHopSec: number; peaks: DawPeakChannel[];
}
type AssetSummary = Omit<DawAssetMetadata, 'peaks'>;
export interface DawRenderAsset { id: string; duration: number; sampleRate: number; channels: 1 | 2; file: string }
interface RenderClip { id: string; assetId: string; start: number; sourceIn: number; duration: number; gainDb: number; fadeIn: number; fadeOut: number; envelope?: { time: number; gain: number }[] }
interface RenderTrack { id: string; volumeDb: number; pan: number; muted: boolean; clips: RenderClip[] }
interface RenderSession { name: string; sampleRate: number; masterDb: number; duration?: number; tracks: RenderTrack[] }
export interface DawRenderPlan { args: string[]; filterGraph: string; duration: number; sampleRate: number; sampleCount: number; name: string }

const records = new Map<string, AssetSummary>();
const children = new Set<ChildProcess>();
const jobControllers = new Set<AbortController>();
let initialization: Promise<void> | undefined;
let persistChain = Promise.resolve();
let activeJobs = 0;

function failure(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label}格式无效`);
  return value as Record<string, unknown>;
}
function number(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) throw failure(`${label}超出支持范围`);
  return result;
}
function name(value: unknown, fallback: string): string { return typeof value === 'string' && value.trim() ? value.trim().replace(/[\x00-\x1f]/g, '').slice(0, 200) : fallback; }
function n(value: number): string { return String(Number(value.toFixed(9))); }
function linear(db: number): string { return n(Math.pow(10, db / 20)); }
function sourceFile(id: string): string { return path.join(sourceRoot, `${id}.wav`); }
function metadataFile(id: string): string { return path.join(sourceRoot, `${id}.json`); }
function requireId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw failure('素材标识无效');
  return value;
}
function validateSummary(value: unknown): AssetSummary | undefined {
  try {
    const x = object(value, '素材'); const id = requireId(x.id);
    const sampleRate = number(x.sampleRate, 0, 8000, 192000, '采样率');
    const channels = number(x.channels, 0, 1, 2, '声道数');
    const sampleCount = number(x.sampleCount, 0, 1, MAX_DURATION * sampleRate, '样本数量');
    if (!Number.isInteger(channels) || !Number.isInteger(sampleRate) || !Number.isInteger(sampleCount)) return undefined;
    const duration = sampleCount / sampleRate;
    return { id, name: name(x.name, '音频'), url: `/api/daw/assets/${id}`, duration, sampleRate, channels: channels as 1 | 2,
      sampleCount, peakHopSec: number(x.peakHopSec, 0, 1 / sampleRate, MAX_DURATION, '波形精度') };
  } catch { return undefined; }
}

export async function initializeDaw(): Promise<void> {
  initialization ??= (async () => {
    await Promise.all([fs.mkdir(sourceRoot, { recursive: true }), fs.mkdir(uploadRoot, { recursive: true }), fs.mkdir(renderRoot, { recursive: true })]);
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { assets?: unknown };
      if (Array.isArray(manifest.assets)) for (const raw of manifest.assets) { const summary = validateSummary(raw); if (summary) records.set(summary.id, summary); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('DAW 素材索引无法读取；原始缓存已保留'); }
  })().catch(error => { initialization = undefined; throw error; });
  await initialization;
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function persist(): Promise<void> {
  persistChain = persistChain.catch(() => {}).then(() => atomicJson(manifestPath, { version: 1, assets: [...records.values()] }));
  await persistChain;
}

function runAudio(args: string[], signal: AbortSignal, timeout: number, cwd?: string, inspectLog?: (log: string) => Error | undefined): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable, ['-hide_banner', '-nostdin', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child);
    let log = ''; let reason: Error | undefined;
    const stop = () => { reason = failure('音频任务已取消', 499); child.kill(); };
    const timer = setTimeout(() => { reason = failure('音频处理超时，请尝试更短的文件', 408); child.kill(); }, timeout);
    signal.addEventListener('abort', stop, { once: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', stop); children.delete(child);
      error ? reject(error) : resolve(log);
    };
    child.stderr?.on('data', chunk => {
      log = (log + chunk.toString()).slice(-12000);
      if (!reason) { const error = inspectLog?.(log); if (error) { reason = error; child.kill(); } }
    });
    child.once('error', error => finish(failure(`无法启动 FFmpeg：${error.message}。请检查 FFMPEG_PATH。`)));
    child.once('close', code => finish(reason || (code === 0 ? undefined : failure(`音频处理失败：${log.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 700)}`))));
    if (signal.aborted) stop();
  });
}
export function killDawJobs(): void {
  killVst3Scans();
  killNativeAudio();
  for (const controller of jobControllers) controller.abort();
  for (const child of children) child.kill();
}
async function task<T>(controller: AbortController, work: () => Promise<T>): Promise<T> {
  if (activeJobs >= 1) throw failure('已有音频任务正在处理，请完成后重试', 409);
  controller.signal.throwIfAborted(); activeJobs++; jobControllers.add(controller);
  try { return await work(); } finally { activeJobs--; jobControllers.delete(controller); }
}
function connectionController(req: Request, res: Response): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  if (req.aborted || res.destroyed) controller.abort();
  return { controller, dispose: () => { req.off('aborted', abort); res.off('close', abort); } };
}

interface FloatWavInfo { sampleRate: number; channels: 1 | 2; sampleCount: number; duration: number; dataOffset: number; dataBytes: number }
export async function readFloatWavInfo(file: string): Promise<FloatWavInfo> {
  const handle = await fs.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0);
    if (!['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) || header.toString('ascii', 8, 12) !== 'WAVE') throw failure('无法读取浮点 WAV 缓存');
    let position = 12; let format: { sampleRate: number; channels: number; blockAlign: number; bits: number; encoding: number } | undefined;
    let largeDataBytes: number | undefined;
    const chunk = Buffer.alloc(8);
    while (position + 8 <= fileSize) {
      const { bytesRead } = await handle.read(chunk, 0, 8, position); if (bytesRead !== 8) break;
      const tag = chunk.toString('ascii', 0, 4); const length = chunk.readUInt32LE(4);
      if (tag === 'ds64' && length >= 28) {
        const sizes = Buffer.alloc(24); await handle.read(sizes, 0, sizes.length, position + 8);
        largeDataBytes = Number(sizes.readBigUInt64LE(8));
        if (!Number.isSafeInteger(largeDataBytes)) throw failure('音频缓存过大');
      }
      if (tag === 'fmt ') {
        if (length < 16 || length > 1024) throw failure('WAV 音频格式无效');
        const fmt = Buffer.alloc(length); const read = await handle.read(fmt, 0, length, position + 8);
        if (read.bytesRead !== length) throw failure('WAV 头部不完整');
        let encoding = fmt.readUInt16LE(0);
        if (encoding === 0xfffe && length >= 40) encoding = fmt.readUInt16LE(24);
        format = { encoding, channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4), blockAlign: fmt.readUInt16LE(12), bits: fmt.readUInt16LE(14) };
      }
      if (tag === 'data') {
        if (!format || format.encoding !== 3 || format.bits !== 32 || (format.channels !== 1 && format.channels !== 2) || format.blockAlign !== format.channels * 4) throw failure('仅支持单声道或双声道音频');
        if (format.sampleRate < 8000 || format.sampleRate > 192000) throw failure('支持的采样率范围为 8–192 kHz');
        const dataBytes = length === 0xffffffff ? largeDataBytes : length;
        if (dataBytes === undefined || dataBytes > fileSize - position - 8) throw failure('音频缓存不完整');
        const sampleCount = Math.floor(dataBytes / format.blockAlign); const duration = sampleCount / format.sampleRate;
        if (!sampleCount || duration > MAX_DURATION) throw failure('支持最长 60 分钟的有效音频');
        return { ...format, channels: format.channels as 1 | 2, sampleCount, duration, dataBytes: sampleCount * format.blockAlign, dataOffset: position + 8 };
      }
      position += 8 + length + (length % 2);
    }
    throw failure('未找到 WAV 音频数据');
  } finally { await handle.close(); }
}

/** Reads bounded chunks of the float cache; no full-file PCM buffer or second decode. */
export async function buildFloatPeaks(file: string, info: FloatWavInfo, signal?: AbortSignal): Promise<{ peakHopSec: number; peaks: DawPeakChannel[] }> {
  const hop = Math.max(256, Math.ceil(info.sampleCount / MAX_BINS));
  const bins = Math.ceil(info.sampleCount / hop);
  const peaks: DawPeakChannel[] = Array.from({ length: info.channels }, () => ({ min: Array(bins).fill(Infinity), max: Array(bins).fill(-Infinity) }));
  const stream = createReadStream(file, { start: info.dataOffset, end: info.dataOffset + info.dataBytes - 1, highWaterMark: 65536, signal });
  let carry = Buffer.alloc(0); let sample = 0;
  for await (const raw of stream) {
    signal?.throwIfAborted();
    const buffer = carry.length ? Buffer.concat([carry, raw as Buffer]) : raw as Buffer;
    const usable = buffer.length - buffer.length % 4;
    for (let offset = 0; offset < usable; offset += 4, sample++) {
      const channel = sample % info.channels; const frame = Math.floor(sample / info.channels); const bin = Math.floor(frame / hop);
      const value = buffer.readFloatLE(offset); if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw failure('音频包含无效或超出支持范围的浮点样本');
      peaks[channel].min[bin] = Math.min(peaks[channel].min[bin], value);
      peaks[channel].max[bin] = Math.max(peaks[channel].max[bin], value);
    }
    carry = Buffer.from(buffer.subarray(usable));
  }
  if (sample !== info.sampleCount * info.channels || carry.length) throw failure('音频缓存不完整');
  // Signed peaks deliberately preserve values above 0 dBFS; the UI may visualize clipping.
  for (const channel of peaks) for (let bin = 0; bin < bins; bin++) {
    channel.min[bin] = Number(channel.min[bin].toFixed(6)); channel.max[bin] = Number(channel.max[bin].toFixed(6));
  }
  return { peakHopSec: hop / info.sampleRate, peaks };
}

export async function importDawAudio(input: string, originalName: string, signal = new AbortController().signal): Promise<DawAssetMetadata> {
  await initializeDaw(); signal.throwIfAborted();
  const id = randomUUID(); const output = sourceFile(id);
  try {
    // No -ar/-ac: preserve source sample rate and mono/stereo layout. The size/time
    // caps bound malformed or unsupported streams before metadata validation.
    await runAudio(['-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,mov,mp4,m4a,3gp,3g2,mj2,aac,asf,aiff,ape,wv',
      '-i', input, '-map', '0:a:0', '-vn', '-t', '3600.01', '-fs', '6000000000', '-c:a', 'pcm_f32le', '-rf64', 'auto', output], signal, 10 * 60 * 1000, undefined, log => {
      // Reject unsupported layouts as soon as FFmpeg configures its WAV output,
      // rather than writing gigabytes of multichannel audio before validation.
      const start = log.indexOf('Output #0, wav,'); if (start < 0) return undefined;
      const stream = /Audio:\s*pcm_f32le[^\n]*?,\s*(\d+)\s*Hz,\s*([^,\n]+)/.exec(log.slice(start)); if (!stream) return undefined;
      if (Number(stream[1]) < 8000 || Number(stream[1]) > 192000) return failure('支持的采样率范围为 8–192 kHz');
      if (!/^(mono|stereo|[12] channels?)(\s|$)/.test(stream[2])) return failure('仅支持单声道或双声道音频');
      return undefined;
    });
    const info = await readFloatWavInfo(output);
    const waveform = await buildFloatPeaks(output, info, signal);
    const asset: DawAssetMetadata = { id, name: name(originalName, '音频'), url: `/api/daw/assets/${id}`, duration: info.duration,
      sampleRate: info.sampleRate, channels: info.channels, sampleCount: info.sampleCount, ...waveform };
    signal.throwIfAborted();
    await atomicJson(metadataFile(id), asset);
    const { peaks: _peaks, ...summary } = asset; records.set(id, summary);
    try { await persist(); } catch (error) { records.delete(id); throw error; }
    return asset;
  } catch (error) { await Promise.allSettled([fs.unlink(output), fs.unlink(metadataFile(id))]); throw error; }
}
export async function getDawAsset(id: string): Promise<DawAssetMetadata | undefined> {
  await initializeDaw();
  const summary = await availableDawAsset(id);
  if (!summary) return undefined;
  try {
    const cached = JSON.parse(await fs.readFile(metadataFile(id), 'utf8')) as { peaks: DawPeakChannel[] };
    return { ...summary, peaks: cached.peaks };
  } catch { return undefined; }
}
async function availableDawAsset(id: string): Promise<AssetSummary | undefined> {
  const summary = records.get(id);
  if (!summary) return undefined;
  try { await fs.access(sourceFile(id)); return summary; } catch { return undefined; }
}

function readSession(input: unknown): RenderSession {
  const s = object(input, '混音工程');
  if (s.schema !== 'visiki-daw' || s.version !== 1) throw failure('不支持的混音工程版本');
  const sampleRate = number(s.sampleRate, 48000, 8000, 192000, '工程采样率');
  if (!Number.isInteger(sampleRate)) throw failure('不支持的工程采样率');
  if (!Array.isArray(s.tracks) || s.tracks.length > MAX_TRACKS) throw failure(`最多支持 ${MAX_TRACKS} 条轨道`);
  let count = 0;
  const tracks: RenderTrack[] = s.tracks.map((raw, index) => {
    const t = object(raw, '轨道');
    if (!Array.isArray(t.clips)) throw failure('轨道片段格式无效');
    count += t.clips.length; if (count > MAX_CLIPS) throw failure(`最多支持 ${MAX_CLIPS} 个片段`);
    return { id: typeof t.id === 'string' ? t.id : String(index), muted: t.muted === true,
      volumeDb: number(t.volumeDb, 0, -96, 24, '轨道音量'), pan: number(t.pan, 0, -1, 1, '声像'),
      clips: t.clips.map((rawClip, clipIndex) => {
        const c = object(rawClip, '片段'); const duration = number(c.duration, 0, 1 / 192000, MAX_DURATION, '片段时长');
        const start = number(c.start, 0, 0, MAX_DURATION, '片段位置');
        if (start + duration > MAX_DURATION + 1e-7) throw failure('时间线最长支持 60 分钟');
        let envelope: RenderClip['envelope'];
        if (c.envelope !== undefined) {
          if (!Array.isArray(c.envelope) || c.envelope.length < 2 || c.envelope.length > 16) throw failure('片段包络格式无效');
          let previous = -1;
          envelope = c.envelope.map(rawPoint => {
            const point = object(rawPoint, '包络点');
            const time = number(point.time, -1, 0, duration, '包络时间'); const gain = number(point.gain, -1, 0, 1, '包络增益');
            if (time <= previous) throw failure('片段包络时间必须递增'); previous = time;
            return { time, gain };
          });
          if (envelope[0].time !== 0 || Math.abs(envelope[envelope.length - 1].time - duration) > 1e-8) throw failure('片段包络必须覆盖整个片段');
        }
        const fadeIn = number(c.fadeIn, 0, 0, duration, '淡入时长'); const fadeOut = number(c.fadeOut, 0, 0, duration, '淡出时长');
        if (fadeIn + fadeOut > duration + 1e-8) throw failure('淡入与淡出总长不能超过片段时长');
        return { id: typeof c.id === 'string' ? c.id : `${index}-${clipIndex}`, assetId: requireId(c.assetId), start,
          sourceIn: number(c.sourceIn, 0, 0, MAX_DURATION, '素材起点'), duration, gainDb: number(c.gainDb, 0, -96, 24, '片段增益'),
          fadeIn, fadeOut, ...(envelope ? { envelope } : {}) };
      }) };
  });
  return { name: name(s.name, 'Visiki 混音'), sampleRate, masterDb: number(s.masterDb, 0, -96, 12, '主输出音量'),
    duration: s.duration === undefined ? undefined : number(s.duration, 0, 0, MAX_DURATION, '导出时长'), tracks };
}

/** Resolver-owned UUID caches only; execute the result with cwd fixed to sourceRoot. */
export function buildDawRenderPlan(input: unknown, lookup: (id: string) => DawRenderAsset | undefined): DawRenderPlan {
  const session = readSession(input);
  const sampleRate = session.sampleRate;
  const sourceIds = new Map<string, DawRenderAsset>();
  let duration = session.duration || 0;
  for (const track of session.tracks) for (const clip of track.clips) {
    duration = Math.max(duration, clip.start + clip.duration);
    if (track.muted) continue;
    const asset = lookup(clip.assetId); if (!asset) throw failure('混音工程中有失联素材，请重新导入或静音相关轨道');
    if (asset.channels !== 1 && asset.channels !== 2) throw failure('仅支持单声道或双声道素材');
    if (clip.sourceIn + clip.duration > asset.duration + 1 / asset.sampleRate) throw failure('片段超出原始音频范围');
    sourceIds.set(clip.assetId, asset);
  }
  if (sourceIds.size > MAX_ASSETS) throw failure(`最多支持 ${MAX_ASSETS} 个音频素材`);
  if (!duration) throw failure('请先添加音频片段');
  const sampleCount = Math.max(1, Math.ceil(duration * sampleRate - 1e-7)); duration = sampleCount / sampleRate;
  const args: string[] = ['-y', '-filter_complex_threads', '2']; const filters: string[] = [];
  const trackLabels: string[] = []; let clipNumber = 0;
  for (let trackIndex = 0; trackIndex < session.tracks.length; trackIndex++) {
    const track = session.tracks[trackIndex]; if (track.muted || !track.clips.length) continue;
    const clipLabels: string[] = [];
    for (const clip of track.clips) {
      const asset = sourceIds.get(clip.assetId)!;
      const sourceStart = Math.round(clip.sourceIn * asset.sampleRate);
      const sourceEnd = sourceStart + Math.max(1, Math.round(clip.duration * asset.sampleRate));
      const chain = [`atrim=start_pts=${sourceStart}:end_pts=${sourceEnd}`, 'asetpts=PTS-STARTPTS', `aresample=${sampleRate}`];
      // Mono uses equal-power gains; stereo uses StereoPannerNode's channel matrix.
      if (asset.channels === 1) {
        const angle = (track.pan + 1) * Math.PI / 4;
        chain.push(`pan=stereo|c0=${n(Math.cos(angle))}*c0|c1=${n(Math.sin(angle))}*c0`);
      } else if (track.pan >= 0) {
        const angle = track.pan * Math.PI / 2;
        chain.push(`pan=stereo|c0=${n(Math.cos(angle))}*c0|c1=c1+${n(Math.sin(angle))}*c0`);
      } else {
        const angle = -track.pan * Math.PI / 2;
        chain.push(`pan=stereo|c0=c0+${n(Math.sin(angle))}*c1|c1=${n(Math.cos(angle))}*c1`);
      }
      chain.push(`volume=${linear(clip.gainDb)}`);
      if (clip.envelope) {
        const points = clip.envelope; let expression = n(points[points.length - 1].gain);
        for (let i = points.length - 2; i >= 0; i--) {
          const left = points[i], right = points[i + 1];
          const ramp = `${n(left.gain)}+(t-${n(left.time)})*${n((right.gain - left.gain) / (right.time - left.time))}`;
          expression = `if(lt(t,${n(right.time)}),${ramp},${expression})`;
        }
        expression = `if(lt(t,${n(points[0].time)}),${n(points[0].gain)},${expression})`;
        chain.push(`aeval=exprs='val(0)*(${expression})|val(1)*(${expression})':channel_layout=stereo`);
      } else {
        if (clip.fadeIn) chain.push(`afade=t=in:st=0:d=${n(clip.fadeIn)}:curve=tri`);
        if (clip.fadeOut) chain.push(`afade=t=out:st=${n(clip.duration - clip.fadeOut)}:d=${n(clip.fadeOut)}:curve=tri`);
      }
      const index = clipNumber++; const label = `c${index}`; const delay = Math.round(clip.start * sampleRate);
      // Independent, seekable float-cache readers avoid asplit queues retaining
      // a long source while a later clip waits. One decoder thread per reader.
      // Seek slightly before the requested sample. PCM WAV readers keep a
      // 1/sampleRate time base; integer PTS trimming then removes seek rounding.
      const source = `amovie=filename=${requireId(asset.id)}.wav:seek_point=${n(Math.max(0, clip.sourceIn - .05))}:dec_threads=1`;
      filters.push(`${source},${chain.join(',')}[${delay ? `body${index}` : label}]`);
      if (delay) {
        // adelay allocates a delay line proportional to absolute timeline time.
        // Generate the silent prefix lazily instead, with bounded frame buffers.
        filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${delay}[silence${index}]`);
        filters.push(`[silence${index}][body${index}]concat=n=2:v=0:a=1[${label}]`);
      }
      clipLabels.push(label);
    }
    const label = `t${trackIndex}`;
    filters.push(`${clipLabels.map(x => `[${x}]`).join('')}${clipLabels.length > 1 ? `amix=inputs=${clipLabels.length}:duration=longest:dropout_transition=0:normalize=0,` : ''}volume=${linear(track.volumeDb)}[${label}]`);
    trackLabels.push(label);
  }
  if (!trackLabels.length) filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${sampleCount}[mix]`);
  else filters.push(`${trackLabels.map(x => `[${x}]`).join('')}${trackLabels.length > 1 ? `amix=inputs=${trackLabels.length}:duration=longest:dropout_transition=0:normalize=0,` : ''}volume=${linear(session.masterDb)},apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS[mix]`);
  const filterGraph = filters.join(';');
  return { args, filterGraph, duration, sampleRate, sampleCount, name: `${session.name.replace(/[<>:"/\\|?*]/g, '_')}.wav` };
}

export const dawRouter = Router();
dawRouter.use(async (_req, _res, next) => { try { await initializeDaw(); next(); } catch (error) { next(error); } });
dawRouter.use('/vst3', vst3Router);

async function resolvedNativeSession(input: unknown, preview: boolean) {
  return nativeSession(input, async id => {
    const asset = records.get(id); if (!asset) return undefined;
    try { return { ...await readFloatWavInfo(sourceFile(id)), file: sourceFile(id) }; } catch { return undefined; }
  }, preview);
}
dawRouter.get('/native/status/:id', (req, res) => {
  const rawCursor = req.query.vst3After;
  const cursor = rawCursor === undefined ? undefined : typeof rawCursor === 'string' && /^(0|[1-9][0-9]*)$/.test(rawCursor) ? Number(rawCursor) : NaN;
  res.json(nativeStatus(String(req.params.id), cursor, req.query.vst3HostId));
});
dawRouter.post('/native/command/:id', async (req, res) => {
  const command = object(req.body, '原生音频操作');
  const op = String(command.op);
  if (op === 'session') res.json(await nativeCommand(String(req.params.id), { op, revision: command.revision, compareDb: command.compareDb, vst3After: command.vst3After, vst3HostId: command.vst3HostId, session: await resolvedNativeSession(command.session, true) }));
  else if (op === 'mix') res.json(await nativeCommand(String(req.params.id), { op, baseRevision: command.baseRevision, revision: command.revision, compareDb: command.compareDb, vst3After: command.vst3After, vst3HostId: command.vst3HostId, mix: command.mix }));
  else if (op === 'listen-noise' || op === 'vst3-open') res.json(await nativeCommand(String(req.params.id), { op, effectId: command.effectId }));
  else if (op === 'vst3-parameter-values') res.json(await nativeCommand(String(req.params.id), { op, requests: command.requests }));
  else res.json(await nativeCommand(String(req.params.id), { op, ...(command.position !== undefined ? { position: command.position } : {}), ...(command.db !== undefined ? { db: command.db } : {}), ...(command.compareDb !== undefined ? { compareDb: command.compareDb } : {}) }));
});
dawRouter.post('/native/learn-noise', async (req, res) => {
  const input = object(req.body, '学习噪声');
  const noiseStart = number(input.start, 0, 0, MAX_DURATION, '底噪起点');
  const noiseDuration = number(input.duration, 1, .5, 3, '底噪时长');
  const noiseTarget = input.target, noiseEffect = input.effectId;
  const connection = connectionController(req, res);
  const job = path.join(renderRoot, `${randomUUID()}.noise.json`);
  try {
    const noiseProfile = await task(connection.controller, async () => {
      const session = await resolvedNativeSession(input.session, true);
      const solo = session.tracks.some(track => track.solo);
      const owner = typeof noiseTarget === 'string' ? resolveEffectTarget(session, noiseTarget) : undefined;
      const audible = owner && (owner.kind === 'master' || !owner.track.muted && (!solo || owner.track.solo));
      const chain = audible && (owner.kind === 'master' ? session.masterEffects : owner.kind === 'clip' ? owner.clip.effects : owner.track.effects);
      const effect = chain && chain.find(item => item.id === noiseEffect);
      if (!effect || !effect.enabled || effect.type !== 'denoise' || !denoiseModes(effect.params).spectralEnabled) throw failure('请在当前可听的片段、轨道或主输出上开启频谱去噪。');
      if (owner?.kind === 'clip' && (noiseStart < owner.clip.start - .5 / session.sampleRate ||
          noiseStart + noiseDuration > owner.clip.start + owner.clip.duration + .5 / session.sampleRate)) throw failure('底噪区间超出所选片段。');
      if (noiseStart + noiseDuration > sessionDuration(session) + .5 / session.sampleRate) throw failure('底噪区间超出工程范围。');
      return learnNativeNoise({ ...session, noiseTarget, noiseEffect, noiseStart, noiseDuration }, job, connection.controller.signal);
    });
    if (!res.destroyed) res.json({ noiseProfile });
  } finally { connection.dispose(); await fs.unlink(job).catch(() => {}); }
});
dawRouter.post('/native/compare', async (req, res) => {
  const input = object(req.body, '等响度比较');
  const compareId = typeof input.effectId === 'string' ? input.effectId : '';
  const comparePosition = number(input.position, 0, 0, MAX_DURATION + 30, '试听位置');
  const connection = connectionController(req, res);
  const job = path.join(renderRoot, `${randomUUID()}.compare.json`);
  try {
    const result = await task(connection.controller, async () => {
      const session = await resolvedNativeSession(input.session, true);
      const solo = session.tracks.some(track => track.solo);
      const audibleTracks = session.tracks.filter(track => !track.muted && (!solo || track.solo));
      const effect = [...session.masterEffects ?? [],
        ...audibleTracks.flatMap(track => [...track.effects ?? [], ...track.clips.flatMap(clip => clip.effects ?? [])]),
      ].find(item => item.id === compareId);
      if (!effect?.enabled || !effect.bState || effect.type === 'meter') throw failure('请启用效果并准备 A、B 两组参数后再测量。');
      return measureNativeComparison({ ...session, compareId, comparePosition }, job, connection.controller.signal);
    });
    if (!res.destroyed) res.json(result);
  } finally { connection.dispose(); await fs.unlink(job).catch(() => {}); }
});
dawRouter.post('/auto-mix/analyze', async (req, res) => {
  const body = object(req.body, '自动混音请求');
  const session = parseSession(body.session);
  const options = readAutoMixOptions(body.options, session);
  const connection = connectionController(req, res);
  const job = path.join(renderRoot, `${randomUUID()}.automix.json`);
  try {
    const result = await task(connection.controller, () => analyzeAutoMix(session, options, async (current, roleIds, probes, outputOnly) => {
      const resolved = await resolvedNativeSession(current, false);
      return scanNativeAutoMix({ ...resolved, autoMixTrackIds: roleIds, autoMixProbeIds: probes,
        autoMixBackingTrackId: options.roles.backing, autoMixOutputOnly: outputOnly }, job, connection.controller.signal);
    }, async (current, noiseTarget, noiseEffect, range) => {
      const resolved = await resolvedNativeSession(current, false);
      try {
        return await learnNativeNoise({ ...resolved, noiseTarget, noiseEffect, noisePreview: false,
          noiseStart: range.start, noiseDuration: range.end - range.start }, job, connection.controller.signal);
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 422) return null;
        throw error;
      }
    }));
    if (!res.destroyed) res.json(result);
  } finally { connection.dispose(); await fs.unlink(job).catch(() => {}); }
});
dawRouter.post('/auto-mix/preview', async (req, res) => {
  const body = object(req.body, '自动混音试听');
  if (body.preview !== undefined && typeof body.preview !== 'boolean') throw failure('试听模式无效');
  const monitoring = body.preview === true;
  const monitorTrimDb = number(body.monitorTrimDb, 0, -60, 0, '试听补偿');
  const connection = connectionController(req, res);
  const id = randomUUID();
  const job = path.join(renderRoot, `${id}.preview.json`);
  const file = path.join(renderRoot, `${id}.preview.wav`);
  try {
    const rendered = await task(connection.controller, async () => {
      const session = await resolvedNativeSession(body.session, monitoring);
      const range = readAutoMixRange(body.range, sessionDuration(session), 20);
      return renderNativeAutoMixPreview({ ...session, autoMixStart: range.start, autoMixDuration: range.end - range.start, monitoring, monitorTrimDb },
        job, file, connection.controller.signal);
    });
    if (res.destroyed) return;
    const { integrated, truePeak } = rendered.loudness ?? {};
    if (typeof integrated === 'number') res.setHeader('X-Visiki-LUFS', String(integrated));
    if (typeof truePeak === 'number') res.setHeader('X-Visiki-True-Peak', String(truePeak));
    res.setHeader('Cache-Control', 'no-store');
    res.type('audio/wav');
    await new Promise<void>((resolve, reject) => {
      res.sendFile(file, { dotfiles: 'allow' }, error => error && !res.destroyed ? reject(error) : resolve());
    });
  } finally { connection.dispose(); await Promise.allSettled([fs.unlink(job), fs.unlink(file)]); }
});
const upload = multer({ dest: uploadRoot, limits: { fileSize: 512 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => {
  file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); callback(null, true);
} });
dawRouter.post('/assets', upload.single('file'), async (req, res) => {
  if (!req.file) throw failure('请选择音频文件');
  const connection = connectionController(req, res);
  try {
    const asset = await task(connection.controller, () => importDawAudio(req.file!.path, req.file!.originalname, connection.controller.signal));
    if (!res.destroyed) res.json(req.query.summary === '1' ? records.get(asset.id) : asset);
  }
  finally { connection.dispose(); await fs.unlink(req.file.path).catch(() => {}); }
});
dawRouter.get('/assets', async (req, res) => {
  const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter(id => idPattern.test(id)).slice(0, MAX_ASSETS) : [...records.keys()].slice(-MAX_ASSETS);
  const lookup = req.query.summary === '1' ? availableDawAsset : getDawAsset;
  const assets = (await Promise.all(ids.map(lookup))).filter(Boolean);
  res.json({ assets });
});
dawRouter.get('/assets/:id/metadata', async (req, res) => {
  const id = requireId(req.params.id);
  if (req.query.summary === '1') {
    const summary = await availableDawAsset(id);
    if (!summary) throw failure('音频素材已失联，请重新导入', 404);
    res.json({ ...summary, peaks: [] });
    return;
  }
  const asset = await getDawAsset(id); if (!asset) throw failure('音频素材已失联，请重新导入', 404); res.json(asset);
});
dawRouter.get('/assets/:id', async (req, res) => {
  const id = requireId(req.params.id); if (!records.has(id)) throw failure('音频素材已失联，请重新导入', 404);
  res.type('audio/wav'); res.setHeader('Cache-Control', 'private, max-age=86400'); res.sendFile(sourceFile(id), { dotfiles: 'allow' });
});

dawRouter.post('/match-eq', async (req, res) => {
  const input = object(req.body, '匹配均衡参数');
  const sourceTarget = input.sourceTarget;
  const targetId = input.targetClipId, referenceId = input.referenceClipId, referenceAssetId = input.referenceAssetId;
  if (sourceTarget !== undefined ? typeof sourceTarget !== 'string' || !sourceTarget : typeof targetId !== 'string' || !targetId) throw failure('请选择要匹配的音频');
  const clipReference = referenceId !== undefined, assetReference = referenceAssetId !== undefined;
  if (clipReference === assetReference || (clipReference && (typeof referenceId !== 'string' || !referenceId))) throw failure('请选择一个参考音频');
  if (assetReference) requireId(referenceAssetId);
  const connection = connectionController(req, res);
  try {
    const gains = await task(connection.controller, async () => {
      await initializeDaw();
      const session = readSession(input.session);
      const rawSession = object(input.session, '混音工程');
      if (!Array.isArray(rawSession.assets) || rawSession.assets.length > MAX_ASSETS) throw failure('工程素材格式无效');
      const assets = new Set(rawSession.assets.map(raw => requireId(object(raw, '素材').id)));
      const clips = session.tracks.flatMap(track => track.clips);
      const fromAsset = async (id: string, requireSessionAsset: boolean): Promise<MatchEqSource> => {
        if ((requireSessionAsset && !assets.has(id)) || !records.has(id)) throw failure('音频素材已失联，请重新导入', 404);
        const file = sourceFile(id);
        let info: Awaited<ReturnType<typeof readFloatWavInfo>>;
        try { info = await readFloatWavInfo(file); } catch { throw failure('音频素材缓存不可用，请重新导入', 404); }
        return { file, info, sourceIn: 0, duration: info.duration };
      };
      const select = async (id: string): Promise<MatchEqSource> => {
        const matches = clips.filter(clip => clip.id === id);
        if (matches.length !== 1) throw failure('所选片段不存在或标识重复');
        const clip = matches[0];
        const source = await fromAsset(clip.assetId, true);
        if (clip.sourceIn + clip.duration > (source.info.sampleCount + 1) / source.info.sampleRate) throw failure('片段超出原始音频范围');
        return { ...source, sourceIn: clip.sourceIn, duration: clip.duration };
      };
      let target: MatchEqSource | MatchEqSource[];
      const owner = sourceTarget === undefined ? `clip:${targetId}` : sourceTarget as string;
      if (owner.startsWith('clip:')) {
        const id = owner.slice(5);
        if (clipReference && id === referenceId) throw failure('请选择两个不同的音频片段');
        target = await select(id);
      } else {
        const rawTracks = rawSession.tracks as Record<string, unknown>[];
        const anySolo = rawTracks.some(track => track.solo === true);
        const tracks = owner === 'master'
          ? session.tracks.filter((track, i) => !track.muted && (!anySolo || rawTracks[i].solo === true))
          : session.tracks.filter(track => track.id === owner);
        if (owner !== 'master' && tracks.length !== 1) throw failure('所选轨道不存在或标识重复');
        const candidates = tracks.flatMap(track => track.clips.map(clip => ({ clip, gain: 10 ** ((clip.gainDb + track.volumeDb) / 20) })))
          .sort((a, b) => a.clip.start - b.clip.start);
        if (!candidates.length) throw failure('所选轨道没有可分析的音频');
        // Spread a fixed eight-second budget over the timeline instead of taking its first clip.
        const count = Math.min(16, candidates.length);
        const sampled = Array.from({ length: count }, (_, i) => candidates[Math.floor((i + .5) * candidates.length / count)]);
        target = [];
        let remaining = 8;
        for (let i = 0; i < sampled.length; i++) {
          const { clip, gain } = sampled[i];
          const source = await select(clip.id);
          const duration = Math.min(source.duration, remaining / (sampled.length - i));
          remaining -= duration;
          target.push({ ...source, sourceIn: source.sourceIn + (source.duration - duration) / 2, duration, gain });
        }
      }
      const reference = clipReference ? await select(referenceId as string) : await fromAsset(requireId(referenceAssetId), false);
      return matchEqSources(target, reference, connection.controller.signal);
    });
    if (!res.destroyed) res.json({ gains });
  } finally { connection.dispose(); }
});

dawRouter.post('/analyze-rhythm', async (req, res) => {
  const input = object(req.body, '节奏分析参数'); const assetId = requireId(input.assetId);
  if (!records.has(assetId)) throw failure('音频素材已失联，请重新导入', 404);
  const file = sourceFile(assetId);
  try { await fs.access(file); } catch { throw failure('音频素材已失联，请重新导入', 404); }
  const connection = connectionController(req, res);
  try {
    const result = await task(connection.controller, async () => {
      const info = await readFloatWavInfo(file);
      return analyzeDawRhythmFile({ assetId, file, info }, input, connection.controller.signal);
    });
    if (!res.destroyed) res.json(result);
  } finally { connection.dispose(); }
});
dawRouter.post('/render', async (req, res) => {
  const connection = connectionController(req, res); const id = randomUUID(); const file = path.join(renderRoot, `${id}.wav`);
  const graphFile = path.join(renderRoot, `${id}.filter.txt`);
  try {
    const result = await task(connection.controller, async () => {
      const raw = req.body?.session;
      if (raw?.masterEffects?.length || Array.isArray(raw?.tracks) && raw.tracks.some((track: { effects?: unknown[]; clips?: { effects?: unknown[] }[] } | null) =>
        track?.effects?.length || Array.isArray(track?.clips) && track.clips.some((clip: { effects?: unknown[] } | null) => clip?.effects?.length))) {
        const session = await resolvedNativeSession(raw, false);
        const jobFile = path.join(renderRoot, `${id}.native.json`);
        try {
          const rendered = await renderNativeAudio({ ...session, includeTail: req.body.includeTail !== false }, jobFile, file, connection.controller.signal);
          const renderName = `${session.name.replace(/[<>:"/\\|?*]/g, '_')}.wav`;
          await atomicJson(path.join(renderRoot, `${id}.json`), { name: renderName, ...rendered });
          return { id, url: `/api/daw/renders/${id}`, name: renderName, duration: rendered.duration, sampleRate: rendered.sampleRate, sampleCount: rendered.sampleCount, channels: 2, loudness: rendered.loudness, clippedSamples: rendered.clippedSamples ?? null, tailSeconds: rendered.tailSeconds };
        } finally { await fs.unlink(jobFile).catch(() => {}); }
      }
      const plan = buildDawRenderPlan(req.body?.session, assetId => {
        const asset = records.get(assetId); return asset ? { ...asset, file: sourceFile(assetId) } : undefined;
      });
      await fs.writeFile(graphFile, appendDawClipCounter(plan.filterGraph));
      const mixLog = await runAudio([...plan.args, '-nostats', '-filter_complex_script', graphFile, '-map', '[export]', '-ar', String(plan.sampleRate), '-ac', '2', '-c:a', 'pcm_s24le', '-rf64', 'auto', file, '-map', '[clipStats]', '-c:a', 'pcm_f64le', '-f', 'null', '-'], connection.controller.signal, 20 * 60 * 1000, sourceRoot);
      const clippedSamples = readDawClipCount(mixLog);
      const scan = await runAudio(['-nostats', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], connection.controller.signal, 20 * 60 * 1000).catch(error => {
        connection.controller.signal.throwIfAborted();
        console.warn('DAW WAV 响度测量未完成:', (error as Error).message);
        return '';
      });
      const loudness = readDawLoudnessScan(scan, plan.duration);
      connection.controller.signal.throwIfAborted();
      const metadata = { name: plan.name, duration: plan.duration, sampleRate: plan.sampleRate, sampleCount: plan.sampleCount, loudness, clippedSamples, tailSeconds: 0 };
      await atomicJson(path.join(renderRoot, `${id}.json`), metadata);
      return { id, url: `/api/daw/renders/${id}`, channels: 2, ...metadata };
    });
    if (!res.destroyed) res.json(result);
  } catch (error) { await Promise.allSettled([fs.unlink(file), fs.unlink(path.join(renderRoot, `${id}.json`))]); throw error; }
  finally { connection.dispose(); await fs.unlink(graphFile).catch(() => {}); }
});
dawRouter.get('/renders/:id', async (req, res) => {
  const id = requireId(req.params.id);
  let renderName = 'Visiki 混音.wav';
  try { const cached = JSON.parse(await fs.readFile(path.join(renderRoot, `${id}.json`), 'utf8')); renderName = name(cached.name, renderName); }
  catch { throw failure('导出文件不存在', 404); }
  res.download(path.join(renderRoot, `${id}.wav`), renderName, { dotfiles: 'allow' });
});
dawRouter.post('/renders/:id/to-editor', async (req, res) => {
  const id = requireId(req.params.id);
  let metadata: { name?: unknown; sampleRate?: unknown; sampleCount?: unknown };
  try { metadata = JSON.parse(await fs.readFile(path.join(renderRoot, `${id}.json`), 'utf8')); }
  catch { throw failure('导出文件不存在或尚未完成', 404); }
  if (!metadata || !Number.isInteger(metadata.sampleRate) || !Number.isInteger(metadata.sampleCount)) throw failure('导出信息无效');
  try {
    const asset = await registerDawRender(id, path.join(renderRoot, `${id}.wav`), name(metadata.name, 'Visiki 混音.wav'),
      { sampleRate: metadata.sampleRate as number, sampleCount: metadata.sampleCount as number });
    res.json(asset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure('导出文件不存在或尚未完成', 404);
    throw error;
  }
});
