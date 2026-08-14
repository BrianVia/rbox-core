import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import type { ApplyGitResult } from "./git-state-apply.js";
import type { RepoCtx } from "./git-state.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import { materializeCleanGit } from "./clean-materialization.js";

const REL = "repo";
const INCOMING_KEY = "incoming-key-1";
const LINEAGE = "a".repeat(64);
const REPO_IDENTITY = "b".repeat(64);
const EPISODE = "c".repeat(32);
let ROOT = "";

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-clean-mat-"));
  await fs.mkdir(path.join(ROOT, REL), { recursive: true });
});
afterAll(async () => fs.rm(ROOT, { recursive: true, force: true }));

function section(head: string, refs: Record<string, string> = { "refs/heads/main": head }): GitSection {
  return { head, refs, refScope: "all" } as unknown as GitSection;
}

const INCOMING = section("a".repeat(40));
const WITH_CONFIG = { ...INCOMING, config: { "core.bare": ["false"] } } as GitSection;
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

type CleanInput = Parameters<typeof materializeCleanGit>[0];
type CleanStateOptions = Parameters<CleanInput["applyState"]>[0];

function baseInput(overrides: Partial<CleanInput> = {}): CleanInput {
  return {
    root: ROOT,
    relPath: REL,
    repoDir: path.join(ROOT, REL),
    incomingKey: INCOMING_KEY,
    incoming: INCOMING,
    ignoredTarget: false,
    cleanMaterialize: false,
    dotGit: undefined,
    stateNonce: "0".repeat(32),
    localRefs: async () => ({}),
    degradedMutex: false,
    chainTimings: undefined,
    warningSink: undefined,
    applyConfig: undefined,
    inheritedConfigBase: undefined,
    baseComposition: { prior: {}, candidate: { base: INCOMING } },
    runMutation: async (fn) => fn(),
    applyState: async () => ({ applied: true }),
    branchProtocol: async () => PROTOCOL,
    repoContext: async () => ({ kind: "dir" } as RepoCtx),
    log: () => {},
    ...overrides,
  };
}

async function run(
  overrides: Partial<CleanInput> = {},
  options: {
    result?: ApplyGitResult;
    config?: () => Promise<boolean>;
    protocol?: () => Promise<FollowerBranchProtocol>;
    repoKind?: RepoCtx["kind"];
  } = {},
) {
  const calls: string[] = [];
  let stateOptions: CleanStateOptions | undefined;
  const outcome = await materializeCleanGit(baseInput({
    ...overrides,
    runMutation: async (fn) => {
      calls.push("runMutation");
      return fn();
    },
    applyState: async (next) => {
      calls.push("applyState");
      stateOptions = next;
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
    applyConfig: options.config
      ? async () => {
          calls.push("applyConfig");
          return options.config!();
        }
      : overrides.applyConfig,
    log: () => calls.push("log"),
  }));
  return { outcome, calls, stateOptions };
}

describe("materializeCleanGit admission", () => {
  test("ignored targets refuse before containment or any effect", async () => {
    const { outcome, calls } = await run({
      ignoredTarget: true,
      relPath: "../escape",
      repoDir: path.join(ROOT, "..", "escape"),
    });
    expect(outcome).toEqual({
      status: "deferred",
      reason: "target is inside an ignored subtree — refusing to materialize",
      deferralReason: "ignored-target",
      configLaneDeferred: false,
    });
    expect(calls).toEqual([]);
  });

  test("escaping targets refuse before mutation", async () => {
    const { outcome, calls } = await run({
      relPath: "../escape",
      repoDir: path.join(ROOT, "..", "escape"),
    });
    expect(outcome.status).toBe("deferred");
    if (outcome.status !== "deferred") return;
    expect(outcome.deferralReason).toBe("containment");
    expect(outcome.reason).toContain("escapes workspace root");
    expect(calls).toEqual([]);
  });

  test("incoming branches require a capable state lineage before mutation", async () => {
    const { outcome, calls } = await run({ stateNonce: undefined });
    expect(outcome).toEqual({
      status: "deferred",
      reason: "branch materialization requires a durable capable state lineage",
      deferralReason: "artifact",
      configLaneDeferred: false,
    });
    expect(calls).toEqual([]);
  });

  test("incapable tags-only materialization retains the legacy untyped path", async () => {
    const tagsOnly = section("b".repeat(40), { "refs/tags/v1": "b".repeat(40) });
    const { outcome, calls, stateOptions } = await run({
      stateNonce: "not-a-nonce",
      incoming: tagsOnly,
      baseComposition: { prior: {}, candidate: { base: tagsOnly } },
    });
    expect(outcome.status).toBe("materialized");
    expect(calls).toEqual(["runMutation", "applyState"]);
    expect(stateOptions?.branchTransitions).toBeUndefined();
  });

  test("local refs remain a lazy incapable-lineage observation", async () => {
    let reads = 0;
    const localRefs = async () => {
      reads += 1;
      return { "refs/heads/main": "c".repeat(40) };
    };
    await run({ localRefs });
    expect(reads).toBe(0);

    const tagsOnly = section("b".repeat(40), { "refs/tags/v1": "b".repeat(40) });
    const refused = await run({
      stateNonce: undefined,
      incoming: tagsOnly,
      cleanMaterialize: true,
      dotGit: { isDirectory: true },
      localRefs,
    });
    expect(reads).toBe(1);
    expect(refused.outcome.status).toBe("deferred");

    const fresh = await run({
      stateNonce: undefined,
      incoming: tagsOnly,
      cleanMaterialize: true,
      dotGit: undefined,
      localRefs,
      baseComposition: { prior: {}, candidate: { base: tagsOnly } },
    });
    expect(reads).toBe(1);
    expect(fresh.outcome.status).toBe("materialized");
  });
});

describe("materializeCleanGit wipe authority", () => {
  test("only a removed-path directory leftover authorizes ref wipe", async () => {
    const dir = await run({ cleanMaterialize: true, dotGit: { isDirectory: true } });
    expect(dir.stateOptions).toMatchObject({ beforeMutateWipesRefs: true, cleanWipeRefs: true });

    const pointer = await run({ cleanMaterialize: true, dotGit: { isDirectory: false } });
    expect(pointer.stateOptions?.beforeMutateWipesRefs).toBeUndefined();
    expect(pointer.stateOptions?.cleanWipeRefs).toBeUndefined();

    const ordinary = await run({ cleanMaterialize: false, dotGit: { isDirectory: true } });
    expect(ordinary.stateOptions?.beforeMutateWipesRefs).toBeUndefined();
  });

  test("degraded mutex keeps legacy whole-section ownership", async () => {
    expect((await run({ degradedMutex: true })).stateOptions?.legacyWholeSectionOwnership).toBe(true);
    expect((await run()).stateOptions?.legacyWholeSectionOwnership).toBeUndefined();
  });
});

describe("materializeCleanGit engine refusals", () => {
  test("reason classification preserves precedence", async () => {
    const rows = [
      ["ownership-deferred: branch main", "worktree-ownership"],
      ["worktree-ownership: branch main checked out", "worktree-ownership"],
      ["repo busy", "git-busy"],
      ["config transaction failed", "config"],
      ["quarantine bundle failed; aborting", "other"],
      ["git artifact fetch/decrypt failed", "artifact"],
      ["invalid git section: bad head", "unsupported"],
      ["something else entirely", "other"],
      ["git busy: bundle import blocked", "git-busy"],
      ["repo busy: config transaction blocked", "git-busy"],
    ] as const;
    for (const [reason, expected] of rows) {
      const { outcome } = await run({}, { result: { applied: false, reason } });
      expect(outcome).toMatchObject({ status: "deferred", reason, deferralReason: expected });
    }
  });

  test("missing reasons keep generic wording", async () => {
    expect((await run({}, { result: { applied: false } })).outcome).toMatchObject({
      status: "deferred",
      reason: "apply deferred",
      deferralReason: "other",
    });
  });

  test("config-named engine refusal marks the config lane", async () => {
    expect((await run({}, { result: { applied: false, reason: "config transaction failed" } })).outcome)
      .toMatchObject({ status: "deferred", configLaneDeferred: true });
  });
});

describe("materializeCleanGit transitions", () => {
  test("sibling-worktree holds pend the section and retain BASE", async () => {
    const { outcome } = await run({}, {
      result: {
        applied: true,
        heldRefs: { "refs/heads/main": "wt-a" },
        filteredRefs: ["refs/heads/skip"],
      },
    });
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(outcome.transition).toMatchObject({
      appliedSection: "retain",
      pending: INCOMING,
      deferral: "worktree-ownership",
      attempt: "retain",
      removedMemory: null,
      indexProjection: null,
    });
    expect(outcome.announcement).toBe(`git-sync applied ${REL} (held refs: refs/heads/main=wt-a)`);
  });

  test("held refs are sorted and direct partial evidence excludes filtered refs", async () => {
    const incoming = section("d".repeat(40), {
      "refs/heads/zeta": "d".repeat(40),
      "refs/heads/alpha": "e".repeat(40),
      "refs/heads/mid": "e".repeat(40),
      "refs/heads/filtered": "f".repeat(40),
    });
    const { outcome } = await run({
      incoming,
      baseComposition: { prior: {}, candidate: { base: incoming } },
    }, {
      result: {
        applied: true,
        heldRefs: { "refs/heads/alpha": "wt-a", "refs/heads/mid": "wt-m", "refs/heads/zeta": "wt-z" },
        filteredRefs: ["refs/heads/filtered"],
      },
    });
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(outcome.transition.partial).toEqual({
      incomingKey: INCOMING_KEY,
      checkoutPending: false,
      appliedRefs: {},
      heldRefs: { "refs/heads/alpha": "ownership", "refs/heads/mid": "ownership", "refs/heads/zeta": "ownership" },
      configApplied: true,
    });
    expect(outcome.announcement).toBe(
      `git-sync applied ${REL} (held refs: refs/heads/alpha=wt-a refs/heads/mid=wt-m refs/heads/zeta=wt-z)`,
    );
  });

  test("no owner and no typed transitions advances BASE directly", async () => {
    const { outcome, calls } = await run();
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(outcome.transition).toMatchObject({
      appliedSection: INCOMING,
      pending: null,
      partial: null,
      deferral: "clear",
      attempt: "clear",
    });
    expect(outcome.announcement).toBe(`git-sync applied ${REL}`);
    expect(calls).toEqual(["runMutation", "applyState"]);
  });

  test("filtered refs appear in the announcement only when nothing is held", async () => {
    const { outcome } = await run({}, { result: { applied: true, filteredRefs: ["refs/heads/x", "refs/heads/y"] } });
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(outcome.announcement).toBe(`git-sync applied ${REL} (filtered refs: refs/heads/x refs/heads/y)`);
  });

  test("typed transitions compose BASE and proof from the same effects", async () => {
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
    const { outcome } = await run({
      incoming,
      baseComposition: { prior: {}, candidate: { base: incoming } },
    }, {
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
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(outcome.transition.proof?.authority).toMatchObject({
      kind: "pull-ref-transaction",
      lineageHash: LINEAGE,
      repositoryIdentityHash: REPO_IDENTITY,
      incomingKey: INCOMING_KEY,
    });
    expect(outcome.transition.proof?.lockedProof).toMatchObject({
      repoKind: "dir",
      effectiveRefScope: "all",
      checkoutComplete: true,
      incomingKey: INCOMING_KEY,
    });
    expect(outcome.transition.appliedSection).toMatchObject({ refs: { "refs/heads/main": nextOid } });
    expect(outcome.transition.branchOrigins?.["refs/heads/main"]).toMatchObject({ oid: nextOid, lineageHash: LINEAGE });
  });

  test("wiping scoped materialization records effective all scope", async () => {
    const nextOid = "3".repeat(40);
    const incoming = { head: nextOid, refs: { "refs/tags/v1": nextOid }, refScope: "scoped" } as GitSection;
    const { outcome, stateOptions } = await run({
      incoming,
      cleanMaterialize: true,
      dotGit: { isDirectory: true },
      baseComposition: { prior: {}, candidate: { base: incoming } },
    }, {
      result: {
        applied: true,
        safeRefTransitions: {
          "refs/tags/v1": { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: null, afterOid: nextOid },
        },
      },
    });
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(stateOptions).toMatchObject({ beforeMutateWipesRefs: true, cleanWipeRefs: true });
    expect(outcome.transition.proof?.lockedProof.effectiveRefScope).toBe("all");
  });

  test("failed config records an unapplied partial after Git commits", async () => {
    const { outcome, calls } = await run({
      incoming: WITH_CONFIG,
      baseComposition: { prior: {}, candidate: { base: WITH_CONFIG } },
    }, { config: async () => false });
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(calls).toEqual(["runMutation", "applyState", "applyConfig"]);
    expect(outcome.transition.partial).toEqual({
      incomingKey: INCOMING_KEY,
      checkoutPending: false,
      appliedRefs: {},
      heldRefs: {},
      configApplied: false,
    });
  });

  test("absent config operation is settled without a phase or partial", async () => {
    const { outcome, calls } = await run();
    if (outcome.status !== "materialized") throw new Error("expected materialized");
    expect(calls).toEqual(["runMutation", "applyState"]);
    expect(outcome.transition.partial).toBeNull();
  });
});
