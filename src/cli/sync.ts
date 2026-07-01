import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  applyGitState,
  assertGitTargetWithinRoot,
  buildIgnoreMatcher,
  captureGitState,
  diffManifests,
  discoverGitRepos,
  encryptFileToTemp,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  isGitBusy,
  isIgnoreRuleFile,
  preserveGitConflict,
  projectIdentity,
  quarantineAndWipeGitState,
  HashCache,
  MAX_GIT_REPOS,
  PhaseReport,
  poolMap,
  reconcile,
  scanManifest,
  validateManifest,
  type Action,
  type FileEntry,
  type GitIdentity,
  type GitRefScope,
  type GitSection,
  type IgnoreMatcher,
  type Manifest,
  type BlobStore,
} from "../engine/index.js";
import { loadState, saveState, type SyncState, type WorkspaceConfig } from "./config.js";
import { BlobShaMismatchError, RboxApi, type SyncRemote } from "./remote.js";

const apiFor = (cfg: WorkspaceConfig): SyncRemote =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

const MAX_ATTEMPTS = 5;
/** How many times a SINGLE churning file's encrypt+upload is retried before it's
 *  deferred out of this commit (design: partial progress — commit the stable subset,
 *  defer the file that won't settle). Bounded so a perpetually-churning file can never
 *  hot-loop the push; the daemon's watcher/safety scans re-queue it once it settles. */
const PER_FILE_UPLOAD_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, so two hot daemons don't livelock retrying. */
const defaultBackoff = (attempt: number) => sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));

/** Plaintext byte total / file-entry count of a manifest (the §35 "plaintext bytes" basis
 *  + file count). Computed only on the metrics-enabled path (each is an O(files) pass). */
const plaintextBytesOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? f.size : 0), 0);
const fileCountOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? 1 : 0), 0);

/**
 * Injectable dependencies for the sync entry points (design 09 §1). Defaults
 * give production behavior; tests inject an in-memory `SyncRemote` and a no-op
 * `backoff` to exercise the conflict-retry control flow offline & fast. The SAME
 * deps object flows through pull/push/pushManifest/sync and the recursive retry.
 */
export interface SyncDeps {
  cache?: HashCache;
  remote?: SyncRemote;
  backoff?: (attempt: number) => Promise<void>;
  /** Called once per commit-level 409 (parent-sequence conflict). Lets the daemon
   *  tally retry pressure without sync.ts doing metrics I/O (design 09 §3). */
  onCommitConflict?: () => void;
  /** Progress for the long phases of sync (encrypt+upload on push; download on
   *  pull). The CLI renders it on the spinner; the daemon ignores it. `done`/`total`
   *  are blob/entry counts. */
  onProgress?: (done: number, total: number, phase: "encrypt" | "upload" | "download") => void;
  /** Optional per-run phase-timing collector (design §35). Defaulted off; when absent,
   *  the sync path uses a disabled no-op report that allocates nothing — so the daemon's
   *  hot path and no-op tick stay free unless metrics are explicitly enabled. */
  report?: PhaseReport;
  /** Forensic git-sync log sink (design 43 §10): capture/carry/defer/remove summaries on
   *  push, per-repo apply/conflict lines on pull. Default: console.error. The daemon
   *  injects its timestamped logger so the lines land in the daemon log. */
  onGitLog?: (line: string) => void;
}

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

/** Either use the caller's cache (caller owns persistence) or load+save one locally. */
async function withCache(
  root: string,
  provided: HashCache | undefined
): Promise<{ cache: HashCache; save: () => Promise<void> }> {
  if (provided) return { cache: provided, save: async () => {} };
  const cache = await HashCache.load(root);
  return { cache, save: () => cache.save(root) };
}


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
async function encryptAndUpload(
  api: SyncRemote,
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  base: Manifest,
  report: PhaseReport,
  onProgress?: SyncDeps["onProgress"],
  backoff: (attempt: number) => Promise<void> = defaultBackoff
): Promise<{ deferred: Set<string> }> {
  // §28 lifted the old "encryption + git-state aren't supported together" refusal: git artifacts
  // are now convergent-encrypted under the same KEK (captureGitForPush), so git-sync is E2EE-safe.
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
        const e = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir);
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
          const re = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir);
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

// ---- git-sync orchestration (design 43 §§6-7, 9, 13.5) ------------------------------

/** Bundling is CPU/IO heavy — bound concurrent captures (design 43 §6.3). */
const GIT_CAPTURE_CONCURRENCY = 4;
const NO_GIT_FORCE: ReadonlySet<string> = new Set();

/** The push-side new-repo admission cap (design 43 §3 [v2, M4]). Env-overridable for
 *  tests/tuning; the manifest-validation bound stays the hard MAX_GIT_REPOS. The cap
 *  bounds capture WORK for newly-discovered repos — base-carrying repos are ALWAYS
 *  carried, so over-cap can never read as mass deletion on receivers. */
const gitRepoCap = (): number => {
  const n = Number(process.env.RBOX_GIT_REPO_CAP);
  return Number.isInteger(n) && n >= 1 && n <= MAX_GIT_REPOS ? n : MAX_GIT_REPOS;
};

const repoDirOf = (root: string, relPath: string) => (relPath === "." ? root : path.join(root, relPath));
/** The narrower of two ref scopes ("scoped" ⊂ "all") — the projection target for every
 *  cross-scope identity comparison (design 43 §7). */
const narrowerScope = (a: GitRefScope, b: GitRefScope | undefined): GitRefScope => (a === "scoped" || b === "scoped" ? "scoped" : "all");
const projectedKey = (g: GitSection | GitIdentity | undefined, scope: GitRefScope): string => gitIdentityKey(g ? projectIdentity(g, scope) : undefined);
/** Every ciphertext address a git section references (bundle + index + op-state). */
const sectionEncShas = (s: GitSection): string[] => [s.bundleEncSha, ...(s.indexEncSha ? [s.indexEncSha] : []), ...Object.values(s.opState ?? {}).map((r) => r.encSha)];
const emptyToUndef = <T,>(o: Record<string, T>): Record<string, T> | undefined => (Object.keys(o).length ? o : undefined);
const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Local-vs-base divergence, projected onto the narrower of the two scopes (§7).
 *  No base → ANY local git identity is divergence-from-nothing (an independently
 *  created local repo must never be clobbered). No local identity (no repo, empty
 *  repo, deleted/unusable `.git`) → never diverged: there is no committed local work
 *  to preserve, so a clean (re)materialization loses nothing. */
function localDivergedFromBase(localId: GitIdentity | undefined, base: GitSection | undefined): boolean {
  if (!localId) return false;
  if (!base) return true;
  const n = narrowerScope(localId.refScope, base.refScope);
  return projectedKey(localId, n) !== projectedKey(base, n);
}

/** The outcome of push-side git orchestration: the outbound `gitRepos` map, whether it
 *  differs from what the last commit carried, the local-only state after this cycle
 *  (persisted only on a successful commit — recomputed idempotently otherwise), and
 *  the forensic counts for the §10 log line. */
interface GitPushPlan {
  gitRepos?: Record<string, GitSection>;
  changed: boolean;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  captured: string[];
  carried: string[];
  deferred: Array<{ relPath: string; reason: string }>;
  removed: string[];
}

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (pending section, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 */
async function captureGitForPush(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher
): Promise<GitPushPlan> {
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const captured: string[] = [];
  const carried: string[] = [];
  const removed: string[] = [];
  const deferred: Array<{ relPath: string; reason: string }> = [];
  const out: Record<string, GitSection> = {};
  const plan = (): GitPushPlan => {
    // Changed = the outbound map differs from what the LAST COMMIT carried. For a
    // pending repo the last commit carried the pending section itself (see the per-repo
    // base-advance in pushManifest), so the expected-previous map is base ∪ pending —
    // a steady pending carry is NOT a change (no echo-commit storm).
    const prev: Record<string, GitSection> = { ...base, ...(state.gitPendingRemote ?? {}) };
    let changed = false;
    for (const k of new Set([...Object.keys(out), ...Object.keys(prev)])) {
      if (!out[k] || !prev[k] || (out[k] !== prev[k] && JSON.stringify(out[k]) !== JSON.stringify(prev[k]))) {
        changed = true;
        break;
      }
    }
    return {
      gitRepos: emptyToUndef(out),
      changed,
      gitReposRemoved: emptyToUndef(removedMem),
      gitNeedsResolution: emptyToUndef(needsRes),
      gitPendingRemote: emptyToUndef(pending),
      captured,
      carried,
      deferred,
      removed,
    };
  };
  if (!cfg.syncGit) return plan(); // out stays empty → any base entries read as removal (opt-out propagates)
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await discoverGitRepos(root, matcher);
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned when the local `.git` disappears.
  for (const rel of Object.keys(removedMem)) if (!kindByPath.has(rel)) delete removedMem[rel];

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  // New-repo admission budget [v2, M4]: base/pending repos never count as new work.
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;

  const toCapture: string[] = [];
  /** Per-repo failure → defer. Forced (422) repos take the M5 non-looping DROP instead:
   *  their base section references exactly the blobs the server lost, so carrying it
   *  would 422 forever — drop from THIS commit; the daemon re-captures when possible. */
  const deferOne = (rel: string, reason: string) => {
    if (force.has(rel)) {
      deferred.push({ relPath: rel, reason: `${reason} — section dropped from this commit (its blobs are missing server-side)` });
      return;
    }
    const b = base[rel];
    if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo (§6.4)
    deferred.push({ relPath: rel, reason });
  };

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    const pend = pending[rel];

    // Pending unapplied remote [v5]: carry THE PENDING SECTION (the newest known truth),
    // capture suppressed. 422-while-pending [v6] → M5 drop; the pending entry stays for
    // the next pull to refresh (remote re-establishes it or absence-supersedes clears it).
    if (pend) {
      if (force.has(rel)) {
        deferred.push({ relPath: rel, reason: "pending remote section's blobs are missing server-side — dropped this commit; the next pull refreshes it" });
      } else {
        out[rel] = pend;
        carried.push(rel);
      }
      continue;
    }

    if (!kind) {
      if (!baseSec) continue; // never synced, nothing local → nothing to do
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirPresent) {
        // §9: repo dir GONE ENTIRELY → the pusher drops the section (receivers drop
        // their base entry but never touch local .git).
        removed.push(rel);
        delete needsRes[rel];
        continue;
      }
      deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
      continue;
    }

    // Removal memory [v2, B4]: a leftover whose identity still equals the memory is the
    // untouched residue of a remote deletion — NOT re-added. Identity changed → the
    // user worked there → re-adding is intentional; clear the memory and fall through.
    if (!baseSec && removedMem[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === removedMem[rel]) continue;
      delete removedMem[rel];
    }

    // needsResolution [v2, M2]: carry the checkpointed base until the local identity
    // CHANGES from the recorded conflict-time value (republish must be intentional).
    if (needsRes[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === needsRes[rel]) {
        if (baseSec) {
          out[rel] = baseSec;
          carried.push(rel);
        }
        continue;
      }
      delete needsRes[rel];
    }

    const pf = await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) {
      deferOne(rel, pf.reason ?? "preflight failed");
      continue;
    }
    const id = await gitIdentity(repoDirOf(root, rel));
    if (!id) {
      // empty repo (no commits yet): nothing to capture; keep any synced base.
      if (baseSec) {
        out[rel] = baseSec;
        carried.push(rel);
      }
      continue;
    }

    // §7 capture-side carry-forward — the normative shape×scope matrix [v3; v4]:
    //   dir/all-base      → carry on full-identity match (design-02 semantics)
    //   dir/scoped-base   → ALWAYS capture fresh (a projected compare would hide a
    //                       genuinely new local branch forever)
    //   pointer/scoped    → carry on scoped-identity match
    //   pointer/all-base  → the explicit wider-carry exception: carry when the base's
    //                       SCOPED PROJECTION matches (terminates the convergence loop)
    if (baseSec && !force.has(rel)) {
      const carry =
        pf.kind === "dir"
          ? baseSec.refScope === "all" && gitIdentityKey(id) === gitIdentityKey(baseSec)
          : baseSec.refScope === "scoped"
            ? gitIdentityKey(id) === gitIdentityKey(baseSec)
            : gitIdentityKey(id) === projectedKey(baseSec, "scoped");
      if (carry) {
        out[rel] = baseSec;
        carried.push(rel);
        continue;
      }
    }
    if (!baseSec) {
      if (admitted >= cap) {
        deferred.push({ relPath: rel, reason: `over the ${cap}-repo cap — new repo not captured this cycle` });
        continue;
      }
      admitted++;
    }
    toCapture.push(rel);
  }

  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline).
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    try {
      const sec = await captureGitState(repoDirOf(root, rel), api.blobStore(), kek);
      if (sec) {
        out[rel] = sec;
        captured.push(rel);
      } else {
        deferOne(rel, "capture returned nothing (repo vanished mid-capture or failed self-validation)");
      }
    } catch (e) {
      deferOne(rel, `capture failed: ${errMsg(e)}`);
    }
  });

  return plan();
}

/** Format the §10 forensic push line:
 *  `git-sync: captured N (a, b) · carried N · deferred N (p: reason) · removed N (x)` */
function formatGitPushLine(plan: GitPushPlan): string {
  const names = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  const defer = plan.deferred.length ? ` (${plan.deferred.map((d) => `${d.relPath}: ${d.reason}`).join("; ")})` : "";
  return `git-sync: captured ${plan.captured.length}${names(plan.captured)} · carried ${plan.carried.length} · deferred ${plan.deferred.length}${defer} · removed ${plan.removed.length}${names(plan.removed)}`;
}

/** The pull-side git outcome: the per-repo base to persist plus the updated local-only maps. */
interface GitPullOutcome {
  gitRepos?: Record<string, GitSection>;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
}

/**
 * Pull-side git orchestration (design 43 §7, §9, §13.5): iterate
 * `remote.gitRepos ∪ base.gitRepos ∪ gitPendingRemote` per key. Per repo:
 *  - remote ABSENT → conflict-precedence first if a pending repo's local diverged
 *    (§13.5), then clear pending ([v6] absence supersedes pending), record a removal
 *    memory when the local `.git` survives, drop the base entry — NEVER touch local .git.
 *  - unchanged (projected onto the narrower scope) → base advances, no apply.
 *  - local diverged from base → per-repo CONFLICT: preserve remote, checkpoint base to
 *    remote, record `needsResolution` with the conflict-time local identity [v2, M2].
 *  - clean → applyGitState (containment + ignored-subtree refusal BEFORE any mutation);
 *    a removal-memory-matching leftover is treated as ABSENT → clean materialization
 *    (dir: quarantine + ref-wipe first; pointer: NEVER ref-wipe — guarded update-only).
 *  - deferred apply → record `gitPendingRemote`; that repo's base does not advance;
 *    every other repo advances independently.
 */
async function applyGitOnPull(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  remote: Manifest,
  store: BlobStore,
  matcher: IgnoreMatcher,
  glog: (line: string) => void
): Promise<GitPullOutcome> {
  const baseRepos = state.lastSyncedManifest.gitRepos ?? {};
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(applied),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(pending),
  });
  if (!cfg.syncGit) return pack();
  const keys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  if (keys.length === 0) return pack();
  const needKek = (): Buffer => {
    if (!cfg.kek) throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox recover`.");
    return cfg.kek;
  };

  for (const rel of keys) {
    const remoteSec = remote.gitRepos?.[rel];
    const baseSec = baseRepos[rel];
    const pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);

    // Receiver quiescence FIRST (design 43 §7): a busy repo defers only itself. This
    // must run BEFORE any identity comparison — a lock makes write-tree fail, flipping
    // gitIdentity onto the raw-index fallback, which would read as FALSE divergence
    // (spurious conflict) or poison a removal memory with a transient key.
    if (dotGit && (remoteSec !== undefined || baseSec !== undefined || pend !== undefined) && (await isGitBusy(repoDir))) {
      if (remoteSec) pending[rel] = remoteSec; // retry next pull; outbound carries newest truth
      glog(`git-sync deferred ${rel}: receiver git busy`);
      continue;
    }
    const localId = dotGit ? await gitIdentity(repoDir) : undefined;

    if (!remoteSec) {
      // §9 removal + [v6] absence-supersedes-pending. §13.5 precedence: if the remote
      // deleted a pending repo whose LOCAL identity also changed, the conflict path wins
      // FIRST (preserve local + recovery from the pending section) — never stamp a
      // removal memory over unexamined local divergence.
      if (pend && localDivergedFromBase(localId, baseSec)) {
        const { recoveryBundle } = await preserveGitConflict(repoDir, pend, store, needKek());
        glog(
          `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}`
        );
      }
      delete pending[rel];
      delete needsRes[rel];
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched)`);
      }
      if (dotGit) removedMem[rel] = gitIdentityKey(localId); // resurrection guard [v2, B4]
      continue;
    }

    // Removal memory: a leftover whose identity still EQUALS the memory is treated as
    // ABSENT (clean materialization target [v3/v4]); a leftover that CHANGED re-enters
    // the normal rules (conflict path) with the memory cleared.
    let cleanMaterialize = false;
    if (removedMem[rel] !== undefined) {
      if (!dotGit) delete removedMem[rel]; // leftover gone → memory pruned; plain fresh target
      else if (gitIdentityKey(localId) === removedMem[rel]) cleanMaterialize = true;
      else delete removedMem[rel];
    }

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    if (!remoteChanged && !pend) {
      applied[rel] = remoteSec; // unchanged → base advances (possibly across scopes)
      continue;
    }

    // Already converged? (e.g. a pending retry finding the user manually resolved, or a
    // remote change that equals local work) → advance base, clear pending, no mutation.
    // A removal-memory leftover never takes this shortcut: it must go through the §9
    // clean-materialization path (wipe on dir targets) so stale refs can't survive.
    if (localId && !cleanMaterialize) {
      const n = narrowerScope(localId.refScope, remoteSec.refScope);
      if (projectedKey(localId, n) === projectedKey(remoteSec, n)) {
        applied[rel] = remoteSec;
        delete pending[rel];
        delete removedMem[rel];
        continue;
      }
    }

    const kek = needKek();
    if (!cleanMaterialize && localDivergedFromBase(localId, baseSec)) {
      // Per-repo conflict: never auto-clobber local. Preserve remote for manual merge,
      // checkpoint base to remote (stop pull-conflict-looping), and suppress capture
      // until the local identity changes from this recorded value [v2, M2].
      const { recoveryBundle } = await preserveGitConflict(repoDir, remoteSec, store, kek);
      applied[rel] = remoteSec;
      needsRes[rel] = gitIdentityKey(localId);
      delete pending[rel];
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually.`);
      continue;
    }

    // Clean apply. Refusals and containment run BEFORE any mutation [v2, B5].
    const defer = (reason: string) => {
      pending[rel] = remoteSec; // [v5]: outbound pushes now carry THIS section; retry next pull
      glog(`git-sync deferred ${rel}: ${reason}`);
    };
    if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
      defer("target is inside an ignored subtree — refusing to materialize");
      continue;
    }
    try {
      await assertGitTargetWithinRoot(root, rel);
    } catch (e) {
      defer(errMsg(e));
      continue;
    }

    if (cleanMaterialize && dotGit) {
      if (dotGit.isDirectory()) {
        // Dir leftover [v5]: quarantine (capture-grade pinning + index/op-state copies)
        // then wipe syncable refs/index/op-state, so the leftover's old refs can never
        // re-enter a later all-scope capture. Quarantine failure → defer, never wipe.
        try {
          await quarantineAndWipeGitState(repoDir);
          delete removedMem[rel]; // leftover is quarantined + wiped — memory served its purpose
        } catch (e) {
          defer(`clean-materialization quarantine failed: ${errMsg(e)}`);
          continue;
        }
      }
      // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
      // update-only apply below is the whole treatment; memory clears on success.
    }

    const res = await applyGitState(repoDir, remoteSec, store, kek);
    if (res.applied) {
      // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (e) {
        glog(`git-sync WARNING ${rel}: post-apply containment check failed: ${errMsg(e)}`);
      }
      applied[rel] = remoteSec;
      delete pending[rel];
      delete removedMem[rel];
      glog(`git-sync applied ${rel}${res.filteredRefs?.length ? ` (filtered refs: ${res.filteredRefs.join(" ")})` : ""}`);
    } else {
      defer(res.reason ?? "apply deferred");
    }
  }
  return pack();
}

/**
 * Pull the latest remote manifest and reconcile it onto the local tree. The
 * reconcile base is the last-synced manifest; after applying, the new base is
 * the remote we just pulled. The remote manifest is validated before it touches
 * the filesystem (never trust the network). Returns the actions taken.
 */
export async function pull(root: string, cfg: WorkspaceConfig, deps: SyncDeps = {}): Promise<Action[]> {
  const api = deps.remote ?? apiFor(cfg);
  const { sequence, manifest: remote } = await api.latest();

  const v = validateManifest(remote);
  if (!v.ok) throw new Error(`refusing to apply invalid remote manifest: ${v.error}`);

  const state = await loadState(root);
  const report = deps.report ?? PhaseReport.disabled("pull");
  const { cache, save } = await withCache(root, deps.cache);
  const matcher = buildIgnoreMatcher(root);
  const local = await report.phase("scan", () => scanManifest(root, matcher, cache));
  if (report.enabled) {
    report.files = fileCountOf(local);
    report.record("scan", { count: report.files, plaintextBytes: plaintextBytesOf(local) });
  }

  // E2EE is the only mode (D6): the KEK is injected by buildAuthedRemote. A remote
  // manifest with encrypted entries but no key on this device → fail closed.
  const kek = cfg.kek;
  if (!kek && remote.files.some((f) => f.encSha)) {
    throw new Error("E2EE required: this workspace is encrypted but no key on this device — run `rbox pair` or `rbox recover`.");
  }

  // A remote entry that LOCAL rules ignore must never touch this tree — neither
  // written (an old client may have synced a `.git` pointer file before it was a
  // builtin ignore; applying it would plant a machine-local path here) nor deleted
  // (a remote removal must not delete the REAL, never-synced artifact this machine
  // has at that path). Ignored entries stay untouched in the recorded base, so they
  // aren't pushed back as deletions either (same forward-only rule as push).
  //
  // TWO-PHASE apply when the pull itself changes the RULES: rule-file actions
  // (.rboxignore/.gitignore writes/deletes) land first, the matcher is rebuilt
  // from the updated disk state, and only then are the remaining actions filtered.
  // Filtering everything through the PRE-pull matcher would drop a file a relaxed
  // rule just un-ignored — it would never land locally, and the follow-up push
  // would commit its deletion back to the remote (a data-loss echo).
  const pathOf = (a: Action) => (a.kind === "write" ? a.entry.path : a.path);
  const all = reconcile(state.lastSyncedManifest, local, remote, cfg.deviceId, new Date().toISOString());
  const ruleActions = all.filter((a) => isIgnoreRuleFile(pathOf(a)) && !matcher.ignores(pathOf(a)));
  const applyOpts = {
    device: cfg.deviceId,
    kek,
    onProgress: deps.onProgress ? (done: number, total: number) => deps.onProgress!(done, total, "download") : undefined,
  };
  let actions: Action[] = [];
  let finalMatcher = matcher; // the post-pull rules — also gates git materialization below
  await report.phase("apply", async () => {
    if (ruleActions.length > 0) await applyActions(root, ruleActions, api.blobStore(), applyOpts);
    const fresh = ruleActions.length > 0 ? buildIgnoreMatcher(root) : matcher;
    finalMatcher = fresh;
    const rest = all.filter((a) => !isIgnoreRuleFile(pathOf(a)) && !fresh.ignores(pathOf(a)));
    await applyActions(root, rest, api.blobStore(), applyOpts);
    actions = [...ruleActions, ...rest];
  });
  if (report.enabled) {
    const writeActions = actions.filter((a): a is Extract<Action, { kind: "write" }> => a.kind === "write");
    report.blobs = writeActions.length;
    report.record("apply", { count: writeActions.length, plaintextBytes: writeActions.reduce((n, a) => n + a.entry.size, 0) });
  }

  // Paths we just wrote/removed changed on disk — invalidate so the next scan
  // re-hashes them from real disk truth (never trust a stale cache entry there).
  for (const a of actions) {
    if (a.kind === "write") cache.invalidate(a.entry.path);
    else if (a.kind === "delete") cache.invalidate(a.path);
    else if (a.kind === "conflict") {
      cache.invalidate(a.path);
      cache.invalidate(a.keepLocalAs);
    }
  }
  await save();

  // Git repos (design 43 §7): per-repo loop over remote ∪ base ∪ pending with
  // scope-projected identity, per-repo base advance (one busy repo never blocks the
  // others), removal memories, needs-resolution checkpoints, pending-remote carry.
  const gitOutcome = await applyGitOnPull(root, cfg, state, remote, api.blobStore(), finalMatcher, deps.onGitLog ?? ((l) => console.error(l)));
  await saveState(root, {
    lastSyncedSequence: sequence,
    lastSyncedManifest: { ...remote, gitRepos: gitOutcome.gitRepos },
    gitReposRemoved: gitOutcome.gitReposRemoved,
    gitNeedsResolution: gitOutcome.gitNeedsResolution,
    gitPendingRemote: gitOutcome.gitPendingRemote,
  });
  return actions;
}

/**
 * Scan and push. Convenience wrapper for CLI one-shots — the daemon uses
 * {@link pushManifest} directly with its incrementally-patched in-memory manifest.
 */
export async function push(root: string, cfg: WorkspaceConfig, deps: SyncDeps = {}, purgeIgnored = false): Promise<number> {
  const report = deps.report ?? PhaseReport.disabled("push");
  const { cache, save } = await withCache(root, deps.cache);
  const local = await report.phase("scan", () => scanManifest(root, undefined, cache));
  await save();
  if (report.enabled) {
    report.files = fileCountOf(local);
    report.record("scan", { count: report.files, plaintextBytes: plaintextBytesOf(local) });
  }
  return (await pushManifest(root, cfg, local, deps, 0, purgeIgnored)).sequence;
}

/**
 * Push a pre-computed manifest: upload missing blobs, commit. Short-circuits to a
 * no-op (no upload, no commit) when nothing changed vs the last-synced manifest —
 * this is what keeps continuous bidirectional sync from echo-storming (a pull
 * writes exactly the last-synced bytes, so the next push sees no diff). A 409
 * conflict pulls, RE-SCANS (disk changed), and retries (bounded, backed off); a
 * 422 re-uploads the named blobs and retries. A file that keeps changing under the
 * push (never producing a hash-matching ciphertext) is DEFERRED rather than aborting
 * the whole push: the stable subset commits, and the deferred paths are returned so
 * the daemon can re-queue them once they settle. Returns the sequence now in effect,
 * the manifest that reflects it (so a caller holding an in-memory manifest can keep it
 * fresh even across a conflict re-scan), and the deferred paths (empty when none).
 */
export async function pushManifest(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps = {},
  attempt = 0,
  purgeIgnored = false,
  forceGitRecapture: ReadonlySet<string> = NO_GIT_FORCE
): Promise<{ sequence: number; manifest: Manifest; deferred?: string[] }> {
  const api = deps.remote ?? apiFor(cfg);
  const backoff = deps.backoff ?? defaultBackoff;
  const state = await loadState(root);
  const matcher = buildIgnoreMatcher(root); // shared: forward-only ignore carry + git discovery

  // Forward-only ignore (M3b): a file that was synced but is now ignored should
  // NOT read as a deletion on other machines. Carry forward its last-synced entry
  // unless --purge explicitly requests propagating the deletion. (A real `rm` of a
  // non-ignored file is still absent-and-not-ignored → a genuine deletion.)
  if (!purgeIgnored) {
    const present = new Set(local.files.map((f) => f.path));
    const carried = state.lastSyncedManifest.files.filter((e) => !present.has(e.path) && matcher.ignores(e.path));
    if (carried.length) {
      local = { ...local, files: [...local.files, ...carried].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
    }
  }

  // Attach the git sections (design 43 §6): per-repo carry/capture/defer/remove map
  // orchestration. `forceGitRecapture` is the per-relPath 422 recapture set [v2, M5]:
  // a git artifact missing server-side can't be satisfied by a file re-upload — ONLY
  // the repos whose sections reference the missing encShas recapture; the force lives
  // at this single site (the recursion recomputes the map) or the recovery is dead.
  const gitPlan = await captureGitForPush(root, cfg, state, api, forceGitRecapture, matcher);
  local = { ...local, manifestSchema: gitPlan.gitRepos ? 2 : local.manifestSchema, gitRepos: gitPlan.gitRepos };

  const filesUnchanged = (() => {
    const d = diffManifests(state.lastSyncedManifest, local);
    return d.added.length === 0 && d.changed.length === 0 && d.deleted.length === 0;
  })();
  const gitUnchanged = !gitPlan.changed;
  if (filesUnchanged && gitUnchanged) {
    // No-op (files AND git identity match base). Safe even under a forced git RE-CAPTURE
    // (the 422 recovery): reaching here needs local == base, but to have hit the 422 at all
    // attempt-0 must have passed its own no-op — i.e. a real file or git-identity change. The
    // base sequence is unadvanced across a 422, so that change still shows here (filesUnchanged
    // or gitUnchanged is false) → this no-op is unreachable whenever there is anything to
    // commit; when it IS reachable, local == base and committing would just echo. So the git
    // recapture's re-uploaded artifacts are never silently dropped by this branch.
    return { sequence: state.lastSyncedSequence, manifest: local };
  }
  // Constructed AFTER the no-op short-circuit so a no-op tick allocates nothing (§35).
  const report = deps.report ?? PhaseReport.disabled("push");
  // §10 forensic line — only when git-sync did something beyond a steady carry.
  if (cfg.syncGit && (gitPlan.captured.length || gitPlan.deferred.length || gitPlan.removed.length)) {
    (deps.onGitLog ?? ((l: string) => console.error(l)))(formatGitPushLine(gitPlan));
  }

  // Upload missing blobs — ALWAYS convergently encrypted (by encSha, ciphertext).
  // E2EE is the only mode (design 12 D6): a non-encrypted config reaching the sync
  // core is a fail-closed error, BEFORE any byte is uploaded — never plaintext.
  if (!cfg.encrypted || !cfg.kek) throw new Error("E2EE required: refusing to sync without an encryption key (run `rbox init`/`rbox pair`/`rbox recover`)");

  // Encrypt + upload. Live-folder resilience (replaces #36's whole-tree re-scan+give-up):
  // a file that keeps changing under us can never produce a hash-matching ciphertext, so
  // encryptAndUpload retries it a bounded number of times and then DEFERS it (returns its
  // path) rather than aborting the entire push. We commit the stable subset; the daemon's
  // watcher + safety/deep scans naturally re-queue the deferred files once they settle.
  const { deferred } = await encryptAndUpload(api, root, cfg, local, state.lastSyncedManifest, report, deps.onProgress, backoff);

  // Build the manifest we actually COMMIT. A deferred file is dropped from this commit;
  // if it was previously synced we carry its base entry forward (mirrors the forward-only
  // ignore carry above) so it NEVER reads as a deletion on other machines, and a never-synced
  // deferred file is simply omitted. Invariant: every blob the committed manifest references
  // was uploaded AND hash-matched this run, or is an already-synced base blob — no dangling
  // ref, no phantom deletion.
  const committed = deferred.size === 0 ? local : deferManifest(local, state.lastSyncedManifest, deferred);

  // If deferral left nothing to commit (every change deferred, git unchanged), don't burn a
  // no-op commit — the deferred files stand alone for the daemon to re-queue later. NEVER
  // short-circuit a forced git RE-CAPTURE (422 recovery): its whole point is to re-commit a
  // manifest whose git artifacts were re-uploaded, and gitUnchanged (identity-only) can't see
  // that the artifact blobs were missing.
  if (deferred.size > 0 && forceGitRecapture.size === 0) {
    const dd = diffManifests(state.lastSyncedManifest, committed);
    if (dd.added.length === 0 && dd.changed.length === 0 && dd.deleted.length === 0 && gitUnchanged) {
      reportDeferred(deferred);
      return { sequence: state.lastSyncedSequence, manifest: committed, deferred: [...deferred] };
    }
  }

  const res = await report.phase("commit", () => api.commit(state.lastSyncedSequence, cfg.deviceId, committed));

  if (res.conflict) {
    deps.onCommitConflict?.(); // tally 409 retry pressure (design 09 §3)
    if (attempt >= MAX_ATTEMPTS) throw new Error("push: too many conflicts, remote is moving faster than we can reconcile");
    await backoff(attempt);
    await pull(root, cfg, deps);
    const { cache, save } = await withCache(root, deps.cache);
    const fresh = await scanManifest(root, undefined, cache); // disk changed under us
    await save();
    return pushManifest(root, cfg, fresh, deps, attempt + 1, purgeIgnored);
  }
  if (res.unsatisfiedBlobs) {
    if (attempt >= MAX_ATTEMPTS) throw new Error("push: server keeps reporting missing blobs after re-upload");
    // Retry the whole attempt: the recursion re-checks missingBlobs + re-uploads the missing
    // FILE ciphertext (with the same per-file defer), and forces a git RE-CAPTURE for exactly
    // the repos whose sections reference the missing encShas [v2, M5] — a missing GIT artifact
    // can't be satisfied by a file re-upload, and the identity-carry would re-reference the
    // absent bundle (§28, codex M3). A naive "recapture everything" would drop exactly the
    // repos the defer machinery is protecting.
    const missing = new Set(res.unsatisfiedBlobs);
    const gitForce = new Set<string>();
    for (const [rel, sec] of Object.entries(committed.gitRepos ?? {})) {
      if (sectionEncShas(sec).some((s) => missing.has(s))) gitForce.add(rel);
    }
    return pushManifest(root, cfg, local, deps, attempt + 1, purgeIgnored, gitForce);
  }

  // Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
  // remote's own unapplied truth — the saved git BASE must keep the OLD entry (or none)
  // so the next pull still sees remote != base and retries the apply. Advancing the base
  // to the pending section would make that pull read "unchanged" and clear pending
  // without ever applying — silently regressing the other machine's work.
  const stateGit = { ...(committed.gitRepos ?? {}) };
  for (const rel of Object.keys(gitPlan.gitPendingRemote ?? {})) {
    const old = state.lastSyncedManifest.gitRepos?.[rel];
    if (old) stateGit[rel] = old;
    else delete stateGit[rel];
  }
  await saveState(root, {
    lastSyncedSequence: res.sequence!,
    lastSyncedManifest: { ...committed, gitRepos: emptyToUndef(stateGit) },
    gitReposRemoved: gitPlan.gitReposRemoved,
    gitNeedsResolution: gitPlan.gitNeedsResolution,
    gitPendingRemote: gitPlan.gitPendingRemote,
  });
  if (deferred.size > 0) reportDeferred(deferred);
  return { sequence: res.sequence!, manifest: committed, deferred: [...deferred] };
}

/** Build the manifest to COMMIT when some files were deferred (never settled under a
 *  churning tree). A deferred file that was previously synced carries its base entry
 *  forward (never a phantom deletion on other machines); a never-synced deferred file
 *  is omitted. Preserves the git section from `local`. */
function deferManifest(local: Manifest, base: Manifest, deferred: Set<string>): Manifest {
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
function reportDeferred(deferred: Set<string>): void {
  console.error(`rbox: ${deferred.size} file(s) still changing — deferred, will sync once they settle`);
  if (process.env.RBOX_DEBUG) console.error(`rbox: deferred paths: ${[...deferred].sort().join(", ")}`);
}

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {}
): Promise<{ pulled: Action[]; pushedSequence: number }> {
  const pulled = await pull(root, cfg, deps);
  const pushedSequence = await push(root, cfg, deps);
  return { pulled, pushedSequence };
}
