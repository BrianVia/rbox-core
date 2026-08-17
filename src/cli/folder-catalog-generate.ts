/** Pure deterministic generation plus revision-bound regeneration publication. */
import path from "node:path";
import {
  collapseFolderPath,
  DEFAULT_FOLDER_POLICY,
  expandFolderPath,
  FOLDER_NAME_MAX_SCALARS,
  FolderCatalogStaleEditError,
  serializeFolderCatalog,
  snapshotPreCatalogPolicy,
  type FolderCatalog,
  type FolderCatalogRevision,
  type FolderCatalogSnapshot,
  type FolderCatalogState,
} from "./folder-config-codec.js";
import publishInternals, {
  publishNoReplace,
  publishReplacing,
  type FolderCatalogPublicationOptions,
} from "./folder-catalog-publish.js";
import type { WorkspaceConfig } from "./workspace-config.js";

export interface FolderGenerationInventory {
  revision: FolderCatalogRevision;
  discoverableBindings: Array<{ root: string; binding: WorkspaceConfig }>;
  skipped: Array<{ root: string; reason: string }>;
  evidenceUnavailable?: string[];
}

export interface GeneratedFolderCatalog {
  bytes: string;
  catalog: FolderCatalog;
  skipped: Array<{ root: string; reason: string }>;
}

export interface FolderRegenerationLoss {
  readonly description: string;
  readonly entries: ReadonlyArray<Readonly<{ name: string; path: string }>>;
}

const regenerationAttemptBrand: unique symbol = Symbol("FolderRegenerationAttempt");
const confirmedRegenerationBrand: unique symbol = Symbol("ConfirmedRegeneration");

export interface FolderRegenerationAttempt {
  readonly loss: FolderRegenerationLoss;
  readonly skipped: ReadonlyArray<Readonly<{ root: string; reason: string }>>;
  readonly [regenerationAttemptBrand]: true;
}

export interface ConfirmedRegeneration {
  readonly [confirmedRegenerationBrand]: true;
}

export type FolderRegenerationResult =
  | {
    kind: "published";
    snapshot: FolderCatalogSnapshot;
    skipped: ReadonlyArray<Readonly<{ root: string; reason: string }>>;
  }
  | { kind: "catalog-changed" };

interface AttemptPayload {
  bytes: string;
  revision: FolderCatalogRevision;
  skipped: ReadonlyArray<Readonly<{ root: string; reason: string }>>;
}

const attempts = new WeakMap<object, AttemptPayload>();
const confirmations = new WeakMap<object, FolderRegenerationAttempt>();

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Derive the first valid, unused local name from one normalized path. */
export function deriveFolderLabel(normalizedPath: string, taken: ReadonlySet<string>): string {
  const raw = path.basename(normalizedPath).normalize("NFC").trim();
  const base = raw.length === 0 ? "folder" : raw;
  for (let ordinal = 1; ; ordinal++) {
    const suffix = ordinal === 1 ? "" : ` (${ordinal})`;
    const remaining = FOLDER_NAME_MAX_SCALARS - Array.from(suffix).length;
    const candidate = `${Array.from(base).slice(0, Math.max(0, remaining)).join("")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function generateFolderCatalog(inventory: FolderGenerationInventory): GeneratedFolderCatalog {
  if (inventory.evidenceUnavailable?.length) {
    throw new Error(`folder binding evidence is unavailable: ${inventory.evidenceUnavailable.join("; ")}`);
  }
  const taken = new Set<string>();
  const folders = [...inventory.discoverableBindings]
    .map(({ root, binding }) => ({ root: expandFolderPath(root), binding }))
    .sort((left, right) => comparePaths(left.root, right.root))
    .map(({ root, binding }) => {
      const name = deriveFolderLabel(root, taken);
      taken.add(name);
      return {
        name,
        path: collapseFolderPath(root),
        options: snapshotPreCatalogPolicy(binding),
      };
    });
  const catalog: FolderCatalog = {
    schemaVersion: 1,
    globalOptions: {
      syncGit: DEFAULT_FOLDER_POLICY.syncGit,
      git: { incremental: DEFAULT_FOLDER_POLICY.git.incremental },
      respectGitignore: DEFAULT_FOLDER_POLICY.respectGitignore,
      noDrift: DEFAULT_FOLDER_POLICY.noDrift,
      trash: { ...DEFAULT_FOLDER_POLICY.trash },
    },
    folders,
  };
  const bytes = serializeFolderCatalog(catalog);
  return { bytes, catalog, skipped: inventory.skipped.map((entry) => ({ ...entry })) };
}

/** Publish a catalog for a home that has none. Admissible only when generation
 * omits nothing: every discoverable binding is reproduced from its own
 * pre-catalog policy, so a skipped row — the one thing generation would drop —
 * refuses instead (design 276 F1.3). Evidence gaps are refused by generation. */
export async function initializeFolderCatalog(
  inventory: FolderGenerationInventory,
  options: { publication?: FolderCatalogPublicationOptions } = {},
): Promise<FolderCatalogSnapshot> {
  if (inventory.skipped.length !== 0) {
    throw new Error("silent folder configuration initialization requires an inventory with zero skipped roots");
  }
  const generated = generateFolderCatalog(inventory);
  return (await publishNoReplace(generated.bytes, options.publication)).snapshot;
}

function lossFor(state: FolderCatalogState): FolderRegenerationLoss {
  return Object.freeze({
    description: "Regeneration cannot reconstruct local labels, ordering, global defaults, inheritance choices, overrides not reflected by current binding policy, or unbound and missing entries.",
    entries: Object.freeze(publishInternals.readableEntries(state).map((entry) => Object.freeze({ ...entry }))),
  });
}

export function prepareFolderRegeneration(
  state: FolderCatalogState,
  inventory: FolderGenerationInventory,
): FolderRegenerationAttempt {
  if (state.revision !== inventory.revision) {
    throw new Error("folder catalog state and generation inventory revisions do not match");
  }
  const generated = generateFolderCatalog(inventory);
  const skipped = Object.freeze(generated.skipped.map((entry) => Object.freeze({ ...entry })));
  const attempt = Object.freeze({
    loss: lossFor(state),
    skipped,
    [regenerationAttemptBrand]: true as const,
  });
  attempts.set(attempt, {
    bytes: generated.bytes,
    revision: state.revision,
    skipped,
  });
  return attempt;
}

/** Mint only after the confirmation Adapter accepted this exact attempt. */
export function confirmFolderRegeneration(attempt: FolderRegenerationAttempt): ConfirmedRegeneration {
  if (!attempts.has(attempt)) throw new Error("unknown folder regeneration attempt");
  const confirmation: ConfirmedRegeneration = Object.freeze({ [confirmedRegenerationBrand]: true as const });
  confirmations.set(confirmation, attempt);
  return confirmation;
}

export async function publishFolderRegeneration(
  attempt: FolderRegenerationAttempt,
  authorization: ConfirmedRegeneration,
  options: { publication?: FolderCatalogPublicationOptions } = {},
): Promise<FolderRegenerationResult> {
  const payload = attempts.get(attempt);
  if (payload === undefined || confirmations.get(authorization) !== attempt) {
    throw new Error("folder regeneration authorization does not match this attempt");
  }
  attempts.delete(attempt);
  confirmations.delete(authorization);
  try {
    const snapshot = await publishReplacing(payload.revision, payload.bytes, options.publication);
    return { kind: "published", snapshot, skipped: payload.skipped };
  } catch (error) {
    if (error instanceof FolderCatalogStaleEditError) return { kind: "catalog-changed" };
    throw error;
  }
}
