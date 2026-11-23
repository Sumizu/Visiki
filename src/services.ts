import type { DemoProject, ExportProgress, ExportSettings, LyricsResult, MediaAsset, SceneResources, SongResult } from './types';
import { renderScene } from './scene';
import { loadProjectFonts } from './fonts';
import { VideoFramePool } from './video-frames';
import { isVideoBackground } from './background-video';
import { exportBatchSize, runExportPipeline } from './export-pipeline';
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({ error: `服务返回 ${response.status}` }));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}
export async function uploadMedia(file: File, type: 'audio' | 'image' | 'video'): Promise<MediaAsset> {
  const data = new FormData(); data.append('file', file); data.append('type', type);
  return responseJson<MediaAsset>(await fetch(`/api/import/${type}`, { method: 'POST', body: data }));
}
export async function loadDemoAudio(): Promise<MediaAsset> { return responseJson(await fetch('/api/demo/audio')); }
export async function searchSongs(query: string, provider: 'netease' | 'qq' = 'netease'): Promise<SongResult[]> {
  return responseJson(await fetch(`/api/lyrics/search?q=${encodeURIComponent(query)}&provider=${provider}`));
}
export async function fetchLyrics(id: string, provider: 'netease' | 'qq' = 'netease'): Promise<LyricsResult> {
  return responseJson(await fetch(`/api/lyrics/song/${encodeURIComponent(id)}?provider=${provider}`));
}

/** Only resolve images that can contribute pixels within the requested range. */
export function collectExportImageAssets(project: DemoProject, range: Pick<ExportSettings, 'start' | 'end'>): MediaAsset[] {
  const library = new Map((project.images ?? []).map(asset => [asset.id, asset]));
  if (project.cover && !library.has(project.cover.id)) library.set(project.cover.id, project.cover);
  const needed = new Map<string, MediaAsset>();
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity <= 0 || layer.end <= range.start || layer.start >= range.end || !['image', 'background', 'disc'].includes(layer.type) || isVideoBackground(layer) || (layer.type === 'background' && layer.params.backgroundType === 'color')) continue;
    const imageId = layer.params.imageId;
    if (imageId !== undefined && typeof imageId !== 'string') throw new Error(`“${layer.name}”的图片引用无效。`);
    const followsCover = layer.params.followCover === true || (!imageId && (layer.type === 'disc' || (imageId === undefined && layer.params.followCover === undefined)));
    const asset = followsCover ? project.cover : imageId ? library.get(imageId) : null;
    if (!followsCover && imageId && !asset) throw new Error(`“${layer.name}”引用的图片已丢失，请重新选择图片。`);
    if (asset) needed.set(asset.id, asset);
  }
  return [...needed.values()];
}

async function decodeExportImage(asset: MediaAsset): Promise<CanvasImageSource> {
  const image = new Image(); image.src = asset.url;
  try { await image.decode(); } catch { throw new Error(`导出图片“${asset.name}”无法读取，请重新导入图片。`); }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error(`导出图片“${asset.name}”内容无效，请重新导入图片。`);
  return image;
}

export async function loadExportImages(project: DemoProject, range: Pick<ExportSettings, 'start' | 'end'>,
  load: (asset: MediaAsset) => Promise<CanvasImageSource> = decodeExportImage): Promise<Pick<SceneResources, 'cover' | 'images'>> {
  const assets = collectExportImageAssets(project, range);
  const entries = await Promise.all(assets.map(async asset => [asset.id, await load(asset)] as const));
  const images = new Map(entries);
  return { cover: project.cover ? images.get(project.cover.id) ?? null : null, images };
}

export async function runExport(project: DemoProject, resources: SceneResources, settings: ExportSettings,
  onProgress: (progress: ExportProgress) => void, signal?: AbortSignal): Promise<{ downloadUrl: string; jobId: string }> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const snapshot = structuredClone(project);
  const { jobId, total, maxFrameBatchBytes } = await responseJson<{
    jobId: string; total: number; maxFrameBatchBytes?: number;
  }>(await fetch('/api/export/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, audioId: snapshot.audio?.id, audioMuted: snapshot.audioMuted === true, audioEffects: snapshot.audioEffects, projectDuration: snapshot.duration }), signal: operationSignal
  }));
  const cancel = () => { void fetch(`/api/export/${jobId}/cancel`, { method: 'POST' }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let completed = 0;
  const progress = (state: ExportProgress['state']): ExportProgress => {
    const elapsedMs = performance.now() - startedAt;
    return { jobId, state, completed, total, elapsedMs, framesPerSecond: elapsedMs > 0 ? completed * 1000 / elapsedMs : 0 };
  };
  const canvas = document.createElement('canvas'); canvas.width = settings.width; canvas.height = settings.height;
  // Canvas text also follows inherited CSS font synthesis. Keep the export
  // canvas in the document so single-weight imported fonts match the preview.
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;font-synthesis:none';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const videoFrames = new VideoFramePool();
  try {
    await loadProjectFonts(snapshot, settings);
    await document.fonts.ready;
    const exportResources: SceneResources = { ...resources, ...await loadExportImages(snapshot, settings) };
    operationSignal.throwIfAborted();
    const batchSize = !maxFrameBatchBytes ? 1 : exportBatchSize(settings.width, settings.height, maxFrameBatchBytes);
    let lastYield = performance.now();
    await runExportPipeline<Uint8Array<ArrayBuffer>>(total, batchSize, async (start, count) => {
      const frameBytes = settings.width * settings.height * 4;
      const raw = new Uint8Array(frameBytes * count);
      for (let offset = 0; offset < count; offset++) {
        operationSignal.throwIfAborted();
        const i = start + offset;
        const time = settings.start + i / settings.fps;
        exportResources.videos = await videoFrames.prepare(snapshot, time, operationSignal);
        ctx.setTransform(settings.width / snapshot.width, 0, 0, settings.height / snapshot.height, 0, 0);
        renderScene(ctx, snapshot, time, exportResources, { editor: false });
        raw.set(ctx.getImageData(0, 0, settings.width, settings.height).data, offset * frameBytes);
        if (performance.now() - lastYield > 12) { await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); }
      }
      return raw;
    }, async (start, _count, data) => {
      const endpoint = maxFrameBatchBytes ? 'frames' : 'frame';
      // Chromium uploads large typed arrays much more slowly than Blob data.
      // Blob preserves every RGBA byte while using its efficient upload path.
      const frameResponse = await fetch(`/api/export/${jobId}/${endpoint}/${start}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([data]), signal: operationSignal });
      if (!frameResponse.ok) await responseJson(frameResponse);
    }, operationSignal, value => { completed = value; onProgress(progress('rendering')); });
    onProgress(progress('encoding'));
    const result = await responseJson<{ downloadUrl: string; jobId: string }>(await fetch(`/api/export/${jobId}/finish`, { method: 'POST', signal: operationSignal }));
    onProgress({ ...progress('complete'), downloadUrl: result.downloadUrl });
    return result;
  } catch (error) {
    controller.abort(error);
    cancel();
    onProgress({ ...progress(signal?.aborted ? 'cancelled' : 'error'), message: error instanceof Error ? error.message : '导出失败' });
    throw error;
  } finally { videoFrames.dispose(); signal?.removeEventListener('abort', cancel); canvas.width = 0; canvas.height = 0; canvas.remove(); }
}
