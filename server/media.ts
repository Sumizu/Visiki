import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '../src/types';
export const dataRoot = path.resolve(process.env.VISIKI_DATA_DIR || process.env.ECHO_DATA_DIR || path.join(process.cwd(), '.demo-data'));
export const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
export interface AssetRecord { asset: MediaAsset; file: string; contentType: string; poster?: string }
const assets = new Map<string, AssetRecord>();
const manifestPath = path.join(dataRoot, 'assets.json');
export async function initializeMedia() {
  await fs.mkdir(path.join(dataRoot, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'exports'), { recursive: true });
  try {
    const records: AssetRecord[] = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    for (const record of records) {
      const candidate = path.resolve(dataRoot, record.file);
      if (candidate.startsWith(dataRoot + path.sep) && /^[a-zA-Z0-9-]+$/.test(record.asset.id)) assets.set(record.asset.id, record);
    }
  } catch { /* New demo cache. A damaged manifest does not authorize arbitrary file access. */ }
}
let saveChain = Promise.resolve();
async function persist() {
  saveChain = saveChain.catch(() => {}).then(async () => {
    const temporary = `${manifestPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify([...assets.values()], null, 2));
    await fs.rename(temporary, manifestPath);
  });
  await saveChain;
}
export function getAsset(id: string) { return assets.get(id); }
export function assetFile(record: AssetRecord) { return path.resolve(dataRoot, record.file); }
export function videoPosterFile(record: AssetRecord): string | null {
  if (!record.poster) return null;
  const file = path.resolve(dataRoot, record.poster);
  return file.startsWith(dataRoot + path.sep) ? file : null;
}
export function runFFmpeg(args: string[], timeout = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('媒体处理超时，请尝试较短的文件')); }, timeout);
    child.stderr.on('data', data => { output = (output + data.toString()).slice(-20000); });
    child.once('error', error => { clearTimeout(timer); reject(new Error(`无法启动 FFmpeg：${error.message}。请设置 FFMPEG_PATH。`)); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`媒体处理失败：${output.split('\n').filter(Boolean).slice(-4).join(' ')}`)); });
  });
}
export async function readWavInfo(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(65536); const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('规范化 WAV 格式无效');
    let position = 12; let sampleRate = 48000, channels = 2, blockAlign = 4;
    while (position + 8 <= bytesRead) {
      const tag = head.toString('ascii', position, position + 4); const size = head.readUInt32LE(position + 4);
      if (tag === 'fmt ') { channels = head.readUInt16LE(position + 10); sampleRate = head.readUInt32LE(position + 12); blockAlign = head.readUInt16LE(position + 20); }
      if (tag === 'data') return { sampleRate, channels, sampleCount: Math.floor(size / blockAlign), duration: Math.floor(size / blockAlign) / sampleRate };
      position += 8 + size + (size % 2);
    }
    throw new Error('未找到 WAV 音频数据');
  } finally { await handle.close(); }
}
export async function importAudio(inputFile: string, name: string, fixedId?: string): Promise<MediaAsset> {
  const id = fixedId || randomUUID(); const output = path.join(dataRoot, 'uploads', `${id}.wav`);
  await runFFmpeg(['-y','-i',inputFile,'-map','0:a:0','-vn','-ar','48000','-ac','2','-c:a','pcm_s16le',output]);
  const info = await readWavInfo(output);
  if (!info.sampleCount || info.duration > 3600) { await fs.unlink(output).catch(() => {}); throw new Error('Demo 支持最长 60 分钟的有效音频'); }
  const asset: MediaAsset = { id, name, type: 'audio', url: `/api/assets/${id}`, ...info };
  assets.set(id, { asset, file: path.relative(dataRoot, output), contentType: 'audio/wav' }); await persist(); return asset;
}
// A completed DAW render is already a WAV in our persistent data directory.
// Keep the original PCM and use the same manifest and serving path as uploads.
const renderRegistrations = new Map<string, Promise<MediaAsset>>();
async function readDawRenderInfo(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(12);
    if (!stat.isFile() || (await handle.read(header, 0, 12, 0)).bytesRead !== 12 ||
        !['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('导出 WAV 格式无效');
    let position = 12, sampleRate = 0, channels = 0, blockAlign = 0, largeDataBytes: number | undefined;
    const chunk = Buffer.alloc(8);
    while (position + 8 <= stat.size) {
      if ((await handle.read(chunk, 0, 8, position)).bytesRead !== 8) break;
      const tag = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4), start = position + 8;
      if (tag === 'data') {
        const bytes = size === 0xffffffff ? largeDataBytes : size;
        if (!blockAlign || bytes === undefined || !Number.isSafeInteger(bytes) || bytes < blockAlign || bytes % blockAlign || bytes > stat.size - start) break;
        const sampleCount = bytes / blockAlign;
        return { sampleRate, channels, sampleCount, duration: sampleCount / sampleRate };
      }
      if (size > stat.size - start) break;
      if (tag === 'ds64' && size >= 28) {
        const sizes = Buffer.alloc(16); if ((await handle.read(sizes, 0, 16, start)).bytesRead !== 16) break;
        largeDataBytes = Number(sizes.readBigUInt64LE(8));
      }
      if (tag === 'fmt ' && size >= 16 && size <= 1024) {
        const fmt = Buffer.alloc(size); if ((await handle.read(fmt, 0, size, start)).bytesRead !== size) break;
        let encoding = fmt.readUInt16LE(0);
        if (encoding === 0xfffe && size >= 40) encoding = fmt.readUInt16LE(24);
        channels = fmt.readUInt16LE(2); sampleRate = fmt.readUInt32LE(4); blockAlign = fmt.readUInt16LE(12);
        if (encoding !== 1 || channels !== 2 || sampleRate < 8000 || sampleRate > 192000 ||
            fmt.readUInt16LE(14) !== 24 || blockAlign !== channels * 3) break;
      }
      position = start + size + size % 2;
    }
    throw new Error('导出 WAV 不完整或格式无效');
  } finally { await handle.close(); }
}
export async function registerDawRender(id: string, file: string, name: string, expected: { sampleRate: number; sampleCount: number }): Promise<MediaAsset> {
  const running = renderRegistrations.get(id);
  if (running) return running;
  const work = (async () => {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(dataRoot + path.sep)) throw new Error('导出文件路径无效');
    const info = await readDawRenderInfo(resolved);
    if (info.sampleRate !== expected.sampleRate || info.sampleCount !== expected.sampleCount) throw new Error('导出 WAV 与导出信息不一致');
    const existing = assets.get(id);
    if (existing) {
      if (assetFile(existing) !== resolved || existing.asset.type !== 'audio') throw new Error('素材标识已被占用');
      return existing.asset;
    }
    const asset: MediaAsset = { id, name, type: 'audio', url: `/api/assets/${id}`, ...info };
    const record = { asset, file: path.relative(dataRoot, resolved), contentType: 'audio/wav' };
    assets.set(id, record);
    try { await persist(); } catch (error) { if (assets.get(id) === record) assets.delete(id); throw error; }
    return asset;
  })();
  renderRegistrations.set(id, work);
  try { return await work; } finally { if (renderRegistrations.get(id) === work) renderRegistrations.delete(id); }
}
export async function importImage(inputFile: string, name: string): Promise<MediaAsset> {
  const id = randomUUID(); const output = path.join(dataRoot, 'uploads', `${id}.png`);
  await runFFmpeg(['-y','-i',inputFile,'-frames:v','1','-vf',"scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",output], 60000);
  const asset: MediaAsset = { id, name, type: 'image', url: `/api/assets/${id}` };
  assets.set(id, { asset, file: path.relative(dataRoot, output), contentType: 'image/png' }); await persist(); return asset;
}
export async function importVideo(inputFile: string, name: string): Promise<MediaAsset> {
  const id = randomUUID(); const output = path.join(dataRoot, 'uploads', `${id}.mp4`);
  const poster = path.join(dataRoot, 'uploads', `${id}-poster.png`);
  try {
    const probe = await runFFmpeg(['-i', inputFile, '-map', '0:v:0', '-an', '-frames:v', '1', '-f', 'null', '-'], 60000);
    const inputDuration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe);
    if (inputDuration && Number(inputDuration[1]) * 3600 + Number(inputDuration[2]) * 60 + Number(inputDuration[3]) > 3600) throw new Error('Demo 支持最长 60 分钟的视频');
    const encoded = await runFFmpeg(['-y', '-i', inputFile, '-map', '0:v:0', '-an', '-t', '3600.1', '-vf', "setpts=PTS-STARTPTS,scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", '-r', '30', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], 600000);
    const frames = [...encoded.matchAll(/frame=\s*(\d+)/g)].at(-1);
    const duration = frames ? Number(frames[1]) / 30 : 0;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('视频时长无效或超过 60 分钟');
    const thumbnailLog = await runFFmpeg(['-y', '-i', output, '-map', '0:v:0', '-frames:v', '1', '-vf', "showinfo,scale='min(480,iw)':-2", poster], 60000);
    const size = /\bs:(\d+)x(\d+)\b/.exec(thumbnailLog);
    if (!size) throw new Error('无法读取视频画面尺寸');
    const asset: MediaAsset = { id, name, type: 'video', url: `/api/assets/${id}`, duration, width: Number(size[1]), height: Number(size[2]), fps: 30, posterUrl: `/api/video/${id}/poster` };
    assets.set(id, { asset, file: path.relative(dataRoot, output), contentType: 'video/mp4', poster: path.relative(dataRoot, poster) });
    await persist(); return asset;
  } catch (error) {
    assets.delete(id); await Promise.allSettled([fs.unlink(output), fs.unlink(poster)]); throw error;
  }
}
export async function getDemoAudio(): Promise<MediaAsset> {
  const existing = assets.get('echo-demo-audio'); if (existing) { try { await fs.access(assetFile(existing)); return existing.asset; } catch {} }
  const source = path.join(dataRoot, 'uploads', 'demo-source.wav');
  const melody = "0.10*sin(2*PI*220*t)+0.065*sin(2*PI*330*t)+0.05*sin(2*PI*440*t)+0.14*sin(2*PI*55*t)*exp(-12*mod(t,0.5))+0.025*sin(2*PI*660*t)*(0.5+0.5*sin(2*PI*t/4))";
  await runFFmpeg(['-y','-f','lavfi','-i',`aevalsrc=${melody.replaceAll(',', '\\,')}:s=48000:d=30`,'-af','afade=t=in:d=0.3,afade=t=out:st=28:d=2','-ac','2','-c:a','pcm_s16le',source]);
  const asset = await importAudio(source, '月光之间 · 原创合成演示.wav', 'echo-demo-audio');
  await fs.unlink(source).catch(() => {}); return asset;
}
