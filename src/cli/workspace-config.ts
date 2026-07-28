import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../engine/fsutil.js";
import type { ScopeIntent } from "./scope/scope-intent.js";

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
  /** Git-sync feature gates. Schema-3 pack chains are default-on; `incremental: false`
   *  is the escape hatch for full-bundle recaptures. */
  git?: {
    incremental?: boolean;
  };
  /** Design 72 opt-in: when true, nested `.gitignore` rules exclude gitignored
   *  untracked files from the FILE layer. Existing workspaces default false. */
  respectGitignore?: boolean;
  /** Per-repo opt-out for dependency-drift nudges (design 29). When true, a sync
   *  that writes a changed lockfile into this tree prints no drift notice. */
  noDrift?: boolean;
  /** Opt-in blob-content encryption (M5). Persisted. */
  encrypted?: boolean;
  /** Workspace KEK — runtime only, loaded from the keystore; NEVER persisted. */
  kek?: Buffer;
  /** E2EE write-context binding for blob-address caches — runtime only, NEVER persisted. */
  accountId?: string;
  /** Current verified account epoch for the runtime KEK wrap context — runtime only. */
  accountEpoch?: number;
  /** Current workspace key epoch for the runtime KEK wrap context — runtime only. */
  keyEpoch?: number;
  /** Design 212: the workspace-relative prefixes this BINDING syncs. Absent = the
   *  whole workspace (every existing binding). Present = a scoped, structurally
   *  PULL-ONLY binding: `pushManifest` refuses, `recover` refuses, and the daemon
   *  derives pull-only from this field rather than from any mode record. Never sent
   *  to the server (paths are ciphertext there) and never shared with other
   *  machines — scope is a property of this binding alone. */
  scope?: string[];
  /** Monotonic scope-edit generation. Fences every cached/trusted observation made
   *  under an older scope (design 212 §3.3). */
  scopeGeneration?: number;
  /** Durable in-flight scope edit. Present ⇒ a `rbox include add|remove` was
   *  interrupted; the next command resumes it before doing anything else. */
  scopeIntent?: ScopeIntent;
  /** Local trash-tier retention (design 50 §2). Both fields optional; normalized
   *  by {@link trashConfig} on read (never trusted raw). `days: 0` = classic
   *  immediate delete (no trash, for the space-constrained). */
  trash?: { days?: number; maxBytes?: number };
}

/** Trash retention defaults + bounds (design 50 §7 MINOR). Persisted overrides are
 *  UNTRUSTED — a hand-edited workspace.json must never let a typo disable retention
 *  or blow the size cap — so each field clamps to its range and any non-finite /
 *  invalid value falls back to the default for THAT field independently. */
const TRASH_DAYS_DEFAULT = 30;
const TRASH_DAYS_MAX = 365;
const TRASH_MAXBYTES_DEFAULT = 2 * 2 ** 30; // 2 GiB
const TRASH_MAXBYTES_MAX = 2 ** 40; // 1 TiB

export function trashConfig(cfg: WorkspaceConfig): { days: number; maxBytes: number } {
  const rawDays = cfg.trash?.days;
  const days =
    typeof rawDays === "number" && Number.isFinite(rawDays)
      ? Math.min(TRASH_DAYS_MAX, Math.max(0, Math.trunc(rawDays)))
      : TRASH_DAYS_DEFAULT;
  const rawBytes = cfg.trash?.maxBytes;
  const maxBytes =
    typeof rawBytes === "number" && Number.isFinite(rawBytes)
      ? Math.min(TRASH_MAXBYTES_MAX, Math.max(0, Math.trunc(rawBytes)))
      : TRASH_MAXBYTES_DEFAULT;
  return { days, maxBytes };
}

export const RBOX_DIR = ".rbox";
const CONFIG_FILE = "workspace.json";
const configPath = (root: string) => path.join(root, RBOX_DIR, CONFIG_FILE);

function configForDisk(cfg: WorkspaceConfig): WorkspaceConfig {
  return {
    ...cfg,
    token: "",
    kek: undefined,
    accountId: undefined,
    accountEpoch: undefined,
    keyEpoch: undefined,
  };
}

/** The identity of the manifest stream a binding syncs against — what a sync
 *  baseline is stamped with and validated against (design 44 §2). Composed of
 *  every coordinate that selects a distinct sequence history server-side. */
export const syncStreamId = (cfg: Pick<WorkspaceConfig, "remoteUrl" | "remoteWorkspaceId" | "projectId">): string =>
  `${cfg.remoteUrl}::${cfg.remoteWorkspaceId}::${cfg.projectId}`;

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

export class WorkspaceConfigNotFoundError extends Error {
  readonly code = "ENOENT";

  constructor(root: string) {
    super(`No rbox workspace at ${root}. Run: rbox link ${root}`);
    this.name = "WorkspaceConfigNotFoundError";
  }
}

export async function loadConfig(root: string): Promise<WorkspaceConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(root), "utf8");
  } catch (e) {
    if (isENOENT(e)) throw new WorkspaceConfigNotFoundError(root);
    throw e;
  }
  try {
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    throw new Error(`Corrupt workspace config at ${configPath(root)}. Inspect or re-run \`rbox link\`.`);
  }
}

/** Typed config probe: only a genuinely absent workspace config maps to undefined. */
export async function loadConfigIfPresent(root: string): Promise<WorkspaceConfig | undefined> {
  try {
    return await loadConfig(root);
  } catch (error) {
    if (error instanceof WorkspaceConfigNotFoundError) return undefined;
    throw error;
  }
}

export async function saveConfig(root: string, cfg: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  // Never persist secrets to the workspace config: the token lives in the
  // per-machine credential (M4) and the KEK in the keystore (M5). Both injected
  // at runtime by loadAuthedConfig.
  await writeFileAtomic(configPath(root), JSON.stringify(configForDisk(cfg), null, 2));
}
