import type { DemoProject, Layer, MediaAsset } from './types';
import { videoSourceTime } from './video-timing';
import { ChromaKeyProcessor, chromaKeySettingsKey } from './chroma-key';
import { backgroundVideoSourceTime, isVideoBackground } from './background-video';

interface Decoder {
  assetId: string;
  url: string;
  video: HTMLVideoElement;
  surface: HTMLCanvasElement;
  loaded: Promise<void>;
  frame: number;
  keyer: ChromaKeyProcessor;
  processed: CanvasImageSource;
  effectKey: string;
}

function waitForVideo(video: HTMLVideoElement, ready: () => boolean, label: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked'];
    const clean = () => {
      clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, check);
      video.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const check = () => { if (ready()) { clean(); resolve(); } };
    const fail = () => { clean(); reject(new Error(`${label}无法解码，请重新导入视频。`)); };
    const abort = () => { clean(); reject(signal.reason ?? new DOMException('视频读取已取消', 'AbortError')); };
    const timer = setTimeout(() => { clean(); reject(new Error(`${label}读取超时，请重试或导入较短的视频。`)); }, 20000);
    for (const event of events) video.addEventListener(event, check);
    video.addEventListener('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else if (video.error) fail(); else check();
  });
}

/** Each timeline layer has its own paused decoder, allowing two clips from the
 * same file to display different source times. Decoded frames are copied into
 * stable canvases; a pending seek never invalidates a previously published map.
 * Preview coalesces requests, while export awaits every requested frame. */
export class VideoFramePool {
  private decoders = new Map<string, Decoder>();
  private controller = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();

  prepare(project: DemoProject, time: number, signal?: AbortSignal): Promise<Map<string, CanvasImageSource>> {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const request = this.chain.catch(() => {}).then(() => this.prepareFrame(project, time, combined));
    this.chain = request;
    return request;
  }

  private async prepareFrame(project: DemoProject, time: number, signal: AbortSignal): Promise<Map<string, CanvasImageSource>> {
    signal.throwIfAborted();
    const library = new Map((project.videos ?? []).map(asset => [asset.id, asset]));
    const active = project.layers.filter(layer => (layer.type === 'video' || (isVideoBackground(layer) && !!layer.params.videoId)) &&
      layer.visible && layer.opacity > 0 && time >= layer.start && time < layer.end);
    // Keep decoders/GPU textures only for clips contributing at this time. A
    // long sequence should not retain one WebGL context for every past clip.
    const retained = new Set(active.map(layer => layer.id));
    for (const [id, decoder] of this.decoders) {
      if (!retained.has(id)) { this.release(decoder); this.decoders.delete(id); }
    }
    const entries = await Promise.all(active.map(async layer => {
      const asset = library.get(String(layer.params.videoId));
      if (!asset) throw new Error(`“${layer.name}”引用的视频已丢失，请重新选择素材。`);
      return [layer.id, await this.decode(layer, asset, time, signal)] as const;
    }));
    signal.throwIfAborted();
    return new Map(entries);
  }

  private async decode(layer: Layer, asset: MediaAsset, time: number, signal: AbortSignal): Promise<CanvasImageSource> {
    let decoder = this.decoders.get(layer.id);
    if (!decoder || decoder.assetId !== asset.id || decoder.url !== asset.url) {
      if (decoder) this.release(decoder);
      const video = document.createElement('video');
      video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto';
      video.src = asset.url;
      const loaded = waitForVideo(video, () => video.readyState >= 2 && video.videoWidth > 0, `视频“${asset.name}”`, signal);
      const surface = document.createElement('canvas');
      decoder = { assetId: asset.id, url: asset.url, video, surface, loaded, frame: -1,
        keyer: new ChromaKeyProcessor(), processed: surface, effectKey: '' };
      this.decoders.set(layer.id, decoder);
      video.load();
    }
    await decoder.loaded;
    signal.throwIfAborted();
    const fps = asset.fps ?? 30;
    const sourceTime = isVideoBackground(layer) ? backgroundVideoSourceTime(layer, time, asset) : videoSourceTime(layer, time, asset);
    const frame = Math.floor(sourceTime * fps + 1e-5);
    const effectKey = chromaKeySettingsKey(layer.params);
    if (decoder.frame === frame) {
      if (decoder.effectKey !== effectKey) {
        decoder.processed = decoder.keyer.process(decoder.surface, decoder.surface.width, decoder.surface.height, layer.params);
        decoder.effectKey = effectKey;
      }
      return decoder.processed;
    }
    // Seek inside a frame rather than exactly on a floating point boundary.
    const target = Math.min((frame + .25) / fps, Math.max(0, decoder.video.duration - .001));
    if (Math.abs(decoder.video.currentTime - target) > 1e-5 || decoder.video.seeking || decoder.video.readyState < 2) {
      decoder.video.currentTime = target;
      await waitForVideo(decoder.video, () => !decoder!.video.seeking && decoder!.video.readyState >= 2, `视频“${asset.name}”的画面`, signal);
    }
    signal.throwIfAborted();
    const { surface, video } = decoder;
    if (surface.width !== video.videoWidth || surface.height !== video.videoHeight) {
      surface.width = video.videoWidth; surface.height = video.videoHeight;
    }
    const ctx = surface.getContext('2d');
    if (!ctx) throw new Error('无法创建视频画面缓存');
    ctx.drawImage(video, 0, 0, surface.width, surface.height);
    decoder.frame = frame;
    decoder.processed = decoder.keyer.process(surface, surface.width, surface.height, layer.params);
    decoder.effectKey = effectKey;
    return decoder.processed;
  }

  private release(decoder: Decoder): void {
    decoder.video.pause(); decoder.video.removeAttribute('src'); decoder.video.load();
    decoder.keyer.dispose();
    // A previously published map may still refer to this surface until the
    // next prepare completes. Let it remain drawable until garbage collection.
  }

  dispose(): void {
    this.controller.abort(new DOMException('视频缓存已关闭', 'AbortError'));
    for (const decoder of this.decoders.values()) this.release(decoder);
    this.decoders.clear();
  }
}
