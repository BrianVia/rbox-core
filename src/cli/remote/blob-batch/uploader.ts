import fs from "node:fs/promises";
import type { ByteProgressCallback } from "../../../engine/blobstore.js";
import { fromHex } from "../../../engine/e2ee/index.js";
import type { RemoteContext } from "../context.js";
import { putBlobFile } from "../blobs.js";
import { BlobRetryLaterError, BlobShaMismatchError, isRetryLater } from "../errors.js";
import { DOWNLOAD_IDLE_MS, SMALL_CONTROL_TIMEOUT_MS } from "../resilient.js";
import { firstPublishAuthDispatchStart, firstPublishAuthSettle, firstPublishTiming, firstPublishUploadEnd, firstPublishUploadStart, LANE_TIMING, recordUploadDispatch, uploadLaneTiming, type UploadDispatchReason } from "../../upload-lane-timing.js";
import { recordLaneSettlement } from "../../push-spans.js";
import { SingleGate, UploadSlotArbiter, batchRecordsCeiling, latchBatchRecordsCeiling, uploadDisabled, disableUploadForProcess, incrementDispatchCount, packUploadDisabled } from "./gate.js";
import { uploadBatchConfig, packUploadConfig, BATCH_RECORDS_FLOOR, FILL_ABSOLUTE_MS, FILL_QUIET_MS, FLUSH_DELAY_MS, SINGLE_UPLOAD_FALLBACK_CONCURRENCY, type BatchConfig, type PackConfig } from "./config.js";
import { BlobPackUploader } from "./pack-uploader.js";
import { framedBytes, parseBatchPutErrorMax, parseBatchPutResponse, BATCH_BLOB_CONTENT_TYPE, BATCH_FRAME_HEADER_BYTES, type BatchPutResponseRecord } from "./wire.js";

interface UploaderClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(t: ReturnType<typeof setTimeout>): void;
}

const realUploaderClock: UploaderClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
let uploaderClock = realUploaderClock;

export function setUploaderClockForTests(clock?: UploaderClock): void {
  uploaderClock = clock ?? realUploaderClock;
}

export interface BatchPutWaiter {
  srcPath: string;
  size: number;
  uploadsDir?: string;
  onBytes?: ByteProgressCallback;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface BatchPutGroup {
  sha: string;
  size: number;
  srcPath: string;
  enqueuedAtMs: number;
  policyEnqueuedAtMs: number;
  waiters: BatchPutWaiter[];
}

export class BlobBatchUploader {
  private readonly config: BatchConfig;
  private readonly packConfig: PackConfig;
  private readonly arbiter: UploadSlotArbiter;
  private queue: BatchPutGroup[] = [];
  private queuedBytes = 0;
  private bySha = new Map<string, BatchPutGroup>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Lane-local only: preserves the legacy idle_tail transition; not capacity. */
  private batchActive = 0;
  private readonly singleGate = new SingleGate(SINGLE_UPLOAD_FALLBACK_CONCURRENCY);
  private closed = false;
  private closeError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();
  private lastUniqueEnqueueAtMs = 0;
  private packUploader: BlobPackUploader | undefined;
  private pendingPartialReason: UploadDispatchReason | undefined;
  private batchReleasePending = false;

  constructor(private readonly ctx: RemoteContext, arbiter?: UploadSlotArbiter) {
    // Upload record bytes stay capped to the server's accepted per-record maximum.
    this.config = uploadBatchConfig();
    this.packConfig = packUploadConfig();
    this.arbiter = arbiter ?? new UploadSlotArbiter(this.config.slots);
    this.arbiter.registerPump(() => {
      if (this.closed) return;
      const batchReleased = this.batchReleasePending;
      this.batchReleasePending = false;
      if (batchReleased) {
        this.dispatchFull();
        if (this.batchActive === 0 && this.queue.length > 0) this.dispatchPartial("idle_tail");
        if (this.config.fill === "v2" && this.queue.length > 0) this.armFillV2Timer();
      }
      // Preserve the arbiter pump's pre-B1 second stage after the release-local
      // full/idle-tail stage. An overdue partial can use a newly freed permit
      // even while another batch request remains active.
      if (this.pendingPartialReason) this.dispatchPartial(this.pendingPartialReason);
      else this.dispatchFull();
      if (this.config.fill === "v2" && this.queue.length > 0) this.armFillV2Timer();
    });
  }

  private get effectiveRecords(): number {
    return Math.min(this.config.records, batchRecordsCeiling());
  }

  private canBatch(size: number): boolean {
    return this.config.enabled && size <= this.config.recordBytes && framedBytes(size) <= this.config.bodyBytes;
  }

  ownsLaneTiming(size: number): boolean {
    return this.canBatch(size);
  }

  putFile(
    sha: string,
    srcPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError!);
    if (!this.canBatch(size)) return this.gatedPutFile(sha, srcPath, size, uploadsDir, onBytes);
    if (this.packConfig.enabled && !packUploadDisabled() && size <= this.packConfig.cutoffBytes) {
      this.packUploader ??= new BlobPackUploader(this.ctx, this.arbiter, (fallbackSha, waiter) => this.requeueFromPack(fallbackSha, waiter));
      return this.packUploader.putFile(sha, srcPath, size, uploadsDir, onBytes);
    }
    if (uploadDisabled()) return this.timedGatedPutFile(sha, srcPath, size, uploadsDir, onBytes, 0);
    return new Promise<void>((resolve, reject) => {
      this.enqueue(sha, { size, srcPath, uploadsDir, onBytes, resolve, reject });
    });
  }

  private enqueue(sha: string, waiter: BatchPutWaiter): void {
    if (this.closed) {
      waiter.reject(this.closeError!);
      return;
    }
    const existing = this.bySha.get(sha);
    if (existing) {
      existing.waiters.push(waiter);
      return;
    }
    const policyEnqueuedAtMs = uploaderClock.now();
    const group: BatchPutGroup = {
      sha,
      size: waiter.size,
      srcPath: waiter.srcPath,
      enqueuedAtMs: LANE_TIMING ? performance.now() : 0,
      policyEnqueuedAtMs,
      waiters: [waiter],
    };
    this.bySha.set(group.sha, group);
    this.queue.push(group);
    this.queuedBytes += framedBytes(group.size);
    this.lastUniqueEnqueueAtMs = policyEnqueuedAtMs;
    this.dispatchFull();
    if (this.queue.length > 0 && !this.timer) {
      if (this.config.fill === "v2") this.armFillV2Timer();
      else this.timer = uploaderClock.setTimeout(() => {
        this.timer = undefined;
        this.dispatchPartial("fixed_timer");
      }, FLUSH_DELAY_MS);
    }
  }

  /** Ownership-transfer target for pack fallback; deliberately bypasses pack routing. */
  requeueFromPack(sha: string, waiter: BatchPutWaiter): void {
    this.enqueue(sha, waiter);
  }

  private dispatchFull(): void {
    if (this.closed) return;
    while (this.queue.length >= this.effectiveRecords || this.queuedBytes >= this.config.bodyBytes) {
      if (!this.arbiter.tryAcquire()) break;
      const reason: UploadDispatchReason = this.queue.length >= this.effectiveRecords ? "full_records" : "full_bytes";
      this.launch(this.carve(), reason);
    }
  }

  private dispatchPartial(reason: UploadDispatchReason): void {
    if (this.closed) return;
    this.pendingPartialReason = reason;
    this.dispatchFull();
    while (this.queue.length > 0) {
      if (!this.arbiter.tryAcquire()) break;
      this.launch(this.carve(), reason);
    }
    if (this.queue.length === 0) this.pendingPartialReason = undefined;
  }

  private armFillV2Timer(): void {
    // Arm only with dispatch capacity; saturation hands re-arming to the
    // settle path because an in-flight request is guaranteed to settle.
    if (this.closed || this.timer || this.queue.length === 0 || this.arbiter.inFlight >= this.arbiter.limit) return;
    const now = uploaderClock.now();
    const quietRemaining = FILL_QUIET_MS - (now - this.lastUniqueEnqueueAtMs);
    const absoluteRemaining = FILL_ABSOLUTE_MS - (now - this.queue[0]!.policyEnqueuedAtMs);
    this.timer = uploaderClock.setTimeout(() => this.onFillV2Timer(), Math.max(1, Math.min(quietRemaining, absoluteRemaining)));
  }

  private onFillV2Timer(): void {
    this.timer = undefined;
    this.pendingPartialReason = undefined;
    if (this.closed) return;
    this.dispatchFull();
    const now = uploaderClock.now();
    if (now - this.lastUniqueEnqueueAtMs >= FILL_QUIET_MS) {
      this.dispatchPartial("quiet");
    } else {
      // A valid partial queue fits one carve because dispatchFull and carve
      // share caps; the loop guard is defensive for latch/byte-cap edges.
      while (this.queue.length > 0 && now - this.queue[0]!.policyEnqueuedAtMs >= FILL_ABSOLUTE_MS) {
        if (!this.arbiter.tryAcquire()) break;
        this.launch(this.carve(), "absolute");
      }
    }
    this.armFillV2Timer();
  }

  private launch(batch: { groups: BatchPutGroup[]; bytes: number }, reason: UploadDispatchReason): void {
    if (batch.groups.length === 0) return;
    if (this.closed) {
      for (const group of batch.groups) this.rejectGroup(group, this.closeError!);
      this.arbiter.release();
      return;
    }
    const oldestAgeMs = Math.max(0, uploaderClock.now() - batch.groups[0]!.policyEnqueuedAtMs);
    recordUploadDispatch(reason, batch.groups.length, batch.bytes, this.queue.length, oldestAgeMs);
    this.batchActive++;
    const dispatch = this.dispatchBatch(batch.groups);
    this.inFlight.add(dispatch);
    void dispatch.finally(() => {
      this.inFlight.delete(dispatch);
      this.batchActive--;
      this.batchReleasePending = true;
      this.arbiter.release();
    });
  }

  private carve(): { groups: BatchPutGroup[]; bytes: number } {
    const taken: BatchPutGroup[] = [];
    let bytes = 0;
    let i = 0;
    for (; i < this.queue.length; i++) {
      const group = this.queue[i]!;
      const nextBytes = framedBytes(group.size);
      if (taken.length >= this.effectiveRecords || (taken.length > 0 && bytes + nextBytes > this.config.bodyBytes)) break;
      taken.push(group);
      bytes += nextBytes;
    }
    this.queue.splice(0, i);
    this.queuedBytes -= bytes;
    return { groups: taken, bytes };
  }

  private async dispatchBatch(batch: BatchPutGroup[]): Promise<void> {
    const pending = new Map(batch.map((group) => [group.sha, group]));
    if (this.closed) {
      for (const group of pending.values()) this.rejectGroup(group, this.closeError!);
      return;
    }
    if (uploadDisabled()) {
      await this.fallbackAll(pending);
      return;
    }

    let idle: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const armIdle = () => {
      if (idle) uploaderClock.clearTimeout(idle);
      idle = uploaderClock.setTimeout(() => ctrl.abort(new DOMException("batch upload stalled", "TimeoutError")), DOWNLOAD_IDLE_MS);
    };

    try {
      const body = await this.encodeBatchBody(batch, pending);
      if (!body) {
        if (this.closed) for (const group of pending.values()) this.rejectGroup(group, this.closeError!);
        return;
      }
      if (this.closed) {
        for (const group of pending.values()) this.rejectGroup(group, this.closeError!);
        return;
      }
      armIdle();
      const queueCutoffMs = performance.now();
      incrementDispatchCount();
      this.ctx.maybeRefreshUploadGrant();
      firstPublishUploadStart();
      const authT0 = firstPublishAuthDispatchStart();
      let authPath: "grant" | "bearer" = "bearer";
      let res: Response;
      try {
        res = await this.ctx.fetch(
          `${this.ctx.baseUrl}/v1/blob-batch/put`,
          {
            method: "POST",
            headers: { ...this.ctx.batchPutAuth, accept: "application/json", "content-type": BATCH_BLOB_CONTENT_TYPE, "content-length": String(body.bytes.byteLength) },
            body: body.bytes,
          },
          { op: "uploading data", timeoutMs: SMALL_CONTROL_TIMEOUT_MS, retries: 0, signal: ctrl.signal },
        );
        if (res.headers.get("x-rbox-auth-path") === "grant") authPath = "grant";
      } finally {
        firstPublishAuthSettle(authT0, authPath);
        firstPublishUploadEnd();
      }
      if (res.status === 404 || res.status === 405) {
        disableUploadForProcess();
        this.drainQueuedAsSingles();
        await this.fallbackAll(pending);
        return;
      }
      if (res.status === 503 && isRetryLater(res.status, await res.clone().text())) {
        // The server wrote every accepted record before its one amortized fence
        // read. Defer the whole request; falling back to singles would immediately
        // re-upload the same bytes into the same hours-lived fence.
        for (const group of pending.values()) this.rejectGroup(group, new BlobRetryLaterError());
        pending.clear();
        return;
      }
      if (res.status === 400 && this.effectiveRecords > BATCH_RECORDS_FLOOR) {
        // | Server max | Client send max | Result |
        // | 32 | 32 | Current compatible behavior; fill-v2 may improve occupancy. |
        // | 64 | 32 | Backward-compatible; server capability is unused. |
        // | 64 | 64 | Target behavior. |
        // | 32 | 64 | Invalid rollout/rollback ordering. Without the latch below this would be UNBOUNDED degradation, not a one-off: today's client treats a 400 like any non-OK response — `fallbackAll` re-uploads that request as singles and keeps forming oversized batches forever (unlike 404/405, a 400 latches nothing). Mitigations below reduce it to one latch event plus a bounded in-flight burst (≤ slots), and make it alertable. |
        // | old/no batch route | 64-cap client | Existing 404/405 process-wide single-PUT fallback. |
        // With 24 slots, up to `slots` oversized requests may already be in flight;
        // each independently falls back to singles. The latch prevents NEW oversized carves.
        const sent = body.groups.length;
        const parsedMax = parseBatchPutErrorMax(await res.json().catch(() => null));
        const target = parsedMax !== undefined && parsedMax < sent
          ? Math.max(BATCH_RECORDS_FLOOR, parsedMax)
          : BATCH_RECORDS_FLOOR;
        latchBatchRecordsCeiling(target);
        await this.fallbackAll(pending);
        return;
      }
      if (!res.ok) {
        await this.fallbackAll(pending);
        return;
      }
      const parsed = parseBatchPutResponse(await res.json().catch(() => null));
      if (!parsed) {
        await this.fallbackAll(pending);
        return;
      }
      const httpMs = performance.now() - queueCutoffMs;
      recordLaneSettlement("batch", body.bytes.byteLength, httpMs);
      for (const result of parsed) {
        const group = pending.get(result.sha256);
        if (!group) continue;
        pending.delete(result.sha256);
        if (result.ok) this.resolveGroupFromBatch(group, result, httpMs / Math.max(1, body.groups.length), queueCutoffMs);
        else if (result.error === "sha_mismatch") this.rejectGroup(group, new BlobShaMismatchError(group.sha));
        else await this.dispatchSingleGroup(group);
      }
      await this.fallbackAll(pending);
    } catch {
      if (this.closed) {
        for (const group of pending.values()) this.rejectGroup(group, this.closeError!);
      } else await this.fallbackAll(pending);
    } finally {
      if (idle) uploaderClock.clearTimeout(idle);
    }
  }

  private async encodeBatchBody(batch: BatchPutGroup[], pending: Map<string, BatchPutGroup>): Promise<{ bytes: Uint8Array; groups: BatchPutGroup[] } | null> {
    if (this.closed) return null;
    const payloads = await Promise.all(batch.map((group) => fs.readFile(group.srcPath)));
    const allPayloadBytes = payloads.reduce((n, payload) => n + payload.byteLength, 0);
    if (firstPublishTiming.enabled) firstPublishTiming.stats.peakUploaderFramingBytes = Math.max(firstPublishTiming.stats.peakUploaderFramingBytes, allPayloadBytes);
    if (this.closed) return null;
    const accepted: Array<{ group: BatchPutGroup; payload: Uint8Array }> = [];
    const fallbacks: BatchPutGroup[] = [];
    let total = 0;
    for (let i = 0; i < batch.length; i++) {
      const group = batch[i]!;
      const payload = payloads[i]!;
      const frameBytes = framedBytes(payload.byteLength);
      if (payload.byteLength > this.config.recordBytes || total + frameBytes > this.config.bodyBytes) {
        pending.delete(group.sha);
        fallbacks.push(group);
        continue;
      }
      accepted.push({ group, payload });
      total += frameBytes;
    }
    for (const group of fallbacks) await this.dispatchSingleGroup(group);
    if (accepted.length === 0) return null;
    const out = new Uint8Array(total);
    if (firstPublishTiming.enabled) {
      firstPublishTiming.stats.peakUploaderFramingBytes = Math.max(firstPublishTiming.stats.peakUploaderFramingBytes, allPayloadBytes + out.byteLength);
    }
    let off = 0;
    for (const { group, payload } of accepted) {
      out.set(fromHex(group.sha), off);
      new DataView(out.buffer, out.byteOffset + off + 32, 4).setUint32(0, payload.byteLength, false);
      off += BATCH_FRAME_HEADER_BYTES;
      out.set(payload, off);
      off += payload.byteLength;
    }
    return { bytes: out, groups: accepted.map(({ group }) => group) };
  }

  private drainQueuedAsSingles(): void {
    if (this.closed) return;
    if (this.timer) uploaderClock.clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingPartialReason = undefined;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const group of queued) void this.dispatchSingleGroup(group);
  }

  private async fallbackAll(pending: Map<string, BatchPutGroup>): Promise<void> {
    if (this.closed) {
      for (const group of pending.values()) this.rejectGroup(group, this.closeError!);
      pending.clear();
      return;
    }
    const groups = [...pending.values()];
    pending.clear();
    await Promise.all(groups.map((group) => this.dispatchSingleGroup(group)));
  }

  private async dispatchSingleGroup(group: BatchPutGroup): Promise<void> {
    if (this.closed) {
      this.rejectGroup(group, this.closeError!);
      return;
    }
    const first = group.waiters[0]!;
    const queueMs = LANE_TIMING && group.enqueuedAtMs > 0 ? Math.max(0, performance.now() - group.enqueuedAtMs) : 0;
    try {
      await this.timedGatedPutFile(group.sha, first.srcPath, first.size, first.uploadsDir, first.onBytes, queueMs);
      for (const waiter of group.waiters.slice(1)) {
        waiter.onBytes?.(waiter.size);
        waiter.resolve();
      }
      first.resolve();
    } catch (e) {
      for (const waiter of group.waiters) waiter.reject(e);
    } finally {
      this.bySha.delete(group.sha);
    }
  }

  private resolveGroupFromBatch(group: BatchPutGroup, result: Extract<BatchPutResponseRecord, { ok: true }>, uploadMs: number, queueCutoffMs: number): void {
    this.ctx.captureReceipt(group.sha, { receipt: result.receipt });
    if (LANE_TIMING) {
      uploadLaneTiming.uploadMs += uploadMs;
      uploadLaneTiming.queueMs += group.enqueuedAtMs > 0 ? Math.max(0, queueCutoffMs - group.enqueuedAtMs) : 0;
      uploadLaneTiming.blobs++;
      uploadLaneTiming.bytes += result.sizeBytes;
    }
    for (const waiter of group.waiters) {
      waiter.onBytes?.(waiter.size);
      waiter.resolve();
    }
    this.bySha.delete(group.sha);
  }

  private rejectGroup(group: BatchPutGroup, e: unknown): void {
    for (const waiter of group.waiters) waiter.reject(e);
    this.bySha.delete(group.sha);
  }

  private async timedGatedPutFile(
    sha: string,
    srcPath: string,
    size: number,
    uploadsDir: string | undefined,
    onBytes: ByteProgressCallback | undefined,
    queueMs: number
  ): Promise<void> {
    const t0 = performance.now();
    await this.gatedPutFile(sha, srcPath, size, uploadsDir, onBytes);
    const uploadMs = performance.now() - t0;
    recordLaneSettlement("single", size, uploadMs);
    if (LANE_TIMING) {
      uploadLaneTiming.uploadMs += uploadMs;
      uploadLaneTiming.queueMs += queueMs;
      uploadLaneTiming.blobs++;
      uploadLaneTiming.bytes += size;
    }
  }

  private async gatedPutFile(sha: string, srcPath: string, size: number, uploadsDir?: string, onBytes?: ByteProgressCallback): Promise<void> {
    const dispatch = this.singleGate.run(() => {
      if (this.closed) throw this.closeError!;
      incrementDispatchCount();
      return putBlobFile(this.ctx, sha, srcPath, size, uploadsDir, onBytes);
    });
    this.inFlight.add(dispatch);
    try {
      await dispatch;
    } finally {
      this.inFlight.delete(dispatch);
    }
  }

  close(err: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Pack shutdown claims/aborts pack-owned groups before the parent batch
    // queue is closed; transferred groups are then rejected by that queue.
    const packClose = this.packUploader?.close(err) ?? Promise.resolve();
    this.closed = true;
    this.closeError = err;
    if (this.timer) uploaderClock.clearTimeout(this.timer);
    this.timer = undefined;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    this.bySha.clear();
    for (const group of queued) for (const waiter of group.waiters) waiter.reject(err);
    this.closePromise = Promise.allSettled([packClose, ...this.inFlight]).then(() => {});
    return this.closePromise;
  }
}
