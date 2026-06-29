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
  preserveGitConflict,
  HashCache,
  poolMap,
  reconcile,
  scanManifest,
  validateManifest,
  type Action,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import { loadState, saveState, type WorkspaceConfig } from "./config.js";
import { RboxApi, type SyncRemote } from "./remote.js";

const apiFor = (cfg: WorkspaceConfig): SyncRemote =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, so two hot daemons don't livelock retrying. */
const defaultBackoff = (attempt: number) => sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));

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
}

const ENCRYPT_CONCURRENCY = 8; // CPU/disk bound
const UPLOAD_CONCURRENCY = 16; // network/latency bound — the dominant cost on a first push

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
 *  ciphertext blobs by `encSha`. Mutates `local`'s entries (encSha + fresh sha). */
async function encryptAndUpload(api: SyncRemote, root: string, cfg: WorkspaceConfig, local: Manifest, base: Manifest, onProgress?: SyncDeps["onProgress"]): Promise<void> {
  if (cfg.syncGit) throw new Error("encryption + git-state sync aren't supported together yet (M5 limitation; full-E2EE milestone covers it)");
  if (!cfg.kek) throw new Error("encrypted workspace but no key loaded — run `rbox key import <recovery-phrase>`");
  const kek = cfg.kek;
  const baseEnc = new Map(base.files.filter((f) => f.encSha).map((f) => [f.sha256, f.encSha!]));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-encup-"));
  const ctByEnc = new Map<string, string>();
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
    await poolMap(toEncrypt, ENCRYPT_CONCURRENCY, async (f) => {
      const e = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir);
      f.sha256 = e.plaintextSha; // fresh-hashed actual bytes (review #1)
      f.encSha = e.encSha;
      ctByEnc.set(e.encSha, e.ciphertextPath);
      onProgress?.(++enc, toEncrypt.length, "encrypt");
    });

    const encShas = local.files.filter((f) => f.type === "file" && f.encSha).map((f) => f.encSha!);
    const missing = await api.missingBlobs(encShas);
    const uploadsDir = path.join(root, ".rbox", "state", "uploads");
    // Upload missing blobs concurrently — THE dominant cost on a first push (each
    // putBlobFile is one round-trip; sequential meant ~3/sec, latency-bound).
    let up = 0;
    await poolMap(missing, UPLOAD_CONCURRENCY, async (encSha) => {
      let ct = ctByEnc.get(encSha);
      if (!ct) {
        // Missing on the server but reused-from-base (server lost it) → re-encrypt.
        const f = local.files.find((x) => x.encSha === encSha);
        if (!f) return;
        ct = (await encryptFileToTemp(path.join(root, f.path), kek, tmpDir)).ciphertextPath;
      }
      await api.putBlobFile(encSha, ct, (await fs.stat(ct)).size, uploadsDir);
      onProgress?.(++up, missing.length, "upload");
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  if (!(await gitPreflight(root)).ok) return baseGit;
  const localId = await gitIdentity(root);
  if (!localId) return baseGit; // empty repo (no commits) → no git section yet
  if (baseGit && gitIdentityKey(localId) === gitIdentityKey(baseGit)) return baseGit; // unchanged → carry
  return captureGitState(root, api.blobStore()); // changed → capture + upload artifacts
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
  const { cache, save } = await withCache(root, deps.cache);
  const local = await scanManifest(root, undefined, cache);

  // E2EE is the only mode (D6): the KEK is injected by buildAuthedRemote. A remote
  // manifest with encrypted entries but no key on this device → fail closed.
  const kek = cfg.kek;
  if (!kek && remote.files.some((f) => f.encSha)) {
    throw new Error("E2EE required: this workspace is encrypted but no key on this device — run `rbox pair` or `rbox recover`.");
  }

  const actions = reconcile(state.lastSyncedManifest, local, remote, cfg.deviceId, new Date().toISOString());
  await applyActions(root, actions, api.blobStore(), {
    device: cfg.deviceId,
    kek,
    onProgress: deps.onProgress ? (done, total) => deps.onProgress!(done, total, "download") : undefined,
  });

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
      const store = api.blobStore();
      const localChanged = gitIdentityKey(await gitIdentity(root)) !== baseKey;
      if (localChanged) {
        // Both sides diverged → never auto-clobber local. Preserve remote for manual
        // merge and checkpoint the base to remote so we stop pull-conflict-looping.
        const { recoveryBundle } = await preserveGitConflict(root, remote.git, store);
        appliedGit = remote.git;
        console.error(`rbox: git conflict — local kept; remote preserved at ${recoveryBundle} and refs/rbox-conflict/*. Resolve manually.`);
      } else {
        // Clean fast-forward (local == base): apply remote transactionally.
        const res = await applyGitState(root, remote.git, store);
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
  const { cache, save } = await withCache(root, deps.cache);
  const local = await scanManifest(root, undefined, cache);
  await save();
  return (await pushManifest(root, cfg, local, deps, 0, purgeIgnored)).sequence;
}

/**
 * Push a pre-computed manifest: upload missing blobs, commit. Short-circuits to a
 * no-op (no upload, no commit) when nothing changed vs the last-synced manifest —
 * this is what keeps continuous bidirectional sync from echo-storming (a pull
 * writes exactly the last-synced bytes, so the next push sees no diff). A 409
 * conflict pulls, RE-SCANS (disk changed), and retries (bounded, backed off); a
 * 422 re-uploads the named blobs and retries. Returns the sequence now in effect
 * and the manifest that reflects it (so a caller holding an in-memory manifest can
 * keep it fresh even across a conflict re-scan).
 */
export async function pushManifest(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps = {},
  attempt = 0,
  purgeIgnored = false
): Promise<{ sequence: number; manifest: Manifest }> {
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
  local = { ...local, git: await captureGitForPush(root, cfg, state.lastSyncedManifest.git, api) };

  const filesUnchanged = (() => {
    const d = diffManifests(state.lastSyncedManifest, local);
    return d.added.length === 0 && d.changed.length === 0 && d.deleted.length === 0;
  })();
  const gitUnchanged = gitIdentityKey(local.git) === gitIdentityKey(state.lastSyncedManifest.git);
  if (filesUnchanged && gitUnchanged) {
    return { sequence: state.lastSyncedSequence, manifest: local }; // no-op (files AND git)
  }
  const d = diffManifests(state.lastSyncedManifest, local);

  // Upload missing blobs — ALWAYS convergently encrypted (by encSha, ciphertext).
  // E2EE is the only mode (design 12 D6): a non-encrypted config reaching the sync
  // core is a fail-closed error, BEFORE any byte is uploaded — never plaintext.
  if (!cfg.encrypted || !cfg.kek) throw new Error("E2EE required: refusing to sync without an encryption key (run `rbox init`/`rbox pair`/`rbox recover`)");
  const doUpload = async () => {
    await encryptAndUpload(api, root, cfg, local, state.lastSyncedManifest, deps.onProgress);
  };
  await doUpload();

  const res = await api.commit(state.lastSyncedSequence, cfg.deviceId, local);

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
    await doUpload(); // re-check + re-upload (encrypted or plaintext)
    return pushManifest(root, cfg, local, deps, attempt + 1, purgeIgnored);
  }

  await saveState(root, { lastSyncedSequence: res.sequence!, lastSyncedManifest: local });
  return { sequence: res.sequence!, manifest: local };
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
