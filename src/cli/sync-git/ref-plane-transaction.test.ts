import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ownershipProofContext, type GitSection } from "../../engine/index.js";
import { repoCtx } from "../../engine/git/shared.js";
import { checkoutJournalBinding } from "./follow-journal.js";
import { classifyCheckout } from "./follow-classify.js";
import { readLive } from "./follow-live.js";
import { effectiveRefs } from "./follow-ref-witness.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import { RefPlaneTransaction } from "./ref-plane-transaction.js";
import type { CheckoutClassification, FollowIntended, FollowOptions, StagedIncoming } from "./follow-types.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test",
  GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test",
  GIT_COMMITTER_EMAIL: "rbox-test@local",
};

let root: string;
let repo: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.toString().trim();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ref-plane-transaction-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(repo, "tracked.txt"), "one\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "base");
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function transactionOptions(overrides: Partial<FollowOptions> = {}) {
  const ctx = await repoCtx(repo);
  if (!ctx) throw new Error("test repository unavailable");
  const live = await readLive(ctx);
  if (!live?.currentRef || !live.currentTip) throw new Error("test repository metadata unavailable");
  const incoming: GitSection = {
    bundleSha: "bundle",
    bundleEncSha: "encrypted-bundle",
    bundleCipherSize: 1,
    head: `ref: ${live.currentRef}\n`,
    refs: { ...live.refs },
    indexSha: "index",
    indexEncSha: "encrypted-index",
    indexCipherSize: 1,
    refScope: "all",
    generatedAt: "",
  };
  const intended = {
    record: {}, expectedRepoGen: 0, relPath: "repo",
  } as FollowIntended;
  const opts = {
    workspaceRoot: root,
    relPath: "repo",
    ctx,
    incoming,
    store: {},
    kek: Buffer.alloc(32),
    oracle: {
      proveRepo: async () => ({ kind: "match" }),
      reproveRepo: async () => ({ kind: "match" }),
      receiptHash: () => "receipt",
    },
    binding: await checkoutJournalBinding("test-stream", "a".repeat(32), ctx),
    followEnabled: true,
    makeIntended: () => intended,
    ...overrides,
  } as FollowOptions;
  return {
    live,
    opts,
    transaction: new RefPlaneTransaction(
      opts,
      live,
      Object.values(live.refs),
      await ownershipProofContext(ctx),
      effectiveRefs(ctx, incoming),
      live.currentRef,
    ),
  };
}

const staged = (indexPath: string, indexProjection?: string): StagedIncoming => ({
  tmpDir: "",
  incomingNs: "",
  candidateIndex: indexPath,
  incomingIndexProjection: indexProjection,
  opState: [],
  opBytes: {},
  cleanupRefs: async () => {},
  cleanup: async () => {},
});

function branchProtocol(logicalBaseRefs: Record<string, string>): FollowerBranchProtocol {
  const lineageHash = "1".repeat(64);
  const repositoryIdentityHash = "2".repeat(64);
  return {
    binding: { lineageHash, repositoryIdentityHash },
    lineageHash,
    repositoryIdentityHash,
    logicalBaseRefs,
    attestations: { incomingKey: "test-incoming", entries: {} },
    artifacts: {},
    presentArtifacts: [],
    unmaterializedAbsenceRefs: new Set(),
    absenceWitnesses: {},
  };
}

test("publication burns prepared-old authority before its first await", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { transaction, opts } = await transactionOptions({
    beforeWorktreeOwnershipRead: async () => {
      enter();
      await held;
      throw new Error("injected publication failure");
    },
  });
  const input = staged(path.join(opts.ctx.gitDir, "index"));

  const first = transaction.publishIndependentRefs(input);
  await entered;
  await expect(transaction.publishIndependentRefs(input)).rejects.toThrow("publication already started");
  release();
  await expect(first).rejects.toThrow("injected publication failure");
  await expect(transaction.publishIndependentRefs(input)).rejects.toThrow("publication already started");
});

test("returned publication receipt cannot alter the retained checkout proof", async () => {
  let proofChanges: readonly { ref: string; before?: string; after?: string }[] | undefined;
  const { live, transaction, opts } = await transactionOptions({
    manualResolution: {
      snapshotId: "snapshot",
      waivedReasons: [],
      protectedOids: [],
      secondProof: async (changes) => {
        proofChanges = changes;
        return changes.length === 0;
      },
    },
  });
  const candidateIndex = path.join(root, "candidate-index");
  await fs.copyFile(path.join(opts.ctx.gitDir, "index"), candidateIndex);
  const input = staged(candidateIndex, live.indexProjection);
  const receipt = await transaction.publishIndependentRefs(input, live.indexProjection);
  (receipt.authoredRefChanges as Array<{ ref: string }>).push({ ref: "refs/heads/injected" });
  (receipt.checkoutWitnessDisposition.heldRefs as Set<string>).add("refs/heads/injected");

  const first: CheckoutClassification = {
    safe: true,
    breadcrumbMismatches: [],
    breadcrumbWaived: false,
    blockers: [],
  };
  const result = await transaction.commitCheckout({ staged: input, first, checkoutRoots: Object.values(live.refs), baseProjection: live.indexProjection });

  expect(proofChanges).toEqual([]);
  expect(result.status).toBe("committed");
});

test("checkout uses the ref candidate captured before the initial classifier await", async () => {
  const base = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "tracked.txt"), "candidate A\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "candidate A");
  const candidateA = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "tracked.txt"), "candidate B\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "candidate B");
  const candidateB = await git("rev-parse", "HEAD");
  await git("reset", "--hard", "-q", base);

  const candidateIndex = path.join(root, "candidate-index");
  await git("read-tree", candidateA);
  await fs.copyFile(path.join(repo, ".git", "index"), candidateIndex);
  await git("reset", "--hard", "-q", base);

  let classifierEntered!: () => void;
  let releaseClassifier!: () => void;
  const entered = new Promise<void>((resolve) => { classifierEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseClassifier = resolve; });
  const { live, opts } = await transactionOptions({
    oracle: {
      proveRepo: async () => {
        classifierEntered();
        await held;
        return { kind: "match" };
      },
      reproveRepo: async () => ({ kind: "match" }),
      receiptHash: () => "receipt",
    },
  });
  const currentRef = live.currentRef!;
  opts.incoming.refs[currentRef] = candidateA;
  opts.branchProtocol = branchProtocol({ [currentRef]: base });
  const roots = [base, candidateA, candidateB];
  const ownershipContext = await ownershipProofContext(opts.ctx);
  const transaction = new RefPlaneTransaction(
    opts,
    live,
    roots,
    ownershipContext,
    effectiveRefs(opts.ctx, opts.incoming),
    currentRef,
  );
  const input = staged(candidateIndex, live.indexProjection);
  const progress = await transaction.publishIndependentRefs(input, live.indexProjection);

  const classifying = classifyCheckout({
    opts,
    live,
    incomingProjection: live.indexProjection,
    baseProjection: live.indexProjection,
    roots,
    boundary: false,
    heldRefs: progress.heldRefs,
    ownershipContext,
  });
  await entered;
  opts.incoming.refs[currentRef] = candidateB;
  releaseClassifier();
  const first = await classifying;
  expect(first.safe).toBe(true);

  const result = await transaction.commitCheckout({ staged: input, first, checkoutRoots: roots, baseProjection: live.indexProjection });

  expect(result.status).toBe("committed");
  expect(await git("rev-parse", "HEAD")).toBe(candidateA);
});

test("makeIntended cannot remove a held ref from the checkout boundary proof", async () => {
  const base = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  const heldBefore = await git("commit-tree", tree, "-p", base, "-m", "held before");
  const heldAfter = await git("commit-tree", tree, "-p", heldBefore, "-m", "held after");
  const heldRef = "refs/heads/held";
  await git("update-ref", heldRef, heldBefore);
  const intended = { record: {}, expectedRepoGen: 0, relPath: "repo" } as FollowIntended;
  let callbackSawHeldRef = false;
  const { live, opts } = await transactionOptions({
    makeIntended: async (progress) => {
      callbackSawHeldRef = progress.heldRefs[heldRef] !== undefined;
      delete progress.heldRefs[heldRef];
      await git("update-ref", heldRef, heldAfter);
      return intended;
    },
  });
  delete opts.incoming.refs[heldRef];
  opts.branchProtocol = branchProtocol({ [live.currentRef!]: base, [heldRef]: heldBefore });
  const roots = [base];
  const transaction = new RefPlaneTransaction(
    opts,
    live,
    roots,
    await ownershipProofContext(opts.ctx),
    effectiveRefs(opts.ctx, opts.incoming),
    live.currentRef,
  );
  const candidateIndex = path.join(root, "candidate-index");
  await fs.copyFile(path.join(opts.ctx.gitDir, "index"), candidateIndex);
  const input = staged(candidateIndex, live.indexProjection);
  const progress = await transaction.publishIndependentRefs(input, live.indexProjection);
  expect(progress.heldRefs[heldRef]).toBe("local-commits");
  const first: CheckoutClassification = {
    safe: true,
    breadcrumbMismatches: [],
    breadcrumbWaived: false,
    blockers: [],
  };

  const result = await transaction.commitCheckout({ staged: input, first, checkoutRoots: roots, baseProjection: live.indexProjection });

  expect(callbackSawHeldRef).toBe(true);
  expect(result.status).toBe("defer");
  if (result.status === "defer") {
    expect(result.result.reason).toBe("local-commits");
    expect(result.result.detail).toBe(`held ref changed at ${heldRef}`);
  }
});
