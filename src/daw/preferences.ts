import { isDawGridDivision, type DawGridDivision } from './grid-division';

export interface DawPreferences {
  snapEnabled: boolean;
  snapGrid: boolean;
  snapEdges: boolean;
  snapCursor: boolean;
  rulerUnit: 'time' | 'bars';
  gridDivision: DawGridDivision;
  restartMode: 'resume' | 'from-cursor';
}
export const DAW_PREFERENCES_KEY = 'visiki-daw-preferences-v1';
export const DEFAULT_DAW_PREFERENCES: Readonly<DawPreferences> = {
  snapEnabled: true, snapGrid: true, snapEdges: true, snapCursor: true,
  rulerUnit: 'time', gridDivision: 'auto', restartMode: 'resume',
};

/** UI preferences are independent from audio edits and project undo history. */
export function parseDawPreferences(input: unknown): DawPreferences {
  const result = { ...DEFAULT_DAW_PREFERENCES };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const value = input as Partial<DawPreferences>;
  for (const key of ['snapEnabled', 'snapGrid', 'snapEdges', 'snapCursor'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (value.rulerUnit === 'time' || value.rulerUnit === 'bars') result.rulerUnit = value.rulerUnit;
  if (isDawGridDivision(value.gridDivision)) result.gridDivision = value.gridDivision;
  if (value.restartMode === 'resume' || value.restartMode === 'from-cursor') result.restartMode = value.restartMode;
  return result;
}
export function readDawPreferences(): DawPreferences {
  try { return parseDawPreferences(JSON.parse(localStorage.getItem(DAW_PREFERENCES_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_DAW_PREFERENCES }; }
}
