import { expect, test } from "bun:test";
import type { DiscoveredGitRepo } from "../../engine/index.js";
import type { RepoCandidateWork } from "./git-ref-watch.js";
import {
  GitDiscoveryContinuity,
  type CurrentGitTopologyReceipt,
  type GitDiscoveryEffects,
  type GitRefRegistryPort,
  type GitRegistryAction,
  type PlanTopologyGate,
} from "./git-discovery-continuity.js";

const dir = (relPath: string): DiscoveredGitRepo => ({ relPath, kind: "dir" });
const pointer = (relPath: string): DiscoveredGitRepo => ({ relPath, kind: "pointer" });
const candidate = (owner: string, discover: boolean): RepoCandidateWork => ({ owner, dirty: true, discover });
const gate = (over: Partial<PlanTopologyGate> = {}): PlanTopologyGate => ({
  topologyEpoch: 0,
  matcherGeneration: 7,
  watcherErrorGeneration: 3,
  watcherTrusted: true,
  matcherRebuildPending: false,
  policyRecyclePending: false,
  queuedCandidateWork: false,
  ...over,
});

interface FakeRegistry extends GitRefRegistryPort {
  readonly calls: GitRegistryAction[];
  floorRequired: boolean;
  inputEpoch: number;
  closed: boolean;
}

function fakeRegistry(): FakeRegistry {
  const calls: GitRegistryAction[] = [];
  const registry: FakeRegistry = {
    calls,
    floorRequired: false,
    inputEpoch: 11,
    closed: false,
    beginSnapshot: () => registry.inputEpoch,
    async upsert(repos) {
      calls.push({ kind: "upsert", repos: repos.map((repo) => repo.relPath) });
    },
    async applySnapshot(repos, startEpoch, complete) {
      calls.push({ kind: "apply-snapshot", repos: repos.map((repo) => repo.relPath), startEpoch, complete });
    },
    async markCandidates(work) {
      calls.push({ kind: "mark-candidates", owners: work.map((item) => item.owner) });
    },
    async markAllCandidatesDirty() {
      calls.push({ kind: "mark-all-candidates-dirty" });
    },
    async close() {
      registry.closed = true;
    },
  };
  return registry;
}

interface Harness {
  continuity: GitDiscoveryContinuity;
  registry: FakeRegistry;
  logs: string[];
  pins: number;
  discoverAllCalls: number;
  discoveredUnder: string[];
}

function harness(options: {
  platform?: string;
  attach?: boolean;
  initial?: readonly DiscoveredGitRepo[];
  discoverAll?: () => Promise<readonly DiscoveredGitRepo[]>;
  discoverUnder?: (owner: string) => Promise<readonly DiscoveredGitRepo[]>;
} = {}): Harness {
  const registry = fakeRegistry();
  const state = { pins: 0, discoverAllCalls: 0 };
  const logs: string[] = [];
  const discoveredUnder: string[] = [];
  const effects: GitDiscoveryEffects = {
    platform: options.platform ?? "linux",
    createRefBackend: () => registry,
    discoverAll: () => {
      state.discoverAllCalls++;
      return options.discoverAll?.() ?? Promise.resolve([]);
    },
    discoverUnder: (owner) => {
      discoveredUnder.push(owner);
      return options.discoverUnder?.(owner) ?? Promise.resolve([]);
    },
    pinSafetyFloor: () => { state.pins++; },
    log: (line) => { logs.push(line); },
  };
  const continuity = new GitDiscoveryContinuity(effects);
  if (options.attach !== false) {
    void continuity.attachRefBackend({
      root: "/workspace",
      initial: options.initial ?? [],
      onSignal: () => {},
      onArmed: () => {},
      onLog: () => {},
    });
  }
  return {
    continuity,
    registry,
    logs,
    discoveredUnder,
    get pins() { return state.pins; },
    get discoverAllCalls() { return state.discoverAllCalls; },
  } as Harness;
}

function scan(
  continuity: GitDiscoveryContinuity,
  repos: readonly DiscoveredGitRepo[],
  scanKind: "safety scan" | "deep scan" | undefined,
  mode: "pruned" | "unpruned",
): Promise<CurrentGitTopologyReceipt> {
  return continuity.observe({ kind: "scan", repos, mode, snapshot: continuity.beginScanSnapshot(scanKind) });
}

// ── exact plan-topology certificate ──────────────────────────────────────────

test("a complete plan walk installs one frozen sorted certificate and every freshness gate fails closed", async () => {
  const h = harness();
  const repos = Array.from({ length: 125 }, (_, index) => dir(`repo-${String(124 - index).padStart(3, "0")}`));
  const witnessed = gate();
  await h.continuity.observe({ kind: "plan", repos, complete: true, gateBefore: witnessed, gateAfter: witnessed });

  const trusted = h.continuity.trustedTopologyForPlan(witnessed)!;
  expect(trusted).toHaveLength(125);
  expect(trusted[0]?.relPath).toBe("repo-000");
  expect(trusted[124]?.relPath).toBe("repo-124");
  expect(Object.isFrozen(trusted)).toBe(true);
  expect(Object.isFrozen(trusted[0])).toBe(true);

  const refused: PlanTopologyGate[] = [
    gate({ watcherTrusted: false }),
    gate({ watcherErrorGeneration: 4 }),
    gate({ matcherGeneration: 8 }),
    gate({ matcherRebuildPending: true }),
    gate({ policyRecyclePending: true }),
    gate({ queuedCandidateWork: true }),
    gate({ topologyEpoch: 1 }),
  ];
  for (const stale of refused) expect(h.continuity.trustedTopologyForPlan(stale)).toBeUndefined();

  await h.continuity.observe({ kind: "plan", repos: [], complete: false, gateBefore: witnessed, gateAfter: witnessed });
  expect(h.continuity.trustedTopologyForPlan(witnessed)).toBe(trusted);
  h.continuity.invalidatePlanTopology();
  expect(h.continuity.trustedTopologyForPlan(gate({ topologyEpoch: 1 }))).toBeUndefined();
});

test("candidate work is in-flight across awaited discovery and never certifies or removes topology", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ discoverUnder: async () => { await blocked; return []; } });
  const witnessed = gate();
  await h.continuity.observe({ kind: "plan", repos: [dir("kept")], complete: true, gateBefore: witnessed, gateAfter: witnessed });

  const observing = h.continuity.observe({ kind: "signal", discoverAll: false, candidates: [candidate("kept", true)] });
  expect(h.continuity.inFlightCandidateCount).toBe(1);
  expect(h.continuity.trustedTopologyForPlan(witnessed)).toBeUndefined();
  release();
  await observing;
  expect(h.continuity.authoritativeRepos).toEqual([]);
  expect(h.continuity.trustedTopologyForPlan(witnessed)?.map((repo) => repo.relPath)).toEqual(["kept"]);
});

test("a complete stable unpruned scan seeds the plan certificate; pruned and incomplete scans do not", async () => {
  const h = harness();
  const witnessed = gate();
  const completeSnapshot = h.continuity.beginScanSnapshot("deep scan", witnessed);
  await h.continuity.observe({ kind: "scan", repos: [dir("b"), pointer("a")], mode: "unpruned", snapshot: completeSnapshot, complete: true, gateAfter: witnessed });
  expect(h.continuity.trustedTopologyForPlan(witnessed)?.map((repo) => repo.relPath)).toEqual(["a", "b"]);

  h.continuity.invalidatePlanTopology();
  const next = gate({ topologyEpoch: 1 });
  await h.continuity.observe({ kind: "scan", repos: [dir("missed")], mode: "unpruned", snapshot: h.continuity.beginScanSnapshot("deep scan", next), complete: false, gateAfter: next });
  expect(h.continuity.trustedTopologyForPlan(next)).toBeUndefined();
  await h.continuity.observe({ kind: "scan", repos: [dir("pruned")], mode: "pruned", snapshot: h.continuity.beginScanSnapshot("safety scan", next), complete: true, gateAfter: next });
  expect(h.continuity.trustedTopologyForPlan(next)).toBeUndefined();
});

test("a failed scan observer and a race during plan observation retain no certificate", async () => {
  const scanHarness = harness();
  scanHarness.registry.applySnapshot = async () => { throw new Error("registry failed"); };
  const witnessed = gate();
  await expect(scanHarness.continuity.observe({
    kind: "scan",
    repos: [dir("scan")],
    mode: "unpruned",
    snapshot: scanHarness.continuity.beginScanSnapshot("deep scan", witnessed),
    complete: true,
    gateAfter: witnessed,
  })).rejects.toThrow("registry failed");
  expect(scanHarness.continuity.trustedTopologyForPlan(witnessed)).toBeUndefined();

  const planHarness = harness();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  planHarness.registry.upsert = async () => { await blocked; };
  const observing = planHarness.continuity.observe({ kind: "plan", repos: [dir("plan")], complete: true, gateBefore: witnessed, gateAfter: witnessed });
  planHarness.continuity.invalidatePlanTopology();
  release();
  await observing;
  expect(planHarness.continuity.trustedTopologyForPlan(gate({ topologyEpoch: 1 }))).toBeUndefined();
});

// ── absence authority ─────────────────────────────────────────────────────────

test("additive observations never authorize absence", async () => {
  const h = harness();
  const seeded = await scan(h.continuity, [dir("kept")], "safety scan", "unpruned");
  expect(seeded.absenceAuthority).toBe("authoritative");
  expect(h.continuity.absenceProof?.discoveredRepos).toEqual(new Set(["kept"]));

  const plan = await h.continuity.observe({ kind: "plan", repos: [dir("late")] });
  expect(plan.absenceAuthority).toBe("additive");
  expect(plan.absenceProof).toBe(h.continuity.absenceProof);

  const signal = await h.continuity.observe({ kind: "signal", discoverAll: false, candidates: [] });
  expect(signal.absenceAuthority).toBe("additive");
  expect(h.continuity.absenceProof?.discoveredRepos).toEqual(new Set(["kept"]));

  // A pruned walk does not report repositories under pruned subtrees, so it
  // retracts the standing proof instead of restating it.
  const pruned = await scan(h.continuity, [], "safety scan", "pruned");
  expect(pruned.absenceAuthority).toBe("additive");
  expect(pruned.absenceProof).toBeUndefined();
  expect(h.continuity.absenceProof).toBeUndefined();
});

test("every unpruned scan mints one fresh, exact absence proof", async () => {
  const h = harness();
  const first = await scan(h.continuity, [dir("a"), pointer("b")], "safety scan", "unpruned");
  const second = await scan(h.continuity, [dir("a")], undefined, "unpruned");
  expect(first.absenceProof?.epoch).toBe(1);
  expect(first.absenceProof?.discoveredRepos).toEqual(new Set(["a", "b"]));
  expect(second.absenceProof?.epoch).toBe(2);
  expect(second.absenceProof?.discoveredRepos).toEqual(new Set(["a"]));
  expect(h.continuity.absenceProof).toBe(second.absenceProof!);
});

// ── topology continuity ───────────────────────────────────────────────────────

test("only a scan-kind unpruned walk may shrink topology; the first unpruned walk seeds it", async () => {
  const h = harness();
  await h.continuity.observe({ kind: "plan", repos: [dir("plan-only")] });
  expect(h.continuity.floorRequired).toBe(true);

  const seeded = await scan(h.continuity, [pointer("seed")], undefined, "unpruned");
  expect(seeded.topology).toBe("seeded");
  expect(h.continuity.authoritativeRepos.map((repo) => repo.relPath)).toEqual(["seed"]);
  // Seeding is additive: it neither clears the plan pin nor claims a snapshot.
  expect(h.continuity.floorRequired).toBe(true);
  expect(seeded.registryActions).toEqual([{ kind: "upsert", repos: ["seed"] }]);

  const again = await scan(h.continuity, [pointer("other")], undefined, "unpruned");
  expect(again.topology).toBe("additive");
  expect(h.continuity.authoritativeRepos.map((repo) => repo.relPath)).toEqual(["seed"]);

  const shrunk = await scan(h.continuity, [pointer("survivor")], "deep scan", "unpruned");
  expect(shrunk.topology).toBe("shrinking-snapshot");
  expect(h.continuity.authoritativeRepos.map((repo) => repo.relPath)).toEqual(["survivor"]);
  expect(h.continuity.floorRequired).toBe(false);
});

test("a pruned scan leaves authoritative topology byte-exact", async () => {
  const h = harness();
  await scan(h.continuity, [dir("a"), pointer("b")], "safety scan", "unpruned");
  const before = h.continuity.authoritativeRepos;
  const receipt = await scan(h.continuity, [], "safety scan", "pruned");
  expect(receipt.topology).toBe("additive");
  expect(h.continuity.authoritativeRepos).toBe(before);
  expect(h.continuity.hasAuthoritativeSnapshot).toBe(true);
});

test("repositories are ordered by owner before any topology or registry effect", async () => {
  const h = harness();
  const receipt = await scan(h.continuity, [dir("b/c"), dir("a")], "safety scan", "unpruned");
  expect(h.continuity.authoritativeRepos.map((repo) => repo.relPath)).toEqual(["a", "b/c"]);
  expect(receipt.registryActions).toEqual([
    { kind: "apply-snapshot", repos: ["a", "b/c"], startEpoch: 11, complete: true },
  ]);
});

// ── registry actions ──────────────────────────────────────────────────────────

test("the scan snapshot token binds the walk's scan kind to the registry epoch it started under", async () => {
  const h = harness();
  const token = h.continuity.beginScanSnapshot("safety scan");
  expect(token).toEqual({ scanKind: "safety scan", registryEpoch: 11 });
  h.registry.inputEpoch = 40; // concurrent arming during the walk
  const receipt = await h.continuity.observe({ kind: "scan", repos: [dir("r")], mode: "unpruned", snapshot: token });
  expect(receipt.registryActions).toEqual([
    { kind: "apply-snapshot", repos: ["r"], startEpoch: 11, complete: true },
  ]);

  // No scan kind means no snapshot horizon, so the walk can only be additive.
  const untokened = h.continuity.beginScanSnapshot(undefined);
  expect(untokened).toEqual({ scanKind: undefined, registryEpoch: undefined });
});

test("a full-discovery signal batch marks everything dirty and upserts only what it found", async () => {
  const found = harness({ discoverAll: async () => [dir("found")] });
  const receipt = await found.continuity.observe({ kind: "signal", discoverAll: true, candidates: [candidate("ignored", true)] });
  expect(found.discoverAllCalls).toBe(1);
  expect(found.discoveredUnder).toEqual([]);
  expect(receipt.registryActions).toEqual([
    { kind: "mark-all-candidates-dirty" },
    { kind: "upsert", repos: ["found"] },
  ]);

  const empty = harness();
  const emptyReceipt = await empty.continuity.observe({ kind: "signal", discoverAll: true, candidates: [] });
  expect(emptyReceipt.registryActions).toEqual([{ kind: "mark-all-candidates-dirty" }]);
});

test("a targeted signal batch discovers each distinct discover-flagged owner once, in order", async () => {
  const h = harness({ discoverUnder: async (owner) => [dir(`${owner}/nested`)] });
  const receipt = await h.continuity.observe({
    kind: "signal",
    discoverAll: false,
    candidates: [candidate("z", true), candidate("a", true), candidate("z", true), candidate("skip", false)],
  });
  expect(h.discoveredUnder).toEqual(["a", "z"]);
  expect(h.discoverAllCalls).toBe(0);
  expect(receipt.registryActions).toEqual([
    { kind: "mark-candidates", owners: ["z", "a", "z", "skip"] },
    { kind: "upsert", repos: ["a/nested", "z/nested"] },
  ]);
});

test("a failed candidate discovery is reported by errno and never thrown or floor-changing", async () => {
  const h = harness({
    discoverUnder: async () => { throw Object.assign(new Error("/abs/path"), { code: "EACCES" }); },
  });
  const receipt = await h.continuity.observe({ kind: "signal", discoverAll: false, candidates: [candidate("a", true)] });
  expect(receipt.registryActions).toEqual([
    { kind: "mark-candidates", owners: ["a"] },
    { kind: "discovery-failed", code: "EACCES" },
  ]);
  expect(h.logs).toEqual(["git ref candidate discovery failed: EACCES"]);
  expect(h.continuity.floorRequired).toBe(false);
});

test("without a ref backend a signal batch performs no discovery at all", async () => {
  const h = harness({ attach: false, discoverAll: async () => [dir("unseen")] });
  const receipt = await h.continuity.observe({ kind: "signal", discoverAll: true, candidates: [] });
  expect(receipt.registryActions).toEqual([]);
  expect(h.discoverAllCalls).toBe(0);
});

// ── safety-floor continuity ───────────────────────────────────────────────────

test("each floor input holds the floor independently and releases only when all are gone", async () => {
  const h = harness();
  h.continuity.noteRefBackendUnavailable();
  expect(h.continuity.floorRequired).toBe(true);
  expect(h.pins).toBe(1);

  // A complete snapshot is the only input that can retire the backend-fallback
  // and plan claims; the registry's own claim outlives it.
  h.registry.floorRequired = true;
  await h.continuity.observe({ kind: "plan", repos: [dir("d")] });
  await scan(h.continuity, [], "safety scan", "unpruned");
  expect(h.continuity.floorRequired).toBe(true);

  h.registry.floorRequired = false;
  h.continuity.refreshFloor("registry");
  expect(h.continuity.floorRequired).toBe(false);

  // A pointer-backed repository never holds the floor.
  await scan(h.continuity, [pointer("p")], "safety scan", "unpruned");
  expect(h.continuity.floorRequired).toBe(false);
});

test("the floor logs and pins only on transition", async () => {
  const h = harness();
  await h.continuity.observe({ kind: "plan", repos: [dir("a")] });
  await h.continuity.observe({ kind: "plan", repos: [dir("b")] });
  expect(h.pins).toBe(1);
  expect(h.logs).toEqual(["git safety floor required: plan-discovery"]);

  await scan(h.continuity, [], "deep scan", "unpruned");
  expect(h.pins).toBe(1);
  expect(h.logs).toEqual([
    "git safety floor required: plan-discovery",
    "git safety floor released: deep scan-snapshot",
  ]);
});

test("off Linux no discovery input ever pins the safety floor", async () => {
  const h = harness({ platform: "darwin" });
  h.continuity.noteRefBackendUnavailable();
  h.registry.floorRequired = true;
  await h.continuity.observe({ kind: "plan", repos: [dir("a")] });
  await scan(h.continuity, [dir("b")], "safety scan", "unpruned");
  expect(h.continuity.floorRequired).toBe(false);
  expect(h.pins).toBe(0);
  expect(h.logs).toEqual([]);
});

// ── backend lifecycle ─────────────────────────────────────────────────────────

test("attaching the ref backend arms the watcher's own start-up discoveries", async () => {
  const h = harness({ attach: false });
  expect(h.continuity.refBackendAttached).toBe(false);
  await h.continuity.attachRefBackend({
    root: "/workspace",
    initial: [dir("start-up")],
    onSignal: () => {},
    onArmed: () => {},
    onLog: () => {},
  });
  expect(h.continuity.refBackendAttached).toBe(true);
  expect(h.registry.calls).toEqual([{ kind: "upsert", repos: ["start-up"] }]);
  // Arming is the registry's business: adoption alone claims no floor.
  expect(h.continuity.floorRequired).toBe(false);
  expect(h.pins).toBe(0);
});

test("replacement closes the old ref registry before the candidate is armed", async () => {
  const old = fakeRegistry();
  const candidate = fakeRegistry();
  let created = 0;
  const originalUpsert = candidate.upsert.bind(candidate);
  candidate.upsert = async (repos) => {
    expect(old.closed).toBe(true);
    await originalUpsert(repos);
  };
  const continuity = new GitDiscoveryContinuity({
    platform: "linux",
    createRefBackend: () => created++ === 0 ? old : candidate,
    discoverAll: async () => [],
    discoverUnder: async () => [],
    pinSafetyFloor: () => {},
    log: () => {},
  });
  const attach = (initial: readonly DiscoveredGitRepo[]) => continuity.attachRefBackend({
    root: "/workspace", initial, onSignal: () => {}, onArmed: () => {}, onLog: () => {},
  });
  await attach([]);
  await attach([dir("new")]);
  expect(candidate.calls).toEqual([{ kind: "upsert", repos: ["new"] }]);
});

test("an abandoned ref backend closes and hands the floor back to the fallback claim", async () => {
  const h = harness();
  await h.continuity.abandonRefBackend();
  expect(h.registry.closed).toBe(true);
  expect(h.continuity.floorRequired).toBe(true);
  const receipt = await h.continuity.observe({ kind: "signal", discoverAll: true, candidates: [] });
  expect(receipt.registryActions).toEqual([]);
});

test("off Linux an abandoned ref backend claims nothing", async () => {
  const h = harness({ platform: "darwin" });
  await h.continuity.abandonRefBackend();
  expect(h.registry.closed).toBe(true);
  expect(h.continuity.floorRequired).toBe(false);
  expect(h.logs).toEqual([]);
});
