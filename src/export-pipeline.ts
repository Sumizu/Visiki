export const MAX_EXPORT_BATCH_BYTES = 16 * 1024 * 1024;

/** The producer may render one next batch while exactly one upload is in flight.
 * The next request starts only after its predecessor is acknowledged, keeping
 * frame order deterministic and retaining at most two bounded pixel batches. */
export async function runExportPipeline<T>(total: number, batchSize: number,
  render: (start: number, count: number) => Promise<T>,
  upload: (start: number, count: number, data: T) => Promise<void>,
  signal?: AbortSignal, onUploaded?: (completed: number) => void): Promise<void> {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('导出帧数无效');
  let pending: Promise<void> | undefined;
  let failure: { reason: unknown } | undefined;
  const check = (): void => {
    signal?.throwIfAborted();
    if (failure) throw failure.reason;
  };
  for (let start = 0; start < total; start += batchSize) {
    check();
    const count = Math.min(batchSize, total - start);
    const data = await render(start, count);
    check();
    await pending;
    check();
    pending = Promise.resolve().then(() => upload(start, count, data)).then(() => onUploaded?.(start + count));
    // Rendering the next batch is asynchronous too. Observe failures immediately
    // so a failed upload cannot become an unhandled rejection while it renders.
    void pending.catch(reason => { failure ??= { reason }; });
  }
  await pending;
  check();
}

export function exportBatchSize(width: number, height: number, advertisedBytes = MAX_EXPORT_BATCH_BYTES): number {
  const frameBytes = width * height * 4;
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 4 || !Number.isFinite(advertisedBytes)) throw new Error('导出画面尺寸无效');
  const limit = Math.min(MAX_EXPORT_BATCH_BYTES, Math.floor(advertisedBytes));
  if (frameBytes > limit) throw new Error('导出画面超出传输上限');
  return Math.max(1, Math.floor(limit / frameBytes));
}
