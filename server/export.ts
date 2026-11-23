import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assetFile, dataRoot, ffmpegPath, getAsset } from './media';
import { MAX_FRAME_BATCH_BYTES, writeFrameBatch } from './export-frames';
import type { LayerEffect } from '../src/types';
import { validateAudioEffects } from '../src/effects';
import { buildAudioFadeFilter } from '../src/fade-effect';
export interface ExportRequest { audioId?: string; width: number; height: number; fps: number; start: number; end: number; audioMuted?: boolean; audioEffects?: LayerEffect[]; projectDuration?: number }
interface Job {
  id: string; width: number; height: number; total: number; expected: number; writing: boolean; encodedFrames: number;
  state: 'rendering'|'encoding'|'complete'|'cancelled'|'error'; file: string; stderr: string;
  child: ChildProcessWithoutNullStreams; closed: Promise<void>; error?: string; lastActivity: number;
}
const jobs = new Map<string, Job>();
export function getExportJob(id: string) { return jobs.get(id); }
export function createExportJob(options: ExportRequest) {
  const { width, height, fps, start, end, audioId } = options;
  if(options.audioMuted!==undefined && typeof options.audioMuted!=='boolean') throw new Error('音轨静音状态无效');
  if (options.projectDuration !== undefined && (typeof options.projectDuration !== 'number' || !Number.isFinite(options.projectDuration) || options.projectDuration <= 0 || options.projectDuration > 3600)) throw new Error('工程时长无效');
  const audioEffects = options.audioEffects === undefined ? undefined : validateAudioEffects(options.audioEffects);
  if (![width,height,fps,start,end].every(Number.isFinite) || ![24,25,30,60].includes(fps) || width < 320 || height < 180 || width > 1920 || height > 1920 || width % 2 || height % 2 || start < 0 || end <= start || end > 3600) throw new Error('导出尺寸、帧率或区间无效');
  const audio = audioId ? getAsset(audioId) : undefined;
  if (audioId !== undefined && (typeof audioId !== 'string' || !audio || audio.asset.type !== 'audio')) throw new Error('工程音乐引用无效');
  if ([...jobs.values()].some(job => job.state === 'rendering' || job.state === 'encoding')) throw new Error('已有导出任务正在进行');
  const id = randomUUID(), total = Math.ceil((end-start)*fps); const file = path.join(dataRoot, 'exports', `${id}.mp4`);
  // A partial export keeps the music's original envelope. Its requested end is
  // never a substitute for the registered music/project end.
  const audioEnd = Math.min(audio?.asset.duration || 0, options.projectDuration ?? Number.POSITIVE_INFINITY);
  const audioFilter=options.audioMuted===true?'volume=0,apad':buildAudioFadeFilter(audioEffects,start,audioEnd);
  const audioInput = audio && start < (audio.asset.duration || 0) ? ['-ss',String(start),'-i',assetFile(audio)] : ['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'];
  const child = spawn(ffmpegPath, ['-hide_banner','-y','-nostats','-progress','pipe:1','-f','rawvideo','-pix_fmt','rgba','-video_size',`${width}x${height}`,'-framerate',String(fps),'-i','pipe:0',...audioInput,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-af',audioFilter,'-t',String(total/fps),'-movflags','+faststart',file], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const job: Job = { id, width, height, total, expected: 0, writing: false, encodedFrames: 0, state: 'rendering', file, stderr: '', child, closed: Promise.resolve(), lastActivity: Date.now() };
  let progress='';
  child.stdout.on('data',data=>{
    progress+=data.toString(); const lines=progress.split('\n');progress=lines.pop() || '';
    for(const line of lines) if(/^frame=\d+\r?$/.test(line)) job.encodedFrames=Number(line.slice(6));
    progress=progress.slice(-1024);
  });
  job.closed = new Promise<void>((resolve, reject) => {
    child.once('error', error => { job.state='error'; job.error=error.message; reject(error); });
    child.once('close', code => {
      if (job.state === 'cancelled') { reject(new Error('导出已取消')); return; }
      if (code === 0 && job.state === 'encoding' && job.encodedFrames === job.total) { job.state='complete'; resolve(); }
      else if(code === 0 && job.state === 'encoding') { job.state='error';job.error=`导出帧数不完整：期望 ${job.total}，实际 ${job.encodedFrames}`;reject(new Error(job.error)); }
      else { job.state='error'; job.error ||= `FFmpeg 退出 (${code})：${job.stderr.split('\n').slice(-5).join(' ')}`; reject(new Error(job.error)); }
    });
  });
  void job.closed.catch(() => {});
  child.stderr.on('data', data => { job.stderr=(job.stderr+data.toString()).slice(-16000); });
  child.stdin.on('error', error => { if(job.state!=='cancelled') job.error=error.message; });
  jobs.set(id,job); return { jobId: id, total, maxFrameBatchBytes: MAX_FRAME_BATCH_BYTES };
}
export async function writeFrame(id: string, index: number, buffer: Buffer) {
  const job=jobs.get(id); if(!job) throw new Error('导出任务不存在');
  if(buffer.length!==job.width*job.height*4) throw new Error('RGBA 帧字节数不正确');
  return writeFrames(id, index, buffer);
}
export async function writeFrames(id: string, start: number, buffer: Buffer) {
  const job=jobs.get(id); if(!job) throw new Error('导出任务不存在');
  try {
    return await writeFrameBatch(job,start,buffer,job.child.stdin);
  } catch (error) {
    // Validation errors leave a valid job retryable. Pipe failures must stop the
    // encoder immediately rather than leave a broken job blocking later exports.
    if (job.state === 'rendering' && (job.child.stdin.destroyed || job.child.stdin.errored)) {
      const detail = error instanceof Error ? error.message : String(error);
      job.error = `写入 FFmpeg 失败：${detail}${job.stderr ? `；${job.stderr.split('\n').filter(Boolean).slice(-3).join(' ')}` : ''}`;
      job.state = 'error'; job.child.stdin.destroy(); job.child.kill();
    }
    throw error;
  }
}
export async function finishExport(id: string) {
  const job=jobs.get(id); if(!job) throw new Error('导出任务不存在');
  if(job.expected!==job.total || job.writing || job.state!=='rendering') throw new Error(job.error || '未收到完整帧序列');
  job.state='encoding'; job.lastActivity=Date.now(); job.child.stdin.end(); await job.closed;
  const stat=await fs.stat(job.file); if(stat.size<1024) throw new Error('输出视频不完整');
  return { jobId: id, downloadUrl: `/api/export/${id}/download` };
}
export async function cancelExport(id: string) {
  const job=jobs.get(id); if(!job || ['complete','cancelled'].includes(job.state)) return;
  job.state='cancelled'; job.child.stdin.destroy(); job.child.kill();
  await job.closed.catch(()=>{}); await fs.unlink(job.file).catch(()=>{});
}
export function killExports() { for(const job of jobs.values()) if(job.state==='rendering'||job.state==='encoding') job.child.kill(); }
// A closed browser may never send /cancel. Do not leave a waiting encoder blocking future jobs.
const idleWatch=setInterval(()=>{
  for(const job of jobs.values()) if((job.state==='rendering'||job.state==='encoding')&&Date.now()-job.lastActivity>180000) void cancelExport(job.id);
},10000);
idleWatch.unref();
