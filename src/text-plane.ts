/** A perspective rotation about the vertical axis of a complete text layer.
 * The renderer works in layer-local project pixels, before the usual layer
 * rotation and output-size transform. Positive yaw puts the right edge farther
 * from the camera. It does not shear individual glyphs or alter their fonts. */
export interface TextPlaneParams { planeYaw?: unknown; planePerspective?: unknown }

/** Lens distance is relative to the unpadded visible line width. Effects and
 * other lyric lines never change the camera of this line. */
export interface TextPlaneCamera { referenceWidth?: number }

export interface TextPlaneProjection {
  yaw: number;
  perspective: number;
  cosine: number;
  depth: number;
  width: number;
  height: number;
  padding: number;
  referenceWidth: number;
  slope: number;
  sourceLeft: number;
  sourceRight: number;
  sourceTop: number;
  sourceBottom: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const MAX_SIDE = 4096;
const MAX_PIXELS = 4 * 1024 * 1024;
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Off-axis ray/plane projection. Rotate the text around Y, then project from
 * C=(0,-f*tan(15deg),-f) onto z=0. The view direction stays fixed as f changes:
 * X = x*cos(yaw)/(1+x*sin(yaw)/f)
 * Y = (y-x*sin(yaw)*tan(15deg))/(1+x*sin(yaw)/f).
 *
 * P only controls f: width*(100+P)/(2*P). This bounded inverse-distance mapping
 * gives useful depth at the default strength, without a near-plane singularity
 * at 300%. P=0 is its oblique parallel-projection limit. No post-projection
 * framing scale or strength-dependent axis slope is applied. */
export function resolveTextPlane(width: number, height: number, params: TextPlaneParams, padding = 0,
  camera: TextPlaneCamera = {}): TextPlaneProjection {
  const yaw = clamp(finite(params.planeYaw, 0), -75, 75);
  const perspective = clamp(finite(params.planePerspective, 50), 0, 300);
  const margin = clamp(finite(padding, 0), 0, 512);
  const bodyWidth = Math.max(1, finite(width, 1));
  const bodyHeight = Math.max(1, finite(height, 1));
  const referenceWidth = Math.max(bodyWidth, finite(camera.referenceWidth, bodyWidth));
  const radians = yaw * Math.PI / 180;
  const cosine = Math.cos(radians);
  const slope = -Math.tan(Math.PI / 12) * Math.tan(radians);
  const depth = 2 * Math.sin(radians) * perspective / (100 + perspective) / referenceWidth;
  const sourceLeft = depth > 0 ? Math.max(-bodyWidth / 2 - margin, -.9 / depth) : -bodyWidth / 2 - margin;
  const sourceRight = depth < 0 ? Math.min(bodyWidth / 2 + margin, -.9 / depth) : bodyWidth / 2 + margin;
  const sourceTop = -bodyHeight / 2 - margin;
  const sourceBottom = bodyHeight / 2 + margin;
  const projectY = (x: number, y: number): number => (y + slope * cosine * x) / (1 + depth * x);
  const cornersY = [projectY(sourceLeft, sourceTop), projectY(sourceLeft, sourceBottom),
    projectY(sourceRight, sourceTop), projectY(sourceRight, sourceBottom)];
  const left = cosine * sourceLeft / (1 + depth * sourceLeft);
  const right = cosine * sourceRight / (1 + depth * sourceRight);
  return { yaw, perspective, cosine, depth, width: sourceRight - sourceLeft, height: sourceBottom - sourceTop, padding: margin,
    referenceWidth, slope, sourceLeft, sourceRight, sourceTop, sourceBottom,
    left, right, top: Math.min(...cornersY), bottom: Math.max(...cornersY) };
}

export function projectTextPlanePoint(x: number, y: number, projection: TextPlaneProjection): { x: number; y: number; scale: number } {
  const scale = 1 / (1 + projection.depth * x);
  const projectedX = projection.cosine * x * scale;
  return { x: projectedX, y: y * scale + projection.slope * projectedX, scale };
}

type Surface = HTMLCanvasElement | OffscreenCanvas;
interface PlaneSurfaces { source: Surface; sourceContext: CanvasRenderingContext2D; output: Surface; outputContext: CanvasRenderingContext2D }
// A previous export canvas is not kept alive by this cache. There are no
// per-layer surfaces: the two scratch buffers are reused for successive layers.
const surfaces = new WeakMap<CanvasRenderingContext2D, PlaneSurfaces>();

function createSurface(target: CanvasRenderingContext2D): Surface | null {
  const owner = 'ownerDocument' in target.canvas ? target.canvas.ownerDocument : typeof document !== 'undefined' ? document : undefined;
  if (owner) {
    const canvas = owner.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.textPlaneSurface = 'true';
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;font-synthesis:none';
    return canvas;
  }
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null;
}

function getSurfaces(ctx: CanvasRenderingContext2D): PlaneSurfaces | null {
  const cached = surfaces.get(ctx);
  if (cached) return cached;
  const source = createSurface(ctx); const output = createSurface(ctx);
  if (!source || !output) return null;
  const sourceContext = source.getContext('2d') as CanvasRenderingContext2D | null;
  const outputContext = output.getContext('2d') as CanvasRenderingContext2D | null;
  if (!sourceContext || !outputContext) return null;
  const result = { source, sourceContext, output, outputContext };
  surfaces.set(ctx, result); return result;
}

function resize(canvas: Surface, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function copyDrawingStyle(source: CanvasRenderingContext2D, target: CanvasRenderingContext2D): void {
  // Layer opacity/compositing are deliberately excluded and applied only once,
  // when the final image is put onto the destination. Local text alpha remains
  // part of the source, including inactive lines and lyric transitions.
  target.fillStyle = source.fillStyle; target.strokeStyle = source.strokeStyle;
  target.font = source.font; target.textAlign = source.textAlign; target.textBaseline = source.textBaseline;
  target.direction = source.direction; target.fontKerning = source.fontKerning;
  target.fontStretch = source.fontStretch; target.fontVariantCaps = source.fontVariantCaps;
  target.textRendering = source.textRendering; target.letterSpacing = source.letterSpacing; target.wordSpacing = source.wordSpacing;
  target.lineWidth = source.lineWidth; target.lineCap = source.lineCap; target.lineJoin = source.lineJoin; target.miterLimit = source.miterLimit;
  target.setLineDash(source.getLineDash()); target.lineDashOffset = source.lineDashOffset;
  target.shadowBlur = source.shadowBlur; target.shadowColor = source.shadowColor;
  target.shadowOffsetX = source.shadowOffsetX; target.shadowOffsetY = source.shadowOffsetY;
  target.filter = source.filter;
}

/** Paint one complete layer onto a common Y-rotated plane. With zero yaw this
 * calls paint with the original context and touches no canvas state or pixels.
 *
 * The inverse homography is sampled in destination pixel columns. Every column
 * has exact integer boundaries on the scratch output, so adjoining translucent
 * glyphs never acquire alpha seams. Only the completed output is scaled to the
 * preview/export canvas; preview scaling and in-plane rotation cannot create
 * subpixel strip seams. There is no pixel readback or GPU-specific code path. */
export function withTextPlane(ctx: CanvasRenderingContext2D, width: number, height: number, params: TextPlaneParams,
  paint: (context: CanvasRenderingContext2D) => void, padding = 0, camera: TextPlaneCamera = {}): void {
  const projection = resolveTextPlane(width, height, params, padding, camera);
  if (projection.yaw === 0 || width <= 0 || height <= 0) { paint(ctx); return; }
  const buffers = getSurfaces(ctx);
  if (!buffers) { paint(ctx); return; }
  const { source, sourceContext, output, outputContext } = buffers;
  const projectedWidth = projection.right - projection.left;
  const projectedHeight = projection.bottom - projection.top;
  // Limit both raster buffers, including the enlarged near side at strong yaw.
  // Reserve raster pixels (rather than project pixels) for the guards and
  // rounding. At low density, four project pixels would be less than one pixel.
  const rasterBudget = MAX_PIXELS - MAX_SIDE * 8 - 16;
  const density = Math.min(1, (MAX_SIDE - 4) / projection.width, (MAX_SIDE - 4) / projection.height,
    (MAX_SIDE - 4) / projectedWidth, (MAX_SIDE - 4) / projectedHeight,
    Math.sqrt(rasterBudget / (projection.width * projection.height)),
    Math.sqrt(rasterBudget / (projectedWidth * projectedHeight)));
  const sourceWidth = Math.max(1, Math.ceil(projection.width * density));
  const sourceHeight = Math.max(1, Math.ceil(projection.height * density));
  // A one-pixel transparent guard accommodates ceil() on source dimensions and
  // the antialiasing at the projected trapezoid's outer edges.
  const left = Math.floor(projection.left * density) - 1;
  const right = Math.ceil(projection.right * density) + 1;
  const top = Math.floor(projection.top * density) - 1;
  const bottom = Math.ceil(projection.bottom * density) + 1;
  resize(source, sourceWidth, sourceHeight); resize(output, right - left, bottom - top);
  sourceContext.setTransform(1, 0, 0, 1, 0, 0); sourceContext.clearRect(0, 0, sourceWidth, sourceHeight);
  sourceContext.save();
  // As with the export canvas, mounting while painting gives font-synthesis a
  // real computed style. It is always removed, including if the painter throws.
  const htmlSource = 'ownerDocument' in source ? source : null;
  try {
    if (htmlSource) htmlSource.ownerDocument.body?.append(htmlSource);
    sourceContext.setTransform(density, 0, 0, density, -projection.sourceLeft * density, -projection.sourceTop * density);
    copyDrawingStyle(ctx, sourceContext);
    sourceContext.globalAlpha = 1; sourceContext.globalCompositeOperation = 'source-over';
    paint(sourceContext);
  } finally {
    sourceContext.restore(); htmlSource?.remove();
  }
  outputContext.setTransform(1, 0, 0, 1, 0, 0); outputContext.clearRect(0, 0, output.width, output.height);
  outputContext.imageSmoothingEnabled = true; outputContext.imageSmoothingQuality = 'high';
  const minX = projection.left * density; const maxX = projection.right * density;
  for (let column = 0; column < output.width; column++) {
    const x0 = Math.max(left + column, minX); const x1 = Math.min(left + column + 1, maxX);
    if (x1 <= x0) continue;
    const world0 = x0 / density; const world1 = x1 / density;
    const source0 = world0 / (projection.cosine - projection.depth * world0);
    const source1 = world1 / (projection.cosine - projection.depth * world1);
    // The inverse homography is linear vertically in each destination column.
    // Camera elevation contributes a fixed axis slope, independent of strength.
    const middle = (world0 + world1) / 2;
    const verticalScale = 1 - projection.depth * middle / projection.cosine;
    const translatedTop = projection.slope * middle + projection.sourceTop * verticalScale;
    outputContext.drawImage(source, (source0 - projection.sourceLeft) * density, 0, (source1 - source0) * density, sourceHeight,
      x0 - left, translatedTop * density - top, x1 - x0, sourceHeight * verticalScale);
  }
  ctx.save();
  try {
    // Source effects were already applied before projection; do not apply the
    // destination's inherited filter/shadow to the complete plane a second time.
    ctx.filter = 'none'; ctx.shadowColor = '#00000000'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.drawImage(output, left / density, top / density, output.width / density, output.height / density);
  } finally { ctx.restore(); }
}
