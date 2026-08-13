import { describe, expect, test } from "bun:test";
import type { IgnoreMatcher } from "../../engine/index.js";
import type { GitSignalBatch, WatchOptions, Watcher } from "./watcher.js";
import {
  WatcherRecoveryScanError,
  WatcherSessionSupervisor,
  type WatcherAttemptWitness,
  type WatcherRecoveryScanReceipt,
  type WatcherRearmClock,
  type WatcherRearmTimer,
} from "./watcher-session-supervisor.js";

const matcher: IgnoreMatcher = { ignores: () => false, prunes: () => false };

class FakeClock implements WatcherRearmClock {
  readonly pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  setTimeout(fn: () => void, ms: number): WatcherRearmTimer {
    const item = { fn, ms, cleared: false, cancel: () => { item.cleared = true; } };
    this.pending.push(item);
    return item;
  }
  delays(): number[] { return this.pending.filter((item) => !item.cleared).map((item) => item.ms); }
  fire(): void {
    const item = this.pending.find((candidate) => !candidate.cleared);
    if (!item) throw new Error("no live timer");
    item.cleared = true;
    item.fn();
  }
}

interface Harness {
  supervisor: WatcherSessionSupervisor;
  clock: FakeClock;
  state: {
    matcherGen: number;
    errorGen: number;
    admission: string[];
    authorityFingerprint: string;
    nativeCoverage: "complete" | "structural-conflict";
    enabled: boolean;
    stopped: boolean;
    published: number[];
    scans: number;
    events: number;
    raw: number;
    errors: number;
    gitBatches: number;
    closes: number;
    debouncerDisposals: number;
    order: string[];
    starts: WatchOptions[];
    debouncerCallbacks: Array<(batch: GitSignalBatch) => void>;
  };
  beforeArm?: (opts: WatchOptions) => void;
  afterArm?: (opts: WatchOptions) => void | Promise<void>;
  attachRef?: () => Promise<void>;
  startError?: Error;
  backend?: Watcher["backend"];
}

function harness(): Harness {
  const clock = new FakeClock();
  const state: Harness["state"] = {
    matcherGen: 0,
    errorGen: 0,
    admission: ["old"],
    authorityFingerprint: "rules-v1",
    nativeCoverage: "complete",
    enabled: true,
    stopped: false,
    published: [],
    scans: 0,
    events: 0,
    raw: 0,
    errors: 0,
    gitBatches: 0,
    closes: 0,
    debouncerDisposals: 0,
    order: [],
    starts: [],
    debouncerCallbacks: [],
  };
  const h = { clock, state } as Harness;
  h.supervisor = new WatcherSessionSupervisor({
    root: "/workspace",
    rebuildArmAuthority: () => ({
      matcherGeneration: ++state.matcherGen,
      admission: [...state.admission],
      authorityFingerprint: state.authorityFingerprint,
      coverage: state.nativeCoverage,
      matcher,
    }),
    readArmCertification: () => ({
      admission: [...state.admission],
      authorityFingerprint: state.authorityFingerprint,
      coverage: state.nativeCoverage,
    }),
    errorGeneration: () => state.errorGen,
    matcherGeneration: () => state.matcherGen,
    retrustEnabled: () => state.enabled,
    stopped: () => state.stopped,
    onEvents: (events) => { state.events += events.length; },
    onRawEvent: () => { state.raw++; },
    onError: () => { state.errors++; state.errorGen++; },
    onGitBatch: () => { state.gitBatches++; },
    attachRefBackend: async () => { state.order.push("attach-ref"); await h.attachRef?.(); },
    detachRefBackend: async () => { state.order.push("detach-ref"); },
    abandonRefBackend: async () => { state.order.push("abandon-ref"); },
    noteRefBackendUnavailable: () => { state.order.push("ref-unavailable"); },
    requestFullScan: () => { state.scans++; },
    publishTrust: (generation) => { state.published.push(generation); },
    sessionInstalled: () => { state.order.push("install-session"); },
    watchUnavailable: () => { state.order.push("unavailable"); },
    log: () => {},
    clock,
    createDebouncer: (onBatch) => {
      state.debouncerCallbacks.push(onBatch);
      return { push: () => {}, dispose: () => { state.debouncerDisposals++; } };
    },
    startWatcher: async (_root, _matcher, onSettle, opts = {}) => {
      state.starts.push(opts);
      h.beforeArm?.(opts);
      opts.onArm?.();
      await h.afterArm?.(opts);
      if (h.startError) throw h.startError;
      await opts.onInitialGitRepos?.([]);
      const watcher: Watcher = {
        backend: h.backend ?? "parcel",
        close: async () => { state.closes++; },
      };
      // Retain the generation-fenced callbacks for lifecycle tests.
      Object.assign(opts, { __settle: onSettle });
      return watcher;
    },
  });
  h.supervisor.installForTest({ backend: "parcel", close: async () => { state.closes++; } });
  return h;
}

async function arm(h: Harness): Promise<WatcherAttemptWitness> {
  h.supervisor.fused();
  expect(h.clock.delays()).toEqual([120_000]);
  h.clock.fire();
  await h.supervisor.drainReplacement();
  const witness = h.supervisor.captureScanWitness();
  if (!witness) throw new Error("attempt did not arm");
  return witness;
}

function receipt(witness: WatcherAttemptWitness): WatcherRecoveryScanReceipt {
  return {
    witness,
    coverage: "full-tree",
    completeness: "complete",
    deferredPaths: new Set(),
    matcherGeneration: witness.matcherGeneration,
    commitDisposition: "advanced",
  };
}

describe("design 237 watcher re-arm publication", () => {
  test("happy Parcel attempt publishes only witnessed complete installed full-tree testimony", async () => {
    const h = harness();
    const witness = await arm(h);
    expect(h.state.scans).toBe(1);
    expect(witness.matcherGeneration).toBe(2); // post-arm recertified generation
    h.supervisor.settleScan(receipt(witness));
    expect(h.state.published).toEqual([0]);
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.supervisor.nextBackoffStep).toBe(0);
  });

  test("stale attempt receipts and throws are inert and consume no backoff", async () => {
    const h = harness();
    const witness = await arm(h);
    const stale = { ...witness, attemptId: "old-attempt" };
    h.supervisor.settleScan(receipt(stale));
    expect(h.supervisor.activeAttempt?.attemptId).toBe(witness.attemptId);
    expect(h.clock.delays()).toEqual([]);
    expect(h.supervisor.nextBackoffStep).toBe(1);
    expect(h.supervisor.scanThrew(new WatcherRecoveryScanError(new Error("old"), stale))).toBe(true);
    expect(h.clock.delays()).toEqual([]);
  });

  const failures: Array<{
    name: string;
    mutate(h: Harness, witness: WatcherAttemptWitness, value: WatcherRecoveryScanReceipt): void;
  }> = [
    { name: "session generation changed", mutate: (_h, witness, value) => { value.witness = { ...witness, sessionGen: witness.sessionGen + 1 }; } },
    { name: "watcher error since arm", mutate: (h) => { h.state.errorGen++; } },
    { name: "current matcher generation changed", mutate: (h) => { h.state.matcherGen++; } },
    { name: "scan matcher generation differs", mutate: (_h, _w, value) => { value.matcherGeneration++; } },
    { name: "coverage is pruned", mutate: (_h, _w, value) => { value.coverage = "pruned"; } },
    { name: "scan is incomplete", mutate: (_h, _w, value) => { value.completeness = "deferred"; } },
    { name: "scan has an unread cursor", mutate: (_h, _w, value) => { value.deferredPaths = new Set(["unread"]); } },
    { name: "complete scan was not installed", mutate: (_h, _w, value) => { value.commitDisposition = "stale-revision"; } },
    { name: "post-arm recertification is absent", mutate: (_h, witness, value) => { value.witness = { ...witness, recertified: false }; } },
    { name: "publication disk authority changed", mutate: (h) => { h.state.authorityFingerprint = "rules-v2"; } },
  ];
  for (const row of failures) test(`${row.name} remains fused and advances backoff`, async () => {
    const h = harness();
    const witness = await arm(h);
    const value = { ...receipt(witness) } as WatcherRecoveryScanReceipt & { witness: WatcherAttemptWitness };
    row.mutate(h, witness, value);
    h.supervisor.settleScan(value);
    expect(h.state.published).toEqual([]);
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.clock.delays()).toEqual([240_000]);
  });

  test("kill switch is checked at schedule, timer fire, and publication", async () => {
    const schedule = harness();
    schedule.state.enabled = false;
    schedule.supervisor.fused();
    expect(schedule.clock.delays()).toEqual([]);

    const firing = harness();
    firing.supervisor.fused();
    firing.state.enabled = false;
    firing.clock.fire();
    await firing.supervisor.drainReplacement();
    expect(firing.state.starts).toHaveLength(0);

    const publication = harness();
    const witness = await arm(publication);
    publication.state.enabled = false;
    publication.supervisor.settleScan(receipt(witness));
    expect(publication.state.published).toEqual([]);
    expect(publication.clock.delays()).toEqual([]);
  });

  test("daemon stop condition blocks publication and synchronously clears attempt", async () => {
    const h = harness();
    const witness = await arm(h);
    h.state.stopped = true;
    const stopping = h.supervisor.stop();
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.clock.delays()).toEqual([]);
    h.supervisor.settleScan(receipt(witness));
    await stopping;
    expect(h.state.published).toEqual([]);
  });
});

describe("design 237 arm ordering, lifecycle, and dispositions", () => {
  test("subscribe-window error invalidates because baseline predates native arm", async () => {
    const h = harness();
    h.beforeArm = (opts) => opts.onError?.(new Error("drop during subscribe"));
    h.supervisor.fused();
    h.clock.fire();
    await h.supervisor.drainReplacement();
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.state.scans).toBe(0);
    expect(h.clock.delays()).toEqual([240_000]);
  });

  test("arm receipt exists before Git discovery settles", async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    h.afterArm = () => blocked;
    h.supervisor.fused();
    h.clock.fire();
    for (let i = 0; i < 10 && !h.supervisor.activeAttempt; i++) await Promise.resolve();
    expect(h.supervisor.activeAttempt?.recertified).toBe(true);
    expect(h.supervisor.captureScanWitness()).toBeUndefined();
    expect(h.state.scans).toBe(0);
    release();
    await h.supervisor.drainReplacement();
    expect(h.state.scans).toBe(1);
  });

  test("matcher rebuild during subscribe or Git discovery invalidates eagerly", async () => {
    const duringSubscribe = harness();
    duringSubscribe.beforeArm = () => duringSubscribe.supervisor.matcherRebuilt();
    duringSubscribe.supervisor.fused();
    duringSubscribe.clock.fire();
    await duringSubscribe.supervisor.drainReplacement();
    expect(duringSubscribe.state.scans).toBe(0);
    expect(duringSubscribe.clock.delays()).toEqual([240_000]);

    const duringDiscovery = harness();
    duringDiscovery.afterArm = () => { duringDiscovery.supervisor.matcherRebuilt(); };
    duringDiscovery.supervisor.fused();
    duringDiscovery.clock.fire();
    await duringDiscovery.supervisor.drainReplacement();
    expect(duringDiscovery.state.scans).toBe(0);
    expect(duringDiscovery.clock.delays()).toEqual([240_000]);
    const invalid = duringDiscovery.state.starts[0]! as WatchOptions & { __settle(events: unknown[]): void };
    invalid.__settle([{ relPath: "late", kind: "change" }]);
    invalid.onRawEvent?.({ relPath: "late", kind: "change" });
    invalid.onError?.(new Error("late"));
    expect([duringDiscovery.state.events, duringDiscovery.state.raw, duringDiscovery.state.errors]).toEqual([0, 0, 0]);
  });

  test("step-0 uses newest disk admission and a step-0-to-arm rule change is rejected", async () => {
    const droppedEvent = harness();
    droppedEvent.state.admission = ["new-from-disk"];
    await arm(droppedEvent);
    expect(droppedEvent.state.starts[0]!.parcelAdmission).toEqual(["new-from-disk"]);

    const gap = harness();
    gap.beforeArm = () => { gap.state.admission = ["changed-in-gap"]; };
    gap.supervisor.fused();
    gap.clock.fire();
    await gap.supervisor.drainReplacement();
    expect(gap.supervisor.activeAttempt).toBeUndefined();
    expect(gap.state.scans).toBe(0);
    expect(gap.clock.delays()).toEqual([240_000]);
  });

  test("native structural conflicts make recovery terminal for this daemon lifetime", async () => {
    const initial = harness();
    initial.state.nativeCoverage = "structural-conflict";
    initial.supervisor.fused();
    initial.clock.fire();
    await initial.supervisor.drainReplacement();
    expect(initial.state.starts).toHaveLength(0);
    expect(initial.clock.delays()).toEqual([]);
    initial.supervisor.fused();
    expect(initial.clock.delays()).toEqual([]);

    const recertified = harness();
    recertified.beforeArm = () => { recertified.state.nativeCoverage = "structural-conflict"; };
    recertified.supervisor.fused();
    recertified.clock.fire();
    await recertified.supervisor.drainReplacement();
    expect(recertified.supervisor.activeAttempt).toBeUndefined();
    expect(recertified.clock.delays()).toEqual([]);
    recertified.supervisor.fused();
    expect(recertified.clock.delays()).toEqual([]);

    const publication = harness();
    const witness = await arm(publication);
    publication.state.nativeCoverage = "structural-conflict";
    publication.supervisor.settleScan(receipt(witness));
    expect(publication.supervisor.activeAttempt).toBeUndefined();
    expect(publication.clock.delays()).toEqual([]);
    publication.supervisor.fused();
    expect(publication.clock.delays()).toEqual([]);
  });

  test("fatal error aborts immediately; matched thrown scan backs off without escape", async () => {
    const fatal = harness();
    await arm(fatal);
    fatal.supervisor.fatalError();
    expect(fatal.supervisor.activeAttempt).toBeUndefined();
    expect(fatal.clock.delays()).toEqual([240_000]);

    const thrown = harness();
    const witness = await arm(thrown);
    expect(thrown.supervisor.scanThrew(new WatcherRecoveryScanError(new Error("walk failed"), witness))).toBe(true);
    expect(thrown.supervisor.activeAttempt).toBeUndefined();
    expect(thrown.clock.delays()).toEqual([240_000]);
  });

  test("backoff is 2m, 4m, 8m, then 30m forever and success resets it", async () => {
    const h = harness();
    const observed: number[] = [];
    h.supervisor.fused();
    for (let i = 0; i < 5; i++) {
      observed.push(h.clock.delays()[0]!);
      h.clock.fire();
      await h.supervisor.drainReplacement();
      const witness = h.supervisor.captureScanWitness()!;
      h.supervisor.settleScan({ ...receipt(witness), coverage: "pruned" });
    }
    expect(observed).toEqual([120_000, 240_000, 480_000, 1_800_000, 1_800_000]);
    h.clock.fire();
    await h.supervisor.drainReplacement();
    h.supervisor.settleScan(receipt(h.supervisor.captureScanWitness()!));
    expect(h.supervisor.nextBackoffStep).toBe(0);
  });

  test("replacement closes old watcher/ref/debouncer and fences every late callback", async () => {
    const h = harness();
    await h.supervisor.startBootSession();
    const old = h.state.starts[0]! as WatchOptions & { __settle(events: unknown[]): void };
    const before = { events: h.state.events, raw: h.state.raw, errors: h.state.errors, gitBatches: h.state.gitBatches };
    h.supervisor.fused();
    h.clock.fire();
    await h.supervisor.drainReplacement();
    old.__settle([{ relPath: "late", kind: "change" }]);
    old.onRawEvent?.({ relPath: "late", kind: "change" });
    old.onError?.(new Error("late"));
    h.state.debouncerCallbacks[0]?.({ reasons: { signal: true, candidate: false, other: false }, candidates: [], discoverAll: false });
    expect({ events: h.state.events, raw: h.state.raw, errors: h.state.errors, gitBatches: h.state.gitBatches }).toEqual(before);
    expect(h.state.closes).toBeGreaterThanOrEqual(2); // initial test session + boot session
    expect(h.state.debouncerDisposals).toBeGreaterThanOrEqual(1);
    expect(h.state.order.indexOf("detach-ref")).toBeLessThan(h.state.order.lastIndexOf("attach-ref"));
  });

  test("stop mid-replacement fences callbacks, clears recovery, and drains candidate cleanup", async () => {
    const h = harness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    h.afterArm = () => blocked;
    h.supervisor.fused();
    h.clock.fire();
    await Promise.resolve();
    const stopping = h.supervisor.stop();
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.clock.delays()).toEqual([]);
    release();
    await stopping;
    expect(h.supervisor.watcher).toBeUndefined();
    expect(h.state.scans).toBe(0);
  });

  test("stop during Git-ref attachment cannot reinstall the drained candidate", async () => {
    const h = harness();
    let release!: () => void;
    h.attachRef = () => new Promise<void>((resolve) => { release = resolve; });
    h.supervisor.fused();
    h.clock.fire();
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    const stopping = h.supervisor.stop();
    release();
    await stopping;
    expect(h.supervisor.watcher).toBeUndefined();
    expect(h.state.scans).toBe(0);
    expect(h.state.order).toContain("abandon-ref");
  });

  test("replacement startup failure cleans lifecycle resources and advances backoff", async () => {
    const h = harness();
    h.startError = new Error("discovery failed");
    h.supervisor.fused();
    h.clock.fire();
    await h.supervisor.drainReplacement();
    expect(h.supervisor.watcher).toBeUndefined();
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.clock.delays()).toEqual([240_000]);
    expect(h.state.debouncerDisposals).toBe(1);
    expect(h.state.order).toContain("abandon-ref");
  });

  test("chokidar stays terminal and never enters the supervisor", () => {
    const h = harness();
    h.supervisor.installForTest({ backend: "chokidar", close: async () => {} });
    h.supervisor.fused();
    expect(h.clock.delays()).toEqual([]);
  });

  test("a Parcel re-arm that resolves to Chokidar becomes terminal without retry", async () => {
    const h = harness();
    h.backend = "chokidar";
    h.supervisor.fused();
    h.clock.fire();
    await h.supervisor.drainReplacement();
    expect(h.supervisor.watcher?.backend).toBe("chokidar");
    expect(h.supervisor.activeAttempt).toBeUndefined();
    expect(h.clock.delays()).toEqual([]);
    expect(h.state.scans).toBe(0);
  });
});
