import fs from "node:fs/promises";
import path from "node:path";
import {
  applyActions,
  applyGitState,
  buildIgnoreMatcher,
  captureGitState,
  diffManifests,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  preserveGitConflict,
  HashCache,
  reconcile,
  scanManifest,
  validateManifest,
  type Action,
  type GitSection,
  type Manifest,
} from "../engine/index.js";
import { loadState, saveState, type WorkspaceConfig } from "./config.js";
import { RboxApi, RemoteBlobStore } from "./remote.js";

const apiFor = (cfg: WorkspaceConfig) =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

const MAX_ATTEMPTS = 5;
const UPLOAD_CONCURRENCY = 8; // bounded so a big push never opens thousands of fds

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, so two hot daemons don't livelock retrying. */
const backoff = (attempt: number) => sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));

/** Either use the caller's cache (caller owns persistence) or load+save one locally. */
async function withCache(
  root: string,
  provided: HashCache | undefined
): Promise<{ cache: HashCache; save: () => Promise<void> }> {
  if (provided) return { cache: provided, save: async () => {} };
  const cache = await HashCache.load(root);
  return { cache, save: () => cache.save(root) };
}

/** Upload blobs with bounded concurrency, streaming each file (single PUT or
 *  resumable multipart by size) so memory stays flat regardless of file size. */
async function uploadBlobs(
  api: RboxApi,
  root: string,
  shas: string[],
  shaToPath: Map<string, string>
): Promise<void> {
  const queue = [...shas];
  const uploadsDir = path.join(root, ".rbox", "state", "uploads");
  const worker = async () => {
    for (let sha = queue.pop(); sha !== undefined; sha = queue.pop()) {
      const rel = shaToPath.get(sha);
      if (!rel) continue; // sha not among our local files (nothing to upload)
      const abs = path.join(root, rel);
      const st = await fs.stat(abs);
      await api.putBlobFile(sha, abs, st.size, uploadsDir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
}

/** Capture/carry the git section for a push (M2). Capture+upload only when the
 *  repo's stable identity changed vs the base; otherwise carry the base section. */
async function captureGitForPush(
  root: string,
  cfg: WorkspaceConfig,
  baseGit: GitSection | undefined,
  api: RboxApi
): Promise<GitSection | undefined> {
  if (!cfg.syncGit) return undefined;
  if (!(await gitPreflight(root)).ok) return baseGit;
  const localId = await gitIdentity(root);
  if (!localId) return baseGit; // empty repo (no commits) → no git section yet
  if (baseGit && gitIdentityKey(localId) === gitIdentityKey(baseGit)) return baseGit; // unchanged → carry
  return captureGitState(root, new RemoteBlobStore(api)); // changed → capture + upload artifacts
}

/**
 * Pull the latest remote manifest and reconcile it onto the local tree. The
 * reconcile base is the last-synced manifest; after applying, the new base is
 * the remote we just pulled. The remote manifest is validated before it touches
 * the filesystem (never trust the network). Returns the actions taken.
 */
export async function pull(root: string, cfg: WorkspaceConfig, providedCache?: HashCache): Promise<Action[]> {
  const api = apiFor(cfg);
  const { sequence, manifest: remote } = await api.latest();

  const v = validateManifest(remote);
  if (!v.ok) throw new Error(`refusing to apply invalid remote manifest: ${v.error}`);

  const state = await loadState(root);
  const { cache, save } = await withCache(root, providedCache);
  const local = await scanManifest(root, undefined, cache);

  const actions = reconcile(state.lastSyncedManifest, local, remote, cfg.deviceId, new Date().toISOString());
  await applyActions(root, actions, new RemoteBlobStore(api), { device: cfg.deviceId });

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
      const store = new RemoteBlobStore(api);
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
export async function push(root: string, cfg: WorkspaceConfig, providedCache?: HashCache, purgeIgnored = false): Promise<number> {
  const { cache, save } = await withCache(root, providedCache);
  const local = await scanManifest(root, undefined, cache);
  await save();
  return (await pushManifest(root, cfg, local, providedCache, 0, purgeIgnored)).sequence;
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
  providedCache?: HashCache,
  attempt = 0,
  purgeIgnored = false
): Promise<{ sequence: number; manifest: Manifest }> {
  const api = apiFor(cfg);
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

  const shaToPath = new Map<string, string>();
  for (const f of local.files) if (f.type === "file") shaToPath.set(f.sha256, f.path);
  const missing = await api.missingBlobs([...shaToPath.keys()]);
  await uploadBlobs(api, root, missing, shaToPath);

  const res = await api.commit(state.lastSyncedSequence, cfg.deviceId, local);

  if (res.conflict) {
    if (attempt >= MAX_ATTEMPTS) throw new Error("push: too many conflicts, remote is moving faster than we can reconcile");
    await backoff(attempt);
    await pull(root, cfg, providedCache);
    const { cache, save } = await withCache(root, providedCache);
    const fresh = await scanManifest(root, undefined, cache); // disk changed under us
    await save();
    return pushManifest(root, cfg, fresh, providedCache, attempt + 1, purgeIgnored);
  }
  if (res.unsatisfiedBlobs) {
    if (attempt >= MAX_ATTEMPTS) throw new Error("push: server keeps reporting missing blobs after re-upload");
    await uploadBlobs(api, root, res.unsatisfiedBlobs, shaToPath);
    return pushManifest(root, cfg, local, providedCache, attempt + 1, purgeIgnored);
  }

  await saveState(root, { lastSyncedSequence: res.sequence!, lastSyncedManifest: local });
  return { sequence: res.sequence!, manifest: local };
}

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(
  root: string,
  cfg: WorkspaceConfig,
  providedCache?: HashCache
): Promise<{ pulled: Action[]; pushedSequence: number }> {
  const pulled = await pull(root, cfg, providedCache);
  const pushedSequence = await push(root, cfg, providedCache);
  return { pulled, pushedSequence };
}
