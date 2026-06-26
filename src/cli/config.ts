import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "../engine/index.js";

/** Per-device, machine-local workspace binding. `rootPath` is NEVER synced. */
export interface WorkspaceConfig {
  /** Shared across machines — identifies the manifest stream on the server. */
  remoteWorkspaceId: string;
  /** Single project for now ("root" = the whole linked tree). */
  projectId: string;
  /** This machine's device id. */
  deviceId: string;
  /** Resolved absolute root on THIS machine. Local-only; joined onto relative paths. */
  rootPath: string;
  remoteUrl: string;
  token: string;
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
  try {
    return JSON.parse(await fs.readFile(configPath(root), "utf8")) as WorkspaceConfig;
  } catch {
    throw new Error(`No rbox workspace at ${root}. Run: rbox link ${root}`);
  }
}

export async function saveConfig(root: string, cfg: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await fs.writeFile(configPath(root), JSON.stringify(cfg, null, 2));
}

export async function loadState(root: string): Promise<SyncState> {
  try {
    return JSON.parse(await fs.readFile(statePath(root), "utf8")) as SyncState;
  } catch {
    return { lastSyncedSequence: 0, lastSyncedManifest: EMPTY_MANIFEST };
  }
}

export async function saveState(root: string, state: SyncState): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await fs.writeFile(statePath(root), JSON.stringify(state, null, 2));
}
