import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  applyGitState,
  buildIgnoreMatcher,
  captureGitState,
  diffManifests,
  encryptFileToTemp,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  isIgnoreRuleFile,
  preserveGitConflict,
  HashCache,
  PhaseReport,
  poolMap,
  reconcile,
  scanManifest,
  validateManifest,
  type Action,
  type FileEntry,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import { loadState, saveState, type WorkspaceConfig } from "./config.js";
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

/** Capture/carry the git section for a push (M2). Capture+upload only when the
 *  repo's stable identity changed vs the base; otherwise carry the base section. */
async function captureGitForPush(
  root: string,
  cfg: WorkspaceConfig,
  baseGit: GitSection | undefined,
  api: SyncRemote
): Promise<GitSection | undefined> {
  if (!cfg.syncGit) return undefined;
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  if (!(await gitPreflight(root)).ok) return baseGit;
  const localId = await gitIdentity(root);
  if (!localId) return baseGit; // empty repo (no commits) → no git section yet
  if (baseGit && gitIdentityKey(localId) === gitIdentityKey(baseGit)) return baseGit; // unchanged → carry
  return captureGitState(root, api.blobStore(), cfg.kek); // changed → ENCRYPT + capture + upload artifacts
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
  await report.phase("apply", async () => {
    if (ruleActions.length > 0) await applyActions(root, ruleActions, api.blobStore(), applyOpts);
    const fresh = ruleActions.length > 0 ? buildIgnoreMatcher(root) : matcher;
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

  // Git section (M2): apply remote git state if it changed; advance the git base
  // ONLY if the apply actually succeeded (else keep base so the next pull retries
  // — never record an unapplied remote git as the base and later push stale git).
  let appliedGit = state.lastSyncedManifest.git;
  if (cfg.syncGit) {
    const baseGit = state.lastSyncedManifest.git;
    const baseKey = gitIdentityKey(baseGit);
    const remoteKey = gitIdentityKey(remote.git);
    if (remote.git && remoteKey !== baseKey) {
      if (!kek) throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox recover`.");
      const store = api.blobStore();
      const localChanged = gitIdentityKey(await gitIdentity(root)) !== baseKey;
      if (localChanged) {
        // Both sides diverged → never auto-clobber local. Preserve remote for manual
        // merge and checkpoint the base to remote so we stop pull-conflict-looping.
        const { recoveryBundle } = await preserveGitConflict(root, remote.git, store, kek);
        appliedGit = remote.git;
        console.error(`rbox: git conflict — local kept; remote preserved at ${recoveryBundle} and refs/rbox-conflict/*. Resolve manually.`);
      } else {
        // Clean fast-forward (local == base): apply remote transactionally.
        const res = await applyGitState(root, remote.git, store, kek);
        if (res.applied) appliedGit = remote.git;
        else {
          appliedGit = baseGit; // deferred/rolled-back → retry next pull
          console.error(`rbox: git apply not done: ${res.reason}`);
        }
      }
    } else if (remote.git && remoteKey === baseKey) {
      appliedGit = remote.git; // unchanged
    }
  }
  await saveState(root, { lastSyncedSequence: sequence, lastSyncedManifest: { ...remote, git: appliedGit } });
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
  forceGitRecapture = false
): Promise<{ sequence: number; manifest: Manifest; deferred?: string[] }> {
  const api = deps.remote ?? apiFor(cfg);
  const backoff = deps.backoff ?? defaultBackoff;
  const state = await loadState(root);

  // Forward-only ignore (M3b): a file that was synced but is now ignored should
  // NOT read as a deletion on other machines. Carry forward its last-synced entry
  // unless --purge explicitly requests propagating the deletion. (A real `rm` of a
  // non-ignored file is still absent-and-not-ignored → a genuine deletion.)
  if (!purgeIgnored) {
    const matcher = buildIgnoreMatcher(root);
    const present = new Set(local.files.map((f) => f.path));
    const carried = state.lastSyncedManifest.files.filter((e) => !present.has(e.path) && matcher.ignores(e.path));
    if (carried.length) {
      local = { ...local, files: [...local.files, ...carried].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
    }
  }

  // Attach the git section (M2): capture only when its stable identity changed
  // vs the base (re-bundling unchanged state would echo forever); else carry it.
  // §28: a 422-retry forces a git RE-CAPTURE (base=undefined ⇒ no identity-carry) so a git
  // artifact missing server-side is re-bundled + re-uploaded — the recursive call recomputes
  // local.git here, so the force MUST live at this single site (not after the commit) or it's
  // overwritten and the recovery is dead (codex scrutiny).
  const gitBase = forceGitRecapture ? undefined : state.lastSyncedManifest.git;
  local = { ...local, git: await captureGitForPush(root, cfg, gitBase, api) };

  const filesUnchanged = (() => {
    const d = diffManifests(state.lastSyncedManifest, local);
    return d.added.length === 0 && d.changed.length === 0 && d.deleted.length === 0;
  })();
  const gitUnchanged = gitIdentityKey(local.git) === gitIdentityKey(state.lastSyncedManifest.git);
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
  if (deferred.size > 0 && !forceGitRecapture) {
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
    // FILE ciphertext (with the same per-file defer), and forces a git RE-CAPTURE — a missing
    // GIT artifact can't be satisfied by a file re-upload, the identity-carry would re-reference
    // the absent bundle (§28, codex M3). The force is a flag the recursion acts on, not a
    // mutation here.
    return pushManifest(root, cfg, local, deps, attempt + 1, purgeIgnored, cfg.syncGit);
  }

  await saveState(root, { lastSyncedSequence: res.sequence!, lastSyncedManifest: committed });
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
