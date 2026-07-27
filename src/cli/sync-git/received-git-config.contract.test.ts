import { expect, test } from "bun:test";
import type { GitConfig } from "../../engine/git/config-sync.js";
import type { ConfigStatToken, ConfigTransactionResult } from "../../engine/git/config-txn.js";
import type { ConfigShapeIdentity } from "../config.js";
import type { ConfigLaneState } from "../sync-state.js";
import { configLaneState } from "../sync-state.js";
import { gitConfigHash } from "./config-lane.js";
import {
  ConfigLaneLedger,
  ReceivedGitConfigPhaseMismatch,
  applyReceivedGitConfig,
  planReceivedGitConfigApply,
  type GitConfigExecutor,
  type ReceivedGitConfigIdentity,
  type ReceivedGitConfigPlan,
} from "./received-git-config.js";

const IDENTITY: ReceivedGitConfigIdentity = {
  root: "/ws",
  relPath: "repo",
  repoDir: "/ws/repo",
};

const shapeOf = (ino: string, shape: ConfigShapeIdentity["shape"] = "dir"): ConfigShapeIdentity => ({
  shape,
  commonDir: { realpath: `/ws/repo/.git`, dev: "1", ino, birthtime: "7" },
});

const STANDALONE = shapeOf("100");
const POINTER = shapeOf("200", "worktree");

const token = (value: string): ConfigStatToken =>
  ({ dev: "1", ino: "9", size: "1", mtimeNs: value, ctimeNs: value });

function ledgerWith(stored: ConfigLaneState = {}): {
  ledger: ConfigLaneLedger;
  lane: Record<string, ConfigLaneState>;
} {
  const lane: Record<string, ConfigLaneState> = {};
  const ledger = new ConfigLaneLedger({
    lane,
    sourceSeq: () => 4,
    storedLane: () => configLaneState(stored),
  });
  return { ledger, lane };
}

interface FakeExecutorOptions {
  phase: GitConfigExecutor["phase"];
  ledger: ConfigLaneLedger;
  commonDirToken?: string;
  identity?: ReceivedGitConfigIdentity;
  result?: ConfigTransactionResult;
  fresh?: { shape: ConfigShapeIdentity; config: GitConfig; token: ConfigStatToken };
}

function fakeExecutor(options: FakeExecutorOptions): GitConfigExecutor & {
  calls: string[];
  logs: string[];
} {
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    identity: options.identity ?? IDENTITY,
    phase: options.phase,
    ...(options.commonDirToken === undefined ? {} : { commonDirToken: options.commonDirToken }),
    ledger: options.ledger,
    calls,
    logs,
    async materializeFresh() {
      calls.push("materializeFresh");
    },
    async inspectFreshInstall() {
      calls.push("inspectFreshInstall");
      if (!options.fresh) throw new Error("no fresh install configured");
      return { shape: options.fresh.shape, config: options.fresh.config, token: options.fresh.token };
    },
    async applyExisting() {
      calls.push("applyExisting");
      if (!options.result) throw new Error("no transaction result configured");
      return options.result;
    },
    log(message: string) {
      logs.push(message);
    },
  };
}

const completedTransaction = (over: Partial<Extract<ConfigTransactionResult, { status: "completed" }>> = {}) =>
  ({
    status: "completed",
    preHash: "pre",
    postHash: "post",
    incomingHash: "incoming",
    postToken: token("post"),
    warnings: [],
    attempts: 1,
    ...over,
  }) as ConfigTransactionResult;

const applyPlan = (
  phase: "config-only" | "after-materialization" | "inside-follow-lock",
  over: Partial<{ commonDirToken: string; incoming: GitConfig }> = {},
): ReceivedGitConfigPlan =>
  planReceivedGitConfigApply({
    identity: IDENTITY,
    phase,
    disposition: { due: true, target: { fresh: false, shape: STANDALONE, configPath: "/ws/repo/.git/config" } },
    incoming: over.incoming ?? { "core.bare": ["false"] },
    baseConfig: undefined,
    ...(phase === "inside-follow-lock" ? { commonDirToken: over.commonDirToken ?? "/ws/repo/.git" } : {}),
  })!;

test("phase legality: an executor refuses a plan minted for another phase", async () => {
  const { ledger } = ledgerWith();
  const plan = applyPlan("inside-follow-lock");
  const executor = fakeExecutor({ phase: "config-only", ledger, result: completedTransaction() });
  await expect(applyReceivedGitConfig(plan, executor)).rejects.toBeInstanceOf(ReceivedGitConfigPhaseMismatch);
  expect(executor.calls).toEqual([]);
});

test("phase legality: an executor refuses a plan bound to another repository", async () => {
  const { ledger } = ledgerWith();
  const plan = applyPlan("config-only");
  const executor = fakeExecutor({
    phase: "config-only",
    ledger,
    identity: { ...IDENTITY, relPath: "other", repoDir: "/ws/other" },
    result: completedTransaction(),
  });
  await expect(applyReceivedGitConfig(plan, executor)).rejects.toBeInstanceOf(ReceivedGitConfigPhaseMismatch);
  expect(executor.calls).toEqual([]);
});

test("common-dir serialization: a follow-lock plan refuses an executor holding another common dir", async () => {
  const { ledger } = ledgerWith();
  const plan = applyPlan("inside-follow-lock", { commonDirToken: "/ws/repo/.git" });
  const executor = fakeExecutor({
    phase: "inside-follow-lock",
    ledger,
    commonDirToken: "/ws/elsewhere/.git",
    result: completedTransaction(),
  });
  await expect(applyReceivedGitConfig(plan, executor)).rejects.toBeInstanceOf(ReceivedGitConfigPhaseMismatch);
  expect(executor.calls).toEqual([]);

  const matched = fakeExecutor({
    phase: "inside-follow-lock",
    ledger,
    commonDirToken: "/ws/repo/.git",
    result: completedTransaction(),
  });
  const receipt = await applyReceivedGitConfig(plan, matched);
  expect(receipt.outcome).toBe("applied");
  expect(matched.calls).toEqual(["applyExisting"]);
});

test("only after-materialization may execute a fresh target", () => {
  const disposition = { due: true, target: { fresh: true } } as const;
  const base = { identity: IDENTITY, disposition, incoming: {} as GitConfig, baseConfig: undefined };
  expect(planReceivedGitConfigApply({ ...base, phase: "config-only" })).toBeUndefined();
  expect(planReceivedGitConfigApply({ ...base, phase: "inside-follow-lock", commonDirToken: "t" })).toBeUndefined();
  expect(planReceivedGitConfigApply({ ...base, phase: "after-materialization" })?.phase).toBe("after-materialization");
});

test("a plan is minted only when the disposition is due with a target", () => {
  const target = { fresh: false, shape: STANDALONE, configPath: "/ws/repo/.git/config" } as const;
  const base = { identity: IDENTITY, phase: "config-only" as const, incoming: {} as GitConfig, baseConfig: undefined };
  expect(planReceivedGitConfigApply({ ...base, disposition: { due: false, target } })).toBeUndefined();
  expect(planReceivedGitConfigApply({ ...base, disposition: { due: true, target: undefined } })).toBeUndefined();
  expect(planReceivedGitConfigApply({ ...base, disposition: { due: true, target }, incoming: undefined })).toBeUndefined();
});

test("a completed transaction records the lane completion and echoes transaction warnings", async () => {
  const { ledger, lane } = ledgerWith();
  const plan = applyPlan("config-only");
  const executor = fakeExecutor({
    phase: "config-only",
    ledger,
    result: completedTransaction({ warnings: ["dropped credential"], baseHash: "basePre" }),
  });
  const receipt = await applyReceivedGitConfig(plan, executor);
  expect(receipt).toEqual({ identity: IDENTITY, phase: "config-only", outcome: "applied" });
  expect(executor.logs).toEqual(["git-sync WARNING repo: config dropped credential"]);
  expect(lane["repo"]).toEqual({ cfgApplied: "incoming", cfgToken: token("post"), cfgShape: STANDALONE });
});

test("independent retry: a failed transaction throws and leaves the lane byte-exact", async () => {
  const { ledger, lane } = ledgerWith({ cfgApplied: "old", cfgToken: token("old"), cfgShape: STANDALONE });
  const before = JSON.stringify(lane);
  const plan = applyPlan("config-only");
  const executor = fakeExecutor({
    phase: "config-only",
    ledger,
    result: { status: "deferred", attempts: 3, fault: { disposition: "transient", reason: "unstable" } },
  });
  await expect(applyReceivedGitConfig(plan, executor)).rejects.toThrow("config deferred: unstable");
  expect(JSON.stringify(lane)).toBe(before);
});

test("after-materialization completes the lane from the post-install read, not the incoming value", async () => {
  const { ledger, lane } = ledgerWith();
  const installed: GitConfig = { "core.bare": ["false"] };
  const incoming: GitConfig = { "core.bare": ["false"], "user.name": ["x"] };
  const plan = planReceivedGitConfigApply({
    identity: IDENTITY,
    phase: "after-materialization",
    disposition: { due: true, target: { fresh: true } },
    incoming,
    baseConfig: { "core.bare": ["true"] },
  })!;
  const executor = fakeExecutor({
    phase: "after-materialization",
    ledger,
    fresh: { shape: STANDALONE, config: installed, token: token("fresh") },
  });
  const receipt = await applyReceivedGitConfig(plan, executor);
  expect(receipt.outcome).toBe("applied");
  expect(executor.calls).toEqual(["materializeFresh", "inspectFreshInstall"]);
  // The post-install read differs from the incoming value, so this device
  // authored nothing publishable: no `cfgSynced` baseline is claimed.
  expect(lane["repo"]).toEqual({
    cfgApplied: gitConfigHash(incoming),
    cfgToken: token("fresh"),
    cfgShape: STANDALONE,
  });
});

test("after-materialization claims a baseline only when the install equals the incoming value", async () => {
  const { ledger, lane } = ledgerWith();
  const incoming: GitConfig = { "core.bare": ["false"] };
  const plan = planReceivedGitConfigApply({
    identity: IDENTITY,
    phase: "after-materialization",
    disposition: { due: true, target: { fresh: true } },
    incoming,
    baseConfig: undefined,
  })!;
  await applyReceivedGitConfig(plan, fakeExecutor({
    phase: "after-materialization",
    ledger,
    fresh: { shape: STANDALONE, config: incoming, token: token("fresh") },
  }));
  expect(lane["repo"]?.cfgSynced).toBe(gitConfigHash(incoming));
});

test("sanitize-present seeds the unchanged local hash so the next push authors no corrective echo", async () => {
  const { ledger, lane } = ledgerWith();
  const plan: ReceivedGitConfigPlan = {
    phase: "sanitize-present",
    identity: IDENTITY,
    shape: STANDALONE,
    localHash: "local-hash",
  };
  const executor = fakeExecutor({ phase: "sanitize-present", ledger });
  const receipt = await applyReceivedGitConfig(plan, executor);
  expect(receipt.outcome).toBe("baseline-recorded");
  expect(lane["repo"]).toEqual({ cfgSynced: "local-hash", cfgShape: STANDALONE });
});

test("sanitize-present preserves a same-shape baseline so a genuine later edit stays publishable", async () => {
  const { ledger, lane } = ledgerWith({ cfgSynced: "hash-A", cfgApplied: "applied-A", cfgShape: STANDALONE });
  const plan: ReceivedGitConfigPlan = {
    phase: "sanitize-present",
    identity: IDENTITY,
    shape: STANDALONE,
    localHash: "hash-B",
  };
  await applyReceivedGitConfig(plan, fakeExecutor({ phase: "sanitize-present", ledger }));
  expect(lane["repo"]?.cfgSynced).toBe("hash-A");
  expect(lane["repo"]?.cfgApplied).toBe("applied-A");
});

test("pointer/standalone transition drops the prior baseline before seeding the new shape", async () => {
  const { ledger, lane } = ledgerWith({
    cfgSynced: "hash-A",
    cfgApplied: "applied-A",
    cfgToken: token("old"),
    cfgShape: POINTER,
  });
  const plan: ReceivedGitConfigPlan = {
    phase: "sanitize-present",
    identity: IDENTITY,
    shape: STANDALONE,
    localHash: "hash-B",
  };
  await applyReceivedGitConfig(plan, fakeExecutor({ phase: "sanitize-present", ledger }));
  expect(lane["repo"]).toEqual({ cfgSynced: "hash-B", cfgShape: STANDALONE });
});

test("wire-absent consumes only the authorship marker", async () => {
  const { ledger, lane } = ledgerWith({
    cfgSynced: "hash-A",
    cfgApplied: "applied-A",
    cfgToken: token("old"),
    cfgShape: STANDALONE,
  });
  const plan: ReceivedGitConfigPlan = { phase: "wire-absent", identity: IDENTITY };
  const receipt = await applyReceivedGitConfig(plan, fakeExecutor({ phase: "wire-absent", ledger }));
  expect(receipt.outcome).toBe("baseline-cleared");
  expect(lane["repo"]).toEqual({ cfgApplied: "applied-A", cfgToken: token("old"), cfgShape: STANDALONE });
});

test("wire-absent with no authorship marker is a no-op", async () => {
  const { ledger, lane } = ledgerWith({ cfgApplied: "applied-A", cfgShape: STANDALONE });
  const plan: ReceivedGitConfigPlan = { phase: "wire-absent", identity: IDENTITY };
  const receipt = await applyReceivedGitConfig(plan, fakeExecutor({ phase: "wire-absent", ledger }));
  expect(receipt.outcome).toBe("baseline-unchanged");
  expect(lane["repo"]).toBeUndefined();
});

test("the ledger's shape invalidation resets the lane exactly once per shape", () => {
  const { ledger, lane } = ledgerWith({ cfgSynced: "s", cfgApplied: "a", cfgToken: token("t"), cfgShape: POINTER });
  const first = ledger.invalidateShape("repo", STANDALONE);
  expect(first).toEqual({ sourceSeq: 4, cfgShape: STANDALONE });
  expect(lane["repo"]).toEqual({ cfgShape: STANDALONE });
  ledger.replace("repo", { ...first, cfgApplied: "next" });
  expect(ledger.invalidateShape("repo", STANDALONE)).toEqual({ sourceSeq: 4, cfgShape: STANDALONE, cfgApplied: "next" });
  expect(lane["repo"]).toEqual({ cfgShape: STANDALONE, cfgApplied: "next" });
});
