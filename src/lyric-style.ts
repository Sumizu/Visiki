import type { LayerParams, LyricCue } from './types';
import { resolveTextTypography } from './text-typography';

export const LYRIC_TRANSITIONS = ['none', 'fade', 'fade-up', 'fade-down', 'fade-zoom'] as const;
export type LyricTransition = typeof LYRIC_TRANSITIONS[number];

/** Project-pixel values. Old projects can omit every newly introduced key. */
export const LYRIC_STYLE_DEFAULTS = {
  fontSize: 43, translationSize: 36, color: '#ffffff', translationColor: '#e5e2f0',
  activeOpacity: 1, activeStrokeWidth: 0, activeStrokeColor: '#080810',
  activeShadowEnabled: true, activeShadowColor: '#07080d', activeShadowOpacity: 0.75,
  activeShadowBlur: 8, activeShadowX: 0, activeShadowY: 2,
  inactiveOpacity: 0.24, inactiveStrokeWidth: 0, inactiveStrokeColor: '#080810',
  inactiveShadowEnabled: true, inactiveShadowColor: '#07080d', inactiveShadowOpacity: 0.75,
  inactiveShadowBlur: 8, inactiveShadowX: 0, inactiveShadowY: 2,
  lineGap: 20, translationGap: 8, transition: 'none' as LyricTransition, transitionDuration: 0.35,
} as const;

export interface LyricTextStyle {
  fontSize: number; translationSize: number; color: string; translationColor: string;
  fontWeight: number; translationFontWeight: number; italic: boolean; translationItalic: boolean;
  fontWeightSynthesis: boolean; translationFontWeightSynthesis: boolean;
  opacity: number; strokeWidth: number; strokeColor: string;
  shadowEnabled: boolean; shadowColor: string; shadowOpacity: number; shadowBlur: number;
  shadowX: number; shadowY: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const numeric = (params: LayerParams, key: string, fallback: number, min: number, max: number): number => {
  const raw = params[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
};
const color = (params: LayerParams, key: string, fallback: string): string => typeof params[key] === 'string' && params[key] ? String(params[key]) : fallback;

/** Freeze legacy inherited values before a style edit, without changing its initial appearance. */
export function normalizeLyricStyles(params: LayerParams): LayerParams {
  return {
    ...params,
    inactiveFontSize: numeric(params, 'inactiveFontSize', numeric(params, 'fontSize', LYRIC_STYLE_DEFAULTS.fontSize, 8, 300), 8, 300),
    inactiveTranslationSize: numeric(params, 'inactiveTranslationSize', numeric(params, 'translationSize', LYRIC_STYLE_DEFAULTS.translationSize, 8, 300), 8, 300),
    inactiveColor: color(params, 'inactiveColor', color(params, 'color', LYRIC_STYLE_DEFAULTS.color)),
    inactiveTranslationColor: color(params, 'inactiveTranslationColor', color(params, 'translationColor', LYRIC_STYLE_DEFAULTS.translationColor)),
  };
}

/** Materialize missing state values from the old snapshot, then apply the user's edit. */
export function updateLyricStyles(params: LayerParams, patch: LayerParams): LayerParams {
  return { ...normalizeLyricStyles(params), ...patch };
}

/** Resolve the two states independently: no rendering state is shared or mutated. */
export function resolveLyricStyle(params: LayerParams, active: boolean): LyricTextStyle {
  const defaults = LYRIC_STYLE_DEFAULTS;
  const prefix = active ? 'active' : 'inactive';
  const fontSize = numeric(params, 'fontSize', defaults.fontSize, 8, 300);
  const translationSize = numeric(params, 'translationSize', defaults.translationSize, 8, 300);
  const originalColor = color(params, 'color', defaults.color);
  const translatedColor = color(params, 'translationColor', defaults.translationColor);
  const originalTypography = resolveTextTypography(params, `${prefix}FontWeight`, `${prefix}Italic`, active ? 600 : 400);
  const translationTypography = resolveTextTypography(params, `${prefix}TranslationFontWeight`, `${prefix}TranslationItalic`, active ? 500 : 400);
  return {
    fontWeight: originalTypography.weight, translationFontWeight: translationTypography.weight,
    italic: originalTypography.italic, translationItalic: translationTypography.italic,
    fontWeightSynthesis: originalTypography.synthesizeWeight, translationFontWeightSynthesis: translationTypography.synthesizeWeight,
    fontSize: active ? fontSize : numeric(params, 'inactiveFontSize', fontSize, 8, 300),
    translationSize: active ? translationSize : numeric(params, 'inactiveTranslationSize', translationSize, 8, 300),
    color: active ? originalColor : color(params, 'inactiveColor', originalColor),
    translationColor: active ? translatedColor : color(params, 'inactiveTranslationColor', translatedColor),
    opacity: numeric(params, `${prefix}Opacity`, active ? defaults.activeOpacity : defaults.inactiveOpacity, 0, 1),
    strokeWidth: numeric(params, `${prefix}StrokeWidth`, 0, 0, 30),
    strokeColor: color(params, `${prefix}StrokeColor`, defaults.activeStrokeColor),
    shadowEnabled: params[`${prefix}ShadowEnabled`] !== false,
    shadowColor: color(params, `${prefix}ShadowColor`, defaults.activeShadowColor),
    shadowOpacity: numeric(params, `${prefix}ShadowOpacity`, defaults.activeShadowOpacity, 0, 1),
    shadowBlur: numeric(params, `${prefix}ShadowBlur`, defaults.activeShadowBlur, 0, 100),
    shadowX: numeric(params, `${prefix}ShadowX`, defaults.activeShadowX, -100, 100),
    shadowY: numeric(params, `${prefix}ShadowY`, defaults.activeShadowY, -100, 100),
  };
}

/** Canvas shadow alpha is independent of text alpha, including alpha-bearing hex. */
export function colorWithOpacity(value: string, opacity: number): string {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (match) {
    const hex = match[1].length < 5 ? [...match[1]].map(char => char + char).join('') : match[1];
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${clamp(opacity, 0, 1) * alpha})`;
  }
  // Existing hand-edited projects may use rgb()/rgba() rather than the color picker.
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${clamp(opacity, 0, 1) * clamp(Number(rgb[4] ?? 1), 0, 1)})`;
  // CSS color-mix is not supported consistently by Canvas2D; saved color picker
  // values and all bundled defaults use the formats parsed above.
  return value;
}

export interface LyricLayoutOptions { originalOnly?: boolean; translationGap?: number }
export interface LyricBlockLayout {
  originalLines: string[]; translationLines: string[];
  originalLineHeight: number; translationLineHeight: number;
  translationTop: number; height: number;
}

/** Reserve each line's complete font box; translated multiline cues cannot overlap. */
export function resolveLyricLayout(cue: LyricCue, style: LyricTextStyle, options: LyricLayoutOptions = {}): LyricBlockLayout {
  const originalLines = cue.text.split(/\r?\n/).filter(line => line.trim());
  const translationLines = options.originalOnly ? [] : (cue.translation ?? '').split(/\r?\n/).filter(line => line.trim());
  const originalLineHeight = style.fontSize * 1.23;
  const translationLineHeight = style.translationSize * 1.23;
  const translationGap = Math.max(0, options.translationGap ?? LYRIC_STYLE_DEFAULTS.translationGap);
  const translationTop = originalLines.length * originalLineHeight + (originalLines.length && translationLines.length ? translationGap : 0);
  return { originalLines, translationLines, originalLineHeight, translationLineHeight, translationTop,
    height: translationTop + translationLines.length * translationLineHeight };
}

export interface PositionedLyricBlock extends LyricBlockLayout { index: number; top: number; style: LyricTextStyle }
export interface LyricBlocksOptions extends LyricLayoutOptions { visibleCount?: number; lineGap?: number }

/** Center the active cue; measure every neighbor using its own resolved style. */
export function layoutLyricBlocks(cues: LyricCue[], index: number, active: LyricTextStyle, inactive: LyricTextStyle, options: LyricBlocksOptions = {}): PositionedLyricBlock[] {
  if (index < 0 || index >= cues.length) return [];
  const count = clamp(Math.round(options.visibleCount ?? 3), 1, 7);
  const gap = Math.max(0, options.lineGap ?? LYRIC_STYLE_DEFAULTS.lineGap);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), cues.length - count));
  const end = Math.min(cues.length - 1, start + count - 1);
  const blocks: PositionedLyricBlock[] = [];
  for (let i = start; i <= end; i++) {
    const style = i === index ? active : inactive;
    blocks.push({ ...resolveLyricLayout(cues[i], style, options), index: i, top: 0, style });
  }
  const position = index - start;
  blocks[position].top = -blocks[position].height / 2;
  for (let i = position - 1; i >= 0; i--) blocks[i].top = blocks[i + 1].top - gap - blocks[i].height;
  for (let i = position + 1; i < blocks.length; i++) blocks[i].top = blocks[i - 1].top + blocks[i - 1].height + gap;
  return blocks;
}

export interface LyricTransitionState { alpha: number; offsetY: number; scale: number; start: number; end: number; duration: number }

/** Absolute lyric time only: scrub order and output frame rate cannot affect this. */
export function lyricTransitionAtTime(cues: LyricCue[], index: number, timeSec: number, projectEnd: number,
  mode: string = LYRIC_STYLE_DEFAULTS.transition, durationSec: number = LYRIC_STYLE_DEFAULTS.transitionDuration, distance = 24): LyricTransitionState {
  const cue = cues[index];
  if (!cue) return { alpha: 0, offsetY: 0, scale: 1, start: 0, end: 0, duration: 0 };
  const start = cue.time;
  const end = Math.min(cue.end ?? Infinity, cues[index + 1]?.time ?? Infinity, projectEnd);
  const duration = Math.min(clamp(Number.isFinite(durationSec) ? durationSec : LYRIC_STYLE_DEFAULTS.transitionDuration, 0.05, 2), Math.max(0, (end - start) / 2));
  if (timeSec < start || timeSec >= end || end <= start) return { alpha: 0, offsetY: 0, scale: 1, start, end, duration };
  if (mode === 'none' || !LYRIC_TRANSITIONS.includes(mode as LyricTransition) || duration <= 0) return { alpha: 1, offsetY: 0, scale: 1, start, end, duration };
  const ease = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const incoming = ease((timeSec - start) / duration);
  const outgoing = ease((end - timeSec) / duration);
  const alpha = Math.min(incoming, outgoing);
  const direction = mode === 'fade-up' ? 1 : mode === 'fade-down' ? -1 : 0;
  return { alpha, offsetY: direction * distance * (outgoing - incoming), scale: mode === 'fade-zoom' ? 0.94 + 0.06 * alpha : 1, start, end, duration };
}
