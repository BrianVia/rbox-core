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
  CryptoWorkerEncryptBatchResult,
  FusedResult,
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

const FUSE_MAX_FILE_BYTES = 256 * 1024;
const FUSE_MAX_JOB_BYTES = 4 * 1024 * 1024;
const FUSE_MAX_JOB_FILES = 512;
const CLONE_SLACK = 64 * 1024;
const JOB_RESERVE = FUSE_MAX_JOB_BYTES + FUSE_MAX_JOB_FILES * 16 + CLONE_SLACK;
const CIPHERTEXT_BUDGET_BYTES = 96 * 1024 * 1024;
const SPILL_WATERMARK_FRAC = 0.75;
const FUSE_FLUSH_DELAY_MS = 10;
const FUSE_PRIMED_FIRST_BYTES = 64 * 1024;
const FUSE_PRIMED_FIRST_FILES = 16;
const FUSE_MAX_ENCRYPT_RETRIES = 3;
// Phase-0 found that streaming-zstd scales negatively at high concurrency (16
// workers were 5–6x slower than 4). This global cap recovered the measured win.
const FUSE_DISPATCH_BOUND_DEFAULT = 4;

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
  fused?: boolean;
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
let requeueStatOverrideForTests: typeof fs.stat | undefined;

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

function fusedDispatchBound(): number {
  return Math.max(1, parsePositiveIntEnv("RBOX_CRYPTO_FUSE_DISPATCH") ?? FUSE_DISPATCH_BOUND_DEFAULT);
}

export type CiphertextLocation = { kind: "memory"; bytes: Uint8Array } | { kind: "file"; path: string };
export interface CiphertextLease {
  readonly encSha: string;
  readonly size: number;
  readonly location: CiphertextLocation;
  release(): void;
}
export type CoalescedBlob = {
  plaintextSha: string; encSha: string; cipherSize: number; comp?: "zstd"; payloadSha?: string;
  lease: CiphertextLease;
};

class CiphertextBudget {
  used = 0;
  highWater = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(readonly cap: number) {}
  tryReserve(n: number): boolean {
    if (this.used + n > this.cap) return false;
    this.used += n;
    this.highWater = Math.max(this.highWater, this.used);
    return true;
  }
  wait(): Promise<void> { return new Promise((resolve) => this.waiters.push(resolve)); }
  convert(reserved: number, exactCharges: number[]): void {
    const exact = exactCharges.reduce((n, x) => n + x, 0);
    if (exact > reserved) throw new Error("fused ciphertext exceeds job reserve");
    this.used -= reserved - exact;
    this.wake();
  }
  release(n: number): void {
    this.used -= n;
    if (this.used < 0) throw new Error("ciphertext budget released below zero");
    this.wake();
  }
  wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }
}

type PendingFile = {
  srcPath: string; size: number; tmpDir: string; opts: EncryptFileOptions;
  expected: { sha256: string; size: number }; attempts: number;
  deliver: (blob: CoalescedBlob) => void | Promise<void>; reject: (err: unknown) => void;
  owner?: symbol;
};
type FusedJob = { files: PendingFile[]; reserved: boolean; posted: boolean };
type ProducerResult = { file: PendingFile; blob: CoalescedBlob; bytes: Uint8Array; charge: number; delivered: boolean };

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

  async terminateIntentional(): Promise<void> {
    this.closing = true;
    await this.worker.terminate();
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
  private openGroup: PendingFile[] = [];
  private openBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private groupsFlushed = 0;
  private readonly fusedQueue: FusedJob[] = [];
  private fusedInFlight = 0;
  private fusedPumping = false;
  private fusionDisabled = false;
  private readonly canceledOwners = new Set<symbol>();
  private readonly activeFusedJobs = new Set<FusedJob>();
  private readonly budget = new CiphertextBudget(Math.max(JOB_RESERVE, parsePositiveIntEnv("RBOX_CRYPTO_FUSE_BUDGET_BYTES") ?? CIPHERTEXT_BUDGET_BYTES));
  private readonly producerResults: ProducerResult[] = [];
  private spillDir: string | undefined;
  private spillOrdinal = 0;
  private spilledFiles = 0;
  private spilledBytes = 0;
  private deliveryTail: Promise<void> = Promise.resolve();

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

  encryptCoalesced(srcPath: string, size: number, tmpDir: string, opts: EncryptFileOptions): Promise<CoalescedBlob> {
    if (this.closed) throw closeError();
    if (size > FUSE_MAX_FILE_BYTES || this.fusionDisabled) return this.encryptFileBacked(srcPath, tmpDir, opts);
    if (!opts.expected) throw new Error("fused encryption requires expected source metadata");
    return new Promise((resolve, reject) => {
      this.addPending({ srcPath, size, tmpDir, opts, expected: opts.expected!, attempts: 0, deliver: resolve, reject });
    });
  }

  encryptStream<T>(
    items: { ref: T; srcPath: string; size: number; opts: EncryptFileOptions; tmpDir?: string }[],
    handlers: { onReady: (ref: T, blob: CoalescedBlob) => void | Promise<void> }
  ): { cancel(): void } {
    let cancelled = false;
    const owner = Symbol("crypto-stream");
    const err = Object.assign(new Error("crypto stream cancelled"), { code: "RBOX_CRYPTO_STREAM_CANCELLED" });
    for (const item of items) {
      const expected = item.opts.expected;
      if (!expected) throw new Error("fused encryption requires expected source metadata");
      const pending: PendingFile = {
        srcPath: item.srcPath, size: item.size, tmpDir: item.tmpDir ?? os.tmpdir(), opts: item.opts,
        expected, attempts: 0,
        owner,
        deliver: async (blob) => { if (!cancelled) await handlers.onReady(item.ref, blob); else blob.lease.release(); },
        reject: () => {},
      };
      if (item.size > FUSE_MAX_FILE_BYTES || this.fusionDisabled) {
        void this.encryptFileBacked(item.srcPath, pending.tmpDir, item.opts).then(pending.deliver, pending.reject);
      } else this.addPending(pending);
    }
    return { cancel: () => {
      cancelled = true;
      this.canceledOwners.add(owner);
      this.cancelUndispatched(err, owner);
      this.maybeForgetCanceledOwner(owner);
    } };
  }

  fusedStatsForTest(): { used: number; highWater: number; spilledFiles: number; spilledBytes: number } {
    return { used: this.budget.used, highWater: this.budget.highWater, spilledFiles: this.spilledFiles, spilledBytes: this.spilledBytes };
  }

  spillDirForTest(): string | undefined {
    return this.spillDir;
  }

  private async encryptFileBacked(srcPath: string, tmpDir: string, opts: EncryptFileOptions): Promise<CoalescedBlob> {
    const blob = await this.encrypt(srcPath, tmpDir, opts);
    return { ...blob, lease: this.fileLease(blob.encSha, blob.cipherSize, blob.ciphertextPath) };
  }

  private fileLease(encSha: string, size: number, pathname: string): CiphertextLease {
    let released = false;
    return { encSha, size, location: { kind: "file", path: pathname }, release: () => {
      if (released && process.env.NODE_ENV !== "production") throw new Error("ciphertext lease released twice");
      released = true;
    } };
  }

  private memoryLease(encSha: string, bytes: Uint8Array, charge: number): CiphertextLease {
    let released = false;
    return { encSha, size: charge, location: { kind: "memory", bytes }, release: () => {
      if (released) {
        if (process.env.NODE_ENV !== "production") throw new Error("ciphertext lease released twice");
        return;
      }
      released = true;
      this.budget.release(charge);
      void this.pumpFused();
    } };
  }

  private addPending(file: PendingFile): void {
    this.clearIdleTimer();
    if (this.openGroup.length && (this.openGroup.length >= FUSE_MAX_JOB_FILES || this.openBytes + file.size > FUSE_MAX_JOB_BYTES)) this.flushOpenGroup();
    this.openGroup.push(file);
    this.openBytes += file.size;
    if ((this.groupsFlushed === 0 && (this.openBytes >= FUSE_PRIMED_FIRST_BYTES || this.openGroup.length >= FUSE_PRIMED_FIRST_FILES)) ||
        this.openBytes >= FUSE_MAX_JOB_BYTES || this.openGroup.length >= FUSE_MAX_JOB_FILES) this.flushOpenGroup();
    else {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flushOpenGroup(), FUSE_FLUSH_DELAY_MS);
    }
  }

  private flushOpenGroup(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.openGroup.length === 0 || this.closed) return;
    this.fusedQueue.push({ files: this.openGroup, reserved: false, posted: false });
    this.openGroup = [];
    this.openBytes = 0;
    this.groupsFlushed++;
    void this.pumpFused();
  }

  private availableFusedWorker(): CryptoWorkerSlot | undefined {
    return this.workers.filter((w) => w.available && ![...w.inFlight.values()].some((r) => r.fused)).sort((a, b) => a.inFlight.size - b.inFlight.size)[0];
  }

  private async reserveJob(): Promise<boolean> {
    while (!this.closed && !this.budget.tryReserve(JOB_RESERVE)) {
      if (this.budget.used > this.budget.cap * SPILL_WATERMARK_FRAC && await this.spillOldest()) continue;
      await this.budget.wait();
    }
    return !this.closed;
  }

  private async pumpFused(): Promise<void> {
    if (this.fusedPumping || this.closed) return;
    this.fusedPumping = true;
    try {
      while (!this.closed && this.fusedQueue.length && this.fusedInFlight < fusedDispatchBound()) {
        if (!await this.reserveJob()) break;
        const worker = this.availableFusedWorker();
        if (this.closed || this.fusedQueue.length === 0 || this.fusedInFlight >= fusedDispatchBound() || !worker) {
          this.budget.release(JOB_RESERVE);
          break;
        }
        const job = this.fusedQueue.shift()!;
        job.reserved = true; job.posted = true; this.fusedInFlight++;
        this.activeFusedJobs.add(job);
        for (const file of job.files) file.attempts++;
        const record: JobRecord = {
          message: { id: this.nextId(), kind: "encryptBatch", jobPlaintextCap: FUSE_MAX_JOB_BYTES,
            jobs: job.files.map((f, index) => ({ index, srcPath: f.srcPath, expected: f.expected, opts: { ...f.opts, expected: undefined } })) },
          attempts: 0, fused: true,
          resolve: (value) => void this.handleFusedResult(job, value),
          reject: (err) => void this.handleFusedCrash(job, err),
        };
        worker.post(record);
      }
    } finally { this.fusedPumping = false; }
  }

  private validFusedResults(value: unknown, job: FusedJob): FusedResult[] | undefined {
    if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray((value as CryptoWorkerEncryptBatchResult).results)) return undefined;
    const results = (value as CryptoWorkerEncryptBatchResult).results;
    if (results.length !== job.files.length) return undefined;
    const seen = new Set<number>();
    const buffers = new Set<ArrayBuffer>();
    let total = 0;
    for (const result of results) {
      if (!result || typeof result.index !== "number" || !Number.isInteger(result.index) || result.index < 0 || result.index >= job.files.length || seen.has(result.index)) return undefined;
      seen.add(result.index);
      if (result.ok) {
        const blob = result.blob;
        if (!blob || !(blob.ciphertext instanceof ArrayBuffer) || blob.ciphertext.byteLength !== blob.cipherSize || buffers.has(blob.ciphertext)) return undefined;
        if (!Number.isSafeInteger(blob.cipherSize) || blob.cipherSize < 0 || typeof blob.plaintextSha !== "string" || typeof blob.encSha !== "string") return undefined;
        if (blob.plaintextSha !== job.files[result.index]!.expected.sha256) return undefined;
        buffers.add(blob.ciphertext); total += blob.cipherSize;
      } else {
        const requeue = "requeue" in result && result.requeue === true && !("error" in result);
        const error = "error" in result && !("requeue" in result) && typeof result.error === "object" && result.error !== null && typeof result.error.message === "string";
        if (!requeue && !error) return undefined;
      }
    }
    return total <= JOB_RESERVE ? results : undefined;
  }

  private async handleFusedResult(job: FusedJob, value: unknown): Promise<void> {
    this.fusedInFlight--;
    if (this.closed) {
      if (job.reserved) { job.reserved = false; this.budget.release(JOB_RESERVE); }
      for (const file of job.files) file.reject(closeError());
      this.activeFusedJobs.delete(job);
      return;
    }
    const results = this.validFusedResults(value, job);
    if (!results) {
      // Design 99 §6.1 step 0 / §6.3: discard transferred bytes before releasing
      // the job reserve, so retry children cannot re-reserve while bytes remain live.
      if (value && typeof value === "object" && "results" in value && Array.isArray(value.results)) {
        for (const raw of value.results) {
          if (!raw || typeof raw !== "object") continue;
          if ("blob" in raw) {
            const blob = raw.blob;
            if (blob && typeof blob === "object" && "ciphertext" in blob) blob.ciphertext = null;
            raw.blob = null;
          }
          if ("ciphertext" in raw) raw.ciphertext = null;
        }
      }
      await this.handleFusedCrash(job, new Error("malformed fused worker response"), false);
      return;
    }
    const charges = results.filter((r): r is Extract<FusedResult, { ok: true }> => r.ok).map((r) => r.blob.cipherSize);
    this.budget.convert(JOB_RESERVE, charges); job.reserved = false;
    for (const result of results) {
      const file = job.files[result.index]!;
      const canceled = file.owner !== undefined && this.canceledOwners.has(file.owner);
      if (result.ok) {
        const bytes = new Uint8Array(result.blob.ciphertext);
        const lease = this.memoryLease(result.blob.encSha, bytes, result.blob.cipherSize);
        if (canceled) {
          lease.release();
          file.reject(Object.assign(new Error("crypto stream cancelled"), { code: "RBOX_CRYPTO_STREAM_CANCELLED" }));
          continue;
        }
        const blob: CoalescedBlob = { plaintextSha: result.blob.plaintextSha, encSha: result.blob.encSha, cipherSize: result.blob.cipherSize,
          comp: result.blob.comp, payloadSha: result.blob.payloadSha, lease };
        const held: ProducerResult = { file, blob, bytes, charge: result.blob.cipherSize, delivered: false };
        this.producerResults.push(held);
        this.deliveryTail = this.deliveryTail.then(() => this.deliverProducer(held));
      } else if (canceled) {
        file.reject(Object.assign(new Error("crypto stream cancelled"), { code: "RBOX_CRYPTO_STREAM_CANCELLED" }));
      } else if ("requeue" in result) {
        const actual = await (requeueStatOverrideForTests ?? fs.stat)(file.srcPath).catch(() => undefined);
        if (file.owner !== undefined && this.canceledOwners.has(file.owner)) {
          file.reject(Object.assign(new Error("crypto stream cancelled"), { code: "RBOX_CRYPTO_STREAM_CANCELLED" }));
        } else if (actual && actual.size > FUSE_MAX_FILE_BYTES) void this.encryptFileBacked(file.srcPath, file.tmpDir, file.opts).then(file.deliver, file.reject);
        else this.enqueueSplit([file]);
      } else file.reject(rehydrateError(result.error));
    }
    for (const file of job.files) if (file.owner !== undefined) this.maybeForgetCanceledOwner(file.owner, job);
    this.activeFusedJobs.delete(job);
    void this.pumpFused();
  }

  private async deliverProducer(held: ProducerResult): Promise<void> {
    if (held.delivered) return;
    held.delivered = true;
    const index = this.producerResults.indexOf(held);
    if (index >= 0) this.producerResults.splice(index, 1);
    try { await held.file.deliver(held.blob); } catch (err) { held.file.reject(err); }
  }

  private async handleFusedCrash(job: FusedJob, err: unknown, decrement = true): Promise<void> {
    if (decrement) this.fusedInFlight--;
    if (job.reserved) { job.reserved = false; this.budget.release(JOB_RESERVE); }
    if (this.closed) {
      for (const file of job.files) file.reject(err);
      this.activeFusedJobs.delete(job);
      return;
    }
    const retryable: PendingFile[] = [];
    for (const file of job.files) {
      if (file.owner !== undefined && this.canceledOwners.has(file.owner)) file.reject(err);
      else retryable.push(file);
    }
    if (typeof err === "object" && err !== null && "code" in err && err.code === "RBOX_CRYPTO_TRANSFER_UNSUPPORTED") {
      this.fusionDisabled = true;
      const queued = this.fusedQueue.splice(0).flatMap((item) => item.files);
      const open = this.openGroup.splice(0);
      this.openBytes = 0;
      for (const file of [...retryable, ...queued, ...open]) void this.encryptFileBacked(file.srcPath, file.tmpDir, file.opts).then(file.deliver, file.reject);
      for (const file of job.files) if (file.owner !== undefined) this.maybeForgetCanceledOwner(file.owner, job);
      this.activeFusedJobs.delete(job);
      return;
    }
    const retry: PendingFile[] = [];
    for (const file of retryable) {
      if (file.attempts >= FUSE_MAX_ENCRYPT_RETRIES) file.reject(err);
      else retry.push(file);
    }
    if (retry.length === 1) this.enqueueSplit(retry);
    else if (retry.some((file) => file.attempts === FUSE_MAX_ENCRYPT_RETRIES - 1)) {
      // The last allowed attempt must isolate every file; otherwise an innocent
      // sibling still grouped with deterministic poison would fail collaterally.
      for (const file of retry) this.enqueueSplit([file]);
    }
    else if (retry.length > 1) {
      const middle = Math.ceil(retry.length / 2);
      this.enqueueSplit(retry.slice(0, middle));
      this.enqueueSplit(retry.slice(middle));
    }
    for (const file of job.files) if (file.owner !== undefined) this.maybeForgetCanceledOwner(file.owner, job);
    this.activeFusedJobs.delete(job);
    void this.pumpFused();
  }

  private maybeForgetCanceledOwner(owner: symbol, terminalJob?: FusedJob): void {
    if (!this.canceledOwners.has(owner)) return;
    const owns = (file: PendingFile): boolean => file.owner === owner;
    if (this.openGroup.some(owns) || this.fusedQueue.some((job) => job.files.some(owns)) ||
        [...this.activeFusedJobs].some((job) => job !== terminalJob && job.files.some(owns)) || this.producerResults.some((held) => owns(held.file))) return;
    this.canceledOwners.delete(owner);
  }

  private enqueueSplit(files: PendingFile[]): void { if (files.length) this.fusedQueue.push({ files, reserved: false, posted: false }); }

  private async spillOldest(): Promise<boolean> {
    const held = this.producerResults.find((x) => !x.delivered && x.blob.lease.location.kind === "memory");
    if (!held) return false;
    try {
      this.spillDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-spill-"));
      await fs.chmod(this.spillDir, 0o700).catch(() => {});
      const pathname = path.join(this.spillDir, `spill-${this.spillOrdinal++}.ct`);
      await fs.writeFile(pathname, held.bytes, { mode: 0o600 });
      held.blob.lease.release();
      held.blob = { ...held.blob, lease: this.fileLease(held.blob.encSha, held.blob.cipherSize, pathname) };
      this.spilledFiles++; this.spilledBytes += held.charge;
    } catch (err) {
      held.blob.lease.release(); held.delivered = true; held.file.reject(err);
      const index = this.producerResults.indexOf(held);
      if (index >= 0) this.producerResults.splice(index, 1);
    }
    return true;
  }

  private cancelUndispatched(err: Error, owner?: symbol): void {
    const keepOpen: PendingFile[] = [];
    for (const file of this.openGroup.splice(0)) {
      if (owner === undefined || file.owner === owner) file.reject(err); else keepOpen.push(file);
    }
    this.openGroup = keepOpen;
    this.openBytes = keepOpen.reduce((n, file) => n + file.size, 0);
    const keepJobs: FusedJob[] = [];
    for (const job of this.fusedQueue.splice(0)) {
      const keep: PendingFile[] = [];
      for (const file of job.files) {
        if (owner === undefined || file.owner === owner) file.reject(err); else keep.push(file);
      }
      if (keep.length) keepJobs.push({ ...job, files: keep });
    }
    this.fusedQueue.push(...keepJobs);
  }

  decrypt(ctPath: string, plaintextSha: string, destPath: string, opts: DecryptFileOptions = {}): Promise<void> {
    return this.run<void>({ id: this.nextId(), kind: "decrypt", ctPath, plaintextSha, destPath, opts });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.budget.wake();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.flushTimer) clearTimeout(this.flushTimer);
      const err = closeError();
      this.cancelUndispatched(err);
      for (const held of this.producerResults.splice(0)) {
        if (!held.delivered) {
          held.delivered = true;
          held.blob.lease.release();
          held.file.reject(err);
        }
      }
      for (const waiter of this.queueWaiters.splice(0)) waiter.reject(err);
      for (const record of this.queue.splice(0)) record.reject(err);
      for (const worker of this.workers.splice(0)) {
        await worker.terminateIntentional();
        for (const record of worker.inFlight.values()) record.reject(err);
        worker.inFlight.clear();
      }
      this.signalQueueSpace();
      if (activePool === this) {
        activePool = undefined;
      }
      await cleanupEmbeddedWorker();
    } finally {
      if (this.spillDir) await fs.rm(this.spillDir, { recursive: true, force: true }).catch(() => {});
      this.spillDir = undefined;
    }
  }

  afterWorkerSlotFreed(): void {
    this.dispatch();
    void this.pumpFused();
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
      if (record.fused) {
        record.reject(crash);
      } else if (record.health || record.attempts >= 1 || this.closed) {
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
    if (this.queue.length > 0 || this.openGroup.length > 0 || this.fusedQueue.length > 0 || this.workers.some((worker) => worker.inFlight.size > 0)) return;
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
    requeueStatOverrideForTests = undefined;
    await cleanupEmbeddedWorker();
  },
  setWorkerPath(pathname: string | undefined): void {
    workerPathOverrideForTests = pathname;
  },
  setRequeueStat(stat: typeof fs.stat | undefined): void {
    requeueStatOverrideForTests = stat;
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
