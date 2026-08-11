/**
 * Read-only folder inventory (design 231 activation).
 *
 * This Module joins caller-pinned catalog state to binding observations without
 * healing either source. Stage C retains compatibility-registry enumeration;
 * Stage D expands that observation into the complete source union.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  readBindingRegistry,
  type BindingRegistryRow,
  type ReadRegistryDeps,
} from "./binding-registry.js";
import {
  type FolderCatalogState,
  type ResolvedFolderPolicy,
} from "./folder-config.js";
import type { FolderGenerationInventory } from "./folder-catalog-generate.js";
import {
  loadConfigIfPresent,
  type WorkspaceConfig,
} from "./workspace-config.js";

export type FolderAdmission =
  | { kind: "admitted"; generation: string; policy: ResolvedFolderPolicy }
  | { kind: "unbound" | "missing" | "detached" | "damaged"; reason: string };

export interface FolderInventoryRow extends BindingRegistryRow {
  admission: FolderAdmission;
}

export interface FolderInventorySnapshot {
  catalogState: FolderCatalogState["kind"];
  revision: FolderCatalogState["revision"];
  rows: FolderInventoryRow[];
}

export interface FolderInventoryDeps extends ReadRegistryDeps {
  readBindingRegistry?: typeof readBindingRegistry;
  loadConfigIfPresent?: typeof loadConfigIfPresent;
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
  const entry = state.kind === "authoritative"
    ? state.snapshot.folders.find((folder) => folder.normalizedPath === absoluteRoot)
    : undefined;

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

  if (state.kind === "absent") {
    return { kind: "damaged", reason: "rbox folder configuration is absent; run `rbox config regenerate`" };
  }
  if (entry === undefined) {
    return { kind: "detached", reason: "the bound folder is not listed in the authoritative folder configuration" };
  }
  return { kind: "admitted", generation: state.snapshot.generation, policy: entry.policy };
}

export async function observeFolderAdmission(
  root: string,
  state: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderAdmission> {
  return observeAgainstState(root, state, deps);
}

export async function listFolderInventory(
  state: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderInventorySnapshot> {
  const registryDeps: ReadRegistryDeps = {
    ...(deps.readDesiredDaemonRows === undefined ? {} : { readDesiredDaemonRows: deps.readDesiredDaemonRows }),
    ...(deps.readBoundWorkspaceId === undefined ? {} : { readBoundWorkspaceId: deps.readBoundWorkspaceId }),
  };
  const rows = await (deps.readBindingRegistry ?? readBindingRegistry)(registryDeps);
  return {
    catalogState: state.kind,
    revision: state.revision,
    rows: await Promise.all(rows.map(async (row) => ({
      ...row,
      admission: await observeAgainstState(row.root, state, deps),
    }))),
  };
}

/** Minimal Stage-C generation observation; Stage D expands the source union. */
export async function observeFolderGeneration(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderInventoryDeps = {},
): Promise<FolderGenerationInventory> {
  const registryDeps: ReadRegistryDeps = {
    ...(deps.readDesiredDaemonRows === undefined ? {} : { readDesiredDaemonRows: deps.readDesiredDaemonRows }),
    ...(deps.readBoundWorkspaceId === undefined ? {} : { readBoundWorkspaceId: deps.readBoundWorkspaceId }),
  };
  const rows = await (deps.readBindingRegistry ?? readBindingRegistry)(registryDeps);
  const roots = new Set(rows.map((row) => path.resolve(row.root)));
  if (context.currentRoot !== undefined) roots.add(path.resolve(context.currentRoot));
  const discoverableBindings: FolderGenerationInventory["discoverableBindings"] = [];
  const skipped: FolderGenerationInventory["skipped"] = [];
  for (const root of [...roots].sort()) {
    try {
      const binding = await (deps.loadConfigIfPresent ?? loadConfigIfPresent)(root);
      if (binding === undefined) {
        skipped.push({ root, reason: await rootExists(root) ? "the folder has no rbox binding" : "the folder does not exist" });
      } else {
        discoverableBindings.push({ root, binding });
      }
    } catch (error) {
      skipped.push({ root, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { revision: state.revision, discoverableBindings, skipped };
}
