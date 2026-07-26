/**
 * Design 98 Tier 1 — the overlapped first-publish pipeline (flag-gated by
 * RBOX_PUBLISH_PIPELINE, default off; routed from `encryptAndUpload`).
 * Replaces the serialized encrypt → missing-check → upload barriers with one
 * producer-consumer graph under a shared abort scope: a closeable dynamic
 * encrypt lane (producers), a rolling server-satisfied check batching
 * `missingBlobs` calls, and an upload scheduler (consumers) draining a
 * budgeted ReadyQueue. Ciphertext temps are released at DISPOSITION
 * settlement only (uploaded / satisfied-skip / duplicate-skip / abandoned —
 * design 98 §3.2); receipts are redeemed DURING upload by the ReceiptDrainer
 * (§3.3); abort follows the §3.5 barrier order (queue close → uploader close
 * → producer termination → temp cleanup). Normative spec: SPEC-98-T1.md and
 * docs/design/98-first-publish-pipeline.md §3.1–3.6.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CryptoPool,
  EncryptedBlob,
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  EncryptFileOptions,
  FileEntry,
  Manifest,
  PhaseReport,
} from "../../engine/index.js";
import { BlobRetryLaterError, BlobShaMismatchError, type SyncRemote } from "../remote.js";
import type { TransferProgress } from "../transfer-progress.js";
import { UploadByteTracker } from "../upload-byte-tracker.js";
import { TransferRateSampler } from "../transfer-rate.js";
import { firstPublishMeasurementLive, firstPublishMeasurementToken, firstPublishReady, firstPublishTiming, firstPublishUploadEnd, firstPublishUploadStart, LANE_TIMING, uploadLaneTiming } from "../upload-lane-timing.js";
import { timeMissingBlobs } from "../push-tail-timing.js";
import { ResourceBudget } from "./budget.js";
import { EOF, ReadyQueue, type ReadyBlob } from "./ready-queue.js";
import { DEFAULT_REDEEM_THRESHOLD, ReceiptDrainer } from "./receipt-drainer.js";
import {
  MAX_SHAS_PER_CHECK,
  PER_FILE_UPLOAD_ATTEMPTS,
  applyCipherDescriptor,
  classifyCacheHit,
  clampConc,
  descriptorFromEncryptedBlob,
  encryptConcurrency,
  fuseEnabled,
  isDeferrableChurn,
  materializeLease,
  redeemDrainUpload,
  uploadConcurrency,
} from "./shared.js";

const ROLLING_CHECK_BATCH = Math.min(5_000, MAX_SHAS_PER_CHECK);
const DEFAULT_QUEUE_BYTES = 256 * 1024 * 1024;
const DEFAULT_QUEUE_ITEMS = 2_048;

type EncryptFn = (srcPath: string, kek: Buffer, tmpDir?: string, opts?: EncryptFileOptions) => Promise<EncryptedBlob>;

export interface PublishPipelineArgs {
  api: SyncRemote;
  root: string;
  kek: Buffer;
  tmpDir: string;
  toEncrypt: FileEntry[];
  local: Manifest;
  encryptCache: EncryptAddressCache;
  cacheWriter: EncryptAddressCacheWriter;
  encryptOpts: { compress: boolean };
  encryptFileToTemp: EncryptFn;
  report: PhaseReport;
  onProgress?: TransferProgress;
  backoff: (attempt: number) => Promise<void>;
  pool: CryptoPool | undefined;
  preflightDelta: boolean;
  fullAudit: boolean;
  recoverAddresses?: ReadonlySet<string>;
  deferred: Set<string>;
  retryLater: Set<string>;
  uploadsDir: string;
  warningSink?: (line: string) => void;
}

export async function runPublishPipeline(args: PublishPipelineArgs): Promise<{ needsUpload: Set<string> }> {
  const mode = args.fullAudit ? "full-audit" : args.preflightDelta ? "delta" : "legacy";
  const disk = new ResourceBudget(clampConc(process.env.RBOX_PIPELINE_QUEUE_BYTES, DEFAULT_QUEUE_BYTES, Number.MAX_SAFE_INTEGER));
  const queue = new ReadyQueue({ maxItems: clampConc(process.env.RBOX_PIPELINE_ITEMS, DEFAULT_QUEUE_ITEMS, 1_000_000) });
  const held = new Set<ReadyBlob>();
  const cleanupSettlements = new Set<Promise<unknown>>();
  const encryptSettlements = new Set<Promise<unknown>>();
  const scope = new AbortController();
  const abortWakeups = new Set<() => void>();
  let abortCause: Error | undefined;
  let intakeOpen = true;
  const abort = (reason: unknown): void => {
    if (abortCause) return;
    abortCause = reason instanceof Error ? reason : new Error(String(reason));
    intakeOpen = false;
    scope.abort(abortCause);
    queue.abort(abortCause);
    disk.close(abortCause);
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = undefined; }
    const abandonedChecks = checkBuffer.splice(0);
    for (const item of abandonedChecks) {
      item.reject(abortCause);
      outstanding--;
    }
    for (const wake of workWaiters.splice(0)) wake();
    for (const wake of abortWakeups) wake();
    abortWakeups.clear();
  };
  const sigint = () => abort(new Error("publish interrupted"));
  process.on("SIGINT", sigint);

  const port = redeemDrainUpload() ? args.api.receiptPort?.() : undefined;
  const threshold = clampConc(process.env.RBOX_PIPELINE_REDEEM_THRESHOLD, DEFAULT_REDEEM_THRESHOLD, 1_000_000);
  const drainer = port ? new ReceiptDrainer(port, { threshold, backlogMax: threshold * 2, onError: abort }) : undefined;
  drainer?.maybeKick();

  const makeReady = (file: FileEntry, encrypted: EncryptedBlob): ReadyBlob => {
    let released = false;
    const blob: ReadyBlob = {
      file,
      encSha: encrypted.encSha,
      cipherSize: encrypted.cipherSize,
      path: encrypted.ciphertextPath,
      diskCharge: encrypted.cipherSize,
      release(_disposition) {
        if (released) return;
        released = true;
        held.delete(blob);
        const cleanup = fs.rm(blob.path, { force: true }).catch(() => {}).finally(() => cleanupSettlements.delete(cleanup));
        cleanupSettlements.add(cleanup);
        disk.release(blob.diskCharge);
      },
    };
    held.add(blob);
    return blob;
  };

  type CheckItem = { address: string; file?: FileEntry; ready?: ReadyBlob; resolve: (missing: boolean) => void; reject: (error: Error) => void };
  let checkBuffer: CheckItem[] = [];
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let checkerInflight = 0;
  let checked = 0;
  let introduced = 0;
  let recover = 0;
  const work: Array<{ file: FileEntry; forceEncrypt: boolean }> = [];
  const workWaiters: Array<() => void> = [];
  let outstanding = 0;
  let initialFeedClosed = false;
  let readyClosed = false;

  const wakeWorker = (): void => workWaiters.shift()?.();
  const enqueueWork = (file: FileEntry, forceEncrypt = false): void => {
    if (!intakeOpen) return;
    outstanding++;
    work.push({ file, forceEncrypt });
    wakeWorker();
  };

  let flushChecks!: () => Promise<void>;
  const scheduleFlush = (): void => {
    if (checkBuffer.length >= ROLLING_CHECK_BATCH) void flushChecks().catch(abort);
    else if (!checkTimer) {
      checkTimer = setTimeout(() => { checkTimer = undefined; void flushChecks().catch(abort); }, 50);
    }
  };
  const maybeClose = (): void => {
    if (readyClosed || !initialFeedClosed || outstanding !== 0 || checkBuffer.length !== 0 || checkerInflight !== 0) return;
    readyClosed = true;
    queue.closeForWriting();
    for (const wake of workWaiters.splice(0)) wake();
  };

  const submitCheck = (file: FileEntry, ready?: ReadyBlob): Promise<boolean> => {
    if (scope.signal.aborted) {
      const rejected = Promise.reject<boolean>(abortCause ?? new Error("publish aborted"));
      void rejected.catch(() => {});
      return rejected;
    }
    outstanding++;
    const promise = new Promise<boolean>((resolve, reject) => checkBuffer.push({ address: file.encSha!, file, ready, resolve, reject }));
    // A producer can be blocked in queue.push when abort rejects this promise.
    // Mark it handled immediately; the consumer still observes the original rejection.
    void promise.catch(() => {});
    if (ready) ready.check = promise;
    scheduleFlush();
    return promise;
  };
  const submitAddressCheck = (file: FileEntry): void => {
    void submitCheck(file).catch(abort);
  };
  const submitAddressOnlyCheck = (address: string): void => {
    if (scope.signal.aborted) return;
    outstanding++;
    const promise = new Promise<boolean>((resolve, reject) => checkBuffer.push({ address, resolve, reject }));
    void promise.catch(abort);
    scheduleFlush();
  };

  flushChecks = async (): Promise<void> => {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = undefined; }
    if (scope.signal.aborted) return;
    if (checkBuffer.length === 0) { maybeClose(); return; }
    const batch = checkBuffer.splice(0, ROLLING_CHECK_BATCH);
    checkerInflight++;
    try {
      // The kill switch is byte-faithful to the serialized legacy sweep: retain
      // manifest order and duplicate addresses. Delta/full-audit arms are set
      // semantics and keep the rolling request deduplication.
      const addresses = mode === "legacy"
        ? batch.map((item) => item.address)
        : [...new Set(batch.map((item) => item.address))];
      const t0 = LANE_TIMING ? performance.now() : 0;
      const statsT0 = firstPublishTiming.enabled ? performance.now() : 0;
      const missing = new Set(await timeMissingBlobs(args.api, addresses));
      if (firstPublishTiming.enabled) {
        firstPublishTiming.stats.missingCheckWallMs += Math.max(0, Math.round(performance.now() - statsT0));
        for (const address of addresses) {
          if (firstPublishTiming.checkedAddresses.has(address)) continue;
          firstPublishTiming.checkedAddresses.add(address);
          if (missing.has(address)) firstPublishTiming.stats.serverUnsatisfiedTotal++;
          else firstPublishTiming.stats.serverSatisfiedSkipped++;
        }
      }
      if (LANE_TIMING) uploadLaneTiming.uploadMs += performance.now() - t0;
      checked += addresses.length;
      for (const item of batch) {
        const isMissing = missing.has(item.address);
        if (isMissing && item.file && !item.ready) enqueueWork(item.file, true);
        if (isMissing && item.ready) upTotal++;
        if (!isMissing && item.ready) item.ready.release("satisfied-skip");
        item.resolve(isMissing);
        outstanding--;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const item of batch) { item.reject(err); outstanding--; }
      throw err;
    } finally {
      checkerInflight--;
      if (initialFeedClosed && checkBuffer.length > 0) await flushChecks();
      maybeClose();
    }
  };

  let encDone = 0;
  let encBytesDone = 0;
  const encBytesTotal = args.toEncrypt.reduce((sum, file) => sum + file.size, 0);
  const emitEncrypt = (file: FileEntry): void => {
    encDone++;
    encBytesDone += file.size;
    args.onProgress?.(encDone, args.toEncrypt.length, "encrypt", file.path, { bytesDone: encBytesDone, bytesTotal: encBytesTotal });
  };
  let encCtBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const reservationFor = (size: number): number => size + size + 4096;
  const recordEncrypted = (file: FileEntry, encrypted: EncryptedBlob): void => {
    const descriptor = descriptorFromEncryptedBlob(encrypted);
    applyCipherDescriptor(file, descriptor);
    args.encryptCache.record(encrypted.plaintextSha, { ...descriptor, cipherSize: encrypted.cipherSize, path: file.path });
    args.cacheWriter.schedule();
  };
  const encryptOne = async (file: FileEntry, forceEncrypt: boolean): Promise<void> => {
    const t0 = LANE_TIMING ? performance.now() : 0;
    const cached = forceEncrypt ? undefined : args.encryptCache.lookup(file.sha256);
    if (cached) {
      if ((await classifyCacheHit(args.root, file)) === "defer") {
        args.deferred.add(file.path);
        emitEncrypt(file);
        return;
      }
      cacheHits++;
      applyCipherDescriptor(file, cached);
      args.encryptCache.record(file.sha256, { ...cached, path: file.path });
      args.cacheWriter.schedule();
      if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
      emitEncrypt(file);
      submitAddressCheck(file);
      return;
    }
    cacheMisses++;
    const reservation = reservationFor(file.size);
    await disk.reserve(reservation);
    let encrypted: EncryptedBlob;
    try {
      const opts = { ...args.encryptOpts, expected: { sha256: file.sha256, size: file.size } };
      const dispatched = args.pool
        ? fuseEnabled()
          ? args.pool.encryptCoalesced(path.join(args.root, file.path), file.size, args.tmpDir, opts).then((blob) => materializeLease(blob, args.tmpDir))
          : args.pool.encrypt(path.join(args.root, file.path), args.tmpDir, opts)
        : args.encryptFileToTemp(path.join(args.root, file.path), args.kek, args.tmpDir, opts);
      encryptSettlements.add(dispatched);
      try { encrypted = await dispatched; }
      finally { encryptSettlements.delete(dispatched); }
    } catch (error) {
      disk.release(reservation);
      if (isDeferrableChurn(error, file.path, args.warningSink)) {
        args.deferred.add(file.path);
        emitEncrypt(file);
        return;
      }
      throw error;
    }
    disk.reconcile(reservation, encrypted.cipherSize);
    firstPublishReady(encrypted.cipherSize, encrypted.encSha);
    if (forceEncrypt && firstPublishTiming.enabled) firstPublishTiming.stats.reEncryptedOnResume++;
    recordEncrypted(file, encrypted);
    encCtBytes += encrypted.cipherSize;
    if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
    emitEncrypt(file);
    const ready = makeReady(file, encrypted);
    submitCheck(file, ready);
    try {
      if (scope.signal.aborted) throw abortCause;
      await queue.push(ready);
    } catch (error) {
      if (!scope.signal.aborted) ready.release("abandoned");
      throw error;
    }
  };

  const producer = async (): Promise<void> => {
    for (;;) {
      if (scope.signal.aborted) return;
      const item = work.shift();
      if (!item) {
        maybeClose();
        if (readyClosed) return;
        await new Promise<void>((resolve) => workWaiters.push(resolve));
        continue;
      }
      try { await encryptOne(item.file, item.forceEncrypt); }
      finally { outstanding--; maybeClose(); }
    }
  };

  const uploaded = new Set<string>();
  const byteTracker = new UploadByteTracker();
  const rateSampler = new TransferRateSampler();
  let up = 0;
  let upTotal = 0;
  let upWireBytes = 0;
  const emitUpload = (file?: FileEntry) => args.onProgress?.(up, upTotal, "upload", file?.path, rateSampler.sample(byteTracker.progress()));
  const uploadReady = async (initial: ReadyBlob): Promise<number | null> => {
    let current = initial;
    for (let attempt = 0; attempt < PER_FILE_UPLOAD_ATTEMPTS; attempt++) {
      const file = current.file;
      if (uploaded.has(current.encSha)) { current.release("duplicate-skip"); return 0; }
      byteTracker.migrate(file.path, current.encSha, current.cipherSize);
      emitUpload(file);
      if (drainer) await drainer.waitForBacklog({
        aborted: () => (scope.signal.aborted ? (abortCause ?? new Error("publish aborted")) : undefined),
        abortWakeups,
      });
      if (scope.signal.aborted) { current.release("abandoned"); throw abortCause; }
      try {
        byteTracker.reviseTotal(current.encSha, current.cipherSize);
        const callerOwnsTiming = LANE_TIMING && args.api.ownsUploadLaneTiming?.(current.cipherSize) !== true;
        firstPublishUploadStart();
        const t0 = callerOwnsTiming ? performance.now() : 0;
        try {
          await args.api.putBlobFile(current.encSha, current.path, current.cipherSize, args.uploadsDir, (absolute) => {
            byteTracker.setProgress(current.encSha, absolute);
            emitUpload(file);
          });
        } finally { firstPublishUploadEnd(); }
        if (callerOwnsTiming) {
          uploadLaneTiming.uploadMs += performance.now() - t0;
          uploadLaneTiming.blobs++;
          uploadLaneTiming.bytes += current.cipherSize;
        }
        byteTracker.setProgress(current.encSha, current.cipherSize);
        uploaded.add(current.encSha);
        drainer?.capture();
        current.release("uploaded");
        return current.cipherSize;
      } catch (error) {
        current.release("uploaded");
        if (error instanceof BlobRetryLaterError) {
          byteTracker.defer(file.path);
          args.retryLater.add(file.path);
          emitUpload(file);
          return null;
        }
        if (!(error instanceof BlobShaMismatchError)) throw error;
        if (attempt + 1 >= PER_FILE_UPLOAD_ATTEMPTS) {
          byteTracker.defer(file.path);
          emitUpload(file);
          return null;
        }
        await args.backoff(attempt);
        if (scope.signal.aborted) throw abortCause;
        const reservation = reservationFor(file.size);
        await disk.reserve(reservation);
        if (scope.signal.aborted) { disk.release(reservation); throw abortCause; }
        let encrypted: EncryptedBlob;
        try {
          const promise = args.encryptFileToTemp(path.join(args.root, file.path), args.kek, args.tmpDir, {
            ...args.encryptOpts, expected: { sha256: file.sha256, size: file.size },
          });
          encryptSettlements.add(promise);
          try { encrypted = await promise; } finally { encryptSettlements.delete(promise); }
        } catch (retryError) {
          disk.release(reservation);
          if (isDeferrableChurn(retryError, file.path, args.warningSink)) { byteTracker.defer(file.path); emitUpload(file); return null; }
          throw retryError;
        }
        disk.reconcile(reservation, encrypted.cipherSize);
        if (scope.signal.aborted) {
          const abandoned = makeReady(file, encrypted);
          abandoned.release("abandoned");
          throw abortCause;
        }
        recordEncrypted(file, encrypted);
        current = makeReady(file, encrypted);
        byteTracker.migrate(file.path, current.encSha, current.cipherSize);
        if (scope.signal.aborted) { current.release("abandoned"); throw abortCause; }
        const missing = await timeMissingBlobs(args.api, [current.encSha]);
        if (missing.length === 0) { current.release("satisfied-skip"); return 0; }
      }
    }
    return null;
  };

  const consumer = async (): Promise<void> => {
    for (;;) {
      if (scope.signal.aborted) return;
      const item = await queue.pull();
      if (item === EOF) return;
      const missing = await item.check!;
      if (!missing) continue;
      const size = await uploadReady(item);
      if (size === null) args.deferred.add(item.file.path);
      else { upWireBytes += size; up++; emitUpload(item.file); }
    }
  };

  let producers: Promise<void>[] = [];
  let consumers: Promise<void>[] = [];
  try {
    for (const file of args.toEncrypt) enqueueWork(file);
    const pipelineFiles = new Set(args.toEncrypt);
    if (mode !== "delta") {
      // Design 103 parity: legacy fullAudit also sweeps only manifest file addresses; git refs remain commit-422 authority.
      // recoverAddresses are intentionally ignored under fullAudit, also parity: the retry loop CLEARS its recovery
      // accumulator when the full-audit latch trips ("the chunked full audit needs no recovery set", sync.ts
      // accumulateRecoveryPage), and legacy fullAudit builds encShas from local.files alone.
      const seen = mode === "full-audit" ? new Set<string>() : undefined;
      for (const file of args.local.files) {
        if (file.type !== "file" || !file.encSha || pipelineFiles.has(file) || seen?.has(file.encSha)) continue;
        seen?.add(file.encSha);
        submitAddressCheck(file);
      }
    } else {
      const byAddress = new Map<string, FileEntry>();
      for (const file of args.local.files) if (file.type === "file" && file.encSha) byAddress.set(file.encSha, file);
      for (const address of args.recoverAddresses ?? []) {
        const file = byAddress.get(address);
        if (file && !pipelineFiles.has(file)) submitAddressCheck(file);
        else if (!file) submitAddressOnlyCheck(address);
        recover++;
      }
      introduced = args.toEncrypt.length;
    }
    initialFeedClosed = true;
    producers = Array.from({ length: encryptConcurrency(args.pool?.workers.length) }, () => producer());
    const consumerCount = Math.max(1, Math.min(uploadConcurrency(), args.toEncrypt.length + (args.recoverAddresses?.size ?? 0)));
    consumers = Array.from({ length: consumerCount }, () => consumer());
    await flushChecks();
    const encryptWallT0 = firstPublishTiming.enabled ? performance.now() : 0;
    const encryptCpuT0 = firstPublishTiming.enabled ? process.cpuUsage() : undefined;
    await args.report.phase("upload", async () => {
      await Promise.all([Promise.all(producers), Promise.all(consumers)]);
      await flushChecks();
    });
    if (firstPublishTiming.enabled) {
      const wall = performance.now() - encryptWallT0;
      const cpu = process.cpuUsage(encryptCpuT0);
      firstPublishTiming.stats.encryptWallMs = Math.max(0, Math.round(wall));
      firstPublishTiming.stats.producerCpuSaturationPct = wall > 0 ? Math.max(0, Math.round((cpu.user + cpu.system) / (wall * 10))) : 0;
    }
    args.report.record("encrypt", { count: args.toEncrypt.length, ciphertextBytes: encCtBytes, changedBytes: encCtBytes });
    args.report.recordDetails("address", { cacheHits, cacheMisses }, `hit${cacheHits}m${cacheMisses}`);
    args.report.record("missing", { count: checked });
    if (mode !== "legacy") {
      const fullAudit = mode === "full-audit" ? 1 : 0;
      args.report.recordDetails("missing", { introduced, recover, sent: checked, fullAudit }, `i${introduced}r${recover}s${checked}fa${fullAudit}`);
    }
    if (args.report.enabled) args.report.blobs = checked;
    args.report.record("upload", { count: up, wireBytes: upWireBytes });
    const flushToken = firstPublishMeasurementToken();
    const flushT0 = flushToken ? performance.now() : 0;
    const result = drainer ? await drainer.flush() : { needsUpload: [] };
    if (drainer && firstPublishMeasurementLive(flushToken)) {
      firstPublishTiming.stats.finalFlushMs += Math.max(0, Math.round(performance.now() - flushT0));
    }
    await Promise.allSettled([...cleanupSettlements]);
    if (firstPublishTiming.enabled) firstPublishTiming.stats.peakTempDiskBytes = Math.max(0, Math.round(disk.highWater));
    if (disk.used !== 0) throw new Error("publish pipeline disk budget did not drain");
    return { needsUpload: new Set(result.needsUpload) };
  } catch (error) {
    abort(error);
    await args.api.closeUploader?.(abortCause!);
    await Promise.allSettled([...encryptSettlements]);
    await Promise.allSettled(producers);
    await Promise.allSettled(consumers);
    // Design 98 §3.5 / SPEC §7 step 5: Tier 1 has no encryptStream handle;
    // the Tier-2 cancellation bridge is therefore structurally inert here.
    for (const blob of [...held]) blob.release("abandoned");
    await Promise.allSettled([...cleanupSettlements]);
    if (drainer?.error) await drainer.flush().catch(() => {});
    throw abortCause;
  } finally {
    if (firstPublishTiming.enabled) firstPublishTiming.stats.peakTempDiskBytes = Math.max(0, Math.round(disk.highWater));
    if (checkTimer) clearTimeout(checkTimer);
    process.off("SIGINT", sigint);
  }
}
