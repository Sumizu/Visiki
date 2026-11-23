const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const bandFrequencies = [40, 100, 250, 750, 2000, 5000, 10000, 16000];

export const eqCutoffHz = (requested: number, sampleRate: number) => clamp(requested, 20, Math.min(20000, .475 * sampleRate));
export const eqSupportsDynamics = (mode: number) => mode === 0 || mode === 1 || mode === 2;

export function eqBandResponse(frequency: number, params: Record<string, number>, band: number, sampleRate: number, reductionDb = 0): number {
  const prefix = `band${band}`;
  const solo = params.soloBand ?? 0;
  if (!(params[`${prefix}Enabled`] ?? (band === 3 ? 1 : 0)) || (solo && solo !== band)) return 0;
  const cutoff = eqCutoffHz(params[`${prefix}Freq`] ?? bandFrequencies[band - 1], sampleRate);
  const quality = clamp(params[`${prefix}Q`] ?? .707, .1, 18), mode = params[`${prefix}Type`] ?? 0;
  const reduction = !solo && params[`${prefix}Dyn`] && eqSupportsDynamics(mode) && Number.isFinite(reductionDb) ? clamp(reductionDb, 0, params[`${prefix}Range`] ?? 6) : 0;
  const gain = (params[`${prefix}Gain`] ?? 0) - reduction;
  const type = solo && mode < 3 ? 6 : mode;
  const sections = 1 + (params[`${prefix}Slope`] ?? 0);
  if ((type === 3 || type === 4) && sections > 1) return Array.from({ length: sections }, (_, section) => eqBandResponse(frequency, { ...params, [`${prefix}Slope`]: 0, [`${prefix}Q`]: 1 / (2 * Math.cos((2 * section + 1) * Math.PI / (4 * sections))) }, band, sampleRate)).reduce((sum, value) => sum + value, 0);
  return filterResponse(frequency, cutoff, quality, type, gain, sampleRate);
}

export function eqMatchResponse(frequency: number, params: Record<string, number>, sampleRate: number): number {
  const strength = (params.matchStrength ?? 0) / 100;
  if (!strength || params.soloBand) return 0;
  return EQ_MATCH_FREQUENCIES.reduce((sum, center, index) => {
    const gain = (params[`matchGain${index + 1}`] ?? 0) * strength;
    return gain && center < sampleRate * .475 ? sum + filterResponse(frequency, center, EQ_MATCH_Q, 0, gain, sampleRate) : sum;
  }, 0);
}

function filterResponse(frequency: number, cutoff: number, quality: number, type: number, gain: number, sampleRate: number): number {
  const a = 10 ** (gain / 40), w0 = 2 * Math.PI * cutoff / sampleRate, c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * quality), sqrtA = Math.sqrt(a);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (type === 0) { b0 = 1 + alpha * a; b1 = -2 * c; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = -2 * c; a2 = 1 - alpha / a; }
  else if (type === 1) { b0 = a * ((a + 1) - (a - 1) * c + 2 * sqrtA * alpha); b1 = 2 * a * ((a - 1) - (a + 1) * c); b2 = a * ((a + 1) - (a - 1) * c - 2 * sqrtA * alpha); a0 = (a + 1) + (a - 1) * c + 2 * sqrtA * alpha; a1 = -2 * ((a - 1) + (a + 1) * c); a2 = (a + 1) + (a - 1) * c - 2 * sqrtA * alpha; }
  else if (type === 2) { b0 = a * ((a + 1) + (a - 1) * c + 2 * sqrtA * alpha); b1 = -2 * a * ((a - 1) + (a + 1) * c); b2 = a * ((a + 1) + (a - 1) * c - 2 * sqrtA * alpha); a0 = (a + 1) - (a - 1) * c + 2 * sqrtA * alpha; a1 = 2 * ((a - 1) - (a + 1) * c); a2 = (a + 1) - (a - 1) * c - 2 * sqrtA * alpha; }
  else if (type === 3 || type === 4) { const low = type === 4; b0 = (1 + (low ? -c : c)) / 2; b1 = low ? 1 - c : -(1 + c); b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else { b0 = type === 6 ? alpha : 1; b1 = type === 6 ? 0 : -2 * c; b2 = type === 6 ? -alpha : 1; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  const w = 2 * Math.PI * frequency / sampleRate, numerator = (b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w)) ** 2 + (b1 * Math.sin(w) + b2 * Math.sin(2 * w)) ** 2;
  const denominator = (a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w)) ** 2 + (a1 * Math.sin(w) + a2 * Math.sin(2 * w)) ** 2;
  return 10 * Math.log10(Math.max(1e-12, numerator / denominator));
}
import { EQ_MATCH_FREQUENCIES, EQ_MATCH_Q } from './effects';

