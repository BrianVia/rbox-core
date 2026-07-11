// THROWAWAY measurement harness — design 99 Phase 1, step-4 production-path A/B.
// Drives the REAL CryptoPool (not the Phase-0 prototype): Arm A = the per-file oracle
// path (`pool.encrypt` → encryptFileToTempInline), Arm B = the production fused
// `pool.encryptStream` with a null-release consumer (release each lease immediately —
// matches Phase-0 Arm-B null sink and design §8 gate 1 "first-start → last-ready").
// One arm per child process so maxRSS / peak FD are attributed per arm.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withCryptoPool, poolMap } from "../../src/engine/index.js";
import { startSamplers } from "../d99-p0/metrics.js";
import type { CorpusFile } from "../d99-p0/corpus.js";

const args = Object.fromEntries(process.argv.slice(2).map((v) => { const [k, ...r] = v.split("="); return [k.replace(/^--/, ""), r.join("=")]; }));
const arm = args.arm;
const workers = Number(args.workers);
process.env.RBOX_CRYPTO_WORKERS = String(workers);
process.env.RBOX_CRYPTO_POOL_MIN_JOBS = "1";
if (args.dispatch) process.env.RBOX_CRYPTO_FUSE_DISPATCH = String(args.dispatch);
if (args.budget) process.env.RBOX_CRYPTO_FUSE_BUDGET_BYTES = String(Number(args.budget) * 1048576);

const corpus = JSON.parse(await fs.readFile(args.manifest, "utf8")) as CorpusFile[];
const kek = Buffer.from(args.kek, "hex");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "d99p1-cell-"));
const sampler = startSamplers();
const encConcurrency = workers * 2; // production poolMap width for Arm A

try {
  const wall = await withCryptoPool(kek, 1, corpus.length, async (pool) => {
    if (!pool) throw new Error("crypto pool did not start");
    const created: string[] = [];
    if (arm === "A") {
      const start = performance.now();
      await poolMap(corpus, encConcurrency, async (f) => {
        const blob = await pool.encrypt(f.absPath, tmp, { compress: true, expected: f.expected });
        created.push(blob.ciphertextPath); // discard (null sink); cleanup excluded from wall
      });
      const ms = performance.now() - start;
      await Promise.all(created.map((p) => fs.rm(p, { force: true }).catch(() => {})));
      return ms;
    }
    // Arm B — production fused stream, null-release consumer.
    const items = corpus.map((f) => ({ ref: f.index, srcPath: f.absPath, size: f.size, tmpDir: tmp, opts: { compress: true, expected: f.expected } }));
    let ready = 0;
    const start = performance.now();
    const done = new Promise<number>((resolve, reject) => {
      pool.encryptStream(items, {
        onReady: (_ref, blob) => {
          // Null sink: for the spill/oversize file variant, delete the temp so FD/disk
          // stay bounded; release the lease immediately (measures encrypt→ready only).
          if (blob.lease.location.kind === "file") created.push(blob.lease.location.path);
          blob.lease.release();
          if (++ready === items.length) resolve(performance.now() - start);
        },
      });
      setTimeout(() => { if (ready < items.length) reject(new Error(`stream stalled at ${ready}/${items.length}`)); }, 120_000);
    });
    const ms = await done;
    await Promise.all(created.map((p) => fs.rm(p, { force: true }).catch(() => {})));
    return ms;
  });
  const memory = sampler.stop();
  process.stdout.write(JSON.stringify({ arm, wallMs: wall, filesPerSecond: corpus.length / (wall / 1000), ...memory }));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
