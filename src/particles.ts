import type { Layer, LayerParams } from './types';

export type ParticlePreset = 'stardust' | 'firefly' | 'snow' | 'rain' | 'petals' | 'bokeh';
export const PARTICLE_PRESETS: readonly { value: ParticlePreset; label: string }[] = [
  { value: 'stardust', label: '星尘' }, { value: 'firefly', label: '萤火' },
  { value: 'snow', label: '飘雪' }, { value: 'rain', label: '细雨' },
  { value: 'petals', label: '花瓣' }, { value: 'bokeh', label: '散景' },
];
export const PARTICLE_LIMITS: Record<string, readonly [number, number]> = {
  count: [10, 400], size: [1, 40], speed: [.05, 4], wind: [-2, 2],
  turbulence: [0, 2], particleOpacity: [0, 1], seed: [1, 999999], twinkle: [0, 1],
};

interface ParticleParams extends LayerParams {
  preset: ParticlePreset; count: number; size: number; speed: number; wind: number;
  turbulence: number; particleOpacity: number; color: string; seed: number; twinkle: number;
}
export interface ParticleSample {
  id: number; preset: ParticlePreset; x: number; y: number; size: number;
  alpha: number; rotation: number; length: number; aspect: number;
}

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const wrap = (value: number, extent: number): number => ((value % extent) + extent) % extent;
const ease = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
function presetValue(value: unknown): ParticlePreset {
  return PARTICLE_PRESETS.some(preset => preset.value === value) ? value as ParticlePreset : 'stardust';
}

/** Flat scalar settings remain compatible with the project file format. */
export function particleDefaults(preset?: ParticlePreset): ParticleParams {
  const value = presetValue(preset);
  const looks: Record<ParticlePreset, [number, number, number, number, number, string]> = {
    stardust: [4, .7, .1, .5, .65, '#d7e5ff'],
    firefly: [6, .6, .1, 1, .85, '#e1ffa2'],
    snow: [5, 1, .2, .65, .1, '#ffffff'],
    rain: [5, 1, .15, .1, 0, '#bfd5f5'],
    petals: [14, .8, .45, .8, .08, '#ffc3d5'],
    bokeh: [22, .5, .05, .3, .3, '#f1c7a5'],
  };
  const [size, speed, wind, turbulence, twinkle, color] = looks[value];
  return { preset: value, count: 80, size, speed, wind, turbulence, particleOpacity: .8, color, seed: 31279, twinkle };
}

export function resolveParticleParams(params: LayerParams): ParticleParams {
  const defaults = particleDefaults(presetValue(params.preset));
  const resolved = { ...defaults };
  for (const [key, [min, max]] of Object.entries(PARTICLE_LIMITS)) {
    const raw = params[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, min, max) : defaults[key];
    resolved[key] = key === 'seed' || key === 'count' ? Math.round(Number(value)) : value;
  }
  resolved.color = typeof params.color === 'string' && /^#[\da-f]{6}$/i.test(params.color) ? params.color : defaults.color;
  return resolved;
}

// Independent hashes make a particle's identity stable when density changes.
function random(seed: number, id: number, channel: number): number {
  let n = seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** No frame history or clock: arbitrary seeks and out-of-order export agree. */
export function sampleParticles(params: LayerParams, localTimeSec: number, width: number, height: number): ParticleSample[] {
  if (![localTimeSec, width, height].every(Number.isFinite) || localTimeSec < 0 || width <= 0 || height <= 0) return [];
  const p = resolveParticleParams(params);
  const t = localTimeSec * p.speed;
  const samples: ParticleSample[] = [];
  for (let id = 0; id < p.count; id++) {
    const r = (channel: number): number => random(p.seed, id, channel);
    const phase = r(2) * TAU;
    const size = p.size * (.45 + r(3) * .55);
    let vx = p.wind * 28 + (r(4) - .5) * 12;
    let vy = -12 - r(5) * 18;
    let sway = 12; let frequency = .45;
    switch (p.preset) {
      case 'firefly': vx = p.wind * 25 + (r(4) - .5) * 14; vy = -9 - r(5) * 12; sway = 30; frequency = .7; break;
      case 'snow': vx = p.wind * 48 + (r(4) - .5) * 12; vy = 30 + r(5) * 35; sway = 18; frequency = .65; break;
      case 'rain': vx = p.wind * 145 + (r(4) - .5) * 8; vy = 400 + r(5) * 220; sway = 1.5; frequency = 1.2; break;
      case 'petals': vx = p.wind * 55 + 18 + r(4) * 10; vy = 22 + r(5) * 28; sway = 26; frequency = .7; break;
      case 'bokeh': vx = p.wind * 18 + (r(4) - .5) * 6; vy = -6 - r(5) * 8; sway = 16; frequency = .3; break;
    }
    const dx = Math.sin(t * frequency + phase) * sway * p.turbulence;
    const dy = Math.cos(t * frequency * .63 + phase) * sway * p.turbulence * .3;
    const x = wrap(r(0) * width + vx * t + dx, width);
    const y = wrap(r(1) * height + vy * t + dy, height);
    // Every wrap happens at zero alpha. Fade a small interior margin too, so
    // large sprites never appear abruptly cut by the component rectangle.
    const margin = Math.min(Math.min(width, height) * .25, Math.max(size * 1.7, Math.min(width, height) * .025));
    const edge = ease(Math.min(x, width - x, y, height - y) / margin);
    const pulse = .5 + Math.sin(t * (1 + r(6) * 1.6) + phase) * .5;
    const flicker = 1 - p.twinkle * (1 - (p.preset === 'firefly' ? pulse * pulse : pulse));
    const alpha = p.particleOpacity * (.45 + r(7) * .55) * edge * flicker;
    const rotation = p.preset === 'rain' ? -Math.atan2(vx, vy) : phase + t * (r(8) - .5) * (p.preset === 'petals' ? 1.5 : .2);
    const length = p.preset === 'rain' ? size * (5 + r(9) * 4) : size * 2;
    const aspect = p.preset === 'petals' ? .18 + Math.abs(Math.cos(t * .85 + phase)) * .82 : 1;
    samples.push({ id, preset: p.preset, x, y, size, alpha, rotation, length, aspect });
  }
  return samples;
}

interface Sprite { source: CanvasImageSource; bytes: number }
const spriteCache = new Map<string, Sprite>();
const SPRITE_SIDE = 128;
const SPRITE_BYTE_BUDGET = 1024 * 1024;
const SPRITE_ENTRY_LIMIT = 24;
let spriteBytes = 0;
export function clearParticleCache(): void { spriteCache.clear(); spriteBytes = 0; }

function spriteFor(preset: ParticlePreset, color: string): CanvasImageSource | null {
  const key = `${preset}:${color.toLowerCase()}`;
  const previous = spriteCache.get(key);
  if (previous) { spriteCache.delete(key); spriteCache.set(key, previous); return previous.source; }
  let surface: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') surface = new OffscreenCanvas(SPRITE_SIDE, SPRITE_SIDE);
  else if (typeof document !== 'undefined') { surface = document.createElement('canvas'); surface.width = surface.height = SPRITE_SIDE; }
  else return null;
  const ctx = surface.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const c = SPRITE_SIDE / 2;
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  if (preset === 'snow') {
    glow.addColorStop(0, `${color}ff`); glow.addColorStop(.42, `${color}ed`); glow.addColorStop(1, `${color}00`);
  } else if (preset === 'bokeh') {
    glow.addColorStop(0, `${color}22`); glow.addColorStop(.55, `${color}38`);
    glow.addColorStop(.7, `${color}90`); glow.addColorStop(.82, `${color}38`); glow.addColorStop(1, `${color}00`);
  } else {
    glow.addColorStop(0, '#ffffffff'); glow.addColorStop(.07, `${color}ff`);
    glow.addColorStop(.28, `${color}80`); glow.addColorStop(.65, `${color}19`); glow.addColorStop(1, `${color}00`);
  }
  ctx.fillStyle = glow; ctx.fillRect(0, 0, SPRITE_SIDE, SPRITE_SIDE);
  if (preset === 'stardust') {
    ctx.fillStyle = `${color}c0`; ctx.beginPath();
    ctx.moveTo(c, c * .32); ctx.lineTo(c * 1.07, c * .93); ctx.lineTo(c * 1.68, c);
    ctx.lineTo(c * 1.07, c * 1.07); ctx.lineTo(c, c * 1.68); ctx.lineTo(c * .93, c * 1.07);
    ctx.lineTo(c * .32, c); ctx.lineTo(c * .93, c * .93); ctx.closePath(); ctx.fill();
  }
  const sprite: Sprite = { source: surface, bytes: SPRITE_SIDE * SPRITE_SIDE * 4 };
  while (spriteCache.size && (spriteBytes + sprite.bytes > SPRITE_BYTE_BUDGET || spriteCache.size >= SPRITE_ENTRY_LIMIT)) {
    const oldest = spriteCache.keys().next().value!;
    spriteBytes -= spriteCache.get(oldest)!.bytes; spriteCache.delete(oldest);
  }
  spriteCache.set(key, sprite); spriteBytes += sprite.bytes;
  return surface;
}

function petal(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.bezierCurveTo(size * 1.1, -size * .6, size * .8, size * .4, 0, size);
  ctx.bezierCurveTo(-size * .8, size * .35, -size * 1.05, -size * .65, 0, -size);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#ffffff70'; ctx.lineWidth = Math.max(.5, size * .04);
  ctx.beginPath(); ctx.moveTo(0, -size * .7); ctx.quadraticCurveTo(size * .14, 0, 0, size * .7); ctx.stroke();
}

/** Caller supplies its existing layer transform and alpha; origin is top-left. */
export function drawParticles(ctx: CanvasRenderingContext2D, layer: Layer, timeSec: number): void {
  if (!Number.isFinite(layer.start) || !Number.isFinite(layer.end) || timeSec >= layer.end) return;
  const samples = sampleParticles(layer.params, timeSec - layer.start, layer.width, layer.height);
  if (!samples.length) return;
  const p = resolveParticleParams(layer.params);
  if (p.particleOpacity === 0) return;
  const sprite = p.preset === 'rain' || p.preset === 'petals' ? null : spriteFor(p.preset, p.color);
  const inheritedAlpha = ctx.globalAlpha;
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(0, 0, layer.width, layer.height); ctx.clip();
    // Cached soft sprites avoid per-particle shadowBlur and full-frame filters.
    for (const item of samples) {
      if (item.alpha <= .0001) continue;
      ctx.save();
      try {
        ctx.globalAlpha = inheritedAlpha * item.alpha;
        ctx.translate(item.x, item.y); ctx.rotate(item.rotation);
        if (p.preset === 'rain') {
          ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(.65, item.size * .16); ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(0, -item.length / 2); ctx.lineTo(0, item.length / 2); ctx.stroke();
        } else if (p.preset === 'petals') {
          ctx.scale(item.aspect, 1); petal(ctx, item.size, p.color);
        } else if (sprite) {
          const radius = item.size * (p.preset === 'snow' ? 1.3 : p.preset === 'bokeh' ? 1.5 : 3);
          ctx.drawImage(sprite, -radius, -radius, radius * 2, radius * 2);
        } else {
          // Non-DOM renderers can still paint without retaining canvas state.
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(0, 0, item.size, 0, TAU); ctx.fill();
        }
      } finally { ctx.restore(); }
    }
  } finally { ctx.restore(); }
}
