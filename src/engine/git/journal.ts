import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile } from "../hash.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../fsutil.js";
import type { GitSection } from "../types.js";
import { exists, git, readRegularFileNoFollow } from "./shared.js";
import { pruneEmptyOpStateDirs, readAllRefs } from "./refs.js";
import { runUpdateRefTransaction } from "./keep-pins.js";
import {
  acquireLock,
  captureCommonDirIdentity,
  classifyProcessIncarnation,
  commonDirIdentityMatches,
  deserializeMarkerObservation,
  observeLockMarker,
  parseLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  sameMarkerObservation,
  systemLockIdentity,
  validProcessIncarnation,
  type CommonDirIdentity,
  type LockIdentitySource,
  type ProcessIncarnation,
  type SerializedMarkerObservation,
} from "./lockfile.js";

export interface CheckoutJournalBinding {
  stream: string;
  stateNonce: string;
  gitDirReal: string;
  commonDirReal: string;
  commonDirIdentity: CommonDirIdentity;
  worktreeId: string;
}

/** Exact binding persisted by the v1.7.24 writer. It predates the durable
 * common-directory identity fence, so it is accepted only by the explicitly
 * legacy recovery path below. */
interface LegacyCheckoutJournalBinding extends Omit<CheckoutJournalBinding, "commonDirIdentity"> {
  commonDirIdentity?: never;
}

interface LegacyLockToken {
  dev: number;
  ino: number;
}

interface LegacyCheckoutLockShape {
  indexLock?: LegacyLockToken;
  reservedLocks?: Record<string, LegacyLockToken>;
  headLock?: {
    path: string;
    acquireStarted: boolean;
    expectedBytes: string[];
    token?: LegacyLockToken;
  };
}

export interface CheckoutJournal<TIntended = unknown> {
  /** Durable ownership token for pseudo-ref locks. Mirrored byte-for-byte in
   * journal.id so corrupt-JSON recovery can still retire an owned lock. */
  journalId: string;
  phase: "intent" | "published";
  incomingKey: string;
  incomingSection: GitSection;
  old: {
    currentRefName?: string;
    currentRefOid?: string;
    /** Additional checkout-plane refs (for example a branch-switch target). */
    refs?: Record<string, string | null>;
    headContent: string;
    indexPresent: boolean;
    opState: Record<string, true>;
    preWipeRefs?: Record<string, string>;
    /** Internal integrity metadata required to distinguish corrupt recovery bytes. */
    indexHash?: string;
    opStateHashes?: Record<string, string>;
  };
  expectedNew: {
    indexHash?: string;
    opState: Record<string, string | null>;
    refs: Record<string, string>;
    /** Typed A/P/K/Z rollback supplied by the branch-transition planner. */
    branchInverses?: Array<{
      ref: string;
      beforeOid: string | null;
      afterOid: string | null;
      lines: string[];
    }>;
    head: string;
    /** Marker-bearing lockfiles owned by checkout-txn across a branch switch. */
    reservedRefs?: Record<string, string | null>;
    indexLock?: { acquireStarted: boolean; observation?: SerializedMarkerObservation };
    reservedLocks?: Record<string, { marker: string; observation?: SerializedMarkerObservation }>;
    /** Ref-transaction locks are named durably before prepare. A token is
     * filled after prepare. Deletion authority is the inode token or a full
     * marker observation ONLY — expectedBytes never authorizes an unlink
     * (a same-bytes foreign lock must be preserved); a prepare-ok ->
     * token-write crash therefore classifies preserve, not recover. */
    preparedTransactions?: Array<{
      id: "primary" | "post-head";
      ownerPid: number;
      /** Boot/PID/start-bound child identity. Absent only in legacy journals. */
      owner?: ProcessIncarnation;
      prepareStarted: boolean;
      completed?: boolean;
      locks: Array<{
        path: string;
        expectedBytes: string[];
        /** birthtimeNs sharpens the dev/ino inode token so a freed-and-reused
         * inode carrying identical bytes is not mistaken for ours. Absent for
         * pre-birthtime journals and unsupported filesystems. */
        token?: { dev: number; ino: number; birthtimeNs?: string };
      }>;
    }>;
    /** Our O_EXCL reservation acquired immediately after a branch-switch
     * symref commit and held through index/op-state publication. */
    headLock?: {
      path: string;
      acquireStarted: boolean;
      expectedBytes: string[];
      observation?: SerializedMarkerObservation;
    };
  };
  binding: CheckoutJournalBinding;
  createdFresh: boolean;
  intended: TIntended;
  episode?: { verb: "take-theirs"; snapshotId: string };
}

export interface WriteCheckoutJournalSources {
  indexPath: string;
  gitDir: string;
}

export type JournalRecoveryResult<TIntended = unknown> =
  | { status: "none" }
  | { status: "rolled-back" }
  | { status: "human-intervened"; quarantinePath: string; fields: string[] }
  | { status: "binding-mismatch"; quarantinePath: string }
  | { status: "fresh-quarantined"; quarantinePath: string }
  | { status: "defer"; reason: string; journalPath: string }
  | { status: "keep"; intended: TIntended; incomingKey: string; journalPath: string };

const keyFor = (relPath: string) => hashBytes(Buffer.from(relPath));
export const checkoutJournalDir = (workspaceRoot: string, relPath: string) => path.join(workspaceRoot, ".rbox", "state", "git-journal", keyFor(relPath));
const checkoutJournalIdPath = (workspaceRoot: string, relPath: string) => path.join(checkoutJournalDir(workspaceRoot, relPath), "journal.id");
/** Cheap presence probe for the recovery gate. Fails open: any error other
 * than ENOENT reports "present" so the full recovery machinery runs. */
export const checkoutJournalPresent = (workspaceRoot: string, relPath: string): Promise<boolean> =>
  fs.lstat(checkoutJournalDir(workspaceRoot, relPath)).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );

function safeRel(rel: string): boolean {
  return rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

async function durableAtomic(abs: string, data: string | Uint8Array): Promise<void> {
  const parent = path.dirname(abs);
  const created = await ensureDirectoryChain(parent, "journal directory");
  await writeFileAtomic(abs, data);
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

/** r2 F1/F2: publish byte-exact rollback material before the intent marker. */
export async function writeCheckoutJournal<T>(
  workspaceRoot: string,
  relPath: string,
  journal: CheckoutJournal<T>,
  sources: WriteCheckoutJournalSources,
): Promise<string> {
  if (journal.phase !== "intent") throw new Error("new checkout journal must start in intent phase");
  if (!/^\d+-[0-9a-f]+$/.test(journal.journalId)) throw new Error("invalid checkout journal id");
  const dir = checkoutJournalDir(workspaceRoot, relPath);
  await fs.rm(dir, { recursive: true, force: true });
  const journalDirectoriesCreated = await ensureDirectoryChain(path.join(dir, "old-op"), "journal directory");
  if (journal.old.indexPresent) {
    const bytes = await fs.readFile(sources.indexPath);
    journal.old.indexHash = hashBytes(bytes);
    await durableAtomic(path.join(dir, "old-index"), bytes);
  }
  journal.old.opStateHashes = {};
  for (const rel of Object.keys(journal.old.opState)) {
    if (!safeRel(rel)) throw new Error(`unsafe journal op-state path: ${rel}`);
    const bytes = await fs.readFile(path.join(sources.gitDir, rel));
    journal.old.opStateHashes[rel] = hashBytes(bytes);
    await durableAtomic(path.join(dir, "old-op", rel), bytes);
  }
  await durableAtomic(checkoutJournalIdPath(workspaceRoot, relPath), journal.journalId);
  await durableAtomic(path.join(dir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  await fsyncDirectory(dir);
  await fsyncCreatedDirectoryAncestors(dir, journalDirectoriesCreated);
  return dir;
}

export async function updateCheckoutJournal<T>(workspaceRoot: string, relPath: string, journal: CheckoutJournal<T>): Promise<void> {
  await durableAtomic(path.join(checkoutJournalDir(workspaceRoot, relPath), "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
}

/** r3 F1: marker publication precedes the caller's state save. */
export async function markCheckoutJournalPublished(workspaceRoot: string, relPath: string): Promise<void> {
  const abs = path.join(checkoutJournalDir(workspaceRoot, relPath), "journal.json");
  const journal = JSON.parse(await fs.readFile(abs, "utf8")) as CheckoutJournal;
  journal.phase = "published";
  await durableAtomic(abs, `${JSON.stringify(journal, null, 2)}\n`);
}

export async function clearCheckoutJournal(workspaceRoot: string, relPath: string): Promise<void> {
  const dir = checkoutJournalDir(workspaceRoot, relPath);
  await fs.rm(dir, { recursive: true, force: true });
  await fsyncDirectory(path.dirname(dir)).catch(() => {});
}

function bindingsEqual(a: CheckoutJournalBinding, b: CheckoutJournalBinding): boolean {
  return a.stream === b.stream && a.stateNonce === b.stateNonce && a.gitDirReal === b.gitDirReal
    && a.commonDirReal === b.commonDirReal && a.worktreeId === b.worktreeId
    && a.commonDirIdentity.path === b.commonDirIdentity.path
    && a.commonDirIdentity.realpath === b.commonDirIdentity.realpath
    && a.commonDirIdentity.dev === b.commonDirIdentity.dev
    && a.commonDirIdentity.ino === b.commonDirIdentity.ino
    && a.commonDirIdentity.birthtimeNs === b.commonDirIdentity.birthtimeNs;
}

function scalarBindingsEqual(a: LegacyCheckoutJournalBinding, b: CheckoutJournalBinding): boolean {
  return a.stream === b.stream && a.stateNonce === b.stateNonce && a.gitDirReal === b.gitDirReal
    && a.commonDirReal === b.commonDirReal && a.worktreeId === b.worktreeId;
}

function validBindingScalars(value: unknown): value is LegacyCheckoutJournalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<CheckoutJournalBinding>;
  return typeof binding.stream === "string" && typeof binding.stateNonce === "string"
    && typeof binding.gitDirReal === "string" && typeof binding.commonDirReal === "string"
    && typeof binding.worktreeId === "string";
}

function validCheckoutJournalBinding(value: unknown): value is CheckoutJournalBinding {
  if (!validBindingScalars(value)) return false;
  const binding = value as Partial<CheckoutJournalBinding>;
  return !!binding.commonDirIdentity && typeof binding.commonDirIdentity === "object"
    && typeof binding.commonDirIdentity.path === "string" && typeof binding.commonDirIdentity.realpath === "string"
    && typeof binding.commonDirIdentity.dev === "string" && typeof binding.commonDirIdentity.ino === "string"
    && typeof binding.commonDirIdentity.birthtimeNs === "string";
}

function validLegacyCheckoutJournalBinding(value: unknown): value is LegacyCheckoutJournalBinding {
  return validBindingScalars(value) && (value as { commonDirIdentity?: unknown }).commonDirIdentity === undefined;
}

function validLockToken(value: unknown): value is { dev: number; ino: number } {
  if (!value || typeof value !== "object") return false;
  const token = value as { dev?: unknown; ino?: unknown };
  return Object.keys(token).length === 2 && Object.keys(token).every((key) => key === "dev" || key === "ino")
    && Number.isSafeInteger(token.dev) && Number(token.dev) >= 0
    && Number.isSafeInteger(token.ino) && Number(token.ino) >= 0;
}

/** Current prepared-transaction inode token: the v1.7.24 dev/ino pair plus an
 * optional birthtimeNs. Legacy records keep the strict two-key shape above. */
function validCurrentLockToken(value: unknown): value is { dev: number; ino: number; birthtimeNs?: string } {
  if (!value || typeof value !== "object") return false;
  const token = value as { dev?: unknown; ino?: unknown; birthtimeNs?: unknown };
  return Object.keys(token).every((key) => key === "dev" || key === "ino" || key === "birthtimeNs")
    && Number.isSafeInteger(token.dev) && Number(token.dev) >= 0
    && Number.isSafeInteger(token.ino) && Number(token.ino) >= 0
    && (token.birthtimeNs === undefined || (typeof token.birthtimeNs === "string" && /^(?:0|[1-9]\d*)$/.test(token.birthtimeNs)));
}

/** Compare an inode token's birth time only when the journal token and the live
 * inode both report one (0/absent = unsupported fs or a pre-birthtime journal);
 * otherwise dev/ino/bytes stay the authority. */
function tokenBirthtimeMatches(persisted: string | undefined, live: bigint): boolean {
  if (persisted === undefined || live === 0n) return true;
  const value = BigInt(persisted);
  return value === 0n || value === live;
}

function validExpectedBytes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((encoded) => {
    if (typeof encoded !== "string" || encoded.length > 2048 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length <= 1024 && bytes.toString("base64") === encoded;
  });
}

function validLegacyExpectedBytes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  let encodedBytes = 0;
  for (const encoded of value) {
    if (typeof encoded !== "string" || encoded.length > 128 * 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
    encodedBytes += encoded.length;
    if (encodedBytes > 256 * 1024 * 1024) return false;
  }
  return true;
}

const VALID_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_ANY_OID = /^(?:0{40}|0{64})$/;
const safeRefName = (ref: string): boolean => ref.startsWith("refs/") && ref.length <= 1024
  && !ref.includes("..") && !ref.includes("\\") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");

function validRefMap(value: unknown, nullable: boolean): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 4096
    && Object.entries(value).every(([ref, oid]) => safeRefName(ref)
      && ((nullable && oid === null) || (typeof oid === "string" && VALID_OID.test(oid))));
}

function validBranchInverse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const inverse = value as { ref?: unknown; beforeOid?: unknown; afterOid?: unknown; lines?: unknown };
  if (typeof inverse.ref !== "string" || !inverse.ref.startsWith("refs/heads/") || !safeRefName(inverse.ref)
    || (inverse.beforeOid !== null && (typeof inverse.beforeOid !== "string" || !VALID_OID.test(inverse.beforeOid)))
    || (inverse.afterOid !== null && (typeof inverse.afterOid !== "string" || !VALID_OID.test(inverse.afterOid)))
    || !Array.isArray(inverse.lines) || inverse.lines.length === 0 || inverse.lines.length > 256) return false;
  let sawPrimary = false;
  for (const raw of inverse.lines) {
    if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\n") || raw.includes("\0")) return false;
    const fields = raw.split(" ");
    const [command, ref, next, previous] = fields;
    if (!command || !ref || !safeRefName(ref) || !["create", "update", "delete", "verify"].includes(command)) return false;
    const oids = fields.slice(2);
    if (oids.length === 0 || oids.length > 2 || oids.some((oid) => !VALID_OID.test(oid) && !ZERO_ANY_OID.test(oid))) return false;
    if (ref === inverse.ref) {
      if (sawPrimary) return false;
      sawPrimary = true;
      const expected = inverse.beforeOid === null && inverse.afterOid === null
        ? `verify ${ref} ${"0".repeat(40)}`
        : inverse.beforeOid === null
          ? `delete ${ref} ${inverse.afterOid}`
          : inverse.afterOid === null
            ? `create ${ref} ${inverse.beforeOid}`
            : `update ${ref} ${inverse.beforeOid} ${inverse.afterOid}`;
      if (raw !== expected && !(inverse.beforeOid === null && inverse.afterOid === null && command === "verify" && next && ZERO_ANY_OID.test(next) && previous === undefined)) return false;
    } else if (!ref.startsWith("refs/rbox-local/") && !ref.startsWith("refs/rbox-recovery/")) return false;
  }
  return sawPrimary;
}

function validCheckoutJournalCoreShape(journal: CheckoutJournal): boolean {
  if (typeof journal.incomingKey !== "string" || typeof journal.createdFresh !== "boolean"
    || !journal.old || typeof journal.old !== "object" || typeof journal.old.headContent !== "string"
    || typeof journal.old.indexPresent !== "boolean" || !journal.old.opState || typeof journal.old.opState !== "object" || Array.isArray(journal.old.opState)
    || Object.entries(journal.old.opState).some(([rel, present]) => !safeRel(rel) || present !== true)
    || (journal.old.currentRefName !== undefined && (typeof journal.old.currentRefName !== "string" || !safeRefName(journal.old.currentRefName)))
    || (journal.old.currentRefOid !== undefined && (typeof journal.old.currentRefOid !== "string" || !VALID_OID.test(journal.old.currentRefOid)))
    || (journal.old.refs !== undefined && !validRefMap(journal.old.refs, true))
    || (journal.old.preWipeRefs !== undefined && !validRefMap(journal.old.preWipeRefs, false))
    || !journal.expectedNew || typeof journal.expectedNew !== "object"
    || typeof journal.expectedNew.head !== "string" || !journal.expectedNew.opState || typeof journal.expectedNew.opState !== "object" || Array.isArray(journal.expectedNew.opState)
    || Object.entries(journal.expectedNew.opState).some(([rel, hash]) => !safeRel(rel) || (hash !== null && typeof hash !== "string"))
    || !journal.expectedNew.refs || typeof journal.expectedNew.refs !== "object" || Array.isArray(journal.expectedNew.refs)
    || !validRefMap(journal.expectedNew.refs, false)
    || (journal.expectedNew.branchInverses !== undefined && (!Array.isArray(journal.expectedNew.branchInverses)
      || journal.expectedNew.branchInverses.length > 256 || journal.expectedNew.branchInverses.some((inverse) => !validBranchInverse(inverse))))) return false;
  const reservedRefs = journal.expectedNew.reservedRefs;
  if (reservedRefs !== undefined) {
    if (!reservedRefs || typeof reservedRefs !== "object" || Array.isArray(reservedRefs) || Object.keys(reservedRefs).length > 256) return false;
    for (const [ref, oid] of Object.entries(reservedRefs)) {
      if (!safeRefName(ref) || (oid !== null && (typeof oid !== "string" || !VALID_OID.test(oid)))) return false;
    }
  }
  return true;
}

function validPreparedTransactions(journal: CheckoutJournal, legacy: boolean): boolean {
  const transactions = journal.expectedNew.preparedTransactions;
  if (transactions !== undefined) {
    if (!Array.isArray(transactions) || transactions.length > 2) return false;
    const ids = new Set<string>();
    const lockPaths = new Set<string>();
    for (const transaction of transactions) {
      if (!transaction || typeof transaction !== "object" || (transaction.id !== "primary" && transaction.id !== "post-head")
        || ids.has(transaction.id) || !Number.isSafeInteger(transaction.ownerPid) || transaction.ownerPid <= 0
        || typeof transaction.prepareStarted !== "boolean" || (transaction.completed !== undefined && typeof transaction.completed !== "boolean")
        || (legacy ? transaction.owner !== undefined
          : transaction.owner === undefined || !validProcessIncarnation(transaction.owner) || transaction.owner.pid !== transaction.ownerPid)
        || !Array.isArray(transaction.locks) || transaction.locks.length > 256) return false;
      ids.add(transaction.id);
      for (const lock of transaction.locks) {
        if (!lock || typeof lock.path !== "string" || !path.isAbsolute(lock.path) || lock.path.length > 4096
          || lockPaths.has(path.resolve(lock.path)) || !(legacy ? validLegacyExpectedBytes(lock.expectedBytes) : validExpectedBytes(lock.expectedBytes))
          || (legacy && Object.keys(lock).some((key) => !["path", "expectedBytes", "token"].includes(key)))
          || (lock.token !== undefined && (!transaction.prepareStarted || !(legacy ? validLockToken(lock.token) : validCurrentLockToken(lock.token))))) return false;
        lockPaths.add(path.resolve(lock.path));
      }
    }
  }
  return true;
}

/** Validate every current recovery-authority field before any journal-directed
 * lock inspection or unlink. JSON shape errors are fail-closed, never partial. */
function validCheckoutLockJournalShape(journal: CheckoutJournal): boolean {
  if (!validCheckoutJournalCoreShape(journal) || !validPreparedTransactions(journal, false)) return false;
  const headLock = journal.expectedNew.headLock;
  if (headLock !== undefined && (!headLock || typeof headLock.path !== "string" || !path.isAbsolute(headLock.path)
    || headLock.path.length > 4096 || typeof headLock.acquireStarted !== "boolean" || !validExpectedBytes(headLock.expectedBytes)
    || (headLock as unknown as { token?: unknown }).token !== undefined
    || (headLock.observation !== undefined && !deserializeMarkerObservation(headLock.observation))
    || (headLock.observation !== undefined && !headLock.acquireStarted))) return false;
  const indexLock = journal.expectedNew.indexLock;
  if (indexLock !== undefined && (!indexLock || typeof indexLock !== "object"
    || typeof indexLock.acquireStarted !== "boolean"
    || (indexLock.observation !== undefined && !deserializeMarkerObservation(indexLock.observation))
    || (indexLock.observation !== undefined && !indexLock.acquireStarted))) return false;
  const reservedLocks = journal.expectedNew.reservedLocks;
  if (reservedLocks !== undefined && (!reservedLocks || typeof reservedLocks !== "object" || Array.isArray(reservedLocks)
    || Object.keys(reservedLocks).length > 256 || Object.values(reservedLocks).some((token) => !token || typeof token !== "object"
      || typeof token.marker !== "string" || Buffer.byteLength(token.marker) > 1024 || !parseLockMarker(token.marker)
      || (token.observation !== undefined && (!deserializeMarkerObservation(token.observation)
        || deserializeMarkerObservation(token.observation)?.raw !== token.marker))
      ))) return false;
  const reservedRefs = journal.expectedNew.reservedRefs;
  if (reservedRefs !== undefined) {
    if (reservedLocks && (Object.keys(reservedLocks).length !== Object.keys(reservedRefs).length
      || Object.keys(reservedRefs).some((ref) => !(ref in reservedLocks)))) return false;
  } else if (reservedLocks !== undefined && Object.keys(reservedLocks).length > 0) return false;
  return true;
}

/** Accept only the exact lock-record families written by v1.7.24. In
 * particular, modern marker observations cannot be smuggled through a legacy
 * scalar binding, and expected bytes never stand in for a missing inode token. */
function validLegacyCheckoutLockJournalShape(journal: CheckoutJournal): boolean {
  if (!validCheckoutJournalCoreShape(journal) || !validPreparedTransactions(journal, true)) return false;
  const legacy = journal.expectedNew as CheckoutJournal["expectedNew"] & LegacyCheckoutLockShape;
  const indexLock = legacy.indexLock as unknown;
  if (indexLock !== undefined && !validLockToken(indexLock)) return false;
  const headLock = legacy.headLock as unknown as LegacyCheckoutLockShape["headLock"];
  if (headLock !== undefined && (!headLock || typeof headLock.path !== "string" || !path.isAbsolute(headLock.path)
    || headLock.path.length > 4096 || typeof headLock.acquireStarted !== "boolean" || !validExpectedBytes(headLock.expectedBytes)
    || Object.keys(headLock).some((key) => !["path", "acquireStarted", "expectedBytes", "token"].includes(key))
    || (headLock.token !== undefined && (!headLock.acquireStarted || !validLockToken(headLock.token)))
    )) return false;
  const reservedLocks = legacy.reservedLocks as unknown;
  if (reservedLocks !== undefined && (!reservedLocks || typeof reservedLocks !== "object" || Array.isArray(reservedLocks)
    || Object.keys(reservedLocks).length > 256 || Object.values(reservedLocks).some((token) => !validLockToken(token)))) return false;
  const reservedRefs = journal.expectedNew.reservedRefs;
  if (reservedRefs === undefined) return reservedLocks === undefined || Object.keys(reservedLocks as object).length === 0;
  return reservedLocks === undefined || (Object.keys(reservedLocks as object).length === Object.keys(reservedRefs).length
    && Object.keys(reservedRefs).every((ref) => ref in (reservedLocks as object)));
}

async function uniqueRetirePath(root: string, area: string, key: string): Promise<string> {
  const base = path.join(root, ".rbox", area);
  await fs.mkdir(base, { recursive: true });
  let dest = path.join(base, `${Date.now()}-${key}`);
  for (let n = 1; await exists(dest); n++) dest = path.join(base, `${Date.now()}-${key}-${n}`);
  return dest;
}

async function retireJournal(root: string, relPath: string): Promise<string> {
  const src = checkoutJournalDir(root, relPath);
  const dest = await uniqueRetirePath(root, "state/git-journal-quarantine", keyFor(relPath));
  await fs.rename(src, dest);
  return dest;
}

async function liveRef(repoDir: string, ref: string): Promise<string | null> {
  return (await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "")) || null;
}

async function planAtomicRefRollback(
  repoDir: string,
  journal: CheckoutJournal,
): Promise<{ lines: string[]; human: string[] }> {
  const human: string[] = [];
  const lines: string[] = [];
  const oldRefs: Record<string, string | null> = { ...(journal.old.refs ?? {}), ...(journal.old.preWipeRefs ?? {}) };
  if (journal.old.currentRefName) oldRefs[journal.old.currentRefName] = journal.old.currentRefOid ?? null;
  const branchInverses = journal.expectedNew.branchInverses ?? [];
  const typedBranchRefs = new Set(branchInverses.map((inverse) => inverse.ref));
  const inverseRefs = new Set<string>();

  for (const inverse of branchInverses) {
    for (const line of inverse.lines) inverseRefs.add(line.split(" ")[1]!);
    const live = await liveRef(repoDir, inverse.ref);
    // A confirmed manual absent-terminal transition can leave R absent on both
    // sides while creating A under the same transaction. Its typed inverse is
    // intentionally non-empty even though the physical endpoints are equal.
    if (live === inverse.beforeOid && inverse.beforeOid !== inverse.afterOid) continue;
    if (live !== inverse.afterOid) human.push(`ref:${inverse.ref}`);
    else lines.push(...inverse.lines);
  }

  const wipeLiveRefs = journal.old.preWipeRefs ? Object.keys(await readAllRefs(repoDir)) : [];
  for (const ref of new Set([...Object.keys(oldRefs), ...Object.keys(journal.expectedNew.refs), ...wipeLiveRefs])) {
    const live = await liveRef(repoDir, ref);
    const old = oldRefs[ref] ?? null;
    const expected = journal.expectedNew.refs[ref] ?? null;
    if (ref.startsWith("refs/heads/")) {
      if (!typedBranchRefs.has(ref) && live !== old) human.push(`branch-inverse-missing:${ref}`);
      continue;
    }
    // A typed inverse owns all of its side refs as one unit. Duplicating one in
    // the generic restoration set would make the batch self-conflicting.
    if (inverseRefs.has(ref) || live === old) continue;
    if (live !== expected) {
      human.push(`ref:${ref}`);
      continue;
    }
    if (old === null) {
      if (live !== null) lines.push(`delete ${ref} ${live}`);
    } else if (live === null) lines.push(`create ${ref} ${old}`);
    else lines.push(`update ${ref} ${old} ${live}`);
  }
  return { lines, human };
}

function normHead(value: string): string {
  return value.trim();
}

function lockPathIsBound(abs: string, binding: CheckoutJournalBinding): boolean {
  const resolved = path.resolve(abs);
  const roots = [path.resolve(binding.gitDirReal), path.resolve(binding.commonDirReal)];
  return resolved.endsWith(".lock") && roots.some((root) => resolved.startsWith(`${root}${path.sep}`));
}

async function safeCheckoutLockParent(abs: string, binding: CheckoutJournalBinding): Promise<boolean> {
  if (!lockPathIsBound(abs, binding)) return false;
  const resolved = path.resolve(abs);
  const root = [path.resolve(binding.gitDirReal), path.resolve(binding.commonDirReal)]
    .find((candidate) => resolved.startsWith(`${candidate}${path.sep}`));
  if (!root) return false;
  try {
    return await safeBoundLockParent(root, resolved, { create: false }) === "safe";
  } catch {
    return false;
  }
}

async function readLock(abs: string): Promise<import("./lockfile.js").MarkerObservation | undefined> {
  return observeLockMarker(abs);
}

type JournalOwnershipIdRead = { status: "absent" | "invalid" } | { status: "valid"; journalId: string };

async function readJournalOwnershipId(workspaceRoot: string, relPath: string): Promise<JournalOwnershipIdRead> {
  const sidecar = checkoutJournalIdPath(workspaceRoot, relPath);
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.lstat(sidecar);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) return { status: "invalid" };
    handle = await fs.open(sidecar, constants.O_RDONLY | constants.O_NOFOLLOW);
    const raw = await handle.readFile();
    const value = raw.toString("utf8");
    return raw.length <= 256 && /^\d+-[0-9a-f]+$/.test(value)
      ? { status: "valid", journalId: value }
      : { status: "invalid" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "invalid" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The sidecar, not journal JSON, is the recovery authority for this lock.
 * Removal is content-exact; a foreign lock is never touched. */
async function recoverOrigHeadLock(journalId: string, bindings: readonly CheckoutJournalBinding[]): Promise<void> {
  const dirs = new Set(bindings.map((binding) => binding.gitDirReal).filter(Boolean).map((dir) => path.resolve(dir)));
  for (const gitDir of dirs) {
    const gitDirStat = await fs.lstat(gitDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!gitDirStat) continue;
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) throw new Error(`unsafe checkout journal gitDir: ${gitDir}`);
    const lockPath = path.join(gitDir, "ORIG_HEAD.lock");
    let handle: fs.FileHandle | undefined;
    let token: { dev: number; ino: number } | undefined;
    let live: Buffer | undefined;
    try {
      const stat = await fs.lstat(lockPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256) {
        handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        token = { dev: opened.dev, ino: opened.ino };
        live = await handle.readFile();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    if (live?.equals(Buffer.from(journalId)) && token) {
      const beforeRemove = await fs.lstat(lockPath).catch(() => undefined);
      if (beforeRemove && beforeRemove.dev === token.dev && beforeRemove.ino === token.ino) await fs.rm(lockPath, { force: true });
    }
    // Always make the observed directory state durable, including absence left
    // by an earlier recovery whose unlink fsync failed.
    await fsyncDirectory(gitDir);
  }
}

async function recoverOrigHeadLockFenced(
  journalId: string,
  binding: CheckoutJournalBinding,
  identity: LockIdentitySource,
): Promise<boolean> {
  if (!await commonDirIdentityMatches(binding.commonDirIdentity)) return false;
  const fencePath = path.join(binding.commonDirReal, "rbox-locks", "recovery", "v1", "recovery.lock");
  try {
    await safeBoundLockParent(binding.commonDirReal, fencePath, { create: true });
  } catch {
    return false;
  }
  const fence = await acquireLock(fencePath, { identity });
  if (fence.status !== "acquired") return false;
  try {
    if (!await commonDirIdentityMatches(binding.commonDirIdentity)) return false;
    await recoverOrigHeadLock(journalId, [binding]);
    return true;
  } finally {
    await fence.lock.release();
  }
}

/** Remove only lockfiles owned by the intent journal. Exact expected bytes
 * validate an inode token or full observation; bytes alone never authorize
 * deletion. */
async function childIsDead(owner: ProcessIncarnation, identity: LockIdentitySource): Promise<boolean | undefined> {
  const classification = await classifyProcessIncarnation(owner, identity);
  return classification === "unknown" ? undefined : classification === "dead";
}

async function legacyChildIsDead(ownerPid: number, identity: LockIdentitySource): Promise<boolean | undefined> {
  try {
    const probe = await identity.probe(ownerPid);
    return probe.status === "unknown" ? undefined : probe.status === "dead";
  } catch {
    return undefined;
  }
}

const staleLegacyLockDiagnostic = (abs: string): string =>
  `stale-unattributed lock:${abs}; run \`rbox doctor\`, confirm no Git process owns it, then remove only the verified stale lock`;

async function recoverJournalLocks(
  journal: CheckoutJournal,
  binding: CheckoutJournalBinding,
  identity: LockIdentitySource,
  legacy: boolean,
): Promise<{ human: string[]; liveOwner: boolean }> {
  const human: string[] = [];
  let liveOwner = false;
  const candidates = new Map<string, Array<{
    expectedBytes: string[];
    token?: { dev: number; ino: number; birthtimeNs?: string };
    observation?: import("./lockfile.js").MarkerObservation;
    ownerDead?: boolean;
  }>>();
  for (const transaction of journal.expectedNew.preparedTransactions ?? []) {
    if (transaction.completed) continue;
    const legacyHasInodeAuthority = transaction.locks.every((lock) => lock.token !== undefined);
    const ownerDead = legacy
      ? legacyHasInodeAuthority ? await legacyChildIsDead(transaction.ownerPid, identity) : undefined
      : transaction.owner === undefined ? true : await childIsDead(transaction.owner, identity);
    for (const lock of transaction.locks) {
      const list = candidates.get(lock.path) ?? [];
      list.push({ expectedBytes: lock.expectedBytes, token: lock.token, ...(ownerDead === undefined ? {} : { ownerDead }) });
      candidates.set(lock.path, list);
    }
  }
  const headLock = journal.expectedNew.headLock;
  if (headLock) {
    const list = candidates.get(headLock.path) ?? [];
    const legacyHead = headLock as unknown as LegacyCheckoutLockShape["headLock"];
    const observed = legacy ? undefined : deserializeMarkerObservation(headLock.observation);
    list.push({
      expectedBytes: headLock.expectedBytes,
      ...(legacy && legacyHead?.token ? { token: legacyHead.token } : {}),
      ...(observed ? { observation: observed } : {}),
      ownerDead: true,
    });
    candidates.set(headLock.path, list);
  }

  for (const [abs, intents] of candidates) {
    const live = await readLock(abs);
    if (!live) continue;
    if (!(await safeCheckoutLockParent(abs, binding))) {
      human.push(legacy ? staleLegacyLockDiagnostic(abs) : `lock:${abs}`);
      continue;
    }
    if (intents.some((intent) => intent.ownerDead !== true)) {
      if (legacy) human.push(staleLegacyLockDiagnostic(abs));
      else liveOwner = true;
      continue;
    }
    const encoded = Buffer.from(live.raw).toString("base64");
    // v1.7.24 predicted an empty HEAD.lock for symref-update, while Git writes
    // the new `ref:` bytes. Its dead-child + exact dev/ino token is therefore
    // the complete legacy authority; expected bytes are only current-schema
    // integrity evidence and never rescue a tokenless legacy record.
    const owned = intents.some((intent) => intent.ownerDead === true && intent.token !== undefined
      && BigInt(intent.token.dev) === live.dev && BigInt(intent.token.ino) === live.inode
      && tokenBirthtimeMatches(intent.token.birthtimeNs, live.birthtimeNs)
      && (legacy || intent.expectedBytes.includes(encoded)))
      || intents.some((intent) => intent.ownerDead === true && intent.observation !== undefined
        && sameMarkerObservation(live, intent.observation) && intent.expectedBytes.includes(encoded));
    if (!owned) {
      human.push(legacy ? staleLegacyLockDiagnostic(abs) : `lock:${abs}`);
      continue;
    }
    const verify = await readLock(abs);
    if (!verify || verify.dev !== live.dev || verify.inode !== live.inode || verify.size !== live.size
      || verify.mtimeNs !== live.mtimeNs || verify.raw !== live.raw) {
      human.push(legacy ? staleLegacyLockDiagnostic(abs) : `lock:${abs}`);
      continue;
    }
    const released = await releaseObservedLock(abs, live);
    if (!released.released || !released.durable) human.push(legacy ? staleLegacyLockDiagnostic(abs) : `lock:${abs}`);
  }
  return { human, liveOwner };
}

/** v1.7.24 journaled index/reservation ownership as inode tokens. Validate the
 * token against a no-follow observation, then release that exact observation;
 * absent or mismatched authority is preservation, never expected-bytes cleanup. */
async function recoverLegacyDirectLocks(
  journal: CheckoutJournal,
  binding: CheckoutJournalBinding,
  repoDir: string,
): Promise<string[]> {
  const human: string[] = [];
  const legacy = journal.expectedNew as CheckoutJournal["expectedNew"] & LegacyCheckoutLockShape;
  const candidates: Array<{ path: string; token?: LegacyLockToken; empty?: true; expectedRef?: [string, string | null] }> = [{
    path: path.join(binding.gitDirReal, "index.lock"),
    token: legacy.indexLock as unknown as LegacyLockToken | undefined,
  }];
  for (const [ref, oid] of Object.entries(journal.expectedNew.reservedRefs ?? {})) {
    candidates.push({
      path: path.join(binding.commonDirReal, `${ref}.lock`),
      token: (legacy.reservedLocks as Record<string, LegacyLockToken> | undefined)?.[ref],
      empty: true,
      expectedRef: [ref, oid],
    });
  }
  for (const candidate of candidates) {
    const observed = await readLock(candidate.path);
    if (!observed) continue;
    if (!(await safeCheckoutLockParent(candidate.path, binding))) {
      human.push(staleLegacyLockDiagnostic(candidate.path));
      continue;
    }
    const tokenMatches = candidate.token !== undefined
      && BigInt(candidate.token.dev) === observed.dev && BigInt(candidate.token.ino) === observed.inode;
    const bytesMatch = !candidate.empty || observed.raw.length === 0;
    const refMatches = candidate.expectedRef === undefined
      || await liveRef(repoDir, candidate.expectedRef[0]) === candidate.expectedRef[1];
    if (!tokenMatches || !bytesMatch || !refMatches) {
      human.push(staleLegacyLockDiagnostic(candidate.path));
      continue;
    }
    const released = await releaseObservedLock(candidate.path, observed);
    if (!released.released || !released.durable) human.push(staleLegacyLockDiagnostic(candidate.path));
  }
  return human;
}

/**
 * Intent recovery is rollback-only (r2 F2). Every field uses old/new/third
 * arbitration (r3 F5); a third value is preserved and causes journal retirement.
 * Published recovery returns only opaque intent for the CLI's fresh CAS merge
 * (r4 F1)—the engine never imports or replays CLI state.
 */
export async function recoverJournal<T = unknown>(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
  options: { identity?: LockIdentitySource } = {},
): Promise<JournalRecoveryResult<T>> {
  const dir = checkoutJournalDir(workspaceRoot, relPath);
  const jsonPath = path.join(dir, "journal.json");
  const ownership = await readJournalOwnershipId(workspaceRoot, relPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch (error) {
    // journal.id is published first, while checkout locking starts only after
    // writeCheckoutJournal returns. A sidecar-only ENOENT is therefore a
    // pre-lock write crash, not a journal that can require arbitration. Corrupt
    // JSON cannot supply the persisted common-dir identity/fence, so it never
    // authorizes path-targeted lock cleanup.
    if (ownership.status === "valid") {
      await recoverOrigHeadLockFenced(ownership.journalId, binding, options.identity ?? systemLockIdentity);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && ownership.status !== "invalid") return { status: "none" };
    return { status: "defer", reason: "unreadable or corrupt journal", journalPath: dir };
  }
  const journal = parsed as CheckoutJournal<T>;
  const id = (journal as { journalId?: unknown }).journalId;
  const validId = id === undefined || (typeof id === "string" && /^\d+-[0-9a-f]+$/.test(id));
  const currentSchema = validCheckoutJournalBinding(journal?.binding) && validCheckoutLockJournalShape(journal);
  const legacySchema = typeof id === "string" && validLegacyCheckoutJournalBinding(journal?.binding)
    && validLegacyCheckoutLockJournalShape(journal);
  if (!journal || (journal.phase !== "intent" && journal.phase !== "published") || !validId
    || (!currentSchema && !legacySchema)) {
    return { status: "defer", reason: "unreadable or corrupt journal", journalPath: dir };
  }
  const legacy = legacySchema;
  const journalBindingMatches = legacy
    ? scalarBindingsEqual(journal.binding as unknown as LegacyCheckoutJournalBinding, binding)
    : bindingsEqual(journal.binding, binding);
  const journalId = (journal as { journalId?: string }).journalId;
  if (journalId === undefined) {
    // Upgrade compatibility: pre-design-126 journals cannot own new locks.
  } else {
    if (ownership.status === "valid" && ownership.journalId !== journalId) {
      // Parseable JSON identifies the recovered journal. A mismatched sidecar
      // id is foreign/ambiguous and must never authorize lock removal.
      if (journalBindingMatches) {
        await recoverOrigHeadLockFenced(journalId, binding, options.identity ?? systemLockIdentity);
      }
      return { status: "defer", reason: "checkout journal ownership sidecar mismatch", journalPath: dir };
    }
  }
  if (!journalBindingMatches) {
    return { status: "binding-mismatch", quarantinePath: await retireJournal(workspaceRoot, relPath) };
  }
  if (journal.phase === "published") {
    if (journalId !== undefined) await recoverOrigHeadLockFenced(journalId, binding, options.identity ?? systemLockIdentity);
    return { status: "keep", intended: journal.intended, incomingKey: journal.incomingKey, journalPath: dir };
  }

  if (journal.createdFresh) {
    if (legacy) {
      return {
        status: "human-intervened",
        quarantinePath: await retireJournal(workspaceRoot, relPath),
        fields: ["stale-unattributed legacy created-fresh journal lacks common-directory identity; inspect the preserved repository with `rbox doctor`"],
      };
    }
    // r4 F2: post-crash freshness is undecidable; never rm -rf. Preserve the
    // entire partial repository (including hooks/objects a human may have added).
    const repoDir = relPath === "." ? workspaceRoot : path.join(workspaceRoot, ...relPath.split("/"));
    const gitEntry = path.join(repoDir, ".git");
    const quarantinePath = await uniqueRetirePath(workspaceRoot, "git-quarantine", keyFor(relPath));
    try {
      await fs.rename(gitEntry, quarantinePath);
      await clearCheckoutJournal(workspaceRoot, relPath);
      return { status: "fresh-quarantined", quarantinePath };
    } catch {
      return { status: "defer", reason: "could not quarantine created-fresh git directory", journalPath: dir };
    }
  }

  const repoDir = relPath === "." ? workspaceRoot : path.join(workspaceRoot, ...relPath.split("/"));
  const recoveryIdentity = legacy ? binding.commonDirIdentity : journal.binding.commonDirIdentity;
  if (!await commonDirIdentityMatches(recoveryIdentity)) {
    return { status: "defer", reason: "checkout common-directory identity changed", journalPath: dir };
  }
  const recoveryFencePath = path.join(binding.commonDirReal, "rbox-locks", "recovery", "v1", "recovery.lock");
  try {
    await safeBoundLockParent(binding.commonDirReal, recoveryFencePath, { create: true });
  } catch {
    return { status: "defer", reason: "checkout recovery fence path is unsafe", journalPath: dir };
  }
  const recoveryFence = await acquireLock(recoveryFencePath, { identity: options.identity });
  if (recoveryFence.status !== "acquired") {
    return { status: "defer", reason: "checkout recovery fence is busy", journalPath: dir };
  }
  if (!await commonDirIdentityMatches(recoveryIdentity)) {
    await recoveryFence.lock.release();
    return { status: "defer", reason: "checkout common-directory identity changed under recovery fence", journalPath: dir };
  }
  try {
  if (journalId !== undefined) await recoverOrigHeadLock(journalId, [binding]);
  const lockRecovery = await recoverJournalLocks(journal, binding, options.identity ?? systemLockIdentity, legacy);
  if (lockRecovery.liveOwner) {
    return { status: "defer", reason: "prepared Git transaction owner is live or indeterminate", journalPath: dir };
  }
  const human: string[] = lockRecovery.human;
  if (legacy) human.push(...await recoverLegacyDirectLocks(journal, binding, repoDir));
  if (human.length > 0) return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: human };

  // Validate ALL rollback bytes before the first checkout-state mutation (owned
  // transaction-lock cleanup above is independently journal-arbitrated). This
  // makes a corrupt nested op-state copy as fail-closed as a corrupt old index.
  try {
    if (journal.old.indexPresent) {
      if (!journal.old.indexHash || await hashFile(path.join(dir, "old-index")) !== journal.old.indexHash) throw new Error("old-index checksum mismatch");
    }
    for (const rel of Object.keys(journal.old.opState)) {
      if (!safeRel(rel) || !journal.old.opStateHashes?.[rel] || await hashFile(path.join(dir, "old-op", rel)) !== journal.old.opStateHashes[rel]) throw new Error("old op-state checksum mismatch");
    }
  } catch {
    return { status: "defer", reason: "unreadable or corrupt journaled rollback bytes", journalPath: dir };
  }

  // Ref rollback is planned in full before the first ref changes, then applied
  // as one update-ref transaction. A third value or an expected-old failure
  // therefore leaves every ref at its pre-recovery value.
  const refRollback = await planAtomicRefRollback(repoDir, journal);
  if (refRollback.human.length > 0) {
    return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: refRollback.human };
  }
  if (refRollback.lines.length > 0) {
    try {
      await runUpdateRefTransaction(repoDir, refRollback.lines);
    } catch {
      return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: ["ref-transaction"] };
    }
  }

  const indexPath = path.join(binding.gitDirReal, "index");
  const indexLockPath = path.join(binding.gitDirReal, "index.lock");
  // Treating a foreign transient index.lock here as human-intervened is accepted
  // conservatism; defer-and-retry remains a follow-up.
  const indexLock = legacy ? undefined : await observeLockMarker(indexLockPath);
  if (indexLock !== undefined) {
    const expected = deserializeMarkerObservation(journal.expectedNew.indexLock?.observation);
    const released = expected ? await releaseObservedLock(indexLockPath, expected) : undefined;
    if (!released?.released || !released.durable) human.push("index.lock");
  }
  for (const [ref, oid] of Object.entries(legacy ? {} : journal.expectedNew.reservedRefs ?? {})) {
    const lockPath = path.join(binding.commonDirReal, `${ref}.lock`);
    const observed = await observeLockMarker(lockPath);
    if (observed === undefined) continue;
    if (!(await safeCheckoutLockParent(lockPath, binding))) {
      human.push(`lock:${ref}`);
      continue;
    }
    const token = journal.expectedNew.reservedLocks?.[ref];
    const live = await liveRef(repoDir, ref);
    const expected = deserializeMarkerObservation(token?.observation);
    if (expected && live === oid) {
      const released = await releaseObservedLock(lockPath, expected);
      if (!released?.released || !released.durable) human.push(`lock:${ref}`);
    } else human.push(`lock:${ref}`);
  }
  if (human.length > 0) return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: human };
  const liveIndex = await fs.readFile(indexPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  const liveIndexHash = liveIndex ? hashBytes(liveIndex) : undefined;
  const oldIndexHash = journal.old.indexPresent ? journal.old.indexHash : undefined;
  if (liveIndexHash !== oldIndexHash) {
    if (liveIndexHash !== journal.expectedNew.indexHash) human.push("index");
    else if (journal.old.indexPresent) await durableAtomic(indexPath, await fs.readFile(path.join(dir, "old-index")));
    else await fs.rm(indexPath, { force: true });
  }

  const opRels = new Set([...Object.keys(journal.old.opState), ...Object.keys(journal.expectedNew.opState)]);
  for (const rel of opRels) {
    if (!safeRel(rel)) { human.push(`op:${rel}`); continue; }
    const abs = path.join(binding.gitDirReal, rel);
    const live = await fs.readFile(abs).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const liveHash = live ? hashBytes(live) : null;
    const oldHash = journal.old.opState[rel] ? journal.old.opStateHashes?.[rel] ?? null : null;
    const expectedHash = journal.expectedNew.opState[rel] ?? null;
    if (liveHash === oldHash) continue;
    if (liveHash !== expectedHash) { human.push(`op:${rel}`); continue; }
    if (journal.old.opState[rel]) await durableAtomic(abs, await fs.readFile(path.join(dir, "old-op", rel)));
    else await fs.rm(abs, { force: true });
  }
  await pruneEmptyOpStateDirs(binding.gitDirReal, Object.keys(journal.old.opState));

  const headPath = path.join(binding.gitDirReal, "HEAD");
  const liveHead = await fs.readFile(headPath, "utf8").catch(() => "");
  if (normHead(liveHead) !== normHead(journal.old.headContent)) {
    if (normHead(liveHead) !== normHead(journal.expectedNew.head)) human.push("HEAD");
    else await durableAtomic(headPath, journal.old.headContent);
  }

  if (human.length > 0) return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: human };
  await clearCheckoutJournal(workspaceRoot, relPath);
  return { status: "rolled-back" };
  } finally {
    await recoveryFence.lock.release().catch(() => ({ released: false, durable: false }));
  }
}
