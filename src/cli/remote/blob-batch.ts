import fs from "node:fs/promises";
import path from "node:path";
import type { ByteProgressCallback } from "../../engine/blobstore.js";
import { hashBytes } from "../../engine/hash.js";
import { fromHex, toHex } from "../../engine/e2ee/index.js";
import type { RemoteContext } from "./context.js";
import { getBlobToFile, putBlobFile } from "./blobs.js";
import { BlobShaMismatchError, translateRemoteError } from "./errors.js";
import { DOWNLOAD_IDLE_MS, SMALL_CONTROL_TIMEOUT_MS, envInt } from "./resilient.js";
import { LANE_TIMING, uploadLaneTiming } from "../upload-lane-timing.js";

// Wire twin: apps/api/src/blob-batch.ts — the framing constants and codec are
// duplicated per build target (house pattern, like UPLOAD_RECEIPTS_V1). Change
// them in lockstep; nothing fails to compile if they drift.

export const BATCH_BLOB_CONTENT_TYPE = "application/x-rbox-blobs";
export const BATCH_FRAME_HEADER_BYTES = 36;
export const BATCH_STATUS_BIT = 0x80000000;
export const DEFAULT_BATCH_RECORD_BYTES = 256 * 1024;
const BATCH_STATUS_MAX_BYTES = 4 * 1024;
const DEFAULT_BATCH_RECORDS = 32;
const DEFAULT_BATCH_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_BATCH_SLOTS = 16;
const DEFAULT_BATCH_PUT_SLOTS = 8;
const FLUSH_DELAY_MS = 10;
const GRANT_REFRESH_AFTER_MS = 4 * 60 * 1000;
const SINGLE_FALLBACK_CONCURRENCY = 128;
const SINGLE_UPLOAD_FALLBACK_CONCURRENCY = 64;

interface BatchFrame {
  sha: string;
  status: boolean;
  payload: Uint8Array;
}

interface BatchConfig {
  enabled: boolean;
  records: number;
  recordBytes: number;
  bodyBytes: number;
  slots: number;
}

interface BatchRequest {
  sha: string;
  expectedSize: number;
  destPath: string;
  resolve: () => void;
  reject: (e: unknown) => void;
}

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

type BatchPutResponseRecord =
  | { sha256: string; ok: true; sizeBytes: number; receipt: string }
  | { sha256: string; ok: false; error: "sha_mismatch" | "too_large" | "r2_error" };

let downloadDisabledForProcess = false;
let uploadDisabledForProcess = false;

class SingleGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export function resetBatchBlobStateForTests(): void {
  downloadDisabledForProcess = false;
  uploadDisabledForProcess = false;
}

async function* parseBatchFrames(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<BatchFrame> {
  const reader = body.getReader();
  // Chunk list instead of a grow-and-recopy buffer: every payload byte is copied
  // at most once (and headers are usually zero-copy subarray views). The naive
  // concat form re-copies the accumulating prefix per read — tens of GB of
  // memcpy across a ~95k-blob join.
  const chunks: Uint8Array[] = [];
  let available = 0;
  let eof = false;
  const fill = async (n: number): Promise<boolean> => {
    while (available < n && !eof) {
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
        break;
      }
      if (value?.byteLength) {
        onChunk?.();
        chunks.push(value);
        available += value.byteLength;
      }
    }
    return available >= n;
  };
  const take = (n: number): Uint8Array => {
    if (n === 0) return new Uint8Array(0);
    const head = chunks[0]!;
    if (head.byteLength >= n) {
      const out = head.subarray(0, n);
      if (head.byteLength === n) chunks.shift();
      else chunks[0] = head.subarray(n);
      available -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = chunks[0]!;
      const want = Math.min(n - off, c.byteLength);
      out.set(c.subarray(0, want), off);
      if (want === c.byteLength) chunks.shift();
      else chunks[0] = c.subarray(want);
      off += want;
    }
    available -= n;
    return out;
  };
  try {
    for (;;) {
      const hasHeader = await fill(BATCH_FRAME_HEADER_BYTES);
      if (!hasHeader) {
        if (available === 0) return;
        throw new Error("truncated batch blob frame header");
      }
      const header = take(BATCH_FRAME_HEADER_BYTES);
      const sha = toHex(header.subarray(0, 32));
      const word = new DataView(header.buffer, header.byteOffset + 32, 4).getUint32(0, false);
      const isStatus = (word & BATCH_STATUS_BIT) !== 0;
      const length = word & 0x7fffffff;
      if (isStatus && length > BATCH_STATUS_MAX_BYTES) throw new Error("batch blob status frame too large");
      if (!isStatus && length > DEFAULT_BATCH_RECORD_BYTES) throw new Error("batch blob data frame too large");
      const hasPayload = await fill(length);
      if (!hasPayload) throw new Error("truncated batch blob frame payload");
      yield { sha, status: isStatus, payload: take(length) };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort only; preserve the original parse failure.
    }
  }
}

export class BlobBatchDownloader {
  private readonly config: BatchConfig;
  private queue: BatchRequest[] = [];
  private queueShas = new Set<string>();
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly singleGate = new SingleGate(SINGLE_FALLBACK_CONCURRENCY);

  constructor(private readonly ctx: RemoteContext) {
    // Download can accept record bytes up to the response body cap; upload cannot.
    this.config = readBatchConfig("RBOX_BATCH_SLOTS", DEFAULT_BATCH_SLOTS, 64, DEFAULT_BATCH_BODY_BYTES);
  }

  getToFile(sha: string, expectedSize: number | undefined, destPath: string): Promise<void> {
    if (downloadDisabledForProcess || !this.config.enabled || expectedSize === undefined || expectedSize > this.config.recordBytes) {
      return this.gatedGetToFile(sha, destPath);
    }
    return new Promise<void>((resolve, reject) => {
      this.enqueue({ sha, expectedSize, destPath, resolve, reject });
    });
  }

  // Pull-based dispatch (measured 2026-07-07: the previous push-based flush —
  // batches formed the moment a 10ms timer fired — settled into ~5.4 shas/batch
  // under steady load, 17k requests instead of ~3k, and the join REGRESSED to
  // 342s vs the 176s single-GET baseline). Full batches dispatch the instant a
  // slot is free; partial batches leave the queue only on the flush timer or
  // when every slot is idle, so steady-state batches stay full.
  private enqueue(req: BatchRequest): void {
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
      if (shas.has(req.sha)) {
        taken.push(req);
        continue;
      }
      if (shas.size >= this.config.records || bytes + req.expectedSize > this.config.bodyBytes) break;
      shas.add(req.sha);
      bytes += req.expectedSize;
      taken.push(req);
    }
    this.queue.splice(0, i);
    this.queueShas = new Set();
    this.queuedBytes = 0;
    for (const r of this.queue) {
      if (!this.queueShas.has(r.sha)) {
        this.queueShas.add(r.sha);
        this.queuedBytes += r.expectedSize;
      }
    }
    return taken;
  }

  private async dispatchBatch(batch: BatchRequest[]): Promise<void> {
    if (downloadDisabledForProcess) {
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
        { op: "downloading data", timeoutMs: SMALL_CONTROL_TIMEOUT_MS, signal: ctrl.signal },
      );
      if (res.status === 404) {
        downloadDisabledForProcess = true;
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
      for await (const frame of parseBatchFrames(res.body as ReadableStream<Uint8Array>, armIdle)) {
        const waiters = pending.get(frame.sha);
        if (!waiters) continue;
        if (frame.status) {
          const status = parseStatus(frame.payload);
          if (!status) continue;
          pending.delete(frame.sha);
          if (status.status === "missing") {
            const err = new Error(translateRemoteError(404, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
            for (const req of waiters) req.reject(err);
          } else {
            settlements.push(Promise.all(waiters.map((req) => this.dispatchSingle(req))));
          }
          continue;
        }
        if (hashBytes(frame.payload) !== frame.sha) {
          pending.delete(frame.sha);
          settlements.push(Promise.all(waiters.map(async (req) => {
            await fs.rm(req.destPath, { force: true }).catch(() => {});
            await this.dispatchSingle(req);
          })));
          continue;
        }
        pending.delete(frame.sha);
        settlements.push(Promise.all(waiters.map((req) => writePayload(req, frame.payload))));
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
    const queued = this.queue;
    this.queue = [];
    this.queueShas = new Set();
    this.queuedBytes = 0;
    for (const req of queued) void this.dispatchSingle(req);
  }

  private async fallbackAll(pending: Map<string, BatchRequest[]>): Promise<void> {
    const groups = [...pending.values()];
    pending.clear();
    await Promise.all(groups.flat().map((req) => this.dispatchSingle(req)));
  }

  // With batching on, the apply pool supplies up to 512 tasks (apply.ts §77
  // comment) — large-blob bypasses, old-server drains, and mass fallbacks must
  // not turn that into 512 concurrent single GETs. Gate every single GET this
  // downloader issues at the pre-batching width.
  private async gatedGetToFile(sha: string, destPath: string): Promise<void> {
    await this.singleGate.run(() => getBlobToFile(this.ctx, sha, destPath));
  }

  private async dispatchSingle(req: BatchRequest): Promise<void> {
    try {
      await this.gatedGetToFile(req.sha, req.destPath);
      req.resolve();
    } catch (e) {
      req.reject(e);
    }
  }
}

export class BlobBatchUploader {
  private readonly config: BatchConfig;
  private queue: BatchPutGroup[] = [];
  private queuedBytes = 0;
  private bySha = new Map<string, BatchPutGroup>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly singleGate = new SingleGate(SINGLE_UPLOAD_FALLBACK_CONCURRENCY);

  constructor(private readonly ctx: RemoteContext) {
    // Upload record bytes stay capped to the server's accepted per-record maximum.
    this.config = readBatchConfig("RBOX_BATCH_PUT_SLOTS", DEFAULT_BATCH_PUT_SLOTS, 32, DEFAULT_BATCH_RECORD_BYTES);
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
    if (!this.canBatch(size)) return this.gatedPutFile(sha, srcPath, size, uploadsDir, onBytes);
    if (uploadDisabledForProcess) return this.timedGatedPutFile(sha, srcPath, size, uploadsDir, onBytes, 0);
    return new Promise<void>((resolve, reject) => {
      this.enqueue(sha, { size, srcPath, uploadsDir, onBytes, resolve, reject });
    });
  }

  private enqueue(sha: string, waiter: BatchPutWaiter): void {
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
    while (this.active < this.config.slots && (this.queue.length >= this.config.records || this.queuedBytes >= this.config.bodyBytes)) {
      this.launch(this.carve());
    }
  }

  private dispatchPartial(): void {
    this.dispatchFull();
    while (this.active < this.config.slots && this.queue.length > 0) this.launch(this.carve());
  }

  private launch(batch: BatchPutGroup[]): void {
    if (batch.length === 0) return;
    this.active++;
    void this.dispatchBatch(batch).finally(() => {
      this.active--;
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
    if (uploadDisabledForProcess) {
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
      if (!body) return;
      armIdle();
      const queueCutoffMs = LANE_TIMING ? performance.now() : 0;
      const res = await this.ctx.fetch(
        `${this.ctx.baseUrl}/v1/blob-batch/put`,
        {
          method: "POST",
          headers: { ...this.ctx.protoAuth, accept: "application/json", "content-type": BATCH_BLOB_CONTENT_TYPE, "content-length": String(body.bytes.byteLength) },
          body: body.bytes,
        },
        { op: "uploading data", timeoutMs: SMALL_CONTROL_TIMEOUT_MS, retries: 0, signal: ctrl.signal },
      );
      if (res.status === 404 || res.status === 405) {
        uploadDisabledForProcess = true;
        this.drainQueuedAsSingles();
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
      await this.fallbackAll(pending);
    } finally {
      if (idle) clearTimeout(idle);
    }
  }

  private async encodeBatchBody(batch: BatchPutGroup[], pending: Map<string, BatchPutGroup>): Promise<{ bytes: Uint8Array; groups: BatchPutGroup[] } | null> {
    const payloads = await Promise.all(batch.map((group) => fs.readFile(group.srcPath)));
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const group of queued) void this.dispatchSingleGroup(group);
  }

  private async fallbackAll(pending: Map<string, BatchPutGroup>): Promise<void> {
    const groups = [...pending.values()];
    pending.clear();
    await Promise.all(groups.map((group) => this.dispatchSingleGroup(group)));
  }

  private async dispatchSingleGroup(group: BatchPutGroup): Promise<void> {
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
    await this.singleGate.run(() => putBlobFile(this.ctx, sha, srcPath, size, uploadsDir, onBytes));
  }
}

async function writePayload(req: BatchRequest, payload: Uint8Array): Promise<void> {
  try {
    await fs.mkdir(path.dirname(req.destPath), { recursive: true });
    await fs.writeFile(req.destPath, payload);
    req.resolve();
  } catch (e) {
    await fs.rm(req.destPath, { force: true }).catch(() => {});
    req.reject(e);
  }
}

function readBatchConfig(slotsEnv: string, slotsDefault: number, slotsMax: number, recordBytesMax: number): BatchConfig {
  return {
    enabled: process.env.RBOX_BATCH_BLOBS !== "0",
    records: envInt("RBOX_BATCH_RECORDS", DEFAULT_BATCH_RECORDS, 1, DEFAULT_BATCH_RECORDS),
    recordBytes: envInt("RBOX_BATCH_RECORD_BYTES", DEFAULT_BATCH_RECORD_BYTES, 1, recordBytesMax),
    bodyBytes: envInt("RBOX_BATCH_BODY_BYTES", DEFAULT_BATCH_BODY_BYTES, 1, DEFAULT_BATCH_BODY_BYTES),
    slots: envInt(slotsEnv, slotsDefault, 1, slotsMax),
  };
}

function framedBytes(payloadBytes: number): number {
  return BATCH_FRAME_HEADER_BYTES + payloadBytes;
}

function parseBatchPutResponse(body: unknown): BatchPutResponseRecord[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) return null;
  const out: BatchPutResponseRecord[] = [];
  for (const raw of (body as { results: unknown[] }).results) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
    if (r.ok === true) {
      if (typeof r.sizeBytes !== "number" || typeof r.receipt !== "string") return null;
      out.push({ sha256: r.sha256, ok: true, sizeBytes: r.sizeBytes, receipt: r.receipt });
    } else if (r.ok === false && (r.error === "sha_mismatch" || r.error === "too_large" || r.error === "r2_error")) {
      out.push({ sha256: r.sha256, ok: false, error: r.error });
    } else {
      return null;
    }
  }
  return out;
}

const textDecoder = new TextDecoder();

function parseStatus(payload: Uint8Array): { status: "missing" | "too_large" | "error" } | null {
  try {
    const body = JSON.parse(textDecoder.decode(payload)) as { status?: unknown };
    return body.status === "missing" || body.status === "too_large" || body.status === "error" ? { status: body.status } : null;
  } catch {
    return null;
  }
}
