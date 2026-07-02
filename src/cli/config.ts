import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection, Manifest } from "../engine/index.js";
import { writeFileAtomic } from "../engine/fsutil.js";

function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Per-device, machine-local workspace binding. `rootPath` is NEVER synced. */
export interface WorkspaceConfig {
  /** Config schema marker. `e2ee/v1` = full end-to-end encryption (design 12).
   *  A workspace lacking it predates E2EE → sync fails closed (D11). */
  schema?: "e2ee/v1";
  /** Shared across machines — identifies the manifest stream on the server. */
  remoteWorkspaceId: string;
  /** OPT-IN, human-readable workspace label — cached LOCALLY so `rbox status` can
   *  show it with NO server round-trip. Names are set-once-at-create (immutable),
   *  so this cache never goes stale. Absent = no name was set (stays the opaque id).
   *  Populated at the two points the CLI already knows it: creating+naming a
   *  workspace (`rbox init --name`), or picking one from the "track existing" list. */
  name?: string;
  /** Single project for now ("root" = the whole linked tree). */
  projectId: string;
  /** This machine's device id. */
  deviceId: string;
  /** Resolved absolute root on THIS machine. Local-only; joined onto relative paths. */
  rootPath: string;
  remoteUrl: string;
  /** Device token — NOT stored in config (M4); injected at runtime from the
   *  per-machine credential (`rbox login`). Empty in the saved workspace.json. */
  token: string;
  /** Opt-in git-state sync (M2). Default off — syncing git config could move
   *  machine-local settings; hooks are never synced regardless. */
  syncGit?: boolean;
  /** Per-repo opt-out for dependency-drift nudges (design 29). When true, a sync
   *  that writes a changed lockfile into this tree prints no drift notice. */
  noDrift?: boolean;
  /** Opt-in blob-content encryption (M5). Persisted. */
  encrypted?: boolean;
  /** Workspace KEK — runtime only, loaded from the keystore; NEVER persisted. */
  kek?: Buffer;
}

/** Last point this device and the server agreed on — the reconcile base.
 *  The three `git*` maps are LOCAL-ONLY (design 43 §11): they never ride a manifest
 *  or leave this machine — they are this device's memory of per-repo sync posture. */
export interface SyncState {
  /** The workspace this baseline belongs to. A baseline is only meaningful against
   *  the stream it was built from: reconciling workspace B against a baseline from
   *  workspace A reads every A-only file as "remotely deleted" — a mass local delete
   *  (the 2026-07-01 rebind incident). loadState treats a mismatch as NO baseline. */
  workspaceId: string;
  lastSyncedSequence: number;
  lastSyncedManifest: Manifest;
  /** Removal memories (design 43 §9 [v2, B4]): relPath → the LOCAL identity key at the
   *  moment the remote deleted the repo. A leftover local repo whose identity still
   *  equals the memory is not re-added by push (it's the untouched leftover) and is
   *  treated as ABSENT (clean materialization target) by pull. Pruned when the local
   *  `.git` disappears or the repo is re-added. */
  gitReposRemoved?: Record<string, string>;
  /** Conflict suppressions (design 43 §7 [v2, M2]): relPath → the conflict-time LOCAL
   *  identity key. Capture carries the checkpointed base (never republishes the
   *  conflicted local state) until the local identity CHANGES from this value. */
  gitNeedsResolution?: Record<string, string>;
  /** Unapplied remote sections (design 43 §7 [v5]): relPath → the remote GitSection a
   *  pull could not apply (ownership block, receiver busy, decrypt failure, …). While
   *  pending: outbound pushes CARRY this section (the newest known truth), capture is
   *  suppressed, and each pull retries the apply. Cleared on successful apply or when
   *  the remote deletes the repo ([v6] absence supersedes pending). */
  gitPendingRemote?: Record<string, GitSection>;
}

export const RBOX_DIR = ".rbox";
const CONFIG_FILE = "workspace.json";
const STATE_FILE = "state.json";
const EMPTY_MANIFEST: Manifest = { generatedAt: "", files: [] };

const configPath = (root: string) => path.join(root, RBOX_DIR, CONFIG_FILE);
const statePath = (root: string) => path.join(root, RBOX_DIR, STATE_FILE);

/** Walk up from `start` looking for a `.rbox/workspace.json`, like git does. */
export async function findRoot(start: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await fs.access(configPath(dir));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

export async function loadConfig(root: string): Promise<WorkspaceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) throw new Error(`No rbox workspace at ${root}. Run: rbox link ${root}`);
    throw e;
  }
  try {
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    throw new Error(`Corrupt workspace config at ${configPath(root)}. Inspect or re-run \`rbox link\`.`);
  }
}

export async function saveConfig(root: string, cfg: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  // Never persist secrets to the workspace config: the token lives in the
  // per-machine credential (M4) and the KEK in the keystore (M5). Both injected
  // at runtime by loadAuthedConfig.
  await writeFileAtomic(configPath(root), JSON.stringify({ ...cfg, token: "", kek: undefined }, null, 2));
}

/**
 * Load the sync state (the reconcile base) for `workspaceId`. A MISSING file is
 * the expected first-run case → empty base. A CORRUPT file is NOT silently treated
 * as empty: resetting the base to empty would make the next reconcile see every
 * remote file as "new" and every local file as conflicting — a destructive
 * surprise. We refuse and surface it instead.
 *
 * A baseline stamped with a DIFFERENT workspace id is treated as no baseline at
 * all: it describes another manifest stream, and reconciling against it turns
 * "file not (yet) in the new workspace" into "remotely deleted" — the rebind
 * mass-delete incident. A fresh base makes a rebound root pull-without-deleting
 * and push-everything, which is exactly right for a new binding. A legacy state
 * file with no stamp is adopted as-is (it predates the stamp; every save since
 * writes one).
 */
export async function loadState(root: string, workspaceId: string): Promise<SyncState> {
  const fresh: SyncState = { workspaceId, lastSyncedSequence: 0, lastSyncedManifest: EMPTY_MANIFEST };
  let raw: string;
  try {
    raw = await fs.readFile(statePath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) return fresh;
    throw e;
  }
  let state: SyncState;
  try {
    state = JSON.parse(raw) as SyncState;
  } catch {
    throw new Error(
      `Corrupt sync state at ${statePath(root)}. Refusing to reset to an empty base ` +
        `(that would force a destructive reconcile). Inspect the file, or delete it to ` +
        `intentionally re-baseline from scratch.`
    );
  }
  if (state.workspaceId === undefined) return { ...state, workspaceId }; // pre-stamp legacy: adopt
  if (state.workspaceId !== workspaceId) {
    console.error(
      `sync state at ${statePath(root)} belongs to workspace ${state.workspaceId}, ` +
        `not ${workspaceId} — starting from a fresh baseline (files on disk untouched).`
    );
    return fresh;
  }
  return state;
}

export async function saveState(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await writeFileAtomic(statePath(root), JSON.stringify(state, null, 2));
}

/** Discard the local sync baseline (used when a root is REBOUND to a different
 *  workspace — the old baseline describes the old stream). Files on disk are
 *  untouched; the next pull writes without deleting and the next push publishes
 *  the full tree. Missing file = already reset. */
export async function resetSyncState(root: string): Promise<void> {
  try {
    await fs.rm(statePath(root));
  } catch (e) {
    if (!isENOENT(e)) throw e;
  }
}
