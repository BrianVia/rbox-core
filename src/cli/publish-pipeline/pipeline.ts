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
import { isSourceChangedError } from "../../engine/index.js";
import { BlobRetryLaterError, BlobShaMismatchError, type SyncRemote } from "../remote.js";
import type { TransferProgress } from "../transfer-progress.js";
import { UploadByteTracker } from "../upload-byte-tracker.js";
import { LANE_TIMING, uploadLaneTiming } from "../upload-lane-timing.js";
import { fuseEnabled, materializeLease } from "../sync-recovery.js";
import { ResourceBudget } from "./budget.js";
import { EOF, ReadyQueue, type Disposition, type ReadyBlob } from "./ready-queue.js";
import { ReceiptDrainer } from "./receipt-drainer.js";

const MAX_SHAS_PER_CHECK = 50_000;
const ROLLING_CHECK_BATCH = Math.min(5_000, MAX_SHAS_PER_CHECK);
const DEFAULT_QUEUE_BYTES = 256 * 1024 * 1024;
const DEFAULT_QUEUE_ITEMS = 2_048;
const DEFAULT_REDEEM_THRESHOLD = 5_000;
const PER_FILE_UPLOAD_ATTEMPTS = 3;

const clamp = (value: string | undefined, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
};
const encryptConcurrency = (workers?: number) => clamp(process.env.RBOX_ENCRYPT_CONCURRENCY, workers ? workers * 2 : 8, 512);
const uploadConcurrency = () => clamp(process.env.RBOX_UPLOAD_CONCURRENCY, process.env.RBOX_BATCH_BLOBS !== "0" ? 512 : 64, 512);
const hasCode = (error: unknown, code: string): boolean => typeof error === "object" && error !== null && "code" in error && error.code === code;

type EncryptFn = (srcPath: string, kek: Buffer, tmpDir?: string, opts?: EncryptFileOptions) => Promise<EncryptedBlob>;
type Descriptor = { encSha: string; cipherSize?: number; comp?: "zstd"; payloadSha?: string };

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
}

function descriptor(blob: EncryptedBlob): Descriptor {
  return blob.comp ? { encSha: blob.encSha, comp: blob.comp, payloadSha: blob.payloadSha, cipherSize: blob.cipherSize } : { encSha: blob.encSha };
}

function applyDescriptor(file: FileEntry, value: Descriptor): void {
  file.encSha = value.encSha;
  if (value.comp) {
    file.comp = value.comp;
    file.payloadSha = value.payloadSha;
    file.cipherSize = value.cipherSize;
  } else {
    delete file.comp;
    delete file.payloadSha;
    delete file.cipherSize;
  }
}

async function cacheHitStillValid(root: string, file: FileEntry): Promise<boolean> {
  try {
    const stat = await fs.lstat(path.join(root, file.path));
    return stat.isFile() && stat.size === file.size && stat.mtimeMs === file.mtimeMs;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function deferrable(error: unknown): boolean {
  return hasCode(error, "ENOENT") || isSourceChangedError(error);
}

export async function runPublishPipeline(args: PublishPipelineArgs): Promise<{ needsUpload: Set<string> }> {
  const disk = new ResourceBudget(clamp(process.env.RBOX_PIPELINE_QUEUE_BYTES, DEFAULT_QUEUE_BYTES, Number.MAX_SAFE_INTEGER));
  const queue = new ReadyQueue({ maxItems: clamp(process.env.RBOX_PIPELINE_ITEMS, DEFAULT_QUEUE_ITEMS, 1_000_000) });
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
      if (item.ready) releaseBlob(item.ready, "abandoned");
      item.reject(abortCause);
      outstanding--;
    }
    for (const wake of workWaiters.splice(0)) wake();
    for (const wake of abortWakeups) wake();
    abortWakeups.clear();
  };
  const sigint = () => abort(new Error("publish interrupted"));
  process.on("SIGINT", sigint);

  const port = args.api.receiptPort?.();
  const threshold = clamp(process.env.RBOX_PIPELINE_REDEEM_THRESHOLD, DEFAULT_REDEEM_THRESHOLD, 1_000_000);
  const drainer = port ? new ReceiptDrainer(port, { threshold, backlogMax: threshold * 2, onError: abort }) : undefined;
  let drainGeneration = 0;
  const drainWaiters = new Set<() => void>();
  drainer?.onDrainComplete(() => {
    drainGeneration++;
    for (const wake of drainWaiters) wake();
    drainWaiters.clear();
  });

  const releaseBlob = (blob: ReadyBlob, disposition: Disposition): void => blob.release(disposition);
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

  type CheckItem = { file: FileEntry; ready?: ReadyBlob; resolve: (missing: boolean) => void; reject: (error: Error) => void };
  let checkBuffer: CheckItem[] = [];
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let checkerInflight = 0;
  let checked = 0;
  let introduced = 0;
  let recover = 0;
  const checkPromises = new WeakMap<ReadyBlob, Promise<boolean>>();
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
    const promise = new Promise<boolean>((resolve, reject) => checkBuffer.push({ file, ready, resolve, reject }));
    // A producer can be blocked in queue.push when abort rejects its classification.
    // Mark it handled immediately; callers still observe the original rejection.
    void promise.catch(() => {});
    if (ready) checkPromises.set(ready, promise);
    if (checkBuffer.length >= ROLLING_CHECK_BATCH) void flushChecks().catch(abort);
    else if (!checkTimer) {
      checkTimer = setTimeout(() => { checkTimer = undefined; void flushChecks().catch(abort); }, 50);
    }
    return promise;
  };
  const submitAddressCheck = (file: FileEntry): void => {
    void submitCheck(file).catch(abort);
  };

  flushChecks = async (): Promise<void> => {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = undefined; }
    if (scope.signal.aborted) return;
    if (checkBuffer.length === 0) { maybeClose(); return; }
    const batch = checkBuffer.splice(0, ROLLING_CHECK_BATCH);
    checkerInflight++;
    try {
      const addresses = [...new Set(batch.map((item) => item.file.encSha!))];
      const t0 = LANE_TIMING ? performance.now() : 0;
      const missing = new Set(await args.api.missingBlobs(addresses));
      if (LANE_TIMING) uploadLaneTiming.uploadMs += performance.now() - t0;
      checked += addresses.length;
      for (const item of batch) {
        const isMissing = missing.has(item.file.encSha!);
        if (isMissing && !item.ready) enqueueWork(item.file, true);
        if (isMissing && item.ready) upTotal++;
        if (!isMissing && item.ready) releaseBlob(item.ready, "satisfied-skip");
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
  let encCtBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const encryptOne = async (file: FileEntry, forceEncrypt: boolean): Promise<void> => {
    const t0 = LANE_TIMING ? performance.now() : 0;
    const cached = forceEncrypt ? undefined : args.encryptCache.lookup(file.sha256);
    if (cached) {
      if (!(await cacheHitStillValid(args.root, file))) {
        args.deferred.add(file.path);
        args.onProgress?.(++encDone, args.toEncrypt.length, "encrypt", file.path);
        return;
      }
      cacheHits++;
      applyDescriptor(file, cached);
      args.encryptCache.record(file.sha256, { ...cached, path: file.path });
      args.cacheWriter.schedule();
      if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
      args.onProgress?.(++encDone, args.toEncrypt.length, "encrypt", file.path);
      submitAddressCheck(file);
      return;
    }
    cacheMisses++;
    const reservation = file.size + file.size + 4096;
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
      if (deferrable(error)) {
        args.deferred.add(file.path);
        args.onProgress?.(++encDone, args.toEncrypt.length, "encrypt", file.path);
        return;
      }
      throw error;
    }
    disk.reconcile(reservation, encrypted.cipherSize);
    applyDescriptor(file, descriptor(encrypted));
    args.encryptCache.record(encrypted.plaintextSha, { ...descriptor(encrypted), cipherSize: encrypted.cipherSize, path: file.path });
    args.cacheWriter.schedule();
    encCtBytes += encrypted.cipherSize;
    if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
    args.onProgress?.(++encDone, args.toEncrypt.length, "encrypt", file.path);
    const ready = makeReady(file, encrypted);
    const classification = submitCheck(file, ready);
    try {
      if (scope.signal.aborted) releaseBlob(ready, "abandoned");
      else await queue.push(ready);
      await classification;
    } catch (error) {
      releaseBlob(ready, "abandoned");
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
  let up = 0;
  let upTotal = 0;
  let upWireBytes = 0;
  const emitUpload = (file?: FileEntry) => args.onProgress?.(up, upTotal, "upload", file?.path, byteTracker.progress());
  const waitForBacklog = async (): Promise<void> => {
    if (!port || !drainer) return;
    while (port.receiptCount() > drainer.backlogMax) {
      if (scope.signal.aborted) throw abortCause;
      const before = drainGeneration;
      await new Promise<void>((resolve) => {
        const wake = () => { abortWakeups.delete(wake); resolve(); };
        drainWaiters.add(wake);
        abortWakeups.add(wake);
        if (drainGeneration !== before || port.receiptCount() <= drainer.backlogMax) { drainWaiters.delete(wake); wake(); }
      });
      if (scope.signal.aborted) throw abortCause;
    }
  };

  const uploadReady = async (initial: ReadyBlob): Promise<number | null> => {
    let current = initial;
    for (let attempt = 0; attempt < PER_FILE_UPLOAD_ATTEMPTS; attempt++) {
      const file = current.file;
      if (uploaded.has(current.encSha)) { releaseBlob(current, "duplicate-skip"); return 0; }
      byteTracker.migrate(file.path, current.encSha, current.cipherSize);
      emitUpload(file);
      await waitForBacklog();
      if (scope.signal.aborted) { releaseBlob(current, "abandoned"); throw abortCause; }
      try {
        byteTracker.reviseTotal(current.encSha, current.cipherSize);
        const callerOwnsTiming = LANE_TIMING && args.api.ownsUploadLaneTiming?.(current.cipherSize) !== true;
        const t0 = callerOwnsTiming ? performance.now() : 0;
        await args.api.putBlobFile(current.encSha, current.path, current.cipherSize, args.uploadsDir, (absolute) => {
          byteTracker.setProgress(current.encSha, absolute);
          emitUpload(file);
        });
        if (callerOwnsTiming) {
          uploadLaneTiming.uploadMs += performance.now() - t0;
          uploadLaneTiming.blobs++;
          uploadLaneTiming.bytes += current.cipherSize;
        }
        byteTracker.setProgress(current.encSha, current.cipherSize);
        uploaded.add(current.encSha);
        drainer?.capture();
        releaseBlob(current, "uploaded");
        return current.cipherSize;
      } catch (error) {
        releaseBlob(current, "uploaded");
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
        const reservation = file.size + file.size + 4096;
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
          if (deferrable(retryError)) { byteTracker.defer(file.path); emitUpload(file); return null; }
          throw retryError;
        }
        disk.reconcile(reservation, encrypted.cipherSize);
        if (scope.signal.aborted) {
          const abandoned = makeReady(file, encrypted);
          releaseBlob(abandoned, "abandoned");
          throw abortCause;
        }
        applyDescriptor(file, descriptor(encrypted));
        args.encryptCache.record(encrypted.plaintextSha, { ...descriptor(encrypted), cipherSize: encrypted.cipherSize, path: file.path });
        args.cacheWriter.schedule();
        current = makeReady(file, encrypted);
        byteTracker.migrate(file.path, current.encSha, current.cipherSize);
        if (scope.signal.aborted) { releaseBlob(current, "abandoned"); throw abortCause; }
        const missing = await args.api.missingBlobs([current.encSha]);
        if (missing.length === 0) { releaseBlob(current, "satisfied-skip"); return 0; }
      }
    }
    return null;
  };

  const consumer = async (): Promise<void> => {
    for (;;) {
      if (scope.signal.aborted) return;
      const item = await queue.pull();
      if (item === EOF) return;
      const missing = await checkPromises.get(item)!;
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
    const byAddress = new Map<string, FileEntry>();
    for (const file of args.local.files) if (file.type === "file" && file.encSha) byAddress.set(file.encSha, file);
    if (!args.preflightDelta || args.fullAudit) {
      const seen = args.fullAudit ? new Set<string>() : undefined;
      for (const file of args.local.files) {
        if (file.type !== "file" || !file.encSha || pipelineFiles.has(file) || seen?.has(file.encSha)) continue;
        seen?.add(file.encSha);
        submitAddressCheck(file);
      }
    } else {
      for (const address of args.recoverAddresses ?? []) {
        const file = byAddress.get(address);
        if (file && !pipelineFiles.has(file)) { recover++; submitAddressCheck(file); }
      }
      introduced = args.toEncrypt.length;
    }
    initialFeedClosed = true;
    producers = Array.from({ length: encryptConcurrency(args.pool?.workers.length) }, () => producer());
    consumers = Array.from({ length: uploadConcurrency() }, () => consumer());
    await flushChecks();
    await args.report.phase("upload", async () => {
      await Promise.all([Promise.all(producers), Promise.all(consumers)]);
      await flushChecks();
    });
    args.report.record("encrypt", { count: args.toEncrypt.length, ciphertextBytes: encCtBytes, changedBytes: encCtBytes });
    args.report.recordDetails("address", { cacheHits, cacheMisses }, `hit${cacheHits}m${cacheMisses}`);
    args.report.record("missing", { count: checked });
    if (args.preflightDelta || args.fullAudit) {
      args.report.recordDetails("missing", { introduced, recover, sent: checked, fullAudit: args.fullAudit ? 1 : 0 }, `i${introduced}r${recover}s${checked}fa${args.fullAudit ? 1 : 0}`);
    }
    if (args.report.enabled) args.report.blobs = checked;
    args.report.record("upload", { count: up, wireBytes: upWireBytes });
    const result = drainer ? await drainer.flush() : { needsUpload: [] };
    await Promise.allSettled([...cleanupSettlements]);
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
    for (const blob of [...held]) releaseBlob(blob, "abandoned");
    await Promise.allSettled([...cleanupSettlements]);
    if (drainer?.error) await drainer.flush().catch(() => {});
    throw abortCause;
  } finally {
    if (checkTimer) clearTimeout(checkTimer);
    process.off("SIGINT", sigint);
  }
}
