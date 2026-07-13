import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ByteProgressCallback } from "../../../engine/blobstore.js";
import {
  PACK_CONTENT_TYPE,
  PACK_MAX_BODY_BYTES,
  PACK_MAX_MEMBERS,
  packOverheadBytes,
} from "../../../engine/blob-pack.js";
import type { RemoteContext } from "../context.js";
import { BlobRetryLaterError, isRetryLater } from "../errors.js";
import { transferTimeoutMs } from "../resilient.js";
import { fileStream } from "../stream.js";
import { LANE_TIMING, recordPackBuilt, recordPackFallback, recordPackSent, uploadLaneTiming, type PackFallbackReason } from "../../upload-lane-timing.js";
import { PACK_FILL_ABSOLUTE_MS, PACK_FILL_QUIET_MS, packUploadConfig, type PackConfig } from "./config.js";
import { disablePackUploadForProcess, onPackUploadDisabled, packUploadDisabled, type UploadSlotArbiter } from "./gate.js";
import { buildPack, type BuiltPack } from "./packer.js";
import type { BatchPutWaiter } from "./uploader.js";

type GroupOwner = "pack" | "transferred" | "settled";

interface PackWaiter extends BatchPutWaiter {
  done: Promise<void>;
}

interface PackGroup {
  sha: string;
  size: number;
  srcPath: string;
  uploadsDir?: string;
  enqueuedAtMs: number;
  waiters: PackWaiter[];
  owner: GroupOwner;
  dispatchStartedAtMs?: number;
  uploadMs?: number;
  completion: Promise<void>;
  complete: () => void;
}

interface PackResultRecord {
  sha256: string;
  ok: true;
  receipt: string;
}

function packResults(value: unknown): PackResultRecord[] | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) return undefined;
  const out: PackResultRecord[] = [];
  for (const result of (value as { results: unknown[] }).results) {
    if (!result || typeof result !== "object") continue;
    const record = result as { sha256?: unknown; ok?: unknown; receipt?: unknown };
    if (typeof record.sha256 === "string" && record.ok === true && typeof record.receipt === "string") {
      out.push({ sha256: record.sha256, ok: true, receipt: record.receipt });
    }
  }
  return out;
}

/** Schedules temp-file pack construction and PUTs within the shared upload budget. */
export class BlobPackUploader {
  private readonly config: PackConfig;
  private queue: PackGroup[] = [];
  private queuedPayloadBytes = 0;
  private bySha = new Map<string, PackGroup>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastUniqueEnqueueAtMs = 0;
  private activated = false;
  private tailReady = false;
  private activePuts = 0;
  private closed = false;
  private closeError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private inFlight = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private readonly unsubscribePackDisabled: () => void;

  constructor(
    private readonly ctx: RemoteContext,
    private readonly arbiter: UploadSlotArbiter,
    private readonly fallback: (sha: string, waiter: BatchPutWaiter) => void,
    private readonly packBuilder: typeof buildPack = buildPack,
  ) {
    this.config = packUploadConfig();
    this.unsubscribePackDisabled = onPackUploadDisabled(() => this.transferAllUnsettled("disabled_latch"));
    this.arbiter.registerPump(() => {
      this.pump();
      this.armTimer();
    });
  }

  putFile(
    sha: string,
    srcPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback,
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError!);
    return new Promise<void>((resolve, reject) => {
      const waiter = this.makeWaiter({ srcPath, size, uploadsDir, onBytes, resolve, reject });
      const existing = this.bySha.get(sha);
      if (existing) {
        existing.waiters.push(waiter);
        return;
      }
      let complete!: () => void;
      const completion = new Promise<void>((done) => { complete = done; });
      const now = performance.now();
      const group: PackGroup = {
        sha, size, srcPath, uploadsDir, enqueuedAtMs: now,
        waiters: [waiter], owner: "pack", completion, complete,
      };
      this.bySha.set(sha, group);
      this.queue.push(group);
      this.queuedPayloadBytes += size;
      this.lastUniqueEnqueueAtMs = now;
      if (
        !this.activated
        && (this.queue.length >= this.config.minActivationCount || this.queuedPayloadBytes >= this.config.minActivationBytes)
      ) this.activated = true;
      this.pump();
      this.armTimer();
    });
  }

  private makeWaiter(waiter: BatchPutWaiter): PackWaiter {
    let done!: () => void;
    const completion = new Promise<void>((resolve) => { done = resolve; });
    let settled = false;
    return {
      ...waiter,
      done: completion,
      resolve: () => {
        if (settled) return;
        settled = true;
        try { waiter.resolve(); } finally { done(); }
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        try { waiter.reject(error); } finally { done(); }
      },
    };
  }

  private armTimer(): void {
    if (this.closed || this.timer || this.tailReady || this.queue.length === 0) return;
    const now = performance.now();
    const quietRemaining = PACK_FILL_QUIET_MS - (now - this.lastUniqueEnqueueAtMs);
    const absoluteRemaining = PACK_FILL_ABSOLUTE_MS - (now - this.queue[0]!.enqueuedAtMs);
    this.timer = setTimeout(() => this.onTimer(), Math.max(1, Math.min(quietRemaining, absoluteRemaining)));
  }

  private onTimer(): void {
    this.timer = undefined;
    if (this.closed) return;
    if (packUploadDisabled()) {
      this.transferAllUnsettled("disabled_latch");
      return;
    }
    if (this.queue.length === 0) return;
    const now = performance.now();
    if (
      now - this.lastUniqueEnqueueAtMs < PACK_FILL_QUIET_MS
      && now - this.queue[0]!.enqueuedAtMs < PACK_FILL_ABSOLUTE_MS
    ) {
      this.armTimer();
      return;
    }
    if (!this.activated) {
      this.transferPending("not_activated");
      return;
    }
    this.tailReady = true;
    this.pump();
    this.armTimer();
  }

  private pump(): void {
    if (this.closed) return;
    if (packUploadDisabled()) {
      this.transferAllUnsettled("disabled_latch");
      return;
    }
    if (!this.activated) return;
    while (
      this.activePuts < this.config.streams
      && this.queue.length > 0
      && (this.tailReady || this.queuedPayloadBytes >= this.config.targetPayloadBytes)
    ) {
      if (!this.arbiter.tryAcquire()) return;
      const groups = this.carve();
      if (groups.length === 0) {
        this.arbiter.release();
        return;
      }
      if (this.queue.length === 0) this.tailReady = false;
      this.launch(groups);
    }
  }

  private carve(): PackGroup[] {
    const groups: PackGroup[] = [];
    let payload = 0;
    let count = 0;
    while (count < this.queue.length && groups.length < PACK_MAX_MEMBERS) {
      const group = this.queue[count]!;
      const nextCount = groups.length + 1;
      if (payload + group.size + packOverheadBytes(nextCount) > PACK_MAX_BODY_BYTES) break;
      if (groups.length > 0 && payload >= this.config.targetPayloadBytes) break;
      groups.push(group);
      payload += group.size;
      count++;
    }
    this.queue.splice(0, count);
    this.queuedPayloadBytes -= payload;
    return groups;
  }

  private launch(groups: PackGroup[]): void {
    this.activePuts++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const dispatch = this.dispatch(groups, controller);
    this.inFlight.add(dispatch);
    void dispatch.finally(() => this.inFlight.delete(dispatch));
  }

  private async dispatch(groups: PackGroup[], controller: AbortController): Promise<void> {
    let built: BuiltPack | undefined;
    try {
      if (packUploadDisabled()) {
        this.transferGroups(groups, "disabled_latch");
        return;
      }
      const buildT0 = performance.now();
      for (const group of groups) group.dispatchStartedAtMs = buildT0;
      built = await this.packBuilder(groups.map((group) => ({
        sha: group.sha,
        size: group.size,
        srcPath: group.srcPath,
        uploadsDir: group.uploadsDir,
      })));
      const payloadBytes = groups.reduce((sum, group) => sum + group.size, 0);
      recordPackBuilt(groups.length, payloadBytes, built.totalBytes, performance.now() - buildT0);
      if (this.closed) {
        this.rejectGroups(groups, this.closeError!);
        return;
      }
      if (packUploadDisabled()) {
        this.transferGroups(groups, "disabled_latch");
        return;
      }
      const pack = built;
      const packId = randomBytes(16).toString("hex");
      const uploadT0 = performance.now();
      let res: Response;
      try {
        res = await this.ctx.fetch(`${this.ctx.baseUrl}/v1/blob-pack/put`, () => ({
          method: "POST",
          headers: {
            ...this.ctx.protoAuth,
            "content-type": PACK_CONTENT_TYPE,
            "x-rbox-pack-id": packId,
            "x-rbox-pack-sha256": pack.packSha256,
            "content-length": String(pack.totalBytes),
          },
          body: fileStream(pack.path),
          duplex: "half",
        } as RequestInit), {
          op: "uploading data",
          timeoutMs: transferTimeoutMs(pack.totalBytes),
          signal: controller.signal,
        });
      } finally {
        const uploadMs = performance.now() - uploadT0;
        recordPackSent(uploadMs);
        const uploadShareMs = uploadMs / Math.max(1, groups.length);
        for (const group of groups) group.uploadMs = uploadShareMs;
      }

      if (res.status === 404 || res.status === 405 || res.status === 415) {
        disablePackUploadForProcess();
        return;
      }
      const text = await res.text();
      if (isRetryLater(res.status, text)) {
        const owned = groups.filter((group) => group.owner === "pack");
        if (owned.length > 0) recordPackFallback("retry_later");
        this.rejectGroups(owned, new BlobRetryLaterError());
        return;
      }
      if (!res.ok) {
        this.transferGroups(groups, "http_error");
        return;
      }
      let parsed: PackResultRecord[] | undefined;
      try { parsed = packResults(JSON.parse(text)); } catch { parsed = undefined; }
      if (!parsed) {
        this.transferGroups(groups, "parse_error");
        return;
      }
      const bySha = new Map(parsed.map((record) => [record.sha256, record]));
      const hasMissingResult = groups.some((group) => group.owner === "pack" && !bySha.has(group.sha));
      if (hasMissingResult) recordPackFallback("parse_error");
      for (const group of groups) {
        const result = bySha.get(group.sha);
        if (!result) this.transferGroup(group);
        else this.resolveGroup(group, result.receipt);
      }
    } catch (error) {
      if (this.closed) this.rejectGroups(groups, this.closeError!);
      else this.transferGroups(groups, packUploadDisabled() ? "disabled_latch" : "transport");
    } finally {
      // Capacity covers build + upload, not subsequent canonical settlement.
      // Release before waiting on transferred waiters so fallback cannot deadlock.
      this.controllers.delete(controller);
      this.activePuts--;
      this.arbiter.release();
      if (built) {
        await Promise.all(groups.map((group) => group.completion));
        await fs.rm(built.path, { force: true }).catch(() => {});
      }
    }
  }

  private resolveGroup(group: PackGroup, receipt: string): void {
    if (group.owner !== "pack") return;
    group.owner = "settled";
    this.bySha.delete(group.sha);
    try {
      this.ctx.captureReceipt(group.sha, { receipt });
      for (const waiter of group.waiters) {
        try { waiter.onBytes?.(waiter.size); } catch {}
        waiter.resolve();
      }
      if (LANE_TIMING) {
        uploadLaneTiming.queueMs += Math.max(0, (group.dispatchStartedAtMs ?? group.enqueuedAtMs) - group.enqueuedAtMs);
        uploadLaneTiming.uploadMs += group.uploadMs ?? 0;
        uploadLaneTiming.blobs++;
        uploadLaneTiming.bytes += group.size;
      }
    } finally {
      group.complete();
    }
  }

  private rejectGroups(groups: Iterable<PackGroup>, error: unknown): void {
    for (const group of groups) {
      if (group.owner !== "pack") continue;
      group.owner = "settled";
      this.bySha.delete(group.sha);
      for (const waiter of group.waiters) waiter.reject(error);
      group.complete();
    }
  }

  private transferGroup(group: PackGroup): void {
    if (group.owner !== "pack") return;
    group.owner = "transferred";
    this.bySha.delete(group.sha);
    const waiters = group.waiters.slice();
    for (const waiter of waiters) {
      try { this.fallback(group.sha, waiter); } catch (error) { waiter.reject(error); }
    }
    void Promise.all(waiters.map((waiter) => waiter.done)).then(group.complete);
  }

  private transferGroups(groups: Iterable<PackGroup>, reason?: PackFallbackReason): void {
    const owned = [...groups].filter((group) => group.owner === "pack");
    if (reason && owned.length > 0) recordPackFallback(reason);
    for (const group of owned) this.transferGroup(group);
  }

  private transferPending(reason: PackFallbackReason): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.queue;
    this.queue = [];
    this.queuedPayloadBytes = 0;
    this.tailReady = false;
    this.transferGroups(pending, reason);
  }

  private transferAllUnsettled(reason: PackFallbackReason): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.queuedPayloadBytes = 0;
    this.tailReady = false;
    // Stop redundant old-server requests. Their catch/finally paths observe
    // transferred ownership, release permits, and clean their own temp files.
    for (const controller of this.controllers) controller.abort(new DOMException("pack capability unavailable", "AbortError"));
    this.transferGroups([...this.bySha.values()], reason);
  }

  close(error: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.unsubscribePackDisabled();
    this.closed = true;
    this.closeError = error;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.queuedPayloadBytes = 0;
    this.tailReady = false;
    for (const controller of this.controllers) controller.abort(error);
    this.rejectGroups(this.bySha.values(), error);
    this.closePromise = Promise.allSettled([...this.inFlight]).then(() => {});
    return this.closePromise;
  }
}
