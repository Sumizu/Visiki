// The statistics branch sees the float mix before the WAV encoder can clip it.
// Count each channel by accumulating 1 for every sample that exceeds full scale.
export const appendDawClipCounter = (graph: string) => graph + ";[mix]asplit=2[export][count];[count]aeval='st(0,ld(0)+gt(abs(val(0)),1))|st(0,ld(0)+gt(abs(val(1)),1))':c=stereo,astats@visikiClipCount=measure_perchannel=Max_level:measure_overall=none[clipStats]";

export function readDawClipCount(log: string): number | null {
  const counts = [...log.matchAll(/^\[astats@visikiClipCount @ [^\]]+\]\s+Max level:\s+(\d+(?:\.0+)?)\s*$/gm)].map(match => Number(match[1]));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.length === 2 && Number.isSafeInteger(total) ? total : null;
}

export function readDawLoudnessScan(log: string, duration: number): { integrated: number | null; truePeak: number | null } | undefined {
  // loudnorm's input fields measure the WAV. Its processed output goes to the null muxer.
  const block = log.match(/\{\s*"input_i"\s*:[^{}]+\}/)?.[0];
  if (!block) return;
  try {
    const result = JSON.parse(block);
    const db = (value: unknown) => {
      if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'string' && !value.trim()) return null;
      const measure = Number(value);
      return Number.isFinite(measure) ? measure : null;
    };
    return { integrated: duration >= .4 ? db(result.input_i) : null, truePeak: db(result.input_tp) };
  } catch { return; }
}
