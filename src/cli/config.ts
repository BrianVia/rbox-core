import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "../engine/index.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { loadCredentials } from "./credentials.js";

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
  /** Opt-in blob-content encryption (M5). Persisted. */
  encrypted?: boolean;
  /** Workspace KEK — runtime only, loaded from the keystore; NEVER persisted. */
  kek?: Buffer;
}

/** Last point this device and the server agreed on — the reconcile base. */
export interface SyncState {
  lastSyncedSequence: number;
  lastSyncedManifest: Manifest;
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

/** Load the workspace config and inject the device token from the per-machine
 *  credential (`rbox login`). Throws if not logged in. Use for any networked op. */
export async function loadAuthedConfig(root: string): Promise<WorkspaceConfig> {
  const cfg = await loadConfig(root);
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  const authed: WorkspaceConfig = { ...cfg, token: creds.token, remoteUrl: cfg.remoteUrl || creds.remoteUrl };
  if (cfg.encrypted) {
    const { loadKek } = await import("./keystore.js");
    authed.kek = await loadKek(cfg.remoteWorkspaceId);
    if (!authed.kek) throw new Error(`workspace is encrypted but no key on this device — run \`rbox key import <recovery-phrase>\``);
  }
  return authed;
}

/**
 * Load the sync state (the reconcile base). A MISSING file is the expected
 * first-run case → empty base. A CORRUPT file is NOT silently treated as empty:
 * resetting the base to empty would make the next reconcile see every remote
 * file as "new" and every local file as conflicting — a destructive surprise.
 * We refuse and surface it instead.
 */
export async function loadState(root: string): Promise<SyncState> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) return { lastSyncedSequence: 0, lastSyncedManifest: EMPTY_MANIFEST };
    throw e;
  }
  try {
    return JSON.parse(raw) as SyncState;
  } catch {
    throw new Error(
      `Corrupt sync state at ${statePath(root)}. Refusing to reset to an empty base ` +
        `(that would force a destructive reconcile). Inspect the file, or delete it to ` +
        `intentionally re-baseline from scratch.`
    );
  }
}

export async function saveState(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await writeFileAtomic(statePath(root), JSON.stringify(state, null, 2));
}
