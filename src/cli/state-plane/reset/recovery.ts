import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../../../engine/lockfile.js";
import { withRepositoryRecoveryFence } from "../../../cli/sync-git/protocol-locks.js";
import {
  classifyResetPhysicalSignature,
  type MarkerDisposition,
  type PrefixDisposition,
  type ResetPhysicalRow,
} from "../../reset-journal-classifier.js";
import {
  decodeResetJournal,
  encodeResetJournal,
  resetJournalFileSource,
  type ResetJournalAuthorization,
  type ResetJournalDecodeError,
  type SQLiteResetJournalV2,
} from "../../reset-journal-codec.js";
import {
  boundedHash,
  boundedRead,
} from "../../reset-io.js";
import type { ResetZEntry } from "../../reset-z.js";
import { compareResetZEntries } from "../../reset-z.js";
import {
  createResetRecoveryRefs,
  deleteExactResetRecoveryRef,
  exactResetRecoveryRefs,
  observeResetRefs,
  retireResetActiveGroups,
} from "../../reset-z-runtime.js";
import {
  classifySqliteResetPredecode,
  ResetOrphanArtifactHalt,
} from "./classifier.js";
import {
  requireDbArtifactS0,
  sqliteResetPaths,
  stableDbHash,
} from "./artifacts.js";
import {
  prepareEmptyResetDbSeed,
  quiesceActiveDbForReset,
  readSqliteAuthorityId,
  recoverOrdinaryWalCrash,
} from "./lifecycle.js";
import {
  STATE_STORE_SCHEMA_VERSION,
  STATE_STORE_SQLITE_APPLICATION_ID,
  STATE_STORE_SQLITE_USER_VERSION,
} from "../schema/application.js";
import {
  assertDbArtifactResetExecutorCapability,
  type DbArtifactResetExecutorCapability,
} from "./owner.js";
import {
  PRODUCTION_RECOVERY_FS,
  type SqliteResetRecoveryFs,
} from "./trace-fs.js";
export {
  createSqliteResetRecoveryFs,
  type SqliteResetFsTraceEvent,
  type SqliteResetRecoveryFs,
} from "./trace-fs.js";

export interface SqliteResetHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
  /** Injectable durability seam used by the power-cut rig. Every operation
   * delegates to the real filesystem; recorders observe the production
   * writer's actual ordering rather than restating the protocol in a test. */
  recoveryFs?: SqliteResetRecoveryFs;
}

export type SqliteResetInspection =
  | { status: "none" }
  | { status: "steady" }
  | { status: "w1" }
  | { status: "halt"; row: "J0" | "W2" | "W3" | "unlisted"; reason: string; decodeError?: ResetJournalDecodeError }
  | {
    status: "recoverable";
    journal: SQLiteResetJournalV2;
    journalIdentityHash: string;
    inventoryIdentity: string;
    configDisposition: "old" | "next";
    row: ResetPhysicalRow;
    paths: { active: string; candidate: string; archive: string; marker: string; journal: string };
  };

export interface ObservedSqliteResetJournal {
  row?: ResetPhysicalRow;
  paths: { active: string; candidate: string; archive: string; marker: string; journal: string };
}

const hash = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const inventoryIdentity = (inventory: Awaited<ReturnType<typeof classifySqliteResetPredecode>>["inventory"]): string =>
  hash(Buffer.from(JSON.stringify({
    active: inventory.active,
    candidates: inventory.candidates,
    archives: inventory.archives,
    legacyCandidates: inventory.legacyCandidates,
    legacyArchives: inventory.legacyArchives,
    inertTemps: inventory.inertTemps,
  })));

async function markerDisposition(file: string, journal: SQLiteResetJournalV2): Promise<MarkerDisposition> {
  const bytes = await boundedRead(file, 512 * 1024);
  if (!bytes) return "absent";
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "other";
    if (!value || Object.keys(value).sort().join("\0") !== ["stateNonce", "stateRevision", "stream"].join("\0")) return "other";
    const stream: unknown = Reflect.get(value, "stream");
    const stateNonce: unknown = Reflect.get(value, "stateNonce");
    const stateRevision: unknown = Reflect.get(value, "stateRevision");
    if (typeof stream !== "string" || typeof stateNonce !== "string" || typeof stateRevision !== "number") return "other";
    const tuple = `${stream}\0${stateNonce}\0${stateRevision}`;
    if (tuple === `${journal.old.stream}\0${journal.old.stateNonce}\0${journal.old.stateRevision}`) return "old";
    if (tuple === `${journal.next.stream}\0${journal.next.stateNonce}\0${journal.next.stateRevision}`) return "next";
    return "other";
  } catch {
    return "other";
  }
}

export async function observeSqliteResetControlPlane(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  journal: SQLiteResetJournalV2,
): Promise<{
  marker: MarkerDisposition;
  recoveryRefs: PrefixDisposition;
  activeRefGroups: PrefixDisposition;
}> {
  assertDbArtifactResetExecutorCapability(capability);
  const [marker, refs] = await Promise.all([
    markerDisposition(sqliteResetPaths.marker(root), journal),
    observeResetRefs(journal.old.z),
  ]);
  return { marker, recoveryRefs: refs.recovery, activeRefGroups: refs.activeGroups };
}

async function optionalStableHash(file: string): Promise<string | undefined> {
  const observed = await fs.lstat(file).catch(() => undefined);
  if (!observed) return undefined;
  return (await stableDbHash(file)).sha256;
}

export async function inspectSqliteReset(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  callerStream?: string,
): Promise<SqliteResetInspection> {
  assertDbArtifactResetExecutorCapability(capability);
  const predecode = await classifySqliteResetPredecode(root);
  if (predecode.kind === "W2") return { status: "halt", row: "W2", reason: "standing journal has a DB sidecar" };
  if (predecode.kind === "W3") return { status: "halt", row: "W3", reason: "orphan candidate/archive sidecar" };
  if (predecode.kind === "W1") return { status: "w1" };
  if (predecode.kind === "steady") return { status: "steady" };
  if (predecode.kind === "halt") return { status: "halt", row: "unlisted", reason: predecode.code };

  const decoded = await decodeResetJournal(await resetJournalFileSource(sqliteResetPaths.journal(root)));
  if (!decoded.ok) {
    return { status: "halt", row: "J0", reason: decoded.error.code, decodeError: decoded.error };
  }
  if (!("stateFormat" in decoded.journal)) {
    return { status: "halt", row: "unlisted", reason: "standing journal is not sqlite/v1" };
  }
  const journal = decoded.journal;
  const authorityId = await readSqliteAuthorityId(root);
  if (journal.authorityId !== authorityId) return { status: "halt", row: "unlisted", reason: "authority id mismatch" };
  if (callerStream !== journal.old.stream && callerStream !== journal.next.stream) {
    return { status: "halt", row: "unlisted", reason: "durable config names neither authorized reset stream" };
  }
  const physical = await observeSqliteResetJournal(capability, root, journal);
  if (!physical.row) return { status: "halt", row: "unlisted", reason: "physical DB artifacts match no authorized recovery row" };
  return {
    status: "recoverable",
    journal,
    journalIdentityHash: decoded.rawSha256,
    inventoryIdentity: inventoryIdentity(predecode.inventory),
    configDisposition: callerStream === journal.old.stream ? "old" : "next",
    row: physical.row,
    paths: physical.paths,
  };
}

/** Physical observation for an already-authenticated bundled SQLite journal. */
export async function observeSqliteResetJournal(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  journal: SQLiteResetJournalV2,
): Promise<ObservedSqliteResetJournal> {
  assertDbArtifactResetExecutorCapability(capability);
  if (journal.authorityId !== await readSqliteAuthorityId(root)) throw new Error("SQLite reset authority id mismatch");
  const paths = {
    active: sqliteResetPaths.active(root),
    candidate: sqliteResetPaths.candidate(root, journal.id),
    archive: sqliteResetPaths.archive(root, journal.old.stateNonce, journal.old.stateSha256),
    marker: sqliteResetPaths.marker(root),
    journal: sqliteResetPaths.journal(root),
  };
  const [activeHash, candidateHash, archiveHash, controls] = await Promise.all([
    optionalStableHash(paths.active),
    optionalStableHash(paths.candidate),
    optionalStableHash(paths.archive),
    observeSqliteResetControlPlane(capability, root, journal),
  ]);
  const row = classifyResetPhysicalSignature({
    phase: journal.phase,
    archiveBaseline: journal.old.archiveBaseline,
    active: activeHash === undefined ? "absent" : activeHash === journal.old.stateSha256 ? "old" : activeHash === journal.next.stateSha256 ? "next" : "other",
    candidate: candidateHash === undefined ? "absent" : candidateHash === journal.next.stateSha256 ? "next" : "other",
    archive: archiveHash === undefined ? "absent" : archiveHash === journal.old.stateSha256 ? "old" : "other",
    marker: controls.marker,
    recoveryRefs: controls.recoveryRefs,
    activeRefGroups: controls.activeRefGroups,
  });
  return { row, paths };
}

async function durableExactWrite(
  file: string,
  bytes: Uint8Array,
  recoveryFs: SqliteResetRecoveryFs,
): Promise<void> {
  const existing = await boundedHash(file);
  if (existing === hash(bytes)) return;
  if (existing !== undefined) throw new Error(`SQLite reset exact target differs: ${file}`);
  const parent = path.dirname(file);
  const created = await recoveryFs.ensureDirectoryChain(parent, "SQLite reset artifact directory");
  await recoveryFs.exactWrite(file, bytes);
  await recoveryFs.fsyncDirectory(parent);
  await recoveryFs.fsyncCreatedDirectoryAncestors(parent, created);
  await requireDbArtifactS0(file);
}

async function writeJournal(
  root: string,
  journal: SQLiteResetJournalV2,
  recoveryFs: SqliteResetRecoveryFs,
): Promise<void> {
  const file = sqliteResetPaths.journal(root);
  const parent = path.dirname(file);
  const created = await recoveryFs.ensureDirectoryChain(parent, "SQLite reset journal directory");
  const bytes = await encodeResetJournal(journal);
  await recoveryFs.atomicWrite(file, bytes);
  await recoveryFs.fsyncDirectory(parent);
  await recoveryFs.fsyncCreatedDirectoryAncestors(parent, created);
}

async function setPhase(root: string, journal: SQLiteResetJournalV2, phase: SQLiteResetJournalV2["phase"], hooks: SqliteResetHooks): Promise<SQLiteResetJournalV2> {
  const next = { ...journal, phase };
  await writeJournal(root, next, hooks.recoveryFs ?? PRODUCTION_RECOVERY_FS);
  await hooks.crashAt?.(`after-${phase}`);
  return next;
}

async function recoverHeld(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  stream: string,
  hooks: SqliteResetHooks,
): Promise<"complete"> {
  const recoveryFs = hooks.recoveryFs ?? PRODUCTION_RECOVERY_FS;
  let inspected = await inspectSqliteReset(capability, root, stream);
  if (inspected.status !== "recoverable") {
    throw new Error(`SQLite reset is not recoverable: ${inspected.status}`);
  }
  let journal = inspected.journal;
  if (journal.phase === "prepared") {
    const id = inspected.row.ids[0]!;
    if (id === "P0" || id === "P0A") {
      await durableExactWrite(inspected.paths.candidate, journal.next.dbBytes, recoveryFs);
      await hooks.crashAt?.("after-candidate-create");
    }
    if (id === "P0" || id === "P1") {
      if (!await recoveryFs.copyExact(inspected.paths.active, inspected.paths.archive)) throw new Error("SQLite reset active disappeared");
      await requireDbArtifactS0(inspected.paths.archive);
      await hooks.crashAt?.("after-archive-create");
    }
    inspected = await inspectSqliteReset(capability, root, stream) as Extract<SqliteResetInspection, { status: "recoverable" }>;
    if (inspected.status !== "recoverable") throw new Error("SQLite reset moved before refs");
    await createResetRecoveryRefs(journal.old.z, inspected.row.observation.recoveryRefs.count, hooks.crashAt);
    journal = await setPhase(root, journal, "ready", hooks);
    inspected = await inspectSqliteReset(capability, root, stream) as Extract<SqliteResetInspection, { status: "recoverable" }>;
  }
  if (journal.phase === "ready") {
    if (inspected.status !== "recoverable") throw new Error("SQLite reset ready state changed");
    if (inspected.row.ids.includes("R0")) {
      await recoveryFs.rename(inspected.paths.candidate, inspected.paths.active);
      await hooks.crashAt?.("after-candidate-rename");
    }
    await recoveryFs.fsyncDbAndParent(inspected.paths.active);
    await hooks.crashAt?.("after-destination-parent-fsync");
    await recoveryFs.remove(inspected.paths.candidate, { force: true });
    await hooks.crashAt?.("after-source-unlink");
    await recoveryFs.fsyncDirectory(path.dirname(inspected.paths.candidate));
    await hooks.crashAt?.("after-source-parent-fsync");
    journal = await setPhase(root, journal, "installed", hooks);
    inspected = await inspectSqliteReset(capability, root, stream) as Extract<SqliteResetInspection, { status: "recoverable" }>;
  }
  if (journal.phase === "installed") {
    if (inspected.status !== "recoverable") throw new Error("SQLite reset installed state changed");
    await stableDbHash(inspected.paths.active);
    await hooks.crashAt?.("after-state-check");
    if (inspected.row.observation.marker !== "next") {
      await recoveryFs.atomicWrite(inspected.paths.marker, Buffer.from(`${JSON.stringify({
        stream: journal.next.stream,
        stateNonce: journal.next.stateNonce,
        stateRevision: journal.next.stateRevision,
      })}\n`));
      await recoveryFs.fsyncDirectory(path.dirname(inspected.paths.marker));
      await hooks.crashAt?.("after-marker-write");
    }
    inspected = await inspectSqliteReset(capability, root, stream) as Extract<SqliteResetInspection, { status: "recoverable" }>;
    if (inspected.status !== "recoverable") throw new Error("SQLite reset moved during retirement");
    await retireResetActiveGroups(journal.old.z, inspected.row.observation.activeRefGroups.count, hooks.crashAt);
    journal = await setPhase(root, journal, "z-retired", hooks);
  }
  const terminal = await inspectSqliteReset(capability, root, stream);
  if (terminal.status !== "recoverable" || !terminal.row.ids.includes("Z0")) throw new Error("SQLite reset terminal row missing");
  await recoveryFs.remove(sqliteResetPaths.journal(root));
  await recoveryFs.fsyncDirectory(path.dirname(sqliteResetPaths.journal(root)));
  await hooks.crashAt?.("after-journal-unlink");
  await recoveryFs.remove(sqliteResetPaths.candidate(root, journal.id), { force: true });
  return "complete";
}

export async function recoverSqliteReset(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  callerStream: string,
  hooks: SqliteResetHooks = {},
): Promise<"none" | "complete"> {
  assertDbArtifactResetExecutorCapability(capability);
  const preflight = await inspectSqliteReset(capability, root, callerStream);
  if (preflight.status === "steady" || preflight.status === "none") return "none";
  if (preflight.status === "halt" && preflight.row === "W3") {
    const classified = await classifySqliteResetPredecode(root);
    if (classified.kind === "W3") throw new ResetOrphanArtifactHalt(classified.inventory);
    throw new Error("SQLite reset orphan-artifact state changed during halt classification");
  }
  if (preflight.status === "w1") {
    const lock = await acquireLock(`${sqliteResetPaths.active(root)}.lock`);
    if (lock.status !== "acquired") throw new Error("SQLite W1 state lock unavailable");
    try {
      await recoverOrdinaryWalCrash(root, undefined, hooks);
      const terminal = await inspectSqliteReset(capability, root, callerStream);
      if (terminal.status !== "steady") throw new Error("SQLite W1 takeover did not reach S0 steady state");
      return "complete";
    } finally {
      await lock.lock.release();
    }
  }
  if (preflight.status !== "recoverable") throw new Error(`SQLite reset halted: ${preflight.reason}`);
  const requests = preflight.journal.old.z.map((entry) => ({
    commonDir: entry.repositoryIdentity.commonDirReal,
    reflogRefs: [entry.activeRef, entry.recoveryRef],
  }));
  return withRepositoryRecoveryFence(requests, path.resolve(sqliteResetPaths.active(root)), async () => {
    const lock = await acquireLock(`${sqliteResetPaths.active(root)}.lock`);
    if (lock.status !== "acquired") throw new Error("SQLite reset state lock unavailable");
    try {
      const held = await inspectSqliteReset(capability, root, callerStream);
      if (held.status !== "recoverable"
        || held.journalIdentityHash !== preflight.journalIdentityHash
        || held.inventoryIdentity !== preflight.inventoryIdentity) {
        throw new Error("SQLite reset changed between preflight and held-fence pass");
      }
      return await recoverHeld(capability, root, callerStream, hooks);
    } finally {
      await lock.lock.release();
    }
  });
}

export async function beginSqliteReset(
  capability: DbArtifactResetExecutorCapability,
  root: string,
  nextStream: string,
  z: ResetZEntry[],
  authorization: ResetJournalAuthorization,
  hooks: SqliteResetHooks = {},
): Promise<SQLiteResetJournalV2> {
  assertDbArtifactResetExecutorCapability(capability);
  if (authorization.version !== 2
    || authorization.authorizedNextStream !== nextStream
    || !Number.isSafeInteger(authorization.mintedAtRevision)
    || authorization.mintedAtRevision < 0
    || (authorization.consentKind !== "setup-rebind" && authorization.consentKind !== "setup-create")) {
    throw new Error("SQLite reset authorization does not bind the requested stream");
  }
  if (Buffer.byteLength(nextStream, "utf8") > 4_096 || nextStream.includes("\0")) {
    throw new Error("SQLite reset next stream is invalid");
  }
  const now = (hooks.now?.() ?? new Date()).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
    || new Date(Date.parse(now)).toISOString() !== now) {
    throw new Error("SQLite reset clock returned a non-canonical timestamp");
  }
  const random = hooks.randomBytes ?? crypto.randomBytes;
  const id = random(16).toString("hex");
  const nonce = random(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new Error("SQLite reset random source returned invalid bytes");
  }
  const old = await quiesceActiveDbForReset(root);
  const authorityId = await readSqliteAuthorityId(root);
  const seed = await prepareEmptyResetDbSeed(root, {
    stream: nextStream,
    stateNonce: nonce,
    stateRevision: old.stateRevision + 1,
    ...(old.telemetryBindingId === undefined ? {} : { telemetryBindingId: old.telemetryBindingId }),
  }, authorityId);
  const activeHash = (await stableDbHash(sqliteResetPaths.active(root))).sha256;
  const archive = sqliteResetPaths.archive(root, old.stateNonce, activeHash);
  const archiveHash = await optionalStableHash(archive);
  if (archiveHash !== undefined && archiveHash !== activeHash) throw new Error("SQLite reset archive baseline differs");
  const journal: SQLiteResetJournalV2 = {
    v: 2,
    stateFormat: "sqlite/v1",
    id,
    phase: "prepared",
    createdAt: now,
    authorization,
    authorityId,
    sqliteApplicationId: STATE_STORE_SQLITE_APPLICATION_ID,
    sqliteUserVersion: STATE_STORE_SQLITE_USER_VERSION,
    storeSchemaVersion: STATE_STORE_SCHEMA_VERSION,
    old: {
      stream: old.stream,
      stateNonce: old.stateNonce,
      stateRevision: old.stateRevision,
      stateSha256: activeHash,
      archiveBaseline: archiveHash === activeHash ? "exact" : "absent",
      z: [...z].sort(compareResetZEntries),
    },
    next: {
      stream: nextStream,
      stateNonce: nonce,
      stateRevision: old.stateRevision + 1,
      stateSha256: seed.sha256,
      dbBytesB64: seed.bytes.toString("base64"),
      dbBytes: seed.bytes,
    },
  };
  // Authenticate every caller- and generated field before any durable
  // recovery-ref normalization. writeJournal repeats this at publication.
  await encodeResetJournal(journal);
  if (await optionalStableHash(sqliteResetPaths.candidate(root, id)) !== undefined) {
    throw new Error("SQLite reset candidate id already exists");
  }
  const beforeRefs = await observeResetRefs(journal.old.z);
  if (beforeRefs.activeGroups.kind !== "prefix" || beforeRefs.activeGroups.count !== 0
    || beforeRefs.recovery.kind !== "prefix") {
    throw new Error("SQLite reset Z plane does not satisfy P0 admission");
  }
  const exactRecovery = await exactResetRecoveryRefs(journal.old.z);
  for (let index = 0; index < exactRecovery.length; index++) {
    await hooks.crashAt?.(`before-recovery-ref-normalize-${index + 1}`);
    await deleteExactResetRecoveryRef(exactRecovery[index]!);
  }
  const normalizedRefs = await observeResetRefs(journal.old.z);
  if (normalizedRefs.recovery.kind !== "prefix" || normalizedRefs.recovery.count !== 0
    || normalizedRefs.activeGroups.kind !== "prefix" || normalizedRefs.activeGroups.count !== 0) {
    throw new Error("SQLite reset Z plane did not normalize to P0");
  }
  const marker = await markerDisposition(sqliteResetPaths.marker(root), journal);
  if (marker !== "old" && marker !== "absent") throw new Error("SQLite reset incarnation marker is not a P0 precondition");
  await writeJournal(root, journal, hooks.recoveryFs ?? PRODUCTION_RECOVERY_FS);
  await hooks.crashAt?.("after-prepared");
  return journal;
}
