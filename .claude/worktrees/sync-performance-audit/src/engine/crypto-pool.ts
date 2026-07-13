import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setCryptoPoolSelectorForProcess, type DecryptFileOptions, type EncryptedBlob, type EncryptFileOptions } from "./crypto.js";
import type {
  CryptoWorkerJobMessage as WorkerMessage,
  CryptoWorkerResponse as WorkerResponse,
  SerializedError,
} from "./crypto-worker-protocol.js";

type BunWorker = {
  postMessage(message: unknown): void;
  terminate(): void | Promise<void>;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: { message?: string; error?: unknown }) => void) | null;
  addEventListener?: (type: "close" | "error" | "messageerror", listener: (event: unknown) => void) => void;
};

declare const Worker: { new (specifier: string | URL): BunWorker };

const MAX_IN_FLIGHT_PER_WORKER = 2;
const QUEUE_PER_WORKER = 4;
const IDLE_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;
const WORKER_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_WORKERS = 16;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type CryptoPoolStatus =
  | { state: "active" | "idle"; workers: number; jobsRun: number; workerExecutions: number }
  | { state: "disabled"; reason: string; workers: number; jobsRun: number; workerExecutions: number }
  | { state: "off"; reason?: string; workers: number; jobsRun: number; workerExecutions: number };

type JobRecord<T = unknown> = {
  message: WorkerMessage;
  attempts: number;
  health?: boolean;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

type QueueWaiter = { resolve: () => void; reject: (err: unknown) => void };

let activePool: CryptoPool | undefined;
let disabledReason: string | undefined;
let jobsRunTotal = 0;
let workerExecutionsTotal = 0;
let configuredWorkersCache: { count: number; offReason?: string } | undefined;
let embeddedWorkerPath: string | undefined;
let embeddedWorkerDir: string | undefined;
let cleanupRegistered = false;
let workerPathOverrideForTests: string | undefined;

const poolScope = new AsyncLocalStorage<CryptoPool | undefined>();

export function kekFingerprint(kek: Buffer): string {
  return createHash("sha256").update(kek).digest("hex");
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function minJobs(): number {
  const env = parsePositiveIntEnv("RBOX_CRYPTO_POOL_MIN_JOBS");
  return env !== undefined && env > 0 ? env : 8;
}

function configuredWorkers(): { count: number; offReason?: string } {
  if (configuredWorkersCache) return configuredWorkersCache;
  const override = parsePositiveIntEnv("RBOX_CRYPTO_WORKERS");
  if (override === 0) {
    configuredWorkersCache = { count: 0, offReason: "RBOX_CRYPTO_WORKERS=0" };
    return configuredWorkersCache;
  }
  const parallelism = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const base = override ?? Math.min(Math.max(parallelism - 2, 2), MAX_WORKERS);
  let count = Math.max(1, Math.min(base, MAX_WORKERS));

  const memoryCap = Math.max(1, Math.floor(os.totalmem() / WORKER_MEMORY_BYTES));
  count = Math.min(count, memoryCap);

  const fdCap = fileDescriptorWorkerCap();
  if (fdCap !== undefined && count > fdCap) {
    console.warn(`rbox: crypto worker count reduced from ${count} to ${fdCap} due to RLIMIT_NOFILE headroom`);
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

function isCompiledRuntime(): boolean {
  return import.meta.url.includes("$bunfs");
}

async function cleanupEmbeddedWorker(): Promise<void> {
  const dir = embeddedWorkerDir;
  embeddedWorkerPath = undefined;
  embeddedWorkerDir = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function embeddedWorkerFile(): Promise<string> {
  if (embeddedWorkerPath) return embeddedWorkerPath;
  const mod = (await import("./generated/crypto-worker.bundle.js", { with: { type: "text" } })) as { default: string };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-worker-"));
  await fs.chmod(dir, 0o700).catch(() => {});
  const file = path.join(dir, "crypto-worker.bundle.js");
  const fh = await fs.open(file, "wx", 0o600);
  try {
    await fh.writeFile(mod.default);
  } finally {
    await fh.close();
  }
  await fs.chmod(file, 0o600).catch(() => {});
  embeddedWorkerDir = dir;
  embeddedWorkerPath = file;
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      if (embeddedWorkerDir) fsSync.rmSync(embeddedWorkerDir, { recursive: true, force: true });
    });
  }
  return file;
}

async function workerSpecifier(): Promise<string> {
  if (workerPathOverrideForTests) return workerPathOverrideForTests;
  if (!isCompiledRuntime()) return path.join(MODULE_DIR, "crypto-worker.ts");
  return embeddedWorkerFile();
}

function rehydrateError(error: SerializedError): Error {
  const out = new Error(error.message);
  out.name = error.name || "Error";
  for (const key of ["code", "errno", "syscall", "path", "dest"] as const) {
    if (error[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = error[key];
  }
  if (error.cause) (out as unknown as { cause?: Error }).cause = rehydrateError(error.cause);
  if (error.stack) {
    out.stack = out.stack ? `${out.stack}\n--- worker stack ---\n${error.stack}` : error.stack;
  }
  return out;
}

function workerCrashError(reason: string): Error {
  const err = new Error(`crypto worker crashed: ${reason}`);
  err.name = "CryptoWorkerCrashError";
  (err as NodeJS.ErrnoException).code = "RBOX_CRYPTO_WORKER_CRASH";
  return err;
}

function closeError(): Error {
  const err = new Error("crypto worker pool closed");
  err.name = "CryptoWorkerPoolClosedError";
  (err as NodeJS.ErrnoException).code = "RBOX_CRYPTO_POOL_CLOSED";
  return err;
}

class CryptoWorkerSlot {
  readonly inFlight = new Map<number, JobRecord>();
  closing = false;
  crashed = false;

  constructor(readonly pool: CryptoPool, readonly worker: BunWorker) {
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.handleCrash(event.message ?? "worker error");
    worker.addEventListener?.("error", (event) => this.handleCrash((event as { message?: string }).message ?? "worker error"));
    worker.addEventListener?.("close", () => {
      if (!this.closing) this.handleCrash("worker closed");
    });
    worker.addEventListener?.("messageerror", () => this.handleCrash("worker messageerror"));
  }

  get available(): boolean {
    return !this.closing && !this.crashed && this.inFlight.size < MAX_IN_FLIGHT_PER_WORKER;
  }

  post(record: JobRecord): void {
    this.inFlight.set(record.message.id, record);
    this.worker.postMessage(record.message);
    if (!record.health) jobsRunTotal++;
  }

  async init(kek: Buffer): Promise<void> {
    this.worker.postMessage({ kek });
    await this.healthCheck();
  }

  healthCheck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.pool.nextId();
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        reject(new Error("crypto worker health check timed out"));
      }, HEALTH_TIMEOUT_MS);
      const record: JobRecord = {
        message: { id, kind: "health" },
        attempts: 0,
        health: true,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.post(record);
    });
  }

  terminateIntentional(): void {
    this.closing = true;
    void this.worker.terminate();
  }

  private handleMessage(msg: WorkerResponse): void {
    const record = this.inFlight.get(msg.id);
    if (!record) return;
    this.inFlight.delete(msg.id);
    if (!record.health) {
      workerExecutionsTotal++;
    }
    if (msg.ok) record.resolve(msg.result);
    else record.reject(rehydrateError(msg.error));
    this.pool.afterWorkerSlotFreed();
  }

  private handleCrash(reason: string): void {
    if (this.crashed || this.closing) return;
    this.crashed = true;
    this.pool.handleWorkerCrash(this, reason);
  }
}

export class CryptoPool {
  readonly queueLimit: number;
  readonly queue: JobRecord[] = [];
  readonly workers: CryptoWorkerSlot[] = [];
  readonly queueWaiters: QueueWaiter[] = [];
  closed = false;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  id = 1;

  constructor(
    readonly kek: Buffer,
    readonly fingerprint: string,
    readonly keyEpoch: number,
    readonly targetWorkers: number
  ) {
    this.queueLimit = targetWorkers * QUEUE_PER_WORKER;
  }

  matches(fingerprint: string, keyEpoch: number): boolean {
    return !this.closed && this.fingerprint === fingerprint && this.keyEpoch === keyEpoch && this.workers.length > 0;
  }

  nextId(): number {
    return this.id++;
  }

  async start(): Promise<void> {
    const first = await this.spawnWorker();
    this.workers.push(first);
    const restResults = await Promise.allSettled(Array.from({ length: Math.max(0, this.targetWorkers - 1) }, () => this.spawnWorker()));
    const rest: CryptoWorkerSlot[] = [];
    for (const result of restResults) {
      if (result.status === "fulfilled") {
        rest.push(result.value);
      } else {
        console.warn(
          `rbox: crypto worker spawn failed; continuing with ${this.workers.length + restResults.filter((r) => r.status === "fulfilled").length} worker(s): ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`
        );
      }
    }
    this.workers.push(...rest);
    this.armIdleTimer();
  }

  encrypt(srcPath: string, tmpDir?: string, opts: EncryptFileOptions = {}): Promise<EncryptedBlob> {
    return this.run<EncryptedBlob>({ id: this.nextId(), kind: "encrypt", srcPath, tmpDir, opts });
  }

  decrypt(ctPath: string, plaintextSha: string, destPath: string, opts: DecryptFileOptions = {}): Promise<void> {
    return this.run<void>({ id: this.nextId(), kind: "decrypt", ctPath, plaintextSha, destPath, opts });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const err = closeError();
    for (const waiter of this.queueWaiters.splice(0)) waiter.reject(err);
    for (const record of this.queue.splice(0)) record.reject(err);
    for (const worker of this.workers.splice(0)) {
      worker.terminateIntentional();
      for (const record of worker.inFlight.values()) record.reject(err);
      worker.inFlight.clear();
    }
    this.signalQueueSpace();
    if (activePool === this) {
      activePool = undefined;
    }
    await cleanupEmbeddedWorker();
  }

  afterWorkerSlotFreed(): void {
    this.dispatch();
    this.signalQueueSpace();
    this.armIdleTimer();
  }

  handleWorkerCrash(slot: CryptoWorkerSlot, reason: string): void {
    const idx = this.workers.indexOf(slot);
    const wasRegistered = idx >= 0;
    if (wasRegistered) this.workers.splice(idx, 1);
    const crash = workerCrashError(reason);
    for (const record of slot.inFlight.values()) {
      slot.inFlight.delete(record.message.id);
      if (record.health || record.attempts >= 1 || this.closed) {
        record.reject(crash);
      } else {
        record.attempts++;
        this.queue.unshift(record);
      }
    }
    // A slot can fail its health check before spawnWorker() registers it.
    // Its caller owns that startup failure; starting a replacement here would
    // leave an untracked task that can mutate module state after a test reset.
    if (!this.closed && wasRegistered) {
      void this.spawnReplacement();
      this.dispatch();
    }
    this.signalQueueSpace();
  }

  terminateBusiestWorkerForTest(): boolean {
    const worker = [...this.workers].sort((a, b) => b.inFlight.size - a.inFlight.size)[0];
    if (!worker || worker.inFlight.size === 0) return false;
    void worker.worker.terminate();
    return true;
  }

  statsForTest(): { workers: number; inFlight: number; queue: number } {
    return {
      workers: this.workers.length,
      inFlight: this.workers.reduce((n, w) => n + w.inFlight.size, 0),
      queue: this.queue.length,
    };
  }

  private run<T>(message: WorkerMessage): Promise<T> {
    if (this.closed) throw closeError();
    this.clearIdleTimer();
    return new Promise<T>((resolve, reject) => {
      const record: JobRecord = { message, attempts: 0, resolve: (value) => resolve(value as T), reject };
      void this.enqueue(record);
    });
  }

  private async enqueue(record: JobRecord): Promise<void> {
    try {
      while (!this.closed && !this.availableWorker() && this.queue.length >= this.queueLimit) {
        await this.waitForQueueSpace();
      }
      if (this.closed) {
        record.reject(closeError());
        return;
      }
      const worker = this.availableWorker();
      if (worker) worker.post(record);
      else this.queue.push(record);
      this.dispatch();
    } catch (err) {
      record.reject(err);
    }
  }

  private dispatch(): void {
    if (this.closed) return;
    let worker = this.availableWorker();
    while (worker && this.queue.length > 0) {
      const record = this.queue.shift()!;
      this.signalQueueSpace();
      worker.post(record);
      worker = this.availableWorker();
    }
  }

  private availableWorker(): CryptoWorkerSlot | undefined {
    let best: CryptoWorkerSlot | undefined;
    for (const worker of this.workers) {
      if (!worker.available) continue;
      if (!best || worker.inFlight.size < best.inFlight.size) best = worker;
    }
    return best;
  }

  private async spawnWorker(): Promise<CryptoWorkerSlot> {
    const specifier = await workerSpecifier();
    const slot = new CryptoWorkerSlot(this, new Worker(specifier));
    try {
      await slot.init(this.kek);
    } catch (err) {
      slot.terminateIntentional();
      throw err;
    }
    return slot;
  }

  private async spawnReplacement(): Promise<void> {
    if (this.closed) return;
    try {
      const slot = await this.spawnWorker();
      if (this.closed) {
        slot.terminateIntentional();
        return;
      }
      this.workers.push(slot);
      this.dispatch();
      this.signalQueueSpace();
    } catch (err) {
      // The pool may have been reset while a replacement was starting. Stale
      // replacement work must not re-disable worker selection after reset.
      if (this.closed) return;
      disabledReason = `crypto worker replacement failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.close();
    }
  }

  private waitForQueueSpace(): Promise<void> {
    return new Promise((resolve, reject) => this.queueWaiters.push({ resolve, reject }));
  }

  private signalQueueSpace(): void {
    for (const waiter of this.queueWaiters.splice(0)) waiter.resolve();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    if (this.closed) return;
    if (this.queue.length > 0 || this.workers.some((worker) => worker.inFlight.size > 0)) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }
}

async function selectCryptoPool(kek: Buffer, keyEpoch: number, expectedJobs: number): Promise<CryptoPool | undefined> {
  if (expectedJobs <= 0 || expectedJobs < minJobs()) return undefined;
  if (disabledReason) return undefined;
  const configured = configuredWorkers();
  if (configured.count === 0) return undefined;

  const fingerprint = kekFingerprint(kek);
  if (activePool?.matches(fingerprint, keyEpoch)) return activePool;
  if (activePool) await activePool.close();

  const pool = new CryptoPool(Buffer.from(kek), fingerprint, keyEpoch, configured.count);
  try {
    await pool.start();
  } catch (err) {
    disabledReason = err instanceof Error ? err.message : String(err);
    await pool.close().catch(() => {});
    return undefined;
  }
  activePool = pool;
  return pool;
}

export async function withCryptoPool<T>(
  kek: Buffer | undefined,
  keyEpoch: number | undefined,
  expectedJobs: number,
  fn: (pool: CryptoPool | undefined) => Promise<T>
): Promise<T> {
  const pool = kek && keyEpoch !== undefined ? await selectCryptoPool(kek, keyEpoch, expectedJobs) : undefined;
  return poolScope.run(pool, () => fn(pool));
}

export function currentCryptoPoolForKek(kek: Buffer): CryptoPool | undefined {
  const pool = poolScope.getStore();
  if (!pool || pool.closed) return undefined;
  return pool.kek.equals(kek) ? pool : undefined;
}

setCryptoPoolSelectorForProcess(currentCryptoPoolForKek);

export function cryptoPoolStatus(): CryptoPoolStatus {
  if (disabledReason) {
    return { state: "disabled", reason: disabledReason, workers: 0, jobsRun: jobsRunTotal, workerExecutions: workerExecutionsTotal };
  }
  const configured = configuredWorkers();
  if (configured.count === 0) {
    return { state: "off", reason: configured.offReason, workers: 0, jobsRun: jobsRunTotal, workerExecutions: workerExecutionsTotal };
  }
  if (activePool && !activePool.closed && activePool.workers.length > 0) {
    return {
      state: "active",
      workers: activePool.workers.length,
      jobsRun: jobsRunTotal,
      workerExecutions: workerExecutionsTotal,
    };
  }
  return { state: "idle", workers: 0, jobsRun: jobsRunTotal, workerExecutions: workerExecutionsTotal };
}

export const __cryptoPoolTestHooks = {
  async reset(): Promise<void> {
    if (activePool) await activePool.close().catch(() => {});
    activePool = undefined;
    disabledReason = undefined;
    jobsRunTotal = 0;
    workerExecutionsTotal = 0;
    configuredWorkersCache = undefined;
    workerPathOverrideForTests = undefined;
    await cleanupEmbeddedWorker();
  },
  setWorkerPath(pathname: string | undefined): void {
    workerPathOverrideForTests = pathname;
  },
  terminateBusiestWorker(): boolean {
    return activePool?.terminateBusiestWorkerForTest() ?? false;
  },
  stats(): { workers: number; inFlight: number; queue: number } {
    return activePool?.statsForTest() ?? { workers: 0, inFlight: 0, queue: 0 };
  },
  async waitForStats(predicate: (stats: { workers: number; inFlight: number; queue: number }) => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(this.stats())) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for crypto pool stats; last=${JSON.stringify(this.stats())}`);
  },
};
