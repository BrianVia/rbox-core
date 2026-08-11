/**
 * Read-only source union for FolderInventory (design 231 §3.2).
 *
 * This Module preserves the evidence from each discovery source independently.
 * It never heals a registry row, binding, desired record, or catalog entry.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  readPersistedEntries,
  readPersistedEntriesStrict,
  type BindingRegistryEntry,
  type BindingRegistryRow,
} from "./binding-registry.js";
import { readDesiredDaemonRows, readDesiredDaemonRowsStrict, type DesiredStateRow } from "./autostart/desired-state.js";
import type {
  FolderCatalogState,
  ResolvedFolderCatalogEntry,
} from "./folder-config.js";
import {
  loadConfigIfPresent,
  type WorkspaceConfig,
} from "./workspace-config.js";

export type FolderBindingObservation =
  | { workspaceId: string; deviceId: string }
  | { unreadable: string };

export interface FolderOverlap {
  kind: "ancestor" | "descendant" | "alias";
  of: string;
}

export interface FolderUnionRow {
  root: string;
  catalog?: ResolvedFolderCatalogEntry;
  registry?: BindingRegistryRow;
  desired?: DesiredStateRow;
  binding?: FolderBindingObservation;
  isCurrentRoot: boolean;
  overlap?: FolderOverlap;
  /** Internal evidence used by generation; omitted from the public inventory row. */
  bindingConfig?: WorkspaceConfig;
  boundWorkspaceId?: string;
  exists: boolean;
  observationError?: string;
  realPath?: string;
}

export interface FolderUnionDeps {
  readPersistedEntries?: typeof readPersistedEntries;
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  readBoundWorkspaceId?: (root: string) => string | undefined;
  loadConfigIfPresent?: typeof loadConfigIfPresent;
  stat?: typeof fs.stat;
  realpath?: typeof fs.realpath;
}

export interface FolderSourceEvidence {
  desiredRows: DesiredStateRow[];
  persistedEntries: BindingRegistryEntry[];
  unavailable: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function observeFolderRoot(
  root: string,
  deps: FolderUnionDeps = {},
): Promise<Pick<FolderUnionRow, "binding" | "bindingConfig" | "boundWorkspaceId" | "exists" | "observationError" | "realPath">> {
  const absolute = path.resolve(root);
  let exists = false;
  let observationError: string | undefined;
  try {
    await (deps.stat ?? fs.stat)(absolute);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") observationError = errorText(error);
  }

  let binding: FolderBindingObservation | undefined;
  let bindingConfig: WorkspaceConfig | undefined;
  let boundWorkspaceId: string | undefined;
  if (exists) {
    try {
      const config = await (deps.loadConfigIfPresent ?? loadConfigIfPresent)(absolute);
      if (config !== undefined) {
        if (typeof config.remoteWorkspaceId === "string" && config.remoteWorkspaceId.length > 0) {
          boundWorkspaceId = config.remoteWorkspaceId;
        }
        if (typeof config.remoteWorkspaceId !== "string" || config.remoteWorkspaceId.length === 0
          || typeof config.deviceId !== "string" || config.deviceId.length === 0) {
          binding = { unreadable: `workspace binding at ${path.join(absolute, ".rbox", "workspace.json")} has no usable workspace/device identity` };
        } else {
          bindingConfig = config;
          binding = { workspaceId: config.remoteWorkspaceId, deviceId: config.deviceId };
        }
      }
    } catch (error) {
      binding = { unreadable: errorText(error) };
    }
  }

  let realPath: string | undefined;
  if (exists) realPath = await (deps.realpath ?? fs.realpath)(absolute).catch(() => undefined);
  return {
    exists,
    ...(observationError === undefined ? {} : { observationError }),
    ...(binding === undefined ? {} : { binding }),
    ...(bindingConfig === undefined ? {} : { bindingConfig }),
    ...(boundWorkspaceId === undefined ? {} : { boundWorkspaceId }),
    ...(realPath === undefined ? {} : { realPath }),
  };
}

function desiredEntry(row: DesiredStateRow): BindingRegistryEntry {
  return {
    root: path.resolve(row.desired.rootPath),
    workspaceId: row.desired.workspaceId,
    boundAt: row.desired.at,
    lastSeenAt: row.desired.at,
    ...(row.desired.accountId ? { accountId: row.desired.accountId } : {}),
  };
}

function registryRow(
  entry: BindingRegistryEntry,
  derived: boolean,
  current: string | undefined,
): BindingRegistryRow {
  const health = current === undefined ? "missing" : current === entry.workspaceId ? "bound" : "rebound";
  return {
    ...entry,
    derived,
    health,
    ...(current === undefined ? {} : { currentWorkspaceId: current }),
  };
}

function lexicalOverlap(root: string, other: string): FolderOverlap | undefined {
  const relative = path.relative(root, other);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return { kind: "ancestor", of: other };
  }
  const inverse = path.relative(other, root);
  if (inverse !== "" && inverse !== ".." && !inverse.startsWith(`..${path.sep}`) && !path.isAbsolute(inverse)) {
    return { kind: "descendant", of: other };
  }
  return undefined;
}

function attachOverlaps(rows: FolderUnionRow[]): void {
  for (const row of rows) {
    for (const other of rows) {
      if (other === row) continue;
      const overlap = row.realPath !== undefined && row.realPath === other.realPath
        ? { kind: "alias" as const, of: other.root }
        : lexicalOverlap(row.root, other.root);
      if (overlap !== undefined) {
        row.overlap = overlap;
        break;
      }
    }
  }
}

export async function buildFolderInventoryUnion(
  state: FolderCatalogState,
  context: { currentRoot?: string } = {},
  deps: FolderUnionDeps = {},
  sourceEvidence?: FolderSourceEvidence,
): Promise<FolderUnionRow[]> {
  const evidence = sourceEvidence ?? await readFolderSourceEvidence(deps);
  const { desiredRows, persistedEntries } = evidence;
  const currentRoot = context.currentRoot === undefined ? undefined : path.resolve(context.currentRoot);
  const byRoot = new Map<string, {
    catalog?: ResolvedFolderCatalogEntry;
    desired?: DesiredStateRow;
    persisted?: BindingRegistryEntry;
  }>();
  const at = (root: string) => {
    const absolute = path.resolve(root);
    const evidence = byRoot.get(absolute) ?? {};
    byRoot.set(absolute, evidence);
    return evidence;
  };

  if (state.kind === "authoritative") {
    for (const catalog of state.snapshot.folders) at(catalog.normalizedPath).catalog = catalog;
  }
  for (const desired of desiredRows) {
    const evidence = at(desired.desired.rootPath);
    if (evidence.desired === undefined) evidence.desired = desired;
  }
  for (const persisted of persistedEntries) at(persisted.root).persisted = { ...persisted, root: path.resolve(persisted.root) };
  if (currentRoot !== undefined) at(currentRoot);

  const rows = await Promise.all([...byRoot.entries()].sort(([a], [b]) => a.localeCompare(b)).map(async ([root, evidence]) => {
    const observed = await observeFolderRoot(root, deps);
    const entry = evidence.persisted ?? (evidence.desired === undefined ? undefined : desiredEntry(evidence.desired));
    const current = deps.readBoundWorkspaceId === undefined
      ? observed.boundWorkspaceId
      : deps.readBoundWorkspaceId(root);
    return {
      root,
      ...(evidence.catalog === undefined ? {} : { catalog: evidence.catalog }),
      ...(evidence.desired === undefined ? {} : { desired: evidence.desired }),
      ...(entry === undefined ? {} : { registry: registryRow(entry, evidence.persisted === undefined, current) }),
      isCurrentRoot: root === currentRoot,
      ...observed,
    } satisfies FolderUnionRow;
  }));
  attachOverlaps(rows);
  return rows;
}

export async function readFolderSourceEvidence(deps: FolderUnionDeps = {}): Promise<FolderSourceEvidence> {
  const [desired, persisted] = await Promise.allSettled([
    (deps.readDesiredDaemonRows ?? readDesiredDaemonRowsStrict)(),
    (deps.readPersistedEntries ?? readPersistedEntriesStrict)(),
  ]);
  return {
    desiredRows: desired.status === "fulfilled" ? desired.value : [],
    persistedEntries: persisted.status === "fulfilled" ? persisted.value : [],
    unavailable: [
      ...(desired.status === "rejected" ? [errorText(desired.reason)] : []),
      ...(persisted.status === "rejected" ? [errorText(persisted.reason)] : []),
    ],
  };
}
