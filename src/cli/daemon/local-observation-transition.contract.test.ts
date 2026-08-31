import { afterAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirCache, HashCache, buildIgnoreMatcher, type FileEntry, type Manifest, type WatchEvent } from "../../engine/index.js";
import {
  LocalAuthority,
  sealLocalObservationIdentity,
  type LocalObservationCommitIntent,
} from "./local-observation-transition.js";
import { LocalRetryQueue, LocalWorkspaceObserver, type LocalObservationEffects } from "./local-workspace-observer.js";
import type { CurrentGitTopologyReceipt } from "./git-discovery-continuity.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-local-commit-"));
  roots.push(root);
  return root;
}

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 1, type: "file" });
const manifestOf = (...paths: string[]): Manifest => ({ generatedAt: "t", files: paths.map(entry) });
const change = (relPath: string): WatchEvent => ({ relPath, kind: "change" });

/** Seal an intent exactly as the observer does: identity captured against the
 *  lineage the observation STARTED under, digest derived from this payload. */
function intentOf(
  authority: LocalAuthority,
  observationId: string,
  payload: Omit<LocalObservationCommitIntent, "identity">,
  snapshot = authority.snapshot(),
): LocalObservationCommitIntent {
  return { ...payload, identity: sealLocalObservationIdentity(observationId, snapshot, payload) };
}

const fullScanPayload = (next: Manifest, deferred: ReadonlySet<string>, observedUnder: number): Omit<LocalObservationCommitIntent, "identity"> => ({
  next,
  update: { kind: "full-workspace", coverage: "full-tree", deferred },
  unsettled: { rebuildFrom: deferred },
  observedUnderMatcherGeneration: observedUnder,
  completeness: deferred.size === 0 ? "complete" : "deferred",
});

function seeded(seed = manifestOf("a.txt")): LocalAuthority {
  const authority = new LocalAuthority();
  authority.seed(seed);
  return authority;
}

// ── the transition itself ─────────────────────────────────────────────────────

test("a complete scan advances LOCAL exactly once: head, revision, completeness, and the P5/P7 provenance", () => {
  const authority = seeded();
  const before = authority.snapshot();

  const receipt = authority.commitObservation(
    intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt", "b.txt"), new Set(), 7)),
  );

  expect(receipt.outcome).toBe("advanced");
  expect(receipt.localRevision).toBe(before.localRevision + 1);
  expect(authority.manifest.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  expect(authority.observationComplete).toBe(true);
  expect(authority.unsettledPaths.size).toBe(0);
  // P5 and design 206 §2's P7 stamp are advanced by this transition alone.
  expect(authority.fullWorkspaceSinceSeed).toBe(true);
  expect(authority.observedMatcherGeneration).toBe(7);
  expect(authority.lastUpdate).toMatchObject({ kind: "full-workspace", coverage: "full-tree" });
  // Exactly once: the revision is the count of advances, not of commit attempts.
  expect(authority.snapshot().localRevision).toBe(before.localRevision + 1);
});

test("an incomplete scan cannot authorize deletion: completeness drops and every unread path stays unsettled", () => {
  const authority = seeded(manifestOf("a.txt", "gone.txt"));
  // The walk did not read gone.txt, so its manifest still carries the prior entry.
  const deferred = new Set(["gone.txt"]);

  authority.commitObservation(intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt", "gone.txt"), deferred, 7)));

  expect(authority.observationComplete).toBe(false);
  expect([...authority.unsettledPaths]).toEqual(["gone.txt"]);
  // The path is present in head (never read as deleted) AND withheld from any
  // trusted projection, so no consumer of LOCAL may plan its removal.
  expect(authority.manifest.files.map((f) => f.path)).toContain("gone.txt");
  expect(authority.trustedProjection().files.map((f) => f.path)).toEqual(["a.txt"]);
});

test("a full-workspace commit re-derives the unsettled set outright; a partial patch touches only its named paths", () => {
  const authority = seeded();
  authority.markUnsettled("stale.txt");
  authority.markUnsettled("named.txt");

  authority.commitPatch(manifestOf("a.txt", "named.txt"), { kind: "partial", source: "watch-events", paths: new Set(["named.txt"]) }, {
    settle: ["named.txt"],
    add: [],
  });

  // Only the named path moved. A patch has no authority over anything else.
  expect([...authority.unsettledPaths]).toEqual(["stale.txt"]);
  expect(authority.lastUpdate).toEqual({ kind: "partial", source: "watch-events", paths: new Set(["named.txt"]) });
  // …and it may not upgrade P5 or re-stamp the P7 observation generation.
  expect(authority.fullWorkspaceSinceSeed).toBe(false);
  expect(authority.observedMatcherGeneration).toBe(-1);
  expect(authority.observationComplete).toBe(true); // untouched by a bounded patch

  authority.commitObservation(intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt", "named.txt"), new Set(), 3)));
  expect([...authority.unsettledPaths]).toEqual([]); // rebuilt from the scan's cursor
});

test("unsettled reconciliation order is rebuildFrom, then settle, then add — a re-observed-and-re-deferred path stays unsettled", () => {
  const authority = seeded();

  authority.commitPatch(manifestOf("a.txt"), { kind: "partial", source: "watch-events", paths: new Set(["p.txt"]) }, {
    rebuildFrom: new Set(["p.txt", "q.txt"]),
    settle: ["p.txt", "q.txt"],
    add: ["p.txt"],
  });

  expect([...authority.unsettledPaths]).toEqual(["p.txt"]);
});

// ── identity: mismatch, replay, stale revision ───────────────────────────────

test("receipt replay is recognized and performs no second transition", () => {
  const authority = seeded();
  const intent = intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt", "b.txt"), new Set(), 7));
  const first = authority.commitObservation(intent);

  const replay = authority.commitObservation(intent);

  expect(first.outcome).toBe("advanced");
  expect(replay.outcome).toBe("replayed");
  expect(replay.localRevision).toBe(first.localRevision); // no advance
  expect(authority.snapshot().localRevision).toBe(first.localRevision);
  expect(authority.manifest.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
});

test("an identity from another lineage performs no write", () => {
  const authority = seeded();
  const foreign = { lineageToken: "some-other-lineage", localRevision: authority.snapshot().localRevision };
  const before = authority.manifest;
  const revision = authority.snapshot().localRevision;

  const receipt = authority.commitObservation(
    intentOf(authority, "obs-1", fullScanPayload(manifestOf("hostile.txt"), new Set(), 7), foreign),
  );

  expect(receipt.outcome).toBe("identity-mismatch");
  expect(authority.manifest).toBe(before);
  expect(authority.snapshot().localRevision).toBe(revision);
  expect(authority.fullWorkspaceSinceSeed).toBe(false);
});

test("a re-seed re-mints the lineage, so an observation planned against the old one performs no write", () => {
  const authority = seeded();
  const planned = intentOf(authority, "obs-1", fullScanPayload(manifestOf("stale.txt"), new Set(), 7));

  authority.seed(manifestOf("fresh.txt"));
  const receipt = authority.commitObservation(planned);

  expect(receipt.outcome).toBe("identity-mismatch");
  expect(authority.manifest.files.map((f) => f.path)).toEqual(["fresh.txt"]);
});

test("an observation planned against a superseded revision performs no write", () => {
  const authority = seeded();
  const planned = intentOf(authority, "obs-late", fullScanPayload(manifestOf("late.txt"), new Set(), 7));
  // Something else advanced LOCAL between the plan and its commit.
  authority.commitPatch(manifestOf("a.txt", "c.txt"), { kind: "partial", source: "pull-applied", paths: new Set(["c.txt"]) }, { add: [] });
  const head = authority.manifest;

  const receipt = authority.commitObservation(planned);

  expect(receipt.outcome).toBe("stale-revision");
  expect(authority.manifest).toBe(head);
});

test("a payload swapped after sealing fails its digest and performs no write", () => {
  const authority = seeded();
  const sealed = intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt", "b.txt"), new Set(), 7));
  const head = authority.manifest;

  // Same identity, different payload: the plan/receipt/state binding must refuse it.
  const tampered: LocalObservationCommitIntent = { ...sealed, next: manifestOf("a.txt", "b.txt", "smuggled.txt") };
  const receipt = authority.commitObservation(tampered);

  expect(receipt.outcome).toBe("identity-mismatch");
  expect(authority.manifest).toBe(head);
  expect(authority.observationComplete).toBe(true); // completeness is part of the refused transition
});

test("the digest binds the clauses trusted-pull reads: completeness, provenance kind, and the observed generation", () => {
  const authority = seeded();
  const base = fullScanPayload(manifestOf("a.txt"), new Set(), 7);
  const digest = sealLocalObservationIdentity("obs-1", authority.snapshot(), base).logicalDigest;

  expect(sealLocalObservationIdentity("obs-1", authority.snapshot(), { ...base, completeness: "deferred" }).logicalDigest).not.toBe(digest);
  expect(sealLocalObservationIdentity("obs-1", authority.snapshot(), { ...base, observedUnderMatcherGeneration: 8 }).logicalDigest).not.toBe(digest);
  expect(sealLocalObservationIdentity("obs-1", authority.snapshot(), {
    ...base,
    update: { kind: "partial", source: "watch-events", paths: new Set() },
  }).logicalDigest).not.toBe(digest);
});

// ── the seed and the completeness downgrade ──────────────────────────────────

test("the seed clears provenance and completeness stamps: nothing has been observed yet", () => {
  const authority = seeded();
  authority.commitObservation(intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt"), new Set(), 7)));
  authority.markUnsettled("x.txt");

  authority.seed(manifestOf("base.txt"));

  expect(authority.manifest.files.map((f) => f.path)).toEqual(["base.txt"]);
  expect(authority.fullWorkspaceSinceSeed).toBe(false);
  expect(authority.observedMatcherGeneration).toBe(-1);
  expect(authority.lastUpdate).toBeUndefined();
  expect(authority.unsettledPaths.size).toBe(0);
});

test("only a commit may set completeness back; a downgrade is unconditional", () => {
  const authority = seeded();
  authority.commitObservation(intentOf(authority, "obs-1", fullScanPayload(manifestOf("a.txt"), new Set(), 7)));
  expect(authority.observationComplete).toBe(true);

  authority.setObservationComplete(false);
  expect(authority.observationComplete).toBe(false);

  authority.commitObservation(intentOf(authority, "obs-2", fullScanPayload(manifestOf("a.txt"), new Set(), 7)));
  expect(authority.observationComplete).toBe(true);
});

test("replay memory is bounded: a long-lived daemon does not retain every observation id", () => {
  const authority = seeded();
  let id = 0;
  const commit = (): string => {
    const observationId = `obs-${++id}`;
    authority.commitObservation(intentOf(authority, observationId, fullScanPayload(manifestOf("a.txt"), new Set(), 7)));
    return observationId;
  };
  const first = commit();
  for (let i = 0; i < 200; i++) commit();

  // The oldest id is no longer remembered — but the revision check still refuses it.
  const stale = intentOf(authority, first, fullScanPayload(manifestOf("a.txt"), new Set(), 7), { lineageToken: authority.snapshot().lineageToken, localRevision: 0 });
  expect(authority.commitObservation(stale).outcome).toBe("stale-revision");
  expect(authority.replayMemorySize).toBeLessThanOrEqual(64);
});

// ── the observer seam: identity is sealed at observation start ───────────────

interface ObserverHarness {
  observer: LocalWorkspaceObserver;
  retries: LocalRetryQueue;
  authority: LocalAuthority;
  generation: number;
  outcomes: string[];
}

function observerOverAuthority(options: {
  root: string;
  authority: LocalAuthority;
  walk?: (call: number) => { files: string[]; defer?: string[]; duringWalk?: (h: ObserverHarness) => void };
  patch?: (events: WatchEvent[]) => { files: string[]; defer?: string[] };
}): ObserverHarness {
  let walkCall = 0;
  // `h` is late-bound: the closures below capture it but none RUN until the observer
  // is driven by a test, well after the assignment at the bottom.
  let h: ObserverHarness;
  const state = {
    authority: options.authority,
    generation: 7,
    outcomes: [] as string[],
  };
  const retries = new LocalRetryQueue({ requeue: () => {}, markUnsettled: (p) => h.authority.markUnsettled(p), stopped: () => true });
  let sharedDircache: DirCache | undefined;
  const effects: LocalObservationEffects = {
    root: options.root,
    currentManifest: () => h.authority.manifest,
    currentMatcher: () => buildIgnoreMatcher(options.root),
    dircache: () => (sharedDircache ??= new DirCache()),
    matcherGeneration: () => h.generation,
    scanMode: () => "unpruned",
    beginTopologySnapshot: (scanKind) => ({ scanKind }),
    observeTopology: async (observation): Promise<CurrentGitTopologyReceipt> => ({
      kind: observation.kind, absenceAuthority: "authoritative", topology: "shrinking-snapshot", registryActions: [], floorRequired: false,
    }),
    authority: {
      snapshot: () => h.authority.snapshot(),
      commitObservation: (intent) => {
        const receipt = h.authority.commitObservation(intent);
        h.outcomes.push(receipt.outcome);
        return receipt;
      },
      get observationComplete() { return h.authority.observationComplete; },
    },
    log: () => {},
    recordScanFault: () => {},
    scanTree: (async (_root, _matcher, _cache, _onProgress, _onGitRepo, _stats, deferred) => {
      const result = options.walk?.(walkCall++) ?? { files: [] };
      for (const p of result.defer ?? []) deferred?.add(p);
      result.duringWalk?.(h);
      return manifestOf(...result.files);
    }) as LocalObservationEffects["scanTree"],
    patchEvents: (async (base, _root, _matcher, events, _cache, deferred) => {
      const result = options.patch?.(events) ?? { files: base.files.map((f) => f.path) };
      for (const p of result.defer ?? []) deferred?.add(p);
      return manifestOf(...result.files);
    }) as LocalObservationEffects["patchEvents"],
  };
  h = { ...state, retries, observer: new LocalWorkspaceObserver(effects, retries) };
  return h;
}

test("design 206 §2: the generation the OBSERVATION started under is what the commit stamps, not the one live when it lands", async () => {
  const root = await tempRoot();
  const authority = seeded();
  const h = observerOverAuthority({
    root,
    authority,
    walk: () => ({ files: ["a.txt"], duringWalk: (self) => { self.generation = 99; } }),
  });

  const receipt = await h.observer.observe({ kind: "scan", cache: new HashCache(), previous: authority.manifest, mode: "unpruned" });

  expect(receipt.matcherGeneration).toBe(7);
  // Stamping at commit time would credit the mid-walk rebuild to a manifest whose
  // inclusion decisions predate it, and P7 would wrongly re-engage trusted pull.
  expect(authority.observedMatcherGeneration).toBe(7);
  expect(h.generation).toBe(99);
  expect(h.outcomes).toEqual(["advanced"]);
});

test("a scan that could not read every path commits `deferred`, so LOCAL never gains deletion authority it did not earn", async () => {
  const root = await tempRoot();
  const authority = seeded(manifestOf("a.txt", "locked.txt"));
  const h = observerOverAuthority({ root, authority, walk: () => ({ files: ["a.txt"], defer: ["locked.txt"] }) });

  const receipt = await h.observer.observe({ kind: "scan", cache: new HashCache(), previous: authority.manifest, mode: "unpruned" });

  expect(receipt.completeness).toBe("deferred");
  expect(authority.observationComplete).toBe(false);
  expect([...authority.unsettledPaths]).toEqual(["locked.txt"]);
  // The unread path keeps the entry it carried in; it is never committed as absent.
  expect(authority.manifest.files.map((f) => f.path)).toEqual(["a.txt", "locked.txt"]);
  expect(authority.trustedProjection().files.map((f) => f.path)).toEqual(["a.txt"]);
});

test("the observation seals its identity against the lineage it started under, and the nested collision rescan commits on top", async () => {
  const root = await tempRoot();
  const authority = seeded(manifestOf());
  authority.setObservationComplete(false);
  const revision = authority.snapshot().localRevision;
  const h = observerOverAuthority({
    root,
    authority,
    patch: () => ({ files: ["A.txt", "a.txt"] }),
    walk: () => ({ files: ["A.txt", "a.txt"] }),
  });

  const receipt = await h.observer.observe({ kind: "watch-batch", events: [change("a.txt")], cache: new HashCache() });

  // Both transitions land — the patch first, the rescan on top — and neither is
  // refused as stale despite sharing one observe() call.
  expect(h.outcomes).toEqual(["advanced", "advanced"]);
  expect(receipt.collisionRescan?.scope).toBe("full-workspace");
  expect(authority.snapshot().localRevision).toBe(revision + 2);
  expect(authority.lastUpdate?.kind).toBe("full-workspace");
});

test("an observation whose commit is refused leaves LOCAL exactly as it was", async () => {
  const root = await tempRoot();
  const authority = seeded();
  const h = observerOverAuthority({
    root,
    authority,
    // A concurrent advance between the sealed snapshot and the commit.
    walk: () => ({ files: ["a.txt", "b.txt"], duringWalk: () => {
      authority.commitPatch(manifestOf("a.txt", "c.txt"), { kind: "partial", source: "pull-applied", paths: new Set(["c.txt"]) }, { add: [] });
    } }),
  });

  const receipt = await h.observer.observe({ kind: "scan", cache: new HashCache(), previous: authority.manifest, mode: "unpruned" });

  expect(h.outcomes).toEqual(["stale-revision"]);
  expect(receipt.completeness).toBe("complete");
  expect(receipt.commitDisposition).toBe("stale-revision");
  expect(authority.manifest.files.map((f) => f.path)).toEqual(["a.txt", "c.txt"]);
  expect(authority.fullWorkspaceSinceSeed).toBe(false);
});

// ── the funnel ───────────────────────────────────────────────────────────────

test("LOCAL head is assigned in exactly one place, and no other module assigns it", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const owner = await fs.readFile(path.join(here, "local-observation-transition.ts"), "utf8");
  expect(owner.match(/this\.head\s*=/g)).toHaveLength(1);

  for (const file of ["daemon.ts", "local-workspace-observer.ts"]) {
    const source = await fs.readFile(path.join(here, file), "utf8");
    expect(source, file).not.toMatch(/this\.manifest\s*=[^=]/);
    expect(source, file).not.toMatch(/manifestObservationComplete/);
  }
});
