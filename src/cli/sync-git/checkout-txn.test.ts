import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CONNECTIVITY_PROOF_UNAVAILABLE,
  checkoutTransactionCapability,
  checkoutTransactionSupported,
  commitCheckout,
  defaultConnectivityProof,
  ownershipAwareGitBusy,
  resetCheckoutCapabilityProbeCacheForTests,
  type CheckoutPlan,
} from "./checkout-txn.js";
import { recoverJournal, writeCheckoutJournal, type CheckoutJournal, type CheckoutJournalBinding } from "./journal.js";
import { captureCommonDirIdentity, systemLockIdentity } from "../../engine/lockfile.js";
import { repoCtx, type RepoCtx } from "./git-state.js";
import { ShutdownMutationGate } from "../../engine/mutation-gate.js";

const exec = promisify(execFile);
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test",
  GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test",
  GIT_COMMITTER_EMAIL: "rbox-test@local",
  GIT_DIR: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  ...extra,
}) as NodeJS.ProcessEnv;
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: cleanEnv() }).then(({ stdout }) => stdout.toString().trim());

let root: string;
let repo: string;
let ctx: RepoCtx;
let oldOid: string;
let newOid: string;
let oldIndex: Buffer;

beforeEach(async () => {
  resetCheckoutCapabilityProbeCacheForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-checkout-txn-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-qb", "main");
  await git(repo, "config", "user.email", "checkout@example.invalid");
  await git(repo, "config", "user.name", "checkout test");
  await fs.writeFile(path.join(repo, "file.txt"), "old\n");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "-qm", "old");
  oldOid = await git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "file.txt"), "new\n");
  await git(repo, "commit", "-qam", "new");
  newOid = await git(repo, "rev-parse", "HEAD");
  await git(repo, "reset", "-q", "--hard", oldOid);
  const resolved = await repoCtx(repo);
  if (!resolved) throw new Error("fixture repo did not resolve");
  ctx = resolved;
  oldIndex = await fs.readFile(path.join(ctx.gitDir, "index"));
});

afterEach(async () => {
  resetCheckoutCapabilityProbeCacheForTests();
  // All subprocesses, including the deliberately blocked git-add writer, are
  // awaited before teardown so Windows and slow CI filesystems have no live users.
  await fs.rm(root, { recursive: true, force: true });
});

async function candidateFor(oid: string): Promise<string> {
  const candidate = path.join(root, `candidate-${oid}`);
  await fs.copyFile(path.join(ctx.gitDir, "index"), candidate);
  await exec("git", ["-C", repo, "read-tree", oid], { env: cleanEnv({ GIT_INDEX_FILE: candidate }) });
  return candidate;
}

function plan(candidateIndexPath: string, overrides: Partial<CheckoutPlan> = {}): CheckoutPlan {
  return {
    candidateIndexPath,
    refUpdates: [{ kind: "update", ref: "refs/heads/main", newOid, oldOid }],
    head: { kind: "symbolic", newTarget: "refs/heads/main", oldTarget: "refs/heads/main" },
    plannedGraphRoots: [newOid],
    opState: [],
    ...overrides,
  };
}

const supported = async () => true;
const proof = async () => true;
const connected = async () => "connected" as const;

async function checkoutJournal(expectedHead = "ref: refs/heads/main\n"): Promise<{ binding: CheckoutJournalBinding; journal: CheckoutJournal<{ snapshot: string }> }> {
  const binding: CheckoutJournalBinding = {
    stream: "test-stream",
    stateNonce: "test-nonce",
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
    commonDirIdentity: await captureCommonDirIdentity(await fs.realpath(ctx.commonDir)),
    worktreeId: "main",
  };
  const journal: CheckoutJournal<{ snapshot: string }> = {
    journalId: `1700000000000-${"b".repeat(16)}`,
    phase: "intent",
    incomingKey: "incoming",
    incomingSection: {
      bundleSha: "a".repeat(64),
      bundleEncSha: "b".repeat(64),
      bundleCipherSize: 1,
      head: expectedHead,
      refs: { "refs/heads/main": newOid },
      refScope: "all",
      generatedAt: new Date(0).toISOString(),
    },
    old: {
      currentRefName: "refs/heads/main",
      currentRefOid: oldOid,
      headContent: "ref: refs/heads/main\n",
      indexPresent: true,
      opState: {},
    },
    expectedNew: {
      opState: {},
      refs: { "refs/heads/main": newOid },
      head: expectedHead,
      branchInverses: [{
        ref: "refs/heads/main",
        beforeOid: oldOid,
        afterOid: newOid,
        lines: [`update refs/heads/main ${oldOid} ${newOid}`],
      }],
    },
    binding,
    createdFresh: false,
    intended: { snapshot: "new" },
  };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });
  return { binding, journal };
}

test("design 116 checkout transaction commits an attached branch and candidate index", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), { capabilityProbe: supported, secondProof: proof });

  expect(result.status).toBe("committed");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  expect(await git(repo, "write-tree")).toBe(await git(repo, "rev-parse", `${newOid}^{tree}`));
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).not.toEqual(oldIndex);
});

test("index-only checkout reserves unchanged symbolic HEAD with symref-verify", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    plannedGraphRoots: [oldOid, newOid],
  }), { capabilityProbe: supported, secondProof: proof });

  expect(result.status).toBe("committed");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await git(repo, "write-tree")).toBe(await git(repo, "rev-parse", `${newOid}^{tree}`));
});

test("design 278: the real connectivity proof defers with the typed connectivity-unproven code", async () => {
  // Every other case here injects `proof`, so this is the first exercise of the
  // real `defaultConnectivityProof`. A planned root the object database does not
  // have is exactly the field class: the proof fails before anything is
  // published, and the ONE site that runs it mints the code the held-skip
  // allowlist keys on.
  const absentRoot = `${"0".repeat(39)}1`;
  const headBefore = await git(repo, "rev-parse", "HEAD");
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    plannedGraphRoots: [newOid, absentRoot],
  }), { capabilityProbe: supported, secondProof: proof });

  expect(result).toEqual({
    status: "defer",
    reason: "planned graph connectivity proof failed",
    code: "connectivity-unproven",
  });
  // The exact-equality above also pins the absence of `journalIntact`: this
  // defer is pre-prepare, so no reservation exists for a journal to protect.
  // Nothing moved — no ref, no HEAD, and the live index is byte-identical.
  expect(await git(repo, "rev-parse", "HEAD")).toBe(headBefore);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
});

test("design 280 (a): the classifier separates a proof that could not run from one that ran", async () => {
  const roots = [await git(repo, "rev-parse", "HEAD")];
  // Node reports a completed child's nonzero exit as a NUMBER and every failure
  // to execute one as a string errno. That is the whole discriminator.
  const ranAndFailed = Object.assign(new Error("fatal: bad object"), { code: 128 });
  const couldNotSpawn = Object.assign(new Error("spawn git EACCES"), { code: "EACCES" });
  const overflowed = Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });

  expect(await defaultConnectivityProof(repo, roots, false)).toBe("connected");
  expect(await defaultConnectivityProof(repo, roots, false, async () => { throw ranAndFailed; })).toBe("unproven");
  expect(await defaultConnectivityProof(repo, roots, false, async () => { throw couldNotSpawn; })).toBe("unavailable");
  expect(await defaultConnectivityProof(repo, roots, false, async () => { throw overflowed; })).toBe("unavailable");
  // A child killed by a signal produced no verdict either, and lands on the
  // conservative side: not skip-eligible.
  expect(await defaultConnectivityProof(repo, roots, false, async () => { throw Object.assign(new Error("killed"), { signal: "SIGKILL" }); })).toBe("unavailable");
});

test("design 280 (a): an unavailable proof defers with the sentinel and mints no typed code", async () => {
  const headBefore = await git(repo, "rev-parse", "HEAD");
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    connectivityProof: async () => "unavailable" as const,
    secondProof: proof,
  });

  // Exact equality also pins the ABSENCE of `code`: nothing was proved here, so
  // no downstream plane may skip, latch, or offer a repair on this defer.
  expect(result).toEqual({ status: "defer", reason: CONNECTIVITY_PROOF_UNAVAILABLE });
  expect(await git(repo, "rev-parse", "HEAD")).toBe(headBefore);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
});

test("design 116 checkout transaction commits detached HEAD", async () => {
  await git(repo, "checkout", "-q", "--detach", oldOid);
  const detachedIndex = await fs.readFile(path.join(ctx.gitDir, "index"));
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    head: { kind: "detached", newOid, oldOid },
  }), { capabilityProbe: supported, connectivityProof: connected, secondProof: proof });

  expect(result.status).toBe("committed");
  await expect(git(repo, "symbolic-ref", "HEAD")).rejects.toThrow();
  expect(await git(repo, "rev-parse", "HEAD")).toBe(newOid);
  expect(await git(repo, "write-tree")).toBe(await git(repo, "rev-parse", `${newOid}^{tree}`));
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).not.toEqual(detachedIndex);
});

test("design 116 checkout transaction switches symbolic HEAD between branches", async () => {
  await git(repo, "branch", "feature", newOid);
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    head: { kind: "symbolic", newTarget: "refs/heads/feature", oldTarget: "refs/heads/main" },
  }), { capabilityProbe: supported, secondProof: proof });

  expect(result.status).toBe("committed");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  expect(await git(repo, "rev-parse", "HEAD")).toBe(newOid);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
});

test("branch switch holds its HEAD reservation across the old-referent transaction", async () => {
  await git(repo, "branch", "feature", newOid);
  let sawHeadReservation = false;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    postHeadRefUpdates: [{ kind: "update", ref: "refs/heads/main", newOid, oldOid }],
    head: { kind: "symbolic", newTarget: "refs/heads/feature", oldTarget: "refs/heads/main" },
  }), {
    capabilityProbe: supported,
    secondProof: proof,
    crashAt: (point) => {
      if (point === "after-ref-commit") sawHeadReservation = existsSync(path.join(ctx.gitDir, "HEAD.lock"));
    },
  });

  expect(result.status).toBe("committed");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  expect(sawHeadReservation).toBe(true);
});

test("expected-old mismatch aborts without refs, index, or lock residue", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [{ kind: "update", ref: "refs/heads/main", newOid, oldOid: newOid }],
  }), { capabilityProbe: supported, secondProof: proof });

  expect(result.status).toBe("defer");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect(await fs.stat(path.join(ctx.gitDir, "index.lock")).then(() => true, () => false)).toBe(false);
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
});

test("second-proof failure aborts the prepared transaction and owned index lock", async () => {
  let sawOwnedIndexLock = false;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    secondProof: async ({ ownedLocks, busy }) => {
      sawOwnedIndexLock = ownedLocks.some((token) => token.path === path.join(ctx.gitDir, "index.lock"));
      expect(await busy()).toBe(false);
      return false;
    },
  });

  expect(result.status).toBe("defer");
  expect(sawOwnedIndexLock).toBe(true);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect(await fs.stat(path.join(ctx.gitDir, "index.lock")).then(() => true, () => false)).toBe(false);
});

test("second-proof cleanup preserves a replacement index.lock inode", async () => {
  const { journal } = await checkoutJournal();
  const indexLock = path.join(ctx.gitDir, "index.lock");
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async () => {
      await fs.unlink(indexLock);
      await fs.writeFile(indexLock, "");
      return false;
    },
  });
  expect(result).toMatchObject({ status: "defer", journalIntact: true });
  expect(await fs.readFile(indexLock, "utf8")).toBe("");
});

test("design 130 reserves expected branch absence and its exact A/Z target through second proof", async () => {
  const absent = "refs/heads/absent";
  const marker = "refs/rbox-local/base-absent/v2/" + "a".repeat(64) + "/" + "b".repeat(64);
  await git(repo, "update-ref", marker, oldOid);
  const { journal } = await checkoutJournal();
  let sawReservations = false;
  const reserved = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refReservations: [
      { ref: absent, expectedOid: null },
      { ref: marker, expectedOid: oldOid },
    ],
  }), {
    capabilityProbe: supported,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async () => {
      sawReservations = existsSync(path.join(ctx.commonDir, `${absent}.lock`))
        && existsSync(path.join(ctx.commonDir, `${marker}.lock`));
      expect(await git(repo, "rev-parse", "--verify", "--quiet", absent).catch(() => "")).toBe("");
      expect(await git(repo, "rev-parse", marker)).toBe(oldOid);
      return true;
    },
  });
  expect(reserved.status).toBe("committed");
  expect(sawReservations).toBe(true);
  expect(existsSync(path.join(ctx.commonDir, `${absent}.lock`))).toBe(false);
  expect(existsSync(path.join(ctx.commonDir, `${marker}.lock`))).toBe(false);
});

test("design 130 expected-absence reservation rejects a next-cycle recreation", async () => {
  const absent = "refs/heads/absent";
  await git(repo, "update-ref", absent, oldOid);
  const { journal } = await checkoutJournal();
  let proofRan = false;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refReservations: [{ ref: absent, expectedOid: null }],
  }), {
    capabilityProbe: supported,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async () => { proofRan = true; return true; },
  });
  expect(result.status).toBe("defer");
  expect(proofRan).toBe(false);
  expect(await git(repo, "rev-parse", absent)).toBe(oldOid);
});

test("manual ref reservations fail closed without a durable journal", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refReservations: [{ ref: "refs/heads/absent", expectedOid: null }],
  }), { capabilityProbe: supported, secondProof: proof });

  expect(result).toEqual({ status: "defer", reason: "checkout ref reservations require a durable intent journal" });
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
});

test("design 126 atomically-owned ORIG_HEAD.lock fences the second proof and releases after op-state publication", async () => {
  const oldOrig = Buffer.from(`${oldOid}\n`);
  await fs.writeFile(path.join(ctx.gitDir, "ORIG_HEAD"), oldOrig);
  const { journal } = await checkoutJournal();
  let sawOwnedContent = false;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    origHeadLock: { journalId: journal.journalId, expectedOldBytes: oldOrig },
  }), {
    capabilityProbe: supported,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async ({ ownedLocks, busy }) => {
      const lock = path.join(ctx.gitDir, "ORIG_HEAD.lock");
      sawOwnedContent = (await fs.readFile(lock, "utf8")) === journal.journalId
        && ownedLocks.some((token) => token.path === lock);
      expect(await busy()).toBe(false);
      return true;
    },
  });

  expect(result.status).toBe("committed");
  expect(sawOwnedContent).toBe(true);
  await expect(fs.access(path.join(ctx.gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
  await expect(fs.access(path.join(ctx.gitDir, "ORIG_HEAD"))).rejects.toThrow();
});

test("design 126 exact breadcrumb equality aborts before a value nobody preserved can be adopted", async () => {
  const preserved = Buffer.from(`${oldOid}\n`);
  await fs.writeFile(path.join(ctx.gitDir, "ORIG_HEAD"), Buffer.from(`${newOid}\n`));
  const { journal } = await checkoutJournal();
  let secondProofCalled = false;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    extraTransactionLines: [`create refs/rbox-recovery/orig-head/primary/1-deadbeef ${oldOid}`],
    origHeadLock: { journalId: journal.journalId, expectedOldBytes: preserved },
  }), {
    capabilityProbe: supported,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async () => { secondProofCalled = true; return true; },
  });

  expect(result).toMatchObject({ status: "defer", reason: "ORIG_HEAD changed at checkout boundary" });
  expect(secondProofCalled).toBe(false);
  await expect(git(repo, "rev-parse", "--verify", "refs/rbox-recovery/orig-head/primary/1-deadbeef")).rejects.toThrow();
  await expect(fs.access(path.join(ctx.gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
});

test("ref-commit crash leaves the ref advanced and journal recovery restores old coherence", async () => {
  const candidate = await candidateFor(newOid);
  const { binding, journal } = await checkoutJournal();

  await expect(commitCheckout(ctx, plan(candidate), {
    capabilityProbe: supported,
    secondProof: proof,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    crashAt: (point) => {
      if (point === "after-ref-commit") throw new Error("simulated crash");
    },
  })).rejects.toThrow("simulated crash");

  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  const recovery = await recoverJournal(root, "repo", binding);
  expect(recovery.status).toBe("rolled-back");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("SIGKILL before prepared-lock observations preserves unattributed native locks", async () => {
  await git(repo, "tag", "packed", oldOid);
  await git(repo, "pack-refs", "--all");
  const { binding, journal } = await checkoutJournal();
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [
      { kind: "update", ref: "refs/heads/main", newOid, oldOid },
      { kind: "delete", ref: "refs/tags/packed", oldOid },
    ],
  }), {
    capabilityProbe: supported,
    secondProof: proof,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    afterPrepareChild: (pid, transaction) => {
      if (transaction === "primary") process.kill(pid, "SIGKILL");
    },
  });

  expect(result).toEqual({ status: "defer", reason: expect.any(String), journalIntact: true });
  expect(journal.expectedNew.preparedTransactions?.[0]?.locks.map((lock) => path.basename(lock.path))).toContain("packed-refs.lock");
  expect(await fs.access(path.join(ctx.gitDir, "HEAD.lock")).then(() => true, () => false)).toBe(true);
  expect(await fs.access(path.join(ctx.commonDir, "refs/heads/main.lock")).then(() => true, () => false)).toBe(true);
  expect((await recoverJournal(root, "repo", binding)).status).toBe("human-intervened");
  expect(await ownershipAwareGitBusy(ctx, [])).toBe(true);
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
});

test("graceful shutdown during native prepare aborts the child and leaves no lock residue", async () => {
  const gate = new ShutdownMutationGate();
  let preparedPid = 0;
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    secondProof: proof,
    mutationBoundary: gate,
    afterPrepareChild: async (pid, transaction) => {
      if (transaction !== "primary") return;
      preparedPid = pid;
      gate.close();
    },
  });

  expect(result).toMatchObject({ status: "defer", reason: "daemon shutdown began before mutation boundary" });
  expect(preparedPid).toBeGreaterThan(0);
  await gate.drain();
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
});

test("prepared-lock recovery removes owned locks but preserves a replaced foreign lock", async () => {
  const { binding, journal } = await checkoutJournal();
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    secondProof: proof,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    afterPrepareChild: (pid, transaction) => {
      if (transaction === "primary") process.kill(pid, "SIGKILL");
    },
  });
  expect(result.status).toBe("defer");

  const foreign = path.join(ctx.gitDir, "HEAD.lock");
  await fs.rm(foreign, { force: true });
  await fs.writeFile(foreign, "foreign lock\n");
  const recovery = await recoverJournal(root, "repo", binding);
  expect(recovery.status).toBe("human-intervened");
  expect(await fs.readFile(foreign, "utf8")).toBe("foreign lock\n");
  await expect(fs.access(path.join(ctx.commonDir, "refs/heads/main.lock"))).rejects.toThrow();
});

test("prepared native locks are preserved for a live boot/pid/start owner", async () => {
  const { binding, journal } = await checkoutJournal();
  const lockPath = path.join(ctx.commonDir, "refs", "heads", "main.lock");
  const owner = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 4242, startTime: "7" };
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: owner.pid,
    owner,
    prepareStarted: true,
    locks: [{ path: lockPath, expectedBytes: [Buffer.alloc(0).toString("base64")] }],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");

  const recovery = await recoverJournal(root, "repo", binding, {
    identity: {
      current: async () => owner,
      probe: async () => ({ status: "alive", startTime: owner.startTime }),
    },
  });
  expect(recovery).toMatchObject({ status: "defer", reason: expect.stringContaining("owner is live") });
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(true);
});

test("prepared native lock recovery preserves tokenless same-bytes lock after pid reuse", async () => {
  const { binding, journal } = await checkoutJournal();
  const lockPath = path.join(ctx.commonDir, "refs", "heads", "main.lock");
  const owner = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 4242, startTime: "7" };
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: owner.pid,
    owner,
    prepareStarted: true,
    locks: [{ path: lockPath, expectedBytes: [Buffer.alloc(0).toString("base64")] }],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");

  const recovery = await recoverJournal(root, "repo", binding, {
    identity: {
      current: async () => owner,
      probe: async () => ({ status: "alive", startTime: "8" }),
    },
  });
  expect(recovery.status).toBe("human-intervened");
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(true);
});

test("prepared-lock recovery preserves a same-bytes successor when the journal has an inode token", async () => {
  const { binding, journal } = await checkoutJournal();
  const lockPath = path.join(ctx.commonDir, "refs", "heads", "main.lock");
  const owner = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 4242, startTime: "7" };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");
  const original = await fs.lstat(lockPath, { bigint: true });
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: owner.pid,
    owner,
    prepareStarted: true,
    locks: [{
      path: lockPath,
      expectedBytes: [Buffer.alloc(0).toString("base64")],
      // A current-schema journal captures the original inode's birth time. After
      // the freed inode is reused by the successor, that birth time no longer
      // matches, so recovery must preserve the lock even when dev/ino/bytes do.
      token: { dev: Number(original.dev), ino: Number(original.ino), birthtimeNs: original.birthtimeNs.toString() },
    }],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });
  await fs.rm(lockPath, { force: true });
  await fs.writeFile(lockPath, "");

  const recovery = await recoverJournal(root, "repo", binding, {
    identity: { current: async () => owner, probe: async () => ({ status: "alive", startTime: "8" }) },
  });
  expect(recovery.status).toBe("human-intervened");
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(true);
});

test("malformed prepared-transaction ownership fails closed before lock cleanup", async () => {
  const { binding, journal } = await checkoutJournal();
  const lockPath = path.join(ctx.commonDir, "refs", "heads", "main.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: 42,
    owner: { hostId: "host", bootId: "boot", pid: 43, startTime: "1" },
    prepareStarted: true,
    locks: [{ path: lockPath, expectedBytes: [Buffer.alloc(0).toString("base64")] }],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

  expect(await recoverJournal(root, "repo", binding)).toMatchObject({ status: "defer", reason: "unreadable or corrupt journal" });
  expect(await fs.lstat(lockPath).then(() => true, () => false)).toBe(true);
});

test("malformed reserved-ref paths cannot authorize deletion outside the common dir", async () => {
  const { binding, journal } = await checkoutJournal();
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  const raw = `rbox-93 ${"a".repeat(32)} ${"b".repeat(32)} 42 1 ${"c".repeat(32)}\n`;
  const victim = path.join(outside, "victim.lock");
  await fs.writeFile(victim, raw);
  journal.expectedNew.reservedRefs = { "refs/../../outside/victim": null };
  journal.expectedNew.reservedLocks = { "refs/../../outside/victim": { marker: raw } };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

  expect(await recoverJournal(root, "repo", binding)).toMatchObject({ status: "defer", reason: "unreadable or corrupt journal" });
  expect(await fs.readFile(victim, "utf8")).toBe(raw);
});

test("binding mismatch never uses an untrusted journal gitDir as ORIG_HEAD authority", async () => {
  const { binding, journal } = await checkoutJournal();
  const outside = path.join(root, "outside-binding");
  await fs.mkdir(outside);
  const victim = path.join(outside, "ORIG_HEAD.lock");
  await fs.writeFile(victim, journal.journalId);
  journal.binding = { ...journal.binding, gitDirReal: outside };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

  expect((await recoverJournal(root, "repo", binding)).status).toBe("binding-mismatch");
  expect(await fs.readFile(victim, "utf8")).toBe(journal.journalId);
});

test("malformed branch inverse cannot mutate an unrelated branch after lock recovery", async () => {
  await git(repo, "branch", "other", oldOid);
  const { binding, journal } = await checkoutJournal();
  journal.expectedNew.branchInverses = [{
    ref: "refs/heads/main",
    beforeOid: oldOid,
    afterOid: newOid,
    lines: [`update refs/heads/main ${oldOid} ${newOid}`, `delete refs/heads/other ${oldOid}`],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

  expect(await recoverJournal(root, "repo", binding)).toMatchObject({ status: "defer", reason: "unreadable or corrupt journal" });
  expect(await git(repo, "rev-parse", "refs/heads/other")).toBe(oldOid);
});

test("prepared-lock recovery refuses a symlinked parent component", async () => {
  const { binding, journal } = await checkoutJournal();
  const outside = path.join(root, "outside");
  const linkedParent = path.join(ctx.commonDir, "linked-locks");
  await fs.mkdir(outside);
  await fs.symlink(outside, linkedParent);
  const lockPath = path.join(linkedParent, "main.lock");
  await fs.writeFile(path.join(outside, "main.lock"), "");
  const owner = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 42, startTime: "7" };
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: owner.pid,
    owner,
    prepareStarted: true,
    locks: [{ path: lockPath, expectedBytes: [Buffer.alloc(0).toString("base64")] }],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

  expect((await recoverJournal(root, "repo", binding, {
    identity: { current: async () => owner, probe: async () => ({ status: "dead" }) },
  })).status).toBe("human-intervened");
  expect(await fs.readFile(path.join(outside, "main.lock"), "utf8")).toBe("");
});

test("branch-switch HEAD gap arbitration preserves a human HEAD move", async () => {
  await git(repo, "branch", "feature", newOid);
  await git(repo, "branch", "human", oldOid);
  const { binding, journal } = await checkoutJournal("ref: refs/heads/feature\n");
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    postHeadRefUpdates: [{ kind: "update", ref: "refs/heads/main", newOid, oldOid }],
    head: { kind: "symbolic", newTarget: "refs/heads/feature", oldTarget: "refs/heads/main" },
  }), {
    capabilityProbe: supported,
    secondProof: proof,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    crashAt: (point) => {
      if (point === "after-head-commit") execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/human"], { env: cleanEnv() });
    },
  });

  expect(result).toEqual({ status: "defer", reason: "symbolic HEAD changed after branch-switch commit", journalIntact: true });
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/human");
  expect((await recoverJournal(root, "repo", binding)).status).toBe("human-intervened");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/human");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
});

test("the held index.lock rejects a concurrent git add before ref commit", async () => {
  await fs.writeFile(path.join(repo, "concurrent.txt"), "human work\n");
  let addError = "";
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    secondProof: async () => {
      try {
        await git(repo, "add", "concurrent.txt");
      } catch (error) {
        addError = String((error as { stderr?: Buffer | string }).stderr ?? error);
      }
      return true;
    },
  });

  expect(result.status).toBe("committed");
  expect(addError).toContain("index.lock");
  expect(await git(repo, "ls-files", "--error-unmatch", "concurrent.txt").then(() => true, () => false)).toBe(false);
});

// The journal names lock paths it alone may attribute and release. These four
// tests pin every state of that probe, because follow.ts clears the journal on
// any defer that does not report journalIntact.
const probeRef = "refs/heads/probe-dir/x";
const probeLockDir = () => path.join(ctx.commonDir, "refs", "heads", "probe-dir");
const probeLockPath = () => path.join(probeLockDir(), "x.lock");
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function deferWithProbeLock(duringSecondProof: () => Promise<void>) {
  const { journal } = await checkoutJournal();
  journal.expectedNew.reservedLocks = { [probeRef]: { marker: "probe-marker" } };
  return commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    connectivityProof: connected,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    // Runs after the ownership-aware busy probe, so the fixture below perturbs
    // only the post-abort journal-retention decision.
    secondProof: async () => {
      await duringSecondProof();
      return false;
    },
  });
}

test("a journal lock still on disk keeps the journal intact", async () => {
  const result = await deferWithProbeLock(async () => {
    await fs.mkdir(probeLockDir(), { recursive: true });
    await fs.writeFile(probeLockPath(), "");
  });

  expect(result).toEqual({ status: "defer", reason: "checkout boundary proof changed", journalIntact: true });
});

test("a provably absent journal lock releases the journal", async () => {
  const result = await deferWithProbeLock(async () => {});

  expect(result).toEqual({ status: "defer", reason: "checkout boundary proof changed" });
});

test.skipIf(runningAsRoot)("an unreadable journal lock path keeps the journal instead of reading as absent", async () => {
  const dir = probeLockDir();
  try {
    const result = await deferWithProbeLock(async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(probeLockPath(), "");
      await fs.chmod(dir, 0o000);
    });

    expect(result).toEqual({ status: "defer", reason: "checkout boundary proof changed", journalIntact: true });
  } finally {
    await fs.chmod(dir, 0o755).catch(() => {});
  }
});

test("an unreadable ORIG_HEAD.lock defers with the journal instead of escaping as a rejection", async () => {
  const { journal } = await checkoutJournal();
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: supported,
    connectivityProof: connected,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    secondProof: async () => {
      await fs.mkdir(path.join(ctx.gitDir, "ORIG_HEAD.lock"));
      return false;
    },
  });

  expect(result).toEqual({ status: "defer", reason: "checkout boundary proof changed", journalIntact: true });
});

test("capability result is cached once per git version", async () => {
  let calls = 0;
  const probe = async (version: string) => {
    expect(version).toStartWith("git version ");
    calls++;
    return true;
  };

  expect(await checkoutTransactionSupported(repo, probe)).toBe(true);
  expect(await checkoutTransactionSupported(repo, async () => {
    calls++;
    return false;
  })).toBe(true);
  expect(calls).toBe(1);
});

test("unsupported capability returns a typed result without mutation", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
    capabilityProbe: async () => false,
    secondProof: () => Promise.reject(new Error("must not run")),
  });

  expect(result).toEqual({ status: "unsupported", reason: expect.any(String) });
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect(await fs.stat(path.join(ctx.gitDir, "index.lock")).then(() => true, () => false)).toBe(false);
});

test("typed capability distinguishes missing/version/probe/unsupported states and sanitizes version", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  expect(await checkoutTransactionCapability(repo, undefined, async () => { throw missing; })).toEqual({ status: "git-missing" });
  expect(await checkoutTransactionCapability(repo, undefined, async () => ({ stdout: "\n\u001b[2J" }))).toEqual({ status: "version-unavailable" });

  resetCheckoutCapabilityProbeCacheForTests();
  expect(await checkoutTransactionCapability(repo, async () => { throw new Error("probe I/O"); }, async () => ({ stdout: "git version 9.1.0\nforged\u001b[2J" }))).toEqual({
    status: "probe-failed", version: "git version 9.1.0 forged [2J",
  });
  resetCheckoutCapabilityProbeCacheForTests();
  expect(await checkoutTransactionCapability(repo, async () => false, async () => ({ stdout: "git version 2.43.0" }))).toEqual({
    status: "unsupported", version: "git version 2.43.0",
  });
});

// The journalled owner must be exact, so both non-alive probes abort — but they
// are named apart, because a recurring "could not be read" is a platform probe
// defect (macOS 26 dropped the sysctl OID `darwinProcessStart` reads) while a
// dead child is an ordinary transaction failure.
for (const [status, reason] of [
  ["dead", "prepared Git child died before its intent was recorded"],
  ["unknown", "prepared Git child incarnation could not be read"],
] as const) {
  test(`a ${status} prepared child defers with its own reason and leaves no residue`, async () => {
    const { journal } = await checkoutJournal();
    const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), {
      capabilityProbe: supported,
      secondProof: proof,
      journal: { workspaceRoot: root, relPath: "repo", value: journal },
      identity: { current: systemLockIdentity.current, probe: async () => ({ status }) },
    });

    expect(result).toMatchObject({ status: "defer", reason });
    expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
    expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
    expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);
    expect(journal.expectedNew.preparedTransactions ?? []).toEqual([]);
  });
}

test("the post-HEAD transaction probes its own child and surfaces the same unreadable-incarnation reason", async () => {
  const { binding, journal } = await checkoutJournal("ref: refs/heads/side\n");
  await git(repo, "branch", "side", oldOid);
  let probes = 0;
  // The post-HEAD intent is recorded after the primary transaction has already
  // committed, so its failure leaves the journal to arbitrate rather than
  // deferring — but it must still be the probe's own reason that surfaces.
  await expect(commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    head: { kind: "symbolic", newTarget: "refs/heads/side", oldTarget: "refs/heads/main" },
    postHeadRefUpdates: [{ kind: "update", ref: "refs/heads/main", newOid, oldOid }],
  }), {
    capabilityProbe: supported,
    secondProof: proof,
    journal: { workspaceRoot: root, relPath: "repo", value: journal },
    // Only the post-HEAD child is unreadable; the primary transaction must
    // still record an exact owner and commit.
    identity: {
      current: systemLockIdentity.current,
      probe: async (pid) => (probes++ === 0 ? systemLockIdentity.probe(pid) : { status: "unknown" }),
    },
  })).rejects.toThrow("prepared Git child incarnation could not be read");

  expect(probes).toBe(2);
  expect(journal.expectedNew.preparedTransactions?.map((entry) => entry.id)).toEqual(["primary"]);
  expect(journal.expectedNew.preparedTransactions?.[0]?.completed).toBe(true);
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/side");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect((await fs.readdir(ctx.commonDir, { recursive: true })).filter((entry) => entry.toString().endsWith(".lock"))).toEqual([]);

  // Leaving HEAD switched is only acceptable because the journal can finish the
  // job. Prove that end to end rather than inferring it from lock cleanliness.
  const recovery = await recoverJournal(root, "repo", binding);
  expect(recovery.status).toBe("rolled-back");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).toEqual(oldIndex);
  expect(await fs.readdir(path.join(root, ".rbox", "state", "git-journal"))).toEqual([]);
});
