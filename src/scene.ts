import type { DemoProject, Layer, LayerEffect, RenderOptions, SceneResources } from './types';
import { sampleFeatures } from './audio-analysis';
import { activeLyricIndex } from './lyrics';
import { fontFamilyForId, resolveLyricFontIds } from './fonts';
import { wrapTextLines } from './text-layout';
import { isVideoBackground } from './background-video';
import { colorWithOpacity, layoutLyricBlocks, LYRIC_STYLE_DEFAULTS, lyricTransitionAtTime, resolveLyricLayout, resolveLyricStyle } from './lyric-style';
import type { LyricTextStyle } from './lyric-style';
import { canvasFont, resolveTextTypography, withCanvasFontSynthesis } from './text-typography';
import type { TextTypography } from './text-typography';
import { paintTextGlow, resolveTextGlow } from './text-glow';
import type { TextGlowStyle } from './text-glow';
import { resolveTextPlane, withTextPlane } from './text-plane';
import { withTextTransition } from './text-transition';
import { clearParticleCache, drawParticles } from './particles';
import { drawDualSpectrumWave } from './spectrum-wave';
import { drawSpectrumEcg } from './spectrum-ecg';
import { drawSpectrumEnvelope } from './spectrum-envelope';
import { clearSpectrumSignalCache } from './spectrum-signal';
import { clearAtmosphereCache, drawAtmosphere } from './atmosphere';
import { activeLayerEffects } from './effects';
import { applyLayerEffects, clearEffectRendererCache } from './effect-renderer';
import { audioReactiveAtTime, clearAudioReactiveCache } from './audio-reactive';
import { audioGainAtTime, fadeAtTime } from './fade-effect';

const TAU = Math.PI * 2;
const FONT = '"Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", sans-serif';
const clamp = (n: number, a: number, b: number): number => Math.min(b, Math.max(a, n));
const numberParam = (layer: Layer, name: string, fallback: number): number => {
  const n = Number(layer.params[name]);
  return Number.isFinite(n) ? n : fallback;
};
const colorParam = (layer: Layer, name: string, fallback: string): string => typeof layer.params[name] === 'string' ? String(layer.params[name]) : fallback;

function layerImage(layer: Layer, resources: SceneResources): CanvasImageSource | null {
  if (layer.params.followCover === true) return resources.cover;
  const id = layer.params.imageId;
  // A bound image that is still loading must never display a different cover.
  if (typeof id === 'string' && id) return resources.images?.get(id) ?? null;
  if (layer.type === 'disc' || (id === undefined && layer.params.followCover === undefined)) return resources.cover;
  return null;
}

// Static pixels are rendered at project resolution, then shared between preview
// and export. Keys contain all visual inputs, never the playhead or frame count.
const surfaces = new Map<string, CanvasImageSource>();
const imageIds = new WeakMap<object, number>();
let nextImageId = 1;
function imageKey(source: CanvasImageSource | null): string {
  if (!source) return 'original-procedural-cover';
  let id = imageIds.get(source as object);
  if (!id) { id = nextImageId++; imageIds.set(source as object, id); }
  return `${id}:${sourceSize(source).join('x')}`;
}

function staticSurface(key: string, width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): CanvasImageSource | null {
  const cached = surfaces.get(key);
  if (cached) return cached;
  const pw = Math.max(1, Math.ceil(width)); const ph = Math.max(1, Math.ceil(height));
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(pw, ph);
  else if (typeof document !== 'undefined') { canvas = document.createElement('canvas'); canvas.width = pw; canvas.height = ph; }
  else return null;
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.translate(pw / 2, ph / 2);
  paint(ctx);
  surfaces.set(key, canvas);
  // Bound retained image memory when users try many covers or layer sizes.
  if (surfaces.size > 24) surfaces.delete(surfaces.keys().next().value!);
  return canvas;
}

export function clearSceneCache(): void {
  surfaces.clear(); clearParticleCache(); clearAtmosphereCache(); clearEffectRendererCache();
  clearAudioReactiveCache();
  clearSpectrumSignalCache();
  effectStage?.canvas.remove(); effectStage=null;
  if(effectScratch){effectScratch.canvas.width=1;effectScratch.canvas.height=1;effectScratch=null;}
}

let effectStage: {canvas:HTMLCanvasElement;ctx:CanvasRenderingContext2D}|null=null;
let effectScratch: {canvas:HTMLCanvasElement|OffscreenCanvas;ctx:CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D}|null=null;
function layerEffectStage(width:number,height:number):typeof effectStage {
  if(typeof document==='undefined')return null;
  if(!effectStage) {
    const canvas=document.createElement('canvas');
    canvas.dataset.visikiEffectStage='true';canvas.setAttribute('aria-hidden','true');
    // Chromium resolves canvas font-synthesis correctly only on a connected element.
    canvas.style.cssText='position:fixed;left:-100000px;top:0;width:1px;height:1px;pointer-events:none;font-synthesis:none;';
    document.body.append(canvas);
    const ctx=canvas.getContext('2d');if(!ctx){canvas.remove();return null;}
    effectStage={canvas,ctx};
  }
  const pw=Math.max(1,Math.round(width)),ph=Math.max(1,Math.round(height));
  if(effectStage.canvas.width!==pw)effectStage.canvas.width=pw;
  if(effectStage.canvas.height!==ph)effectStage.canvas.height=ph;
  return effectStage;
}

function layerEffectScratch(width:number,height:number):typeof effectScratch {
  if(!effectScratch) {
    let canvas:HTMLCanvasElement|OffscreenCanvas;
    if(typeof OffscreenCanvas!=='undefined')canvas=new OffscreenCanvas(width,height);
    else if(typeof document!=='undefined'){
      canvas=document.createElement('canvas');canvas.dataset.visikiEffectScratch='true';canvas.setAttribute('aria-hidden','true');
    }else return null;
    const ctx=canvas.getContext('2d') as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null;
    if(!ctx)return null;effectScratch={canvas,ctx};
  }
  if(effectScratch.canvas.width!==width)effectScratch.canvas.width=width;
  if(effectScratch.canvas.height!==height)effectScratch.canvas.height=height;
  return effectScratch;
}

interface EffectTransform { scale:number;opacity:number;brightness:number;offsetX:number;offsetY:number }
interface PreparedEffect { effect:LayerEffect;transform:EffectTransform|null }
const IDENTITY_EFFECT_TRANSFORM:EffectTransform={scale:1,opacity:1,brightness:1,offsetX:0,offsetY:0};

/** Resolve temporal effects before choosing an isolation canvas. A bypass must
 * preserve the original direct paint path, including text antialiasing and
 * overlapping translucent glyphs, rather than merely skipping its last pass. */
function prepareLayerEffects(layer:Layer,project:DemoProject,timeSec:number,resources:SceneResources):PreparedEffect[] {
  return activeLayerEffects(layer.effects).map(effect=>{
    let transform:EffectTransform|null=null;
    if(effect.type==='audio-reactive') {
      const audioEnd=Math.min(project.duration,project.audio?.duration??resources.analysis?.duration??project.duration);
      const state=audioReactiveAtTime(effect,resources.analysis,timeSec,{muted:project.audioMuted===true||!project.audio,
        gain:audioGainAtTime(project.audioEffects,timeSec,audioEnd),audioEnd});
      transform={...IDENTITY_EFFECT_TRANSFORM,scale:state.scale,opacity:state.opacity,brightness:state.brightness};
    }else if(effect.type==='fade') {
      let start=layer.start,end=layer.end;
      if(effect.params.timing===1&&layer.type==='lyrics') {
        if(layer.params.mode!=='single'&&layer.params.mode!=='bilingual')return {effect,transform:IDENTITY_EFFECT_TRANSFORM};
        const offset=project.lyricsOffsetMs/1000,index=activeLyricIndex(project.lyrics,timeSec-offset);
        if(index<0)return {effect,transform:IDENTITY_EFFECT_TRANSFORM};
        const cue=project.lyrics[index];start=Math.max(layer.start,cue.time+offset);
        end=Math.min(layer.end,project.duration,(project.lyrics[index+1]?.time??project.duration-offset)+offset,
          cue.end===undefined?project.duration:cue.end+offset);
      }
      transform={...IDENTITY_EFFECT_TRANSFORM,...fadeAtTime(effect,start,end,timeSec,{width:layer.width,height:layer.height})};
    }
    return {effect,transform};
  }).filter(({transform})=>transform===null||transform.scale!==1||transform.opacity!==1||transform.brightness!==1||transform.offsetX!==0||transform.offsetY!==0);
}

/** Pixel groups and compositing transforms retain their declared stack order.
 * A reusable scratch protects the source when applying a transform in place.
 * All coordinates stay in project space; the editor selection is drawn later
 * from the unchanged Layer geometry. */
function applyOrderedEffects(stage:NonNullable<typeof effectStage>,effects:readonly PreparedEffect[],layer:Layer,timeSec:number):CanvasImageSource {
  const width=stage.canvas.width,height=stage.canvas.height,target=stage.ctx;
  let pixels:LayerEffect[]=[];
  const reset=()=>{target.setTransform(1,0,0,1,0,0);target.globalAlpha=1;target.globalCompositeOperation='source-over';target.filter='none';};
  const flush=()=>{
    if(!pixels.length)return;
    const output=applyLayerEffects(stage.canvas,width,height,pixels,timeSec-layer.start+(layer.effectTimeOffset??0),layer);
    pixels=[];
    if(output!==stage.canvas){reset();target.clearRect(0,0,width,height);target.drawImage(output,0,0,width,height);}
  };
  target.save();
  try {
    for(const {effect,transform} of effects) {
      if(transform===null){pixels.push(effect);continue;}
      flush();
      const {scale,opacity,brightness,offsetX,offsetY}=transform;
      const scratch=layerEffectScratch(width,height);if(!scratch)continue;
      scratch.ctx.setTransform(1,0,0,1,0,0);scratch.ctx.globalAlpha=1;scratch.ctx.globalCompositeOperation='source-over';scratch.ctx.filter='none';
      scratch.ctx.clearRect(0,0,width,height);scratch.ctx.drawImage(stage.canvas,0,0,width,height);
      reset();target.clearRect(0,0,width,height);target.globalAlpha=opacity;
      if(brightness!==1)target.filter=`brightness(${brightness})`;
      target.translate(layer.x,layer.y);target.rotate(layer.rotation*Math.PI/180);target.translate(offsetX,offsetY);target.scale(scale,scale);
      target.rotate(-layer.rotation*Math.PI/180);target.translate(-layer.x,-layer.y);
      target.drawImage(scratch.canvas,0,0,width,height);
    }
    flush();return stage.canvas;
  } finally {target.restore();}
}

/** Absolute song time is the only rotation clock, including during seeks/export. */
export function discAngleAtTime(timeSec: number, rpm = 8): number {
  return ((timeSec * rpm * TAU / 60) % TAU + TAU) % TAU;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

function imageMask(ctx: CanvasRenderingContext2D, layer: Layer): void {
  const w = layer.width; const h = layer.height;
  const radius = Math.max(0, numberParam(layer, 'radius', 2));
  // Preserve the rounded corners of projects saved before shape masks existed.
  const mask = String(layer.params.mask ?? (radius > 0 ? 'rounded' : 'rectangle'));
  ctx.beginPath();
  switch (mask) {
    case 'rounded': ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(radius, w / 2, h / 2)); break;
    case 'circle': ctx.arc(0, 0, Math.min(w, h) / 2, 0, TAU); break;
    case 'ellipse': ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU); break;
    case 'diamond': ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(0, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath(); break;
    case 'hexagon': ctx.moveTo(-w / 4, -h / 2); ctx.lineTo(w / 4, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(w / 4, h / 2); ctx.lineTo(-w / 4, h / 2); ctx.lineTo(-w / 2, 0); ctx.closePath(); break;
    default: ctx.rect(-w / 2, -h / 2, w, h);
  }
}

/** Original procedural cover: no network image, template, or third-party artwork. */
function paintFallbackCover(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.save(); ctx.translate(x, y); ctx.scale(width, height);
  const sky = ctx.createLinearGradient(0, 0, 0.95, 1);
  sky.addColorStop(0, '#101b35'); sky.addColorStop(0.42, '#55436a'); sky.addColorStop(0.73, '#bb8990'); sky.addColorStop(1, '#283245');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 1, 1);
  const halo = ctx.createRadialGradient(0.66, 0.28, 0.01, 0.66, 0.28, 0.48);
  halo.addColorStop(0, '#ebbdad80'); halo.addColorStop(1, '#d9b5c600');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#ffe9cc'; ctx.beginPath(); ctx.arc(0.66, 0.28, 0.145, 0, TAU); ctx.fill();
  const terrain: [string, number, number][] = [['#786986', 0.61, 0.11], ['#4b536b', 0.71, 0.14], ['#303d57', 0.82, 0.11], ['#1a2a43', 0.94, 0.1]];
  for (const [color, baseline, amplitude] of terrain) {
    ctx.beginPath(); ctx.moveTo(0, 1.05);
    for (let i = 0; i <= 50; i++) {
      const dx = i / 50;
      ctx.lineTo(dx, baseline + Math.sin(dx * 5 + baseline * 9) * amplitude + Math.cos(dx * 11) * amplitude * 0.18);
    }
    ctx.lineTo(1, 1.05); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  ctx.fillStyle = '#f1e3df';
  // Fixed positions make this fallback identical in preview and exported frames.
  for (let i = 0; i < 30; i++) {
    const sx = ((i * 0.381966011) % 0.9) + 0.05;
    const sy = ((i * 0.173205081) % 0.48) + 0.03;
    ctx.globalAlpha = 0.25 + (i % 4) * 0.15;
    ctx.beginPath(); ctx.arc(sx, sy, 0.0012 + (i % 3) * 0.0006, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 0.6; ctx.strokeStyle = '#fff1e4'; ctx.lineWidth = 0.001;
  ctx.strokeRect(0.07, 0.055, 0.86, 0.89);
  ctx.globalAlpha = 0.92; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `500 0.025px ${FONT}`; ctx.fillText('E C H O   /   M O O N L I T', 0.10, 0.10);
  ctx.font = `300 0.075px ${FONT}`; ctx.fillText('月光之间', 0.10, 0.79);
  ctx.font = `400 0.018px ${FONT}`; ctx.globalAlpha = 0.65; ctx.fillText('AN ORIGINAL SOUND, A NEW HORIZON', 0.105, 0.90);
  ctx.restore();
}

function sourceSize(source: CanvasImageSource): [number, number] {
  const sized = source as unknown as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number };
  return [sized.naturalWidth || sized.videoWidth || Number(sized.width) || 1, sized.naturalHeight || sized.videoHeight || Number(sized.height) || 1];
}

function cover(ctx: CanvasRenderingContext2D, source: CanvasImageSource | null, x: number, y: number, width: number, height: number, fit = 'cover'): void {
  if (!source) {
    const cached = staticSurface(`fallback:${width}:${height}`, width, height, context => paintFallbackCover(context, -width / 2, -height / 2, width, height));
    if (cached) ctx.drawImage(cached, x, y, width, height);
    else paintFallbackCover(ctx, x, y, width, height);
    return;
  }
  const [sw, sh] = sourceSize(source);
  if (fit === 'stretch') {
    // Independent X/Y resize maps the complete source to the layer bounds.
    ctx.drawImage(source, x, y, width, height);
  } else if (fit === 'contain') {
    const ratio = Math.min(width / sw, height / sh);
    ctx.drawImage(source, x + (width - sw * ratio) / 2, y + (height - sh * ratio) / 2, sw * ratio, sh * ratio);
  } else {
    const ratio = Math.max(width / sw, height / sh);
    const cropWidth = width / ratio; const cropHeight = height / ratio;
    ctx.drawImage(source, (sw - cropWidth) / 2, (sh - cropHeight) / 2, cropWidth, cropHeight, x, y, width, height);
  }
}

function paintBackground(ctx: CanvasRenderingContext2D, layer: Layer, resources: SceneResources): void {
  const w = layer.width; const h = layer.height;
  ctx.fillStyle = colorParam(layer, 'color', '#302d3b'); ctx.fillRect(-w / 2, -h / 2, w, h);
  if (layer.params.backgroundType === 'color') return;
  const videoBackground = isVideoBackground(layer);
  const frame = videoBackground ? resources.videos?.get(layer.id) : null;
  // A video without a decoded frame shows its own base color; unrelated cover
  // images must never leak into a video background while it is loading.
  if (videoBackground && !frame) return;
  ctx.save();
  const blur = clamp(numberParam(layer, 'blur', 40), 0, 150);
  ctx.filter = `blur(${blur}px)`;
  if (frame) {
    // Overscan only replaces pixels consumed by blur. At zero blur, contain or
    // stretch retains the complete frame, including source edges and corners.
    const padding = blur * 2;
    cover(ctx, frame, -w / 2 - padding, -h / 2 - padding, w + padding * 2, h + padding * 2, String(layer.params.fit ?? 'cover'));
  } else cover(ctx, layerImage(layer, resources), -w * 0.57, -h * 0.62, w * 1.14, h * 1.24);
  ctx.restore();
  ctx.fillStyle = `rgba(15, 16, 25, ${1 - clamp(numberParam(layer, 'brightness', 0.48), 0, 1)})`;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  const vignette = ctx.createRadialGradient(0, 0, w * 0.12, 0, 0, w * 0.65);
  vignette.addColorStop(0, '#12132100'); vignette.addColorStop(1, '#10111f80');
  ctx.fillStyle = vignette; ctx.fillRect(-w / 2, -h / 2, w, h);
}

function background(ctx: CanvasRenderingContext2D, layer: Layer, resources: SceneResources): void {
  if (isVideoBackground(layer)) {
    ctx.save(); ctx.beginPath(); ctx.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height); ctx.clip();
    paintBackground(ctx, layer, resources); ctx.restore(); return;
  }
  const key = `background:${imageKey(layerImage(layer, resources))}:${layer.width}:${layer.height}:${JSON.stringify(layer.params)}`;
  const cached = staticSurface(key, layer.width, layer.height, context => paintBackground(context, layer, resources));
  if (cached) ctx.drawImage(cached, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
  else paintBackground(ctx, layer, resources);
}

function image(ctx: CanvasRenderingContext2D, layer: Layer, resources: SceneResources): void {
  const w = layer.width; const h = layer.height;
  const shadowOpacity = clamp(numberParam(layer, 'shadowOpacity', 160 / 255), 0, 1);
  if (layer.params.shadow !== false && shadowOpacity > 0) {
    ctx.save(); ctx.shadowColor = `rgba(8, 10, 22, ${shadowOpacity})`; ctx.shadowBlur = 26; ctx.shadowOffsetX = 12; ctx.shadowOffsetY = 17;
    ctx.fillStyle = '#161725'; imageMask(ctx, layer); ctx.fill(); ctx.restore();
  }
  ctx.save(); imageMask(ctx, layer); ctx.clip();
  cover(ctx, layerImage(layer, resources), -w / 2, -h / 2, w, h, String(layer.params.fit ?? 'cover')); ctx.restore();
  ctx.strokeStyle = '#ffffff1c'; ctx.lineWidth = 1; imageMask(ctx, layer); ctx.stroke();
}

function video(ctx: CanvasRenderingContext2D, layer: Layer, resources: SceneResources): void {
  const frame = resources.videos?.get(layer.id);
  // Each clip owns its decoded frame. Missing frames stay transparent rather
  // than borrowing the cover or a frame belonging to another timeline clip.
  if (!frame) return;
  const w = layer.width; const h = layer.height;
  ctx.save(); ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
  cover(ctx, frame, -w / 2, -h / 2, w, h, String(layer.params.fit ?? 'cover'));
  ctx.restore();
}

function paintDiscSurface(ctx: CanvasRenderingContext2D, layer: Layer, resources: SceneResources): void {
  const r = Math.min(layer.width, layer.height) * 0.48;
  const isCD = layer.params.skin === 'cd';
  const surface = ctx.createRadialGradient(-r * 0.22, -r * 0.3, r * 0.05, 0, 0, r);
  if (isCD) { surface.addColorStop(0, '#d9d7df'); surface.addColorStop(0.42, '#b7c5c7'); surface.addColorStop(0.72, '#f4e3e8'); surface.addColorStop(1, '#87949f'); }
  else { surface.addColorStop(0, '#222129'); surface.addColorStop(0.45, '#17171f'); surface.addColorStop(0.76, '#28242e'); surface.addColorStop(1, '#13141c'); }
  ctx.fillStyle = surface; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  if (isCD) {
    const prism = ['#aaebeb60', '#e6afea50', '#f5d5a870', '#b9c7f750'];
    for (let i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r * 0.99, i * Math.PI / 4, i * Math.PI / 4 + 0.15); ctx.closePath();
      ctx.fillStyle = prism[i % prism.length]; ctx.fill();
    }
  }
  const labelRatio = clamp(numberParam(layer, 'labelRatio', isCD ? 0.38 : 0.48), 0.1, 0.88);
  const labelRadius = r * labelRatio;
  ctx.lineWidth = isCD ? 0.7 : 0.9;
  for (let radius = Math.max(labelRadius + 10, r * 0.25); radius < r - 8; radius += isCD ? 5 : 3.5) {
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.strokeStyle = isCD ? '#ffffff30' : '#b7a1c514'; ctx.stroke();
  }
  // Two restrained reflected wedges make the material readable while rotating.
  for (const angle of [-0.7, Math.PI - 0.7]) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r - 2, angle, angle + 0.23); ctx.closePath();
    ctx.fillStyle = isCD ? '#ffffff40' : '#e1caec0d'; ctx.fill();
  }
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, TAU); ctx.clip();
  cover(ctx, layerImage(layer, resources), -labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2); ctx.restore();
  ctx.beginPath(); ctx.arc(0, 0, labelRadius + 2, 0, TAU); ctx.strokeStyle = '#070810'; ctx.lineWidth = 5; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, Math.max(5, r * 0.025), 0, TAU); ctx.fillStyle = '#bbb8c4'; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, Math.max(2, r * 0.011), 0, TAU); ctx.fillStyle = '#15151f'; ctx.fill();
}

function disc(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number, resources: SceneResources): void {
  const r = Math.min(layer.width, layer.height) * 0.48;
  ctx.save(); ctx.shadowColor = '#05061290'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 18;
  ctx.fillStyle = '#111119'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.restore();
  ctx.save(); ctx.rotate(discAngleAtTime(timeSec, numberParam(layer, 'rpm', 8)));
  const key = `disc:${imageKey(layerImage(layer, resources))}:${r}:${layer.params.skin}:${layer.params.labelRatio}`;
  const diameter = Math.ceil(r * 2 + 2);
  const cached = staticSurface(key, diameter, diameter, context => paintDiscSurface(context, layer, resources));
  if (cached) ctx.drawImage(cached, -diameter / 2, -diameter / 2, diameter, diameter);
  else paintDiscSurface(ctx, layer, resources);
  ctx.restore();
  if (layer.params.tonearm !== false) {
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = '#00000090'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 3;
    ctx.beginPath(); ctx.moveTo(r * 0.28, -r * 1.02); ctx.bezierCurveTo(r * 0.34, -r * 0.79, r * 0.4, -r * 0.65, r * 0.62, -r * 0.51);
    ctx.strokeStyle = '#dcdde5'; ctx.lineWidth = r * 0.033; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r * 0.28, -r * 1.02); ctx.bezierCurveTo(r * 0.34, -r * 0.79, r * 0.4, -r * 0.65, r * 0.62, -r * 0.51);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = r * 0.014; ctx.stroke();
    ctx.translate(r * 0.62, -r * 0.51); ctx.rotate(0.58);
    ctx.fillStyle = '#f1f1f5'; roundedRect(ctx, -r * 0.06, -r * 0.035, r * 0.15, r * 0.072, 3); ctx.fill();
    ctx.fillStyle = '#9595a4'; ctx.fillRect(r * 0.075, -r * 0.017, r * 0.045, r * 0.034); ctx.restore();
  }
}

function fittedFont(ctx: CanvasRenderingContext2D, text: string, size: number, maxWidth: number, typography: TextTypography, family = FONT): number {
  ctx.font = canvasFont(size, family, typography);
  const result = Math.max(Math.min(10, size), Math.min(size, size * Math.max(1, maxWidth) / Math.max(1, ctx.measureText(text).width)));
  ctx.font = canvasFont(result, family, typography);
  return result;
}

function lyricInk(ctx: CanvasRenderingContext2D, text: string, size: number) {
  const metrics = ctx.measureText(text);
  const advance = Number.isFinite(metrics.width) ? Math.max(1, metrics.width) : Math.max(1, size * text.length);
  const alignment = ctx.textAlign === 'center' ? .5 : ctx.textAlign === 'right' ? 1 : 0;
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? -metrics.actualBoundingBoxLeft : -advance * alignment;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : advance * (1 - alignment);
  const top = Number.isFinite(metrics.actualBoundingBoxAscent) ? -metrics.actualBoundingBoxAscent : 0;
  const bottom = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : size;
  return { width: Math.max(1, right - left), height: Math.max(1, bottom - top), cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

function lyricLine(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, width: number, typography: TextTypography,
  family: string, color: string, style: LyricTextStyle, glow: TextGlowStyle, planeParams: Layer['params']): void {
  ctx.save();
  withCanvasFontSynthesis(ctx, typography, () => {
    const fittedSize = fittedFont(ctx, text, size, width, typography, family);
    const paint = (target: CanvasRenderingContext2D, tx: number, ty: number): void => {
      target.fillStyle = color;
      target.lineJoin = 'round'; target.miterLimit = 2;
      paintTextGlow(target, text, tx, ty, glow, style.strokeWidth * 2);
      target.shadowColor = style.shadowEnabled ? colorWithOpacity(style.shadowColor, style.shadowOpacity) : 'rgba(0, 0, 0, 0)';
      target.shadowBlur = style.shadowEnabled ? style.shadowBlur : 0;
      target.shadowOffsetX = style.shadowEnabled ? style.shadowX : 0;
      target.shadowOffsetY = style.shadowEnabled ? style.shadowY : 0;
      if (style.strokeWidth > 0) {
        // Stroke first places the outline behind the glyph. Only the outermost
        // shape casts a shadow, so adding an outline does not double its opacity.
        target.strokeStyle = style.strokeColor; target.lineWidth = style.strokeWidth * 2;
        target.strokeText(text, tx, ty);
        target.shadowColor = 'rgba(0, 0, 0, 0)';
      }
      target.fillText(text, tx, ty);
    };
    const yaw = Number(planeParams.planeYaw ?? 0);
    // Preserve the original direct painting path, including font measurement,
    // alpha and clipping, for projects that do not turn their lyric planes.
    if (!Number.isFinite(yaw) || yaw === 0 || !text) { paint(ctx, x, y); return; }
    const font = ctx.font;
    const { width: inkWidth, height: inkHeight, cx, cy } = lyricInk(ctx, text, fittedSize);
    const outline = style.strokeWidth * 2;
    const halo = glow.enabled && glow.intensity > 0 ? glow.radius * 3 + outline : 0;
    const shadow = style.shadowEnabled ? style.shadowBlur * 3 + Math.max(Math.abs(style.shadowX), Math.abs(style.shadowY)) + outline : 0;
    const padding = Math.min(512, Math.max(2, outline, halo, shadow));
    // Each line spans the same normalized depth interval. Long hidden lyrics,
    // punctuation and independent font sizes cannot weaken another line's depth.
    const camera = { referenceWidth: inkWidth };
    const bounds = resolveTextPlane(inkWidth, inkHeight, planeParams, 0, camera);
    const anchorX = ctx.textAlign === 'left' ? x + cx - inkWidth / 2 - bounds.left
      : ctx.textAlign === 'right' ? x + cx + inkWidth / 2 - bounds.right : x + cx;
    // Apply scrolling/line layout after projection. Using the visible centre
    // here avoids adding font bearings or a row's vertical position to tilt.
    ctx.translate(anchorX, y + cy);
    withTextPlane(ctx, inkWidth, inkHeight, planeParams, plane => {
      withCanvasFontSynthesis(plane, typography, () => {
        plane.font = font;
        paint(plane, -cx, -cy);
      });
    }, padding, camera);
  });
  ctx.restore();
}

function lyrics(ctx: CanvasRenderingContext2D, layer: Layer, project: DemoProject, timeSec: number): void {
  const offset = project.lyricsOffsetMs / 1000;
  const time = timeSec - offset;
  const index = activeLyricIndex(project.lyrics, time);
  if (index < 0) return;
  const w = layer.width;
  const activeStyle = resolveLyricStyle(layer.params, true);
  const inactiveStyle = resolveLyricStyle(layer.params, false);
  const glow = resolveTextGlow(layer.params);
  const fontIds = resolveLyricFontIds(layer.params);
  const align = String(layer.params.align ?? 'center');
  const originalOnly = layer.params.mode === 'single';
  const isSingle = originalOnly || layer.params.mode === 'bilingual';
  const visibleCount = isSingle ? 1 : clamp(Math.round(numberParam(layer, 'lines', 3)), 1, 7);
  const lineGap = Math.max(0, numberParam(layer, 'lineGap', LYRIC_STYLE_DEFAULTS.lineGap));
  const translationGap = Math.max(0, numberParam(layer, 'translationGap', LYRIC_STYLE_DEFAULTS.translationGap));
  const blocks = layoutLyricBlocks(project.lyrics, index, activeStyle, inactiveStyle, { visibleCount, lineGap, translationGap, originalOnly });
  const padding = 12;
  const elapsed = time - project.lyrics[index].time;
  const previous = project.lyrics[index - 1];
  const hasPreviousWithoutGap = previous && (previous.end === undefined || previous.end >= project.lyrics[index].time);
  const step = hasPreviousWithoutGap ? (resolveLyricLayout(previous, inactiveStyle, { translationGap }).height + resolveLyricLayout(project.lyrics[index], activeStyle, { translationGap }).height) / 2 + lineGap : 0;
  const slide = isSingle || !hasPreviousWithoutGap ? 0 : (1 - clamp(elapsed / 0.38, 0, 1)) ** 3 * step;
  const transition = isSingle ? lyricTransitionAtTime(project.lyrics, index, time, project.duration - offset,
    String(layer.params.transition ?? LYRIC_STYLE_DEFAULTS.transition), numberParam(layer, 'transitionDuration', LYRIC_STYLE_DEFAULTS.transitionDuration), activeStyle.fontSize * 0.7) : null;
  if (transition && transition.alpha <= 0) return;
  ctx.save();
  // The rectangular selection is an editing control, not a mask. Display count
  // selects the rows; their first/last glyphs remain complete at every angle.
  ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center'; ctx.textBaseline = 'top';
  if (transition) { ctx.globalAlpha *= transition.alpha; ctx.translate(0, transition.offsetY); ctx.scale(transition.scale, transition.scale); }
  const x = align === 'left' ? -w / 2 + padding : align === 'right' ? w / 2 - padding : 0;
  for (const block of blocks) {
    const style = block.style;
    const family = fontFamilyForId(fontIds.original, style.fontWeightSynthesis);
    const translationFamily = fontFamilyForId(fontIds.translation, style.translationFontWeightSynthesis);
    const top = block.top + slide;
    ctx.save(); ctx.globalAlpha *= style.opacity;
    block.originalLines.forEach((text, line) => lyricLine(ctx, text, x, top + line * block.originalLineHeight,
      style.fontSize, w - padding * 2, { weight: style.fontWeight, italic: style.italic, synthesizeWeight: style.fontWeightSynthesis }, family, style.color, style, glow, layer.params));
    block.translationLines.forEach((text, line) => lyricLine(ctx, text, x, top + block.translationTop + line * block.translationLineHeight,
      style.translationSize, w - padding * 2, { weight: style.translationFontWeight, italic: style.translationItalic, synthesizeWeight: style.translationFontWeightSynthesis }, translationFamily, style.translationColor, style, glow, layer.params));
    ctx.restore();
  }
  ctx.restore();
}

function spectrum(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number, resources: SceneResources): void {
  const w = layer.width; const h = layer.height;
  const mode = String(layer.params.mode ?? 'bars');
  ctx.fillStyle = colorParam(layer, 'color', '#e6d9f5'); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2.8; ctx.lineCap = 'round';
  if (mode === 'ecg-wave') { drawSpectrumEcg(ctx, layer, timeSec, resources.analysis); return; }
  if (mode === 'dual-wave') { drawDualSpectrumWave(ctx, layer, timeSec, resources.analysis); return; }
  if (mode === 'wave') { drawSpectrumEnvelope(ctx, layer, timeSec, resources.analysis); return; }
  const values = sampleFeatures(resources.analysis, timeSec);
  const gain = clamp(numberParam(layer, 'gain', 1.3), 0, 10);
  const count = clamp(Math.round(numberParam(layer, 'barCount', 80)), 8, 256);
  if (mode === 'ring') {
    const radius = Math.min(w, h) * 0.31;
    for (let i = 0; i < count; i++) {
      const value = values[Math.min(values.length - 1, Math.floor(i * values.length / count))];
      const length = Math.max(1, value * Math.min(w, h) * 0.18 * gain);
      const angle = i / count * TAU - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius); ctx.lineTo(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length)); ctx.stroke();
    }
  } else {
    const spacing = w / count; const barWidth = Math.max(1, spacing * 0.68);
    for (let i = 0; i < count; i++) {
      const value = values[Math.min(values.length - 1, Math.floor(i * values.length / count))];
      const amplitude = Math.min(h, value ** 1.45 * h * gain);
      const barHeight = Math.max(2, amplitude);
      ctx.globalAlpha = layer.opacity * (0.32 + value * 0.58);
      ctx.fillRect(-w / 2 + spacing * i, h / 2 - barHeight, barWidth, barHeight);
    }
  }
}

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, direction = 1): void {
  ctx.beginPath(); ctx.moveTo(x + direction * width / 2, y); ctx.lineTo(x - direction * width / 2, y - height / 2); ctx.lineTo(x - direction * width / 2, y + height / 2); ctx.closePath(); ctx.fill();
}

function timeLabel(time: number): string {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function player(ctx: CanvasRenderingContext2D, layer: Layer, project: DemoProject, timeSec: number): void {
  const w = layer.width; const h = layer.height;
  ctx.fillStyle = colorParam(layer, 'color', '#ffffff'); ctx.strokeStyle = ctx.fillStyle;
  const y = -h * 0.2;
  ctx.save(); ctx.globalAlpha *= 0.92;
  triangle(ctx, -w * 0.26, y, 23, 29, -1); triangle(ctx, -w * 0.26 - 20, y, 23, 29, -1);
  triangle(ctx, w * 0.26, y, 23, 29); triangle(ctx, w * 0.26 + 20, y, 23, 29);
  roundedRect(ctx, -15, y - 19, 7, 38, 3.5); ctx.fill(); roundedRect(ctx, 8, y - 19, 7, 38, 3.5); ctx.fill();
  ctx.restore();
  if (layer.params.progress !== false) {
    const px = -w * 0.42; const py = h * 0.27; const trackW = w * 0.84;
    const fraction = clamp(timeSec / Math.max(0.01, project.duration), 0, 1);
    ctx.save(); ctx.globalAlpha *= 0.24; roundedRect(ctx, px, py, trackW, 4, 2); ctx.fill(); ctx.restore();
    ctx.save(); ctx.globalAlpha *= 0.7; roundedRect(ctx, px, py, Math.max(1, trackW * fraction), 4, 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px + trackW * fraction, py + 2, 7, 0, TAU); ctx.fill(); ctx.restore();
  }
  if (layer.params.time !== false) {
    ctx.font = `400 15px ${FONT}`; ctx.textBaseline = 'top'; ctx.globalAlpha *= 0.62;
    ctx.textAlign = 'left'; ctx.fillText(timeLabel(timeSec), -w * 0.42, h * 0.35);
    ctx.textAlign = 'right'; ctx.fillText(timeLabel(project.duration), w * 0.42, h * 0.35);
  }
}

function title(ctx: CanvasRenderingContext2D, layer: Layer, project: DemoProject): void {
  const size = numberParam(layer, 'fontSize', 26);
  const glow = resolveTextGlow(layer.params);
  const fontId = typeof layer.params.fontId === 'string' ? layer.params.fontId : undefined;
  ctx.fillStyle = colorParam(layer, 'color', '#eeebf5'); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.save(); ctx.beginPath(); ctx.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height); ctx.clip();
  const mainTypography = resolveTextTypography(layer.params, 'fontWeight', 'italic', 600);
  const subtitleTypography = resolveTextTypography(layer.params, 'subtitleFontWeight', 'subtitleItalic', 400);
  withCanvasFontSynthesis(ctx, mainTypography, () => {
    fittedFont(ctx, project.title || '未命名曲目', size, layer.width, mainTypography, fontFamilyForId(fontId, mainTypography.synthesizeWeight));
    paintTextGlow(ctx, project.title || '未命名曲目', -layer.width / 2, -layer.height / 2 + 4, glow);
    ctx.fillText(project.title || '未命名曲目', -layer.width / 2, -layer.height / 2 + 4);
  });
  ctx.globalAlpha *= 0.54;
  withCanvasFontSynthesis(ctx, subtitleTypography, () => {
    fittedFont(ctx, project.artist || 'UNKNOWN ARTIST', size * 0.52, layer.width, subtitleTypography, fontFamilyForId(fontId, subtitleTypography.synthesizeWeight));
    paintTextGlow(ctx, project.artist || 'UNKNOWN ARTIST', -layer.width / 2, -layer.height / 2 + size * 1.45, glow);
    ctx.fillText(project.artist || 'UNKNOWN ARTIST', -layer.width / 2, -layer.height / 2 + size * 1.45);
  });
  ctx.restore();
}

function textBox(ctx: CanvasRenderingContext2D, layer: Layer): void {
  const text = String(layer.params.text ?? '');
  if (!text) return;
  const glow = resolveTextGlow(layer.params);
  const size = clamp(numberParam(layer, 'fontSize', 48), 8, 300);
  const advance = size * clamp(numberParam(layer, 'lineHeight', 1.3), .5, 4);
  const align = layer.params.align === 'center' ? 'center' : layer.params.align === 'right' ? 'right' : 'left';
  ctx.save(); ctx.beginPath(); ctx.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height); ctx.clip();
  const typography = resolveTextTypography(layer.params, 'fontWeight', 'italic', 400, 'fontWeightSynthesis');
  const family = fontFamilyForId(typeof layer.params.fontId === 'string' ? layer.params.fontId : undefined, typography.synthesizeWeight);
  withCanvasFontSynthesis(ctx, typography, () => {
    ctx.font = canvasFont(size, family, typography);
    ctx.textBaseline = 'top'; ctx.textAlign = align;
    ctx.fillStyle = colorParam(layer, 'color', '#ffffff');
    const x = align === 'left' ? -layer.width / 2 : align === 'right' ? layer.width / 2 : 0;
    const lines = wrapTextLines(text, layer.width, line => ctx.measureText(line).width);
    for (let index = 0; index < lines.length && index * advance < layer.height; index++) {
      paintTextGlow(ctx, lines[index], x, -layer.height / 2 + index * advance, glow);
      ctx.fillText(lines[index], x, -layer.height / 2 + index * advance);
    }
  });
  ctx.restore();
}

function selection(ctx: CanvasRenderingContext2D, layer: Layer, scale: number): void {
  const w = layer.width; const h = layer.height;
  ctx.strokeStyle = '#c6b4ff'; ctx.lineWidth = 1.4 / scale; ctx.setLineDash([]); ctx.strokeRect(-w / 2, -h / 2, w, h);
  const size = 7 / scale;
  for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
    ctx.fillStyle = '#f4edff'; ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeStyle = '#8d76b5'; ctx.lineWidth = 1 / scale; ctx.strokeRect(x - size / 2, y - size / 2, size, size);
  }
}

/**
 * Shared deterministic Canvas2D renderer. Layer coordinates use project pixels
 * and x/y denote each layer's center. This function owns output-size scaling.
 */
function paintLayer(ctx:CanvasRenderingContext2D,layer:Layer,project:DemoProject,timeSec:number,resources:SceneResources):void {
    switch (layer.type) {
      case 'background': background(ctx, layer, resources); break;
      case 'image': image(ctx, layer, resources); break;
      case 'video': video(ctx, layer, resources); break;
      case 'disc': disc(ctx, layer, timeSec, resources); break;
      case 'lyrics': lyrics(ctx, layer, project, timeSec); break;
      case 'spectrum': spectrum(ctx, layer, timeSec, resources); break;
      case 'player': player(ctx, layer, project, timeSec); break;
      case 'title': withTextTransition(ctx, layer, timeSec, () => title(ctx, layer, project)); break;
      case 'text': withTextTransition(ctx, layer, timeSec, () => textBox(ctx, layer)); break;
      case 'particles':
        ctx.save(); ctx.translate(-layer.width / 2, -layer.height / 2);
        drawParticles(ctx, layer, timeSec); ctx.restore(); break;
      case 'atmosphere':
        ctx.save(); ctx.translate(-layer.width / 2, -layer.height / 2);
        drawAtmosphere(ctx, layer, timeSec); ctx.restore(); break;
    }
}

export function renderScene(ctx: CanvasRenderingContext2D, project: DemoProject, timeSec: number, resources: SceneResources, options: RenderOptions = {}): void {
  const sx = ctx.canvas.width / project.width; const sy = ctx.canvas.height / project.height;
  ctx.save();
  try {
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.fillStyle = '#181923'; ctx.fillRect(0, 0, project.width, project.height);
    for (const layer of project.layers) {
      if (!layer.visible || layer.width <= 0 || layer.height <= 0 || timeSec < layer.start || timeSec >= layer.end) continue;
      ctx.save();
      try {
        ctx.translate(layer.x, layer.y);ctx.rotate(layer.rotation*Math.PI/180);ctx.globalAlpha=clamp(layer.opacity,0,1);
        const effects=layer.opacity>0?prepareLayerEffects(layer,project,timeSec,resources):[];
        const stage=effects.length?layerEffectStage(project.width,project.height):null;
        if(stage) {
          const target=stage.ctx;
          target.save();
          try {
            target.setTransform(1,0,0,1,0,0);target.globalAlpha=1;target.globalCompositeOperation='source-over';target.filter='none';
            target.clearRect(0,0,stage.canvas.width,stage.canvas.height);
            target.translate(layer.x,layer.y);target.rotate(layer.rotation*Math.PI/180);target.globalAlpha=clamp(layer.opacity,0,1);
            const isolated=layer.type==='atmosphere'?{...layer,params:{...layer.params,blendMode:'normal'}}:layer;
            paintLayer(target,isolated,project,timeSec,resources);
          } finally {target.restore();}
          const output=applyOrderedEffects(stage,effects,layer,timeSec);
          ctx.save();
          try {
            ctx.setTransform(sx,0,0,sy,0,0);ctx.globalAlpha=1;
            ctx.globalCompositeOperation=layer.type==='atmosphere'?(layer.params.blendMode==='add'?'lighter':layer.params.blendMode==='normal'?'source-over':'screen'):'source-over';
            ctx.drawImage(output,0,0,project.width,project.height);
          } finally {ctx.restore();}
        } else paintLayer(ctx,layer,project,timeSec,resources);
        if(options.editor&&options.selectionId===layer.id){ctx.globalAlpha=1;selection(ctx,layer,Math.max(.1,Math.min(sx,sy)));}
      } finally {ctx.restore();}
    }
  } finally {ctx.restore();}
}
