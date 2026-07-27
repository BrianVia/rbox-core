import { spawnSync } from "node:child_process";
import os from "node:os";

export const MAX_IN_FLIGHT_PER_WORKER = 2;
export const QUEUE_PER_WORKER = 4;
export const IDLE_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 2_000;
const WORKER_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_WORKERS = 16;

export const FUSE_MAX_JOB_BYTES = 4 * 1024 * 1024;
export const FUSE_MAX_JOB_FILES = 512;
const CLONE_SLACK = 64 * 1024;
export const JOB_RESERVE = FUSE_MAX_JOB_BYTES + FUSE_MAX_JOB_FILES * 16 + CLONE_SLACK;
export const CIPHERTEXT_BUDGET_BYTES = 96 * 1024 * 1024;
export const SPILL_WATERMARK_FRAC = 0.75;
export const FUSE_FLUSH_DELAY_MS = 10;
export const FUSE_PRIMED_FIRST_BYTES = 64 * 1024;
export const FUSE_PRIMED_FIRST_FILES = 16;
export const FUSE_MAX_ENCRYPT_RETRIES = 3;
// Phase-0 found that streaming-zstd scales negatively at high concurrency (16
// workers were 5–6x slower than 4). This global cap recovered the measured win.
const FUSE_DISPATCH_BOUND_DEFAULT = 4;

let configuredWorkersCache: { count: number; offReason?: string } | undefined;

export function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function fusedDispatchBound(): number {
  return Math.max(1, parsePositiveIntEnv("RBOX_CRYPTO_FUSE_DISPATCH") ?? FUSE_DISPATCH_BOUND_DEFAULT);
}

export function minJobs(): number {
  const env = parsePositiveIntEnv("RBOX_CRYPTO_POOL_MIN_JOBS");
  return env !== undefined && env > 0 ? env : 8;
}

export function configuredWorkers(warningSink: (line: string) => void = console.warn): { count: number; offReason?: string } {
  if (configuredWorkersCache) return configuredWorkersCache;
  const override = parsePositiveIntEnv("RBOX_CRYPTO_WORKERS");
  if (override === 0) {
    configuredWorkersCache = { count: 0, offReason: "RBOX_CRYPTO_WORKERS=0" };
    return configuredWorkersCache;
  }
  const parallelism = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  // 4 workers, cross-architecture constant (2026-07-27 fleet sweep, issue #508):
  // the encrypt lane is memory-bandwidth/VFS-bound, not compute-bound — the
  // knee was 4 on 12/12 sweeps across Zen3 16C, Zen3 8C, and M2 Max, and the
  // old cores-derived default (parallelism-2 → 10-30 workers) ran 1.7-7x
  // SLOWER than 4, below one serial core at the top end. Core count does not
  // predict the knee; do not restore a formula without new sweep evidence.
  const base = override ?? Math.min(4, Math.max(parallelism, 1));
  let count = Math.max(1, Math.min(base, MAX_WORKERS));

  const memoryCap = Math.max(1, Math.floor(os.totalmem() / WORKER_MEMORY_BYTES));
  count = Math.min(count, memoryCap);

  const fdCap = fileDescriptorWorkerCap();
  if (fdCap !== undefined && count > fdCap) {
    warningSink(`rbox: crypto worker count reduced from ${count} to ${fdCap} due to RLIMIT_NOFILE headroom`);
    count = fdCap;
  }
  configuredWorkersCache = { count: Math.max(0, count) };
  return configuredWorkersCache;
}

function fileDescriptorWorkerCap(): number | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  try {
    const res = spawnSync("sh", ["-c", "ulimit -n"], { encoding: "utf8" });
    if (res.status !== 0) return undefined;
    const limit = Number(res.stdout.trim());
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
    const reserve = 128;
    const fdsPerWorker = 32;
    return Math.max(1, Math.floor((limit - reserve) / fdsPerWorker));
  } catch {
    return undefined;
  }
}

export function resetConfiguredWorkersCacheForTests(): void {
  configuredWorkersCache = undefined;
}
