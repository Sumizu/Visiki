const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const gain = (db: number) => 10 ** (db / 20);

/** Steady-state transfer; assumes detector level equals input level. */
export function compressorTransfer(input: number, threshold: number, ratio: number, knee: number, makeup: number, mix: number): number {
  const over = input - threshold;
  let reduction = 0;
  if (knee > 0 && Math.abs(over) < knee / 2) reduction = (1 / ratio - 1) * (over + knee / 2) ** 2 / (2 * knee);
  else if (over > 0) reduction = (1 / ratio - 1) * over;
  const wet = clamp(mix / 100, 0, 1);
  return input + 20 * Math.log10((1 - wet) + wet * gain(reduction + makeup));
}

/** Native detector's digital band-pass response, including phase. */
export function deesserResponse(frequency: number, center: number, bandwidth: number, sampleRate: number) {
  const hz = clamp(center, 5, sampleRate * .475);
  const q = clamp(1 / (2 * Math.sinh(Math.log(2) * bandwidth / 2)), .1, 18);
  const w0 = 2 * Math.PI * hz / sampleRate, alpha = Math.sin(w0) / (2 * q);
  const w = 2 * Math.PI * frequency / sampleRate;
  const nr = alpha * (1 - Math.cos(2 * w)), ni = alpha * Math.sin(2 * w);
  const dr = 1 + alpha - 2 * Math.cos(w0) * Math.cos(w) + (1 - alpha) * Math.cos(2 * w);
  const di = 2 * Math.cos(w0) * Math.sin(w) - (1 - alpha) * Math.sin(2 * w);
  const denominator = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / denominator, im: (ni * dr - nr * di) / denominator, hz, q };
}

export function deesserLimitDb(frequency: number, center: number, bandwidth: number, sampleRate: number, range: number, mix: number, split: boolean): number {
  const k = clamp(mix / 100, 0, 1) * (1 - gain(-range));
  if (!split) return 20 * Math.log10(1 - k);
  const h = deesserResponse(frequency, center, bandwidth, sampleRate);
  return 20 * Math.log10(Math.max(1e-12, Math.hypot(1 - k * h.re, k * h.im)));
}

export function saturationTransfer(x: number, driveDb: number, bias: number, mode: number, mix: number, outputDb: number): number {
  const shape = (v: number) => mode === 1 ? Math.tanh(v) : mode === 2 ? clamp(v, -1, 1) : Math.abs(v) >= 1 ? Math.sign(v) * 2 / 3 : v - v ** 3 / 3;
  const wet = clamp(mix / 100, 0, 1);
  return ((1 - wet) * x + wet * (shape(x * gain(driveDb) + bias) - shape(bias))) * gain(outputDb);
}

export function delayEvents(left: number, right: number, feedback: number, mix: number, pingPong: boolean, count = 5) {
  const events: { side: 'L' | 'R'; time: number; amplitude: number }[] = [];
  const fb = clamp(feedback / 100, 0, .95), wet = clamp(mix / 100, 0, 1);
  if (pingPong) {
    let time = 0;
    for (let i = 0; i < count; i++) { time += i % 2 === 0 ? left : right; events.push({ side: i % 2 === 0 ? 'L' : 'R', time, amplitude: wet * fb ** i }); }
  } else {
    for (const [side, time] of [['L', left], ['R', right]] as const) for (let i = 0; i < count; i++) events.push({ side, time: time * (i + 1), amplitude: wet * fb ** i });
  }
  return events;
}
