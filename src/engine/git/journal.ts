import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile } from "../hash.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../fsutil.js";
import type { GitSection } from "../types.js";
import { exists, git, readRegularFileNoFollow, ZERO_OID } from "./shared.js";
import { pruneEmptyOpStateDirs, readAllRefs } from "./refs.js";
import { runUpdateRefTransaction } from "./keep-pins.js";

export interface CheckoutJournalBinding {
  stream: string;
  stateNonce: string;
  gitDirReal: string;
  commonDirReal: string;
  worktreeId: string;
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
    /** Empty lockfiles owned by checkout-txn across a branch switch. */
    reservedRefs?: Record<string, string | null>;
    indexLock?: { dev: number; ino: number };
    reservedLocks?: Record<string, { dev: number; ino: number }>;
    /** Ref-transaction locks are named durably before prepare. A token is
     * filled after prepare; expectedBytes closes the prepare-ok -> token-write
     * crash window for the journal-owned child transaction. */
    preparedTransactions?: Array<{
      id: "primary" | "post-head";
      ownerPid: number;
      prepareStarted: boolean;
      completed?: boolean;
      locks: Array<{
        path: string;
        expectedBytes: string[];
        token?: { dev: number; ino: number };
      }>;
    }>;
    /** Our O_EXCL reservation acquired immediately after a branch-switch
     * symref commit and held through index/op-state publication. */
    headLock?: {
      path: string;
      acquireStarted: boolean;
      expectedBytes: string[];
      token?: { dev: number; ino: number };
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
  return a.stream === b.stream && a.stateNonce === b.stateNonce && a.gitDirReal === b.gitDirReal && a.commonDirReal === b.commonDirReal && a.worktreeId === b.worktreeId;
}

function validCheckoutJournalBinding(value: unknown): value is CheckoutJournalBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<CheckoutJournalBinding>;
  return typeof binding.stream === "string" && typeof binding.stateNonce === "string"
    && typeof binding.gitDirReal === "string" && typeof binding.commonDirReal === "string"
    && typeof binding.worktreeId === "string";
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

function normHead(value: string): string {
  return value.trim();
}

function lockPathIsBound(abs: string, binding: CheckoutJournalBinding): boolean {
  const resolved = path.resolve(abs);
  const roots = [path.resolve(binding.gitDirReal), path.resolve(binding.commonDirReal)];
  return resolved.endsWith(".lock") && roots.some((root) => resolved.startsWith(`${root}${path.sep}`));
}

async function readLock(abs: string): Promise<{ bytes: Buffer; dev: number; ino: number } | undefined> {
  const live = await readRegularFileNoFollow(abs);
  return live ? { bytes: live.bytes, dev: live.token.dev, ino: live.token.ino } : undefined;
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

/** Remove only lockfiles owned by the intent journal. Token equality is the
 * normal proof. Exact expected bytes are the deliberately narrow fallback for
 * a crash after O_EXCL/prepare but before the observed inode was journaled. */
async function recoverJournalLocks(journal: CheckoutJournal, binding: CheckoutJournalBinding): Promise<string[]> {
  const human: string[] = [];
  const candidates = new Map<string, Array<{ expectedBytes: string[]; token?: { dev: number; ino: number }; shapeOwned: boolean }>>();
  for (const transaction of journal.expectedNew.preparedTransactions ?? []) {
    if (transaction.completed) continue;
    for (const lock of transaction.locks) {
      const list = candidates.get(lock.path) ?? [];
      list.push({ expectedBytes: lock.expectedBytes, token: lock.token, shapeOwned: transaction.prepareStarted });
      candidates.set(lock.path, list);
    }
  }
  const headLock = journal.expectedNew.headLock;
  if (headLock?.acquireStarted) {
    const list = candidates.get(headLock.path) ?? [];
    list.push({ expectedBytes: headLock.expectedBytes, token: headLock.token, shapeOwned: true });
    candidates.set(headLock.path, list);
  }

  for (const [abs, intents] of candidates) {
    if (!lockPathIsBound(abs, binding)) {
      human.push(`lock:${abs}`);
      continue;
    }
    const live = await readLock(abs);
    if (!live) continue;
    const encoded = live.bytes.toString("base64");
    const owned = intents.some((intent) => intent.token?.dev === live.dev && intent.token.ino === live.ino)
      || intents.some((intent) => intent.shapeOwned && intent.expectedBytes.includes(encoded));
    if (owned) await fs.rm(abs, { force: true });
    else human.push(`lock:${abs}`);
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
): Promise<JournalRecoveryResult<T>> {
  const dir = checkoutJournalDir(workspaceRoot, relPath);
  const jsonPath = path.join(dir, "journal.json");
  const ownership = await readJournalOwnershipId(workspaceRoot, relPath);
  let journal: CheckoutJournal<T>;
  try {
    journal = JSON.parse(await fs.readFile(jsonPath, "utf8")) as CheckoutJournal<T>;
    const id = (journal as { journalId?: unknown }).journalId;
    if (!journal || (journal.phase !== "intent" && journal.phase !== "published") || !validCheckoutJournalBinding(journal.binding)
      || (id !== undefined && (typeof id !== "string" || !/^\d+-[0-9a-f]+$/.test(id)))) throw new Error("invalid journal shape");
  } catch (error) {
    // Corrupt JSON cannot name an owner. The independently durable sidecar is
    // the only exact cleanup authority available on this exit.
    if (ownership.status === "valid") await recoverOrigHeadLock(ownership.journalId, [binding]);
    // journal.id is published first, while checkout locking starts only after
    // writeCheckoutJournal returns. A sidecar-only ENOENT is therefore a
    // pre-lock write crash, not a journal that can require arbitration.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && ownership.status !== "invalid") return { status: "none" };
    return { status: "defer", reason: "unreadable or corrupt journal", journalPath: dir };
  }
  const journalId = (journal as { journalId?: string }).journalId;
  if (journalId === undefined) {
    // Upgrade compatibility: pre-design-126 journals cannot own this new lock
    // and retain their established rollback/published recovery semantics.
    if (ownership.status === "valid") await recoverOrigHeadLock(ownership.journalId, [binding, journal.binding]);
  } else {
    if (ownership.status === "valid" && ownership.journalId !== journalId) {
      // Parseable JSON identifies the recovered journal. A mismatched sidecar
      // id is foreign/ambiguous and must never authorize lock removal.
      await recoverOrigHeadLock(journalId, [binding, journal.binding]);
      return { status: "defer", reason: "checkout journal ownership sidecar mismatch", journalPath: dir };
    }
    await recoverOrigHeadLock(journalId, [binding, journal.binding]);
  }
  if (!bindingsEqual(journal.binding, binding)) return { status: "binding-mismatch", quarantinePath: await retireJournal(workspaceRoot, relPath) };
  if (journal.phase === "published") return { status: "keep", intended: journal.intended, incomingKey: journal.incomingKey, journalPath: dir };

  if (journal.createdFresh) {
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

  const human: string[] = await recoverJournalLocks(journal, binding);
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

  const repoDir = relPath === "." ? workspaceRoot : path.join(workspaceRoot, ...relPath.split("/"));
  const indexPath = path.join(binding.gitDirReal, "index");
  const indexLockPath = path.join(binding.gitDirReal, "index.lock");
  const indexLock = await fs.readFile(indexLockPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (indexLock !== undefined) {
    const stat = await fs.lstat(indexLockPath);
    const token = journal.expectedNew.indexLock;
    const owned = token !== undefined && stat.dev === token.dev && stat.ino === token.ino;
    if (owned) await fs.rm(indexLockPath, { force: true });
    else human.push("index.lock");
  }
  for (const [ref, oid] of Object.entries(journal.expectedNew.reservedRefs ?? {})) {
    const lockPath = path.join(binding.commonDirReal, `${ref}.lock`);
    const bytes = await fs.readFile(lockPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (bytes === undefined) continue;
    const stat = await fs.lstat(lockPath);
    const token = journal.expectedNew.reservedLocks?.[ref];
    const live = await liveRef(repoDir, ref);
    if (bytes.length === 0 && live === oid && token && stat.dev === token.dev && stat.ino === token.ino) await fs.rm(lockPath, { force: true });
    else human.push(`lock:${ref}`);
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

  const oldRefs: Record<string, string | null> = { ...(journal.old.refs ?? {}), ...(journal.old.preWipeRefs ?? {}) };
  if (journal.old.currentRefName) oldRefs[journal.old.currentRefName] = journal.old.currentRefOid ?? null;
  const branchInverses = journal.expectedNew.branchInverses ?? [];
  const typedBranchRefs = new Set(branchInverses.map((inverse) => inverse.ref));
  for (const inverse of branchInverses) {
    const live = await liveRef(repoDir, inverse.ref);
    // A confirmed manual absent-terminal transition can leave R absent on both
    // sides while creating A under the same transaction. Its typed inverse is
    // therefore intentionally non-empty even though the physical endpoints are
    // equal; run it so rollback removes the exact A target.
    if (live === inverse.beforeOid && inverse.beforeOid !== inverse.afterOid) continue;
    if (live !== inverse.afterOid) { human.push(`ref:${inverse.ref}`); continue; }
    try {
      await runUpdateRefTransaction(repoDir, inverse.lines);
    } catch {
      human.push(`branch-inverse:${inverse.ref}`);
    }
  }
  const wipeLiveRefs = journal.old.preWipeRefs ? Object.keys(await readAllRefs(repoDir)) : [];
  for (const ref of new Set([...Object.keys(oldRefs), ...Object.keys(journal.expectedNew.refs), ...wipeLiveRefs])) {
    const live = await liveRef(repoDir, ref);
    const old = oldRefs[ref] ?? null;
    const expected = journal.expectedNew.refs[ref] ?? null;
    // Branch rollback authority exists only in its exact typed inverse. Never
    // fall through to the generic ref restore if that inverse hard-held, and
    // never synthesize branch authority for an older/incomplete journal.
    if (ref.startsWith("refs/heads/")) {
      if (!typedBranchRefs.has(ref) && live !== old) human.push(`branch-inverse-missing:${ref}`);
      continue;
    }
    if (live === old) continue;
    if (live !== expected) { human.push(`ref:${ref}`); continue; }
    if (old) await git(repoDir, ["update-ref", ref, old, live ?? ZERO_OID]);
    else if (live) await git(repoDir, ["update-ref", "-d", ref, live]);
  }

  const headPath = path.join(binding.gitDirReal, "HEAD");
  const liveHead = await fs.readFile(headPath, "utf8").catch(() => "");
  if (normHead(liveHead) !== normHead(journal.old.headContent)) {
    if (normHead(liveHead) !== normHead(journal.expectedNew.head)) human.push("HEAD");
    else await durableAtomic(headPath, journal.old.headContent);
  }

  if (human.length > 0) return { status: "human-intervened", quarantinePath: await retireJournal(workspaceRoot, relPath), fields: human };
  await clearCheckoutJournal(workspaceRoot, relPath);
  return { status: "rolled-back" };
}
