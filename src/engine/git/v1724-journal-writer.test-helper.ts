/**
 * Test-only vendoring of the v1.7.24 checkout-journal writer.
 *
 * Source: git blob f7da751a66bdaec057ed5895a300d7db717ad30a
 * (`v1.7.24:src/engine/git/journal.ts`). The declarations and writer functions
 * below are copied verbatim; only imports unused by this extracted slice were
 * omitted. Keep this independent of the upgraded writer so compatibility tests
 * exercise bytes that the released writer itself could emit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../hash.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../fsutil.js";
import type { GitSection } from "../types.js";

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
