import { describe, expect, test } from "bun:test";
import type { Action, Manifest } from "../../engine/index.js";
import type { SyncState } from "../config.js";
import { TrustedViewRefusalError, type TrustedLocalView } from "../sync.js";
import type { SkipCause, TrustedPullViewResult } from "./manifest-update.js";
import {
  ApplyRemoteWorkspaceTransition,
  buildTrustedPullView,
  classifyPullOutcome,
  planPullRefresh,
  reducePullRefresh,
  reducePullSettlement,
  sealPullRequest,
  sealScanFallbackRequest,
  summarizePullActions,
  type DaemonPullEffect,
  type DaemonPullEffects,
  type DaemonPullOutcome,
  type PullAttemptInputs,
  type PullOperation,
  type PullTransitionPort,
  type PullTrustFacts,
  type SealedPullRequest,
} from "./daemon-pull-transition.js";

function manifest(files: string[]): Manifest {
  return {
    generatedAt: "2026-07-26T00:00:00.000Z",
    files: files.map((path) => ({ path, size: 1, mtime: 0, hash: `h-${path}` })),
  } as Manifest;
}

function state(seq: number, files: string[] = ["a.txt"]): SyncState {
  return { lastSyncedSequence: seq, lastSyncedManifest: manifest(files) } as SyncState;
}

const VIEW: TrustedLocalView = { manifest: manifest(["a.txt"]), deferred: new Set<string>() };

function inputs(overrides: Partial<PullAttemptInputs> = {}): PullAttemptInputs {
  return {
    trust: { view: VIEW } as TrustedPullViewResult,
    preBase: state(1),
    watcherErrorGeneration: 4,
    notifyPendingAt: undefined,
    ...overrides,
  };
}

function write(path: string): Action {
  return { kind: "write", path, entry: { path, size: 1, mtime: 0, hash: `h-${path}` } } as unknown as Action;
}

function conflict(path: string, keepLocalAs: string): Action {
  return { kind: "conflict", path, keepLocalAs } as unknown as Action;
}

// ---------------------------------------------------------------- trust predicate

function trustFacts(overrides: Partial<Record<keyof PullTrustFacts, unknown>> = {}, log?: string[]): PullTrustFacts {
  const order = log ?? [];
  const base: PullTrustFacts = {
    killSwitchOff: () => { order.push("kill-switch"); return false; },
    watcherTrusted: () => { order.push("p1"); return true; },
    manifestSettled: () => { order.push("p2"); return true; },
    fullWorkspaceSinceSeed: () => { order.push("p5"); return true; },
    resetReady: () => { order.push("p6"); return true; },
    matcherMatchesBase: () => { order.push("p7"); return true; },
    matcherObservationCurrent: () => { order.push("p7-obs"); return true; },
    drainPendingEvents: async () => { order.push("drain"); },
    pendingEmpty: () => { order.push("pending"); return true; },
    trustedView: () => { order.push("view"); return VIEW; },
  };
  return { ...base, ...(overrides as Partial<PullTrustFacts>) };
}

describe("buildTrustedPullView", () => {
  test("an armed daemon yields the single-use trusted view", async () => {
    expect(await buildTrustedPullView(trustFacts())).toEqual({ view: VIEW });
  });

  test("each clause reports its own named skip cause", async () => {
    const cases: [Partial<Record<keyof PullTrustFacts, unknown>>, SkipCause][] = [
      [{ killSwitchOff: () => true }, "kill-switch"],
      [{ watcherTrusted: () => false }, "p1-watcher"],
      [{ manifestSettled: () => false }, "p2-observation"],
      [{ fullWorkspaceSinceSeed: () => false }, "p5-seed"],
      [{ resetReady: () => false }, "p6-reset"],
      [{ matcherMatchesBase: () => false }, "p7-matcher"],
      [{ matcherObservationCurrent: () => false }, "p7-matcher-observation"],
      [{ pendingEmpty: () => false }, "p3-pending"],
    ];
    for (const [override, skip] of cases) {
      expect((await buildTrustedPullView(trustFacts(override))).skip, skip).toBe(skip);
    }
  });

  test("clauses are evaluated in P order and the drain is the last side effect before the view", async () => {
    const order: string[] = [];
    await buildTrustedPullView(trustFacts({}, order));
    expect(order).toEqual(["kill-switch", "p1", "p2", "p5", "p6", "p7", "p7-obs", "drain", "pending", "p1", "p2", "view"]);
  });

  test("the drain is skipped entirely when an earlier clause withholds trust", async () => {
    const order: string[] = [];
    await buildTrustedPullView(trustFacts({ watcherTrusted: () => false }, order));
    expect(order).not.toContain("drain");
  });

  test("a post-drain P1/P2 invalidation reports its own clause, never a drain token", async () => {
    let p1 = 0;
    expect((await buildTrustedPullView(trustFacts({ watcherTrusted: () => ++p1 === 1 }))).skip).toBe("p1-watcher");
    let p2 = 0;
    expect((await buildTrustedPullView(trustFacts({ manifestSettled: () => ++p2 === 1 }))).skip).toBe("p2-observation");
  });
});

// ---------------------------------------------------------------- sealing

describe("sealPullRequest", () => {
  test("carries the trusted view and no skip cause", () => {
    const request = sealPullRequest("pull-1/1", inputs());
    expect(request).toEqual({ attemptId: "pull-1/1", view: VIEW, skip: undefined, watcherErrorGeneration: 4 });
  });

  test("a withheld view carries its named clause and no view", () => {
    const request = sealPullRequest("pull-1/1", inputs({ trust: { skip: "p6-reset" } }));
    expect(request.view).toBeUndefined();
    expect(request.skip).toBe("p6-reset");
  });

  test("the scan fallback drops the view and names the refusal, keeping the watcher generation", () => {
    const first = sealPullRequest("pull-1/1", inputs());
    const second = sealScanFallbackRequest("pull-1/2", first);
    expect(second).toEqual({ attemptId: "pull-1/2", view: undefined, skip: "refused", watcherErrorGeneration: 4 });
  });
});

// ---------------------------------------------------------------- classification

describe("classifyPullOutcome", () => {
  const trusted = sealPullRequest("a1", inputs());
  const scanned = sealPullRequest("a1", inputs({ trust: { skip: "kill-switch" } }));

  test("actions become an applied outcome bound to the attempt", async () => {
    const outcome = await classifyPullOutcome(trusted, async () => [write("x")], () => false);
    expect(outcome.kind).toBe("applied");
    expect(outcome.attemptId).toBe("a1");
  });

  test("the chain-repair flag is read from the port, not inferred", async () => {
    const outcome = await classifyPullOutcome(trusted, async () => [], () => true);
    expect(outcome).toMatchObject({ kind: "applied", chainRepaired: true });
  });

  test("a refusal against a trusted view is absorbed as local-untrusted", async () => {
    const outcome = await classifyPullOutcome(trusted, async () => {
      throw new TrustedViewRefusalError("mass-delete", "nope");
    }, () => false);
    expect(outcome).toEqual({ kind: "local-untrusted", attemptId: "a1", reason: "mass-delete" });
  });

  test("a refusal on a scan-backed request is NOT absorbed — it fails closed", async () => {
    await expect(classifyPullOutcome(scanned, async () => {
      throw new TrustedViewRefusalError("mass-delete", "nope");
    }, () => false)).rejects.toThrow(TrustedViewRefusalError);
  });

  test("any other failure propagates unclassified", async () => {
    await expect(classifyPullOutcome(trusted, async () => { throw new Error("network"); }, () => false))
      .rejects.toThrow("network");
  });
});

// ---------------------------------------------------------------- pure reduction

describe("summarizePullActions", () => {
  test("counts conflicts and detects ignore-rule writes", () => {
    expect(summarizePullActions([write("a.txt")])).toEqual({ fileConflicts: 0, rulesWritten: false });
    expect(summarizePullActions([conflict("a.txt", "a (copy).txt")])).toMatchObject({ fileConflicts: 1 });
    expect(summarizePullActions([write(".rboxignore")]).rulesWritten).toBe(true);
    expect(summarizePullActions([write("sub/.gitignore")]).rulesWritten).toBe(true);
  });
});

const kinds = (effects: readonly DaemonPullEffect[]): string[] => effects.map((effect) => effect.kind);

describe("reducePullSettlement", () => {
  const applied: DaemonPullOutcome = { kind: "applied", attemptId: "a1", actions: [], chainRepaired: false };

  test("the quiet path clears chain repair, settles the report, and adopts the post base", () => {
    const effects = reducePullSettlement(applied, { notifyPendingAt: undefined });
    expect(kinds(effects)).toEqual(["clear-chain-repair", "settle-report", "adopt-post-base"]);
  });

  test("a notify-carried pull records propagation before the report settles", () => {
    const effects = reducePullSettlement(applied, { notifyPendingAt: 1234 });
    expect(kinds(effects)).toEqual(["clear-chain-repair", "record-propagation", "settle-report", "adopt-post-base"]);
    expect(effects).toContainEqual({ kind: "record-propagation", pendingAt: 1234 });
  });

  test("conflicts and rule writes are ordered between the report and the post base", () => {
    const effects = reducePullSettlement(
      { kind: "applied", attemptId: "a1", actions: [conflict("a.txt", "a copy"), write(".rboxignore")], chainRepaired: false },
      { notifyPendingAt: undefined },
    );
    expect(kinds(effects)).toEqual([
      "clear-chain-repair",
      "settle-report",
      "record-file-conflicts",
      "refresh-matcher",
      "adopt-post-base",
    ]);
    expect(effects).toContainEqual({ kind: "record-file-conflicts", count: 1 });
  });

  test("a conflict-free pull records no conflict metric", () => {
    const effects = reducePullSettlement(applied, { notifyPendingAt: undefined });
    expect(kinds(effects)).not.toContain("record-file-conflicts");
  });
});

describe("planPullRefresh", () => {
  const facts = { chainRepaired: false, rulesWritten: false, topologyChanged: false };

  test("a scan-backed pull never patches", () => {
    expect(planPullRefresh({ trusted: false, ...facts })).toEqual({ kind: "no-trusted-view" });
  });

  test("F4 chain repair outranks F3 and F2", () => {
    expect(planPullRefresh({ trusted: true, chainRepaired: true, rulesWritten: true, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "chain-repair" });
  });

  test("F3 ignore-rule writes outrank F2 topology", () => {
    expect(planPullRefresh({ trusted: true, chainRepaired: false, rulesWritten: true, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "ignore-rules" });
  });

  test("F2 git topology change falls back to the scan", () => {
    expect(planPullRefresh({ trusted: true, chainRepaired: false, rulesWritten: false, topologyChanged: true }))
      .toEqual({ kind: "fallback", cause: "git-topology" });
  });

  test("otherwise the O(applied) patch is installed", () => {
    expect(planPullRefresh({ trusted: true, ...facts })).toEqual({ kind: "install-patch" });
  });
});

describe("reducePullRefresh", () => {
  test("a trusted pull with an installed patch logs provenance and does not rescan", () => {
    const effects = reducePullRefresh({ trusted: true, skip: undefined, fallback: undefined });
    expect(effects).toEqual([{ kind: "log", line: "pull local=trusted" }]);
  });

  test("a fallback rescans BEFORE it logs, and names the cause", () => {
    const effects = reducePullRefresh({ trusted: true, skip: undefined, fallback: "watcher-drop" });
    expect(kinds(effects)).toEqual(["scan-local", "log"]);
    expect(effects[1]).toEqual({ kind: "log", line: "pull local=trusted fallback=watcher-drop" });
  });

  test("a withheld view names its skip clause", () => {
    const effects = reducePullRefresh({ trusted: false, skip: "p7-matcher", fallback: undefined });
    expect(kinds(effects)).toEqual(["scan-local", "log"]);
    expect(effects[1]).toEqual({ kind: "log", line: "pull local=scan skip=p7-matcher" });
  });

  test("every skip cause renders its own byte-exact token", () => {
    const causes: (SkipCause | "refused")[] = [
      "kill-switch", "p1-watcher", "p2-observation", "p3-pending",
      "p5-seed", "p6-reset", "p7-matcher", "p7-matcher-observation", "refused",
    ];
    for (const skip of causes) {
      const line = reducePullRefresh({ trusted: false, skip, fallback: undefined })
        .find((effect) => effect.kind === "log") as { line: string };
      expect(line.line).toBe(`pull local=scan skip=${skip}`);
    }
  });

  test("every fallback cause renders its own byte-exact token", () => {
    for (const fallback of ["chain-repair", "ignore-rules", "git-topology", "watcher-drop"] as const) {
      const line = reducePullRefresh({ trusted: true, skip: undefined, fallback })
        .find((effect) => effect.kind === "log") as { line: string };
      expect(line.line).toBe(`pull local=trusted fallback=${fallback}`);
    }
  });

  test("skip and fallback can both appear, in that order", () => {
    const line = reducePullRefresh({ trusted: false, skip: "refused", fallback: "git-topology" })
      .find((effect) => effect.kind === "log") as { line: string };
    expect(line.line).toBe("pull local=scan skip=refused fallback=git-topology");
  });
});

// ---------------------------------------------------------------- the transition

class RecordingEffects implements DaemonPullEffects, PullTransitionPort, PullOperation {
  readonly calls: string[] = [];
  readonly requests: SealedPullRequest[] = [];
  attemptInputs: PullAttemptInputs = inputs();
  outcomeFor: (request: SealedPullRequest) => Promise<DaemonPullOutcome> = async (request) =>
    ({ kind: "applied", attemptId: request.attemptId, actions: [], chainRepaired: false });
  postBase: SyncState = state(9);
  topologyChanged = false;
  patchReason: "watcher-drop" | undefined = undefined;

  constructor(overrides: Partial<RecordingEffects> = {}) {
    Object.assign(this, overrides);
  }

  async seal(): Promise<PullAttemptInputs> { this.calls.push("seal-inputs"); return this.attemptInputs; }
  open(): PullTransitionPort { return this; }
  async execute(request: SealedPullRequest): Promise<DaemonPullOutcome> {
    this.requests.push(request);
    this.calls.push(`execute:${request.view === undefined ? "scan" : "trusted"}`);
    return this.outcomeFor(request);
  }
  settleReport(): void { this.calls.push("settle-report"); }
  clearChainRepair(): void { this.calls.push("clear-chain-repair"); }
  recordPropagation(pendingAt: number): void { this.calls.push(`propagation:${pendingAt}`); }
  async recordFileConflicts(count: number): Promise<void> { this.calls.push(`conflicts:${count}`); }
  async refreshMatcher(): Promise<void> { this.calls.push("refresh-matcher"); }
  async adoptPostBase(): Promise<SyncState> { this.calls.push("adopt-post-base"); return this.postBase; }
  gitTopologyChanged(): boolean { return this.topologyChanged; }
  installPullPatch(
    _view: TrustedLocalView,
    _actions: readonly Action[],
    _postBase: Manifest,
    generation: number,
  ): "watcher-drop" | undefined {
    this.calls.push(`install-patch:${generation}`);
    return this.patchReason;
  }
  async scanLocal(): Promise<void> { this.calls.push("scan-local"); }
  log(line: string): void { this.calls.push(`log:${line}`); }
}

describe("ApplyRemoteWorkspaceTransition", () => {
  test("an ordinary trusted pull calls the engine ONCE and applies effects in order", async () => {
    const effects = new RecordingEffects();
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls).toEqual([
      "seal-inputs",
      "execute:trusted",
      "clear-chain-repair",
      "settle-report",
      "adopt-post-base",
      "install-patch:4",
      "log:pull local=trusted",
    ]);
    expect(receipt.local).toBe("trusted");
    expect(receipt.children).toEqual([effects.requests[0]!.attemptId]);
    expect(receipt.fallback).toBeUndefined();
  });

  test("a withheld view calls the engine once, scan-backed, and never patches", async () => {
    const effects = new RecordingEffects({ attemptInputs: inputs({ trust: { skip: "p1-watcher" } }) });
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls.filter((c) => c.startsWith("execute"))).toEqual(["execute:scan"]);
    expect(effects.calls).not.toContain("install-patch:4");
    expect(effects.calls.at(-1)).toBe("log:pull local=scan skip=p1-watcher");
    expect(receipt.skip).toBe("p1-watcher");
  });

  test("a refusal authorizes EXACTLY ONE scan-backed re-execute, logged between the two", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async (request) => request.view
        ? { kind: "local-untrusted", attemptId: request.attemptId, reason: "mass-delete" }
        : { kind: "applied", attemptId: request.attemptId, actions: [], chainRepaired: false },
    });
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls).toEqual([
      "seal-inputs",
      "execute:trusted",
      "log:pull local=trusted refused=mass-delete",
      "execute:scan",
      "clear-chain-repair",
      "settle-report",
      "adopt-post-base",
      "scan-local",
      "log:pull local=scan skip=refused",
    ]);
    expect(receipt.children).toHaveLength(2);
    expect(receipt.children[0]).not.toBe(receipt.children[1]);
    expect(receipt.attemptId).not.toBe(receipt.children[0]);
  });

  test("a second refusal is never authorized — it fails closed", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async (request) => ({ kind: "local-untrusted", attemptId: request.attemptId, reason: "mass-delete" }),
    });
    await expect(new ApplyRemoteWorkspaceTransition(effects).apply(effects)).rejects.toThrow(/untrusted/);
    expect(effects.calls.filter((c) => c.startsWith("execute"))).toHaveLength(2);
  });

  test("an outcome bound to another attempt performs NO transition", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async () => ({ kind: "applied", attemptId: "someone-else", actions: [], chainRepaired: false }),
    });
    await expect(new ApplyRemoteWorkspaceTransition(effects).apply(effects)).rejects.toThrow(/attempt/);
    expect(effects.calls).toEqual(["seal-inputs", "execute:trusted"]);
  });

  test("the port opens only AFTER the attempt inputs are sealed", async () => {
    const effects = new RecordingEffects();
    await new ApplyRemoteWorkspaceTransition(effects).apply({
      seal: () => effects.seal(),
      open: () => { effects.calls.push("open-port"); return effects; },
    });
    expect(effects.calls.indexOf("open-port")).toBe(effects.calls.indexOf("seal-inputs") + 1);
  });

  test("a watcher-drop patch refusal rescans and names itself in the log", async () => {
    const effects = new RecordingEffects({ patchReason: "watcher-drop" });
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls.slice(-3)).toEqual(["install-patch:4", "scan-local", "log:pull local=trusted fallback=watcher-drop"]);
    expect(receipt.fallback).toBe("watcher-drop");
  });

  test("a git-topology change rescans instead of patching", async () => {
    const effects = new RecordingEffects({ topologyChanged: true });
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls).not.toContain("install-patch:4");
    expect(effects.calls.slice(-2)).toEqual(["scan-local", "log:pull local=trusted fallback=git-topology"]);
    expect(receipt.fallback).toBe("git-topology");
  });

  test("chain repair reported by the port suppresses the patch", async () => {
    const effects = new RecordingEffects({
      outcomeFor: async (request) => ({ kind: "applied", attemptId: request.attemptId, actions: [], chainRepaired: true }),
    });
    await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(effects.calls).not.toContain("install-patch:4");
    expect(effects.calls.at(-1)).toBe("log:pull local=trusted fallback=chain-repair");
  });

  test("each pull is sealed under a fresh parent identity", async () => {
    const effects = new RecordingEffects();
    const transition = new ApplyRemoteWorkspaceTransition(effects);
    const first = await transition.apply(effects);
    const second = await transition.apply(effects);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.children[0]).not.toBe(second.children[0]);
  });

  test("the receipt's effect list is exactly what was applied, in order", async () => {
    const effects = new RecordingEffects({ attemptInputs: inputs({ notifyPendingAt: 42 }) });
    const receipt = await new ApplyRemoteWorkspaceTransition(effects).apply(effects);
    expect(kinds(receipt.effects)).toEqual([
      "clear-chain-repair",
      "record-propagation",
      "settle-report",
      "adopt-post-base",
      "install-pull-patch",
      "log",
    ]);
  });
});
