/** Read-only FolderInventory classifier and public facade (design 231 §3.2). */
import path from "node:path";
import type { BindingRegistryRow } from "./binding-registry.js";
import type { DesiredStateRow } from "./autostart/desired-state.js";
import type {
  FolderCatalogState,
  ResolvedFolderCatalogEntry,
  ResolvedFolderPolicy,
} from "./folder-config.js";
import type { FolderGenerationInventory } from "./folder-catalog-generate.js";
import {
  buildFolderInventoryUnion,
  observeFolderRoot,
  type FolderBindingObservation,
  type FolderOverlap,
  type FolderUnionDeps,
  type FolderUnionRow,
} from "./folder-inventory-union.js";

export type FolderAdmission =
  | { kind: "admitted"; generation: string; policy: ResolvedFolderPolicy }
  | { kind: "unbound" | "missing" | "detached" | "damaged"; reason: string };

export interface FolderInventoryRow {
  root: string;
  catalog?: ResolvedFolderCatalogEntry;
  registry?: BindingRegistryRow;
  desired?: DesiredStateRow;
  binding?: FolderBindingObservation;
  isCurrentRoot: boolean;
  overlap?: FolderOverlap;
  admission: FolderAdmission;
}

export interface FolderInventorySnapshot {
  catalogState: FolderCatalogState["kind"];
  revision: FolderCatalogState["revision"];
  rows: FolderInventoryRow[];
}

export type FolderInventoryDeps = FolderUnionDeps;

function classify(row: Pick<FolderUnionRow, "catalog" | "binding" | "bindingConfig" | "exists" | "observationError">, state: FolderCatalogState): FolderAdmission {
  if (state.kind === "damaged") return { kind: "damaged", reason: state.reason };
  if (!row.exists) {
    return row.observationError === undefined
      ? { kind: "missing", reason: "the folder does not exist" }
      : { kind: "unbound", reason: row.observationError };
  }
  if (row.bindingConfig === undefined) {
    const reason = row.binding !== undefined && "unreadable" in row.binding
      ? row.binding.unreadable
      : "the folder has no rbox binding";
    return { kind: "unbound", reason };
  }
  if (state.kind === "absent") {
    return { kind: "damaged", reason: "rbox folder configuration is absent; run `rbox config regenerate`" };
  }
  if (row.catalog === undefined) {
    return { kind: "detached", reason: "the bound folder is not listed in the authoritative folder configuration; run `rbox config add`" };
  }
  return { kind: "admitted", generation: state.snapshot.generation, policy: row.catalog.policy };
}

function publicRow(row: FolderUnionRow, state: FolderCatalogState): FolderInventoryRow {
  return {
    root: row.root,
    ...(row.catalog === undefined ? {} : { catalog: row.catalog }),
    ...(row.registry === undefined ? {} : { registry: row.registry }),
    ...(row.desired === undefined ? {} : { desired: row.desired }),
    ...(row.binding === undefined ? {} : { binding: row.binding }),
    isCurrentRoot: row.isCurrentRoot,
    ...(row.overlap === undefined ? {} : { overlap: row.overlap }),
    admission: classify(row, state),
  };
}

export async function observeFolderAdmission(
  root: string,
  state: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderAdmission> {
  if (state.kind === "damaged") return { kind: "damaged", reason: state.reason };
  const absolute = path.resolve(root);
  const observed = await observeFolderRoot(absolute, deps);
  const catalog = state.kind === "authoritative"
    ? state.snapshot.folders.find((entry) => entry.normalizedPath === absolute)
    : undefined;
  return classify({ ...observed, ...(catalog === undefined ? {} : { catalog }) }, state);
}

export async function listFolderInventory(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderInventoryDeps = {},
): Promise<FolderInventorySnapshot> {
  const rows = await buildFolderInventoryUnion(state, context, deps);
  return {
    catalogState: state.kind,
    revision: state.revision,
    rows: rows.map((row) => publicRow(row, state)),
  };
}

export async function observeFolderGeneration(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderInventoryDeps = {},
): Promise<FolderGenerationInventory> {
  const rows = await buildFolderInventoryUnion(state, context, deps);
  const discoverableBindings: FolderGenerationInventory["discoverableBindings"] = [];
  const skipped: FolderGenerationInventory["skipped"] = [];
  for (const row of rows) {
    if (row.bindingConfig !== undefined) {
      discoverableBindings.push({ root: row.root, binding: row.bindingConfig });
    } else {
      const reason = !row.exists && row.observationError === undefined
        ? "the folder does not exist"
        : row.binding !== undefined && "unreadable" in row.binding
          ? row.binding.unreadable
          : row.observationError ?? "the folder has no rbox binding";
      skipped.push({ root: row.root, reason });
    }
  }
  return { revision: state.revision, discoverableBindings, skipped };
}
