import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ownershipProofContext, type GitSection } from "../../engine/index.js";
import { repoCtx } from "../../engine/git/shared.js";
import { checkoutJournalBinding } from "./follow-journal.js";
import { readLive } from "./follow-live.js";
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
    transaction: new RefPlaneTransaction(opts, live, Object.values(live.refs), await ownershipProofContext(ctx)),
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
