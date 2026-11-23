import type { Layer, LayerParams } from './types';

export type AtmosphereKind = 'leak' | 'fog' | 'rays';
export const ATMOSPHERE_KINDS: readonly { value: AtmosphereKind; label: string }[] = [
  { value: 'leak', label: '光泄漏' }, { value: 'fog', label: '薄雾' }, { value: 'rays', label: '光束' },
];
export const ATMOSPHERE_PRESETS: readonly { value: string; label: string; kind: AtmosphereKind }[] = [
  { value: 'warm-edge', label: '暖色边光', kind: 'leak' },
  { value: 'cool-wash', label: '冷色光斑', kind: 'leak' },
  { value: 'cool-mist', label: '清冷薄雾', kind: 'fog' },
  { value: 'warm-haze', label: '暖色烟霭', kind: 'fog' },
  { value: 'diagonal-rays', label: '窗边斜光', kind: 'rays' },
  { value: 'radial-rays', label: '放射光束', kind: 'rays' },
];
export const ATMOSPHERE_LIMITS: Record<string, readonly [number, number]> = {
  intensity: [0, 1], speed: [0, 3], scale: [.2, 4], direction: [-180, 180],
  softness: [0, 1], variation: [0, 1], seed: [1, 999999], fadeIn: [0, 3], fadeOut: [0, 3],
  sourceX: [0, 1], sourceY: [0, 1], density: [0, 1], spread: [5, 150], rayCount: [2, 20], length: [.2, 2],
};

export interface AtmosphereParams extends LayerParams {
  kind: AtmosphereKind; preset: string; color: string; secondaryColor: string;
  blendMode: 'normal' | 'screen' | 'add'; intensity: number; speed: number; scale: number;
  direction: number; softness: number; variation: number; seed: number; fadeIn: number; fadeOut: number;
  sourceX: number; sourceY: number; density: number; spread: number; rayCount: number; length: number;
}
const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const smooth = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const wrap = (value: number, size: number): number => ((value % size) + size) % size;
const kindValue = (value: unknown): AtmosphereKind => ATMOSPHERE_KINDS.some(item => item.value === value) ? value as AtmosphereKind : 'leak';
function hash(seed: number, id: number, channel: number): number {
  let n = seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function atmosphereDefaults(kind?: AtmosphereKind, presetId?: string): AtmosphereParams {
  const selectedKind = kindValue(kind);
  const preset = ATMOSPHERE_PRESETS.find(item => item.value === presetId && item.kind === selectedKind)
    ?? ATMOSPHERE_PRESETS.find(item => item.kind === selectedKind)!;
  const params: AtmosphereParams = {
    kind: selectedKind, preset: preset.value, color: '#ffad6b', secondaryColor: '#f15b77',
    blendMode: 'screen', intensity: .65, speed: .45, scale: 1, direction: 18, softness: .85,
    variation: .55, seed: 41729, fadeIn: .4, fadeOut: .4, sourceX: .12, sourceY: .03,
    density: .65, spread: 48, rayCount: 7, length: 1.1,
  };
  if (selectedKind === 'fog') Object.assign(params, {
    color: '#b7cde3', secondaryColor: '#cad7dd', blendMode: 'normal', intensity: .6,
    speed: .3, scale: 1.2, direction: -12, softness: .9, variation: .6, density: .6,
  });
  if (selectedKind === 'rays') Object.assign(params, {
    color: '#ffe6bb', secondaryColor: '#c8ddff', intensity: .65, speed: .35,
    direction: 62, softness: .8, variation: .3, spread: 42, rayCount: 7,
  });
  if (preset.value === 'cool-wash') Object.assign(params, {
    color: '#7caeff', secondaryColor: '#be8aff', direction: -25, scale: 1.3, variation: .65,
  });
  if (preset.value === 'warm-haze') Object.assign(params, {
    color: '#e7c7a7', secondaryColor: '#c5a1b6', direction: 15, scale: 1.5, density: .5,
  });
  if (preset.value === 'radial-rays') Object.assign(params, {
    color: '#c4dfff', secondaryColor: '#eee0ff', sourceX: .5, sourceY: .06,
    direction: 90, spread: 112, rayCount: 12, length: 1.3, variation: .5,
  });
  return params;
}

export function resolveAtmosphereParams(params: LayerParams): AtmosphereParams {
  const defaults = atmosphereDefaults(kindValue(params.kind), typeof params.preset === 'string' ? params.preset : undefined);
  const result = { ...defaults };
  for (const [key, [min, max]] of Object.entries(ATMOSPHERE_LIMITS)) {
    const raw = params[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, min, max) : defaults[key];
    result[key] = key === 'seed' || key === 'rayCount' ? Math.round(Number(value)) : value;
  }
  for (const key of ['color', 'secondaryColor'] as const) {
    if (typeof params[key] === 'string' && /^#[\da-f]{6}$/i.test(params[key])) result[key] = params[key];
  }
  if (['normal', 'screen', 'add'].includes(String(params.blendMode))) result.blendMode = params.blendMode as AtmosphereParams['blendMode'];
  return result;
}

/** The two fades share the available duration proportionally, including very short clips. */
export function atmosphereFade(layer: Pick<Layer, 'start' | 'end' | 'params'>, timeSec: number): number {
  if (![layer.start, layer.end, timeSec].every(Number.isFinite) || layer.end <= layer.start || timeSec < layer.start || timeSec >= layer.end) return 0;
  const p = resolveAtmosphereParams(layer.params); const duration = layer.end - layer.start;
  const scale = Math.min(1, duration / Math.max(.000001, p.fadeIn + p.fadeOut));
  const fadeIn = p.fadeIn * scale; const fadeOut = p.fadeOut * scale;
  return Math.min(fadeIn > 0 ? smooth((timeSec - layer.start) / fadeIn) : 1,
    fadeOut > 0 ? smooth((layer.end - timeSec) / fadeOut) : 1);
}

export interface AtmosphereGlow { x: number; y: number; width: number; height: number; angle: number; alpha: number; color: string }
export interface AtmosphereBeam { angle: number; width: number; length: number; alpha: number; color: string }
export interface AtmosphereFogPlane { x: number; y: number; tileSize: number; angle: number; alpha: number; color: string; seed: number }
export interface AtmosphereSample {
  kind: AtmosphereKind; sourceX: number; sourceY: number;
  glows: AtmosphereGlow[]; beams: AtmosphereBeam[]; fog: AtmosphereFogPlane[];
}

/** Pure local-time sampling: no wall clock, advancing random generator, or frame history. */
export function sampleAtmosphere(params: LayerParams, localTimeSec: number, width: number, height: number): AtmosphereSample | null {
  if (![localTimeSec, width, height].every(Number.isFinite) || localTimeSec < 0 || width <= 0 || height <= 0) return null;
  const p = resolveAtmosphereParams(params); const t = Math.min(localTimeSec, 1e12) * p.speed;
  const sample: AtmosphereSample = { kind: p.kind, sourceX: width * p.sourceX, sourceY: height * p.sourceY, glows: [], beams: [], fog: [] };
  const rad = p.direction * Math.PI / 180;
  if (p.kind === 'leak') {
    const cool = p.preset === 'cool-wash';
    for (let id = 0; id < 4; id++) {
      const phase = hash(p.seed, id, 0) * TAU;
      const drift = Math.sin(t * (.13 + hash(p.seed, id, 1) * .13) + phase) * p.variation;
      sample.glows.push({
        x: width * ((id % 2 ? 1 - p.sourceX : p.sourceX) + drift * .14),
        y: height * (p.sourceY + (.12 + hash(p.seed, id, 2) * .7) * (1 - p.sourceY) + Math.cos(t * .14 + phase) * .1 * p.variation),
        width: width * (cool ? .42 : .22) * p.scale * (1 + drift * .12),
        height: height * (.55 + hash(p.seed, id, 3) * .45) * p.scale,
        angle: rad + Math.sin(t * .07 + phase) * .13 * p.variation,
        alpha: (.45 + hash(p.seed, id, 4) * .3) * (1 + drift * .15),
        color: id % 2 ? p.secondaryColor : p.color,
      });
    }
  } else if (p.kind === 'fog') {
    for (let id = 0; id < 3; id++) {
      const tileSize = Math.min(width, height) * (1.1 + p.scale * .9) * (1 + id * .24);
      const direction = rad + id * .47; const phase = hash(p.seed, id, 5) * TAU;
      sample.fog.push({
        x: wrap(hash(p.seed, id, 6) * tileSize + t * Math.cos(direction) * width * .015 * (1 + id * .23), tileSize),
        y: wrap(hash(p.seed, id, 7) * tileSize + t * Math.sin(direction) * height * .015 + Math.sin(t * .08 + phase) * height * .07 * p.variation, tileSize),
        tileSize, angle: (id - 1) * .22, alpha: p.density * (.48 - id * .07),
        color: id === 1 ? p.secondaryColor : p.color, seed: p.seed + id * 193,
      });
    }
  } else {
    const reach = Math.hypot(width, height) * p.length;
    for (let id = 0; id < p.rayCount; id++) {
      const position = id / (p.rayCount - 1) - .5;
      const phase = hash(p.seed, id, 8) * TAU;
      const sway = Math.sin(t * .17 + phase) * p.variation;
      sample.beams.push({
        angle: rad + (position * p.spread + (hash(p.seed, id, 9) - .5) * p.spread / p.rayCount * .6 + sway * p.spread * .025) * Math.PI / 180,
        width: reach * Math.tan(Math.min(.25, p.spread / p.rayCount * Math.PI / 180 * (.22 + hash(p.seed, id, 10) * .25))) * p.scale,
        length: reach * (.74 + hash(p.seed, id, 11) * .26),
        alpha: (.22 + hash(p.seed, id, 12) * .3) * (1 + sway * .16),
        color: id % 3 === 1 ? p.secondaryColor : p.color,
      });
    }
  }
  return sample;
}

type Surface = OffscreenCanvas | HTMLCanvasElement;
interface CachedSurface { surface: Surface; ctx: CanvasRenderingContext2D; bytes: number }
const surfaces = new Map<string, CachedSurface>();
const MAX_CACHE_BYTES = 8 * 1024 * 1024; const MAX_CACHE_ENTRIES = 28; const WORK_LONG_SIDE = 640; const NOISE_SIDE = 128;
let cacheBytes = 0;
export function clearAtmosphereCache(): void { surfaces.clear(); cacheBytes = 0; }
export function atmosphereCacheStats(): { bytes: number; entries: number; byteBudget: number; entryLimit: number } {
  return { bytes: cacheBytes, entries: surfaces.size, byteBudget: MAX_CACHE_BYTES, entryLimit: MAX_CACHE_ENTRIES };
}
function surfaceFor(key: string, width: number, height: number): CachedSurface | null {
  const previous = surfaces.get(key);
  if (previous) { surfaces.delete(key); surfaces.set(key, previous); return previous; }
  let surface: Surface;
  if (typeof OffscreenCanvas !== 'undefined') surface = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') { surface = document.createElement('canvas'); surface.width = width; surface.height = height; }
  else return null;
  const ctx = surface.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const entry = { surface, ctx, bytes: width * height * 4 };
  while (surfaces.size && (cacheBytes + entry.bytes > MAX_CACHE_BYTES || surfaces.size >= MAX_CACHE_ENTRIES)) {
    const oldest = surfaces.keys().next().value!; cacheBytes -= surfaces.get(oldest)!.bytes; surfaces.delete(oldest);
  }
  surfaces.set(key, entry); cacheBytes += entry.bytes; return entry;
}

/** Periodic, four-octave value noise is created only when a seed/color enters the bounded cache. */
function cloudTexture(seed: number, color: string): Surface | null {
  const key = `cloud:${seed}:${color.toLowerCase()}`;
  const previous = surfaces.get(key);
  if (previous) { surfaces.delete(key); surfaces.set(key, previous); return previous.surface; }
  const entry = surfaceFor(key, NOISE_SIDE, NOISE_SIDE);
  if (!entry) return null;
  const { ctx, surface } = entry;
  if (typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') return surface;
  const image = ctx.createImageData(NOISE_SIDE, NOISE_SIDE);
  const red = parseInt(color.slice(1, 3), 16); const green = parseInt(color.slice(3, 5), 16); const blue = parseInt(color.slice(5, 7), 16);
  for (let y = 0; y < NOISE_SIDE; y++) for (let x = 0; x < NOISE_SIDE; x++) {
    let noise = 0; let weight = .56; let total = 0;
    for (let octave = 0; octave < 4; octave++) {
      const cells = 4 << octave; const nx = x / NOISE_SIDE * cells; const ny = y / NOISE_SIDE * cells;
      const ix = Math.floor(nx); const iy = Math.floor(ny); const fx = smooth(nx - ix); const fy = smooth(ny - iy);
      const point = (px: number, py: number): number => hash(seed, wrap(px, cells) + wrap(py, cells) * cells, octave);
      const top = point(ix, iy) * (1 - fx) + point(ix + 1, iy) * fx;
      const bottom = point(ix, iy + 1) * (1 - fx) + point(ix + 1, iy + 1) * fx;
      noise += (top * (1 - fy) + bottom * fy) * weight; total += weight; weight *= .5;
    }
    const value = smooth((noise / total - .2) / .65);
    const index = (x + y * NOISE_SIDE) * 4;
    image.data[index] = red; image.data[index + 1] = green; image.data[index + 2] = blue;
    image.data[index + 3] = Math.round((.025 + value * value * .9) * 255);
  }
  ctx.putImageData(image, 0, 0); return surface;
}

function glow(ctx: CanvasRenderingContext2D, item: AtmosphereGlow, softness: number): void {
  ctx.save();
  try {
    ctx.translate(item.x, item.y); ctx.rotate(item.angle); ctx.scale(item.width, item.height); ctx.globalAlpha *= item.alpha;
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, `${item.color}d0`);
    gradient.addColorStop(.12 + (1 - softness) * .25, `${item.color}90`);
    gradient.addColorStop(.65, `${item.color}25`); gradient.addColorStop(1, `${item.color}00`);
    ctx.fillStyle = gradient; ctx.fillRect(-1, -1, 2, 2);
  } finally { ctx.restore(); }
}

function drawSample(ctx: CanvasRenderingContext2D, sample: AtmosphereSample, p: AtmosphereParams, width: number, height: number): void {
  for (const item of sample.glows) glow(ctx, item, p.softness);
  for (const item of sample.fog) {
    const texture = cloudTexture(item.seed, item.color);
    const pattern = texture ? ctx.createPattern(texture, 'repeat') : null;
    ctx.save();
    try {
      ctx.globalAlpha *= item.alpha; ctx.translate(width / 2, height / 2); ctx.rotate(item.angle);
      if (pattern) {
        const extent = Math.hypot(width, height) / 2 + item.tileSize;
        const scale = item.tileSize / NOISE_SIDE;
        ctx.translate(item.x, item.y); ctx.scale(scale, scale); ctx.fillStyle = pattern;
        // One repeat-pattern rasterization avoids antialiased gaps and double-alpha
        // seams where separately transformed drawImage tiles would meet.
        ctx.fillRect((-extent - item.x) / scale, (-extent - item.y) / scale, extent * 2 / scale, extent * 2 / scale);
      } else {
        // Canvas-less clients retain a soft, continuous approximation rather than discrete particles.
        for (let id = 0; id < 6; id++) glow(ctx, {
          x: (hash(item.seed, id, 0) - .5) * width + item.x * .2,
          y: (hash(item.seed, id, 1) - .5) * height + item.y * .2,
          width: width * .7, height: height * .65, angle: id * .3, alpha: .45, color: item.color,
        }, p.softness);
      }
    } finally { ctx.restore(); }
  }
  for (const beam of sample.beams) {
    ctx.save();
    try {
      ctx.translate(sample.sourceX, sample.sourceY); ctx.rotate(beam.angle); ctx.globalAlpha *= beam.alpha;
      const gradient = ctx.createLinearGradient(0, 0, beam.length, 0);
      gradient.addColorStop(0, `${beam.color}00`); gradient.addColorStop(.04, `${beam.color}b0`);
      gradient.addColorStop(.35, `${beam.color}88`); gradient.addColorStop(.75, `${beam.color}32`); gradient.addColorStop(1, `${beam.color}00`);
      ctx.fillStyle = gradient;
      // Nested transparent wedges approximate a smooth cross-beam profile without full-frame blur.
      const bands = 10;
      for (let band = 0; band < bands; band++) {
        const fraction = 1 - band / bands * p.softness * .92;
        const halfWidth = beam.width * fraction;
        ctx.save();
        try {
          ctx.globalAlpha *= 1 / (1 + bands * .38);
          ctx.beginPath(); ctx.moveTo(0, -halfWidth * .015); ctx.lineTo(beam.length, -halfWidth);
          ctx.lineTo(beam.length, halfWidth); ctx.lineTo(0, halfWidth * .015); ctx.closePath(); ctx.fill();
        } finally { ctx.restore(); }
      }
    } finally { ctx.restore(); }
  }
  if (sample.kind === 'rays') glow(ctx, {
    x: sample.sourceX, y: sample.sourceY, width: width * .16 * p.scale, height: height * .18 * p.scale,
    angle: 0, alpha: .45, color: p.color,
  }, p.softness);
}

function featherEdges(ctx: CanvasRenderingContext2D, width: number, height: number, softness: number): void {
  const margin = Math.max(1, Math.min(width, height) * (.015 + softness * .12));
  ctx.save();
  try {
    ctx.globalCompositeOperation = 'destination-out';
    for (const [x0, y0, x1, y1, x, y, w, h] of [
      [0, 0, margin, 0, 0, 0, margin, height], [width, 0, width - margin, 0, width - margin, 0, margin, height],
      [0, 0, 0, margin, 0, 0, width, margin], [0, height, 0, height - margin, 0, height - margin, width, margin],
    ]) {
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      gradient.addColorStop(0, '#ffffffff'); gradient.addColorStop(1, '#ffffff00');
      ctx.fillStyle = gradient; ctx.fillRect(x, y, w, h);
    }
  } finally { ctx.restore(); }
}

/** Caller supplies the layer transform and opacity; this component never changes surrounding layers. */
export function drawAtmosphere(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number): void {
  const fade = atmosphereFade(layer, timeSec); const p = resolveAtmosphereParams(layer.params);
  if (fade <= 0 || p.intensity <= 0 || (p.kind === 'fog' && p.density === 0)) return;
  if (![layer.width, layer.height].every(Number.isFinite) || layer.width <= 0 || layer.height <= 0) return;
  const ratio = Math.min(1, WORK_LONG_SIDE / Math.max(layer.width, layer.height));
  const width = Math.max(1, Math.round(layer.width * ratio)); const height = Math.max(1, Math.round(layer.height * ratio));
  const work = surfaceFor(`work:${width}:${height}`, width, height);
  const blend = p.blendMode === 'add' ? 'lighter' : p.blendMode === 'screen' ? 'screen' : 'source-over';
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(0, 0, layer.width, layer.height); ctx.clip();
    ctx.globalAlpha *= fade * p.intensity; ctx.globalCompositeOperation = blend;
    if (work) {
      const sample = sampleAtmosphere(p, timeSec - layer.start, width, height)!;
      const target = work.ctx;
      target.save();
      try {
        target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = 'source-over'; target.filter = 'none';
        target.clearRect(0, 0, width, height); drawSample(target, sample, p, width, height); featherEdges(target, width, height, p.softness);
      } finally { target.restore(); }
      ctx.drawImage(work.surface, 0, 0, layer.width, layer.height);
    } else {
      drawSample(ctx, sampleAtmosphere(p, timeSec - layer.start, layer.width, layer.height)!, p, layer.width, layer.height);
    }
  } finally { ctx.restore(); }
}
