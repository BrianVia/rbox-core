import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../json.js";
import { canonicalize } from "../engine/e2ee/jcs.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { acquireLock, type OwnedLock } from "../engine/lockfile.js";
import {
  withRepositoryRecoveryFence,
  type RepositoryProtocolFenceRequest,
} from "../cli/sync-git/protocol-locks.js";
import {
  assertStateReadable,
  recordLastWriterWitness,
  StateFormatTooNewError,
  StateWriteRefusedError,
} from "./state-plane/index.js";
import type { SyncState } from "./sync-state-model.js";
import {
  classifyResetPhysicalSignature,
} from "./reset-journal-classifier.js";
import {
  RESET_STREAM_BYTE_LIMIT,
  ResetCorruptionError,
  assertResetParseAdmission,
  boundedCopy,
  boundedEqualsBytes,
  boundedHash,
  boundedRead,
  parseResetJsonBytes,
} from "./reset-io.js";
import {
  decodeResetJournalBytes,
  encodeResetJournal,
  resetJournalFileSource,
  decodeResetJournal,
  type SQLiteResetJournalV2,
} from "./reset-journal-codec.js";
import {
  createResetFenceObservation,
  assertResetProtocolFence,
  internalResetFenceObservation,
  observeLegacyResetPhysical,
  resetFenceRequests,
  ResetRecoveryHaltError,
  type ResetFenceObservation,
  type ResetArtifactObservation,
  type ResetJournalHooks,
  type ResetJournalInspection,
  type StandingResetInspection,
} from "./reset-journal-inspection.js";
export {
  ResetRecoveryHaltError,
  type ResetFenceObservation,
  type ResetArtifactObservation,
  type ResetJournalHooks,
  type ResetJournalInspection,
} from "./reset-journal-inspection.js";
import { compareResetZEntries, type ResetZEntry } from "./reset-z.js";
import { classifyStateFormat } from "./state-plane/authority-marker.js";
import { stateLockPath, statePath } from "./state-plane/paths.js";
import {
  acquireWorkspaceSyncMutex,
  assertHealthyOwnedSyncMutex,
  releaseWorkspaceSyncMutex,
  type WorkspaceSyncMutex,
} from "./sync-mutex.js";
import {
  createResetRecoveryRefs,
  deleteExactResetRecoveryRef,
  exactResetRecoveryRefs,
  observeResetRefs,
  retireResetActiveGroups,
} from "./reset-z-runtime.js";
import {
  validateResetJournalV1,
  validateResetJournalV2,
  type ResetConsentKind,
  type ResetJournal,
  type ResetJournalAuthorization,
  type ResetJournalV1,
  type ResetJournalV2,
  type ResetNextState,
  type ResetPhase,
} from "./reset-journal-legacy-schema.js";
export {
  validateResetJournalV1,
  validateResetJournalV2,
  type ResetConsentKind,
  type ResetJournal,
  type ResetJournalAuthorization,
  type ResetJournalV1,
  type ResetJournalV2,
  type ResetNextState,
  type ResetPhase,
} from "./reset-journal-legacy-schema.js";

const HEX32 = /^[0-9a-f]{32}$/;
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_TEXT = 4096;

export type { ResetZEntry } from "./reset-z.js";

const counter = (value: number | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: string): boolean => Buffer.byteLength(value) <= MAX_TEXT && !value.includes("\0");
const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalLine = (value: JsonValue): Buffer => Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);
const corruption = (message: string): ResetCorruptionError => new ResetCorruptionError(message);

function assertResetOwner(root: string, stateLock: OwnedLock, target: string): void {
  if (path.resolve(stateLock.path) !== path.resolve(stateLockPath(root))) {
    throw new StateWriteRefusedError("state-lock-unavailable", target, "held lock has the wrong canonical path");
  }
  if (!stateLock.isOwnerSync()) throw new StateWriteRefusedError("state-lock-lease-lost", target);
}

export const resetJournalPath = (root: string): string => path.join(root, ".rbox", "state", "reset-v1.json");
export const resetCandidatePath = (root: string, id: string): string => path.join(root, ".rbox", "state", "reset-candidates", `${id}.json`);
export const resetArchivePath = (root: string, nonce: string, hash: string): string => path.join(root, ".rbox", "state", "lineages", nonce, `${hash}.json`);
export const resetIncarnationPath = (root: string): string => path.join(root, ".rbox", "state", "state-incarnation.json");
const activeStatePath = (root: string): string => path.join(root, ".rbox", "state.json");

async function parseJournal(bytes: Uint8Array): Promise<ResetJournal> {
  const decoded = await decodeResetJournalBytes(bytes);
  if (!decoded.ok) throw corruption(decoded.error.code === "JSON_SYNTAX"
    ? "malformed reset journal JSON"
    : `reset journal decoder rejected: ${decoded.error.code}`);
  if ("stateFormat" in decoded.journal) throw corruption("SQLite reset journal requires DB-artifact dispatch");
  if (decoded.journal.v === 1) {
    return {
      ...decoded.journal,
      old: { ...decoded.journal.old, archiveBaseline: "absent" },
    } as ResetJournalV1;
  }
  return decoded.journal as ResetJournalV2;
}

export async function readResetJournal(root: string): Promise<ResetJournal | undefined> {
  const file = resetJournalPath(root);
  try {
    const decoded = await decodeResetJournal(await resetJournalFileSource(file));
    if (!decoded.ok) throw corruption(decoded.error.code === "JSON_SYNTAX"
      ? "malformed reset journal JSON"
      : `reset journal decoder rejected: ${decoded.error.code}`);
    if ("stateFormat" in decoded.journal) throw corruption("SQLite reset journal requires DB-artifact dispatch");
    return decoded.journal.v === 1
      ? { ...decoded.journal, old: { ...decoded.journal.old, archiveBaseline: "absent" } } as ResetJournalV1
      : decoded.journal as ResetJournalV2;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function durableWrite(root: string, file: string, bytes: Uint8Array, stateLock: OwnedLock): Promise<void> {
  assertResetOwner(root, stateLock, file);
  const parent = path.dirname(file);
  const created = await ensureDirectoryChain(parent, "reset journal directory");
  const existing = await fs.lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw corruption(`unsafe path ${file}`);
  await writeFileAtomic(file, bytes, {
    mode: 0o600,
    beforeRenameSync: () => assertResetOwner(root, stateLock, file),
  });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

async function expectedAbsentOrExact(root: string, file: string, bytes: Uint8Array, stateLock: OwnedLock): Promise<void> {
  const equal = await boundedEqualsBytes(file, bytes, RESET_STREAM_BYTE_LIMIT);
  if (equal === true) return;
  if (equal === false) throw corruption(`wrong existing bytes at ${file}`);
  await durableWrite(root, file, bytes, stateLock);
}

function legacyArtifactPaths(root: string, journal: ResetJournalV2): ResetArtifactObservation["artifactPaths"] {
  const paths = {
    active: activeStatePath(root), candidate: resetCandidatePath(root, journal.id),
    archive: resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256),
    marker: resetIncarnationPath(root), journal: resetJournalPath(root),
  };
  return paths;
}

/** Validate a quarantined journal envelope and observe its referenced physical
 * marker/ref plane without publishing that journal at the live path. */
export async function observeResetJournalBytes(
  root: string,
  bytes: Buffer,
): Promise<{ journal: ResetJournalV2; observation: ResetArtifactObservation }> {
  const parsed = await parseJournal(bytes);
  if (parsed.v !== 2) throw corruption("legacy reset journal has no restorable physical preconditions");
  return { journal: parsed, observation: await observeLegacyResetPhysical(parsed, legacyArtifactPaths(root, parsed)) };
}

export async function inspectResetJournal(root: string, callerStream?: string): Promise<ResetJournalInspection> {
  if (await classifyStateFormat(activeStatePath(root)) === "authority-marker") {
    const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
    const sqlite = await sqliteResetFacade.inspect(root, callerStream);
    if (sqlite.status === "steady" || sqlite.status === "none") return { status: "none" };
    if (sqlite.status === "w1") return { status: "w1" };
    if (sqlite.status === "halt") {
      return {
        status: "halt",
        reason: `${sqlite.row}: ${sqlite.reason}`,
        ...(sqlite.decodeError === undefined ? {} : { decodeError: sqlite.decodeError }),
      };
    }
    return {
      status: "recoverable",
      journalIdentityHash: sqlite.journalIdentityHash,
      journal: sqlite.journal,
      configDisposition: sqlite.configDisposition,
      row: sqlite.row,
      observation: { ...sqlite.row.observation, artifactPaths: sqlite.paths },
    };
  }
  const file = resetJournalPath(root);
  let decoded: Awaited<ReturnType<typeof decodeResetJournal>>;
  try { decoded = await decodeResetJournal(await resetJournalFileSource(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    const journalIdentityHash = await boundedHash(file, RESET_STREAM_BYTE_LIMIT).catch(() => undefined);
    return { status: "halt", reason: error instanceof Error ? error.message : "unreadable reset journal", journalIdentityHash };
  }
  if (!decoded.ok) {
    const journalIdentityHash = await boundedHash(file, RESET_STREAM_BYTE_LIMIT).catch(() => undefined);
    const reason = decoded.error.code === "JSON_SYNTAX"
      ? "reset-corruption: malformed reset journal JSON"
      : decoded.error.code === "DEPTH_LIMIT"
        ? "reset-corruption: malformed reset journal JSON (nesting limit)"
        : `reset-corruption: reset journal decoder rejected: ${decoded.error.code}`;
    return { status: "halt", reason, journalIdentityHash };
  }
  const journalIdentityHash = decoded.rawSha256;
  if ("stateFormat" in decoded.journal) {
    return { status: "halt", reason: "SQLite reset journal requires DB-artifact dispatch", journalIdentityHash };
  }
  const journal = decoded.journal.v === 1
    ? { ...decoded.journal, old: { ...decoded.journal.old, archiveBaseline: "absent" } } as ResetJournalV1
    : decoded.journal as ResetJournalV2;
  if (journal.v === 1) return { status: "halt", reason: "legacy reset journal v1 has no authorization witness", journalIdentityHash, journal };
  if (callerStream !== journal.old.stream && callerStream !== journal.next.stream) {
    return { status: "halt", reason: callerStream === undefined ? "caller stream is unavailable" : "durable config names neither authorized reset stream", journalIdentityHash, journal };
  }
  let observation: ResetArtifactObservation;
  try { observation = await observeLegacyResetPhysical(journal, legacyArtifactPaths(root, journal)); }
  catch (error) {
    // The barrier is fail-closed and typed; demoting it to a generic reset halt
    // would tell the user to repair a reset that is not the problem.
    if (error instanceof StateFormatTooNewError) throw error;
    return { status: "halt", reason: error instanceof Error ? error.message : "physical reset inspection failed", journalIdentityHash, journal };
  }
  const row = classifyResetPhysicalSignature(observation);
  if (!row) return { status: "halt", reason: "physical reset state matches no authorized recovery row", journalIdentityHash, journal, observation };
  return { status: "recoverable", journalIdentityHash, journal, configDisposition: callerStream === journal.old.stream ? "old" : "next", row, observation };
}

export interface ResetFenceInventory {
  settlement: "none" | "required";
  requests: readonly RepositoryProtocolFenceRequest[];
  observation: ResetFenceObservation;
}
async function inspectStanding(root: string, callerStream?: string): Promise<StandingResetInspection> {
  if (await classifyStateFormat(activeStatePath(root)) === "authority-marker") {
    const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
    const inspection = await sqliteResetFacade.inspect(root, callerStream);
    if (inspection.status === "none" || inspection.status === "steady") return { kind: "none" };
    if (inspection.status === "halt" && inspection.reason === "RESET_ACTIVE_ARTIFACT_INVALID") {
      return { kind: "none" };
    }
    if (inspection.status === "w1") return { kind: "w1" };
    return { kind: "sqlite", inspection };
  }
  const inspection = await inspectResetJournal(root, callerStream);
  return inspection.status === "none" ? { kind: "none" } : { kind: "legacy", inspection };
}

export async function inspectResetFenceInventory(
  root: string,
  callerStream?: string,
): Promise<ResetFenceInventory> {
  const standing = await inspectStanding(root, callerStream);
  const observation = await createResetFenceObservation(root, callerStream, standing, [
    activeStatePath(root), resetJournalPath(root), path.join(root, ".rbox", "state", "state.db"),
    path.join(root, ".rbox", "state", "state.db-wal"), path.join(root, ".rbox", "state", "state.db-shm"),
  ]);
  return {
    settlement: standing.kind === "none" ? "none" : "required",
    requests: resetFenceRequests(standing),
    observation,
  };
}

export async function settleStandingResetUnderHeldFence(
  root: string,
  callerStream: string | undefined,
  expected: ResetFenceObservation,
  heldStateLock: OwnedLock,
  hooks: ResetJournalHooks = {},
): Promise<"none" | "complete"> {
  const prior = internalResetFenceObservation(expected);
  if (prior.root !== path.resolve(root) || prior.callerStream !== callerStream) {
    throw new Error("reset fence observation belongs to a different request");
  }
  assertResetOwner(root, heldStateLock, statePath(root));
  const current = await inspectResetFenceInventory(root, callerStream);
  assertResetProtocolFence(root, current.requests);
  const fresh = internalResetFenceObservation(current.observation);
  if (fresh.fingerprint !== prior.fingerprint) throw new Error("standing reset changed under the complete fence");
  if (fresh.standing.kind === "none") return "none";
  if (fresh.standing.kind === "legacy") {
    if (fresh.standing.inspection.status === "halt") throw new ResetRecoveryHaltError(fresh.standing.inspection);
    return recoverResetJournalUnderHeldFence(root, callerStream ?? "", hooks, heldStateLock);
  }
  const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
  return sqliteResetFacade.recover(root, callerStream ?? "", heldStateLock, hooks);
}

export async function settleStandingReset(
  root: string,
  heldMutex: WorkspaceSyncMutex,
  callerStream?: string,
  hooks: ResetJournalHooks = {},
): Promise<"none" | "complete"> {
  await assertHealthyOwnedSyncMutex(heldMutex, root);
  const inventory = await inspectResetFenceInventory(root, callerStream);
  if (inventory.settlement === "none") return "none";
  return withRepositoryRecoveryFence(inventory.requests, path.resolve(statePath(root)), async () => {
    const acquired = await acquireLock(stateLockPath(root));
    if (acquired.status !== "acquired") throw new Error("reset refused: canonical state lock unavailable during recovery");
    try {
      return await settleStandingResetUnderHeldFence(
        root, callerStream, inventory.observation, acquired.lock, hooks,
      );
    } finally {
      await acquired.lock.release();
    }
  });
}

export async function beginSelectedReset(
  root: string,
  nextStream: string,
  expectedOld: { stream: string; stateNonce: string },
  z: readonly ResetZEntry[],
  authorization: ResetJournalAuthorization,
  heldStateLock: OwnedLock,
  hooks: ResetJournalHooks = {},
): Promise<{ recoveryStream: string }> {
  assertResetProtocolFence(root, []);
  assertResetOwner(root, heldStateLock, statePath(root));
  if (await classifyStateFormat(statePath(root)) === "authority-marker") {
    const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
    await sqliteResetFacade.begin(
      root, nextStream, expectedOld, [...z], authorization, heldStateLock, hooks,
    );
    return { recoveryStream: expectedOld.stream };
  }
  await assertStateReadable(statePath(root));
  const oldBytes = await boundedRead(statePath(root), RESET_STREAM_BYTE_LIMIT);
  if (!oldBytes) throw new Error("reset refused: active JSON state disappeared before begin");
  assertResetParseAdmission(oldBytes.byteLength);
  const oldState = parseResetJsonBytes<SyncState>(oldBytes, statePath(root));
  if (oldState.stream !== expectedOld.stream || oldState.stateNonce !== expectedOld.stateNonce) {
    throw new Error("reset refused: active JSON lineage changed before begin");
  }
  await beginResetJournal(root, nextStream, oldBytes, oldState, [...z], authorization, heldStateLock, hooks);
  return { recoveryStream: expectedOld.stream };
}

async function writeJournal(root: string, journal: ResetJournalV2, stateLock: OwnedLock): Promise<void> {
  validateResetJournalV2(journal);
  await durableWrite(root, resetJournalPath(root), await encodeResetJournal(journal as import("./reset-journal-codec.js").ResetJournalV2), stateLock);
}

async function setPhase(root: string, journal: ResetJournalV2, nextPhase: ResetPhase, hooks: ResetJournalHooks, stateLock: OwnedLock): Promise<ResetJournalV2> {
  const next = { ...journal, phase: nextPhase };
  await writeJournal(root, next, stateLock);
  await hooks.crashAt?.(`after-${nextPhase}`);
  return next;
}

export async function recoverResetJournalUnderHeldFence(
  root: string,
  callerStream: string,
  hooks: ResetJournalHooks,
  stateLock: OwnedLock,
): Promise<"none" | "complete"> {
  assertResetOwner(root, stateLock, activeStatePath(root));
  await assertStateReadable(activeStatePath(root));
  let inspection = await inspectResetJournal(root, callerStream);
  if (inspection.status === "none") return "none";
  if (inspection.status === "halt") throw new ResetRecoveryHaltError(inspection);
  if (inspection.status !== "recoverable") throw corruption("SQLite WAL crash has no legacy reset journal to recover");
  if ("stateFormat" in inspection.journal) {
    throw corruption("state format changed before legacy reset recovery");
  }
  let journal = inspection.journal;
  const candidatePath = resetCandidatePath(root, journal.id);
  const archivePath = resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256);
  const nextBytes = canonicalLine(journal.next.state);

  if (journal.phase === "prepared") {
    const rowId = inspection.row.ids[0]!;
    if (rowId === "P0" || rowId === "P0A") {
      await expectedAbsentOrExact(root, candidatePath, nextBytes, stateLock);
      await hooks.crashAt?.("after-candidate-create");
    }
    if (rowId === "P0" || rowId === "P1") {
      await assertStateReadable(activeStatePath(root));
      if (await boundedHash(activeStatePath(root)) !== journal.old.stateSha256) throw corruption("old state changed before archive creation");
      if (!(await boundedCopy(activeStatePath(root), archivePath, RESET_STREAM_BYTE_LIMIT, {
        beforeRenameSync: () => assertResetOwner(root, stateLock, archivePath),
      }))) throw corruption("old state disappeared before archive creation");
      if (await boundedHash(archivePath) !== journal.old.stateSha256) throw corruption("old state archive copy mismatch");
      await hooks.crashAt?.("after-archive-create");
    }
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared during recovery");
    await createResetRecoveryRefs(root, journal.old.z, inspection.observation.recoveryRefs.count, stateLock, hooks.crashAt);
    const readyBoundary = await inspectResetJournal(root, callerStream);
    if (readyBoundary.status !== "recoverable"
      || readyBoundary.observation.recoveryRefs.count !== readyBoundary.observation.recoveryRefs.total
      || !readyBoundary.row.ids.some((id) => id === "P2" || id.startsWith("P3."))) {
      throw readyBoundary.status === "halt" ? new ResetRecoveryHaltError(readyBoundary) : corruption("physical state moved before ready publication");
    }
    journal = await setPhase(root, journal, "ready", hooks, stateLock);
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared after ready publication");
  }

  if (journal.phase === "ready") {
    const activeParent = path.dirname(activeStatePath(root));
    const candidateParent = path.dirname(candidatePath);
    if (inspection.row.ids[0] === "R0") {
      // The entry-time ownership check is arbitrarily old by now: preparing the
      // archive and the recovery refs is unbounded work. Re-assert the lease and
      // then read the barrier with nothing between it and the rename but the
      // rename, so a lease lost during that work refuses instead of publishing.
      await assertStateReadable(activeStatePath(root));
      assertResetOwner(root, stateLock, activeStatePath(root));
      const activeBytes = fsSync.readFileSync(activeStatePath(root));
      const candidateBytes = fsSync.readFileSync(candidatePath);
      if (sha256(activeBytes) !== journal.old.stateSha256 || sha256(candidateBytes) !== journal.next.stateSha256) {
        throw corruption("state changed at the replacement syscall boundary");
      }
      await fs.rename(candidatePath, activeStatePath(root));
    }
    assertResetOwner(root, stateLock, activeParent);
    await fsyncDirectory(activeParent);
    await recordLastWriterWitness(root, activeStatePath(root), nextBytes, Date.now, stateLock);
    await hooks.crashAt?.("after-destination-parent-fsync");
    assertResetOwner(root, stateLock, candidatePath);
    await fs.rm(candidatePath, { force: true });
    await fsyncDirectory(candidateParent);
    await hooks.crashAt?.("after-source-parent-fsync");
    await hooks.crashAt?.("after-state-replace");
    const installedBoundary = await inspectResetJournal(root, callerStream);
    if (installedBoundary.status !== "recoverable" || !installedBoundary.row.ids.includes("R1")) {
      throw installedBoundary.status === "halt" ? new ResetRecoveryHaltError(installedBoundary) : corruption("state moved before installed publication");
    }
    journal = await setPhase(root, journal, "installed", hooks, stateLock);
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared after install publication");
  }

  if (journal.phase === "installed") {
    if (inspection.observation.marker !== "next") {
      await durableWrite(root, resetIncarnationPath(root), canonicalLine({ stream: journal.next.stream, stateNonce: journal.next.stateNonce, stateRevision: journal.next.stateRevision }), stateLock);
      await hooks.crashAt?.("after-marker-write");
    }
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared during retirement");
    await retireResetActiveGroups(root, journal.old.z, inspection.observation.activeRefGroups.count, stateLock, hooks.crashAt);
    const retiredBoundary = await inspectResetJournal(root, callerStream);
    if (retiredBoundary.status !== "recoverable"
      || retiredBoundary.observation.activeRefGroups.count !== retiredBoundary.observation.activeRefGroups.total
      || !(retiredBoundary.row.ids.includes("I2") || retiredBoundary.row.ids.some((id) => id.startsWith("I3.")))) {
      throw retiredBoundary.status === "halt" ? new ResetRecoveryHaltError(retiredBoundary) : corruption("physical state moved before z-retired publication");
    }
    journal = await setPhase(root, journal, "z-retired", hooks, stateLock);
  }

  if (journal.phase === "z-retired") {
    const terminal = await inspectResetJournal(root, callerStream);
    if (terminal.status !== "recoverable" || !terminal.row.ids.includes("Z0")) throw terminal.status === "halt" ? new ResetRecoveryHaltError(terminal) : corruption("reset journal not terminal");
    assertResetOwner(root, stateLock, resetJournalPath(root));
    await fs.rm(resetJournalPath(root));
    await fsyncDirectory(path.dirname(resetJournalPath(root)));
    const existed = await fs.lstat(candidatePath).then(() => true, () => false);
    assertResetOwner(root, stateLock, candidatePath);
    await fs.rm(candidatePath, { force: true });
    if (existed) await fsyncDirectory(path.dirname(candidatePath));
    return "complete";
  }
  throw corruption("unreachable reset phase");
}

export async function recoverResetJournal(
  root: string,
  callerStream: string,
  hooks: ResetJournalHooks = {},
  heldMutex?: WorkspaceSyncMutex,
): Promise<"none" | "complete"> {
  let mutex = heldMutex;
  let releaseMutex = false;
  if (!mutex) {
    mutex = await acquireWorkspaceSyncMutex(root, "cli");
    releaseMutex = true;
  }
  try {
    return await settleStandingReset(root, mutex, callerStream, hooks);
  } finally {
    if (releaseMutex) await releaseWorkspaceSyncMutex(mutex);
  }
}

export async function beginResetJournal(
  root: string,
  nextStream: string,
  oldBytes: Uint8Array,
  oldState: SyncState,
  z: ResetZEntry[],
  authorization: ResetJournalAuthorization,
  heldStateLock: OwnedLock,
  hooks: ResetJournalHooks = {},
): Promise<ResetJournalV2> {
  assertResetOwner(root, heldStateLock, activeStatePath(root));
  if (!bounded(nextStream) || !oldState.stream || !HEX32.test(oldState.stateNonce ?? "") || !counter(oldState.stateRevision)) throw new Error("reset refused: old state lacks a fenced lineage");
  if (authorization.version !== 2 || authorization.authorizedNextStream !== nextStream || !counter(authorization.mintedAtRevision) || !["setup-rebind", "setup-create"].includes(authorization.consentKind)) throw new Error("reset refused: authorization witness does not bind the requested reset");
  if (oldBytes.byteLength > RESET_STREAM_BYTE_LIMIT) throw new Error("reset refused: old state exceeds the streaming byte limit");
  const now = (hooks.now?.() ?? new Date()).toISOString();
  const id = (hooks.randomBytes ?? crypto.randomBytes)(16).toString("hex");
  const nonce = (hooks.randomBytes ?? crypto.randomBytes)(16).toString("hex");
  if (!HEX32.test(id) || !HEX32.test(nonce)) throw new Error("reset refused: random source returned invalid bytes");
  const nextState: ResetNextState = {
    stream: nextStream, stateNonce: nonce, stateRevision: oldState.stateRevision! + 1,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] }, repoRecords: {},
    ...(oldState.telemetryBindingId === undefined ? {} : { telemetryBindingId: oldState.telemetryBindingId }),
  };
  const journal: ResetJournalV2 = {
    v: 2, id, phase: "prepared", createdAt: now, authorization,
    old: {
      stream: oldState.stream, stateNonce: oldState.stateNonce!, stateRevision: oldState.stateRevision!, stateSha256: sha256(oldBytes), archiveBaseline: "absent",
      z: [...z].sort(compareResetZEntries),
    },
    next: { stream: nextStream, stateNonce: nonce, stateRevision: nextState.stateRevision, stateSha256: sha256(canonicalLine(nextState)), state: nextState },
  };
  const [physical, existingRecoveryRefs] = await Promise.all([
    observeLegacyResetPhysical(journal, legacyArtifactPaths(root, journal)),
    exactResetRecoveryRefs(journal.old.z),
  ]);
  if (physical.activeHash !== journal.old.stateSha256 || physical.candidateHash !== undefined
    || (physical.archiveHash !== undefined && physical.archiveHash !== journal.old.stateSha256)
    || !["old", "absent"].includes(physical.marker)
    || physical.activeRefGroups.kind !== "prefix" || physical.activeRefGroups.count !== 0) {
    throw new Error("reset refused: physical state does not satisfy the normalized P0 initiation invariant");
  }
  journal.old.archiveBaseline = physical.archiveHash === journal.old.stateSha256 ? "exact" : "absent";
  // Recovery refs are deterministic and can survive an operator quarantine.
  // Normalize only exact-target refs before publishing the new journal; a wrong
  // target was rejected above and is never rewritten. The canonical archive is
  // durable provenance, so exact bytes are adopted as the P0A baseline instead.
  for (let index = 0; index < existingRecoveryRefs.length; index++) {
    const entry = existingRecoveryRefs[index]!;
    await hooks.crashAt?.(`before-recovery-ref-normalize-${index + 1}`);
    await deleteExactResetRecoveryRef(root, entry, heldStateLock);
  }
  const normalizedRefs = await observeResetRefs(journal.old.z);
  if (normalizedRefs.recovery.kind !== "prefix" || normalizedRefs.recovery.count !== 0
    || normalizedRefs.activeGroups.kind !== "prefix" || normalizedRefs.activeGroups.count !== 0) {
    throw new Error("reset refused: recovery refs did not normalize to the P0 initiation invariant");
  }
  await writeJournal(root, journal, heldStateLock);
  await hooks.crashAt?.("after-prepared");
  return journal;
}
