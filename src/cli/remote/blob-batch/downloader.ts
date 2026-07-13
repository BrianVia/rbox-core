import fs from "node:fs/promises";
import path from "node:path";
import { countRename, mkdirCounted } from "../../../engine/apply-stats.js";
import { hashBytes } from "../../../engine/hash.js";
import type { RemoteContext } from "../context.js";
import { getBlobToFile } from "../blobs.js";
import { translateRemoteError } from "../errors.js";
import { DOWNLOAD_IDLE_MS, blobDownloadTimeoutMs, envInt } from "../resilient.js";
import { SingleGate, downloadDisabled, disableDownloadForProcess } from "./gate.js";
import { downloadBatchConfig, FLUSH_DELAY_MS, GRANT_REFRESH_AFTER_MS, SINGLE_FALLBACK_CONCURRENCY, DEFAULT_PULL_JOIN_WATCHDOG_MS, DEFAULT_PULL_JOIN_WATCHDOG_MAX_FIRINGS } from "./config.js";
import type { BatchConfig } from "./config.js";
import { parseBatchFrames, parseStatus, BATCH_BLOB_CONTENT_TYPE } from "./wire.js";

const debug = (msg: string): void => {
  if (process.env.RBOX_DEBUG) process.stderr.write(`rbox: ${msg}\n`);
};

interface BatchRequest {
  id: number;
  sha: string;
  expectedSize?: number;
  destPath: string;
  attempts: number;
  settled: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * A watchdog duplicate races the in-flight primary. The loser must never settle
 * the request; publishAttempt's settled guard plus atomic rename pick the winner.
 */
type AttemptKind = "primary" | "watchdog-duplicate";

export class BlobBatchDownloader {
  private readonly config: BatchConfig;
  private queue: BatchRequest[] = [];
  private queueShas = new Set<string>();
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly singleGate = new SingleGate(SINGLE_FALLBACK_CONCURRENCY);
  private readonly watchdogMs = envInt("RBOX_PULL_JOIN_WATCHDOG_MS", DEFAULT_PULL_JOIN_WATCHDOG_MS, 10, 60 * 60 * 1000);
  private readonly watchdogMaxFirings = envInt("RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS", DEFAULT_PULL_JOIN_WATCHDOG_MAX_FIRINGS, 1, 10);
  private readonly activeRequests = new Set<BatchRequest>();
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAtMs = 0;
  private watchdogFiringsSinceProgress = 0;
  private queueDirty = false;
  private nextRequestId = 1;

  constructor(private readonly ctx: RemoteContext) {
    // Download can accept record bytes up to the response body cap; upload cannot.
    this.config = downloadBatchConfig();
  }

  getToFile(sha: string, expectedSize: number | undefined, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req: BatchRequest = {
        id: this.nextRequestId++,
        sha,
        expectedSize,
        destPath,
        attempts: 0,
        settled: false,
        resolve,
        reject,
      };
      const canBatch = !downloadDisabled() && this.config.enabled && expectedSize !== undefined && expectedSize <= this.config.recordBytes;
      if (canBatch) this.track(req);
      if (!canBatch) {
        void this.dispatchSingle(req);
      } else {
        this.enqueue(req);
      }
    });
  }

  private track(req: BatchRequest): void {
    if (this.activeRequests.size === 0) {
      const now = Date.now();
      this.lastActivityAtMs = now;
      this.watchdogFiringsSinceProgress = 0;
    }
    this.activeRequests.add(req);
    this.armWatchdog();
  }

  private settleOk(req: BatchRequest): void {
    if (req.settled) return;
    req.settled = true;
    this.queueDirty = true;
    this.activeRequests.delete(req);
    this.recordProgress();
    req.resolve();
  }

  private settleErr(req: BatchRequest, e: unknown): void {
    if (req.settled) return;
    req.settled = true;
    this.queueDirty = true;
    this.activeRequests.delete(req);
    this.recordProgress();
    req.reject(e);
  }

  private recordProgress(): void {
    this.lastActivityAtMs = Date.now();
    this.watchdogFiringsSinceProgress = 0;
  }

  private armWatchdog(): void {
    if (this.watchdog || this.activeRequests.size === 0) return;
    this.watchdog = setTimeout(() => this.onWatchdog(), this.watchdogMs);
    this.watchdog.unref?.();
  }

  private onWatchdog(): void {
    this.watchdog = undefined;
    const outstanding = [...this.activeRequests].filter((req) => !req.settled);
    if (outstanding.length === 0) return;
    const idleMs = Date.now() - this.lastActivityAtMs;
    if (idleMs < this.watchdogMs) {
      this.watchdog = setTimeout(() => this.onWatchdog(), Math.max(1, this.watchdogMs - idleMs));
      this.watchdog.unref?.();
      return;
    }
    this.watchdogFiringsSinceProgress++;
    const sample = outstanding.slice(0, 8).map((req) => req.sha).join(", ");
    if (this.watchdogFiringsSinceProgress >= this.watchdogMaxFirings) {
      const err = new Error(
          `pull download stalled: no blob completions or stream progress for ${Math.round(idleMs / 1000)}s; ` +
          `outstanding blobs ${outstanding.length} (${sample}${outstanding.length > 8 ? ", …" : ""}). ` +
          "safe to re-run `rbox pull` to resume."
      );
      for (const req of outstanding) this.settleErr(req, err);
      return;
    }
    process.stderr.write(
      `rbox: pull download liveness watchdog: no blob completions or stream progress for ${Math.round(idleMs / 1000)}s; ` +
        `retrying ${outstanding.length} outstanding blob(s): ${sample}${outstanding.length > 8 ? ", …" : ""}\n`
    );
    for (const req of outstanding) void this.dispatchSingle(req, "watchdog-duplicate");
    this.armWatchdog();
  }

  private pruneQueue(): void {
    if (!this.queueDirty) return;
    this.queueDirty = false;
    const live = this.queue.filter((req) => !req.settled);
    if (live.length === this.queue.length) return;
    this.queue = live;
    this.recountQueue();
  }

  private recountQueue(): void {
    this.queueShas = new Set();
    this.queuedBytes = 0;
    for (const req of this.queue) {
      if (this.queueShas.has(req.sha)) continue;
      this.queueShas.add(req.sha);
      this.queuedBytes += req.expectedSize!;
    }
  }

  // Pull-based dispatch (measured 2026-07-07: the previous push-based flush —
  // batches formed the moment a 10ms timer fired — settled into ~5.4 shas/batch
  // under steady load, 17k requests instead of ~3k, and the join REGRESSED to
  // 342s vs the 176s single-GET baseline). Full batches dispatch the instant a
  // slot is free; partial batches leave the queue only on the flush timer or
  // when every slot is idle, so steady-state batches stay full.
  private enqueue(req: BatchRequest): void {
    if (req.settled || req.expectedSize === undefined) return;
    this.queue.push(req);
    if (!this.queueShas.has(req.sha)) {
      this.queueShas.add(req.sha);
      this.queuedBytes += req.expectedSize;
    }
    this.dispatchFull();
    if (this.queue.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.dispatchPartial();
      }, FLUSH_DELAY_MS);
    }
  }

  /** Dispatch only FULL batches (record or byte cap reached) into free slots. */
  private dispatchFull(): void {
    this.pruneQueue();
    while (this.active < this.config.slots && (this.queueShas.size >= this.config.records || this.queuedBytes >= this.config.bodyBytes)) {
      this.launch(this.carve());
    }
  }

  /** Timer/idle path: keep slots busy even when only a partial batch is queued. */
  private dispatchPartial(): void {
    this.dispatchFull();
    while (this.active < this.config.slots && this.queue.length > 0) this.launch(this.carve());
  }

  private launch(batch: BatchRequest[]): void {
    batch = batch.filter((req) => !req.settled);
    if (batch.length === 0) return;
    this.active++;
    void this.dispatchBatch(batch).finally(() => {
      this.active--;
      this.dispatchFull();
      // Tail: nothing left in flight but stragglers queued — ship them now
      // rather than waiting on an already-fired timer.
      if (this.active === 0 && this.queue.length > 0) this.dispatchPartial();
    });
  }

  /** Take up to `records` unique shas (within the byte cap) off the queue front. */
  private carve(): BatchRequest[] {
    const taken: BatchRequest[] = [];
    const shas = new Set<string>();
    let bytes = 0;
    let i = 0;
    for (; i < this.queue.length; i++) {
      const req = this.queue[i]!;
      if (req.settled) {
        taken.push(req);
        continue;
      }
      if (shas.has(req.sha)) {
        taken.push(req);
        continue;
      }
      const expectedSize = req.expectedSize!;
      if (shas.size >= this.config.records || bytes + expectedSize > this.config.bodyBytes) break;
      shas.add(req.sha);
      bytes += expectedSize;
      taken.push(req);
    }
    this.queue.splice(0, i);
    this.recountQueue();
    return taken.filter((req) => !req.settled);
  }

  private async dispatchBatch(batch: BatchRequest[]): Promise<void> {
    batch = batch.filter((req) => !req.settled);
    if (batch.length === 0) return;
    if (downloadDisabled()) {
      await Promise.all(batch.map((req) => this.dispatchSingle(req)));
      return;
    }
    const bySha = new Map<string, BatchRequest[]>();
    for (const req of batch) {
      const list = bySha.get(req.sha);
      if (list) list.push(req);
      else bySha.set(req.sha, [req]);
    }
    const shas = [...bySha.keys()];
    const pending = new Map(bySha);
    const batchBytes = shas.reduce((n, sha) => n + (bySha.get(sha)?.[0]?.expectedSize ?? 0), 0);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new DOMException("batch download stalled", "TimeoutError")), DOWNLOAD_IDLE_MS);
    };
    try {
      await this.ctx.ensureFreshDownloadGrant(GRANT_REFRESH_AFTER_MS);
      armIdle();
      const res = await this.ctx.fetch(
        `${this.ctx.baseUrl}/v1/blob-batch/get`,
        {
          method: "POST",
          headers: { ...this.ctx.authDownload, accept: BATCH_BLOB_CONTENT_TYPE, "content-type": "application/json" },
          body: JSON.stringify(shas),
        },
        { op: "downloading data", timeoutMs: blobDownloadTimeoutMs(batchBytes), signal: ctrl.signal },
      );
      if (res.status === 404) {
        disableDownloadForProcess();
        this.drainQueuedAsSingles();
        await this.fallbackAll(pending);
        return;
      }
      if (!res.ok || !res.body) {
        await this.fallbackAll(pending);
        return;
      }
      // Settlements (disk writes, per-sha single-GET fallbacks) run concurrently
      // with stream parsing — a 256 KiB writeFile must not stall the next network
      // read. Bounded: ≤ bodyBytes of payload in flight per slot; none of these
      // promises reject (writePayload/dispatchSingle settle their request).
      const settlements: Promise<unknown>[] = [];
      for await (const frame of parseBatchFrames(res.body as ReadableStream<Uint8Array>, () => {
        armIdle();
        this.recordProgress();
      })) {
        const waiters = pending.get(frame.sha)?.filter((req) => !req.settled);
        if (!waiters) continue;
        if (frame.status) {
          const status = parseStatus(frame.payload);
          if (!status) continue;
          pending.delete(frame.sha);
          if (status.status === "missing") {
            const err = new Error(translateRemoteError(404, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
            for (const req of waiters) this.settleErr(req, err);
          } else {
            settlements.push(Promise.all(waiters.map((req) => this.dispatchSingle(req))));
          }
          continue;
        }
        if (hashBytes(frame.payload) !== frame.sha) {
          pending.delete(frame.sha);
          settlements.push(Promise.all(waiters.map(async (req) => {
            await this.dispatchSingle(req);
          })));
          continue;
        }
        pending.delete(frame.sha);
        settlements.push(Promise.all(waiters.map((req) => this.writePayload(req, frame.payload))));
      }
      await Promise.all(settlements);
      await this.fallbackAll(pending);
    } catch {
      await this.fallbackAll(pending);
    } finally {
      if (idle) clearTimeout(idle);
    }
  }

  private drainQueuedAsSingles(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const queued = this.queue.filter((req) => !req.settled);
    this.queue = [];
    this.queueShas = new Set();
    this.queuedBytes = 0;
    this.queueDirty = false;
    for (const req of queued) void this.dispatchSingle(req);
  }

  private async fallbackAll(pending: Map<string, BatchRequest[]>): Promise<void> {
    const groups = [...pending.values()].map((group) => group.filter((req) => !req.settled)).filter((group) => group.length > 0);
    pending.clear();
    await Promise.all(groups.flat().map((req) => this.dispatchSingle(req)));
  }

  // With batching on, the apply pool supplies up to 512 tasks (apply.ts §77
  // comment) — large-blob bypasses, old-server drains, and mass fallbacks must
  // not turn that into 512 concurrent single GETs. Gate every single GET this
  // downloader issues at the pre-batching width.
  private async gatedGetToFile(sha: string, destPath: string, expectedSize?: number): Promise<void> {
    await this.singleGate.run(() => getBlobToFile(this.ctx, sha, destPath, expectedSize));
  }

  private async dispatchSingle(req: BatchRequest, kind: AttemptKind = "primary"): Promise<void> {
    if (req.settled) return;
    const tmp = this.attemptPath(req);
    try {
      await this.gatedGetToFile(req.sha, tmp, req.expectedSize);
      await this.publishAttempt(req, tmp);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (kind === "watchdog-duplicate") {
        debug(`pull download watchdog duplicate retry failed for ${req.sha}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.settleErr(req, e);
    }
  }

  private attemptPath(req: BatchRequest): string {
    req.attempts++;
    return `${req.destPath}.rboxdl-${process.pid}-${req.id}-${req.attempts}`;
  }

  private async publishAttempt(req: BatchRequest, tmp: string): Promise<void> {
    if (req.settled) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return;
    }
    await mkdirCounted(path.dirname(req.destPath));
    countRename();
    await fs.rename(tmp, req.destPath);
    this.settleOk(req);
  }

  private async writePayload(req: BatchRequest, payload: Uint8Array): Promise<void> {
    if (req.settled) return;
    const tmp = this.attemptPath(req);
    try {
      await mkdirCounted(path.dirname(tmp));
      await fs.writeFile(tmp, payload);
      await this.publishAttempt(req, tmp);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      this.settleErr(req, e);
    }
  }
}
