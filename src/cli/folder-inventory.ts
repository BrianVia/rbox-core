/** Read-only FolderInventory classifier and public facade (design 231 §3.2).
 *
 * Never: discovery I/O, healing/writes, remote mutation, daemon transitions, scope policy, or sync
 * orchestration.
 */
import path from "node:path";
import type { BindingRegistryRow } from "./binding-registry.js";
import type { DesiredStateRow } from "./autostart/desired-state.js";
import type {
  FolderCatalogState,
  ResolvedFolderCatalogEntry,
  ResolvedFolderPolicy,
} from "./folder-config.js";
import type { FolderGenerationInventory } from "./folder-catalog-generate.js";
import type { WorkspaceConfig } from "./workspace-config.js";
import {
  buildFolderInventoryUnion,
  observeFolderRoot,
  readFolderSourceEvidence,
  type FolderBindingObservation,
  type FolderOverlap,
  type FolderUnionDeps,
  type FolderUnionRow,
} from "./folder-inventory-union.js";

export type FolderAdmission =
  | { kind: "admitted"; generation: string; policy: ResolvedFolderPolicy }
  | { kind: "unbound" | "missing" | "detached" | "damaged" | "ambiguous"; reason: string };

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

/** The complete safe policy overlay. Runtime-only identity, credentials, E2EE
 * material, scope, and every future non-policy field remain caller-owned. */
export function folderPolicyFields(policy: ResolvedFolderPolicy): Pick<
  WorkspaceConfig,
  "syncGit" | "git" | "respectGitignore" | "ignorePaths" | "noDrift" | "trash"
> {
  return {
    syncGit: policy.syncGit,
    git: { incremental: policy.git.incremental },
    respectGitignore: policy.respectGitignore,
    ignorePaths: [...policy.ignorePaths],
    noDrift: policy.noDrift,
    trash: { days: policy.trash.days, maxBytes: policy.trash.maxBytes },
  };
}

export function applyFolderPolicy(cfg: WorkspaceConfig, policy: ResolvedFolderPolicy): WorkspaceConfig {
  const safeFieldsOnly = folderPolicyFields(policy);
  return {
    ...cfg,
    ...safeFieldsOnly,
    git: { ...cfg.git, incremental: safeFieldsOnly.git?.incremental },
  };
}

export function runtimeRefusal(admission: Exclude<FolderAdmission, { kind: "admitted" }>): Error {
  return new Error(`rbox cannot run this folder (${admission.kind}): ${admission.reason}`);
}

function classify(row: Pick<FolderUnionRow, "root" | "catalog" | "binding" | "bindingConfig" | "exists" | "observationError">, state: FolderCatalogState): FolderAdmission {
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
  // loadConfig is a tolerant cast: pre-catalog records may omit rootPath even
  // though the type requires it. A binding observed AT this root with no
  // recorded path lives here; only a conflicting recorded path is ambiguous.
  const recordedRoot = typeof row.bindingConfig.rootPath === "string"
    ? path.resolve(row.bindingConfig.rootPath)
    : row.root;
  if (recordedRoot !== row.root) {
    return {
      kind: "ambiguous",
      reason: `the binding still names ${recordedRoot}; if this folder moved here, run \`rbox config repair ${row.root}\``,
    };
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

function markDuplicateBindingIdentities(rows: FolderUnionRow[], projected: FolderInventoryRow[]): void {
  const rootsByIdentity = new Map<string, string[]>();
  for (const row of rows) {
    if (row.bindingConfig === undefined) continue;
    const key = `${row.bindingConfig.remoteWorkspaceId}\0${row.bindingConfig.deviceId}`;
    const roots = rootsByIdentity.get(key) ?? [];
    roots.push(row.root);
    rootsByIdentity.set(key, roots);
  }
  for (const roots of rootsByIdentity.values()) {
    if (roots.length < 2) continue;
    for (const root of roots) {
      const row = projected.find((candidate) => candidate.root === root);
      if (row !== undefined) {
        row.admission = {
          kind: "ambiguous",
          reason: `the same workspace and device binding also exists at ${roots.find((candidate) => candidate !== root)}`,
        };
      }
    }
  }
}

export async function observeFolderAdmission(
  root: string,
  state: FolderCatalogState,
  deps: FolderInventoryDeps = {},
): Promise<FolderAdmission> {
  if (state.kind === "damaged") return { kind: "damaged", reason: state.reason };
  const absolute = path.resolve(root);
  const rows = await buildFolderInventoryUnion(state, { currentRoot: absolute }, deps);
  const projected = rows.map((row) => publicRow(row, state));
  markDuplicateBindingIdentities(rows, projected);
  return projected.find((row) => row.root === absolute)?.admission
    ?? { kind: "missing", reason: "the folder does not exist" };
}

export async function listFolderInventory(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderInventoryDeps = {},
): Promise<FolderInventorySnapshot> {
  const rows = await buildFolderInventoryUnion(state, context, deps);
  const projected = rows.map((row) => publicRow(row, state));
  markDuplicateBindingIdentities(rows, projected);
  return {
    catalogState: state.kind,
    revision: state.revision,
    rows: projected,
  };
}

export async function observeFolderGeneration(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderInventoryDeps = {},
): Promise<FolderGenerationInventory> {
  const evidence = await readFolderSourceEvidence(deps);
  const rows = await buildFolderInventoryUnion(state, context, deps, evidence);
  const discoverableBindings: FolderGenerationInventory["discoverableBindings"] = [];
  const skipped: FolderGenerationInventory["skipped"] = [];
  for (const row of rows) {
    if (row.bindingConfig !== undefined) {
      discoverableBindings.push({ root: row.root, binding: row.bindingConfig });
    } else if (row.binding !== undefined || row.registry !== undefined || row.desired !== undefined || row.catalog !== undefined) {
      const reason = !row.exists && row.observationError === undefined
        ? "the folder does not exist"
        : row.binding !== undefined && "unreadable" in row.binding
          ? row.binding.unreadable
          : row.observationError ?? "the folder has no rbox binding";
      skipped.push({ root: row.root, reason });
    }
  }
  return {
    revision: state.revision,
    discoverableBindings,
    skipped,
    ...(evidence.unavailable.length === 0 ? {} : { evidenceUnavailable: evidence.unavailable }),
  };
}
