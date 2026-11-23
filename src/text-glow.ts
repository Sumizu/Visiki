import type { LayerParams } from './types';

export interface TextGlowStyle {
  enabled: boolean;
  color: string;
  intensity: number;
  radius: number;
}

const bounded = (value: unknown, fallback: number, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : fallback;

export function resolveTextGlow(params: LayerParams): TextGlowStyle {
  return {
    enabled: params.glowEnabled === true,
    color: typeof params.glowColor === 'string' && /^#[\da-f]{6}$/i.test(params.glowColor) ? params.glowColor : '#ffffff',
    intensity: bounded(params.glowIntensity, 1, 2),
    radius: bounded(params.glowRadius, 18, 80),
  };
}

/** Paint only the halo, before the caller paints its usual sharp text. The
 * original glyph is moved wholly outside the canvas in device coordinates;
 * its shadow is moved back by the exact same distance. Keeping the same
 * context preserves the active font-synthesis policy, font, alignment and
 * baseline. Canvas clips still apply to the resulting halo as usual.
 *
 * No canvas allocations or glyph caches are retained. Existing alpha (layer,
 * lyric state and fade transitions) affects the halo without being reset. */
export function paintTextGlow(ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  style: TextGlowStyle, strokeWidth = 0, maxWidth?: number): void {
  if (!style.enabled || style.intensity <= 0 || style.radius <= 0 || !text || ctx.globalAlpha <= 0) return;
  if (maxWidth !== undefined && (!Number.isFinite(maxWidth) || maxWidth <= 0)) return;
  const matrix = ctx.getTransform();
  const scale = Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d) / Math.SQRT2;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const radius = style.radius * scale;
  const outline = Number.isFinite(strokeWidth) ? Math.max(0, strokeWidth) : 0;
  const metrics = ctx.measureText(text);
  const fontSize = Number(/([\d.]+)px\b/.exec(ctx.font)?.[1]) || 16;
  const width = Number.isFinite(metrics.width) ? metrics.width : fontSize * text.length;
  const alignment = ctx.textAlign === 'center' ? .5 : ctx.textAlign === 'right' ||
    (ctx.textAlign === 'end' && ctx.direction !== 'rtl') || (ctx.textAlign === 'start' && ctx.direction === 'rtl') ? 1 : 0;
  const left = x - (Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : width * alignment);
  const right = x + (Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : width * (1 - alignment));
  const top = y - (Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize * 2);
  const bottom = y + (Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize * 2);
  const rightmost = Math.max(...[left, right].flatMap(px => [top, bottom].map(py => matrix.a * px + matrix.c * py + matrix.e)));
  // The margin includes stroke joins and the complete blur kernel. Source
  // pixels stay offscreen even for centered/RTL text and rotated contexts.
  const displacement = Math.max(0, rightmost) + radius * 4 + outline * scale * 4 + 32;
  if (!Number.isFinite(displacement)) return;
  const alpha = ctx.globalAlpha;
  ctx.save();
  try {
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - displacement, matrix.f);
    ctx.filter = 'none';
    ctx.shadowOffsetX = displacement; ctx.shadowOffsetY = 0;
    ctx.shadowColor = style.color; ctx.shadowBlur = radius;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = outline;
    const paint = (): void => {
      if (maxWidth === undefined) ctx.fillText(text, x, y);
      else ctx.fillText(text, x, y, maxWidth);
      if (outline > 0) {
        if (maxWidth === undefined) ctx.strokeText(text, x, y);
        else ctx.strokeText(text, x, y, maxWidth);
      }
    };
    // Canvas alpha is capped at one. A second halo pass gives the upper half
    // of the strength control a real effect without painting another body.
    for (let pass = 0; pass < Math.min(2, Math.ceil(style.intensity)); pass++) {
      ctx.globalAlpha = alpha * Math.min(1, style.intensity - pass);
      paint();
    }
  } finally { ctx.restore(); }
}
