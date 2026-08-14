import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitIncomingKey } from "./shared.js";
import { hashBytes } from "../../engine/hash.js";
import type { GitSection } from "../../engine/types.js";
import {
  checkoutJournalDir,
  markCheckoutJournalPublished,
  updateCheckoutJournal,
  writeCheckoutJournal,
  type CheckoutJournal,
  type CheckoutJournalBinding,
} from "./v1724-journal-writer.test-helper.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const ZERO_SHA = "0".repeat(64);

type JournalPreparedTransaction = NonNullable<CheckoutJournal["expectedNew"]["preparedTransactions"]>[number];

/* The next three helpers are verbatim from
 * v1.7.24:src/engine/git/checkout-txn.ts. */
function expectedLockBytes(line: string): { ref: string; bytes: string } | undefined {
  const fields = line.split(" ");
  const command = fields[0];
  const ref = fields[1];
  if (!ref || (ref !== "HEAD" && !ref.startsWith("refs/"))) return undefined;
  if (command === "create" || command === "update") {
    const oid = fields[2];
    if (!oid) return undefined;
    return { ref, bytes: Buffer.from(`${oid}\n`).toString("base64") };
  }
  if (command === "delete" || command === "verify" || command === "symref-update" || command === "symref-verify") {
    return { ref, bytes: Buffer.alloc(0).toString("base64") };
  }
  return undefined;
}

async function preparedTransactionIntent(
  ctx: { gitDir: string; commonDir: string },
  id: JournalPreparedTransaction["id"],
  ownerPid: number,
  lines: readonly string[],
  includeHeadReservation: boolean,
): Promise<JournalPreparedTransaction> {
  const byPath = new Map<string, Set<string>>();
  const add = (abs: string, bytes: string) => {
    const key = path.resolve(abs);
    const values = byPath.get(key) ?? new Set<string>();
    values.add(bytes);
    byPath.set(key, values);
  };
  for (const line of lines) {
    const expected = expectedLockBytes(line);
    if (!expected) continue;
    const abs = expected.ref === "HEAD" ? path.join(ctx.gitDir, "HEAD.lock") : path.join(ctx.commonDir, `${expected.ref}.lock`);
    add(abs, expected.bytes);
  }
  // Updating the checked-out referent also makes files-backend Git reserve
  // HEAD, even when HEAD itself is intentionally omitted from the commands.
  if (includeHeadReservation) add(path.join(ctx.gitDir, "HEAD.lock"), Buffer.alloc(0).toString("base64"));

  const packed = await fs.readFile(path.join(ctx.commonDir, "packed-refs"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const packedNames = new Set(packed.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("^")).map((line) => line.split(" ")[1]).filter(Boolean));
  const deleted = new Set(lines.filter((line) => line.startsWith("delete refs/")).map((line) => line.split(" ")[1]!));
  if ([...deleted].some((ref) => packedNames.has(ref))) {
    const packedLock = path.join(ctx.commonDir, "packed-refs.lock");
    // Files-backend Git may stage either the current packed file or the
    // delete-filtered successor depending on exactly where it dies.
    add(packedLock, Buffer.from(packed).toString("base64"));
    if (deleted.size > 0) {
      const kept: string[] = [];
      let omitPeeled = false;
      for (const line of packed.split("\n")) {
        if (line.startsWith("^")) {
          if (!omitPeeled) kept.push(line);
          continue;
        }
        const ref = line && !line.startsWith("#") ? line.split(" ")[1] : undefined;
        omitPeeled = ref !== undefined && deleted.has(ref);
        if (!omitPeeled) kept.push(line);
      }
      add(packedLock, Buffer.from(kept.join("\n")).toString("base64"));
    }
  }

  return {
    id,
    ownerPid,
    prepareStarted: true,
    locks: [...byPath].map(([lockPath, expectedBytes]) => ({ path: lockPath, expectedBytes: [...expectedBytes] })),
  };
}

async function observePreparedLockTokens(transaction: JournalPreparedTransaction): Promise<void> {
  for (const lock of transaction.locks) {
    const token = await lockToken(lock.path);
    if (token) lock.token = { dev: token.dev, ino: token.ino };
  }
}

async function lockToken(abs: string): Promise<{ path: string; dev: number; ino: number } | undefined> {
  try {
    const st = await fs.lstat(abs);
    return { path: path.resolve(abs), dev: st.dev, ino: st.ino };
  } catch {
    return undefined;
  }
}

export type V1724FixturePoint = "prepared-tokenless" | "prepared-tokenized" | "committed-intent" | "published";

export interface V1724BranchSwitchFixture<T> {
  journalDir: string;
  journal: CheckoutJournal<T>;
  raw: string;
  incoming: GitSection;
  oldOid: string;
  newOid: string;
  oldIndex: Buffer;
  candidateIndex: Buffer;
  preparedLockPaths: string[];
}

/**
 * Run the release writer around a real prepared `git update-ref --stdin`
 * branch switch. Process death is SIGKILL so Git leaves the exact lockfiles a
 * crashed v1.7.24 child would have left behind.
 */
export async function writeV1724BranchSwitchFixture<T>(args: {
  workspaceRoot: string;
  relPath: string;
  repoDir: string;
  binding: CheckoutJournalBinding;
  oldOid: string;
  newOid: string;
  point: V1724FixturePoint;
  intended: T;
}): Promise<V1724BranchSwitchFixture<T>> {
  const { workspaceRoot, relPath, repoDir, binding, oldOid, newOid, point, intended } = args;
  const gitDir = binding.gitDirReal;
  const commonDir = binding.commonDirReal;
  const legacyBinding: CheckoutJournalBinding = {
    stream: binding.stream,
    stateNonce: binding.stateNonce,
    gitDirReal: binding.gitDirReal,
    commonDirReal: binding.commonDirReal,
    worktreeId: binding.worktreeId,
  };
  // Branch-switch checkout transactions move HEAD to an existing incoming
  // branch. v1.7.24 reserves that target and prepares only the symref update;
  // any checked-out old-branch transition is a separate post-HEAD transaction.
  await exec("git", ["-C", repoDir, "update-ref", "refs/heads/incoming", newOid], { env: TEST_GIT_ENV });
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const oldIndex = await fs.readFile(path.join(gitDir, "index"));
  const candidatePath = path.join(workspaceRoot, ".rbox", `v1724-candidate-index-${process.pid}-${Date.now()}`);
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.copyFile(path.join(gitDir, "index"), candidatePath);
  await exec("git", ["-C", repoDir, "read-tree", newOid], {
    env: { ...TEST_GIT_ENV, GIT_INDEX_FILE: candidatePath },
  });
  const candidateIndex = await fs.readFile(candidatePath);
  const incoming: GitSection = {
    bundleSha: ZERO_SHA,
    bundleEncSha: ZERO_SHA,
    bundleCipherSize: 0,
    head: "ref: refs/heads/incoming",
    refs: { "refs/heads/main": oldOid, "refs/heads/incoming": newOid },
    refScope: "all",
    generatedAt: "2026-07-22T00:00:00.000Z",
  };
  const journal: CheckoutJournal<T> = {
    journalId: `${Date.now()}-${"7".repeat(16)}`,
    phase: "intent",
    incomingKey: gitIncomingKey(incoming),
    incomingSection: incoming,
    old: {
      currentRefName: "refs/heads/main",
      currentRefOid: oldOid,
      headContent: oldHead,
      indexPresent: true,
      opState: {},
    },
    expectedNew: {
      opState: {},
      refs: {},
      head: incoming.head,
    },
    binding: legacyBinding,
    createdFresh: false,
    intended,
  };
  const journalDir = await writeCheckoutJournal(workspaceRoot, relPath, journal, {
    indexPath: path.join(gitDir, "index"),
    gitDir,
  });

  // commitCheckout computes and journals the candidate hash before starting
  // the prepared transaction.
  journal.expectedNew.indexHash = hashBytes(candidateIndex);
  await updateCheckoutJournal(workspaceRoot, relPath, journal);

  const transactionLines = ["symref-update HEAD refs/heads/incoming ref refs/heads/main"];
  const child = spawn("git", ["-C", repoDir, "update-ref", "--stdin"], {
    env: TEST_GIT_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("v1.7.24 fixture could not start git update-ref");
  let stdout = "";
  let stderr = "";
  const waiters = new Set<() => void>();
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
    for (const wake of waiters) wake();
  });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      for (const wake of waiters) wake();
      resolve(code);
    });
  });
  const waitFor = async (needle: string): Promise<void> => {
    while (!stdout.includes(needle)) {
      const code = child.exitCode;
      if (code !== null) throw new Error(`git update-ref exited ${code} before ${needle}: ${stderr}`);
      await new Promise<void>((resolve) => {
        const wake = () => { waiters.delete(wake); resolve(); };
        waiters.add(wake);
        setTimeout(wake, 2_000).unref?.();
      });
      if (!stdout.includes(needle) && child.exitCode === null) {
        throw new Error(`git update-ref produced no ${needle}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
      }
    }
  };
  const write = (line: string): void => {
    if (!child.stdin!.write(`${line}\n`)) throw new Error(`git update-ref input closed before ${line}`);
  };

  write("start");
  await waitFor("start: ok");
  write("option no-deref");
  for (const line of transactionLines) write(line);
  const primary = await preparedTransactionIntent({ gitDir, commonDir }, "primary", child.pid, transactionLines, true);
  journal.expectedNew.preparedTransactions = [primary];
  await updateCheckoutJournal(workspaceRoot, relPath, journal);
  write("prepare");
  await waitFor("prepare: ok");

  const killPreparedChild = async (): Promise<void> => {
    child.kill("SIGKILL");
    child.stdin!.destroy();
    await exited;
  };
  if (point === "prepared-tokenless") {
    await killPreparedChild();
  } else {
    await observePreparedLockTokens(primary);
    await updateCheckoutJournal(workspaceRoot, relPath, journal);
    if (point === "prepared-tokenized") {
      await killPreparedChild();
    } else {
      const indexLockPath = path.join(gitDir, "index.lock");
      const indexHandle = await fs.open(indexLockPath, "wx");
      const indexToken = await lockToken(indexLockPath);
      if (!indexToken) throw new Error("v1.7.24 fixture could not observe index.lock");
      journal.expectedNew.indexLock = { dev: indexToken.dev, ino: indexToken.ino };
      await updateCheckoutJournal(workspaceRoot, relPath, journal);
      journal.expectedNew.headLock = {
        path: path.resolve(gitDir, "HEAD.lock"),
        acquireStarted: true,
        expectedBytes: [Buffer.alloc(0).toString("base64")],
      };
      await updateCheckoutJournal(workspaceRoot, relPath, journal);

      write("commit");
      child.stdin!.end();
      await waitFor("commit: ok");
      const code = await exited;
      if (code !== 0) throw new Error(`git update-ref commit exited ${code}: ${stderr}`);

      const headLockPath = path.join(gitDir, "HEAD.lock");
      const headHandle = await fs.open(headLockPath, "wx");
      const headToken = await lockToken(headLockPath);
      if (!headToken) throw new Error("v1.7.24 fixture could not observe HEAD.lock");
      journal.expectedNew.headLock.token = { dev: headToken.dev, ino: headToken.ino };
      primary.completed = true;
      await updateCheckoutJournal(workspaceRoot, relPath, journal);

      await indexHandle.writeFile(candidateIndex);
      await indexHandle.sync();
      await indexHandle.close();
      await fs.rename(indexLockPath, path.join(gitDir, "index"));
      await headHandle.close();
      await fs.rm(headLockPath, { force: true });
      if (point === "published") await markCheckoutJournalPublished(workspaceRoot, relPath);
    }
  }

  await fs.rm(candidatePath, { force: true });
  const raw = await fs.readFile(path.join(checkoutJournalDir(workspaceRoot, relPath), "journal.json"), "utf8");
  return {
    journalDir,
    journal,
    raw,
    incoming,
    oldOid,
    newOid,
    oldIndex,
    candidateIndex,
    preparedLockPaths: primary.locks.map((lock) => lock.path),
  };
}
