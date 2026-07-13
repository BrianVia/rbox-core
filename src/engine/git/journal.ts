import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile } from "../hash.js";
import { fsyncDirectory, writeFileAtomic } from "../fsutil.js";
import type { GitSection } from "../types.js";
import { git } from "./shared.js";
import { pruneEmptyOpStateDirs, readAllRefs } from "./refs.js";

export interface CheckoutJournalBinding {
  stream: string;
  stateNonce: string;
  gitDirReal: string;
  commonDirReal: string;
  worktreeId: string;
}

export interface CheckoutJournal<TIntended = unknown> {
  phase: "intent" | "published";
  incomingKey: string;
  incomingSection: GitSection;
  old: {
    currentRefName?: string;
    currentRefOid?: string;
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
    head: string;
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

function safeRel(rel: string): boolean {
  return rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

async function durableAtomic(abs: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, data);
  await fsyncDirectory(path.dirname(abs));
}

/** r2 F1/F2: publish byte-exact rollback material before the intent marker. */
export async function writeCheckoutJournal<T>(
  workspaceRoot: string,
  relPath: string,
  journal: CheckoutJournal<T>,
  sources: WriteCheckoutJournalSources,
): Promise<string> {
  if (journal.phase !== "intent") throw new Error("new checkout journal must start in intent phase");
  const dir = checkoutJournalDir(workspaceRoot, relPath);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "old-op"), { recursive: true });
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
  await durableAtomic(path.join(dir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  await fsyncDirectory(dir);
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

async function uniqueRetirePath(root: string, area: string, key: string): Promise<string> {
  const base = path.join(root, ".rbox", area);
  await fs.mkdir(base, { recursive: true });
  let dest = path.join(base, `${Date.now()}-${key}`);
  for (let n = 1; await fs.access(dest).then(() => true, () => false); n++) dest = path.join(base, `${Date.now()}-${key}-${n}`);
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
  let journal: CheckoutJournal<T>;
  try {
    journal = JSON.parse(await fs.readFile(jsonPath, "utf8")) as CheckoutJournal<T>;
    if (!journal || (journal.phase !== "intent" && journal.phase !== "published") || !journal.binding) throw new Error("invalid journal shape");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    return { status: "defer", reason: "unreadable or corrupt journal", journalPath: dir };
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

  // Validate ALL rollback bytes before the first mutation. This makes a corrupt
  // nested op-state copy as fail-closed as a corrupt old-index copy.
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

  const human: string[] = [];
  const repoDir = relPath === "." ? workspaceRoot : path.join(workspaceRoot, ...relPath.split("/"));
  const indexPath = path.join(binding.gitDirReal, "index");
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

  const oldRefs: Record<string, string | null> = { ...(journal.old.preWipeRefs ?? {}) };
  if (journal.old.currentRefName) oldRefs[journal.old.currentRefName] = journal.old.currentRefOid ?? null;
  const wipeLiveRefs = journal.old.preWipeRefs ? Object.keys(await readAllRefs(repoDir)) : [];
  for (const ref of new Set([...Object.keys(oldRefs), ...Object.keys(journal.expectedNew.refs), ...wipeLiveRefs])) {
    const live = await liveRef(repoDir, ref);
    const old = oldRefs[ref] ?? null;
    const expected = journal.expectedNew.refs[ref] ?? null;
    if (live === old) continue;
    if (live !== expected) { human.push(`ref:${ref}`); continue; }
    if (old) await git(repoDir, ["update-ref", ref, old, live ?? "0".repeat(40)]);
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
