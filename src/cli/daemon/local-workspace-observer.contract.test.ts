import { afterAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirCache, HashCache, buildIgnoreMatcher, type FileEntry, type IgnoreMatcher, type Manifest, type WatchEvent } from "../../engine/index.js";
import type { ManifestUpdate } from "./manifest-update.js";
import {
  LocalRetryQueue,
  LocalWorkspaceObserver,
  type LocalObservationEffects,
  type ScanGenerationPlan,
  type SealedLocalObservationReceipt,
} from "./local-workspace-observer.js";
import type { CurrentGitTopologyObservation, CurrentGitTopologyReceipt, GitScanKind, ScanTopologySnapshot } from "./git-discovery-continuity.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-observer-"));
  roots.push(root);
  return root;
}

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 1, type: "file" });
const manifestOf = (...paths: string[]): Manifest => ({ generatedAt: "t", files: paths.map(entry) });
const change = (relPath: string): WatchEvent => ({ relPath, kind: "change" });

interface Install {
  next: Manifest;
  update: ManifestUpdate;
  unsettled: { rebuildFrom?: ReadonlySet<string>; settle?: Iterable<string>; add?: Iterable<string> };
  observedUnder?: number;
}

interface Harness {
  observer: LocalWorkspaceObserver;
  retries: LocalRetryQueue;
  installs: Install[];
  topology: CurrentGitTopologyObservation[];
  snapshots: (GitScanKind | undefined)[];
  completeness: boolean[];
  walkedPaths: string[][];
  patchedEvents: WatchEvent[][];
  requeued: string[][];
  unsettledMarks: string[];
  logs: string[];
  generation: number;
  stopped: boolean;
  manifest: Manifest;
  complete: boolean;
  revision: number;
}

function harness(options: {
  root: string;
  manifest?: Manifest;
  matcher?: IgnoreMatcher;
  /** Result of each successive tree walk: files observed, paths it could not read. */
  walk?: (call: number) => { files: string[]; defer?: string[]; duringWalk?: (h: Harness) => void };
  patch?: (events: WatchEvent[]) => { files: string[]; defer?: string[] };
  scanMode?: "pruned" | "unpruned";
}): Harness {
  let walkCall = 0;
  let sharedDircache: DirCache | undefined;
  // `h` is late-bound: the effects/retry closures below read it, but none of them
  // RUN until the observer they are handed to is driven by a test — well after the
  // assignment at the bottom. That ordering is what lets every field be real.
  let h: Harness;
  const state = {
    installs: [],
    topology: [],
    snapshots: [],
    completeness: [],
    walkedPaths: [],
    patchedEvents: [],
    requeued: [],
    unsettledMarks: [],
    logs: [],
    generation: 7,
    stopped: false,
    manifest: options.manifest ?? manifestOf(),
    complete: true,
    revision: 0,
  };
  const retries = new LocalRetryQueue({
    requeue: (paths) => h.requeued.push([...paths]),
    markUnsettled: (p) => h.unsettledMarks.push(p),
    stopped: () => h.stopped,
  });
  const effects: LocalObservationEffects = {
    root: options.root,
    currentManifest: () => h.manifest,
    currentMatcher: () => options.matcher ?? buildIgnoreMatcher(options.root),
    dircache: () => (sharedDircache ??= new DirCache()),
    matcherGeneration: () => h.generation,
    scanMode: () => options.scanMode ?? "unpruned",
    beginTopologySnapshot: (scanKind): ScanTopologySnapshot => {
      h.snapshots.push(scanKind);
      return { scanKind, registryEpoch: scanKind ? 42 : undefined };
    },
    observeTopology: async (observation): Promise<CurrentGitTopologyReceipt> => {
      h.topology.push(observation);
      return { kind: observation.kind, absenceAuthority: "authoritative", topology: "shrinking-snapshot", registryActions: [], floorRequired: false };
    },
    // The LOCAL-authority seam is a sealed commit intent (`CommitLocalObservation`);
    // this harness records the SAME facts the previous install/completeness effects
    // carried, so every assertion below still reads the observer's own output.
    authority: {
      snapshot: () => ({ lineageToken: "harness", localRevision: h.revision }),
      commitObservation: (intent) => {
        h.installs.push({ next: intent.next, update: intent.update, unsettled: intent.unsettled, observedUnder: intent.observedUnderMatcherGeneration });
        if (intent.completeness !== undefined) {
          h.completeness.push(intent.completeness === "complete");
          h.complete = intent.completeness === "complete";
        }
        h.manifest = intent.next;
        h.revision += 1;
        return { observationId: intent.identity.observationId, outcome: "advanced", localRevision: h.revision, observationComplete: h.complete };
      },
      get observationComplete() { return h.complete; },
    },
    log: (line) => h.logs.push(line),
    recordScanFault: () => {},
    scanTree: (async (_root, _matcher, _cache, _onProgress, _onGitRepo, _stats, deferred) => {
      const result = options.walk?.(walkCall++) ?? { files: [] };
      h.walkedPaths.push([...result.files]);
      for (const p of result.defer ?? []) deferred?.add(p);
      result.duringWalk?.(h);
      return manifestOf(...result.files);
    }) as LocalObservationEffects["scanTree"],
    patchEvents: (async (base, _root, _matcher, events, _cache, deferred) => {
      h.patchedEvents.push([...events]);
      const result = options.patch?.(events) ?? { files: base.files.map((f) => f.path) };
      for (const p of result.defer ?? []) deferred?.add(p);
      return manifestOf(...result.files);
    }) as LocalObservationEffects["patchEvents"],
  };
  h = { ...state, retries, observer: new LocalWorkspaceObserver(effects, retries) };
  return h;
}

const scanPlan = (h: Harness, over: { scanKind?: GitScanKind; mode?: "pruned" | "unpruned" } = {}): ScanGenerationPlan => {
  // `scanKind` must stay ABSENT when unset — its presence is what marks a plan as
  // a git-observing scan — so it is assigned, not conditionally spread.
  const plan: ScanGenerationPlan = {
    kind: "scan",
    cache: new HashCache(),
    previous: h.manifest,
    mode: over.mode ?? "unpruned",
  };
  return over.scanKind ? { ...plan, scanKind: over.scanKind } : plan;
};

test("a deferred scan cannot claim absence: completeness drops and the unread cursor survives install", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt", "b.txt"), walk: () => ({ files: ["a.txt"], defer: ["b.txt"] }) });

  const receipt = await h.observer.observe(scanPlan(h, { scanKind: "safety scan" }));

  expect(receipt.completeness).toBe("deferred");
  expect([...receipt.deferredPaths]).toEqual(["b.txt"]);
  expect(h.completeness).toEqual([false]);
  // The install must re-derive the unsettled set FROM the deferred cursor, and the
  // deferred path must carry its previous entry rather than read as deleted.
  const install = h.installs[0]!;
  expect([...(install.unsettled.rebuildFrom ?? [])]).toEqual(["b.txt"]);
  expect(install.next.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  expect(install.update).toMatchObject({ kind: "full-workspace" });
});

test("a complete scan restores observation completeness and installs the walk's own manifest", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt", "b.txt"), walk: () => ({ files: ["a.txt"] }) });

  const receipt = await h.observer.observe(scanPlan(h, { scanKind: "deep scan" }));

  expect(receipt.completeness).toBe("complete");
  expect(h.completeness).toEqual([true]);
  expect(h.installs[0]!.next.files.map((f) => f.path)).toEqual(["a.txt"]);
  expect(receipt.freshManifest?.files.map((f) => f.path)).toEqual(["a.txt"]);
  expect(receipt.retriesArmed).toEqual([]);
});

test("the scan forwards its topology observation with the horizon sealed BEFORE the walk", async () => {
  const root = await tempRoot();
  const h = harness({ root, walk: () => ({ files: [] }) });

  const receipt = await h.observer.observe(scanPlan(h, { scanKind: "safety scan", mode: "pruned" }));

  expect(h.snapshots).toEqual(["safety scan"]);
  expect(h.topology).toEqual([{ kind: "scan", repos: [], mode: "pruned", snapshot: { scanKind: "safety scan", registryEpoch: 42 }, complete: true }]);
  expect(receipt.topology?.kind).toBe("scan");
  // Coverage originates from the dircache, never from the plan's prune request.
  expect(receipt.coverage).toBe("full-tree");
});

test("design 206 §2: the matcher generation is captured before the walk, so a rebuild mid-walk leaves the stamp stale", async () => {
  const root = await tempRoot();
  const h = harness({ root, walk: () => ({ files: ["a.txt"], duringWalk: (self) => { self.generation = 99; } }) });

  const receipt = await h.observer.observe(scanPlan(h, { scanKind: "safety scan" }));

  expect(receipt.matcherGeneration).toBe(7);
  expect(h.installs[0]!.observedUnder).toBe(7);
  expect(h.generation).toBe(99);
});

test("a watcher patch observes only the named paths and never walks the tree", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt"), patch: () => ({ files: ["a.txt", "new.txt"] }) });

  const receipt = await h.observer.observe({ kind: "watch-batch", events: [change("new.txt")], cache: new HashCache() });

  expect(receipt.scope).toBe("named-paths");
  expect(h.walkedPaths).toEqual([]);
  expect(h.topology).toEqual([]);
  expect(h.patchedEvents).toEqual([[change("new.txt")]]);
  const install = h.installs[0]!;
  expect(install.update).toEqual({ kind: "partial", source: "watch-events", paths: new Set(["new.txt"]) });
  expect(install.unsettled.rebuildFrom).toBeUndefined();
  expect([...(install.unsettled.settle ?? [])]).toEqual(["new.txt"]);
  expect([...(install.unsettled.add ?? [])]).toEqual([]);
  // A partial patch carries NO observation generation: only a full-workspace
  // observation may re-stamp P7 provenance.
  expect(install.observedUnder).toBeUndefined();
});

test("a deferred watcher path joins the unsettled set instead of settling", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt"), patch: () => ({ files: ["a.txt"], defer: ["a.txt"] }) });

  const receipt = await h.observer.observe({ kind: "watch-batch", events: [change("a.txt")], cache: new HashCache() });

  expect([...(h.installs[0]!.unsettled.settle ?? [])]).toEqual([]);
  expect([...(h.installs[0]!.unsettled.add ?? [])]).toEqual(["a.txt"]);
  expect(receipt.retriesPending).toEqual([]);
  expect(receipt.completeness).toBe("deferred");
});

test("collision facts stay bounded: the rescan fires only for an incomplete observation with a standing collision", async () => {
  const root = await tempRoot();
  const collide = () => ({ files: ["A.txt", "a.txt"] });
  const h = harness({ root, manifest: manifestOf(), patch: collide, walk: () => ({ files: ["A.txt", "a.txt"], defer: ["late.txt"] }) });

  // Complete observation: a collision alone does not authorize a full walk.
  const clean = await h.observer.observe({ kind: "watch-batch", events: [change("A.txt")], cache: new HashCache() });
  expect(clean.collisionRescan).toBeUndefined();
  expect(h.walkedPaths).toEqual([]);

  // Incomplete observation + standing collision: reunite the omitted groups.
  h.complete = false;
  const rescanned = await h.observer.observe({ kind: "watch-batch", events: [change("a.txt")], cache: new HashCache() });
  // The rescan carries its OWN full-workspace receipt; the patch receipt never
  // widens its own scope by borrowing it.
  expect(rescanned.scope).toBe("named-paths");
  expect(rescanned.collisionRescan?.scope).toBe("full-workspace");
  expect(rescanned.collisionRescan?.coverage).toBe("full-tree");
  expect(h.walkedPaths).toEqual([["A.txt", "a.txt"]]);
  // The nested walk's own unread cursor merges into the batch receipt.
  expect([...rescanned.deferredPaths]).toEqual(["late.txt"]);
  // …and the nested scan is a full-workspace install stacked ON TOP of the patch.
  expect(h.installs.map((i) => i.update.kind)).toEqual(["partial", "partial", "full-workspace"]);
});

test("retry facts are exact: a scan arms write-finish for exactly its unread cursor", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt"), walk: () => ({ files: ["a.txt"], defer: ["a.txt"] }) });

  const receipt = await h.observer.observe(scanPlan(h, { scanKind: "safety scan" }));

  expect(receipt.retriesArmed).toEqual(["a.txt"]);
  expect([...h.retries.deferredPaths]).toEqual(["a.txt"]);
  expect(h.unsettledMarks).toEqual([]);
  h.retries.stop();
  expect([...h.retries.deferredPaths]).toEqual([]);
});

test("retry facts are exact: a watcher batch settles cleanly-read paths and arms only the remainder", async () => {
  const root = await tempRoot();
  const h = harness({ root, manifest: manifestOf("a.txt", "b.txt"), patch: () => ({ files: ["a.txt", "b.txt"], defer: ["b.txt"] }) });

  const receipt = await h.observer.observe({ kind: "watch-batch", events: [change("a.txt"), change("b.txt")], cache: new HashCache() });

  // Nothing armed until the caller has resolved drift against this cursor.
  expect([...h.retries.deferredPaths]).toEqual([]);
  expect(receipt.retriesPending).toEqual(["a.txt"]);

  h.observer.settleRetries(receipt);
  expect([...h.retries.deferredPaths]).toEqual(["b.txt"]);
  h.retries.stop();
});

test("the per-path write-finish budget is bounded and a give-up path is recorded as unobserved", async () => {
  const root = await tempRoot();
  const h = harness({ root });

  for (let i = 0; i < 15; i++) h.retries.scheduleWriteFinish(new Set(["hot.txt"]));
  expect([...h.retries.deferredPaths]).toEqual(["hot.txt"]);
  expect(h.unsettledMarks).toEqual([]);

  h.retries.scheduleWriteFinish(new Set(["hot.txt"]));
  expect([...h.retries.deferredPaths]).toEqual([]);
  expect(h.unsettledMarks).toEqual(["hot.txt"]);

  // Settling resets the budget: the same path may retry again after a clean read.
  h.retries.settle("hot.txt");
  h.retries.scheduleWriteFinish(new Set(["hot.txt"]));
  expect([...h.retries.deferredPaths]).toEqual(["hot.txt"]);
  h.retries.stop();
});

test("a write-finish wakeup releases its paths and requeues them exactly once", async () => {
  const root = await tempRoot();
  const h = harness({ root });

  h.retries.scheduleWriteFinish(new Set(["a.txt"]));
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(h.requeued).toEqual([["a.txt"]]);
  expect([...h.retries.deferredPaths]).toEqual([]);
});

test("a stopped daemon arms no wakeup, and a GC fence holds its paths without a hot retry", async () => {
  const root = await tempRoot();
  const h = harness({ root });

  h.retries.scheduleGcFence(new Set(["fenced.txt"]));
  expect([...h.retries.gcFencedPaths]).toEqual(["fenced.txt"]);
  expect([...h.retries.deferredPaths]).toEqual(["fenced.txt"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(h.requeued).toEqual([]);

  h.stopped = true;
  h.retries.scheduleWriteFinish(new Set(["late.txt"]));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(h.requeued).toEqual([]);
  h.retries.stop();
  expect([...h.retries.gcFencedPaths]).toEqual([]);
});

test("every receipt is bound to exactly one plan execution", async () => {
  const root = await tempRoot();
  const h = harness({ root, walk: () => ({ files: [] }) });

  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const receipt: SealedLocalObservationReceipt = await h.observer.observe(scanPlan(h, { scanKind: "safety scan" }));
    expect(seen.has(receipt.observationId)).toBe(false);
    seen.add(receipt.observationId);
  }
});
