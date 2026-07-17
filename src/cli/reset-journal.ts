import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../engine/e2ee/jcs.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { acquireLock, type OwnedLock } from "../engine/git/lockfile.js";
import { withRepositoryRecoveryFence } from "../engine/git/protocol-locks.js";
import { readRepoIdentityV1, repositoryIdentityHash, validateRepoIdentityV1, type RepoIdentityV1 } from "../engine/git/repo-lineage.js";
import { gitRaw } from "../engine/git/shared.js";
import type { SyncState } from "./config.js";
import {
  classifyResetPhysicalSignature,
  type MarkerDisposition,
  type NextArtifactDisposition,
  type OldArtifactDisposition,
  type PrefixDisposition,
  type ResetPhysicalObservation,
  type ResetPhysicalRow,
  type StateDisposition,
} from "./reset-journal-classifier.js";
import {
  RESET_STREAM_BYTE_LIMIT,
  ResetCorruptionError,
  boundedCopy,
  boundedEqualsBytes,
  boundedHash,
  boundedRead,
  assertResetParseAdmission,
  parseResetJsonBytes,
} from "./reset-io.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_Z = 256;
const MAX_TEXT = 4096;

export type ResetPhase = "prepared" | "ready" | "installed" | "z-retired";
export type ResetConsentKind = "setup-rebind" | "setup-create";

export interface ResetJournalAuthorization {
  version: 2;
  authorizedNextStream: string;
  consentKind: ResetConsentKind;
  mintedAtRevision: number;
}

export interface ResetZEntry {
  lineageHash: string;
  repositoryIdentityHash: string;
  repositoryIdentity: RepoIdentityV1;
  activeRef: string;
  targetOid: string;
  recoveryRef: string;
}

export interface ResetNextState {
  stream: string;
  stateNonce: string;
  stateRevision: number;
  lastSyncedSequence: 0;
  lastSyncedManifest: { generatedAt: ""; files: [] };
  repoRecords: Record<string, never>;
  telemetryBindingId?: string;
}

interface ResetJournalBody {
  id: string;
  phase: ResetPhase;
  createdAt: string;
  old: { stream: string; stateNonce: string; stateRevision: number; stateSha256: string; z: ResetZEntry[] };
  next: { stream: string; stateNonce: string; stateRevision: number; stateSha256: string; state: ResetNextState };
}

export interface ResetJournalV1 extends ResetJournalBody { v: 1 }
export interface ResetJournalV2 extends ResetJournalBody { v: 2; authorization: ResetJournalAuthorization }
export type ResetJournal = ResetJournalV1 | ResetJournalV2;

export interface ResetJournalHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
}

export interface ResetArtifactObservation extends ResetPhysicalObservation {
  activeHash?: string;
  candidateHash?: string;
  archiveHash?: string;
  artifactPaths: { active: string; candidate: string; archive: string; marker: string; journal: string };
}

export type ResetJournalInspection =
  | { status: "none" }
  | { status: "halt"; reason: string; journalIdentityHash?: string; journal?: ResetJournal; observation?: ResetArtifactObservation }
  | {
    status: "recoverable";
    journalIdentityHash: string;
    journal: ResetJournalV2;
    configDisposition: "old" | "next";
    row: ResetPhysicalRow;
    observation: ResetArtifactObservation;
  };

export class ResetRecoveryHaltError extends Error {
  readonly code = "RESET_RECOVERY_HALT";
  constructor(readonly inspection: Extract<ResetJournalInspection, { status: "halt" }>) {
    super(`reset recovery halted: ${inspection.reason}`);
    this.name = "ResetRecoveryHaltError";
  }
}

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value) <= MAX_TEXT && !value.includes("\0");
const canonicalTime = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalLine = (value: unknown): Buffer => Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);
const corruption = (message: string): ResetCorruptionError => new ResetCorruptionError(message);

export const resetJournalPath = (root: string): string => path.join(root, ".rbox", "state", "reset-v1.json");
export const resetCandidatePath = (root: string, id: string): string => path.join(root, ".rbox", "state", "reset-candidates", `${id}.json`);
export const resetArchivePath = (root: string, nonce: string, hash: string): string => path.join(root, ".rbox", "state", "lineages", nonce, `${hash}.json`);
export const resetIncarnationPath = (root: string): string => path.join(root, ".rbox", "state", "state-incarnation.json");
const activeStatePath = (root: string): string => path.join(root, ".rbox", "state.json");

function validateIdentity(value: unknown): RepoIdentityV1 {
  const identity = record(value);
  if (!identity || !exact(identity, ["relPath", "kind", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime"])) throw corruption("bad repository identity schema");
  for (const key of ["relPath", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime"] as const) {
    if (!bounded(identity[key])) throw corruption(`bad repository identity ${key}`);
  }
  const typed = identity as unknown as RepoIdentityV1;
  validateRepoIdentityV1(typed);
  return typed;
}

function validateBody(journal: Record<string, unknown>): ResetJournalBody {
  if (typeof journal.id !== "string" || !HEX32.test(journal.id) || !["prepared", "ready", "installed", "z-retired"].includes(journal.phase as string) || !canonicalTime(journal.createdAt)) throw corruption("bad reset journal envelope");
  const old = record(journal.old);
  const next = record(journal.next);
  if (!old || !exact(old, ["stream", "stateNonce", "stateRevision", "stateSha256", "z"]) || !bounded(old.stream)
    || typeof old.stateNonce !== "string" || !HEX32.test(old.stateNonce) || !counter(old.stateRevision) || typeof old.stateSha256 !== "string" || !HEX64.test(old.stateSha256) || !Array.isArray(old.z) || old.z.length > MAX_Z) throw corruption("bad old reset state");
  const z: ResetZEntry[] = [];
  const seenActive = new Set<string>();
  const seenRecovery = new Set<string>();
  for (const rawEntry of old.z) {
    const entry = record(rawEntry);
    if (!entry || !exact(entry, ["lineageHash", "repositoryIdentityHash", "repositoryIdentity", "activeRef", "targetOid", "recoveryRef"]) || typeof entry.lineageHash !== "string" || !HEX64.test(entry.lineageHash)
      || typeof entry.repositoryIdentityHash !== "string" || !HEX64.test(entry.repositoryIdentityHash) || typeof entry.targetOid !== "string" || !HEX40.test(entry.targetOid)) throw corruption("bad Z entry");
    const repositoryIdentity = validateIdentity(entry.repositoryIdentity);
    if (repositoryIdentityHash(repositoryIdentity) !== entry.repositoryIdentityHash) throw corruption("repository identity hash mismatch");
    const activeRef = `refs/rbox-local/base-absent-settled/v1/${entry.lineageHash}`;
    const recoveryRef = `refs/rbox-recovery/base-absent/v1/${entry.lineageHash}/${entry.targetOid}`;
    if (entry.activeRef !== activeRef || entry.recoveryRef !== recoveryRef || seenActive.has(activeRef) || seenRecovery.has(recoveryRef)) throw corruption("unsafe or duplicate Z ref");
    seenActive.add(activeRef); seenRecovery.add(recoveryRef);
    z.push({ ...entry as unknown as ResetZEntry, repositoryIdentity });
  }
  const sorted = [...z].sort((a, b) => a.activeRef.localeCompare(b.activeRef) || a.targetOid.localeCompare(b.targetOid));
  if (z.some((entry, index) => entry.activeRef !== sorted[index]?.activeRef || entry.targetOid !== sorted[index]?.targetOid)) throw corruption("unsorted Z entries");
  if (!next || !exact(next, ["stream", "stateNonce", "stateRevision", "stateSha256", "state"]) || !bounded(next.stream)
    || typeof next.stateNonce !== "string" || !HEX32.test(next.stateNonce) || !counter(next.stateRevision) || typeof next.stateSha256 !== "string" || !HEX64.test(next.stateSha256)) throw corruption("bad next reset state");
  const state = record(next.state);
  const allowed = ["stream", "stateNonce", "stateRevision", "lastSyncedSequence", "lastSyncedManifest", "repoRecords", ...(state?.telemetryBindingId === undefined ? [] : ["telemetryBindingId"])] as const;
  const manifest = record(state?.lastSyncedManifest);
  if (!state || !exact(state, allowed) || state.stream !== next.stream || state.stateNonce !== next.stateNonce || state.stateRevision !== next.stateRevision || state.lastSyncedSequence !== 0
    || !manifest || !exact(manifest, ["generatedAt", "files"]) || manifest.generatedAt !== "" || !Array.isArray(manifest.files) || manifest.files.length !== 0
    || !record(state.repoRecords) || Object.keys(state.repoRecords as object).length !== 0 || (state.telemetryBindingId !== undefined && (typeof state.telemetryBindingId !== "string" || !/^[0-9a-f]{16}$/.test(state.telemetryBindingId)))) throw corruption("bad bounded next state");
  if (sha256(canonicalLine(state)) !== next.stateSha256) throw corruption("next state hash mismatch");
  return {
    id: journal.id, phase: journal.phase as ResetPhase, createdAt: journal.createdAt as string,
    old: { ...old as unknown as ResetJournalBody["old"], z },
    next: { ...next as unknown as ResetJournalBody["next"], state: state as unknown as ResetNextState },
  };
}

export function validateResetJournalV1(value: unknown): ResetJournalV1 {
  const journal = record(value);
  if (!journal || !exact(journal, ["v", "id", "phase", "createdAt", "old", "next"]) || journal.v !== 1) throw corruption("bad reset journal v1 envelope");
  return { v: 1, ...validateBody(journal) };
}

export function validateResetJournalV2(value: unknown): ResetJournalV2 {
  const journal = record(value);
  if (!journal || !exact(journal, ["v", "id", "phase", "createdAt", "authorization", "old", "next"]) || journal.v !== 2) throw corruption("bad reset journal v2 envelope");
  const authorization = record(journal.authorization);
  if (!authorization || !exact(authorization, ["version", "authorizedNextStream", "consentKind", "mintedAtRevision"])
    || authorization.version !== 2 || !bounded(authorization.authorizedNextStream)
    || !["setup-rebind", "setup-create"].includes(authorization.consentKind as string) || !counter(authorization.mintedAtRevision)) throw corruption("bad reset authorization witness");
  const body = validateBody(journal);
  const typed = authorization as unknown as ResetJournalAuthorization;
  if (typed.authorizedNextStream !== body.next.stream) throw corruption("reset authorization witness does not bind the journal destination");
  return { v: 2, authorization: typed, ...body };
}

function parseJournal(bytes: Buffer): ResetJournal {
  assertResetParseAdmission(bytes.byteLength);
  let value: unknown;
  try {
    value = parseResetJsonBytes<unknown>(bytes, "reset journal");
  } catch (error) {
    if (error instanceof ResetCorruptionError) {
      throw corruption(`malformed reset journal JSON${error.message.includes("nesting") ? " (nesting limit)" : ""}`);
    }
    throw error;
  }
  return record(value)?.v === 2 ? validateResetJournalV2(value) : validateResetJournalV1(value);
}

export async function readResetJournal(root: string): Promise<ResetJournal | undefined> {
  const bytes = await boundedRead(resetJournalPath(root), MAX_JOURNAL_BYTES);
  return bytes ? parseJournal(bytes) : undefined;
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

async function readRef(entry: ResetZEntry, ref: string): Promise<string | undefined> {
  const out = (await gitRaw(entry.repositoryIdentity.commonDirReal, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "")).trim();
  return HEX40.test(out) ? out : undefined;
}

async function verifyIdentity(entry: ResetZEntry): Promise<void> {
  const current = await readRepoIdentityV1(entry.repositoryIdentity.relPath, entry.repositoryIdentity.kind, entry.repositoryIdentity);
  if (repositoryIdentityHash(current) !== entry.repositoryIdentityHash) throw corruption("repository incarnation changed");
}

function prefixDisposition(values: readonly boolean[]): PrefixDisposition {
  let count = 0;
  while (count < values.length && values[count]) count++;
  return { kind: values.slice(count).some(Boolean) ? "other" : "prefix", count, total: values.length };
}

async function observeRefs(entries: readonly ResetZEntry[]): Promise<{ recovery: PrefixDisposition; activeGroups: PrefixDisposition }> {
  try {
    const recoveryPresent: boolean[] = [];
    for (const entry of entries) {
      await verifyIdentity(entry);
      const value = await readRef(entry, entry.recoveryRef);
      if (value !== undefined && value !== entry.targetOid) return { recovery: { kind: "other", count: 0, total: entries.length }, activeGroups: { kind: "other", count: 0, total: 0 } };
      recoveryPresent.push(value === entry.targetOid);
    }
    const groups = new Map<string, ResetZEntry[]>();
    for (const entry of entries) groups.set(entry.repositoryIdentity.commonDirReal, [...(groups.get(entry.repositoryIdentity.commonDirReal) ?? []), entry]);
    const retired: boolean[] = [];
    for (const commonDir of [...groups.keys()].sort()) {
      const dispositions: boolean[] = [];
      for (const entry of groups.get(commonDir)!) {
        const value = await readRef(entry, entry.activeRef);
        if (value !== undefined && value !== entry.targetOid) return { recovery: prefixDisposition(recoveryPresent), activeGroups: { kind: "other", count: 0, total: groups.size } };
        dispositions.push(value === undefined);
      }
      if (new Set(dispositions).size > 1) return { recovery: prefixDisposition(recoveryPresent), activeGroups: { kind: "other", count: 0, total: groups.size } };
      retired.push(dispositions[0] ?? false);
    }
    return { recovery: prefixDisposition(recoveryPresent), activeGroups: prefixDisposition(retired) };
  } catch {
    return { recovery: { kind: "other", count: 0, total: entries.length }, activeGroups: { kind: "other", count: 0, total: new Set(entries.map((entry) => entry.repositoryIdentity.commonDirReal)).size } };
  }
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
  const [activeHash, candidateHash, archiveHash, marker, refs] = await Promise.all([
    boundedHash(paths.active), boundedHash(paths.candidate), boundedHash(paths.archive), markerDisposition(paths.marker, journal), observeRefs(journal.old.z),
  ]);
  return {
    phase: journal.phase,
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
  const parsed = parseJournal(bytes);
  if (parsed.v !== 2) throw corruption("legacy reset journal has no restorable physical preconditions");
  return { journal: parsed, observation: await observePhysical(root, parsed) };
}

export async function inspectResetJournal(root: string, callerStream?: string): Promise<ResetJournalInspection> {
  let bytes: Buffer | undefined;
  try { bytes = await boundedRead(resetJournalPath(root), MAX_JOURNAL_BYTES); }
  catch (error) {
    const journalIdentityHash = await boundedHash(resetJournalPath(root), RESET_STREAM_BYTE_LIMIT).catch(() => undefined);
    return { status: "halt", reason: error instanceof Error ? error.message : "unreadable reset journal", journalIdentityHash };
  }
  if (!bytes) return { status: "none" };
  const journalIdentityHash = sha256(bytes);
  let journal: ResetJournal;
  try { journal = parseJournal(bytes); }
  catch (error) { return { status: "halt", reason: error instanceof Error ? error.message : "malformed reset journal", journalIdentityHash }; }
  if (journal.v === 1) return { status: "halt", reason: "legacy reset journal v1 has no authorization witness", journalIdentityHash, journal };
  if (callerStream !== journal.old.stream && callerStream !== journal.next.stream) {
    return { status: "halt", reason: callerStream === undefined ? "caller stream is unavailable" : "durable config names neither authorized reset stream", journalIdentityHash, journal };
  }
  let observation: ResetArtifactObservation;
  try { observation = await observePhysical(root, journal); }
  catch (error) { return { status: "halt", reason: error instanceof Error ? error.message : "physical reset inspection failed", journalIdentityHash, journal }; }
  const row = classifyResetPhysicalSignature(observation);
  if (!row) return { status: "halt", reason: "physical reset state matches no authorized recovery row", journalIdentityHash, journal, observation };
  return { status: "recoverable", journalIdentityHash, journal, configDisposition: callerStream === journal.old.stream ? "old" : "next", row, observation };
}

async function writeJournal(root: string, journal: ResetJournalV2): Promise<void> {
  validateResetJournalV2(journal);
  await durableWrite(resetJournalPath(root), canonicalLine(journal));
}

async function setPhase(root: string, journal: ResetJournalV2, nextPhase: ResetPhase, hooks: ResetJournalHooks): Promise<ResetJournalV2> {
  const next = { ...journal, phase: nextPhase };
  await writeJournal(root, next);
  await hooks.crashAt?.(`after-${nextPhase}`);
  return next;
}

async function createRecoveryRefs(entries: readonly ResetZEntry[], start: number, hooks: ResetJournalHooks): Promise<void> {
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    await verifyIdentity(entry);
    if (await readRef(entry, entry.activeRef) !== entry.targetOid) throw corruption(`active Z changed ${entry.activeRef}`);
    const recovery = await readRef(entry, entry.recoveryRef);
    if (recovery !== undefined && recovery !== entry.targetOid) throw corruption(`wrong recovery Z target ${entry.recoveryRef}`);
    if (recovery === undefined) await gitRaw(entry.repositoryIdentity.commonDirReal, ["update-ref", entry.recoveryRef, entry.targetOid, ""]);
    await hooks.crashAt?.(`after-recovery-ref-${index + 1}`);
  }
}

async function retireActiveGroups(entries: readonly ResetZEntry[], start: number, hooks: ResetJournalHooks): Promise<void> {
  const groups = new Map<string, ResetZEntry[]>();
  for (const entry of entries) groups.set(entry.repositoryIdentity.commonDirReal, [...(groups.get(entry.repositoryIdentity.commonDirReal) ?? []), entry]);
  const ordered = [...groups.keys()].sort();
  for (let index = start; index < ordered.length; index++) {
    const commonDir = ordered[index]!;
    const group = groups.get(commonDir)!.sort((a, b) => a.activeRef.localeCompare(b.activeRef));
    for (const entry of group) {
      await verifyIdentity(entry);
      if (await readRef(entry, entry.recoveryRef) !== entry.targetOid) throw corruption(`wrong recovery Z target ${entry.recoveryRef}`);
      const active = await readRef(entry, entry.activeRef);
      if (active !== undefined && active !== entry.targetOid) throw corruption(`wrong active Z target ${entry.activeRef}`);
    }
    const present = await Promise.all(group.map(async (entry) => (await readRef(entry, entry.activeRef)) === entry.targetOid));
    if (present.some(Boolean) && !present.every(Boolean)) throw corruption(`physically impossible mixed Z retirement in ${commonDir}`);
    if (present.every(Boolean)) {
      const stdin = group.map((entry) => `delete ${entry.activeRef} ${entry.targetOid}`).join("\n") + "\n";
      await gitRaw(commonDir, ["update-ref", "--stdin"], { stdin });
    }
    await hooks.crashAt?.(`after-active-group-${index + 1}`);
  }
}

export async function recoverResetJournalUnderHeldFence(
  root: string,
  callerStream: string,
  hooks: ResetJournalHooks,
  stateLock: OwnedLock,
): Promise<"none" | "complete"> {
  if (!(await stateLock.isOwner())) throw corruption("sync state lock ownership was lost");
  let inspection = await inspectResetJournal(root, callerStream);
  if (inspection.status === "none") return "none";
  if (inspection.status === "halt") throw new ResetRecoveryHaltError(inspection);
  let journal = inspection.journal;
  const candidatePath = resetCandidatePath(root, journal.id);
  const archivePath = resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256);
  const nextBytes = canonicalLine(journal.next.state);

  if (journal.phase === "prepared") {
    const rowId = inspection.row.ids[0]!;
    if (rowId === "P0") {
      await expectedAbsentOrExact(candidatePath, nextBytes);
      await hooks.crashAt?.("after-candidate-create");
    }
    if (rowId === "P0" || rowId === "P1") {
      if (await boundedHash(activeStatePath(root)) !== journal.old.stateSha256) throw corruption("old state changed before archive creation");
      if (!(await boundedCopy(activeStatePath(root), archivePath))) throw corruption("old state disappeared before archive creation");
      if (await boundedHash(archivePath) !== journal.old.stateSha256) throw corruption("old state archive copy mismatch");
      await hooks.crashAt?.("after-archive-create");
    }
    inspection = await inspectResetJournal(root, callerStream);
    if (inspection.status !== "recoverable") throw inspection.status === "halt" ? new ResetRecoveryHaltError(inspection) : corruption("reset journal disappeared during recovery");
    await createRecoveryRefs(journal.old.z, inspection.observation.recoveryRefs.count, hooks);
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
    if (inspection.row.ids[0] === "R0") await fs.rename(candidatePath, activeStatePath(root));
    await fsyncDirectory(activeParent);
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
    await retireActiveGroups(journal.old.z, inspection.observation.activeRefGroups.count, hooks);
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
    try { return await recoverResetJournalUnderHeldFence(root, callerStream, hooks, acquired.lock); }
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
      stream: oldState.stream, stateNonce: oldState.stateNonce!, stateRevision: oldState.stateRevision!, stateSha256: sha256(oldBytes),
      z: [...z].sort((a, b) => a.activeRef.localeCompare(b.activeRef) || a.targetOid.localeCompare(b.targetOid)),
    },
    next: { stream: nextStream, stateNonce: nonce, stateRevision: nextState.stateRevision, stateSha256: sha256(canonicalLine(nextState)), state: nextState },
  };
  const [activeHash, candidateHash, archiveHash, marker, refs] = await Promise.all([
    boundedHash(activeStatePath(root)), boundedHash(resetCandidatePath(root, id)), boundedHash(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256)),
    markerDisposition(resetIncarnationPath(root), journal), observeRefs(journal.old.z),
  ]);
  if (activeHash !== journal.old.stateSha256 || candidateHash !== undefined || archiveHash !== undefined || !["old", "absent"].includes(marker)
    || refs.recovery.kind !== "prefix" || refs.recovery.count !== 0 || refs.activeGroups.kind !== "prefix" || refs.activeGroups.count !== 0) {
    throw new Error("reset refused: physical state does not satisfy the normalized P0 initiation invariant");
  }
  await writeJournal(root, journal);
  await hooks.crashAt?.("after-prepared");
  return journal;
}
