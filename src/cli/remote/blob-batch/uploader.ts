import fs from "node:fs/promises";
import type { ByteProgressCallback } from "../../../engine/blobstore.js";
import { fromHex } from "../../../engine/e2ee/index.js";
import type { RemoteContext } from "../context.js";
import { putBlobFile } from "../blobs.js";
import { BlobRetryLaterError, BlobShaMismatchError, isRetryLater } from "../errors.js";
import { DOWNLOAD_IDLE_MS, SMALL_CONTROL_TIMEOUT_MS } from "../resilient.js";
import { firstPublishAuthEnd, firstPublishAuthStart, firstPublishTiming, firstPublishUploadEnd, firstPublishUploadStart, LANE_TIMING, uploadLaneTiming } from "../../upload-lane-timing.js";
import { SingleGate, uploadDisabled, disableUploadForProcess, incrementDispatchCount } from "./gate.js";
import { uploadBatchConfig, FLUSH_DELAY_MS, SINGLE_UPLOAD_FALLBACK_CONCURRENCY } from "./config.js";
import type { BatchConfig } from "./config.js";
import { framedBytes, parseBatchPutResponse, BATCH_BLOB_CONTENT_TYPE, BATCH_FRAME_HEADER_BYTES } from "./wire.js";
import type { BatchPutResponseRecord } from "./wire.js";

interface BatchPutWaiter {
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
  waiters: BatchPutWaiter[];
}

export class BlobBatchUploader {
  private readonly config: BatchConfig;
  private queue: BatchPutGroup[] = [];
  private queuedBytes = 0;
  private bySha = new Map<string, BatchPutGroup>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly singleGate = new SingleGate(SINGLE_UPLOAD_FALLBACK_CONCURRENCY);
  private closed = false;
  private closeError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly ctx: RemoteContext) {
    // Upload record bytes stay capped to the server's accepted per-record maximum.
    this.config = uploadBatchConfig();
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
    const group: BatchPutGroup = {
      sha,
      size: waiter.size,
      srcPath: waiter.srcPath,
      enqueuedAtMs: LANE_TIMING ? performance.now() : 0,
      waiters: [waiter],
    };
    this.bySha.set(group.sha, group);
    this.queue.push(group);
    this.queuedBytes += framedBytes(group.size);
    this.dispatchFull();
    if (this.queue.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.dispatchPartial();
      }, FLUSH_DELAY_MS);
    }
  }

  private dispatchFull(): void {
    if (this.closed) return;
    while (this.active < this.config.slots && (this.queue.length >= this.config.records || this.queuedBytes >= this.config.bodyBytes)) {
      this.launch(this.carve());
    }
  }

  private dispatchPartial(): void {
    if (this.closed) return;
    this.dispatchFull();
    while (this.active < this.config.slots && this.queue.length > 0) this.launch(this.carve());
  }

  private launch(batch: BatchPutGroup[]): void {
    if (batch.length === 0) return;
    if (this.closed) {
      for (const group of batch) this.rejectGroup(group, this.closeError!);
      return;
    }
    this.active++;
    const dispatch = this.dispatchBatch(batch);
    this.inFlight.add(dispatch);
    void dispatch.finally(() => {
      this.inFlight.delete(dispatch);
      this.active--;
      if (this.closed) return;
      this.dispatchFull();
      if (this.active === 0 && this.queue.length > 0) this.dispatchPartial();
    });
  }

  private carve(): BatchPutGroup[] {
    const taken: BatchPutGroup[] = [];
    let bytes = 0;
    let i = 0;
    for (; i < this.queue.length; i++) {
      const group = this.queue[i]!;
      const nextBytes = framedBytes(group.size);
      if (taken.length >= this.config.records || (taken.length > 0 && bytes + nextBytes > this.config.bodyBytes)) break;
      taken.push(group);
      bytes += nextBytes;
    }
    this.queue.splice(0, i);
    this.queuedBytes -= bytes;
    return taken;
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
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new DOMException("batch upload stalled", "TimeoutError")), DOWNLOAD_IDLE_MS);
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
      const queueCutoffMs = LANE_TIMING ? performance.now() : 0;
      incrementDispatchCount();
      firstPublishUploadStart();
      firstPublishAuthStart();
      let res: Response;
      try { res = await this.ctx.fetch(
        `${this.ctx.baseUrl}/v1/blob-batch/put`,
        {
          method: "POST",
          headers: { ...this.ctx.protoAuth, accept: "application/json", "content-type": BATCH_BLOB_CONTENT_TYPE, "content-length": String(body.bytes.byteLength) },
          body: body.bytes,
        },
        { op: "uploading data", timeoutMs: SMALL_CONTROL_TIMEOUT_MS, retries: 0, signal: ctrl.signal },
      ); } finally { firstPublishAuthEnd(); firstPublishUploadEnd(); }
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
      if (!res.ok) {
        await this.fallbackAll(pending);
        return;
      }
      const parsed = parseBatchPutResponse(await res.json().catch(() => null));
      if (!parsed) {
        await this.fallbackAll(pending);
        return;
      }
      const httpMs = LANE_TIMING ? performance.now() - queueCutoffMs : 0;
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
      if (idle) clearTimeout(idle);
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
    const t0 = LANE_TIMING ? performance.now() : 0;
    await this.gatedPutFile(sha, srcPath, size, uploadsDir, onBytes);
    if (LANE_TIMING) {
      uploadLaneTiming.uploadMs += performance.now() - t0;
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
    this.closed = true;
    this.closeError = err;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    this.bySha.clear();
    for (const group of queued) for (const waiter of group.waiters) waiter.reject(err);
    this.closePromise = Promise.allSettled([...this.inFlight]).then(() => {});
    return this.closePromise;
  }
}
