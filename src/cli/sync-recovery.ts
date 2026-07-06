import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptFileToTemp, poolMap, type FileEntry, type Manifest, type PhaseReport } from "../engine/index.js";
import { BlobShaMismatchError, type SyncRemote } from "./remote.js";
import type { WorkspaceConfig } from "./config.js";
import type { TransferProgress } from "./transfer-progress.js";

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
const clampConc = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 256 ? n : dflt;
};
const encryptConcurrency = () => clampConc(process.env.RBOX_ENCRYPT_CONCURRENCY, 8); // CPU/disk bound
// 64 is the post-§23 knee. The old default (32) was the knee BEFORE §23, when each PUT did
// ~7 D1 round-trips and concurrency past 32 just multiplied D1 contention. §23 moved D1 off
// the PUT (the hot path is now a pure R2 write), so the upload scales further: a measured
// savvy-core push (4287 blobs, dev) drops ~25% going 32→64 (31s→23s), then regresses by 96
// (R2/connection limits). This — not the §26 batch endpoint — is where the small-blob upload
// win actually lives (codex §26 review: DONT-BUILD; the simpler lever captures more). Env-tunable.
const uploadConcurrency = () => clampConc(process.env.RBOX_UPLOAD_CONCURRENCY, 64); // network/latency bound

/** Encrypted upload (M5): attach `encSha` to each file entry (reuse the base's
 *  encSha for unchanged files; else convergent-encrypt), then upload the missing
 *  ciphertext blobs by `encSha`. Mutates `local`'s entries (encSha + fresh sha).
 *
 *  Live-folder resilience: a file that keeps changing under the push can never
 *  produce a ciphertext that hash-matches its committed `encSha` (the blob PUT
 *  400/412s as `sha_mismatch`, or the reused-from-base re-encrypt yields a different
 *  address). Rather than aborting the WHOLE push (the old behavior), each such file
 *  is retried a bounded number of times (re-encrypting a fresh stable snapshot each
 *  time, adopting whatever address that snapshot hashes to); if it still won't settle
 *  it is DEFERRED — returned in `deferred` (by path) so the caller drops it from THIS
 *  commit and lets the daemon re-queue it once it settles. The common stable-file
 *  path (first encrypt → upload that exact temp) is untouched. */
export async function encryptAndUpload(
  api: SyncRemote,
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  base: Manifest,
  report: PhaseReport,
  onProgress: TransferProgress | undefined,
  backoff: (attempt: number) => Promise<void>
): Promise<{ deferred: Set<string> }> {
  // §28 lifted the old "encryption + git-state aren't supported together" refusal: git artifacts
  // are now convergent-encrypted under the same KEK (planGitSections), so git-sync is E2EE-safe.
  if (!cfg.kek) throw new Error("encrypted workspace but no key loaded — run `rbox key import <recovery-phrase>`");
  const kek = cfg.kek;
  const baseEnc = new Map(base.files.filter((f) => f.encSha).map((f) => [f.sha256, f.encSha!]));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-encup-"));
  const ctByEnc = new Map<string, string>();
  const deferred = new Set<string>();
  try {
    // Carry forward unchanged ciphertext addresses; collect the rest to (re)encrypt.
    const toEncrypt: typeof local.files = [];
    for (const f of local.files) {
      if (f.type !== "file") continue;
      const reuse = baseEnc.get(f.sha256);
      if (reuse) f.encSha = reuse; // unchanged → reuse ciphertext address (no re-encrypt)
      else toEncrypt.push(f);
    }
    // Encrypt changed files concurrently (was sequential — slow on a big first push).
    let enc = 0;
    let encCtBytes = 0; // ciphertext this run had to (re)encrypt = §35 "changed bytes"
    await report.phase("encrypt", async () => {
      await poolMap(toEncrypt, encryptConcurrency(), async (f) => {
        let e;
        try {
          e = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir);
        } catch (err) {
          // Vanished between scan and snapshot (agent/build churn deletes files
          // constantly on a live tree). This is the churn case design 38 defers,
          // not a push-fatal error: one vanished file must never kill a 126k-file
          // push. Defer it — deferManifest carries the base entry (or omits a
          // never-synced one) and the next scan sees the deletion for real.
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            deferred.add(f.path);
            onProgress?.(++enc, toEncrypt.length, "encrypt");
            return;
          }
          throw err;
        }
        f.sha256 = e.plaintextSha; // fresh-hashed actual bytes (review #1)
        f.encSha = e.encSha;
        ctByEnc.set(e.encSha, e.ciphertextPath);
        encCtBytes += e.cipherSize;
        onProgress?.(++enc, toEncrypt.length, "encrypt");
      });
    });
    report.record("encrypt", { count: toEncrypt.length, ciphertextBytes: encCtBytes, changedBytes: encCtBytes });

    const encShas = local.files.filter((f) => f.type === "file" && f.encSha).map((f) => f.encSha!);
    const missing = new Set(await api.missingBlobs(encShas));
    report.blobs = encShas.length;
    const uploadsDir = path.join(root, ".rbox", "state", "uploads");

    // The files whose blob still needs uploading (their post-encrypt address is missing
    // server-side). We iterate FILES, not addresses: each file re-encrypts ONLY its own
    // bytes on a retry, so a divergent duplicate can never have another path's snapshot
    // smeared onto it (data-corruption hazard). Convergent duplicates that hash to the
    // same address are deduped by `uploaded` — the second is satisfied without a re-PUT.
    const toUpload = local.files.filter((f): f is FileEntry => f.type === "file" && !!f.encSha && missing.has(f.encSha));
    const uploaded = new Set<string>(); // addresses already landed this run (convergent dedup)

    /**
     * Upload ONE file's blob with bounded per-file retry. Each retry re-encrypts a fresh
     * snapshot of THIS file and adopts whatever address it hashes to, so a moving file
     * eventually pins to a settled snapshot; if it never settles within the bound the file
     * is deferred (returns null). Mutates only `f` (its fresh sha256/encSha). Returns the
     * wire bytes actually sent (0 if a convergent peer already uploaded the address).
     */
    const uploadFileWithRetry = async (f: FileEntry): Promise<number | null> => {
      for (let attempt = 0; attempt < PER_FILE_UPLOAD_ATTEMPTS; attempt++) {
        if (uploaded.has(f.encSha!)) return 0; // a convergent peer already landed this exact blob
        let ct = ctByEnc.get(f.encSha!);
        if (!ct) {
          // No temp for this address (reused-from-base but server lost it, or a retry):
          // re-encrypt a fresh snapshot of THIS file NOW and adopt whatever address it
          // hashes to. Committing the fresh address (not insisting on the stale one) is what
          // lets a file that changed since the manifest was built still upload consistently.
          let re;
          try {
            re = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir);
          } catch (err) {
            // Vanished mid-push (same churn class as the encrypt-stage catch above):
            // defer this file instead of failing the whole push.
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
            throw err;
          }
          f.sha256 = re.plaintextSha;
          f.encSha = re.encSha;
          ct = re.ciphertextPath;
          ctByEnc.set(f.encSha, ct);
          if (uploaded.has(f.encSha)) return 0; // fresh address already landed by a peer
        }
        try {
          const size = (await fs.stat(ct)).size;
          await api.putBlobFile(f.encSha!, ct, size, uploadsDir);
          uploaded.add(f.encSha!);
          return size; // settled — the committed manifest can safely reference f.encSha
        } catch (e) {
          if (!(e instanceof BlobShaMismatchError)) throw e;
          // The streamed ciphertext no longer hash-matched (the file moved again). Drop
          // the stale temp so the next attempt re-encrypts, back off, and retry — bounded.
          ctByEnc.delete(f.encSha!);
          if (attempt + 1 >= PER_FILE_UPLOAD_ATTEMPTS) return null; // never settled → defer
          await backoff(attempt);
        }
      }
      return null;
    };

    // Upload missing blobs concurrently — THE dominant cost on a first push (each
    // putBlobFile is one round-trip; sequential meant ~3/sec, latency-bound).
    let up = 0;
    let upWireBytes = 0; // ciphertext bytes actually sent over the wire this run
    await report.phase("upload", async () => {
      await poolMap(toUpload, uploadConcurrency(), async (f) => {
        const size = await uploadFileWithRetry(f);
        if (size === null) {
          deferred.add(f.path); // never settled → defer THIS file only
          return;
        }
        upWireBytes += size;
        onProgress?.(++up, toUpload.length, "upload");
      });
    });
    report.record("upload", { count: up, wireBytes: upWireBytes });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  return { deferred };
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
