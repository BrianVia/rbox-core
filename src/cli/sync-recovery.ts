import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  encryptFileToTemp as defaultEncryptFileToTemp,
  isSourceChangedError,
  poolMap,
  withCryptoPool,
  type EncryptedBlob,
  type EncryptAddressCacheContext,
  type EncryptFileOptions,
  type CryptoPool,
  type CoalescedBlob,
  type FileEntry,
  type Manifest,
  type PhaseReport,
} from "../engine/index.js";
import { BlobRetryLaterError, BlobShaMismatchError, type SyncRemote } from "./remote.js";
import type { WorkspaceConfig } from "./config.js";
import type { TransferProgress } from "./transfer-progress.js";
import { UploadByteTracker } from "./upload-byte-tracker.js";
import { LANE_TIMING, uploadLaneTiming, uploadLaneTimingSummary } from "./upload-lane-timing.js";

// ---- churning-file recovery: encrypt + upload with bounded per-file retry ------------
//
// Extracted from sync.ts so the push orchestration there reads as one flow. This module
// owns the two file-blob recovery mechanisms that resolve WITHIN a single push attempt
// (not a whole-attempt retry): the per-file BlobShaMismatch re-encrypt loop, and the
// defer-churning partial commit (commit the stable subset, defer the file that won't
// settle) — plus the manifest surgery and operator reporting that defer implies.

/** How many times a SINGLE churning file's encrypt+upload is retried before it's
 *  deferred out of this commit (design: partial progress — commit the stable subset,
 *  defer the file that won't settle). Bounded so a perpetually-churning file can never
 *  hot-loop the push; the daemon's watcher/safety scans re-queue it once it settles. */
export const PER_FILE_UPLOAD_ATTEMPTS = 3;

// Concurrency knobs (read at call-time so the bench harness + power users can tune
// via env). Upload is the dominant cost on a first push (latency-bound), so it's
// the highest. Bench sweeps RBOX_UPLOAD_CONCURRENCY to find the real optimum.
const clampConc = (v: string | undefined, dflt: number, max = 512): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : dflt;
};
const encryptConcurrency = (poolWorkers?: number) => clampConc(process.env.RBOX_ENCRYPT_CONCURRENCY, poolWorkers ? poolWorkers * 2 : 8); // CPU/disk bound
const FUSED_ENCRYPT_CONCURRENCY_CAP = 2048;
const fuseEnabled = (): boolean => /^(1|true|yes|on)$/i.test(process.env.RBOX_CRYPTO_FUSE?.trim() ?? "");

export const __syncRecoveryTestHooks = {
  useFusedCrypto(poolAvailable: boolean, customEncryptor: boolean): boolean {
    return poolAvailable && fuseEnabled() && !customEncryptor;
  },
  encryptViaSelectedPath<T>(fuse: boolean, coalesced: () => Promise<T>, oracle: () => Promise<T>): Promise<T> {
    return fuse ? coalesced() : oracle();
  },
};

async function materializeLease(blob: CoalescedBlob, tmpDir: string): Promise<EncryptedBlob> {
  let ciphertextPath: string;
  if (blob.lease.location.kind === "file") {
    ciphertextPath = blob.lease.location.path;
    blob.lease.release();
  } else {
    ciphertextPath = path.join(tmpDir, `${blob.plaintextSha}.${randomBytes(8).toString("hex")}.ct`);
    try { await fs.writeFile(ciphertextPath, blob.lease.location.bytes); }
    finally { blob.lease.release(); }
  }
  return { plaintextSha: blob.plaintextSha, encSha: blob.encSha, ciphertextPath, cipherSize: blob.cipherSize, comp: blob.comp, payloadSha: blob.payloadSha };
}
// 64 is the post-§23 knee. The old default (32) was the knee BEFORE §23, when each PUT did
// ~7 D1 round-trips and concurrency past 32 just multiplied D1 contention. §23 moved D1 off
// the PUT (the hot path is now a pure R2 write), so the upload scales further: a measured
// savvy-core push (4287 blobs, dev) drops ~25% going 32→64 (31s→23s), then regresses by 96
// (R2/connection limits). This — not the §26 batch endpoint — is where the small-blob upload
// win lived before design 80. With upload batching enabled, this pool becomes supply for the
// coalescer, so the default mirrors the pull-side batch supply margin. Env-tunable.
const uploadConcurrency = () => clampConc(process.env.RBOX_UPLOAD_CONCURRENCY, process.env.RBOX_BATCH_BLOBS !== "0" ? 512 : 64); // network/latency bound
const compressionEnabled = () => process.env.RBOX_COMPRESS !== "0";
export { uploadLaneTiming, uploadLaneTimingSummary };
export const uploadConcurrencyForTests = uploadConcurrency;

type EncryptFileToTempForSync = (srcPath: string, kek: Buffer, tmpDir?: string, opts?: EncryptFileOptions) => Promise<EncryptedBlob>;

type CipherDescriptor = {
  encSha: string;
  cipherSize?: number;
  comp?: "zstd";
  payloadSha?: string;
};

function descriptorFromEntry(f: FileEntry): CipherDescriptor | undefined {
  if (!f.encSha) return undefined;
  return f.comp ? { encSha: f.encSha, comp: f.comp, payloadSha: f.payloadSha, cipherSize: f.cipherSize } : { encSha: f.encSha };
}

function descriptorFromEncryptedBlob(e: EncryptedBlob): CipherDescriptor {
  return e.comp ? { encSha: e.encSha, comp: e.comp, payloadSha: e.payloadSha, cipherSize: e.cipherSize } : { encSha: e.encSha };
}

function applyCipherDescriptor(f: FileEntry, descriptor: CipherDescriptor): void {
  f.encSha = descriptor.encSha;
  if (descriptor.comp) {
    f.comp = descriptor.comp;
    f.payloadSha = descriptor.payloadSha;
    f.cipherSize = descriptor.cipherSize;
  } else {
    delete f.comp;
    delete f.payloadSha;
    delete f.cipherSize;
  }
}

export interface EncryptAndUploadOptions {
  encryptFileToTemp?: EncryptFileToTempForSync;
  encryptCacheFlushMs?: number;
  pruneLivePaths?: ReadonlySet<string>;
  /** Addresses reported unsatisfied on prior 422 attempts of this push loop. */
  recoverAddresses?: ReadonlySet<string>;
  /** Recovery accumulation overflowed, so audit the complete refset. */
  forceFullAudit?: boolean;
}

const DEFAULT_ENCRYPT_CACHE_FLUSH_MS = 10_000;
const MAX_SHAS_PER_CHECK = 50_000;
const isRuntimeEpoch = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export async function missingBlobsChunked(api: SyncRemote, shas: string[]): Promise<string[]> {
  const missing = new Set<string>();
  for (let i = 0; i < shas.length; i += MAX_SHAS_PER_CHECK) {
    for (const sha of await api.missingBlobs(shas.slice(i, i + MAX_SHAS_PER_CHECK))) missing.add(sha);
  }
  return [...missing];
}

function encryptAddressCacheContext(cfg: WorkspaceConfig): EncryptAddressCacheContext {
  if (!cfg.accountId) throw new Error("E2EE write context missing accountId; refusing to use encrypt address cache");
  if (!isRuntimeEpoch(cfg.accountEpoch)) throw new Error("E2EE write context missing accountEpoch; refusing to use encrypt address cache");
  if (!isRuntimeEpoch(cfg.keyEpoch)) throw new Error("E2EE write context missing keyEpoch; refusing to use encrypt address cache");
  return {
    accountId: cfg.accountId,
    workspaceId: cfg.remoteWorkspaceId,
    accountEpoch: cfg.accountEpoch,
    keyEpoch: cfg.keyEpoch,
  };
}

type CacheHitStatus = "accept" | "defer";

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function classifyCacheHit(root: string, f: FileEntry): Promise<CacheHitStatus> {
  try {
    const st = await fs.lstat(path.join(root, f.path));
    if (!st.isFile()) return "defer";
    return st.size === f.size && st.mtimeMs === f.mtimeMs ? "accept" : "defer";
  } catch (err) {
    if (hasErrorCode(err, "ENOENT") || hasErrorCode(err, "ENOTDIR")) return "defer";
    throw err;
  }
}

/** Missing sources and snapshots that no longer match the scanned tuple are
 *  deferred; source changes are logged once per attempted cycle. */
function isDeferrableChurn(err: unknown, relPath: string): boolean {
  if (hasErrorCode(err, "ENOENT")) return true;
  if (!isSourceChangedError(err)) return false;
  console.error(`rbox: ${relPath} changed during encryption — deferred`);
  return true;
}

export async function pruneEncryptAddressCache(root: string, cfg: WorkspaceConfig, livePaths: ReadonlySet<string>): Promise<void> {
  const cache = await EncryptAddressCache.load(root, encryptAddressCacheContext(cfg));
  cache.prune(livePaths);
  await cache.save(root);
}

/** Encrypted upload (M5): attach `encSha` to each file entry (reuse the base's
 *  encSha for unchanged files; else convergent-encrypt), then upload the missing
 *  ciphertext blobs by `encSha`. Mutates only `local`'s cipher descriptors; the
 *  scan-time plaintext SHA and size remain authoritative.
 *
 *  Snapshot mismatches and missing sources defer immediately. Ciphertext upload
 *  mismatches retry within a fixed per-file budget. Deferred paths are omitted or
 *  carried from the applied base, so no mismatched plaintext tuple is committed. */
export async function encryptAndUpload(
  api: SyncRemote,
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  base: Manifest,
  report: PhaseReport,
  onProgress: TransferProgress | undefined,
  backoff: (attempt: number) => Promise<void>,
  options: EncryptAndUploadOptions = {}
): Promise<{ deferred: Set<string>; retryLater: Set<string> }> {
  // §28 lifted the old "encryption + git-state aren't supported together" refusal: git artifacts
  // are now convergent-encrypted under the same KEK (planGitSections), so git-sync is E2EE-safe.
  if (!cfg.kek) throw new Error("encrypted workspace but no key loaded — run `rbox key import <recovery-phrase>`");
  const kek = cfg.kek;
  const encryptFileToTemp = options.encryptFileToTemp ?? defaultEncryptFileToTemp;
  const encryptOpts = { compress: compressionEnabled() };
  const encryptCache = await EncryptAddressCache.load(root, encryptAddressCacheContext(cfg));
  const cacheWriter = new EncryptAddressCacheWriter(root, encryptCache, options.encryptCacheFlushMs ?? DEFAULT_ENCRYPT_CACHE_FLUSH_MS);
  const baseEnc = new Map(base.files.map((f) => [f.sha256, descriptorFromEntry(f)]).filter((x): x is [string, CipherDescriptor] => x[1] !== undefined));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-encup-"));
  const ctByEnc = new Map<string, string>();
  const ctSizeByEnc = new Map<string, number>();
  const deferred = new Set<string>();
  const retryLater = new Set<string>();
  try {
    // Carry forward unchanged ciphertext addresses; collect the rest to (re)encrypt.
    const toEncrypt: FileEntry[] = [];
    let carried = 0;
    await report.phase("address", async () => {
      for (const f of local.files) {
        if (f.type !== "file") continue;
        const reuse = baseEnc.get(f.sha256);
        if (reuse) {
          applyCipherDescriptor(f, reuse); // unchanged → reuse ciphertext descriptor (no re-encrypt)
          if (encryptCache.migratePath(f.sha256, f.path)) cacheWriter.schedule();
          carried++;
        } else {
          toEncrypt.push(f);
        }
      }
    });
    report.record("address", { count: carried });
    const runCryptoAndUpload = async (pool: CryptoPool | undefined): Promise<void> => {
      const fuse = __syncRecoveryTestHooks.useFusedCrypto(pool !== undefined, options.encryptFileToTemp !== undefined);
      // Encrypt changed files concurrently (was sequential — slow on a big first push).
      let enc = 0;
      let encCtBytes = 0; // ciphertext this run had to (re)encrypt = §35 "changed bytes"
      let cacheHits = 0;
      let cacheMisses = 0;
      await report.phase("encrypt", async () => {
        // The budget and fused dispatch bound provide real backpressure; this wide
        // caller window only lets the coalescer fill byte/count-bounded groups.
        const encConc = fuse ? Math.min(toEncrypt.length, FUSED_ENCRYPT_CONCURRENCY_CAP) : encryptConcurrency(pool?.workers.length);
        await poolMap(toEncrypt, encConc, async (f) => {
        const t0 = LANE_TIMING ? performance.now() : 0;
        const cached = encryptCache.lookup(f.sha256);
        if (cached) {
          const status = await classifyCacheHit(root, f);
          if (status === "defer") {
            deferred.add(f.path);
            onProgress?.(++enc, toEncrypt.length, "encrypt", f.path);
            return;
          }
          if (status === "accept") {
            cacheHits++;
            applyCipherDescriptor(f, cached);
            ctSizeByEnc.set(cached.encSha, cached.cipherSize);
            encryptCache.record(f.sha256, { ...cached, path: f.path });
            cacheWriter.schedule();
            if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
            onProgress?.(++enc, toEncrypt.length, "encrypt", f.path);
            return;
          }
        }
        cacheMisses++;
        let e;
        try {
          const opts = { ...encryptOpts, expected: { sha256: f.sha256, size: f.size } };
          e = await __syncRecoveryTestHooks.encryptViaSelectedPath(
            fuse,
            async () => materializeLease(await pool!.encryptCoalesced(path.join(root, f.path), f.size, tmpDir, opts), tmpDir),
            async () => encryptFileToTemp(path.join(root, f.path), kek, tmpDir, opts),
          );
        } catch (err) {
          // Vanished between scan and snapshot (agent/build churn deletes files
          // constantly on a live tree). This is the churn case design 38 defers,
          // not a push-fatal error: one vanished file must never kill a 126k-file
          // push. Defer it — deferManifest carries the base entry (or omits a
          // never-synced one) and the next scan sees the deletion for real.
          if (isDeferrableChurn(err, f.path)) {
            deferred.add(f.path);
            onProgress?.(++enc, toEncrypt.length, "encrypt", f.path);
            return;
          }
          throw err;
        }
        applyCipherDescriptor(f, descriptorFromEncryptedBlob(e));
        ctByEnc.set(e.encSha, e.ciphertextPath);
        ctSizeByEnc.set(e.encSha, e.cipherSize);
        encryptCache.record(e.plaintextSha, { ...descriptorFromEncryptedBlob(e), cipherSize: e.cipherSize, path: f.path });
        cacheWriter.schedule();
        encCtBytes += e.cipherSize;
        if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
        onProgress?.(++enc, toEncrypt.length, "encrypt", f.path);
        });
      });
      report.record("encrypt", { count: toEncrypt.length, ciphertextBytes: encCtBytes, changedBytes: encCtBytes });
      // Design 82 §4: address-cache effectiveness travels with the address phase
      // (hits/misses are only known here, after classifyCacheHit ran per file).
      report.recordDetails("address", { cacheHits, cacheMisses }, `hit${cacheHits}m${cacheMisses}`);

    const preflightDelta = process.env.RBOX_PREFLIGHT_DELTA === "1";
    const fullAudit = process.env.RBOX_PREFLIGHT_FULL === "1" || (preflightDelta && options.forceFullAudit === true);

    let encShas: string[];
    let introduced = 0;
    let recover = 0;
    if (fullAudit) {
      const allEncShas = local.files.filter((f) => f.type === "file" && f.encSha).map((f) => f.encSha!);
      encShas = [...new Set(allEncShas)];
    } else if (!preflightDelta) {
      encShas = local.files.filter((f) => f.type === "file" && f.encSha).map((f) => f.encSha!);
    } else {
      const candidate = new Set<string>();
      for (const f of toEncrypt) if (f.encSha && !deferred.has(f.path)) candidate.add(f.encSha);
      introduced = candidate.size;
      for (const sha of options.recoverAddresses ?? []) {
        if (!candidate.has(sha)) recover++;
        candidate.add(sha);
      }
      encShas = [...candidate];
    }
    const missingT0 = LANE_TIMING ? performance.now() : 0;
    const missing = new Set(await report.phase("missing", () =>
      fullAudit ? missingBlobsChunked(api, encShas) : api.missingBlobs(encShas)
    ));
    if (LANE_TIMING) uploadLaneTiming.uploadMs += performance.now() - missingT0;
    report.record("missing", { count: encShas.length });
    if (preflightDelta || fullAudit) {
      report.recordDetails(
        "missing",
        { introduced, recover, sent: encShas.length, fullAudit: fullAudit ? 1 : 0 },
        `i${introduced}r${recover}s${encShas.length}fa${fullAudit ? 1 : 0}`
      );
    }
    if (report.enabled) report.blobs = encShas.length; // guarded: disabled reports are shared singletons
    const uploadsDir = path.join(root, ".rbox", "state", "uploads");

    // The files whose blob still needs uploading (their post-encrypt address is missing
    // server-side). We iterate FILES, not addresses: each file re-encrypts ONLY its own
    // bytes on a retry, so a divergent duplicate can never have another path's snapshot
    // smeared onto it (data-corruption hazard). Convergent duplicates that hash to the
    // same address are deduped by `uploaded` — the second is satisfied without a re-PUT.
    const toUpload = local.files.filter((f): f is FileEntry => f.type === "file" && !!f.encSha && missing.has(f.encSha));
    const uploaded = new Set<string>(); // addresses already landed this run (convergent dedup)
    let up = 0;
    const byteTracker = UploadByteTracker.fromFiles(toUpload, missing, ctSizeByEnc);
    const emitUploadProgress = (currentPath?: string) => onProgress?.(up, toUpload.length, "upload", currentPath, byteTracker.progress());

    /**
     * Upload ONE file's blob with bounded per-file retry. Each retry re-encrypts a fresh
     * snapshot of THIS file and requires it to match `f`'s scanned SHA and size. A changed
     * source defers immediately; repeated ciphertext upload mismatches remain bounded.
     * Mutates only `f`'s cipher descriptor. Returns the
     * wire bytes actually sent (0 if a convergent peer already uploaded the address).
     */
    const uploadFileWithRetry = async (f: FileEntry): Promise<number | null> => {
      for (let attempt = 0; attempt < PER_FILE_UPLOAD_ATTEMPTS; attempt++) {
        if (uploaded.has(f.encSha!)) return 0; // a convergent peer already landed this exact blob
        let ct = ctByEnc.get(f.encSha!);
        if (!ct) {
          // No temp for this address (reused-from-base but server lost it, or a retry):
          // re-encrypt a fresh snapshot of THIS file NOW, but only if it still
          // matches the manifest tuple. Source churn defers rather than patching `f`.
          let re;
          try {
            const t0 = LANE_TIMING ? performance.now() : 0;
            re = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir, {
              ...encryptOpts,
              expected: { sha256: f.sha256, size: f.size },
            });
            if (LANE_TIMING) uploadLaneTiming.encryptMs += performance.now() - t0;
          } catch (err) {
            // Source churn defers instead of mutating the scanned manifest tuple.
            if (isDeferrableChurn(err, f.path)) {
              byteTracker.defer(f.path);
              emitUploadProgress(f.path);
              return null;
            }
            throw err;
          }
          applyCipherDescriptor(f, descriptorFromEncryptedBlob(re));
          const freshEncSha = re.encSha;
          ct = re.ciphertextPath;
          ctByEnc.set(freshEncSha, ct);
          ctSizeByEnc.set(freshEncSha, re.cipherSize);
          encryptCache.record(re.plaintextSha, { ...descriptorFromEncryptedBlob(re), cipherSize: re.cipherSize, path: f.path });
          cacheWriter.schedule();
          if (uploaded.has(freshEncSha)) {
            byteTracker.migrate(f.path, freshEncSha, re.cipherSize);
            emitUploadProgress(f.path);
            return 0; // fresh address already landed by a peer
          }
          if (!missing.has(freshEncSha)) {
            const checkT0 = LANE_TIMING ? performance.now() : 0;
            const present = (await api.missingBlobs([freshEncSha])).length === 0;
            if (LANE_TIMING) uploadLaneTiming.uploadMs += performance.now() - checkT0;
            if (present) {
              uploaded.add(freshEncSha);
              byteTracker.migrate(f.path, undefined);
              emitUploadProgress(f.path);
              return 0; // fresh address is already present remotely; no phase bytes to add
            }
            missing.add(freshEncSha);
          }
          byteTracker.migrate(f.path, freshEncSha, re.cipherSize);
          emitUploadProgress(f.path);
        }
        try {
          const size = (await fs.stat(ct)).size;
          const uploadEncSha = f.encSha!;
          byteTracker.reviseTotal(uploadEncSha, size);
          emitUploadProgress(f.path);
          const callerOwnsLaneTiming = LANE_TIMING && api.ownsUploadLaneTiming?.(size) !== true;
          const t0 = callerOwnsLaneTiming ? performance.now() : 0;
          await api.putBlobFile(uploadEncSha, ct, size, uploadsDir, (abs) => {
            byteTracker.setProgress(uploadEncSha, abs);
            emitUploadProgress(f.path);
          });
          if (callerOwnsLaneTiming) {
            uploadLaneTiming.uploadMs += performance.now() - t0;
            uploadLaneTiming.blobs++;
            uploadLaneTiming.bytes += size;
          }
          byteTracker.setProgress(uploadEncSha, size);
          uploaded.add(uploadEncSha);
          return size; // settled — the committed manifest can safely reference f.encSha
        } catch (e) {
          if (e instanceof BlobRetryLaterError) {
            byteTracker.defer(f.path);
            retryLater.add(f.path);
            emitUploadProgress(f.path);
            return null;
          }
          if (!(e instanceof BlobShaMismatchError)) throw e;
          // The streamed ciphertext no longer hash-matched (the file moved again). Drop
          // the stale temp so the next attempt re-encrypts, back off, and retry — bounded.
          ctByEnc.delete(f.encSha!);
          if (attempt + 1 >= PER_FILE_UPLOAD_ATTEMPTS) {
            byteTracker.defer(f.path);
            emitUploadProgress(f.path);
            return null; // never settled → defer
          }
          await backoff(attempt);
        }
      }
      return null;
    };

    // Upload missing blobs concurrently — THE dominant cost on a first push (each
    // putBlobFile is one round-trip; sequential meant ~3/sec, latency-bound).
    let upWireBytes = 0; // ciphertext bytes actually sent over the wire this run
    await report.phase("upload", async () => {
      await poolMap(toUpload, uploadConcurrency(), async (f) => {
        const size = await uploadFileWithRetry(f);
        if (size === null) {
          deferred.add(f.path); // never settled → defer THIS file only
          return;
        }
        upWireBytes += size;
        up++;
        emitUploadProgress(f.path);
      });
    });
    report.record("upload", { count: up, wireBytes: upWireBytes });
    };

    if (options.encryptFileToTemp === undefined) {
      await withCryptoPool(kek, cfg.keyEpoch, toEncrypt.length, async (pool) => runCryptoAndUpload(pool));
    } else {
      await runCryptoAndUpload(undefined);
    }
  } finally {
    try {
      const livePaths = new Set(options.pruneLivePaths ?? local.files.filter((f) => f.type === "file").map((f) => f.path));
      for (const p of deferred) livePaths.delete(p);
      encryptCache.prune(livePaths);
      cacheWriter.schedule();
      await cacheWriter.flush();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
  return { deferred, retryLater };
}

/** Build the manifest to COMMIT when some files were deferred (never settled under a
 *  churning tree). A deferred file that was previously synced carries its base entry
 *  forward (never a phantom deletion on other machines); a never-synced deferred file
 *  is omitted. Preserves the git section from `local`. */
export function deferManifest(local: Manifest, base: Manifest, deferred: Set<string>): Manifest {
  const baseByPath = new Map(base.files.map((f) => [f.path, f]));
  const files = local.files.filter((f) => !deferred.has(f.path));
  for (const p of deferred) {
    const b = baseByPath.get(p);
    if (b) files.push(b); // previously synced → carry base version (never a deletion)
    // else: never synced → omit (simply absent from this commit)
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...local, files };
}

/** Operator-facing summary for deferred files: the count always (so the push clearly
 *  reports partial progress); the churning paths only under RBOX_DEBUG (noisier, and
 *  lower-signal than the count). */
export function reportDeferred(deferred: Set<string>): void {
  console.error(`rbox: ${deferred.size} file(s) still changing — deferred, will sync once they settle`);
  if (process.env.RBOX_DEBUG) console.error(`rbox: deferred paths: ${[...deferred].sort().join(", ")}`);
}
