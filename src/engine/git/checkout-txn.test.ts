import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  checkoutTransactionSupported,
  commitCheckout,
  resetCheckoutCapabilityProbeCacheForTests,
  type CheckoutPlan,
} from "./checkout-txn.js";
import { recoverJournal, writeCheckoutJournal, type CheckoutJournal, type CheckoutJournalBinding } from "./journal.js";
import { repoCtx, type RepoCtx } from "./shared.js";

const exec = promisify(execFile);
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
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

test("design 116 checkout transaction commits an attached branch and candidate index", async () => {
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid)), { capabilityProbe: supported, secondProof: proof });

  expect(result.status).toBe("committed");
  expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  expect(await git(repo, "write-tree")).toBe(await git(repo, "rev-parse", `${newOid}^{tree}`));
  expect(await fs.readFile(path.join(ctx.gitDir, "index"))).not.toEqual(oldIndex);
});

test("design 116 checkout transaction commits detached HEAD", async () => {
  await git(repo, "checkout", "-q", "--detach", oldOid);
  const detachedIndex = await fs.readFile(path.join(ctx.gitDir, "index"));
  const result = await commitCheckout(ctx, plan(await candidateFor(newOid), {
    refUpdates: [],
    head: { kind: "detached", newOid, oldOid },
  }), { capabilityProbe: supported, connectivityProof: proof, secondProof: proof });

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

test("ref-commit crash leaves pinned transient and journal recovery restores old coherence", async () => {
  const candidate = await candidateFor(newOid);
  const binding: CheckoutJournalBinding = {
    stream: "test-stream",
    stateNonce: "test-nonce",
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal: await fs.realpath(ctx.commonDir),
    worktreeId: "main",
  };
  const journal: CheckoutJournal<{ snapshot: string }> = {
    phase: "intent",
    incomingKey: "incoming",
    incomingSection: {
      bundleSha: "a".repeat(64),
      bundleEncSha: "b".repeat(64),
      bundleCipherSize: 1,
      head: "ref: refs/heads/main\n",
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
      head: "ref: refs/heads/main\n",
    },
    binding,
    createdFresh: false,
    intended: { snapshot: "new" },
  };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(ctx.gitDir, "index"), gitDir: ctx.gitDir });

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
