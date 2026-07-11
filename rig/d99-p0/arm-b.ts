import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { CorpusFile } from "./corpus.js";
import { quantile } from "./metrics.js";

const MAX_JOB_BYTES = 4 * 1024 * 1024;
const MAX_JOB_FILES = 512;
const CLONE_SLACK = 64 * 1024;
const FUSE_MAX_FILE_BYTES = 256 * 1024;
const SPILL_WATERMARK = 0.75;

type Slot = { worker: Worker; busy: number; pending: Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }> };
type Held = { bytes: number; buf: ArrayBuffer | undefined; timer: ReturnType<typeof setTimeout>; released: boolean };

/** Arm B — fused byte-bounded in-memory jobs under a global ciphertext budget.
 *  settleMs > 0 holds each per-file charge for a simulated upload-settlement
 *  latency (design 99 §4.1 lease residence); settleMs = 0 is the pure null sink
 *  (§5.3 encrypt-critical-path measurement). Spill (§4.2): when dispatch is
 *  blocked above the 75% watermark, the oldest producer-held lease is written to
 *  a temp file and its charge released. */
export async function runArmB(corpus: CorpusFile[], kek: Buffer, tmpDir: string, workers: number, budgetBytes: number, inflight: number, settleMs: number, maxJobs = 0) {
  const slots: Slot[] = Array.from({ length: workers }, () => {
    const worker = new Worker(new URL("./fused-worker.ts", import.meta.url));
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
    const slot = { worker, busy: 0, pending };
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p.resolve(e.data); } };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); };
    return slot;
  });
  let id = 1;
  const post = (s: Slot, message: any) => new Promise<any>((resolve, reject) => { s.pending.set(message.id, { resolve, reject }); s.worker.postMessage(message); });
  await Promise.all(slots.map(async (s) => { const response = await post(s, { id: id++, kek, tmpDir }); if (!response.ready) throw new Error("worker init failed"); }));

  // Coalesce: fuse-eligible files group under byte/count caps; over-cap files are
  // single-file jobs on the UNCHANGED oracle temp path (design 99 §3) — no budget charge.
  const groups: { files: CorpusFile[]; bytes: number; enqueued: number; oversize?: boolean }[] = [];
  let open: CorpusFile[] = [];
  let bytes = 0;
  const flush = () => { if (open.length) { groups.push({ files: open, bytes, enqueued: 0 }); open = []; bytes = 0; } };
  for (const f of corpus) {
    if (f.size > FUSE_MAX_FILE_BYTES) { flush(); groups.push({ files: [f], bytes: f.size, enqueued: 0, oversize: true }); continue; }
    if (open.length && (open.length >= MAX_JOB_FILES || bytes + f.size > MAX_JOB_BYTES)) flush();
    open.push(f); bytes += f.size;
    if (groups.length === 0 && (bytes >= 64 * 1024 || open.length >= 16)) flush(); // primed first batch
  }
  flush();

  const reserve = MAX_JOB_BYTES + MAX_JOB_FILES * 16 + CLONE_SLACK;
  if (budgetBytes < reserve) throw new Error("budget smaller than one JOB_RESERVE");
  let used = 0, high = 0, heldCount = 0, peakHeldCharges = 0, next = 0, completed = 0, tempBytes = 0, spilledBytes = 0, spilledFiles = 0, spillOrdinal = 0;
  const queueWait: number[] = [], overhead: number[] = [], jobWalls: number[] = [];
  const tempCtPaths: string[] = [];
  const heldLeases: Held[] = []; // producer-held (settling) leases, FIFO — spill candidates
  const waiters: (() => void)[] = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  const release = (n: number) => { used -= n; wake(); };
  const spillOldest = async (): Promise<boolean> => {
    const victim = heldLeases.find((h) => !h.released && h.buf);
    if (!victim) return false;
    victim.released = true; clearTimeout(victim.timer); heldCount--;
    const i = heldLeases.indexOf(victim); if (i >= 0) heldLeases.splice(i, 1);
    const p = path.join(tmpDir, `spill-${spillOrdinal++}`);
    await fs.writeFile(p, Buffer.from(victim.buf!));
    tempCtPaths.push(p);
    spilledBytes += victim.bytes; spilledFiles++; tempBytes += victim.bytes;
    victim.buf = undefined;
    release(victim.bytes);
    return true;
  };
  const acquire = async () => {
    while (used + reserve > budgetBytes) {
      if (used > SPILL_WATERMARK * budgetBytes && (await spillOldest())) continue;
      await new Promise<void>((r) => waiters.push(r));
    }
    used += reserve; high = Math.max(high, used);
  };
  const settle = (cipherSize: number, buf: ArrayBuffer) => {
    // Per-file charge held until simulated settlement (null sink: settleMs = 0
    // releases immediately — the pure §5.3 encrypt-critical-path mode).
    if (settleMs === 0) { release(cipherSize); return; }
    heldCount++; peakHeldCharges = Math.max(peakHeldCharges, heldCount);
    const held: Held = { bytes: cipherSize, buf, released: false, timer: setTimeout(() => {
      heldCount--;
      if (!held.released) { held.released = true; held.buf = undefined; release(cipherSize); }
      const i = heldLeases.indexOf(held); if (i >= 0) heldLeases.splice(i, 1);
    }, settleMs) };
    heldLeases.push(held);
  };
  const idleSlot = () => slots.reduce((best, s) => (s.busy < best.busy ? s : best), slots[0]);
  // Global dispatch cap (maxJobs > 0): bounds concurrently in-flight worker jobs of
  // BOTH kinds — a design-99 dispatch policy candidate motivated by the measured
  // negative scaling of concurrent streaming-zstd jobs on this host.
  let jobsInFlight = 0;
  const jobWaiters: (() => void)[] = [];
  const jobSlotAcquire = async () => { if (maxJobs <= 0) return; while (jobsInFlight >= maxJobs) await new Promise<void>((r) => jobWaiters.push(r)); jobsInFlight++; };
  const jobSlotRelease = () => { if (maxJobs <= 0) return; jobsInFlight--; const w = jobWaiters.shift(); if (w) w(); };
  const start = performance.now();
  for (const g of groups) g.enqueued = start;
  async function runner() {
    while (next < groups.length) {
      const group = groups[next++];
      if (!group.oversize) await acquire();
      await jobSlotAcquire();
      queueWait.push(performance.now() - group.enqueued);
      const jid = id++;
      const slot = idleSlot(); slot.busy++;
      const msg: any = await post(slot, { id: jid, jobs: group.files.map((f) => ({ index: f.index, srcPath: f.absPath, expected: f.expected, oversize: group.oversize })), jobPlaintextCap: Math.max(MAX_JOB_BYTES, group.bytes) });
      slot.busy--; jobSlotRelease();
      if (msg.fatal) throw new Error(msg.fatal);
      const ok = msg.results.filter((r: any) => r.ok);
      if (ok.length + msg.results.filter((r: any) => r.requeue).length !== msg.results.length) throw new Error("fused worker file failure");
      if (group.oversize) {
        for (const r of ok) { tempBytes += r.plaintextSize + r.cipherSize; tempCtPaths.push(r.ciphertextPath); completed++; }
      } else {
        // §6.1 receipt validation: transfer present, byteLength === cipherSize, then
        // atomically convert JOB_RESERVE to exact per-file charges (release the slack).
        const exact = ok.reduce((n: number, r: any) => n + r.cipherSize, 0);
        for (const r of ok) {
          if (!(r.ct instanceof ArrayBuffer)) throw new Error("ciphertext transfer missing");
          if (r.ct.byteLength !== r.cipherSize) throw new Error("cipherSize/byteLength mismatch (design 99 s6.1)");
        }
        used -= reserve - exact; wake(); high = Math.max(high, used);
        for (const r of ok) { settle(r.cipherSize, r.ct); completed++; }
      }
      jobWalls.push(msg.jobWallMs);
      overhead.push(msg.jobWallMs - msg.payloadCryptoMs);
      for (const r of msg.results.filter((x: any) => x.requeue)) groups.push({ files: [corpus[r.index]], bytes: corpus[r.index].size, enqueued: performance.now() });
    }
  }
  await Promise.all(Array.from({ length: workers * Math.max(1, inflight) }, () => runner()));
  while (heldLeases.length > 0 || heldCount > 0) await new Promise((r) => setTimeout(r, 1)); // drain settling leases
  const wallMs = performance.now() - start;
  for (const s of slots) s.worker.terminate();
  await Promise.all(tempCtPaths.map((p) => fs.rm(p, { force: true }))); // cleanup excluded from wall, same as Arm A
  if (completed !== corpus.length) throw new Error(`completion mismatch ${completed}/${corpus.length}`);
  const plaintextBytes = corpus.reduce((n, f) => n + f.size, 0);
  return {
    arm: "B", wallMs,
    queueWaitP50Ms: quantile(queueWait, 0.5), queueWaitP99Ms: quantile(queueWait, 0.99),
    messageCount: groups.length, jobCount: groups.length,
    jobOverheadP50Ms: quantile(overhead, 0.5), jobWallP50Ms: quantile(jobWalls, 0.5),
    tempBytesWritten: tempBytes, budgetHighWaterBytes: high, peakHeldCharges,
    spilledBytes, spilledFiles,
    filesPerSecond: corpus.length / (wallMs / 1000),
    plaintextMiBPerSecond: plaintextBytes / 1048576 / (wallMs / 1000),
  };
}
