/**
 * Bounded-concurrency map: run `fn` over `items` with at most `concurrency` in
 * flight (a worker-pool, like the manifest hasher). This is the shared primitive
 * behind concurrent blob upload (push) and download (pull) — both were sequential
 * per-blob round-trips, which is latency-bound and slow on a real repo.
 *
 * Rejects on the FIRST task failure (fail-fast): already-running tasks settle but
 * no new ones start. That's the right shape for blob transfer — uploads/downloads
 * are idempotent and resumable, so a partial run just resumes next time.
 */
export async function poolMap<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
