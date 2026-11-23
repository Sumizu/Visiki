/** UI grid resolution; note values always refer to quarter-note BPM. */
export const DAW_GRID_DIVISIONS = [
  { value: 'auto', label: '自动' },
  { value: 'bar', label: '一小节' },
  { value: '1/1', label: '全音符' },
  { value: '1/2', label: '二分音符' },
  { value: '1/4', label: '四分音符' },
  { value: '1/8', label: '八分音符' },
  { value: '1/16', label: '十六分音符' },
  { value: '1/32', label: '三十二分音符' },
  { value: '1/64', label: '六十四分音符' },
] as const;

export type DawGridDivision = typeof DAW_GRID_DIVISIONS[number]['value'];

export function isDawGridDivision(value: unknown): value is DawGridDivision {
  return DAW_GRID_DIVISIONS.some(option => option.value === value);
}
