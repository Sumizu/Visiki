import { parentPort, workerData } from 'node:worker_threads';
import { analyzeDawRhythmChannels } from '../src/daw/rhythm-analysis';
import { readRhythmAudio, type RhythmAudioJob } from './daw-rhythm-audio';

async function run(): Promise<void> {
  try {
    const job = workerData as RhythmAudioJob;
    const audio = await readRhythmAudio(job);
    const result = analyzeDawRhythmChannels(audio.channels, audio.sampleRate, { startTime: job.startSample / job.info.sampleRate });
    parentPort?.postMessage({ result });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : '节奏分析失败' });
  }
}
void run();
