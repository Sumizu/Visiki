import { DEFAULT_DAW_MUSICAL_GRID, type DawMusicalGrid } from './model';
import { isDawGridDivision, type DawGridDivision } from './grid-division';

/** Timeline distances are seconds; viewport distances and scale are CSS pixels. */
export interface DawTimelineGridOptions extends Partial<DawMusicalGrid> {
  unit?: 'time' | 'bars';
  gridDivision?: DawGridDivision;
}
export interface DawGrid {
  majorStep: number;
  /** Visible subdivision spacing, which may thin dense fixed note grids. */
  minorStep: number;
  /** Editing interval, independent of zoom for a manually selected note value. */
  snapStep: number;
}

export interface DawGridLine {
  time: number;
  x: number;
  major: boolean;
}

const finiteScale = (value: number) => Number.isFinite(value) && value > 0 ? Math.max(4, Math.min(250, value)) : 35;
const cleanTime = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const precise = (value: number) => Math.round(value * 1e9) / 1e9;

/** Select a readable interval from 1, 2, 5 × 10^n. */
function niceInterval(minimum: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  const fraction = minimum / magnitude;
  const step = fraction <= 1 + 1e-10 ? 1 : fraction <= 2 + 1e-10 ? 2 : fraction <= 5 + 1e-10 ? 5 : 10;
  return precise(step * magnitude);
}

const musicalGrid = (options: Partial<DawMusicalGrid> = {}): DawMusicalGrid => ({
  bpm: Number.isFinite(options.bpm) && options.bpm! >= 20 && options.bpm! <= 300 ? options.bpm! : DEFAULT_DAW_MUSICAL_GRID.bpm,
  beatsPerBar: Number.isInteger(options.beatsPerBar) && options.beatsPerBar! >= 2 && options.beatsPerBar! <= 12 ? options.beatsPerBar! : DEFAULT_DAW_MUSICAL_GRID.beatsPerBar,
  beatUnit: [2, 4, 8, 16].includes(options.beatUnit!) ? options.beatUnit! : DEFAULT_DAW_MUSICAL_GRID.beatUnit,
});

/** Quarter-note tempo, with notated beat lengths derived from the signature denominator. */
export function getDawMusicalTiming(options: Partial<DawMusicalGrid> = {}): DawMusicalGrid & { beatSeconds: number; barSeconds: number } {
  const grid = musicalGrid(options);
  const beatSeconds = 60 / grid.bpm * 4 / grid.beatUnit;
  return { ...grid, beatSeconds, barSeconds: beatSeconds * grid.beatsPerBar };
}

/** One-based bar.beat display. Epsilon keeps rounded grid times on their intended beat. */
export function formatDawBars(time: number, options: Partial<DawMusicalGrid> = {}): string {
  const { beatSeconds, beatsPerBar } = getDawMusicalTiming(options);
  const beatIndex = Math.floor(cleanTime(time) / beatSeconds + 1e-7);
  return `${Math.floor(beatIndex / beatsPerBar) + 1}.${beatIndex % beatsPerBar + 1}`;
}

/** Grid subdivisions always divide whole bars, including compound and odd signatures. */
function getBarGrid(scale: number, options: DawTimelineGridOptions): DawGrid {
  const { beatSeconds, barSeconds, beatsPerBar } = getDawMusicalTiming(options);
  const beatPx = beatSeconds * scale;
  const barPx = barSeconds * scale;
  const divisors = Array.from({ length: beatsPerBar }, (_, index) => index + 1).filter(value => beatsPerBar % value === 0);
  const stepForPixels = (minimum: number) => {
    if (barPx < minimum) return barSeconds * 2 ** Math.ceil(Math.log2(minimum / barPx));
    if (beatPx >= minimum) {
      const divisions = 2 ** Math.floor(Math.log2(beatPx / minimum));
      return beatSeconds / divisions;
    }
    return beatSeconds * divisors.find(value => value * beatPx >= minimum - 1e-9)!;
  };
  // Labels stay on beats; only grid/snap lines subdivide individual beats.
  const majorStep = beatPx >= 90 ? beatSeconds : stepForPixels(90);
  const minorStep = stepForPixels(18);
  return { majorStep, minorStep, snapStep: minorStep };
}

export function getDawGrid(scale: number, options: DawTimelineGridOptions = {}): DawGrid {
  const pxPerSecond = finiteScale(scale);
  const automatic = options.unit === 'bars' ? getBarGrid(pxPerSecond, options) : (() => {
    const majorStep = niceInterval(90 / pxPerSecond);
    const minorStep = Math.min(majorStep, niceInterval(18 / pxPerSecond));
    return { majorStep, minorStep, snapStep: minorStep };
  })();
  if (!isDawGridDivision(options.gridDivision) || options.gridDivision === 'auto') return automatic;
  const timing = getDawMusicalTiming(options);
  const snapStep = options.gridDivision === 'bar'
    ? timing.barSeconds
    : 60 / timing.bpm * 4 / Number(options.gridDivision.slice(2));
  // Thinning is purely visual: editing still uses the chosen note length, even when zoomed out.
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(6 / (snapStep * pxPerSecond))));
  return { majorStep: automatic.majorStep, minorStep: snapStep * stride, snapStep };
}

/** Only materialize visible lines, including one offscreen line on either side. */
export function getDawGridLines(options: {
  scale: number;
  left: number;
  width: number;
  totalSeconds: number;
} & DawTimelineGridOptions): DawGridLine[] {
  const scale = finiteScale(options.scale);
  const { majorStep, minorStep } = getDawGrid(scale, options);
  const left = cleanTime(options.left);
  const width = cleanTime(options.width);
  const totalSeconds = cleanTime(options.totalSeconds);
  if (width === 0) return [];
  const lines: DawGridLine[] = [];
  const append = (step: number, major: boolean) => {
    const firstIndex = Math.max(0, Math.floor(left / scale / step) - 1);
    const lastIndex = Math.min(Math.floor((totalSeconds + 1e-9) / step), Math.ceil((left + width) / scale / step) + 1);
    for (let index = firstIndex; index <= lastIndex; index++) {
      const time = precise(index * step);
      lines.push({ time, x: time * scale, major });
    }
  };
  const manual = isDawGridDivision(options.gridDivision) && options.gridDivision !== 'auto';
  if (!manual) {
    const majorMultiple = Math.round(majorStep / minorStep);
    append(minorStep, false);
    // Automatic grids nest exactly, preserving the existing ruler layout.
    for (const line of lines) line.major = Math.round(line.time / minorStep) % majorMultiple === 0;
    return lines;
  }
  // Ruler labels and fixed musical divisions need not share a common interval: e.g. 137 BPM
  // eighth notes on a seconds ruler, or whole notes in 3/4. Keep both exact timelines.
  append(minorStep, false);
  append(majorStep, true);
  lines.sort((a, b) => a.time - b.time || Number(b.major) - Number(a.major));
  const merged: DawGridLine[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.time - line.time) < 1e-8) {
      if (line.major) merged[merged.length - 1] = line;
    } else merged.push(line);
  }
  return merged;
}

export interface DawSnapTarget {
  time: number;
  label: string;
}

export interface DawSnapResult {
  time: number;
  snapped: boolean;
  label: string | null;
  kind: 'grid' | 'edge' | null;
}

export function snapDawTime(time: number, options: {
  scale: number;
  enabled: boolean;
  bypass?: boolean;
  gridStep: number;
  targets: readonly DawSnapTarget[];
  tolerancePx?: number;
}): DawSnapResult {
  const safeTime = cleanTime(time);
  const unchanged: DawSnapResult = { time: safeTime, snapped: false, label: null, kind: null };
  if (!options.enabled || options.bypass) return unchanged;
  const tolerancePx = Number.isFinite(options.tolerancePx) ? Math.max(0, options.tolerancePx!) : 8;
  const tolerance = tolerancePx / finiteScale(options.scale);
  let closest: DawSnapTarget | undefined;
  let distance = Infinity;
  for (const target of options.targets) {
    if (!Number.isFinite(target.time) || target.time < 0) continue;
    const delta = Math.abs(target.time - safeTime);
    // A clip edge or the transport cursor is a stronger editing intention than the grid.
    if (delta <= tolerance + 1e-10 && delta < distance - 1e-10) {
      closest = target;
      distance = delta;
    }
  }
  if (closest) return { time: closest.time, snapped: true, label: closest.label, kind: 'edge' };
  if (!Number.isFinite(options.gridStep) || options.gridStep <= 0) return unchanged;
  const gridTime = precise(Math.round(safeTime / options.gridStep) * options.gridStep);
  if (Math.abs(gridTime - safeTime) > tolerance + 1e-10) return unchanged;
  return { time: gridTime, snapped: true, label: '时间网格', kind: 'grid' };
}
