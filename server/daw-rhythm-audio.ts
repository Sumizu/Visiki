import { promises as fs } from 'node:fs';

export interface RhythmWavInfo {
  sampleRate: number; channels: 1 | 2; sampleCount: number; duration: number; dataOffset: number; dataBytes: number;
}
export interface RhythmAudioJob {
  file: string; info: RhythmWavInfo; startSample: number; sampleCount: number;
}

export async function readRhythmAudio(job: RhythmAudioJob): Promise<{ channels: Float32Array<ArrayBuffer>[]; sampleRate: number }> {
  const { info } = job;
  const sampleRate = Math.min(11025, info.sampleRate);
  const length = Math.max(1, Math.ceil(job.sampleCount * sampleRate / info.sampleRate));
  const outputs = Array.from({ length: info.channels }, () => new Float32Array(length));
  const counts = new Uint16Array(length);
  const handle = await fs.open(job.file, 'r');
  try {
    const blockAlign = info.channels * 4;
    const buffer = Buffer.alloc(65536 - 65536 % blockAlign);
    let frame = 0;
    while (frame < job.sampleCount) {
      const frames = Math.min(buffer.length / blockAlign, job.sampleCount - frame);
      const bytes = frames * blockAlign;
      const position = info.dataOffset + (job.startSample + frame) * blockAlign;
      const { bytesRead } = await handle.read(buffer, 0, bytes, position);
      if (bytesRead !== bytes) throw new Error('音频缓存不完整，请重新导入');
      for (let local = 0; local < frames; local++) {
        const index = Math.min(length - 1, Math.floor((frame + local) * sampleRate / info.sampleRate));
        counts[index]++;
        for (let channel = 0; channel < info.channels; channel++) {
          const sample = buffer.readFloatLE((local * info.channels + channel) * 4);
          if (!Number.isFinite(sample) || Math.abs(sample) > 1e6) throw new Error('音频缓存包含无效样本，请重新导入');
          outputs[channel][index] += sample;
        }
      }
      frame += frames;
    }
    for (const output of outputs) {
      for (let index = 0; index < length; index++) {
        output[index] /= Math.max(1, counts[index]);
      }
    }
    return { channels: outputs, sampleRate };
  } finally { await handle.close(); }
}
