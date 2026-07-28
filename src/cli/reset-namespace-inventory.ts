import type { BigIntStats, Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RBOX_DIR } from "./workspace-config.js";

export const RESET_NAMESPACE_ENTRY_LIMIT = 16_384;
export const RESET_NAMESPACE_CHURN_RETRY_LIMIT = 3;

const HEX32 = /^[0-9a-f]{32}$/;
const CANDIDATE = /^([0-9a-f]{32})\.(db|json)(?:(-wal|-shm|-journal))?$/;
const ARCHIVE = /^([0-9a-f]{64})\.(db|json)(?:(-wal|-shm|-journal))?$/;
const PROTOCOL_TEMP = /^\.rbox-tmp-[0-9]{1,10}-(?:[0-9]{1,10}|[0-9a-f]{16})-.+$/;

export type ResetNamespaceInventoryErrorCode =
  | "RESET_NAMESPACE_INVALID"
  | "RESET_NAMESPACE_BUSY"
  | "RESET_LEGACY_ARTIFACT_INVALID";

export class ResetNamespaceInventoryError extends Error {
  readonly name = "ResetNamespaceInventoryError";

  constructor(
    readonly code: ResetNamespaceInventoryErrorCode,
    readonly artifactPath: string,
    readonly artifactType: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${artifactType} at ${artifactPath}`, options);
  }
}

export type InventoryLeafStatus = "absent" | "regular" | "other";
export type ResetDbSidecarVector = "S0" | "SW" | "other";

export interface ResetDbArtifactInventory {
  kind: "active" | "candidate" | "archive";
  path: string;
  journalId?: string;
  stateNonce?: string;
  stateSha256?: string;
  main: InventoryLeafStatus;
  wal: InventoryLeafStatus;
  shm: InventoryLeafStatus;
  rollbackJournal: InventoryLeafStatus;
  sidecarVector: ResetDbSidecarVector;
}

export interface ResetLegacyArtifactInventory {
  kind: "candidate" | "archive";
  path: string;
  journalId?: string;
  stateNonce?: string;
  stateSha256?: string;
  status: "legacy-exact" | "legacy-other";
}

export interface ResetNamespaceInventory {
  stateRoot: string;
  active: ResetDbArtifactInventory;
  candidates: ResetDbArtifactInventory[];
  archives: ResetDbArtifactInventory[];
  legacyCandidates: ResetLegacyArtifactInventory[];
  legacyArchives: ResetLegacyArtifactInventory[];
  inertTemps: string[];
  entryCount: number;
}

export function resetDbArtifacts(
  inventory: ResetNamespaceInventory,
): readonly ResetDbArtifactInventory[] {
  return [inventory.active, ...inventory.candidates, ...inventory.archives];
}

export function resetInventoryHasNonS0(inventory: ResetNamespaceInventory): boolean {
  return resetDbArtifacts(inventory).some((artifact) => artifact.sidecarVector !== "S0");
}

export function resetLegacyOtherArtifacts(
  inventory: ResetNamespaceInventory,
): readonly ResetLegacyArtifactInventory[] {
  return [...inventory.legacyCandidates, ...inventory.legacyArchives]
    .filter((artifact) => artifact.status === "legacy-other");
}

/** Call only after standing-journal sidecar precedence has been evaluated. */
export function assertResetLegacyArtifactsValid(inventory: ResetNamespaceInventory): void {
  const invalidArtifact = resetLegacyOtherArtifacts(inventory)[0];
  if (invalidArtifact) {
    throw new ResetNamespaceInventoryError(
      "RESET_LEGACY_ARTIFACT_INVALID",
      invalidArtifact.path,
      "legacy-other",
    );
  }
}

/** Test seams only. Production callers must use the normative defaults. */
export interface ResetNamespaceInventoryTestOptions {
  entryLimit?: number;
  maxAttempts?: number;
  afterDirectoryRead?: (directory: string, attempt: number) => void | Promise<void>;
}

class NamespaceChurn extends Error {}

function enoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mode === b.mode
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs;
}

function readable(mode: bigint, directory: boolean): boolean {
  return (mode & (directory ? 0o555n : 0o444n)) !== 0n;
}

function invalid(artifactPath: string, artifactType: string, cause?: unknown): never {
  throw new ResetNamespaceInventoryError(
    "RESET_NAMESPACE_INVALID",
    artifactPath,
    artifactType,
    cause === undefined ? undefined : { cause },
  );
}

async function lstatOptional(artifactPath: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(artifactPath, { bigint: true });
  } catch (error) {
    if (enoent(error)) return undefined;
    invalid(artifactPath, "unreadable-entry", error);
  }
}

async function requirePlainDirectory(directory: string): Promise<BigIntStats> {
  const stat = await lstatOptional(directory);
  if (!stat) invalid(directory, "missing-directory");
  if (stat.isSymbolicLink()) invalid(directory, "directory-symlink");
  if (!stat.isDirectory()) invalid(directory, "non-directory");
  if (!readable(stat.mode, true)) invalid(directory, "unreadable-directory");
  return stat;
}

async function observeLeaf(artifactPath: string): Promise<InventoryLeafStatus> {
  const before = await lstatOptional(artifactPath);
  if (!before) return "absent";
  const after = await lstatOptional(artifactPath);
  if (!after || !sameIdentity(before, after)) return "other";
  if (before.isSymbolicLink() || !before.isFile() || !readable(before.mode, false)) return "other";
  return "regular";
}

function sidecarVector(
  main: InventoryLeafStatus,
  wal: InventoryLeafStatus,
  shm: InventoryLeafStatus,
  rollbackJournal: InventoryLeafStatus,
): ResetDbSidecarVector {
  if (wal === "absent" && shm === "absent" && rollbackJournal === "absent") return "S0";
  if (
    main === "regular"
    && rollbackJournal === "absent"
    && (wal === "regular" || shm === "regular")
    && wal !== "other"
    && shm !== "other"
  ) return "SW";
  return "other";
}

async function observeDb(
  kind: ResetDbArtifactInventory["kind"],
  mainPath: string,
  identity: Pick<ResetDbArtifactInventory, "journalId" | "stateNonce" | "stateSha256"> = {},
): Promise<ResetDbArtifactInventory> {
  const [main, wal, shm, rollbackJournal] = await Promise.all([
    observeLeaf(mainPath),
    observeLeaf(`${mainPath}-wal`),
    observeLeaf(`${mainPath}-shm`),
    observeLeaf(`${mainPath}-journal`),
  ]);
  return {
    kind,
    path: mainPath,
    ...identity,
    main,
    wal,
    shm,
    rollbackJournal,
    sidecarVector: sidecarVector(main, wal, shm, rollbackJournal),
  };
}

async function observeLegacy(
  kind: ResetLegacyArtifactInventory["kind"],
  artifactPath: string,
  identity: Pick<ResetLegacyArtifactInventory, "journalId" | "stateNonce" | "stateSha256">,
): Promise<ResetLegacyArtifactInventory> {
  const status = await observeLeaf(artifactPath);
  return {
    kind,
    path: artifactPath,
    ...identity,
    status: status === "regular" ? "legacy-exact" : "legacy-other",
  };
}

function byteSort<T extends { name: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
}

function comparePathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.from(a.path).compare(Buffer.from(b.path));
}

interface AttemptContext {
  attempt: number;
  count: number;
  entryLimit: number;
  hook?: ResetNamespaceInventoryTestOptions["afterDirectoryRead"];
}

async function readBracketed(directory: string, context: AttemptContext): Promise<Dirent[]> {
  const before = await requirePlainDirectory(directory);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    invalid(directory, "unreadable-directory", error);
  }
  context.count += entries.length;
  if (context.count > context.entryLimit) invalid(directory, "entry-limit-overflow");
  await context.hook?.(directory, context.attempt);
  const after = await lstatOptional(directory);
  if (!after || !sameIdentity(before, after)) throw new NamespaceChurn();
  return byteSort(entries);
}

async function optionalDirectoryEntries(
  directory: string,
  parent: string,
  context: AttemptContext,
): Promise<Dirent[] | undefined> {
  const parentBefore = await requirePlainDirectory(parent);
  const stat = await lstatOptional(directory);
  if (!stat) {
    const parentAfter = await requirePlainDirectory(parent);
    if (!sameIdentity(parentBefore, parentAfter)) throw new NamespaceChurn();
    return undefined;
  }
  if (stat.isSymbolicLink()) invalid(directory, "directory-symlink");
  if (!stat.isDirectory()) invalid(directory, "non-directory");
  return readBracketed(directory, context);
}

function acceptTemp(name: string, directory: string, temps: string[]): boolean {
  if (!PROTOCOL_TEMP.test(name)) return false;
  temps.push(path.join(directory, name));
  return true;
}

async function inventoryAttempt(
  root: string,
  context: AttemptContext,
): Promise<ResetNamespaceInventory> {
  await requirePlainDirectory(root);
  const rboxRoot = path.join(root, RBOX_DIR);
  const rootBefore = await requirePlainDirectory(root);
  const rboxStat = await lstatOptional(rboxRoot);
  const stateRoot = path.join(rboxRoot, "state");
  if (!rboxStat) {
    const active = await observeDb("active", path.join(stateRoot, "state.db"));
    const rootAfter = await requirePlainDirectory(root);
    if (!sameIdentity(rootBefore, rootAfter)) throw new NamespaceChurn();
    return emptyInventory(stateRoot, active);
  }
  if (rboxStat.isSymbolicLink() || !rboxStat.isDirectory() || !readable(rboxStat.mode, true)) {
    invalid(
      rboxRoot,
      rboxStat.isSymbolicLink()
        ? "directory-symlink"
        : rboxStat.isDirectory()
          ? "unreadable-directory"
          : "non-directory",
    );
  }
  const rboxBefore = await requirePlainDirectory(rboxRoot);
  const stateStat = await lstatOptional(stateRoot);
  if (!stateStat) {
    const active = await observeDb("active", path.join(stateRoot, "state.db"));
    const rboxAfter = await requirePlainDirectory(rboxRoot);
    if (!sameIdentity(rboxBefore, rboxAfter)) throw new NamespaceChurn();
    return emptyInventory(stateRoot, active);
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory() || !readable(stateStat.mode, true)) {
    invalid(
      stateRoot,
      stateStat.isSymbolicLink()
        ? "directory-symlink"
        : stateStat.isDirectory()
          ? "unreadable-directory"
          : "non-directory",
    );
  }

  const stateBefore = await requirePlainDirectory(stateRoot);
  const stateEntries = await readBracketed(stateRoot, context);
  const inertTemps: string[] = [];
  for (const entry of stateEntries) {
    if (acceptTemp(entry.name, stateRoot, inertTemps)) continue;
    if (entry.name.startsWith(".rbox-tmp-")) {
      invalid(path.join(stateRoot, entry.name), "invalid-reserved-name");
    }
  }
  const active = await observeDb("active", path.join(stateRoot, "state.db"));
  const candidates: ResetDbArtifactInventory[] = [];
  const archives: ResetDbArtifactInventory[] = [];
  const legacyCandidates: ResetLegacyArtifactInventory[] = [];
  const legacyArchives: ResetLegacyArtifactInventory[] = [];

  const candidateRoot = path.join(stateRoot, "reset-candidates");
  const candidateEntries = await optionalDirectoryEntries(candidateRoot, stateRoot, context);
  for (const entry of candidateEntries ?? []) {
    if (acceptTemp(entry.name, candidateRoot, inertTemps)) continue;
    const match = CANDIDATE.exec(entry.name);
    if (!match || (match[2] === "json" && match[3] !== undefined)) {
      invalid(path.join(candidateRoot, entry.name), "invalid-reserved-name");
    }
    const journalId = match[1]!;
    const stemPath = path.join(candidateRoot, `${journalId}.${match[2]}`);
    if (match[2] === "json") {
      if (match[3] === undefined) legacyCandidates.push(await observeLegacy("candidate", stemPath, { journalId }));
    } else if (!candidates.some((item) => item.path === stemPath)) {
      candidates.push(await observeDb("candidate", stemPath, { journalId }));
    }
  }

  const lineageRoot = path.join(stateRoot, "lineages");
  const lineageEntries = await optionalDirectoryEntries(lineageRoot, stateRoot, context);
  for (const lineage of lineageEntries ?? []) {
    if (acceptTemp(lineage.name, lineageRoot, inertTemps)) continue;
    const lineagePath = path.join(lineageRoot, lineage.name);
    if (!HEX32.test(lineage.name)) invalid(lineagePath, "invalid-reserved-name");
    const archiveEntries = await readBracketed(lineagePath, context);
    for (const entry of archiveEntries) {
      if (acceptTemp(entry.name, lineagePath, inertTemps)) continue;
      const match = ARCHIVE.exec(entry.name);
      if (!match || (match[2] === "json" && match[3] !== undefined)) {
        invalid(path.join(lineagePath, entry.name), "invalid-reserved-name");
      }
      const stateSha256 = match[1]!;
      const stemPath = path.join(lineagePath, `${stateSha256}.${match[2]}`);
      if (match[2] === "json") {
        if (match[3] === undefined) {
          legacyArchives.push(await observeLegacy("archive", stemPath, {
            stateNonce: lineage.name,
            stateSha256,
          }));
        }
      } else if (!archives.some((item) => item.path === stemPath)) {
        archives.push(await observeDb("archive", stemPath, {
          stateNonce: lineage.name,
          stateSha256,
        }));
      }
    }
  }

  const stateAfter = await requirePlainDirectory(stateRoot);
  if (!sameIdentity(stateBefore, stateAfter)) throw new NamespaceChurn();
  candidates.sort(comparePathBytes);
  archives.sort(comparePathBytes);
  legacyCandidates.sort(comparePathBytes);
  legacyArchives.sort(comparePathBytes);
  inertTemps.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return {
    stateRoot,
    active,
    candidates,
    archives,
    legacyCandidates,
    legacyArchives,
    inertTemps,
    entryCount: context.count,
  };
}

function emptyInventory(stateRoot: string, active: ResetDbArtifactInventory): ResetNamespaceInventory {
  return {
    stateRoot,
    active,
    candidates: [],
    archives: [],
    legacyCandidates: [],
    legacyArchives: [],
    inertTemps: [],
    entryCount: 0,
  };
}

export async function inventoryResetNamespace(
  rootInput: string,
  testOptions: ResetNamespaceInventoryTestOptions = {},
): Promise<ResetNamespaceInventory> {
  const root = path.resolve(rootInput);
  const maxAttempts = testOptions.maxAttempts ?? (RESET_NAMESPACE_CHURN_RETRY_LIMIT + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await inventoryAttempt(root, {
        attempt,
        count: 0,
        entryLimit: testOptions.entryLimit ?? RESET_NAMESPACE_ENTRY_LIMIT,
        hook: testOptions.afterDirectoryRead,
      });
    } catch (error) {
      if (!(error instanceof NamespaceChurn)) throw error;
      if (attempt === maxAttempts) {
        throw new ResetNamespaceInventoryError("RESET_NAMESPACE_BUSY", root, "directory-identity-churn");
      }
    }
  }
  throw new ResetNamespaceInventoryError("RESET_NAMESPACE_BUSY", root, "directory-identity-churn");
}

export async function hasResetLineageProvenance(root: string): Promise<boolean> {
  const inventory = await inventoryResetNamespace(root);
  return inventory.archives.some((archive) => archive.main === "regular")
    || inventory.legacyArchives.some((archive) => archive.status === "legacy-exact");
}
