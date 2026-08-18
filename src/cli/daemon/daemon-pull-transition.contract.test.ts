import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { Action, GitSection, Manifest } from "../../engine/index.js";
import type { SyncState } from "../config.js";
import { loadMetrics, type SyncMetrics } from "../metrics.js";
import { TrustedViewRefusalError, type TrustedLocalView } from "../sync.js";
import type { TelemetrySample } from "../telemetry/contract.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import {
  ApplyRemoteWorkspaceTransition,
  buildTrustedPullView,
  classifyPullOutcome,
  planPullRefresh,
  sealPullRequest,
  summarizePullActions,
  type DaemonPullOutcome,
  type PullAttemptInputs,
  type PullOperation,
  type PullTransitionPort,
  type PullTrustGate,
  type PullTrustRecheck,
  type SealedPullRequest,
} from "./daemon-pull-transition.js";
import { LocalAuthority } from "./local-observation-transition.js";

function manifest(files: string[]): Manifest {
  return {
    generatedAt: "2026-07-26T00:00:00.000Z",
    files: files.map((filePath) => ({ path: filePath, size: 1, mtime: 0, hash: `h-${filePath}` })),
  } as Manifest;
}

function state(sequence: number, files: string[] = ["a.txt"]): SyncState {
  return { lastSyncedSequence: sequence, lastSyncedManifest: manifest(files) } as SyncState;
}

const VIEW: TrustedLocalView = { manifest: manifest(["a.txt"]), deferred: new Set<string>() };
const TRUSTED_BEFORE: PullTrustGate = {
  killSwitchOff: false,
  watcherTrusted: true,
  manifestSettled: true,
  fullWorkspaceSinceSeed: true,
  resetReady: true,
  matcherMatchesBase: true,
  matcherObservationCurrent: true,
};
const TRUSTED_AFTER: PullTrustRecheck = {
  pendingEmpty: true,
  watcherTrusted: true,
  manifestSettled: true,
  trustedView: () => VIEW,
};

function write(filePath: string): Action {
  return { kind: "write", path: filePath, entry: { path: filePath, size: 1, mtime: 0, hash: `h-${filePath}` } } as Action;
}

function conflict(filePath: string): Action {
  return { kind: "conflict", path: filePath, keepLocalAs: `${filePath}.copy` } as Action;
}

function gitSection(): GitSection {
  return { bundleSha: "bundle", bundleEncSha: "enc", bundleCipherSize: 1, head: "ref: refs/heads/main", refs: {} };
}

class RecordingTelemetry implements TelemetryRecorder {
  readonly samples: TelemetrySample[] = [];
  constructor(private readonly calls: string[]) {}
  record(sample: TelemetrySample): void {
    this.calls.push("propagation");
    this.samples.push(sample);
  }
}

async function harness(options: {
  before?: PullTrustGate;
  after?: PullTrustRecheck;
  outcome?: (request: SealedPullRequest) => DaemonPullOutcome;
  actions?: readonly Action[];
  chainRepaired?: boolean;
  topologyChanged?: boolean;
  patchReason?: "watcher-drop";
  metrics?: SyncMetrics;
  notifyPendingAt?: number;
  failAt?: "settle-report" | "refresh-matcher" | "load-post-base";
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pull-transition-"));
  const calls: string[] = [];
  const requests: SealedPullRequest[] = [];
  const metrics = options.metrics ?? { syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 };
  const telemetry = new RecordingTelemetry(calls);
  const adopted: number[] = [];
  const logs: string[] = [];
  const observed = {
    reportSettled: false,
    matcherRefreshed: false,
    postBaseLoaded: false,
  };
  const preBase = state(1);
  const postBase = options.topologyChanged ? state(9, ["a.txt", "repo/.git/config"]) : state(9);
  if (options.topologyChanged) postBase.lastSyncedManifest.gitRepos = { repo: gitSection() };
  const transition = new ApplyRemoteWorkspaceTransition({
    root,
    local: new LocalAuthority(),
    metrics,
    telemetry,
    chainRepairPolicy: { clear: () => { calls.push("clear-chain-repair"); } },
    publishTransition: { adoptPublishedSequence: (sequence) => { calls.push("adopt-sequence"); adopted.push(sequence); } },
    now: () => 2_000,
  }, {
    log: (line) => { calls.push("log"); logs.push(line); },
    refreshMatcher: async () => {
      calls.push("refresh-matcher");
      if (options.failAt === "refresh-matcher") throw new Error("injected refresh failure");
      observed.matcherRefreshed = true;
    },
    loadAndSurfacePostBase: async () => {
      calls.push("load-post-base");
      if (options.failAt === "load-post-base") throw new Error("injected BASE failure");
      observed.postBaseLoaded = true;
      return postBase;
    },
    installPullPatch: () => { calls.push("install-patch"); return options.patchReason; },
    scanLocal: async () => { calls.push("scan-local"); },
  });
  const port: PullTransitionPort = {
    execute: async (request) => {
      calls.push(`execute:${request.view === undefined ? "scan" : "trusted"}`);
      requests.push(request);
      return options.outcome?.(request) ?? {
        kind: "applied",
        attemptId: request.attemptId,
        actions: options.actions ?? [],
        chainRepaired: options.chainRepaired ?? false,
      };
    },
    settleReport: () => {
      calls.push("settle-report");
      if (options.failAt === "settle-report") throw new Error("injected report failure");
      observed.reportSettled = true;
    },
  };
  const attempt: PullAttemptInputs = {
    preBase,
    watcherErrorGeneration: 4,
    notifyPendingAt: options.notifyPendingAt,
  };
  const operation: PullOperation = {
    seal: async () => { calls.push("seal"); return attempt; },
    drainPendingEvents: async () => { calls.push("drain"); },
    trustGate: () => { calls.push("trust-gate"); return options.before ?? TRUSTED_BEFORE; },
    trustRecheck: () => { calls.push("trust-recheck"); return options.after ?? TRUSTED_AFTER; },
    open: () => { calls.push("open"); return port; },
  };
  return { root, calls, requests, metrics, telemetry, adopted, logs, observed, transition, port, operation };
}

describe("trusted pull admission", () => {
  test("accepted trust drains once, then gates, then seals the view", async () => {
    const calls: string[] = [];
    expect(await buildTrustedPullView(
      async () => { calls.push("drain"); },
      () => { calls.push("gate"); return TRUSTED_BEFORE; },
      () => { calls.push("recheck"); return TRUSTED_AFTER; },
    )).toEqual({ view: VIEW });
    expect(calls).toEqual(["drain", "gate", "recheck"]);
  });

  test("design 277 B3: trust is sampled after the drain, so a settling drain admits", async () => {
    let settled = false;
    const result = await buildTrustedPullView(
      async () => { settled = true; },
      () => ({ ...TRUSTED_BEFORE, manifestSettled: settled }),
      () => TRUSTED_AFTER,
    );
    expect(result.view).toBe(VIEW);
  });

  test("every gate value reports its named refusal AFTER the unconditional drain", async () => {
    const cases: [keyof PullTrustGate, boolean, string][] = [
      ["killSwitchOff", true, "kill-switch"],
      ["watcherTrusted", false, "p1-watcher"],
      ["manifestSettled", false, "p2-observation"],
      ["fullWorkspaceSinceSeed", false, "p5-seed"],
      ["resetReady", false, "p6-reset"],
      ["matcherMatchesBase", false, "p7-matcher"],
      ["matcherObservationCurrent", false, "p7-matcher-observation"],
    ];
    for (const [key, value, expected] of cases) {
      let drained = false;
      const result = await buildTrustedPullView(
        async () => { drained = true; },
        () => ({ ...TRUSTED_BEFORE, [key]: value }),
        () => TRUSTED_AFTER,
      );
      expect(result.skip, key).toBe(expected);
      expect(drained, key).toBe(true);
    }
  });

  test("post-drain P3, P1, and P2 refusals keep their exact tokens", async () => {
    const cases: [Partial<PullTrustRecheck>, string][] = [
      [{ pendingEmpty: false }, "p3-pending"],
      [{ watcherTrusted: false }, "p1-watcher"],
      [{ manifestSettled: false }, "p2-observation"],
    ];
    for (const [override, expected] of cases) {
      const result = await buildTrustedPullView(async () => {}, () => TRUSTED_BEFORE, () => ({ ...TRUSTED_AFTER, ...override }));
      expect(result.skip).toBe(expected);
    }
  });

  test("the trusted projection stays lazy until every post-drain clause admits", async () => {
    let projections = 0;
    const after = (override: Partial<PullTrustRecheck>): PullTrustRecheck => ({
      ...TRUSTED_AFTER,
      ...override,
      trustedView: () => { projections++; return VIEW; },
    });
    expect((await buildTrustedPullView(
      async () => {},
      () => TRUSTED_BEFORE,
      () => after({ pendingEmpty: false }),
    )).skip).toBe("p3-pending");
    expect((await buildTrustedPullView(
      async () => {},
      () => TRUSTED_BEFORE,
      () => after({ watcherTrusted: false }),
    )).skip).toBe("p1-watcher");
    expect((await buildTrustedPullView(
      async () => {},
      () => TRUSTED_BEFORE,
      () => after({ manifestSettled: false }),
    )).skip).toBe("p2-observation");
    expect(projections).toBe(0);
    expect((await buildTrustedPullView(async () => {}, () => TRUSTED_BEFORE, () => after({}))).view).toBe(VIEW);
    expect(projections).toBe(1);
  });
});

describe("pull classification and pure decisions", () => {
  const trusted = sealPullRequest("a1", { view: VIEW }, 4);
  const scanned = sealPullRequest("a1", { skip: "kill-switch" }, 4);

  test("classification binds actions and explicit chain-repair evidence", async () => {
    expect(await classifyPullOutcome(trusted, async () => [write("x")], () => true))
      .toMatchObject({ kind: "applied", attemptId: "a1", chainRepaired: true });
  });

  test("trusted-view refusal becomes one local-untrusted outcome", async () => {
    expect(await classifyPullOutcome(trusted, async () => {
      throw new TrustedViewRefusalError("mass-delete", "nope");
    }, () => false)).toEqual({ kind: "local-untrusted", attemptId: "a1", reason: "mass-delete" });
  });

  test("scan-backed and unrelated failures propagate", async () => {
    await expect(classifyPullOutcome(scanned, async () => {
      throw new TrustedViewRefusalError("mass-delete", "nope");
    }, () => false)).rejects.toThrow(TrustedViewRefusalError);
    await expect(classifyPullOutcome(trusted, async () => { throw new Error("network"); }, () => false))
      .rejects.toThrow("network");
  });

  test("action summary counts conflicts and ignore-rule writes", () => {
    expect(summarizePullActions([write("a"), conflict("b"), write(".rboxignore")]))
      .toEqual({ fileConflicts: 1, rulesWritten: true });
  });

  test("refresh precedence is F4 then F3 then F2 then patch", () => {
    expect(planPullRefresh({ trusted: false, chainRepaired: true, rulesWritten: true, topologyChanged: true }).kind)
      .toBe("no-trusted-view");
    expect(planPullRefresh({ trusted: true, chainRepaired: true, rulesWritten: true, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "chain-repair" });
    expect(planPullRefresh({ trusted: true, chainRepaired: false, rulesWritten: true, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "ignore-rules" });
    expect(planPullRefresh({ trusted: true, chainRepaired: false, rulesWritten: false, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "git-topology" });
    expect(planPullRefresh({ trusted: true, chainRepaired: false, rulesWritten: false, topologyChanged: false }))
      .toEqual({ kind: "install-patch" });
  });
});

describe("ApplyRemoteWorkspaceTransition", () => {
  test("ordinary trusted pull applies direct settlement in protected order", async () => {
    const h = await harness({ notifyPendingAt: 1_500 });
    const receipt = await h.transition.apply(h.operation);
    expect(receipt).toMatchObject({ local: "trusted", fallback: undefined, skip: undefined });
    expect(h.calls).toEqual([
      "seal", "drain", "trust-gate", "trust-recheck", "open", "execute:trusted", "clear-chain-repair",
      "propagation", "settle-report", "load-post-base", "adopt-sequence", "install-patch", "log",
    ]);
    expect(h.adopted).toEqual([9]);
    expect(h.telemetry.samples).toContainEqual({ kind: "propagation", deliveryToApplyMs: 500 });
    expect(h.logs).toEqual(["pull local=trusted"]);
  });

  // Design 277 B3: a withheld-trust pull still DRAINS. Leaving the drain behind P1
  // let a fused watcher accumulate events unboundedly and hold local work unsettled.
  test("withheld trust executes scan-backed but still drains, without post snapshot or patch", async () => {
    const h = await harness({ before: { ...TRUSTED_BEFORE, watcherTrusted: false } });
    const receipt = await h.transition.apply(h.operation);
    expect(receipt).toMatchObject({ local: "scan", skip: "p1-watcher" });
    expect(h.calls.slice(0, 3)).toEqual(["seal", "drain", "trust-gate"]);
    expect(h.calls).not.toContain("trust-recheck");
    expect(h.calls).not.toContain("install-patch");
    expect(h.calls.slice(-2)).toEqual(["scan-local", "log"]);
    expect(h.logs.at(-1)).toBe("pull local=scan skip=p1-watcher");
  });

  test("trusted refusal authorizes exactly one scan child", async () => {
    const h = await harness({ outcome: (request) => request.view
      ? { kind: "local-untrusted", attemptId: request.attemptId, reason: "mass-delete" }
      : { kind: "applied", attemptId: request.attemptId, actions: [], chainRepaired: false } });
    const receipt = await h.transition.apply(h.operation);
    expect(receipt.children).toHaveLength(2);
    expect(receipt.children[0]).not.toBe(receipt.children[1]);
    expect(h.calls.filter((call) => call.startsWith("execute"))).toEqual(["execute:trusted", "execute:scan"]);
    expect(h.logs).toEqual(["pull local=trusted refused=mass-delete", "pull local=scan skip=refused"]);
  });

  test("a second refusal fails closed", async () => {
    const h = await harness({ outcome: (request) => ({
      kind: "local-untrusted",
      attemptId: request.attemptId,
      reason: "mass-delete",
    }) });
    await expect(h.transition.apply(h.operation)).rejects.toThrow(/scan-backed/);
    expect(h.calls.filter((call) => call.startsWith("execute"))).toHaveLength(2);
  });

  test("mismatched identity performs no settlement", async () => {
    const h = await harness({ outcome: () => ({ kind: "applied", attemptId: "other", actions: [], chainRepaired: false }) });
    await expect(h.transition.apply(h.operation)).rejects.toThrow(/attempt/);
    expect(h.calls).toEqual(["seal", "drain", "trust-gate", "trust-recheck", "open", "execute:trusted"]);
  });

  test("conflict metrics increment the stable loaded record and preserve siblings", async () => {
    const metrics = { syncs: 8, commitConflicts409: 3, fileConflicts: 5, lockStarved: 2, lastConflictAt: "then" };
    const h = await harness({ actions: [conflict("a")], metrics });
    await h.transition.apply(h.operation);
    expect(h.metrics.syncs).toBe(8);
    expect(h.metrics.commitConflicts409).toBe(3);
    expect(h.metrics.fileConflicts).toBe(6);
    expect(h.metrics.lockStarved).toBe(2);
    expect(h.metrics.lastConflictAt).not.toBe("then");
    expect(await loadMetrics(h.root)).toEqual(h.metrics);
    expect(h.calls.indexOf("settle-report")).toBeLessThan(h.calls.indexOf("load-post-base"));
  });

  test("ignore-rule write refreshes matcher before BASE and scans with named fallback", async () => {
    const h = await harness({ actions: [write(".rboxignore")] });
    const receipt = await h.transition.apply(h.operation);
    expect(receipt.fallback).toBe("ignore-rules");
    expect(h.calls.indexOf("refresh-matcher")).toBeLessThan(h.calls.indexOf("load-post-base"));
    expect(h.calls.slice(-2)).toEqual(["scan-local", "log"]);
    expect(h.logs.at(-1)).toBe("pull local=trusted fallback=ignore-rules");
  });

  test("settlement failures preserve the completed prefix and stop the remaining pull chain", async () => {
    const atReport = await harness({ actions: [conflict("a"), write(".rboxignore")], failAt: "settle-report" });
    await expect(atReport.transition.apply(atReport.operation)).rejects.toThrow("injected report failure");
    expect(atReport.observed).toEqual({ reportSettled: false, matcherRefreshed: false, postBaseLoaded: false });
    expect(atReport.metrics.fileConflicts).toBe(0);
    expect(atReport.adopted).toEqual([]);

    const atMatcher = await harness({ actions: [conflict("a"), write(".rboxignore")], failAt: "refresh-matcher" });
    await expect(atMatcher.transition.apply(atMatcher.operation)).rejects.toThrow("injected refresh failure");
    expect(atMatcher.observed).toEqual({ reportSettled: true, matcherRefreshed: false, postBaseLoaded: false });
    expect((await loadMetrics(atMatcher.root)).fileConflicts).toBe(1);
    expect(atMatcher.adopted).toEqual([]);

    const atBase = await harness({ actions: [conflict("a"), write(".rboxignore")], failAt: "load-post-base" });
    await expect(atBase.transition.apply(atBase.operation)).rejects.toThrow("injected BASE failure");
    expect(atBase.observed).toEqual({ reportSettled: true, matcherRefreshed: true, postBaseLoaded: false });
    expect((await loadMetrics(atBase.root)).fileConflicts).toBe(1);
    expect(atBase.adopted).toEqual([]);
  });

  test("chain repair, topology, and watcher drop each select their named scan", async () => {
    const chain = await harness({ chainRepaired: true });
    expect((await chain.transition.apply(chain.operation)).fallback).toBe("chain-repair");
    const topology = await harness({ topologyChanged: true });
    expect((await topology.transition.apply(topology.operation)).fallback).toBe("git-topology");
    const watcher = await harness({ patchReason: "watcher-drop" });
    expect((await watcher.transition.apply(watcher.operation)).fallback).toBe("watcher-drop");
    expect(watcher.logs.at(-1)).toBe("pull local=trusted fallback=watcher-drop");
  });

  test("each operation gets fresh parent and child identities", async () => {
    const h = await harness();
    const first = await h.transition.apply(h.operation);
    const second = await h.transition.apply(h.operation);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.children[0]).not.toBe(second.children[0]);
  });
});
