import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DawRhythmAnalysis } from '../src/daw/rhythm-analysis';
import type { RhythmAudioJob, RhythmWavInfo } from './daw-rhythm-audio';

const MAX_ANALYSIS_SECONDS = 90;
const DEFAULT_ANALYSIS_SECONDS = 60;
const MAX_CACHED_RESULTS = 24;
const cache = new Map<string, DawRhythmResult>();

export interface DawRhythmResult extends DawRhythmAnalysis {
  assetId: string; start: number; cached: boolean;
}

function failure(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }

export function rhythmAnalysisRange(info: RhythmWavInfo, input: unknown): { startSample: number; sampleCount: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('节奏分析参数无效');
  const value = input as Record<string, unknown>;
  const start = value.start === undefined ? 0 : value.start;
  const duration = value.duration === undefined ? DEFAULT_ANALYSIS_SECONDS : value.duration;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start >= info.duration) throw failure('分析起点超出音频范围');
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_ANALYSIS_SECONDS) throw failure('分析时长须大于 0 且不超过 90 秒');
  const startSample = Math.min(info.sampleCount - 1, Math.round(start * info.sampleRate));
  const sampleCount = Math.min(info.sampleCount - startSample, Math.round(duration * info.sampleRate));
  if (sampleCount < info.sampleRate * 6) throw failure('节奏分析至少需要 6 秒音频，请选择更长的片段');
  return { startSample, sampleCount };
}

function workerFile(): string {
  // The bundled CJS server lives beside its worker. tsx development runs from the
  // app root and the dev script builds this entry first.
  const directory = typeof __dirname === 'string' ? __dirname : path.resolve(process.cwd(), 'dist-server');
  return path.join(directory, 'daw-rhythm-worker.cjs');
}

/** Runs both PCM preprocessing and DSP outside the API event loop. */
export function runRhythmWorker(job: RhythmAudioJob, signal: AbortSignal, file = workerFile()): Promise<DawRhythmAnalysis> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: job });
    let settled = false;
    const timer = setTimeout(() => finish(failure('节奏分析超时，请选择更短的音频片段', 408)), 30000);
    const abort = () => finish(failure('节奏分析已取消', 499));
    const finish = (error?: Error, result?: DawRhythmAnalysis) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      // Keep the caller's task slot occupied until termination has closed any
      // worker-owned file handles. Immediate rejection could allow a retry to
      // overlap the still-exiting worker after a cancellation.
      const complete = (terminationError?: unknown) => {
        worker.removeAllListeners();
        const reason = error || (terminationError ? failure('节奏分析工作线程未能正常结束') : undefined);
        reason ? reject(reason) : resolve(result!);
      };
      void worker.terminate().then(() => complete(), complete);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { result?: DawRhythmAnalysis; error?: string }) => {
      if (message.error) finish(failure(message.error));
      else if (message.result) finish(undefined, message.result);
      else finish(failure('节奏分析返回无效数据'));
    });
    worker.once('error', error => finish(failure(`无法运行节奏分析：${error instanceof Error ? error.message : '工作线程异常'}`)));
    worker.once('exit', () => { if (!settled) finish(failure('节奏分析提前结束，请重试')); });
    if (signal.aborted) abort();
  });
}

/** file/info are resolved by the router, never supplied as paths by the request. */
export async function analyzeDawRhythmFile(source: { assetId: string; file: string; info: RhythmWavInfo }, input: unknown,
  signal: AbortSignal, workerPath?: string): Promise<DawRhythmResult> {
  signal.throwIfAborted();
  const range = rhythmAnalysisRange(source.info, input);
  const stat = await fs.stat(source.file); signal.throwIfAborted();
  const key = `${source.assetId}:${stat.size}:${stat.mtimeMs}:${range.startSample}:${range.sampleCount}`;
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key); cache.set(key, previous);
    return structuredClone({ ...previous, cached: true });
  }
  const result = await runRhythmWorker({ file: source.file, info: source.info, ...range }, signal, workerPath);
  signal.throwIfAborted();
  const response = { ...result, assetId: source.assetId, start: range.startSample / source.info.sampleRate, cached: false };
  cache.set(key, structuredClone(response));
  if (cache.size > MAX_CACHED_RESULTS) cache.delete(cache.keys().next().value!);
  return response;
}
