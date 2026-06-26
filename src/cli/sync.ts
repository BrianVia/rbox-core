import fs from "node:fs/promises";
import path from "node:path";
import { applyActions, reconcile, scanManifest, type Action } from "../engine/index.js";
import { loadState, saveState, type WorkspaceConfig } from "./config.js";
import { RboxApi, RemoteBlobStore } from "./remote.js";

const apiFor = (cfg: WorkspaceConfig) =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

/**
 * Pull the latest remote manifest and reconcile it onto the local tree.
 * The reconcile base is the last-synced manifest; after applying, the new base
 * is the remote we just pulled (the new common point). Returns the actions taken.
 */
export async function pull(root: string, cfg: WorkspaceConfig): Promise<Action[]> {
  const api = apiFor(cfg);
  const { sequence, manifest: remote } = await api.latest();
  const state = await loadState(root);
  const local = await scanManifest(root);

  const actions = reconcile(state.lastSyncedManifest, local, remote, cfg.deviceId, new Date().toISOString());
  await applyActions(root, actions, new RemoteBlobStore(api));

  await saveState(root, { lastSyncedSequence: sequence, lastSyncedManifest: remote });
  return actions;
}

/**
 * Scan the local tree, upload any blobs the server is missing, and commit a new
 * manifest with the parent sequence we last saw. On a 409 conflict we pull (which
 * reconciles) and retry — bounded, so a hot remote can't loop forever.
 */
export async function push(root: string, cfg: WorkspaceConfig, attempt = 0): Promise<number> {
  const api = apiFor(cfg);
  const local = await scanManifest(root);

  // Upload missing blobs (batched check, then PUT only the gaps).
  const shaToPath = new Map<string, string>();
  for (const f of local.files) if (f.type === "file") shaToPath.set(f.sha256, f.path);
  const missing = await api.missingBlobs([...shaToPath.keys()]);
  for (const sha of missing) {
    const rel = shaToPath.get(sha)!;
    await api.putBlob(sha, await fs.readFile(path.join(root, rel)));
  }

  const state = await loadState(root);
  const res = await api.commit(state.lastSyncedSequence, cfg.deviceId, local);
  if (res.conflict) {
    if (attempt >= 3) throw new Error("push: too many conflicts, remote is moving faster than we can reconcile");
    await pull(root, cfg);
    return push(root, cfg, attempt + 1);
  }
  await saveState(root, { lastSyncedSequence: res.sequence!, lastSyncedManifest: local });
  return res.sequence!;
}

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(root: string, cfg: WorkspaceConfig): Promise<{ pulled: Action[]; pushedSequence: number }> {
  const pulled = await pull(root, cfg);
  const pushedSequence = await push(root, cfg);
  return { pulled, pushedSequence };
}
