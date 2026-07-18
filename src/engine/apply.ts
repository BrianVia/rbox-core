import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "./blobstore.js";
import { sameContent } from "./diff.js";
import { hashBytes, hashFile } from "./hash.js";
import { BLOB_CIPHERTEXT_TAG_BYTES, decryptFileToPath } from "./crypto.js";
import { withCryptoPool } from "./crypto-pool.js";
import { assertWithinRoot, RBOX_TMP_PREFIX } from "./fsutil.js";
import { conflictName, type Action } from "./reconcile.js";
import { poolMap } from "./pool.js";
import type { TrashBatch } from "./trash.js";
import type { FileEntry, Manifest } from "./types.js";
import {
  addDirComponentWalks, addPreflightMs, addUniqueDirs, addWritePoolMs,
  applyStatsEnabled, countLstat, countMkdir, countRename, countStage, mkdirCounted,
} from "./apply-stats.js";

/**
 * Push a tree's content into the blob store (the Phase-1 stand-in for "upload
 * missing blobs"). Only file content is stored; symlinks carry their target in
 * the manifest. Returns the count actually uploaded (deduped against the store).
 */
export async function uploadManifestBlobs(
  root: string,
  manifest: Manifest,
  store: BlobStore
): Promise<number> {
  let uploaded = 0;
  for (const entry of manifest.files) {
    if (entry.type !== "file") continue;
    if (await store.has(entry.sha256)) continue;
    await store.put(entry.sha256, await fs.readFile(path.join(root, entry.path)));
    uploaded++;
  }
  return uploaded;
}

export interface ApplyOptions {
  /** Used to name conflict copies created when a precondition fails. */
  device?: string;
  /** ISO timestamp for conflict-copy names; defaults to now. */
  now?: string;
  /** Workspace KEK (M5). When set and an entry has `encSha`, the blob is fetched
   *  by `encSha` (ciphertext) and decrypted+verified before write. */
  kek?: Buffer;
  /** Key epoch for the KEK. Required for worker-pool decrypt selection. */
  keyEpoch?: number;
  /** Max concurrent writes (each fetches+decrypts a blob). Defaults to 16 — the
   *  dominant cost of a pull is per-blob download latency, so this is the lever. */
  concurrency?: number;
  /** Progress over the write phase (download+decrypt). Counts are preserved for
   * compatibility; byte counters are the transfer-percent authority. */
  onProgress?: (done: number, total: number, bytesDone: number, bytesTotal: number) => void;
  /** Local trash tier (design 50). When set, propagated clean deletes and type-flip
   *  directory evictions RENAME here instead of `fs.rm` — bytes stay recoverable. */
  trash?: TrashBatch;
  /** Fired once per type-flip resolved at apply (obstructing dir evicted, or an
   *  ancestor file moved aside). The daemon logs it and counts `lastPull.conflicts`. */
  onTypeFlip?: (relPath: string) => void;
  warningSink?: (line: string) => void;
}

/**
 * Apply reconcile actions to `destRoot` — precondition-checked and
 * non-destructive. Every write stages a temp first, then re-checks the target
 * against the local state reconcile expected (`expectedLocal`); if the user
 * touched the file in the scan→apply window, the current bytes are moved aside
 * to a `.conflict` copy before the remote is published. Deletes that find a
 * changed file move it aside instead of removing it. Writes/conflicts first,
 * deletes last.
 */
export async function applyActions(
  destRoot: string,
  actions: Action[],
  store: BlobStore,
  opts: ApplyOptions = {}
): Promise<void> {
  const measured = applyStatsEnabled();
  const preT0 = measured ? performance.now() : 0;
  let poolStarted = false;
  const device = opts.device ?? "local";
  const now = opts.now ?? new Date().toISOString();

  const deletes = actions.filter((a) => a.kind === "delete");
  const rest = actions.filter((a) => a.kind !== "delete");
  const prepared = new Map<Action, string>();

  // Ancestor preflight (§3): a FILE or SYMLINK squatting on a
  // path component a write needs as a directory makes mkdir throw ENOTDIR. Resolve
  // it once, serially, shallowest-first, BEFORE the parallel write pool — poolMap
  // runs writes concurrently, so two children under one obstruction must never
  // race the same move. These go to a VISIBLE conflict copy (files are cheap; the
  // design deliberately does NOT trash them).
  const needDirs = new Set<string>();
  let dirComponentWalks = 0;
  for (const a of rest) {
    const p = a.kind === "write" ? a.entry.path : a.path;
    const parts = p.split("/");
    if (measured) dirComponentWalks += parts.length - 1;
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]!}` : parts[i]!;
      needDirs.add(acc);
    }
  }
  if (measured) {
    addDirComponentWalks(dirComponentWalks);
    addUniqueDirs(needDirs.size);
  }
  const shallowFirst = [...needDirs].sort((a, b) => a.split("/").length - b.split("/").length);

  // Writes/conflicts target distinct paths and are independent, so fetch+decrypt
  // them through a bounded pool — a pull was a sequential per-blob download, which
  // is latency-bound and slow on a real clone. Deletes (local, cheap) stay last.
  let done = 0;
  let bytesDone = 0;
  const bytesTotal = rest.reduce((sum, action) => sum + transferBytesForEntry(action.entry, opts.kek), 0);
  const envDl = Number(process.env.RBOX_DOWNLOAD_CONCURRENCY);
  // The recorded savvy-core sweep kept improving from 64 to 128 without a D1
  // plateau, so foreground pulls default to 128. Constrained clients can pin
  // RBOX_DOWNLOAD_CONCURRENCY=64; daemon pulls still rely on design 49's
  // background IO priority/throttling instead of a lower command default.
  // §77: the batch coalescer fills batches FROM this pool — 128 tasks can never
  // fill 16 slots × 32 records of batch capacity (measured 2026-07-07: 12.8
  // shas/batch, join 231s vs 202s single-GET). A task awaiting the coalescer is
  // just a promise, so when batching is on the supply scales to slots×records
  // and the coalescer, not this pool, bounds real network parallelism.
  const batchDefault = process.env.RBOX_BATCH_BLOBS !== "0" ? 512 : 128;
  const dlConc = opts.concurrency ?? (Number.isInteger(envDl) && envDl >= 1 && envDl <= 512 ? envDl : batchDefault);
  const encryptedEntryCount = opts.kek
    ? rest.filter((a) => {
        const entry = a.kind === "write" || a.kind === "conflict" ? a.entry : undefined;
        return entry?.type === "file" && !!entry.encSha;
      }).length
    : 0;
  try {
    await withCryptoPool(opts.kek, opts.keyEpoch, encryptedEntryCount, async () => {
      // Detection is serial and shallowest-first; ENOTDIR below an already-found
      // obstruction is equivalent to absence. Other filesystem errors remain fatal.
      // Detection precedes displacement so affected entries can be verified first.
      const obstructed = new Set<string>();
      for (const comp of shallowFirst) {
        try {
          countLstat();
          const st = await fs.lstat(path.join(destRoot, comp));
          if (st.isFile() || st.isSymbolicLink()) obstructed.add(comp);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
          throw error;
        }
      }

      // A file-valued ancestor makes the normal beside-target temp impossible to
      // create. Verify those entries first beside the shallowest obstruction (same
      // filesystem — its parent dir is real). Zero cost on the no-obstruction
      // steady state: no per-entry probing, just the one detection pass above.
      if (obstructed.size > 0) {
        for (const a of rest) {
          const obstruction = shallowestObstructedAncestor(a.entry.path, obstructed);
          if (!obstruction) continue;
          const tmp = tmpName(path.join(destRoot, obstruction));
          try {
            await stageEntryToTemp(tmp, a.entry, store, opts.kek);
          } catch (e) {
            throw stagingError(a.entry.path, e);
          }
          prepared.set(a, tmp);
        }
      }

      // Displacement stays serial and shallowest-first so siblings cannot race
      // one obstruction; every affected entry is already staged+verified above.
      for (const comp of shallowFirst) {
        if (!obstructed.has(comp)) continue;
        opts.onTypeFlip?.(comp);
        await moveAside(destRoot, comp, conflictName(comp, device, now));
      }

      if (measured) addPreflightMs(performance.now() - preT0);
      poolStarted = true;
      const poolT0 = measured ? performance.now() : 0;
      try {
        await poolMap(rest, dlConc, async (a) => {
          if (a.kind === "write") {
            await writeEntry(destRoot, a.entry, a.expectedLocal, store, device, now, {
              kek: opts.kek, trash: opts.trash, onTypeFlip: opts.onTypeFlip, preparedTmp: prepared.get(a),
            });
          } else if (a.kind === "conflict") {
            // Reconcile already decided both sides diverged. Stage and verify the
            // remote first; only then preserve the local at its chosen conflict name.
            await writeEntry(destRoot, a.entry, undefined, store, device, now, {
              kek: opts.kek, trash: opts.trash, onTypeFlip: opts.onTypeFlip, keepLocalAs: a.keepLocalAs, preparedTmp: prepared.get(a),
            });
          }
          bytesDone += transferBytesForEntry(a.entry, opts.kek);
          opts.onProgress?.(++done, rest.length, bytesDone, bytesTotal);
        });
      } finally {
        if (measured) addWritePoolMs(performance.now() - poolT0);
      }
    }, opts.warningSink);
  } finally {
    // Deletes (after the pool) and prepared-temp cleanup deliberately stay outside
    // both intervals. They are ~0 on a fresh join; apply wall is the denominator,
    // so this split is evidence rather than an identity.
    if (measured && !poolStarted) addPreflightMs(performance.now() - preT0);
    await Promise.all([...prepared.values()].map((tmp) => fs.rm(tmp, { force: true }).catch(() => {})));
  }
  for (const a of deletes) {
    await deleteEntry(destRoot, a.path, a.expectedLocal, device, now, opts.trash);
  }
}

function transferBytesForEntry(entry: FileEntry, kek?: Buffer): number {
  if (entry.type !== "file") return 0;
  if (!entry.encSha || !kek) return entry.size;
  return entry.comp ? (entry.cipherSize ?? entry.size + BLOB_CIPHERTEXT_TAG_BYTES) : entry.size + BLOB_CIPHERTEXT_TAG_BYTES;
}

/** Stage the remote entry to a temp, re-check the target, preserve any surprise
 *  bytes as a conflict copy, then atomically publish. `keepLocalAs` (conflict
 *  actions) and `preparedTmp` (obstruction pre-stage) are named fields, not
 *  positionals — both are strings, and transposing them would silently break
 *  verify-before-displace. */
type WriteEntryOptions = {
  kek?: Buffer;
  trash?: TrashBatch;
  onTypeFlip?: (relPath: string) => void;
  keepLocalAs?: string;
  preparedTmp?: string;
};
async function writeEntry(
  destRoot: string,
  entry: FileEntry,
  expectedLocal: FileEntry | undefined,
  store: BlobStore,
  device: string,
  now: string,
  { kek, trash, onTypeFlip, keepLocalAs, preparedTmp }: WriteEntryOptions = {}
): Promise<void> {
  const abs = path.join(destRoot, entry.path);
  await assertWithinRoot(destRoot, abs); // defend symlink+file traversal combo
  await mkdirCounted(path.dirname(abs));

  const tmp = tmpName(abs);
  try {
    if (preparedTmp) {
      countRename();
      await fs.rename(preparedTmp, tmp);
    }
    else {
      try {
        await stageEntryToTemp(tmp, entry, store, kek);
      } catch (e) {
        throw stagingError(entry.path, e);
      }
    }

    // Final precondition: does the target still match what reconcile assumed?
    const current = await currentEntryAt(destRoot, entry.path);
    if (current && keepLocalAs) {
      await moveAside(destRoot, entry.path, keepLocalAs);
    } else if (!sameContent(current, expectedLocal) && current) {
      // The user created/edited it in the window — preserve those bytes.
      await moveAside(destRoot, entry.path, conflictName(entry.path, device, now));
    }

    // Type-flip eviction (§3): currentEntryAt returns undefined for a directory,
    // so the conflict-copy branch above never sees one. A materialized directory
    // squatting on an incoming file/symlink path must be evicted whole before the
    // rename (else `rename(tmp, dir)` is EISDIR — the flat-meadow outage). It goes
    // to trash when present (a visible in-workspace conflict copy would re-push the
    // entire subtree as new adds — a churn bomb), else to a visible conflict copy.
    countLstat();
    const obstruction = await fs.lstat(abs).catch(() => undefined);
    if (obstruction?.isDirectory()) {
      onTypeFlip?.(entry.path);
      if (trash) await trash.put(entry.path);
      else await moveAside(destRoot, entry.path, conflictName(entry.path, device, now));
    }
    countRename();
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Stage one entry's bytes into `tmp` (no publish). Symlink → create the link;
 *  encrypted file → fetch ciphertext by `encSha`, decrypt+verify the plaintext sha
 *  into `tmp`; plain file → stream by sha (download verifies it) + chmod. Shared by
 *  the pull writer (precondition-checked publish) and the version-restore writer
 *  (explicit overwrite). */
/** RBOX_LANE_TIMING=1 — per-lane fetch vs decrypt+write attribution (design 74/76):
 *  the pull's per-blob cost must be decomposable before transport work is
 *  justified. Zero cost when unset. Totals print once per apply via laneTimingSummary. */
const LANE_TIMING = process.env.RBOX_LANE_TIMING === "1";
export const laneTiming = { fetchMs: 0, decryptWriteMs: 0, blobs: 0 };
export function laneTimingSummary(): string | undefined {
  if (!LANE_TIMING || laneTiming.blobs === 0) return undefined;
  const f = laneTiming.fetchMs, d = laneTiming.decryptWriteMs, n = laneTiming.blobs;
  return `lane timing: ${n} blobs · fetch ${(f / 1000).toFixed(1)}s (${((f / (f + d)) * 100).toFixed(0)}%) · decrypt+write ${(d / 1000).toFixed(1)}s (${((d / (f + d)) * 100).toFixed(0)}%) · per-blob fetch ${(f / n).toFixed(1)}ms / local ${(d / n).toFixed(1)}ms`;
}

async function stageEntryToTemp(tmp: string, entry: FileEntry, store: BlobStore, kek?: Buffer): Promise<void> {
  const measured = applyStatsEnabled();
  const t0 = measured ? performance.now() : 0;
  try {
    if (entry.type === "symlink") {
      await fs.symlink(entry.symlinkTarget ?? "", tmp);
      return;
    }
    if (entry.encSha && kek) {
      // Encrypted (M5/E2EE): fetch ciphertext by encSha, decrypt+verify into tmp.
      const ctTmp = `${tmp}.ct`;
      try {
        const laneT0 = LANE_TIMING ? performance.now() : 0;
        const ciphertextSizeHint = entry.comp ? (entry.cipherSize ?? entry.size + BLOB_CIPHERTEXT_TAG_BYTES) : entry.size + BLOB_CIPHERTEXT_TAG_BYTES;
        if (store.getToFile) await store.getToFile(entry.encSha, ctTmp, ciphertextSizeHint);
        else await fs.writeFile(ctTmp, await store.get(entry.encSha));
        const t1 = LANE_TIMING ? performance.now() : 0;
        await decryptFileToPath(ctTmp, kek, entry.sha256, tmp, { comp: entry.comp, payloadSha: entry.payloadSha, maxPlaintextBytes: entry.size });
        if (LANE_TIMING) {
          laneTiming.fetchMs += t1 - laneT0;
          laneTiming.decryptWriteMs += performance.now() - t1;
          laneTiming.blobs++;
        }
      } finally {
        await fs.rm(ctTmp, { force: true }).catch(() => {});
      }
      await fs.chmod(tmp, entry.mode);
      return;
    }
    // Stream large blobs straight to the temp file (no whole-file buffer); the
    // streaming download verifies the sha. Fall back to buffered get otherwise.
    if (store.getToFile) await store.getToFile(entry.sha256, tmp);
    else await fs.writeFile(tmp, await store.get(entry.sha256));
    await fs.chmod(tmp, entry.mode);
  } finally {
    if (measured) countStage(entry.size, performance.now() - t0);
  }
}

/** Staging failures name the entry and retain the original typed error as `cause`. */
function stagingError(relPath: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${relPath}: ${detail}`, { cause });
}

/** Shallowest ancestor of `relPath` present in `obstructed` (in-memory; the
 *  lstat evidence was gathered once by the detection pass). Shallowest matters:
 *  the pre-staged temp is created beside it, where the parent dir is real. */
function shallowestObstructedAncestor(relPath: string, obstructed: ReadonlySet<string>): string | undefined {
  let acc = "";
  const parts = relPath.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]!}` : parts[i]!;
    if (obstructed.has(acc)) return acc;
  }
  return undefined;
}

/**
 * Restore ONE file from a past version onto disk (design 12 §15). Unlike the pull
 * writer this is an EXPLICIT OVERWRITE — no reconcile precondition, no conflict-copy
 * (the user asked for these exact bytes at this version). Still fully guarded: the
 * symlink-parent traversal check, decrypt + plaintext-sha verify, and an atomic
 * rename (so a partial/failed restore never leaves a truncated target). When a
 * trash batch is supplied, the previous on-disk copy is preserved there. Does
 * NOT commit or rewrite history — the next sync sees it as an ordinary local edit.
 */
export async function restoreEntryToPath(
  destRoot: string,
  entry: FileEntry,
  store: BlobStore,
  kek?: Buffer,
  opts: { trash?: TrashBatch } = {}
): Promise<{ previousCopyTrashed: boolean }> {
  const abs = path.join(destRoot, entry.path);
  await assertWithinRoot(destRoot, abs); // defend symlinked-parent escape
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = tmpName(abs);
  try {
    await stageEntryToTemp(tmp, entry, store, kek);
    let previousCopyTrashed = false;
    if (opts.trash) {
      const exists = await fs.lstat(abs).then(() => true, (error: unknown) => {
        if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
        throw error;
      });
      if (exists) {
        previousCopyTrashed = await opts.trash.put(entry.path);
      }
    }
    await fs.rename(tmp, abs); // atomic replace of any existing file/symlink
    return { previousCopyTrashed };
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Remove the target only if it still matches what reconcile expected; if it
 *  changed under us, a concurrent edit beats the propagated delete — move it
 *  aside so the user's bytes survive. A clean-matching delete routes through the
 *  local trash tier when present (design 50) so a cross-machine `rm -rf` stays
 *  recoverable; the dirty branch keeps its VISIBLE conflict copy (cross-machine
 *  visibility is the point there). */
async function deleteEntry(
  destRoot: string,
  rel: string,
  expectedLocal: FileEntry | undefined,
  device: string,
  now: string,
  trash?: TrashBatch
): Promise<void> {
  const abs = path.join(destRoot, rel);
  await assertWithinRoot(destRoot, abs);
  const current = await currentEntryAt(destRoot, rel);
  if (!current) return; // already gone
  if (sameContent(current, expectedLocal)) {
    if (trash) await trash.put(rel);
    else await fs.rm(abs, { force: true });
  } else {
    await moveAside(destRoot, rel, conflictName(rel, device, now));
  }
}

/** The on-disk entry at `rel`, or undefined if absent. Symlink targets are read,
 *  not followed; directories read as undefined (we never delete/overwrite a dir
 *  as if it were a file). */
async function currentEntryAt(destRoot: string, rel: string): Promise<FileEntry | undefined> {
  const abs = path.join(destRoot, rel);
  let st;
  try {
    countLstat();
    st = await fs.lstat(abs);
  } catch (e) {
    // ENOTDIR: a parent component is a file (or was evicted to trash) — the target
    // can't exist, so it's already gone.
    if (hasErrorCode(e, "ENOENT") || hasErrorCode(e, "ENOTDIR")) return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    return { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 };
  }
  if (st.isFile()) {
    return { path: rel, type: "file", sha256: await hashFile(abs), size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
  }
  return undefined; // directory or special file
}

/** A conflict-copy destination must never clobber an EARLIER copy: conflictName
 *  has one-second precision, so two conflicts on the same path in the same second
 *  (same device) collide — probe and suffix `~2`, `~3`… (design 50). */
async function moveAside(destRoot: string, fromRel: string, toRel: string): Promise<void> {
  const from = path.join(destRoot, fromRel);
  countLstat();
  const st = await fs.lstat(from);
  let to = path.join(destRoot, toRel);
  await mkdirCounted(path.dirname(to));
  for (let i = 2; ; i++) {
    if (await moveNoClobber(from, to, st)) return;
    to = path.join(destRoot, `${toRel}~${i}`);
  }
}

/** Move without overwriting an existing conflict name. Each destination claim is
 * exclusive at the filesystem operation itself, avoiding access-then-rename races. */
async function moveNoClobber(from: string, to: string, st: { isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> {
  try {
    if (st.isDirectory()) {
      let ok = false;
      try {
        await fs.mkdir(to);
        ok = true;
      } finally {
        countMkdir(ok);
      }
      await fs.rename(from, to);
      countRename();
    } else if (st.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(from), to);
      await fs.unlink(from);
    } else {
      await fs.link(from, to);
      await fs.unlink(from);
    }
    return true;
  } catch (e) {
    if (hasErrorCode(e, "EEXIST")) return false;
    throw e;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}


let tmpCounter = 0;
function tmpName(abs: string): string {
  const dir = path.dirname(abs);
  return path.join(dir, `${RBOX_TMP_PREFIX}${process.pid}-${tmpCounter++}-${path.basename(abs)}`);
}
