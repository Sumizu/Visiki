import type { LayerParams } from './types';

export interface TextTypography {
  weight: number;
  italic: boolean;
  synthesizeWeight: boolean;
}

export function fontWeight(value: unknown, fallback = 400): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(100, Math.min(900, value)) : fallback;
}

/** Missing new controls retain the old unsynthesized face. Text boxes already
 * saved a 400/600 weight, so their first weight edit has a separate opt-in. */
export function resolveTextTypography(params: LayerParams, weightKey = 'fontWeight', italicKey = 'italic', fallback = 400,
  synthesisKey?: string): TextTypography {
  return {
    weight: fontWeight(params[weightKey], fallback),
    italic: params[italicKey] === true,
    synthesizeWeight: synthesisKey ? params[synthesisKey] === true : typeof params[weightKey] === 'number',
  };
}

export function canvasFont(size: number, family: string, typography: TextTypography): string {
  return `${typography.italic ? 'italic ' : ''}${typography.weight} ${size}px ${family}`;
}

/** Canvas inherits font-synthesis from its DOM element. Both preview and export
 * deliberately default to none; enable only the controls edited by the user,
 * then restore the exact inline declaration so later lines/layers stay legacy.
 * Style flush + a different font assignment make Chromium re-resolve an equal
 * font string after policy changes (important for a paused preview). */
export function withCanvasFontSynthesis<T>(ctx: CanvasRenderingContext2D, typography: TextTypography, paint: () => T): T {
  const canvas = ctx.canvas;
  const style = 'style' in canvas ? (canvas as HTMLCanvasElement).style : undefined;
  if (!style?.setProperty) return paint();
  const original = style.getPropertyValue('font-synthesis');
  const priority = style.getPropertyPriority('font-synthesis');
  const policy = [typography.synthesizeWeight ? 'weight' : '', typography.italic ? 'style' : ''].filter(Boolean).join(' ') || 'none';
  const previousFont = ctx.font;
  const flush = (): void => {
    if (typeof getComputedStyle === 'function') void getComputedStyle(canvas as HTMLCanvasElement).fontSynthesis;
  };
  try {
    style.setProperty('font-synthesis', policy);
    flush();
    ctx.font = '10px serif';
    return paint();
  } finally {
    if (original) style.setProperty('font-synthesis', original, priority);
    else style.removeProperty('font-synthesis');
    flush();
    // Resolve the restored state as well, rather than leaving a synthesized
    // font object active for a subsequent component that uses the same string.
    ctx.font = '10px serif';
    ctx.font = previousFont;
  }
}
