/**
 * Read-only folder inventory (design 231 slice 2).
 *
 * This Module joins catalog state to the existing binding registry without
 * healing either source. `detached` requires an authoritative catalog and is
 * therefore unreachable on every pre-cutover machine. `unbound`, `missing`,
 * and `damaged` remain reachable pre-cutover as per-root observations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  readBindingRegistry,
  type BindingRegistryRow,
  type ReadRegistryDeps,
} from "./binding-registry.js";
import {
  inspectFolderCatalog,
  resolveFolderPolicy,
  type FolderCatalogState,
  type ResolvedFolderPolicy,
} from "./folder-config.js";
import {
  loadConfigIfPresent,
  trashConfig,
  type WorkspaceConfig,
} from "./workspace-config.js";

export type FolderAdmission =
  | { kind: "admitted"; generation: string; policy: ResolvedFolderPolicy }
  | { kind: "legacy"; policy: ResolvedFolderPolicy }
  | { kind: "unbound" | "missing" | "detached" | "damaged"; reason: string };

export interface FolderInventoryRow extends BindingRegistryRow {
  admission: FolderAdmission;
}

export interface FolderInventorySnapshot {
  catalogState: FolderCatalogState["kind"];
  rows: FolderInventoryRow[];
}

export interface FolderInventoryDeps extends ReadRegistryDeps {
  readBindingRegistry?: typeof readBindingRegistry;
  inspectFolderCatalog?: typeof inspectFolderCatalog;
  loadConfigIfPresent?: typeof loadConfigIfPresent;
}

function legacyPolicy(binding: WorkspaceConfig): ResolvedFolderPolicy {
  const trash = trashConfig(binding);
  // Every value comes from the legacy binding's persisted fields, with the
  // historical effective default supplied when that field is absent:
  // syncGit=false (legacy opt-in), git.incremental=true (schema-3 default),
  // respectGitignore=false, noDrift=false, and trashConfig's independently
  // normalized 30-day / 2-GiB defaults and legacy bounds.
  return resolveFolderPolicy({}, {
    syncGit: binding.syncGit ?? false,
    git: { incremental: binding.git?.incremental ?? true },
    respectGitignore: binding.respectGitignore ?? false,
    noDrift: binding.noDrift ?? false,
    trash,
  });
}

async function rootExists(root: string): Promise<boolean> {
  try {
    await fs.stat(root);
    return true;
  } catch {
    return false;
  }
}

async function observeAgainstState(
  root: string,
  state: FolderCatalogState,
  deps: FolderInventoryDeps,
): Promise<FolderAdmission> {
  if (state.kind === "damaged") return { kind: "damaged", reason: state.reason };

  const absoluteRoot = path.resolve(root);
  const authoritative = state.kind === "authoritative" ? state.snapshot : undefined;
  const entry = authoritative?.folders.find((folder) => folder.normalizedPath === absoluteRoot);

  let binding: WorkspaceConfig | undefined;
  try {
    binding = await (deps.loadConfigIfPresent ?? loadConfigIfPresent)(absoluteRoot);
  } catch (error) {
    return { kind: "damaged", reason: error instanceof Error ? error.message : String(error) };
  }
  if (binding === undefined) {
    return await rootExists(absoluteRoot)
      ? { kind: "unbound", reason: "the folder has no rbox binding" }
      : { kind: "missing", reason: "the folder does not exist" };
  }

  if (authoritative && entry === undefined) {
    return { kind: "detached", reason: "the bound folder is not listed in the authoritative folder configuration" };
  }
  if (authoritative && entry) {
    return { kind: "admitted", generation: authoritative.generation, policy: entry.policy };
  }
  // Candidate catalogs are deliberately dormant until their authority marker
  // exists, so they retain the exact legacy policy path too.
  try {
    return { kind: "legacy", policy: legacyPolicy(binding) };
  } catch (error) {
    return { kind: "damaged", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function observeFolderAdmission(
  root: string,
  state?: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderAdmission> {
  const observedState = state ?? await (deps.inspectFolderCatalog ?? inspectFolderCatalog)();
  return observeAgainstState(root, observedState, deps);
}

export async function listFolderInventory(
  state?: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderInventorySnapshot> {
  const registryDeps: ReadRegistryDeps = {
    ...(deps.readDesiredDaemonRows === undefined ? {} : { readDesiredDaemonRows: deps.readDesiredDaemonRows }),
    ...(deps.readBoundWorkspaceId === undefined ? {} : { readBoundWorkspaceId: deps.readBoundWorkspaceId }),
  };
  const [rows, observedState] = await Promise.all([
    (deps.readBindingRegistry ?? readBindingRegistry)(registryDeps),
    state === undefined
      ? (deps.inspectFolderCatalog ?? inspectFolderCatalog)()
      : Promise.resolve(state),
  ]);
  return {
    catalogState: observedState.kind,
    rows: await Promise.all(rows.map(async (row) => ({
      ...row,
      admission: await observeAgainstState(row.root, observedState, deps),
    }))),
  };
}
