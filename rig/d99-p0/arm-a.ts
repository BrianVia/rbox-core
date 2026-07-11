import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { withCryptoPool, __cryptoPoolTestHooks } from "../../src/engine/crypto-pool.js";
import type { CorpusFile } from "./corpus.js";
import { quantile } from "./metrics.js";

/** Arm A — today's per-file worker path, driven through the REAL CryptoPool at
 *  production caller concurrency (sync-recovery.ts poolMap uses poolWorkers*2). */
export async function runArmA(corpus: CorpusFile[], kek: Buffer, tmpDir: string, workers: number) {
  await __cryptoPoolTestHooks.reset();
  let start = 0;
  const latencies: number[] = [];
  const ciphertextPaths: string[] = [];
  let cipherBytes = 0;
  await withCryptoPool(kek, 1, corpus.length, async (pool) => {
    if (!pool) throw new Error("real CryptoPool unavailable");
    // Fairness: Arm B initializes its workers BEFORE its clock starts, so Arm A's
    // clock also starts after the pool is up (pool spawn/health excluded).
    start = performance.now();
    let next = 0;
    const width = Math.min(corpus.length, workers * 2); // production: encryptConcurrency = poolWorkers*2
    await Promise.all(
      Array.from({ length: width }, async () => {
        while (next < corpus.length) {
          const file = corpus[next++];
          const t = performance.now();
          const blob = await pool.encrypt(file.absPath, tmpDir, { compress: true, expected: file.expected });
          latencies.push(performance.now() - t);
          cipherBytes += blob.cipherSize;
          ciphertextPaths.push(blob.ciphertextPath);
        }
      })
    );
  });
  const wallMs = performance.now() - start;
  await Promise.all(ciphertextPaths.map((p) => fs.rm(p, { force: true }))); // cleanup excluded from wall
  await __cryptoPoolTestHooks.reset();
  const plaintextBytes = corpus.reduce((n, f) => n + f.size, 0);
  // Only REAL measurements are emitted: pool-internal queue wait / per-job overhead
  // are not observable without touching src/ (adversarial review item 8).
  return {
    arm: "A",
    wallMs,
    enqueueResolveP50Ms: quantile(latencies, 0.5),
    enqueueResolveP99Ms: quantile(latencies, 0.99),
    messageCount: corpus.length,
    jobCount: corpus.length,
    tempBytesWritten: plaintextBytes + cipherBytes, // snapshot + ct temp per file (buffered compress writes no temp)
    filesPerSecond: corpus.length / (wallMs / 1000),
    plaintextMiBPerSecond: plaintextBytes / 1048576 / (wallMs / 1000),
  };
}
