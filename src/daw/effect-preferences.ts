import { isDawEffectType, type DawEffect, type DawEffectType } from './effects';

export interface DawUserPreset { id: string; type: DawEffectType; name: string; params: Record<string, number> }
export const DAW_FAVORITES_KEY = 'visiki-daw-fx-favorites-v1';
export const DAW_PRESETS_KEY = 'visiki-daw-fx-presets-v1';

export function readEffectPreference<T>(key: string, validate: (value: unknown) => value is T): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter(validate) : [];
  } catch { return []; }
}

export function writeEffectPreference(key: string, list: readonly unknown[]) {
  const value = JSON.stringify(list);
  localStorage.setItem(key, value);
  // Changes from the MCP and from a docked editor share the same document.
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
}

export function isDawUserPreset(value: unknown): value is DawUserPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as DawUserPreset;
  return typeof preset.id === 'string' && typeof preset.name === 'string' && isDawEffectType(preset.type) &&
    !!preset.params && typeof preset.params === 'object' && !Array.isArray(preset.params) &&
    Object.values(preset.params).every(entry => typeof entry === 'number' && Number.isFinite(entry));
}
export const readDawUserPresets = () => readEffectPreference(DAW_PRESETS_KEY, isDawUserPreset);
export const readDawEffectFavorites = () => readEffectPreference(DAW_FAVORITES_KEY, isDawEffectType);
export function createDawUserPreset(effect: DawEffect, name: string): DawUserPreset {
  if (effect.type === 'vst3') throw new Error('VST3 不支持内置预设');
  return { id: `user-${crypto.randomUUID()}`, type: effect.type, name, params: { ...effect.params } };
}
