import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApplyGitResult, GitSection, RepoCtx } from "../../engine/index.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import {
  CleanMaterializationIdentityMismatch,
  classifyCleanApplyDeferral,
  executeCleanMaterialization,
  planCleanMaterialization,
  type BoundCleanMaterializationPlan,
  type CleanMaterializationEffects,
  type CleanMaterializationIdentity,
  type CleanMaterializationInput,
} from "./clean-materialization.js";

const REL = "repo";
let ROOT = "";

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-clean-mat-"));
  await fs.mkdir(path.join(ROOT, REL), { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

const INCOMING_KEY = "incoming-key-1";
const LINEAGE = "a".repeat(64);
const REPO_IDENTITY = "b".repeat(64);
const EPISODE = "c".repeat(32);

function identity(overrides: Partial<CleanMaterializationIdentity> = {}): CleanMaterializationIdentity {
  return { root: ROOT, relPath: REL, repoDir: path.join(ROOT, REL), incomingKey: INCOMING_KEY, ...overrides };
}

function section(head: string, refs: Record<string, string> = { "refs/heads/main": head }): GitSection {
  return { head, refs, refScope: "all" } as unknown as GitSection;
}

const INCOMING = section("a".repeat(40));
const WITH_CONFIG = { ...section("a".repeat(40)), config: { "core.bare": "false" } } as unknown as GitSection;

function input(overrides: Partial<CleanMaterializationInput> = {}): CleanMaterializationInput {
  return {
    identity: identity(),
    incoming: INCOMING,
    ignoredTarget: false,
    containmentRefusal: undefined,
    cleanMaterialize: false,
    dotGit: undefined,
    stateNonce: "0".repeat(32),
    localRefs: async () => ({}),
    degradedMutex: false,
    chainTimings: undefined,
    warningSink: undefined,
    config: { phase: "not-due", applied: true },
    inheritedConfigBase: undefined,
    baseComposition: { prior: {}, candidate: { base: INCOMING } },
    ...overrides,
  };
}

async function bound(overrides: Partial<CleanMaterializationInput> = {}): Promise<BoundCleanMaterializationPlan> {
  const plan = await planCleanMaterialization(input(overrides));
  if (plan.status !== "bound") throw new Error(`expected a bound plan, got ${plan.status}`);
  return plan;
}

const PROTOCOL: FollowerBranchProtocol = {
  binding: {} as FollowerBranchProtocol["binding"],
  lineageHash: LINEAGE,
  repositoryIdentityHash: REPO_IDENTITY,
  logicalBaseRefs: {},
  attestations: {} as FollowerBranchProtocol["attestations"],
  artifacts: {},
  presentArtifacts: [],
  unmaterializedAbsenceRefs: new Set<string>(),
  absenceWitnesses: {},
};

interface Harness {
  effects: CleanMaterializationEffects;
  calls: string[];
}

function harness(options: {
  identity?: CleanMaterializationIdentity;
  result?: ApplyGitResult;
  config?: () => Promise<boolean>;
  protocol?: () => Promise<FollowerBranchProtocol>;
  repoKind?: RepoCtx["kind"];
} = {}): Harness {
  const calls: string[] = [];
  const effects: CleanMaterializationEffects = {
    identity: options.identity ?? identity(),
    runMutation: async (fn) => {
      calls.push("runMutation");
      return fn();
    },
    applyState: async () => {
      calls.push("applyState");
      return options.result ?? { applied: true };
    },
    branchProtocol: async () => {
      calls.push("branchProtocol");
      return options.protocol ? options.protocol() : PROTOCOL;
    },
    repoContext: async () => {
      calls.push("repoContext");
      return { kind: options.repoKind ?? "dir" } as RepoCtx;
    },
    applyConfig: async () => {
      calls.push("applyConfig");
      return options.config ? options.config() : true;
    },
    log: () => calls.push("log"),
  };
  return { effects, calls };
}

describe("planCleanMaterialization refusals", () => {
  test("an ignored target refuses before any effect and names the materialization", async () => {
    // The ignore refusal also outranks a containment refusal.
    const plan = await planCleanMaterialization(input({ ignoredTarget: true, containmentRefusal: "escapes root" }));
    expect(plan).toEqual({
      status: "refused",
      identity: identity(),
      reason: "target is inside an ignored subtree — refusing to materialize",
      deferralReason: "ignored-target",
    });
  });

  test("a containment refusal carries the observed message under the containment lane", async () => {
    const plan = await planCleanMaterialization(input({ containmentRefusal: "git apply target escapes workspace root: /x" }));
    expect(plan).toEqual({
      status: "refused",
      identity: identity(),
      reason: "git apply target escapes workspace root: /x",
      deferralReason: "containment",
    });
  });

  test("incoming branches without a capable state lineage refuse before any mutation", async () => {
    const plan = await planCleanMaterialization(input({ stateNonce: undefined }));
    expect(plan).toEqual({
      status: "refused",
      identity: identity(),
      reason: "branch materialization requires a durable capable state lineage",
      deferralReason: "artifact",
    });
  });

  test("an incapable lineage still binds when neither side carries a branch", async () => {
    const plan = await planCleanMaterialization(input({
      stateNonce: "not-a-nonce",
      incoming: section("b".repeat(40), { "refs/tags/v1": "b".repeat(40) }),
    }));
    expect(plan.status).toBe("bound");
    if (plan.status !== "bound") return;
    expect(plan.capableLineage).toBe(false);
  });

  test("local branches are read only for a wiping incapable-lineage plan", async () => {
    let reads = 0;
    const localRefs = async () => {
      reads += 1;
      return { "refs/heads/main": "c".repeat(40) };
    };
    await planCleanMaterialization(input({ localRefs }));
    expect(reads).toBe(0);

    const tagsOnly = section("b".repeat(40), { "refs/tags/v1": "b".repeat(40) });
    const refused = await planCleanMaterialization(input({
      stateNonce: undefined,
      incoming: tagsOnly,
      cleanMaterialize: true,
      dotGit: { isDirectory: true },
      localRefs,
    }));
    expect(reads).toBe(1);
    expect(refused.status).toBe("refused");
    if (refused.status !== "refused") return;
    expect(refused.deferralReason).toBe("artifact");

    const noDotGit = await planCleanMaterialization(input({
      stateNonce: undefined,
      incoming: tagsOnly,
      cleanMaterialize: true,
      dotGit: undefined,
      localRefs,
    }));
    expect(reads).toBe(1);
    expect(noDotGit.status).toBe("bound");
  });
});

describe("planCleanMaterialization quarantine/wipe authority", () => {
  test("recreate-at-a-removed-path over a dir leftover authorizes the quarantine wipe", async () => {
    const plan = await bound({ cleanMaterialize: true, dotGit: { isDirectory: true } });
    expect(plan.wipeLeftover).toBe(true);
    expect(plan.stateOptions.beforeMutateWipesRefs).toBe(true);
    expect(plan.stateOptions.cleanWipeRefs).toBe(true);
  });

  test("a pointer leftover is never ref-wiped — the shared store is not ours to wipe", async () => {
    const plan = await bound({ cleanMaterialize: true, dotGit: { isDirectory: false } });
    expect(plan.wipeLeftover).toBe(false);
    expect(plan.stateOptions.beforeMutateWipesRefs).toBeUndefined();
    expect(plan.stateOptions.cleanWipeRefs).toBeUndefined();
  });

  test("an ordinary fresh target carries no wipe authority, and a degraded mutex keeps the legacy disposition", async () => {
    const plan = await bound({ cleanMaterialize: false, dotGit: { isDirectory: true } });
    expect(plan.wipeLeftover).toBe(false);
    expect(plan.stateOptions.beforeMutateWipesRefs).toBeUndefined();
    expect((await bound({ degradedMutex: true })).stateOptions.legacyWholeSectionOwnership).toBe(true);
    expect((await bound()).stateOptions.legacyWholeSectionOwnership).toBeUndefined();
  });
});

describe("executeCleanMaterialization identity binding", () => {
  // Ports are built inside the test: ROOT only exists after beforeAll, so a
  // module-level port would mismatch on root and mask the other identity axes.
  for (const [label, port] of [
    ["another repository", () => identity({ relPath: "other", repoDir: "/elsewhere/other" })],
    ["a relinked repository directory", () => identity({ repoDir: "/elsewhere/repo" })],
    ["another workspace root", () => identity({ root: "/elsewhere" })],
    ["another incoming section", () => identity({ incomingKey: "incoming-key-2" })],
  ] as const) {
    test(`a plan bound to ${label} is refused before any effect runs`, async () => {
      const plan = await bound();
      const { effects, calls } = harness({ identity: port() });
      await expect(executeCleanMaterialization(plan, effects)).rejects.toBeInstanceOf(CleanMaterializationIdentityMismatch);
      expect(calls).toEqual([]);
    });
  }
});

describe("executeCleanMaterialization refusals from the engine", () => {
  test("a missing bundle defers under the artifact lane and produces no transition", async () => {
    const plan = await bound();
    const { effects } = harness({ result: { applied: false, reason: "git artifact fetch/decrypt failed (no mutation): missing blob" } });
    const receipt = await executeCleanMaterialization(plan, effects);
    expect(receipt).toEqual({
      identity: identity(),
      status: "deferred",
      reason: "git artifact fetch/decrypt failed (no mutation): missing blob",
      deferralReason: "artifact",
      configLaneDeferred: false,
    });
  });

  test("a refusal with no reason keeps the generic apply-deferred wording", async () => {
    const plan = await bound();
    const { effects } = harness({ result: { applied: false } });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "deferred") throw new Error("expected a deferred receipt");
    expect(receipt.reason).toBe("apply deferred");
    expect(receipt.deferralReason).toBe("other");
  });

  test("a config-named refusal also marks the config lane", async () => {
    const plan = await bound();
    const { effects } = harness({ result: { applied: false, reason: "config transaction failed" } });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "deferred") throw new Error("expected a deferred receipt");
    expect(receipt.configLaneDeferred).toBe(true);
    expect(receipt.deferralReason).toBe("config");
  });

  test("the deferral classifier keeps its exact precedence order", () => {
    expect(classifyCleanApplyDeferral("ownership-deferred: branch main")).toBe("worktree-ownership");
    expect(classifyCleanApplyDeferral("worktree-ownership: branch main checked out")).toBe("worktree-ownership");
    expect(classifyCleanApplyDeferral("repo busy")).toBe("git-busy");
    expect(classifyCleanApplyDeferral("config transaction failed")).toBe("config");
    expect(classifyCleanApplyDeferral("quarantine bundle failed; aborting")).toBe("other");
    expect(classifyCleanApplyDeferral("git artifact fetch/decrypt failed")).toBe("artifact");
    expect(classifyCleanApplyDeferral("invalid git section: bad head")).toBe("unsupported");
    expect(classifyCleanApplyDeferral("something else entirely")).toBe("other");
    // A busy repo whose reason also names an artifact or the config lane stays git-busy.
    expect(classifyCleanApplyDeferral("git busy: bundle import blocked")).toBe("git-busy");
    expect(classifyCleanApplyDeferral("repo busy: config transaction blocked")).toBe("git-busy");
    // A quarantine failure never reads as an artifact fault, even when its
    // message also names the bundle it failed to write.
    expect(classifyCleanApplyDeferral("quarantine bundle failed; aborting: EIO")).toBe("other");
  });
});

describe("executeCleanMaterialization receipts", () => {
  test("a sibling-worktree hold pends the section and never touches the applied BASE slot", async () => {
    const plan = await bound();
    const { effects } = harness({
      result: {
        applied: true,
        heldRefs: { "refs/heads/main": "wt-a" },
        filteredRefs: ["refs/heads/skip"],
      },
    });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(receipt.physical.heldRefs).toEqual([["refs/heads/main", "wt-a"]]);
    expect(receipt.transition.appliedSection).toBe("retain");
    expect(receipt.transition.pending).toBe(INCOMING);
    expect(receipt.transition.deferral).toBe("worktree-ownership");
    expect(receipt.transition.attempt).toBe("retain");
    expect(receipt.transition.proof).toBeUndefined();
    expect(receipt.transition.removedMemory).toBeNull();
    expect(receipt.transition.indexProjection).toBeNull();
    expect(receipt.announcement).toBe(`git-sync applied ${REL} (held refs: refs/heads/main=wt-a)`);
  });

  test("held refs are reported in sorted order and carry direct partial evidence", async () => {
    const incoming = section("d".repeat(40), {
      "refs/heads/zeta": "d".repeat(40),
      "refs/heads/alpha": "e".repeat(40),
      "refs/heads/mid": "e".repeat(40),
      "refs/heads/filtered": "f".repeat(40),
    });
    const plan = await bound({ incoming, baseComposition: { prior: {}, candidate: { base: incoming } } });
    const { effects } = harness({
      result: {
        applied: true,
        heldRefs: { "refs/heads/alpha": "wt-a", "refs/heads/mid": "wt-m", "refs/heads/zeta": "wt-z" },
        filteredRefs: ["refs/heads/filtered"],
      },
    });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(receipt.physical.heldRefs.map(([ref]) => ref)).toEqual(["refs/heads/alpha", "refs/heads/mid", "refs/heads/zeta"]);
    expect(receipt.transition.partial).toEqual({
      incomingKey: INCOMING_KEY,
      checkoutPending: false,
      appliedRefs: {},
      heldRefs: { "refs/heads/alpha": "ownership", "refs/heads/mid": "ownership", "refs/heads/zeta": "ownership" },
      configApplied: true,
    });
    expect(receipt.announcement).toBe(
      `git-sync applied ${REL} (held refs: refs/heads/alpha=wt-a refs/heads/mid=wt-m refs/heads/zeta=wt-z)`,
    );
  });

  test("no owner and no typed transitions advances the applied BASE directly", async () => {
    const plan = await bound();
    const { effects, calls } = harness();
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(receipt.transition.appliedSection).toBe(INCOMING);
    expect(receipt.transition.pending).toBeNull();
    expect(receipt.transition.partial).toBeNull();
    expect(receipt.transition.deferral).toBe("clear");
    expect(receipt.transition.attempt).toBe("clear");
    expect(receipt.announcement).toBe(`git-sync applied ${REL}`);
    expect(calls).toEqual(["runMutation", "applyState"]);
    expect(receipt.physical.refsWiped).toBe(false);
  });

  test("a filtered-ref announcement is emitted only when nothing is held", async () => {
    const plan = await bound();
    const { effects } = harness({ result: { applied: true, filteredRefs: ["refs/heads/x", "refs/heads/y"] } });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(receipt.announcement).toBe(`git-sync applied ${REL} (filtered refs: refs/heads/x refs/heads/y)`);
  });

  test("typed transitions compose one BASE transition and one proof from the same receipt", async () => {
    const nextOid = "1".repeat(40);
    const incoming = section(nextOid, { "refs/heads/main": nextOid });
    const witness = {
      kind: "present" as const,
      ref: "refs/heads/main",
      priorOid: null,
      nextOid,
      lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_IDENTITY,
      artifactRef: "refs/heads/main",
      artifactOid: "2".repeat(40),
      episode: EPISODE,
    };
    const plan = await bound({ incoming, baseComposition: { prior: {}, candidate: { base: incoming } } });
    const { effects } = harness({
      result: {
        applied: true,
        branchTransitions: {
          "refs/heads/main": {
            ref: "refs/heads/main",
            beforeOid: null,
            afterOid: nextOid,
            inverseLines: ["delete refs/heads/main"],
            witness,
            lockedProof: {
              liveOid: nextOid,
              witness,
              reflogEpisode: EPISODE,
              artifactsClear: true,
              ownershipStable: true,
              reflogStable: true,
              currentRef: true,
              siblingOwned: false,
            },
          },
        },
      },
    });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    // Physical Git facts and the intended logical transition come from ONE receipt.
    expect(receipt.physical.branchTransitions["refs/heads/main"]?.afterOid).toBe(nextOid);
    expect(receipt.transition.proof?.authority).toMatchObject({
      kind: "pull-ref-transaction",
      lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_IDENTITY,
      incomingKey: INCOMING_KEY,
    });
    expect(receipt.transition.proof?.lockedProof).toMatchObject({
      repoKind: "dir",
      effectiveRefScope: "all",
      checkoutComplete: true,
      incomingKey: INCOMING_KEY,
    });
    expect(receipt.transition.appliedSection).toMatchObject({ refs: { "refs/heads/main": nextOid } });
    expect(receipt.transition.branchOrigins?.["refs/heads/main"]).toMatchObject({ v: 1, oid: nextOid, lineageHash: LINEAGE });
    expect(receipt.transition.deferral).toBe("clear");
    expect(receipt.transition.attempt).toBe("clear");
  });

  test("a wiping plan records the effective all-scope in the locked proof", async () => {
    const nextOid = "3".repeat(40);
    const incoming = { head: nextOid, refs: { "refs/tags/v1": nextOid }, refScope: "scoped" } as unknown as GitSection;
    const plan = await bound({
      incoming,
      cleanMaterialize: true,
      dotGit: { isDirectory: true },
      baseComposition: { prior: {}, candidate: { base: incoming } },
    });
    const { effects } = harness({
      result: {
        applied: true,
        safeRefTransitions: {
          "refs/tags/v1": { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: null, afterOid: nextOid },
        },
      },
    });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(receipt.physical.refsWiped).toBe(true);
    expect(receipt.transition.proof?.lockedProof.effectiveRefScope).toBe("all");
  });

  test("a failed config apply records an unapplied partial without blocking the Git transition", async () => {
    const plan = await bound({
      incoming: WITH_CONFIG,
      config: { phase: "apply-after-materialization" },
      baseComposition: { prior: {}, candidate: { base: WITH_CONFIG } },
    });
    const { effects, calls } = harness({ config: async () => false });
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(calls).toEqual(["runMutation", "applyState", "applyConfig"]);
    expect(receipt.physical.configApplied).toBe(false);
    expect(receipt.transition.appliedSection).toBe(WITH_CONFIG);
    expect(receipt.transition.partial).toEqual({
      incomingKey: INCOMING_KEY,
      checkoutPending: false,
      appliedRefs: {},
      heldRefs: {},
      configApplied: false,
    });
  });

  // The due/ownership/target predicate belongs to ApplyReceivedGitConfig; this
  // transition only carries the settled phase through, so both settled outcomes
  // must reach the receipt without ever touching the config lane.
  test("a settled applied phase never runs the lane and leaves no unapplied partial", async () => {
    const plan = await bound({ config: { phase: "not-due", applied: true } });
    const { effects, calls } = harness();
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(calls).toEqual(["runMutation", "applyState"]);
    expect(receipt.physical.configApplied).toBe(true);
    expect(receipt.transition.partial).toBeNull();
  });

  test("a settled unapplied phase never runs the lane but still records the partial", async () => {
    const plan = await bound({ config: { phase: "not-due", applied: false } });
    const { effects, calls } = harness();
    const receipt = await executeCleanMaterialization(plan, effects);
    if (receipt.status !== "materialized") throw new Error("expected a materialized receipt");
    expect(calls).toEqual(["runMutation", "applyState"]);
    expect(receipt.physical.configApplied).toBe(false);
    expect(receipt.transition.partial).toEqual({
      incomingKey: INCOMING_KEY,
      checkoutPending: false,
      appliedRefs: {},
      heldRefs: {},
      configApplied: false,
    });
  });
});
