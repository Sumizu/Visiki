/** Main mix after the session master fader and before the listening volume. */
export const DAW_MASTER_METER = '__master__';
export interface DawMeterReading { peak: number; rms: number }
export type DawMeterLevels = Record<string, DawMeterReading>;
export const DAW_METER_FLOOR = -60;

export interface DawMeterState {
  peakDb: number;
  rmsDb: number;
  holdDb: number;
  holdUntil: number;
  clipUntil: number;
  time: number | undefined;
}

export function gainToMeterDb(gain: number): number {
  return Number.isFinite(gain) && gain > 0 ? Math.max(DAW_METER_FLOOR, 20 * Math.log10(gain)) : DAW_METER_FLOOR;
}
export function meterDbToUnit(db: number): number {
  return Math.max(0, Math.min(1, (db - DAW_METER_FLOOR) / -DAW_METER_FLOOR));
}
export function createDawMeterState(): DawMeterState {
  return { peakDb: DAW_METER_FLOOR, rmsDb: DAW_METER_FLOOR, holdDb: DAW_METER_FLOOR, holdUntil: 0, clipUntil: 0, time: undefined };
}

/** Display-only ballistics: actual samples are read by the audio engine. */
export function advanceDawMeter(previous: DawMeterState, reading: DawMeterReading | undefined, timeMs: number): DawMeterState {
  const time = Number.isFinite(timeMs) ? timeMs : previous.time ?? 0;
  const elapsed = previous.time === undefined ? 0 : Math.max(0, time - previous.time) / 1000;
  const rawPeak = gainToMeterDb(reading?.peak ?? 0);
  const rawRms = gainToMeterDb(reading?.rms ?? 0);
  const peakDb = Math.max(rawPeak, previous.peakDb - 30 * elapsed);
  const rmsDb = rawRms >= previous.rmsDb
    ? previous.rmsDb + (rawRms - previous.rmsDb) * (previous.time === undefined ? 1 : 1 - Math.exp(-elapsed / .025))
    : Math.max(rawRms, previous.rmsDb - 20 * elapsed);
  let holdDb = previous.holdDb, holdUntil = previous.holdUntil;
  if (rawPeak >= holdDb) { holdDb = rawPeak; holdUntil = time + 1000; }
  else if (time > holdUntil) {
    const releaseSeconds = Math.max(0, time - Math.max(holdUntil, previous.time ?? time)) / 1000;
    holdDb = Math.max(peakDb, holdDb - 20 * releaseSeconds);
  }
  return { peakDb, rmsDb, holdDb, holdUntil, clipUntil: rawPeak >= 0 ? time + 1200 : previous.clipUntil, time };
}

/** Peak and RMS use the same post-fader samples, including values above 0 dBFS. */
export function measureDawSamples(samples: Float32Array): DawMeterReading {
  let peak = 0, energy = 0;
  for (const sample of samples) {
    const value = Number.isFinite(sample) ? sample : 0;
    peak = Math.max(peak, Math.abs(value)); energy += value * value;
  }
  return { peak, rms: samples.length ? Math.sqrt(energy / samples.length) : 0 };
}

/** Combine channel energy without first summing phases or changing peak amplitude. */
export function measureDawChannels(channels: readonly Float32Array[]): DawMeterReading {
  let peak = 0, energy = 0, count = 0;
  for (const samples of channels) {
    for (const sample of samples) {
      const value = Number.isFinite(sample) ? sample : 0;
      peak = Math.max(peak, Math.abs(value)); energy += value * value;
    }
    count += samples.length;
  }
  return { peak, rms: count ? Math.sqrt(energy / count) : 0 };
}
