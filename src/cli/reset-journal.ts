import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../engine/e2ee/jcs.js";
import type { JsonObject } from "../json.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { acquireLock, type OwnedLock } from "../engine/git/lockfile.js";
import { withRepositoryRecoveryFence } from "../engine/git/protocol-locks.js";
import {
  assertStateReadable,
  recordLastWriterWitness,
  StateFormatTooNewError,
  StateWriteRefusedError,
} from "./state-plane/index.js";
import type { SyncState } from "./sync-state-model.js";
import {
  classifyResetPhysicalSignature,
  type MarkerDisposition,
  type NextArtifactDisposition,
  type OldArtifactDisposition,
  type StateDisposition,
} from "./reset-journal-classifier.js";
import {
  RESET_STREAM_BYTE_LIMIT,
  ResetCorruptionError,
  boundedCopy,
  boundedEqualsBytes,
  boundedHash,
  boundedRead,
} from "./reset-io.js";
import {
  decodeResetJournalBytes,
  encodeResetJournal,
  resetJournalFileSource,
  decodeResetJournal,
  type SQLiteResetJournalV2,
} from "./reset-journal-codec.js";
import {
  ResetRecoveryHaltError,
  type ResetArtifactObservation,
  type ResetJournalHooks,
  type ResetJournalInspection,
} from "./reset-journal-inspection.js";
export {
  ResetRecoveryHaltError,
  type ResetArtifactObservation,
  type ResetJournalHooks,
  type ResetJournalInspection,
} from "./reset-journal-inspection.js";
import { compareResetZEntries, type ResetZEntry } from "./reset-z.js";
import { classifyStateFormat } from "./state-plane/authority-marker.js";
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

const record = (value: unknown): JsonObject | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const exact = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value) <= MAX_TEXT && !value.includes("\0");
const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalLine = (value: unknown): Buffer => Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);
const corruption = (message: string): ResetCorruptionError => new ResetCorruptionError(message);

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

async function durableWrite(file: string, bytes: Uint8Array): Promise<void> {
  const parent = path.dirname(file);
  const created = await ensureDirectoryChain(parent, "reset journal directory");
  const existing = await fs.lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw corruption(`unsafe path ${file}`);
  await writeFileAtomic(file, bytes, { mode: 0o600 });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

async function expectedAbsentOrExact(file: string, bytes: Uint8Array): Promise<void> {
  const equal = await boundedEqualsBytes(file, bytes, RESET_STREAM_BYTE_LIMIT);
  if (equal === true) return;
  if (equal === false) throw corruption(`wrong existing bytes at ${file}`);
  await durableWrite(file, bytes);
}

function stateDisposition(hash: string | undefined, journal: ResetJournalV2): StateDisposition {
  if (hash === undefined) return "absent";
  if (hash === journal.old.stateSha256) return "old";
  if (hash === journal.next.stateSha256) return "next";
  return "other";
}
function nextDisposition(hash: string | undefined, journal: ResetJournalV2): NextArtifactDisposition {
  return hash === undefined ? "absent" : hash === journal.next.stateSha256 ? "next" : "other";
}
function oldDisposition(hash: string | undefined, journal: ResetJournalV2): OldArtifactDisposition {
  return hash === undefined ? "absent" : hash === journal.old.stateSha256 ? "old" : "other";
}

async function markerDisposition(file: string, journal: ResetJournalV2): Promise<MarkerDisposition> {
  const bytes = await boundedRead(file, MAX_JOURNAL_BYTES);
  if (!bytes) return "absent";
  try {
    const value = record(JSON.parse(bytes.toString("utf8")));
    if (!value || !exact(value, ["stream", "stateNonce", "stateRevision"])) return "other";
    const tuple = `${String(value.stream)}\0${String(value.stateNonce)}\0${String(value.stateRevision)}`;
    if (tuple === `${journal.old.stream}\0${journal.old.stateNonce}\0${journal.old.stateRevision}`) return "old";
    if (tuple === `${journal.next.stream}\0${journal.next.stateNonce}\0${journal.next.stateRevision}`) return "next";
    return "other";
  } catch { return "other"; }
}

async function observePhysical(root: string, journal: ResetJournalV2): Promise<ResetArtifactObservation> {
  const paths = {
    active: activeStatePath(root), candidate: resetCandidatePath(root, journal.id),
    archive: resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256),
    marker: resetIncarnationPath(root), journal: resetJournalPath(root),
  };
  // Hashing the live state is a read of the state plane: a newer format must be
  // recognized here, not consumed as an ordinary signature mismatch.
  await assertStateReadable(paths.active);
  const [activeHash, candidateHash, archiveHash, marker, refs] = await Promise.all([
    boundedHash(paths.active), boundedHash(paths.candidate), boundedHash(paths.archive), markerDisposition(paths.marker, journal), observeResetRefs(journal.old.z),
  ]);
  return {
    phase: journal.phase,
    archiveBaseline: journal.old.archiveBaseline,
    active: stateDisposition(activeHash, journal), candidate: nextDisposition(candidateHash, journal), archive: oldDisposition(archiveHash, journal), marker,
    recoveryRefs: refs.recovery, activeRefGroups: refs.activeGroups,
    activeHash, candidateHash, archiveHash, artifactPaths: paths,
  };
}

/** Validate a quarantined journal envelope and observe its referenced physical
 * marker/ref plane without publishing that journal at the live path. */
export async function observeResetJournalBytes(
  root: string,
  bytes: Buffer,
): Promise<{ journal: ResetJournalV2; observation: ResetArtifactObservation }> {
  const parsed = await parseJournal(bytes);
  if (parsed.v !== 2) throw corruption("legacy reset journal has no restorable physical preconditions");
  return { journal: parsed, observation: await observePhysical(root, parsed) };
}

export async function inspectResetJournal(root: string, callerStream?: string): Promise<ResetJournalInspection> {
  if (await classifyStateFormat(activeStatePath(root)) === "authority-marker") {
    const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
    const sqlite = await sqliteResetFacade.inspect(root, callerStream);
    if (sqlite.status === "steady" || sqlite.status === "none") return { status: "none" };
    if (sqlite.status === "w1") {
      return { status: "halt", reason: "SQLite authority has an ordinary WAL crash requiring writer takeover" };
    }
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
  try { observation = await observePhysical(root, journal); }
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

async function writeJournal(root: string, journal: ResetJournalV2): Promise<void> {
  validateResetJournalV2(journal);
  await durableWrite(resetJournalPath(root), await encodeResetJournal(journal as import("./reset-journal-codec.js").ResetJournalV2));
}

async function setPhase(root: string, journal: ResetJournalV2, nextPhase: ResetPhase, hooks: ResetJournalHooks): Promise<ResetJournalV2> {
  const next = { ...journal, phase: nextPhase };
  await writeJournal(root, next);
  await hooks.crashAt?.(`after-${nextPhase}`);
  return next;
}

export async function recoverResetJournalUnderHeldFence(
  root: string,
  callerStream: string,
  hooks: ResetJournalHooks,
  stateLock: OwnedLock,
): Promise<"none" | "complete"> {
  if (!(await stateLock.isOwner())) throw corruption("sync state lock ownership was lost");
  await assertStateReadable(activeStatePath(root));
  let inspection = await inspectResetJournal(root, callerStream);
  if (inspection.status === "none") return "none";
  if (inspection.status === "halt") throw new ResetRecoveryHaltError(inspection);
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
      await expectedAbsentOrExact(candidatePath, nextBytes);
      await hooks.crashAt?.("after-candidate-create");
    }
    if (rowId === "P0" || rowId === "P1") {
      await assertStateReadable(activeStatePath(root));
      if (await boundedHash(activeStatePath(root)) !== journal.old.stateSha256) throw corruption("old state changed before archive creation");
      if (!(await boundedCopy(activeStatePath(root), archivePath))) throw corruption("old state disappeared before archive creation");
      if (await boundedHash(archivePath) !== journal.old.stateSha256) throw corruption("old state archive copy mismatch");
      await hooks.crashAt?.("after-archive-create");
    }
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared during recovery");
    await createResetRecoveryRefs(journal.old.z, inspection.observation.recoveryRefs.count, hooks.crashAt);
    const readyBoundary = await inspectResetJournal(root, callerStream);
    if (readyBoundary.status !== "recoverable"
      || readyBoundary.observation.recoveryRefs.count !== readyBoundary.observation.recoveryRefs.total
      || !readyBoundary.row.ids.some((id) => id === "P2" || id.startsWith("P3."))) {
      throw readyBoundary.status === "halt" ? new ResetRecoveryHaltError(readyBoundary) : corruption("physical state moved before ready publication");
    }
    journal = await setPhase(root, journal, "ready", hooks);
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
      if (!(await stateLock.isOwner())) throw new StateWriteRefusedError("state-lock-lease-lost", activeStatePath(root));
      await assertStateReadable(activeStatePath(root));
      await fs.rename(candidatePath, activeStatePath(root));
    }
    await fsyncDirectory(activeParent);
    await recordLastWriterWitness(root, activeStatePath(root), nextBytes);
    await hooks.crashAt?.("after-destination-parent-fsync");
    await fs.rm(candidatePath, { force: true });
    await fsyncDirectory(candidateParent);
    await hooks.crashAt?.("after-source-parent-fsync");
    await hooks.crashAt?.("after-state-replace");
    const installedBoundary = await inspectResetJournal(root, callerStream);
    if (installedBoundary.status !== "recoverable" || !installedBoundary.row.ids.includes("R1")) {
      throw installedBoundary.status === "halt" ? new ResetRecoveryHaltError(installedBoundary) : corruption("state moved before installed publication");
    }
    journal = await setPhase(root, journal, "installed", hooks);
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared after install publication");
  }

  if (journal.phase === "installed") {
    if (inspection.observation.marker !== "next") {
      await durableWrite(resetIncarnationPath(root), canonicalLine({ stream: journal.next.stream, stateNonce: journal.next.stateNonce, stateRevision: journal.next.stateRevision }));
      await hooks.crashAt?.("after-marker-write");
    }
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared during retirement");
    await retireResetActiveGroups(journal.old.z, inspection.observation.activeRefGroups.count, hooks.crashAt);
    const retiredBoundary = await inspectResetJournal(root, callerStream);
    if (retiredBoundary.status !== "recoverable"
      || retiredBoundary.observation.activeRefGroups.count !== retiredBoundary.observation.activeRefGroups.total
      || !(retiredBoundary.row.ids.includes("I2") || retiredBoundary.row.ids.some((id) => id.startsWith("I3.")))) {
      throw retiredBoundary.status === "halt" ? new ResetRecoveryHaltError(retiredBoundary) : corruption("physical state moved before z-retired publication");
    }
    journal = await setPhase(root, journal, "z-retired", hooks);
  }

  if (journal.phase === "z-retired") {
    const terminal = await inspectResetJournal(root, callerStream);
    if (terminal.status !== "recoverable" || !terminal.row.ids.includes("Z0")) throw terminal.status === "halt" ? new ResetRecoveryHaltError(terminal) : corruption("reset journal not terminal");
    await fs.rm(resetJournalPath(root));
    await fsyncDirectory(path.dirname(resetJournalPath(root)));
    const existed = await fs.lstat(candidatePath).then(() => true, () => false);
    await fs.rm(candidatePath, { force: true });
    if (existed) await fsyncDirectory(path.dirname(candidatePath));
    return "complete";
  }
  throw corruption("unreachable reset phase");
}

export async function recoverResetJournal(root: string, callerStream: string, hooks: ResetJournalHooks = {}): Promise<"none" | "complete"> {
  const preFormat = await classifyStateFormat(activeStatePath(root));
  if (preFormat === "authority-marker") {
    // Keep bun:sqlite outside the executable's static graph until U3 flips
    // authority. The dynamically loaded module exposes only the bound facade.
    const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
    return sqliteResetFacade.recover(root, callerStream, hooks);
  }
  const initial = await readResetJournal(root);
  if (!initial) return "none";
  const preflight = await inspectResetJournal(root, callerStream);
  if (preflight.status === "halt") throw new ResetRecoveryHaltError(preflight);
  if (preflight.status === "none") return "none";
  const requests = preflight.journal.old.z.map((entry) => ({
    commonDir: entry.repositoryIdentity.commonDirReal,
    reflogRefs: [entry.activeRef, entry.recoveryRef],
  }));
  return withRepositoryRecoveryFence(requests, path.resolve(activeStatePath(root)), async () => {
    const acquired = await acquireLock(`${activeStatePath(root)}.lock`);
    if (acquired.status !== "acquired") throw new Error("reset refused: sync state lock unavailable during recovery");
    try {
      if (await classifyStateFormat(activeStatePath(root)) !== preFormat) {
        throw new Error("reset state format changed while acquiring the recovery fence");
      }
      return await recoverResetJournalUnderHeldFence(root, callerStream, hooks, acquired.lock);
    }
    finally { await acquired.lock.release(); }
  });
}

export async function beginResetJournal(
  root: string,
  nextStream: string,
  oldBytes: Uint8Array,
  oldState: SyncState,
  z: ResetZEntry[],
  authorization: ResetJournalAuthorization,
  hooks: ResetJournalHooks = {},
): Promise<ResetJournalV2> {
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
  const [activeHash, candidateHash, archiveHash, marker, refs, existingRecoveryRefs] = await Promise.all([
    boundedHash(activeStatePath(root)), boundedHash(resetCandidatePath(root, id)), boundedHash(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256)),
    markerDisposition(resetIncarnationPath(root), journal), observeResetRefs(journal.old.z), exactResetRecoveryRefs(journal.old.z),
  ]);
  if (activeHash !== journal.old.stateSha256 || candidateHash !== undefined
    || (archiveHash !== undefined && archiveHash !== journal.old.stateSha256) || !["old", "absent"].includes(marker)
    || refs.activeGroups.kind !== "prefix" || refs.activeGroups.count !== 0) {
    throw new Error("reset refused: physical state does not satisfy the normalized P0 initiation invariant");
  }
  journal.old.archiveBaseline = archiveHash === journal.old.stateSha256 ? "exact" : "absent";
  // Recovery refs are deterministic and can survive an operator quarantine.
  // Normalize only exact-target refs before publishing the new journal; a wrong
  // target was rejected above and is never rewritten. The canonical archive is
  // durable provenance, so exact bytes are adopted as the P0A baseline instead.
  for (let index = 0; index < existingRecoveryRefs.length; index++) {
    const entry = existingRecoveryRefs[index]!;
    await hooks.crashAt?.(`before-recovery-ref-normalize-${index + 1}`);
    await deleteExactResetRecoveryRef(entry);
  }
  const normalizedRefs = await observeResetRefs(journal.old.z);
  if (normalizedRefs.recovery.kind !== "prefix" || normalizedRefs.recovery.count !== 0
    || normalizedRefs.activeGroups.kind !== "prefix" || normalizedRefs.activeGroups.count !== 0) {
    throw new Error("reset refused: recovery refs did not normalize to the P0 initiation invariant");
  }
  await writeJournal(root, journal);
  await hooks.crashAt?.("after-prepared");
  return journal;
}
