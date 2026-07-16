import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../engine/e2ee/jcs.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { gitRaw } from "../engine/git/shared.js";
import { acquireLock, type OwnedLock } from "../engine/git/lockfile.js";
import { readRepoIdentityV1, repositoryIdentityHash, validateRepoIdentityV1, type RepoIdentityV1 } from "../engine/git/repo-lineage.js";
import type { SyncState } from "./config.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_Z = 256;
const MAX_TEXT = 4096;

export type ResetPhase = "prepared" | "ready" | "installed" | "z-retired";

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

export interface ResetJournalV1 {
  v: 1;
  id: string;
  phase: ResetPhase;
  createdAt: string;
  old: {
    stream: string;
    stateNonce: string;
    stateRevision: number;
    stateSha256: string;
    z: ResetZEntry[];
  };
  next: {
    stream: string;
    stateNonce: string;
    stateRevision: number;
    stateSha256: string;
    state: ResetNextState;
  };
}

export interface ResetJournalHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
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

export const resetJournalPath = (root: string): string => path.join(root, ".rbox", "state", "reset-v1.json");
export const resetCandidatePath = (root: string, id: string): string => path.join(root, ".rbox", "state", "reset-candidates", `${id}.json`);
export const resetArchivePath = (root: string, nonce: string, hash: string): string => path.join(root, ".rbox", "state", "lineages", nonce, `${hash}.json`);
export const resetIncarnationPath = (root: string): string => path.join(root, ".rbox", "state", "state-incarnation.json");
const activeStatePath = (root: string): string => path.join(root, ".rbox", "state.json");

function validateIdentity(value: unknown): RepoIdentityV1 {
  const identity = record(value);
  if (!identity || !exact(identity, ["relPath", "kind", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime"])) throw new Error("reset-corruption: bad repository identity schema");
  for (const key of ["relPath", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime"] as const) {
    if (!bounded(identity[key])) throw new Error(`reset-corruption: bad repository identity ${key}`);
  }
  const typed = identity as unknown as RepoIdentityV1;
  validateRepoIdentityV1(typed);
  return typed;
}

export function validateResetJournalV1(value: unknown): ResetJournalV1 {
  const journal = record(value);
  if (!journal || !exact(journal, ["v", "id", "phase", "createdAt", "old", "next"]) || journal.v !== 1 || typeof journal.id !== "string" || !HEX32.test(journal.id)
    || !["prepared", "ready", "installed", "z-retired"].includes(journal.phase as string) || !canonicalTime(journal.createdAt)) throw new Error("reset-corruption: bad reset journal envelope");
  const old = record(journal.old);
  const next = record(journal.next);
  if (!old || !exact(old, ["stream", "stateNonce", "stateRevision", "stateSha256", "z"]) || !bounded(old.stream)
    || typeof old.stateNonce !== "string" || !HEX32.test(old.stateNonce) || !counter(old.stateRevision) || typeof old.stateSha256 !== "string" || !HEX64.test(old.stateSha256) || !Array.isArray(old.z) || old.z.length > MAX_Z) {
    throw new Error("reset-corruption: bad old reset state");
  }
  const z: ResetZEntry[] = [];
  const seenActive = new Set<string>();
  const seenRecovery = new Set<string>();
  for (const rawEntry of old.z) {
    const entry = record(rawEntry);
    if (!entry || !exact(entry, ["lineageHash", "repositoryIdentityHash", "repositoryIdentity", "activeRef", "targetOid", "recoveryRef"]) || typeof entry.lineageHash !== "string" || !HEX64.test(entry.lineageHash)
      || typeof entry.repositoryIdentityHash !== "string" || !HEX64.test(entry.repositoryIdentityHash) || typeof entry.targetOid !== "string" || !HEX40.test(entry.targetOid)) throw new Error("reset-corruption: bad Z entry");
    const identity = validateIdentity(entry.repositoryIdentity);
    if (repositoryIdentityHash(identity) !== entry.repositoryIdentityHash) throw new Error("reset-corruption: repository identity hash mismatch");
    const activeRef = `refs/rbox-local/base-absent-settled/v1/${entry.lineageHash}`;
    const recoveryRef = `refs/rbox-recovery/base-absent/v1/${entry.lineageHash}/${entry.targetOid}`;
    if (entry.activeRef !== activeRef || entry.recoveryRef !== recoveryRef || seenActive.has(activeRef) || seenRecovery.has(recoveryRef)) throw new Error("reset-corruption: unsafe or duplicate Z ref");
    seenActive.add(activeRef); seenRecovery.add(recoveryRef);
    z.push({ ...entry as unknown as ResetZEntry, repositoryIdentity: identity });
  }
  const sorted = [...z].sort((a, b) => a.activeRef < b.activeRef ? -1 : a.activeRef > b.activeRef ? 1 : a.targetOid < b.targetOid ? -1 : a.targetOid > b.targetOid ? 1 : 0);
  if (z.some((entry, index) => entry.activeRef !== sorted[index]?.activeRef || entry.targetOid !== sorted[index]?.targetOid)) throw new Error("reset-corruption: unsorted Z entries");
  if (!next || !exact(next, ["stream", "stateNonce", "stateRevision", "stateSha256", "state"]) || !bounded(next.stream)
    || typeof next.stateNonce !== "string" || !HEX32.test(next.stateNonce) || !counter(next.stateRevision) || typeof next.stateSha256 !== "string" || !HEX64.test(next.stateSha256)) throw new Error("reset-corruption: bad next reset state");
  const state = record(next.state);
  const allowed = ["stream", "stateNonce", "stateRevision", "lastSyncedSequence", "lastSyncedManifest", "repoRecords", ...(state?.telemetryBindingId === undefined ? [] : ["telemetryBindingId"])] as const;
  const manifest = record(state?.lastSyncedManifest);
  if (!state || !exact(state, allowed) || state.stream !== next.stream || state.stateNonce !== next.stateNonce || state.stateRevision !== next.stateRevision || state.lastSyncedSequence !== 0
    || !manifest || !exact(manifest, ["generatedAt", "files"]) || manifest.generatedAt !== "" || !Array.isArray(manifest.files) || manifest.files.length !== 0
    || !record(state.repoRecords) || Object.keys(state.repoRecords as object).length !== 0 || (state.telemetryBindingId !== undefined && (typeof state.telemetryBindingId !== "string" || !/^[0-9a-f]{16}$/.test(state.telemetryBindingId)))) {
    throw new Error("reset-corruption: bad bounded next state");
  }
  if (sha256(canonicalLine(state)) !== next.stateSha256) throw new Error("reset-corruption: next state hash mismatch");
  return { ...journal as unknown as ResetJournalV1, old: { ...old as unknown as ResetJournalV1["old"], z }, next: { ...next as unknown as ResetJournalV1["next"], state: state as unknown as ResetNextState } };
}

async function noFollowRead(file: string, cap: number): Promise<Buffer | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new Error(`reset-corruption: unsafe or oversized file ${file}`);
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new Error(`reset-corruption: file changed while reading ${file}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function durableWrite(file: string, bytes: Uint8Array): Promise<void> {
  const parent = path.dirname(file);
  const created = await ensureDirectoryChain(parent, "reset journal directory");
  const existing = await fs.lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`reset-corruption: unsafe path ${file}`);
  await writeFileAtomic(file, bytes, { mode: 0o600 });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

async function expectedAbsentOrExact(file: string, bytes: Uint8Array): Promise<void> {
  const existing = await noFollowRead(file, Math.max(bytes.byteLength, MAX_STATE_BYTES));
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`reset-corruption: wrong existing bytes at ${file}`);
    return;
  }
  await durableWrite(file, bytes);
}

async function readRef(entry: ResetZEntry, ref: string): Promise<string | undefined> {
  const out = (await gitRaw(entry.repositoryIdentity.commonDirReal, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "")).trim();
  return HEX40.test(out) ? out : undefined;
}

async function verifyIdentity(entry: ResetZEntry): Promise<void> {
  const current = await readRepoIdentityV1(entry.repositoryIdentity.relPath, entry.repositoryIdentity.kind, entry.repositoryIdentity);
  if (repositoryIdentityHash(current) !== entry.repositoryIdentityHash) throw new Error("reset-corruption: repository incarnation changed");
}

async function verifyZ(entries: readonly ResetZEntry[], allowActiveAbsent: boolean): Promise<Map<string, "present" | "absent">> {
  const result = new Map<string, "present" | "absent">();
  for (const entry of entries) {
    await verifyIdentity(entry);
    const recovery = await readRef(entry, entry.recoveryRef);
    if (recovery !== entry.targetOid) throw new Error(`reset-corruption: wrong recovery Z target ${entry.recoveryRef}`);
    const active = await readRef(entry, entry.activeRef);
    if (active === undefined && allowActiveAbsent) result.set(entry.activeRef, "absent");
    else if (active === entry.targetOid) result.set(entry.activeRef, "present");
    else throw new Error(`reset-corruption: wrong active Z target ${entry.activeRef}`);
  }
  return result;
}

async function createRecoveryRefs(entries: readonly ResetZEntry[]): Promise<void> {
  for (const entry of entries) {
    await verifyIdentity(entry);
    const active = await readRef(entry, entry.activeRef);
    if (active !== entry.targetOid) throw new Error(`reset-corruption: active Z changed ${entry.activeRef}`);
    const recovery = await readRef(entry, entry.recoveryRef);
    if (recovery === entry.targetOid) continue;
    if (recovery !== undefined) throw new Error(`reset-corruption: wrong recovery Z target ${entry.recoveryRef}`);
    await gitRaw(entry.repositoryIdentity.commonDirReal, ["update-ref", entry.recoveryRef, entry.targetOid, ""]);
  }
}

async function retireActiveZ(entries: readonly ResetZEntry[]): Promise<void> {
  const groups = new Map<string, ResetZEntry[]>();
  for (const entry of entries) groups.set(entry.repositoryIdentity.commonDirReal, [...(groups.get(entry.repositoryIdentity.commonDirReal) ?? []), entry]);
  for (const commonDir of [...groups.keys()].sort()) {
    const group = groups.get(commonDir)!.sort((a, b) => a.activeRef < b.activeRef ? -1 : 1);
    const dispositions = await verifyZ(group, true);
    const values = new Set(dispositions.values());
    if (values.size > 1) throw new Error(`reset-corruption: physically impossible mixed Z retirement in ${commonDir}`);
    if (values.has("absent")) continue;
    const stdin = group.map((entry) => `delete ${entry.activeRef} ${entry.targetOid}`).join("\n") + "\n";
    await gitRaw(commonDir, ["update-ref", "--stdin"], { stdin });
  }
}

async function writeJournal(root: string, journal: ResetJournalV1): Promise<void> {
  validateResetJournalV1(journal);
  await durableWrite(resetJournalPath(root), canonicalLine(journal));
}

export async function readResetJournal(root: string): Promise<ResetJournalV1 | undefined> {
  const bytes = await noFollowRead(resetJournalPath(root), MAX_JOURNAL_BYTES);
  if (!bytes) return undefined;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("reset-corruption: malformed reset journal JSON"); }
  return validateResetJournalV1(value);
}

async function phase(root: string, journal: ResetJournalV1, nextPhase: ResetPhase, hooks: ResetJournalHooks): Promise<ResetJournalV1> {
  const next = { ...journal, phase: nextPhase };
  await writeJournal(root, next);
  await hooks.crashAt?.(`after-${nextPhase}`);
  return next;
}

async function quarantineCandidate(root: string, journal: ResetJournalV1): Promise<void> {
  const candidate = resetCandidatePath(root, journal.id);
  const bytes = await noFollowRead(candidate, MAX_STATE_BYTES);
  if (!bytes) return;
  const dest = path.join(path.dirname(candidate), `${journal.id}.quarantine-${sha256(bytes)}.json`);
  await expectedAbsentOrExact(dest, bytes);
  await fs.rm(candidate);
  await fsyncDirectory(path.dirname(candidate));
}

/** Recover one standing journal to a terminal result. `aborted` is the authorized
 * pre-cutover state-change row: intervening state is preserved and a caller may start
 * again from fresh observations. */
async function recoverResetJournalLocked(root: string, hooks: ResetJournalHooks = {}, stateLock?: OwnedLock): Promise<"none" | "complete" | "aborted"> {
  const requireStateOwner = async (): Promise<void> => {
    if (stateLock && !(await stateLock.isOwner())) throw new Error("reset-corruption: sync state lock ownership was lost");
  };
  let journal = await readResetJournal(root);
  if (!journal) return "none";
  const oldBytes = await noFollowRead(activeStatePath(root), MAX_STATE_BYTES);
  const candidatePath = resetCandidatePath(root, journal.id);
  const candidate = await noFollowRead(candidatePath, MAX_STATE_BYTES);
  const nextBytes = canonicalLine(journal.next.state);
  const oldExact = oldBytes !== undefined && sha256(oldBytes) === journal.old.stateSha256;
  if (journal.phase !== "prepared") {
    const archive = await noFollowRead(resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256), MAX_STATE_BYTES);
    if (!archive || sha256(archive) !== journal.old.stateSha256) throw new Error("reset-corruption: missing or wrong old state archive");
    await verifyZ(journal.old.z, journal.phase === "installed" || journal.phase === "z-retired");
  }

  if (journal.phase === "prepared") {
    if (!oldExact) {
      await quarantineCandidate(root, journal);
      await fs.rm(resetJournalPath(root)); await fsyncDirectory(path.dirname(resetJournalPath(root)));
      return "aborted";
    }
    await expectedAbsentOrExact(candidatePath, nextBytes);
    const archive = resetArchivePath(root, journal.old.stateNonce, journal.old.stateSha256);
    await expectedAbsentOrExact(archive, oldBytes!);
    await createRecoveryRefs(journal.old.z);
    const reloaded = await noFollowRead(activeStatePath(root), MAX_STATE_BYTES);
    if (!reloaded || sha256(reloaded) !== journal.old.stateSha256) throw new Error("reset-corruption: old state changed during preparation");
    await verifyZ(journal.old.z, false);
    journal = await phase(root, journal, "ready", hooks);
  }

  if (journal.phase === "ready") {
    const currentCandidate = await noFollowRead(candidatePath, MAX_STATE_BYTES);
    const currentState = await noFollowRead(activeStatePath(root), MAX_STATE_BYTES);
    if (currentCandidate && (!currentState || sha256(currentState) !== journal.old.stateSha256)) {
      await quarantineCandidate(root, journal);
      await fs.rm(resetJournalPath(root)); await fsyncDirectory(path.dirname(resetJournalPath(root)));
      return "aborted";
    }
    if (currentCandidate && !currentCandidate.equals(nextBytes)) throw new Error(`reset-corruption: wrong candidate ${candidatePath}`);
    if (!currentCandidate) await expectedAbsentOrExact(candidatePath, nextBytes);
    await requireStateOwner();
    await fs.rename(candidatePath, activeStatePath(root));
    await fsyncDirectory(path.dirname(activeStatePath(root)));
    await hooks.crashAt?.("after-state-replace");
    journal = await phase(root, journal, "installed", hooks);
  }

  if (journal.phase === "installed") {
    const current = await noFollowRead(activeStatePath(root), MAX_STATE_BYTES);
    if (!current || !current.equals(nextBytes)) {
      await requireStateOwner();
      await durableWrite(activeStatePath(root), nextBytes);
    }
    const marker = canonicalLine({ stream: journal.next.stream, stateNonce: journal.next.stateNonce, stateRevision: journal.next.stateRevision });
    const existingMarker = await noFollowRead(resetIncarnationPath(root), MAX_JOURNAL_BYTES);
    if (!existingMarker || !existingMarker.equals(marker)) {
      await requireStateOwner();
      await durableWrite(resetIncarnationPath(root), marker);
    }
    const exactState = await noFollowRead(activeStatePath(root), MAX_STATE_BYTES);
    const exactMarker = await noFollowRead(resetIncarnationPath(root), MAX_JOURNAL_BYTES);
    if (!exactState?.equals(nextBytes) || !exactMarker?.equals(marker)) throw new Error("reset-corruption: installed state or incarnation marker moved before Z retirement");
    await verifyZ(journal.old.z, true);
    await retireActiveZ(journal.old.z);
    journal = await phase(root, journal, "z-retired", hooks);
  }

  if (journal.phase === "z-retired") {
    await verifyZ(journal.old.z, true);
    for (const entry of journal.old.z) if (await readRef(entry, entry.activeRef)) throw new Error(`reset-corruption: active Z survived retirement ${entry.activeRef}`);
    await fs.rm(resetJournalPath(root));
    await fsyncDirectory(path.dirname(resetJournalPath(root)));
    const candidateStillExists = await fs.lstat(candidatePath).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    await fs.rm(candidatePath, { force: true });
    if (candidateStillExists) await fsyncDirectory(path.dirname(candidatePath));
    return "complete";
  }
  throw new Error("reset-corruption: unreachable reset phase");
}

export async function recoverResetJournal(root: string, hooks: ResetJournalHooks = {}): Promise<"none" | "complete" | "aborted"> {
  const journal = await readResetJournal(root);
  if (!journal) return "none";
  const locks: OwnedLock[] = [];
  try {
    const commonDirs = [...new Set(journal.old.z.map((entry) => entry.repositoryIdentity.commonDirReal))].sort();
    for (const commonDir of commonDirs) {
      const acquired = await acquireLock(path.join(commonDir, "rbox-operation.lock"));
      if (acquired.status !== "acquired") throw new Error(`reset refused: operation lock unavailable for ${commonDir}`);
      locks.push(acquired.lock);
    }
    const state = await acquireLock(`${activeStatePath(root)}.lock`);
    if (state.status !== "acquired") throw new Error("reset refused: sync state lock unavailable during recovery");
    locks.push(state.lock);
    return await recoverResetJournalLocked(root, hooks, state.lock);
  } finally {
    for (const lock of locks.reverse()) await lock.release();
  }
}

export async function beginResetJournal(
  root: string,
  nextStream: string,
  oldBytes: Uint8Array,
  oldState: SyncState,
  z: ResetZEntry[],
  hooks: ResetJournalHooks = {},
): Promise<ResetJournalV1> {
  if (!bounded(nextStream) || !oldState.stream || !HEX32.test(oldState.stateNonce ?? "") || !counter(oldState.stateRevision)) throw new Error("reset refused: old state lacks a fenced lineage");
  const now = (hooks.now?.() ?? new Date()).toISOString();
  const id = (hooks.randomBytes ?? crypto.randomBytes)(16).toString("hex");
  const nonce = (hooks.randomBytes ?? crypto.randomBytes)(16).toString("hex");
  if (!HEX32.test(id) || !HEX32.test(nonce)) throw new Error("reset refused: random source returned invalid bytes");
  const nextState: ResetNextState = {
    stream: nextStream,
    stateNonce: nonce,
    stateRevision: oldState.stateRevision! + 1,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
    ...(oldState.telemetryBindingId === undefined ? {} : { telemetryBindingId: oldState.telemetryBindingId }),
  };
  const journal: ResetJournalV1 = {
    v: 1, id, phase: "prepared", createdAt: now,
    old: {
      stream: oldState.stream, stateNonce: oldState.stateNonce!, stateRevision: oldState.stateRevision!, stateSha256: sha256(oldBytes),
      z: [...z].sort((a, b) => a.activeRef < b.activeRef ? -1 : a.activeRef > b.activeRef ? 1 : a.targetOid < b.targetOid ? -1 : 1),
    },
    next: { stream: nextStream, stateNonce: nonce, stateRevision: nextState.stateRevision, stateSha256: sha256(canonicalLine(nextState)), state: nextState },
  };
  await writeJournal(root, journal);
  await hooks.crashAt?.("after-prepared");
  return journal;
}
