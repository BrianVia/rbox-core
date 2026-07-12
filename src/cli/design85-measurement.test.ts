import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, HashCache, scanManifest, type FileEntry, type Manifest, type WatchEvent } from "../engine/index.js";
import { RboxDaemon, scanStatsLine } from "./daemon.js";
import { metricsEnabled } from "./metrics.js";
import { createScanProbe, probeEligible, RACY_MARGIN_MS, type ScanProbeState } from "./scan-probe.js";
import {
  candidateStillMismatch,
  continuityBroken,
  diffForDrift,
  eventCoversPath,
  horizonClass,
  loadDriftAudit,
  mergePending,
  PENDING_CAP,
  resolveCoveredAtApply,
  snapshotAtPath,
  snapshotEntry,
  type DriftCandidate,
} from "./drift-audit.js";

const oldMetrics = process.env.RBOX_METRICS;
afterEach(() => { if (oldMetrics === undefined) delete process.env.RBOX_METRICS; else process.env.RBOX_METRICS = oldMetrics; });

test("metrics default on with explicit opt-out", () => {
  delete process.env.RBOX_METRICS; expect(metricsEnabled()).toBe(true);
  process.env.RBOX_METRICS = "0"; expect(metricsEnabled()).toBe(false);
  process.env.RBOX_METRICS = "false"; expect(metricsEnabled()).toBe(false);
  process.env.RBOX_METRICS = "1"; expect(metricsEnabled()).toBe(true);
});

test("daemon deep audit records, confirms, and races without sleeping", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-private-")));
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_DRIFT_NAME"), "old");
    const cfg = { schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: "00".repeat(32), accountId: "a", accountEpoch: 0, keyEpoch: 0 };
    const daemon = new RboxDaemon(root, cfg as never, { remote: {} as never, backoff: async () => {} }, { bootId: "boot" }) as any;
    daemon.cache = await HashCache.load(root);
    daemon.manifest = await scanManifest(root, daemon.matcher, daemon.cache);
    daemon.watcher = { close: async () => {} };
    daemon.watcherSessionId = "session";
    await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_DRIFT_NAME"), "changed");
    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    expect((await loadDriftAudit(root)).pending).toHaveLength(1);
    daemon.pendingEvents.push({ relPath: "DISTINCTIVE_PRIVATE_DRIFT_NAME", kind: "change" });
    await daemon.applyPendingWatchEvents();
    expect(await loadDriftAudit(root)).toMatchObject({ pending: [], resolvedSinceLastAudit: { lateCovered: 1, coveredAmbiguous: 0 } });

    // Binding R7 case: the dropped first edit was observed by deep scan, then a
    // different second edit is the one whose event reaches apply-time truth.
    await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_DRIFT_NAME"), "first-dropped-edit");
    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_DRIFT_NAME"), "different-observed-edit");
    daemon.pendingEvents.push({ relPath: "DISTINCTIVE_PRIVATE_DRIFT_NAME", kind: "change" });
    await daemon.applyPendingWatchEvents();
    expect(await loadDriftAudit(root)).toMatchObject({ pending: [], resolvedSinceLastAudit: { coveredAmbiguous: 1 } });

    await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_DRIFT_NAME"), "uncovered-edit");
    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    expect(logs.some((line) => line.includes("confirmed=1"))).toBe(true);

    await fs.writeFile(path.join(root, "SECOND_PRIVATE_DRIFT_NAME"), "new");
    await daemon.doDeepScan();
    daemon.pendingEvents.push({ relPath: "SECOND_PRIVATE_DRIFT_NAME", kind: "add" });
    await daemon.runDriftAuditNow();
    expect(logs.some((line) => line.includes("racing=1"))).toBe(true);
    const oldProbe = process.env.RBOX_SCAN_PROBE;
    process.env.RBOX_SCAN_PROBE = "1";
    await daemon.doFullScan();
    if (oldProbe === undefined) delete process.env.RBOX_SCAN_PROBE; else process.env.RBOX_SCAN_PROBE = oldProbe;
    expect(logs.some((line) => line.includes("scan probe:"))).toBe(true);
    for (const line of logs.filter((x) => x.includes("deep-scan drift:") || x.includes("deep scan:") || x.includes("safety scan:") || x.includes("scan probe:"))) {
      expect(line).not.toContain("DISTINCTIVE_PRIVATE_DRIFT_NAME");
      expect(line).not.toContain("SECOND_PRIVATE_DRIFT_NAME");
    }
  } finally {
    console.log = oldLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a candidate born in a NON-quiescent scan never counts as a quiescent-gated confirm", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-quiescence-")));
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    await fs.writeFile(path.join(root, "f.txt"), "old");
    const cfg = { schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: "00".repeat(32), accountId: "a", accountEpoch: 0, keyEpoch: 0 };
    const daemon = new RboxDaemon(root, cfg as never, { remote: {} as never, backoff: async () => {} }, { bootId: "boot" }) as any;
    daemon.cache = await HashCache.load(root);
    daemon.manifest = await scanManifest(root, daemon.matcher, daemon.cache);
    daemon.watcher = { close: async () => {} };
    daemon.watcherSessionId = "session";

    await fs.writeFile(path.join(root, "f.txt"), "drifted"); // no watcher event
    await daemon.doDeepScan();
    // A raw event for an UNRELATED path lands inside the settle window: the scan
    // is non-quiescent, but the candidate is not covered and survives.
    const audit = daemon.openDriftAudits.values().next().value;
    audit.rawEvents.push({ relPath: "unrelated.txt", kind: "change" });
    await daemon.runDriftAuditNow();
    expect((await loadDriftAudit(root)).pending[0]).toMatchObject({ quiescentAtScan: false });

    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    const line = logs.find((l) => l.includes("deep-scan drift:") && l.includes("confirmed=1"))!;
    expect(line).toBeDefined();
    expect(line).toContain("confirmedQuiescent=0"); // never feeds the quiescent-only gate
  } finally {
    console.log = oldLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("drift sidecar write failure is measurement-only — the apply path never throws", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-failsoft-")));
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    await fs.writeFile(path.join(root, "f.txt"), "old");
    const cfg = { schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: "00".repeat(32), accountId: "a", accountEpoch: 0, keyEpoch: 0 };
    const daemon = new RboxDaemon(root, cfg as never, { remote: {} as never, backoff: async () => {} }, { bootId: "boot" }) as any;
    daemon.cache = await HashCache.load(root);
    daemon.manifest = await scanManifest(root, daemon.matcher, daemon.cache);
    daemon.watcher = { close: async () => {} };
    daemon.watcherSessionId = "session";

    await fs.writeFile(path.join(root, "f.txt"), "drifted");
    await daemon.doDeepScan();
    await daemon.runDriftAuditNow();
    expect((await loadDriftAudit(root)).pending).toHaveLength(1);

    // Squat a directory on the sidecar path so the atomic rename fails.
    await fs.rm(path.join(root, ".rbox/state/drift-audit.json"), { force: true });
    await fs.mkdir(path.join(root, ".rbox/state/drift-audit.json"));
    daemon.pendingEvents.push({ relPath: "f.txt", kind: "change" });
    await daemon.applyPendingWatchEvents(); // must not throw
    const failLine = logs.find((l) => l.includes("drift audit sidecar write failed"))!;
    expect(failLine).toBeDefined();
    // Sanitized failure line: fs error messages embed absolute paths — only the
    // errno code may be emitted (no workspace root, no sidecar path, D2-R3).
    expect(failLine).not.toContain(root);
    expect(failLine).not.toContain("drift-audit.json");
    // In-memory state stayed coherent: the covering event resolved the candidate.
    expect(daemon.driftState.pending).toHaveLength(0);
  } finally {
    console.log = oldLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a batch applied between scan and settle covers the candidate — never a false confirmed drop (D2-R2)", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-preopen-")));
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    await fs.writeFile(path.join(root, "f.txt"), "old");
    const cfg = { schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: "00".repeat(32), accountId: "a", accountEpoch: 0, keyEpoch: 0 };
    const daemon = new RboxDaemon(root, cfg as never, { remote: {} as never, backoff: async () => {} }, { bootId: "boot" }) as any;
    daemon.cache = await HashCache.load(root);
    daemon.manifest = await scanManifest(root, daemon.matcher, daemon.cache);
    daemon.watcher = { close: async () => {} };
    daemon.watcherSessionId = "session";

    // The raw event fired BEFORE the scan opened (so no rawEvents trace); the
    // deep scan sees the mutation as a candidate; the settled batch is applied
    // BEFORE the settle window closes — while the candidate is not yet pending.
    await fs.writeFile(path.join(root, "f.txt"), "drifted");
    await daemon.doDeepScan();
    daemon.pendingEvents.push({ relPath: "f.txt", kind: "change" });
    await daemon.applyPendingWatchEvents(); // drains the batch; nothing pending yet
    await daemon.runDriftAuditNow();

    // The applied batch is watcher evidence: the candidate resolves racing,
    // never survives to be confirmed as a drop at the next horizon.
    expect((await loadDriftAudit(root)).pending).toHaveLength(0);
    const line = logs.find((l) => l.includes("deep-scan drift:"))!;
    expect(line).toContain("racing=1");
    expect(line).toContain("survivors=0");
  } finally {
    console.log = oldLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a duplicate-path sidecar dedups on load (oldest candidate wins)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-dup-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    const cand = (firstSeenAtMs: number) => ({
      path: "p", kind: "modified", expected: null, observed: null,
      firstSeenAtMs, eventGenAtScan: 0, bootId: "b", errorGenAtScan: 0, quiescentAtScan: true,
    });
    await fs.writeFile(
      path.join(root, ".rbox", "state", "drift-audit.json"),
      JSON.stringify({ version: 1, pending: [cand(5), cand(2)], resolvedSinceLastAudit: { lateCovered: 0, coveredAmbiguous: 0 } })
    );
    const loaded = await loadDriftAudit(root);
    expect(loaded.pending).toHaveLength(1);
    expect(loaded.pending[0]!.firstSeenAtMs).toBe(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("snapshotAtPath binary-searches the sorted manifest without a whole-tree pass", () => {
  const m = manifest(entry("a/1"), entry("b/2", { sha256: "x" }), entry("c/3"));
  expect(snapshotAtPath(m, "a/1")).toMatchObject({ sha256: "a" });
  expect(snapshotAtPath(m, "b/2")).toMatchObject({ sha256: "x" });
  expect(snapshotAtPath(m, "c/3")).toMatchObject({ sha256: "a" });
  expect(snapshotAtPath(m, "b/1.5")).toBeNull();
  expect(snapshotAtPath(manifest(), "a")).toBeNull();
});

test("mergePending dedups by path (older candidate wins) and caps growth", () => {
  const cand = (p: string, firstSeenAtMs: number): DriftCandidate => ({
    path: p, kind: "modified", expected: null, observed: null,
    firstSeenAtMs, eventGenAtScan: 0, bootId: "b", errorGenAtScan: 0, quiescentAtScan: true,
  });
  const merged = mergePending([cand("a", 1)], [cand("a", 2), cand("b", 3)]);
  expect(merged).toHaveLength(2);
  expect(merged.find((c) => c.path === "a")!.firstSeenAtMs).toBe(1); // older evidence kept
  const flood = mergePending([], Array.from({ length: PENDING_CAP + 50 }, (_, i) => cand(`p${i}`, i)));
  expect(flood).toHaveLength(PENDING_CAP);
});

test("corrupt drift sidecars are safely discarded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-drift-state-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    const file = path.join(root, ".rbox", "state", "drift-audit.json");
    await fs.writeFile(file, "not json");
    expect(await loadDriftAudit(root)).toMatchObject({ version: 1, pending: [], resolvedSinceLastAudit: { lateCovered: 0, coveredAmbiguous: 0 } });
    await fs.writeFile(file, JSON.stringify({ version: 1, pending: [] }));
    expect((await loadDriftAudit(root)).resolvedSinceLastAudit).toEqual({ lateCovered: 0, coveredAmbiguous: 0 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("scan stats line is fixed-shape and path-free", () => {
  const line = scanStatsLine("safety scan", createScanStats(), 12, 0);
  expect(line).toBe("safety scan: files=0 dirs=0 wall=12ms readdir=0 stat=0 matcher=0 hash=0 sort=0 residual=12 cacheHits=0 hashed=0 deferred=0 reuse=0 dc=off");
  expect(line).not.toContain("DISTINCTIVE_PRIVATE_NAME");
});

describe("scan probe", () => {
  const prior = (mtimeMs: number, ctimeMs: number): ScanProbeState => ({ version: 1, lastScanStartMs: 10_000, dirs: { abc: { mtimeMs, ctimeMs, readdirMs: 2 } } });
  test("eligibility requires equal timestamps strictly outside the racy margin", () => {
    expect(probeEligible({ key: "abc", mtimeMs: 1, ctimeMs: 2 }, prior(1, 2))).toBe(true);
    expect(probeEligible({ key: "abc", mtimeMs: 2, ctimeMs: 2 }, prior(1, 2))).toBe(false);
    expect(probeEligible({ key: "abc", mtimeMs: 1, ctimeMs: 3 }, prior(1, 2))).toBe(false);
    const boundary = 10_000 - RACY_MARGIN_MS;
    expect(probeEligible({ key: "abc", mtimeMs: boundary, ctimeMs: 2 }, prior(boundary, 2))).toBe(false);
    expect(probeEligible({ key: "missing", mtimeMs: 1, ctimeMs: 2 }, prior(1, 2))).toBe(false);
  });
  test("samples hash directory keys and retain no child paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-probe-"));
    try {
      await fs.writeFile(path.join(root, "DISTINCTIVE_PRIVATE_NAME"), "x");
      const probe = createScanProbe();
      await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, probe);
      expect(probe.samples[0]!.key).toMatch(/^[0-9a-f]{16}$/);
      expect(probe.samples[0]!.projectedBytes).toBeGreaterThan(0);
      expect(JSON.stringify(probe.samples)).not.toContain("DISTINCTIVE_PRIVATE_NAME");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

const entry = (p: string, over: Partial<FileEntry> = {}): FileEntry => ({ path: p, type: "file", sha256: "a", size: 1, mode: 0o644, mtimeMs: 0, ...over });
const manifest = (...files: FileEntry[]): Manifest => ({ generatedAt: "", files });
const context = { firstSeenAtMs: 1, eventGenAtScan: 2, bootId: "b", watcherSessionId: "w", errorGenAtScan: 3 };

describe("deep scan drift pure classification", () => {
  test("diffs every identity dimension plus added/deleted", () => {
    expect(diffForDrift(manifest(), manifest(entry("p")), context)[0]!.kind).toBe("added");
    expect(diffForDrift(manifest(entry("p")), manifest(), context)[0]!.kind).toBe("deleted");
    for (const changed of [
      entry("p", { type: "symlink", symlinkTarget: "x" }), entry("p", { sha256: "b" }),
      entry("p", { size: 2 }), entry("p", { mode: 0o755 }),
      entry("p", { type: "symlink", symlinkTarget: "y" }),
    ]) expect(diffForDrift(manifest(entry("p")), manifest(changed), context)[0]!.kind).toBe("modified");
  });
  test("coverage is exact except directory add/unlink subtree", () => {
    expect(eventCoversPath({ relPath: "a", kind: "change" }, "a")).toBe(true);
    expect(eventCoversPath({ relPath: "a", kind: "change" }, "a/b")).toBe(false);
    expect(eventCoversPath({ relPath: "a", kind: "addDir" }, "a/b")).toBe(true);
    expect(eventCoversPath({ relPath: "a", kind: "unlinkDir" }, "a/b")).toBe(true);
    const rename: WatchEvent[] = [{ relPath: "old", kind: "unlink" }, { relPath: "new", kind: "add" }];
    expect(rename.some((e) => eventCoversPath(e, "old"))).toBe(true);
    expect(rename.some((e) => eventCoversPath(e, "new"))).toBe(true);
  });
  test("continuity precedes confirm versus revert", () => {
    const candidate = diffForDrift(manifest(entry("p")), manifest(entry("p", { sha256: "b" })), context)[0]!;
    const continuous = { bootId: "b", watcherSessionId: "w", errorGeneration: 3, watcherUnhealthySince: false };
    expect(continuityBroken(candidate, continuous)).toBe(false);
    expect(horizonClass(candidate, snapshotEntry(entry("p", { sha256: "b" })), continuous)).toBe("confirmed");
    expect(horizonClass(candidate, snapshotEntry(entry("p")), continuous)).toBe("reverted");
    expect(horizonClass(candidate, snapshotEntry(entry("p", { sha256: "b" })), { ...continuous, errorGeneration: 4 })).toBe("unattributable");
  });
  test("settle re-verification preserves candidate direction", () => {
    const added = diffForDrift(manifest(), manifest(entry("p")), context)[0]!;
    const deleted = diffForDrift(manifest(entry("p")), manifest(), context)[0]!;
    const modified = diffForDrift(manifest(entry("p")), manifest(entry("p", { sha256: "b" })), context)[0]!;
    expect(candidateStillMismatch(added, snapshotEntry(entry("p", { sha256: "c" })))).toBe(true);
    expect(candidateStillMismatch(deleted, null)).toBe(true);
    expect(candidateStillMismatch(deleted, snapshotEntry(entry("p", { sha256: "c" })))).toBe(false);
    expect(candidateStillMismatch(modified, null)).toBe(false);
  });
  test("event-apply truth resolves late-covered versus covered-ambiguous", () => {
    const candidate: DriftCandidate = { ...diffForDrift(manifest(entry("p")), manifest(entry("p", { sha256: "b" })), context)[0]!, quiescentAtScan: true };
    const events: WatchEvent[] = [{ relPath: "p", kind: "change" }];
    const late = resolveCoveredAtApply([candidate], events, new Set(), manifest(entry("p", { sha256: "b" })));
    expect(late).toMatchObject({ lateCovered: 1, coveredAmbiguous: 0, pending: [] });
    const ambiguous = resolveCoveredAtApply([candidate], events, new Set(), manifest(entry("p", { sha256: "c" })));
    expect(ambiguous).toMatchObject({ lateCovered: 0, coveredAmbiguous: 1, pending: [] });
  });
});
