import type { AudioAnalysis, DemoProject, ExportSettings, SceneResources } from './types';
import { analyzeAudio } from './audio-analysis';
import { loadProjectFonts } from './fonts';
import { loadExportImages } from './services';
import { VideoFramePool } from './video-frames';
import { renderScene } from './scene';

/** Abort waiting immediately even if a browser decoder/font load cannot be interrupted. */
export function waitForAgent<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
let audioCache: { url: string; promise: Promise<AudioAnalysis>; controller: AbortController; users: number; done: boolean } | undefined;
export async function prepareAgentAnalysis(project: DemoProject, signal: AbortSignal, available?: AudioAnalysis | null): Promise<AudioAnalysis | null> {
  signal.throwIfAborted();
  if (!project.audio) return null;
  if (available) return available;
  const url = project.audio.url;
  if (!audioCache || audioCache.url !== url) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('工程音乐读取失败，请重新导入');
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(await response.arrayBuffer()); controller.signal.throwIfAborted();
        return await analyzeAudio(buffer, () => controller.signal.throwIfAborted());
      }
      finally { await context.close(); }
    })();
    audioCache = { url, promise, controller, users: 0, done: false };
    const entry = audioCache;
    void promise.then(() => { entry.done = true; }, () => {});
    void promise.catch(() => { if (audioCache?.promise === promise) audioCache = undefined; });
  }
  const entry = audioCache; entry.users++;
  try { return await waitForAgent(entry.promise, signal); }
  finally {
    entry.users--;
    if (!entry.done && entry.users === 0) { entry.controller.abort(); if (audioCache === entry) audioCache = undefined; }
  }
}

const numeric = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 超出范围 ${min}–${max}`);
  return value;
};
export function agentExportSettings(project: DemoProject, args: Record<string, unknown>): ExportSettings {
  const scale = Math.min(1, 1920 / project.width, 1920 / project.height);
  const defaultWidth = Math.floor(project.width * scale / 2) * 2;
  const defaultHeight = Math.floor(project.height * scale / 2) * 2;
  const width = numeric(args, 'width', defaultWidth, 320, 1920);
  const height = numeric(args, 'height', defaultHeight, 180, 1920);
  const fps = numeric(args, 'fps', project.fps, 1, 60);
  const start = numeric(args, 'start', 0, 0, project.duration);
  const end = numeric(args, 'end', project.duration, 0, project.duration);
  if (width % 2 || height % 2 || ![24, 25, 30, 60].includes(fps) || end <= start) throw new Error('导出宽高须为偶数，帧率为 24/25/30/60，结束时间须大于开始时间');
  return { width, height, fps, start, end };
}

/** Render a clean frame without moving the playhead or using selection overlays. */
export async function renderAgentPreview(project: DemoProject, args: Record<string, unknown>, signal: AbortSignal, available?: AudioAnalysis | null) {
  const time = numeric(args, 'time', 0, 0, project.duration);
  const defaultWidth = Math.max(16, Math.floor(Math.min(960, project.width, 1920 * project.width / project.height)));
  const width = numeric(args, 'width', args.height === undefined ? defaultWidth : Math.round(Number(args.height) * project.width / project.height), 16, 1920);
  const height = numeric(args, 'height', Math.round(width * project.height / project.width), 16, 1920);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('预览尺寸须为整数');
  const range = { start: time, end: time + 1 / project.fps };
  const [analysis, images] = await waitForAgent(Promise.all([prepareAgentAnalysis(project, signal, available), loadExportImages(project, range), loadProjectFonts(project, range)]), signal);
  signal.throwIfAborted();
  const pool = new VideoFramePool();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.setAttribute('aria-hidden', 'true'); canvas.style.cssText = 'position:fixed;width:1px;height:1px;visibility:hidden;font-synthesis:none';
  document.body.append(canvas);
  try {
    const resources: SceneResources = { ...images, analysis, videos: await pool.prepare(project, time, signal) };
    const context = canvas.getContext('2d'); if (!context) throw new Error('预览画布不可用');
    await waitForAgent(document.fonts.ready, signal); signal.throwIfAborted();
    context.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
    renderScene(context, project, time, resources, { editor: false });
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (data.length > 4 * 1024 * 1024) throw new Error('预览图片超过传输上限，请减小预览宽高后重试');
    return { mimeType: 'image/png', data, width, height, time };
  } finally { pool.dispose(); canvas.width = canvas.height = 0; canvas.remove(); }
}
