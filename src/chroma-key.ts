import type { LayerParams } from './types';

export interface ChromaKeySettings {
  enabled: boolean; color: string; tolerance: number; softness: number; spill: number;
}

export const CHROMA_KEY_DEFAULTS: ChromaKeySettings = {
  enabled: false, color: '#00ff00', tolerance: .18, softness: .10, spill: .5,
};

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
function numeric(params: LayerParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : fallback;
}

export function resolveChromaKeySettings(params: LayerParams): ChromaKeySettings {
  return {
    enabled: params.chromaEnabled === true,
    color: typeof params.chromaColor === 'string' && /^#[\da-f]{6}$/i.test(params.chromaColor) ? params.chromaColor.toLowerCase() : CHROMA_KEY_DEFAULTS.color,
    tolerance: numeric(params, 'chromaTolerance', CHROMA_KEY_DEFAULTS.tolerance),
    softness: numeric(params, 'chromaSoftness', CHROMA_KEY_DEFAULTS.softness),
    spill: numeric(params, 'chromaSpill', CHROMA_KEY_DEFAULTS.spill),
  };
}

export function chromaKeySettingsKey(params: LayerParams): string {
  const settings = resolveChromaKeySettings(params);
  return settings.enabled ? `${settings.color}:${settings.tolerance}:${settings.softness}:${settings.spill}` : 'off';
}

function smoothstep(low: number, high: number, value: number): number {
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

function colorValues(color: string): [number, number, number] {
  return [Number.parseInt(color.slice(1, 3), 16) / 255, Number.parseInt(color.slice(3, 5), 16) / 255, Number.parseInt(color.slice(5, 7), 16) / 255];
}

function chroma(r: number, g: number, b: number): [number, number] {
  return [-.168736 * r - .331264 * g + .5 * b, .5 * r - .418688 * g - .081312 * b];
}

/**
 * CPU fallback and reference for the GPU shader below. RGB is straight alpha.
 * Chroma distance removes a screen without confusing a dark screen with black
 * foreground. Neutral keys compare full RGB; chromatic keys protect neutrals
 * and opposing hues. Spill correction subtracts only the screen direction.
 */
export function keyChromaPixels(pixels: Uint8ClampedArray, params: LayerParams): Uint8ClampedArray {
  const settings = resolveChromaKeySettings(params);
  if (!settings.enabled) return pixels;
  const [kr, kg, kb] = colorValues(settings.color);
  const [kcb, kcr] = chroma(kr, kg, kb);
  const keyLength = Math.hypot(kcb, kcr);
  const keyChromatic = smoothstep(.025, .10, keyLength);
  const unitCb = kcb / Math.max(keyLength, .000001);
  const unitCr = kcr / Math.max(keyLength, .000001);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i] / 255; const g = pixels[i + 1] / 255; const b = pixels[i + 2] / 255;
    const y = .299 * r + .587 * g + .114 * b;
    const [cb, cr] = chroma(r, g, b);
    const length = Math.hypot(cb, cr);
    const colorDistance = Math.hypot(cb - kcb, cr - kcr) / Math.max(.25, keyLength);
    // Equal luminance does not imply equal color. Comparing full RGB for a
    // neutral key keeps saturated foreground with the same brightness intact.
    const neutralDistance = Math.hypot(r - kr, g - kg, b - kb) * .5773502691896258;
    const distance = neutralDistance * (1 - keyChromatic) + colorDistance * keyChromatic;
    const hue = (cb * kcb + cr * kcr) / Math.max(.000001, length * keyLength);
    const hueGate = smoothstep(.15, .75, hue);
    const chromaticGate = smoothstep(.015, .075, length) * hueGate;
    const remove = (1 - smoothstep(settings.tolerance, settings.tolerance + Math.max(.0001, settings.softness), distance)) * (1 - keyChromatic + chromaticGate * keyChromatic);
    const matte = 1 - remove;
    const projection = Math.max(0, cb * unitCb + cr * unitCr);
    const spill = projection * settings.spill * keyChromatic * hueGate * (.25 + .75 * remove);
    const outCb = cb - unitCb * spill; const outCr = cr - unitCr * spill;
    pixels[i] = clamp(y + 1.402 * outCr) * 255;
    pixels[i + 1] = clamp(y - .344136 * outCb - .714136 * outCr) * 255;
    pixels[i + 2] = clamp(y + 1.772 * outCb) * 255;
    pixels[i + 3] *= matte;
  }
  return pixels;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() { vUv = (aPosition + 1.0) * .5; gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec3 uKey;
uniform float uTolerance;
uniform float uSoftness;
uniform float uSpill;
vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-.168736, -.331264, .5)), dot(c, vec3(.5, -.418688, -.081312))); }
void main() {
  vec4 pixel = texture2D(uFrame, vUv);
  float y = dot(pixel.rgb, vec3(.299, .587, .114));
  vec2 c = chroma(pixel.rgb);
  vec2 k = chroma(uKey);
  float keyLength = length(k);
  float keyChromatic = smoothstep(.025, .10, keyLength);
  float colorDistance = length(c - k) / max(.25, keyLength);
  float neutralDistance = length(pixel.rgb - uKey) * .5773502691896258;
  float distance = mix(neutralDistance, colorDistance, keyChromatic);
  float hue = dot(c, k) / max(.000001, length(c) * keyLength);
  float hueGate = smoothstep(.15, .75, hue);
  float chromaticGate = smoothstep(.015, .075, length(c)) * hueGate;
  float removal = (1.0 - smoothstep(uTolerance, uTolerance + max(.0001, uSoftness), distance)) * mix(1.0, chromaticGate, keyChromatic);
  vec2 keyUnit = k / max(keyLength, .000001);
  float spill = max(0.0, dot(c, keyUnit)) * uSpill * keyChromatic * hueGate * (.25 + .75 * removal);
  vec2 outC = c - keyUnit * spill;
  vec3 rgb = clamp(vec3(y + 1.402 * outC.y, y - .344136 * outC.x - .714136 * outC.y, y + 1.772 * outC.x), 0.0, 1.0);
  gl_FragColor = vec4(rgb, pixel.a * (1.0 - removal));
}
`;

type Surface = HTMLCanvasElement | OffscreenCanvas;
function surface(): Surface {
  if (typeof document !== 'undefined') return document.createElement('canvas');
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  throw new Error('当前环境无法创建视频抠像画布');
}

interface GpuState {
  canvas: Surface; gl: WebGLRenderingContext; program: WebGLProgram; texture: WebGLTexture; buffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/** One processor per clip keeps the published output stable between prepares. */
export class ChromaKeyProcessor {
  private gpu: GpuState | null = null;
  private fallback: Surface | null = null;
  private attemptedGpu = false;
  private disposed = false;

  constructor(options: { preferGpu?: boolean } = {}) {
    this.attemptedGpu = options.preferGpu === false;
  }

  private initializeGpu(): GpuState | null {
    const canvas = surface();
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, depth: false, stencil: false }) as WebGLRenderingContext | null;
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null; let texture: WebGLTexture | null = null; let buffer: WebGLBuffer | null = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('无法创建色键着色器');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '色键着色器编译失败');
      }
      program = gl.createProgram(); texture = gl.createTexture(); buffer = gl.createBuffer();
      if (!program || !texture || !buffer) throw new Error('无法创建色键渲染资源');
      shaders.forEach(shader => gl.attachShader(program!, shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '色键渲染初始化失败');
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'aPosition'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const uniforms = Object.fromEntries(['uFrame', 'uKey', 'uTolerance', 'uSoftness', 'uSpill'].map(name => [name, gl.getUniformLocation(program!, name)]));
      gl.uniform1i(uniforms.uFrame, 0);
      return { canvas, gl, program, texture, buffer, uniforms };
    } catch {
      if (program) gl.deleteProgram(program); if (texture) gl.deleteTexture(texture); if (buffer) gl.deleteBuffer(buffer);
      return null;
    } finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  }

  process(source: CanvasImageSource, width: number, height: number, params: LayerParams): CanvasImageSource {
    if (this.disposed) throw new Error('视频抠像处理器已释放');
    const settings = resolveChromaKeySettings(params);
    if (!settings.enabled) return source;
    width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
    if (!this.attemptedGpu) { this.attemptedGpu = true; this.gpu = this.initializeGpu(); }
    const gpu = this.gpu;
    if (gpu && !gpu.gl.isContextLost()) {
      const { canvas, gl, uniforms } = gpu;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height); gl.useProgram(gpu.program); gl.bindTexture(gl.TEXTURE_2D, gpu.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
      gl.uniform3fv(uniforms.uKey, colorValues(settings.color));
      gl.uniform1f(uniforms.uTolerance, settings.tolerance); gl.uniform1f(uniforms.uSoftness, settings.softness); gl.uniform1f(uniforms.uSpill, settings.spill);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    }
    if (!this.fallback) this.fallback = surface();
    const canvas = this.fallback;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('当前环境无法处理视频抠像');
    ctx.clearRect(0, 0, width, height); ctx.drawImage(source, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height); keyChromaPixels(frame.data, params); ctx.putImageData(frame, 0, 0);
    return canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gpu) {
      const { gl, program, texture, buffer } = this.gpu;
      gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program);
    }
    // Existing preview resource maps may still draw the final published canvas
    // during a source replacement. Retain its pixels; GC releases the surface.
    this.gpu = null; this.fallback = null;
  }
}
