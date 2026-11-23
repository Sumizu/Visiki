import type { LayerEffect } from './types';
import { activeLayerEffects } from './effects';

/** Bounds are in project pixels, before rotation around their center. */
export interface EffectBounds { x: number; y: number; width: number; height: number; rotation: number }
type EffectCanvas = HTMLCanvasElement | OffscreenCanvas;
const TAU = Math.PI * 2;
const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
const smooth = (a: number, b: number, value: number): number => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Bounded integer arithmetic is also used in GLSL, without a stateful random clock. */
export function sampleEffectNoise(x: number, y: number, seed: number, frame: number): number {
  let h = mod(Math.floor(x) * 127 + Math.floor(y) * 311 + mod(Math.round(seed), 4093) * 17 + mod(Math.floor(frame), 4093) * 131, 4093);
  h = mod(h * h, 4093);
  return mod(h * 251 + 37, 4093) / 4093;
}
export function effectAnimationFrame(localTimeSec: number, speed: number, frequency = 24): number {
  return mod(Math.floor(Math.max(0, Number.isFinite(localTimeSec) ? localTimeSec : 0) * Math.max(0, speed) * frequency + 1e-6), 4093);
}

function createCanvas(width: number, height: number): EffectCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}

/** Straight RGBA sampling. Outside the source is transparent, never an edge smear. */
function sample(input: Uint8ClampedArray, width: number, height: number, x: number, y: number, result: number[]): void {
  if (x < 0 || y < 0 || x >= width || y >= height) { result.fill(0); return; }
  const px = x - .5; const py = y - .5;
  const ix = Math.floor(px); const iy = Math.floor(py); const fx = px - ix; const fy = py - iy;
  const x0 = clamp(ix, 0, width - 1); const x1 = clamp(ix + 1, 0, width - 1);
  const y0 = clamp(iy, 0, height - 1); const y1 = clamp(iy + 1, 0, height - 1);
  const a = (y0 * width + x0) * 4; const b = (y0 * width + x1) * 4;
  const c = (y1 * width + x0) * 4; const d = (y1 * width + x1) * 4;
  const wa = (1 - fx) * (1 - fy); const wb = fx * (1 - fy); const wc = (1 - fx) * fy; const wd = fx * fy;
  const alpha = input[a + 3] * wa + input[b + 3] * wb + input[c + 3] * wc + input[d + 3] * wd;
  result[3] = alpha / 255;
  for (let channel = 0; channel < 3; channel++) result[channel] = alpha > 0 ? (input[a + channel] * input[a + 3] * wa + input[b + channel] * input[b + 3] * wb + input[c + channel] * input[c + 3] * wc + input[d + channel] * input[d + 3] * wd) / alpha / 255 : 0;
}

function renderEffectPixels(input: Uint8ClampedArray, output: Uint8ClampedArray, width: number, height: number, effect: LayerEffect, localTimeSec: number, bounds: EffectBounds): void {
  const p = effect.params; const n = (key: string) => Number(p[key]); const strength = effect.strength;
  const rotation = bounds.rotation * Math.PI / 180; const cos = Math.cos(rotation); const sin = Math.sin(rotation);
  const halfW = Math.max(.5, bounds.width / 2); const halfH = Math.max(.5, bounds.height / 2);
  const seed = n('seed') || 1; const speed = n('speed') || 0;
  const frame = effectAnimationFrame(localTimeSec, speed, effect.type === 'glitch' ? n('frequency') : 24);
  const flicker = (sampleEffectNoise(0, 0, seed + 17, frame) * 2 - 1) * (n('flicker') || 0);
  const angle = (n('angle') || 0) * Math.PI / 180 + rotation;
  const rgbOffset = (n('offset') || 0) * (1 + (n('animated') || 0) * Math.sin(Math.max(0, localTimeSec) * speed * TAU + mod(seed, 6283) / 1000));
  const dx = Math.cos(angle) * rgbOffset; const dy = Math.sin(angle) * rgbOffset;
  const first = [0, 0, 0, 0]; const second = [0, 0, 0, 0]; const third = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const originalR = input[offset] / 255; const originalG = input[offset + 1] / 255; const originalB = input[offset + 2] / 255; const originalA = input[offset + 3] / 255;
    let r = originalR; let g = originalG; let b = originalB; let alpha = originalA;
    const centerX = x + .5 - bounds.x; const centerY = y + .5 - bounds.y;
    const lx = centerX * cos + centerY * sin; const ly = -centerX * sin + centerY * cos;
    const nx = lx / halfW; const ny = ly / halfH;
    switch (effect.type) {
      case 'color': {
        const exposure = 2 ** n('exposure'); const brightness = n('brightness'); const contrast = n('contrast');
        r = (r * exposure + brightness - .5) * contrast + .5;
        g = (g * exposure + brightness - .5) * contrast + .5;
        b = (b * exposure + brightness - .5) * contrast + .5;
        r += n('temperature') * .15 + n('tint') * .05; g -= n('tint') * .1; b += -n('temperature') * .15 + n('tint') * .05;
        let luma = r * .2126 + g * .7152 + b * .0722;
        const lift = n('highlights') * .25 * smooth(.35, 1, luma) + n('shadows') * .25 * (1 - smooth(0, .65, luma));
        r += lift; g += lift; b += lift; luma += lift;
        r = clamp(luma + (r - luma) * n('saturation')); g = clamp(luma + (g - luma) * n('saturation')); b = clamp(luma + (b - luma) * n('saturation'));
        break;
      }
      case 'film': {
        const noise = (sampleEffectNoise(Math.floor((lx + halfW) / n('grainSize')), Math.floor((ly + halfH) / n('grainSize')), seed, frame) * 2 - 1) * n('grain') * .2;
        const vignette = 1 - n('vignette') * .8 * smooth(.25, 1.35, Math.hypot(nx, ny));
        const scratch = sampleEffectNoise(Math.floor((lx + halfW) / 2), 0, seed + 29, Math.floor(frame / 4)) > 1 - n('scratches') * .03 ? .35 * n('scratches') : 0;
        const grade = (channel: number) => clamp(((channel * (1 - n('faded')) + n('faded') * .5 + noise) * (1 + flicker) + scratch) * vignette);
        r = grade(r); g = grade(g); b = grade(b); break;
      }
      case 'rgb-split': {
        sample(input, width, height, x + .5 - dx, y + .5 - dy, first);
        sample(input, width, height, x + .5 + dx, y + .5 + dy, third);
        alpha = Math.max(first[3], originalA, third[3]);
        r = alpha > 0 ? first[0] * first[3] / alpha : 0;
        g = alpha > 0 ? originalG * originalA / alpha : 0;
        b = alpha > 0 ? third[2] * third[3] / alpha : 0; break;
      }
      case 'glitch': {
        const band = Math.floor((ly + halfH) / n('blockSize'));
        const amount = n('amount'); const trigger = sampleEffectNoise(band, 0, seed, frame);
        const displacement = trigger < amount * .65 ? (sampleEffectNoise(band, 1, seed, frame) * 2 - 1) * amount * Math.min(bounds.width, 600) * .2 : 0;
        const split = trigger < amount * .65 ? n('colorShift') * amount : 0;
        const px = x + .5 - displacement * cos; const py = y + .5 - displacement * sin;
        sample(input, width, height, px - split * cos, py - split * sin, first);
        sample(input, width, height, px, py, second);
        sample(input, width, height, px + split * cos, py + split * sin, third);
        alpha = Math.max(first[3], second[3], third[3]);
        r = alpha > 0 ? first[0] * first[3] / alpha : 0; g = alpha > 0 ? second[1] * second[3] / alpha : 0; b = alpha > 0 ? third[2] * third[3] / alpha : 0; break;
      }
      case 'crt': {
        const warpedX = lx * (1 + n('curvature') * ny * ny); const warpedY = ly * (1 + n('curvature') * nx * nx);
        sample(input, width, height, bounds.x + warpedX * cos - warpedY * sin, bounds.y + warpedX * sin + warpedY * cos, first);
        const scan = 1 - n('scanlines') * .55 * (.5 + .5 * Math.cos((ly + halfH) / n('lineSpacing') * TAU));
        const vignette = 1 - n('vignette') * .8 * smooth(.25, 1.35, Math.hypot(nx, ny));
        const multiplier = scan * vignette * (1 + flicker);
        r = clamp(first[0] * multiplier); g = clamp(first[1] * multiplier); b = clamp(first[2] * multiplier); alpha = first[3]; break;
      }
    }
    // Interpolate in premultiplied space, keeping colored transparent edges clean.
    const mixedA = originalA * (1 - strength) + alpha * strength;
    output[offset + 3] = mixedA * 255;
    if (mixedA <= 0) { output[offset] = 0; output[offset + 1] = 0; output[offset + 2] = 0; continue; }
    output[offset] = (originalR * originalA * (1 - strength) + r * alpha * strength) / mixedA * 255;
    output[offset + 1] = (originalG * originalA * (1 - strength) + g * alpha * strength) / mixedA * 255;
    output[offset + 2] = (originalB * originalA * (1 - strength) + b * alpha * strength) / mixedA * 255;
  }
}

/** CPU reference and fallback: does not mutate either pixels or effect parameters. */
export function renderEffectsPixels(input: Uint8ClampedArray, width: number, height: number, effects: readonly LayerEffect[], localTimeSec: number, bounds: EffectBounds): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || input.length !== width * height * 4) throw new Error('效果像素尺寸无效');
  const active = activeLayerEffects(effects); let result = new Uint8ClampedArray(input);
  if (!active.length) return result;
  let target = new Uint8ClampedArray(input.length);
  for (const effect of active) { renderEffectPixels(result, target, width, height, effect, localTimeSec, bounds); [result, target] = [target, result]; }
  return result;
}

const VERTEX_SHADER = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
// One program keeps pipeline changes cheap. All source sampling checks transparent
// boundaries explicitly; CLAMP_TO_EDGE is used only inside the source rectangle.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 uv;
uniform sampler2D image;
uniform vec2 size;
uniform vec4 bounds;
uniform vec2 rotation;
uniform int kind;
uniform float strength;
uniform float seed;
uniform float frame;
uniform float phase;
uniform vec4 p0;
uniform vec4 p1;
float noise(vec2 p,float s,float tick){float h=mod(floor(p.x)*127.+floor(p.y)*311.+mod(s,4093.)*17.+mod(tick,4093.)*131.,4093.);h=mod(h*h,4093.);return mod(h*251.+37.,4093.)/4093.;}
vec2 toUV(vec2 p){return vec2(p.x/size.x,1.-p.y/size.y);}
vec4 readAt(vec2 t){vec4 c=texture2D(image,t);return c.a>0.?vec4(c.rgb/c.a,c.a):vec4(0.);}
vec4 sampleAt(vec2 p){vec2 t=toUV(p);if(t.x<0.||t.y<0.||t.x>=1.||t.y<=0.)return vec4(0.);return readAt(t);}
vec2 rotate(vec2 p){return vec2(p.x*rotation.x-p.y*rotation.y,p.x*rotation.y+p.y*rotation.x);}
vec4 splitAt(vec2 p,vec2 shift){vec4 r=sampleAt(p-shift);vec4 g=sampleAt(p);vec4 b=sampleAt(p+shift);float a=max(r.a,max(g.a,b.a));return a>0.?vec4(vec3(r.r*r.a,g.g*g.a,b.b*b.a)/a,a):vec4(0.);}
void main(){
  vec2 pixel=vec2(uv.x*size.x,(1.-uv.y)*size.y);
  vec4 original=readAt(uv);vec4 result=original;
  vec2 d=pixel-bounds.xy;vec2 local=vec2(d.x*rotation.x+d.y*rotation.y,-d.x*rotation.y+d.y*rotation.x);
  vec2 halfSize=max(bounds.zw*.5,vec2(.5));vec2 n=local/halfSize;
  if(kind==0){
    vec3 color=(original.rgb*exp2(p0.x)+p0.y-.5)*p0.z+.5;
    color+=vec3(p1.x*.15+p1.y*.05,-p1.y*.1,-p1.x*.15+p1.y*.05);
    float luma=dot(color,vec3(.2126,.7152,.0722));
    float lift=p1.z*.25*smoothstep(.35,1.,luma)+p1.w*.25*(1.-smoothstep(0.,.65,luma));
    color+=lift;luma+=lift;result.rgb=clamp(vec3(luma)+(color-luma)*p0.w,0.,1.);
  }else if(kind==1){
    float grain=(noise(floor((local+halfSize)/p0.y),seed,frame)*2.-1.)*p0.x*.2;
    float vignette=1.-p0.w*.8*smoothstep(.25,1.35,length(n));
    float flicker=(noise(vec2(0.),seed+17.,frame)*2.-1.)*p1.x;
    float scratch=noise(vec2(floor((local.x+halfSize.x)/2.),0.),seed+29.,floor(frame/4.))>1.-p1.y*.03?.35*p1.y:0.;
    result.rgb=clamp(((original.rgb*(1.-p0.z)+p0.z*.5+grain)*(1.+flicker)+scratch)*vignette,0.,1.);
  }else if(kind==2){
    float distance=p0.x*(1.+p0.z*sin(phase));float angle=p0.y;
    result=splitAt(pixel,rotate(vec2(cos(angle),sin(angle))*distance));
  }else if(kind==3){
    float band=floor((local.y+halfSize.y)/p0.y);float trigger=noise(vec2(band,0.),seed,frame);
    float displacement=trigger<p0.x*.65?(noise(vec2(band,1.),seed,frame)*2.-1.)*p0.x*min(bounds.z,600.)*.2:0.;
    float shift=trigger<p0.x*.65?p0.z*p0.x:0.;
    result=splitAt(pixel-rotate(vec2(displacement,0.)),rotate(vec2(shift,0.)));
  }else if(kind==4){
    vec2 warped=local*(1.+p0.w*n.yx*n.yx);result=sampleAt(bounds.xy+rotate(warped));
    float scan=1.-p0.x*.55*(.5+.5*cos((local.y+halfSize.y)/p0.y*6.28318530718));
    float vignette=1.-p0.z*.8*smoothstep(.25,1.35,length(n));
    float flicker=(noise(vec2(0.),seed+17.,frame)*2.-1.)*p1.x;
    result.rgb=clamp(result.rgb*scan*vignette*(1.+flicker),0.,1.);
  }
  float a=mix(original.a,result.a,strength);
  vec3 premultiplied=mix(original.rgb*original.a,result.rgb*result.a,strength);
  gl_FragColor=vec4(premultiplied,a);
}`;

interface GpuState {
  canvas: EffectCanvas; gl: WebGLRenderingContext; program: WebGLProgram;
  textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[]; buffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>; width: number; height: number; unusable: boolean;
}
let gpu: GpuState | null | undefined;
interface CpuState { canvas: EffectCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; a: Uint8ClampedArray; b: Uint8ClampedArray }
let cpu: CpuState | null = null;
let lastBackend: 'webgl' | 'cpu' | 'none' = 'none';

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type); if (!shader) throw new Error('Cannot allocate effect shader');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(message || 'Cannot compile effect shader'); }
  return shader;
}
function createGpu(): GpuState | null {
  const canvas = createCanvas(1, 1); if (!canvas) return null;
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
  if (!gl) return null;
  let vertex: WebGLShader | null = null; let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null; let buffer: WebGLBuffer | null = null;
  const textures: WebGLTexture[] = []; const framebuffers: WebGLFramebuffer[] = [];
  try {
    vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER); fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram(); if (!program) throw new Error('Cannot allocate effect program');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Cannot link effect program');
    buffer = gl.createBuffer(); if (!buffer) throw new Error('Cannot allocate effect buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (let i = 0; i < 3; i++) {
      const texture = gl.createTexture(); if (!texture) throw new Error('Cannot allocate effect texture'); textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (i > 0) { const framebuffer = gl.createFramebuffer(); if (!framebuffer) throw new Error('Cannot allocate effect framebuffer'); framebuffers.push(framebuffer); }
    }
    const uniforms: GpuState['uniforms'] = {};
    for (const name of ['image', 'size', 'bounds', 'rotation', 'kind', 'strength', 'seed', 'frame', 'phase', 'p0', 'p1']) uniforms[name] = gl.getUniformLocation(program, name);
    const state: GpuState = { canvas, gl, program, buffer, textures, framebuffers, uniforms, width: 0, height: 0, unusable: false };
    // Context restoration invalidates every program, buffer, texture and FBO.
    // Keep this pooled state retired after the first loss, even if the browser
    // restores its context; a cache reset can safely allocate a fresh pipeline.
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); state.unusable = true; });
    canvas.addEventListener('webglcontextrestored', () => { state.unusable = true; });
    return state;
  } catch {
    for (const texture of textures) gl.deleteTexture(texture); for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
    if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); return null;
  } finally { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
}

function drawGpu(state: GpuState, source: CanvasImageSource, width: number, height: number, effects: readonly LayerEffect[], localTimeSec: number, bounds: EffectBounds): CanvasImageSource | null {
  const { gl, uniforms: u } = state;
  if (state.unusable) return null;
  // isContextLost can become true before the loss event is delivered.
  if (gl.isContextLost()) { state.unusable = true; return null; }
  if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
  if (state.width !== width || state.height !== height) {
    state.canvas.width = width; state.canvas.height = height; state.width = width; state.height = height;
    for (let i = 1; i < state.textures.length; i++) {
      gl.bindTexture(gl.TEXTURE_2D, state.textures[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffers[i - 1]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.textures[i], 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    }
  }
  gl.useProgram(state.program); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, width, height);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer); const position = gl.getAttribLocation(state.program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.textures[0]);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
  gl.uniform1i(u.image, 0); gl.uniform2f(u.size, width, height); gl.uniform4f(u.bounds, bounds.x, bounds.y, bounds.width, bounds.height);
  const angle = bounds.rotation * Math.PI / 180; gl.uniform2f(u.rotation, Math.cos(angle), Math.sin(angle));
  let input = state.textures[0];
  effects.forEach((effect, index) => {
    const p = effect.params; const n = (key: string) => Number(p[key]); const seed = n('seed') || 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, index === effects.length - 1 ? null : state.framebuffers[index % 2]);
    gl.bindTexture(gl.TEXTURE_2D, input); gl.uniform1f(u.strength, effect.strength); gl.uniform1f(u.seed, seed);
    gl.uniform1f(u.frame, effectAnimationFrame(localTimeSec, n('speed') || 0, effect.type === 'glitch' ? n('frequency') : 24));
    gl.uniform1f(u.phase, mod(Math.max(0, localTimeSec) * (n('speed') || 0) * TAU + mod(seed, 6283) / 1000, TAU));
    switch (effect.type) {
      case 'color': gl.uniform1i(u.kind, 0); gl.uniform4f(u.p0, n('exposure'), n('brightness'), n('contrast'), n('saturation')); gl.uniform4f(u.p1, n('temperature'), n('tint'), n('highlights'), n('shadows')); break;
      case 'film': gl.uniform1i(u.kind, 1); gl.uniform4f(u.p0, n('grain'), n('grainSize'), n('faded'), n('vignette')); gl.uniform4f(u.p1, n('flicker'), n('scratches'), 0, 0); break;
      case 'rgb-split': gl.uniform1i(u.kind, 2); gl.uniform4f(u.p0, n('offset'), n('angle') * Math.PI / 180, n('animated'), 0); gl.uniform4f(u.p1, 0, 0, 0, 0); break;
      case 'glitch': gl.uniform1i(u.kind, 3); gl.uniform4f(u.p0, n('amount'), n('blockSize'), n('colorShift'), 0); gl.uniform4f(u.p1, 0, 0, 0, 0); break;
      case 'crt': gl.uniform1i(u.kind, 4); gl.uniform4f(u.p0, n('scanlines'), n('lineSpacing'), n('vignette'), n('curvature')); gl.uniform4f(u.p1, n('flicker'), 0, 0, 0); break;
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); if (index < effects.length - 1) input = state.textures[1 + index % 2];
  });
  return state.canvas;
}

function drawCpu(source: CanvasImageSource, width: number, height: number, effects: readonly LayerEffect[], localTimeSec: number, bounds: EffectBounds): CanvasImageSource | null {
  if (!cpu) {
    const canvas = createCanvas(width, height); if (!canvas) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null; cpu = { canvas, ctx, a: new Uint8ClampedArray(0), b: new Uint8ClampedArray(0) };
  }
  const { canvas, ctx } = cpu;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, width, height); ctx.drawImage(source, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  if (cpu.a.length !== pixels.data.length) { cpu.a = new Uint8ClampedArray(pixels.data.length); cpu.b = new Uint8ClampedArray(pixels.data.length); }
  cpu.a.set(pixels.data); let input = cpu.a; let output = cpu.b;
  for (const effect of effects) { renderEffectPixels(input, output, width, height, effect, localTimeSec, bounds); [input, output] = [output, input]; }
  pixels.data.set(input); ctx.putImageData(pixels, 0, 0); return canvas;
}

/** Apply only to an isolated layer. Returned pooled surface is consumed immediately. */
export function applyLayerEffects(source: CanvasImageSource, width: number, height: number, effects: readonly LayerEffect[] | undefined, localTimeSec: number, bounds: EffectBounds, options: { forceCpu?: boolean } = {}): CanvasImageSource {
  // Timeline/compositing effects are dispatched by scene.ts. Never let a new
  // effect reuse the preceding shader's kind/uniforms or silently touch pixels.
  const active = activeLayerEffects(effects).filter(effect => ['color', 'film', 'rgb-split', 'glitch', 'crt'].includes(effect.type));
  if (!active.length || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return source;
  if (!options.forceCpu && gpu === undefined) gpu = createGpu();
  if (!options.forceCpu && gpu) { try { const result = drawGpu(gpu, source, width, height, active, localTimeSec, bounds); if (result) { lastBackend = 'webgl'; return result; } } catch { /* Tainted media or GPU loss can still use a CPU canvas. */ } }
  try { const result = drawCpu(source, width, height, active, localTimeSec, bounds); if (result) { lastBackend = 'cpu'; return result; } } catch { /* Restricted/tainted media cannot be read. Keep the original layer. */ }
  lastBackend = 'none'; return source;
}

export function clearEffectRendererCache(): void {
  if (gpu) {
    const { gl } = gpu; for (const texture of gpu.textures) gl.deleteTexture(texture); for (const framebuffer of gpu.framebuffers) gl.deleteFramebuffer(framebuffer);
    gl.deleteBuffer(gpu.buffer); gl.deleteProgram(gpu.program); gpu.canvas.width = 1; gpu.canvas.height = 1;
    // Explicitly release the context when a project is closed, rather than leaking
    // one context per reload until the browser forcibly evicts older canvases.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  if (cpu) { cpu.canvas.width = 1; cpu.canvas.height = 1; } gpu = undefined; cpu = null; lastBackend = 'none';
}

export function effectRendererBackend(): 'webgl' | 'cpu' | 'unavailable' { return lastBackend === 'none' ? 'unavailable' : lastBackend; }
export function effectRendererStats(): { backend: 'webgl' | 'cpu' | 'none'; width: number; height: number; textures: number; framebuffers: number; cpuBytes: number } {
  return { backend: lastBackend, width: lastBackend === 'cpu' ? cpu?.canvas.width ?? 0 : gpu?.width ?? 0, height: lastBackend === 'cpu' ? cpu?.canvas.height ?? 0 : gpu?.height ?? 0, textures: gpu?.textures.length ?? 0, framebuffers: gpu?.framebuffers.length ?? 0, cpuBytes: (cpu?.a.byteLength ?? 0) + (cpu?.b.byteLength ?? 0) };
}
