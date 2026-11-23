import type { Writable } from 'node:stream';

// One request holds a bounded batch; callers must await its acknowledgement before
// posting the next one. No server-side frame queue or reordering is necessary.
export const MAX_FRAME_BATCH_BYTES = 16 * 1024 * 1024;
export interface FrameWriteState {
  width: number; height: number; total: number; expected: number; writing: boolean;
  state: 'rendering'|'encoding'|'complete'|'cancelled'|'error';
  lastActivity: number; error?: string;
}

export function frameBatchCount(job: FrameWriteState, start: number, byteLength: number): number {
  if (job.state !== 'rendering') throw new Error(job.error || '任务已结束或取消');
  if (!Number.isSafeInteger(start) || start !== job.expected || start >= job.total || job.writing) throw new Error(`帧顺序错误：期望 ${job.expected}`);
  const frameBytes = job.width * job.height * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % frameBytes !== 0) throw new Error('RGBA 帧字节数不正确');
  if (byteLength > MAX_FRAME_BATCH_BYTES) throw new Error('RGBA 帧批次超过 16 MiB');
  const count = byteLength / frameBytes;
  if (start + count > job.total) throw new Error('RGBA 帧批次超过导出总帧数');
  return count;
}

export async function writeFrameBatch(job: FrameWriteState, start: number, buffer: Buffer, input: Pick<Writable, 'write'>): Promise<number> {
  const count = frameBatchCount(job, start, buffer.length);
  job.writing = true; job.lastActivity = Date.now();
  try {
    // A single bounded write preserves the exact byte order and waits for pipe
    // backpressure. The browser can render its next batch during this wait.
    await new Promise<void>((resolve, reject) => input.write(buffer, error => error ? reject(error) : resolve()));
    if (job.state !== 'rendering') throw new Error(job.error || '导出已取消');
    job.expected += count; job.lastActivity = Date.now();
    return job.expected;
  } finally { job.writing = false; }
}
