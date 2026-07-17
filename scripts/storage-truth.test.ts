import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BLOB_REF_PAGE_LIMIT,
  GRACE_1_MS,
  PHASE1_UNIQUE_ROOT_CAP,
  SNAPSHOT_RETRIES,
  capProximity,
  classifyEntitlement,
  measureStorageTruth,
  phase1PageCount,
  reconcilePrefix,
  renderHuman,
  type EntitlementRow,
  type InventoryEntry,
  type ObservedObject,
  type Page,
  type SnapshotTriple,
  type StorageTruthSource,
  type WorkspaceKey,
  WorkspaceInspectionFailure,
} from "./storage-truth.js";

const NOW = 10 * GRACE_1_MS;
const pin: SnapshotTriple = { head: 7, pruneFloor: 2, indexGeneration: 11 };
const ws: WorkspaceKey = { workspaceId: "ws", projectId: "root" };

function paged<T>(rows: T[], cursor: string | null, limit: number): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const page = rows.slice(start, start + limit);
  return { rows: page, nextCursor: start + page.length < rows.length ? String(start + page.length) : null };
}

class FixtureSource implements StorageTruthSource {
  clock = NOW;
  rootsCalls = 0;
  staleAlways = false;
  staleOnce = false;
  staleInjected = false;
  uninspectableReason: string | null = null;
  entitlementsComplete = false;
  currentHeadAfterEntitlements = false;
  currentHeadUninspectableReason: string | null = null;
  fleetUninspectableReason: string | null = null;
  physicalPageSize = Number.POSITIVE_INFINITY;
  failCanonicalInventoryContinuation = false;
  canonicalInventoryCursors: Array<string | null> = [];
  uniqueRoots = 8;
  duplicateOldHead = false;
  mixedHistoryWindow = false;
  droppedRows = 0;
  seqRows = 0;
  readonly ent: EntitlementRow[] = [
    { accountId: "acct", sha: "a-active", grantedAt: NOW - GRACE_1_MS, sizeBytes: 10 },
    { accountId: "acct", sha: "b-history", grantedAt: NOW - GRACE_1_MS, sizeBytes: 20 },
    { accountId: "acct", sha: "c-fresh", grantedAt: NOW - GRACE_1_MS + 1, sizeBytes: 30 },
    { accountId: "acct", sha: "d-aged", grantedAt: NOW - GRACE_1_MS, sizeBytes: null, location: { packId: "missing", length: 1, packInventoryPresent: false } },
    { accountId: "acct", sha: "e-marked", grantedAt: NOW - 2 * GRACE_1_MS, markedAt: NOW - GRACE_1_MS + 1, sizeBytes: 50 },
    { accountId: "acct", sha: "f-purge", grantedAt: NOW - 2 * GRACE_1_MS, markedAt: NOW - GRACE_1_MS, sizeBytes: 60 },
  ];
  readonly canonicalInventory: InventoryEntry[] = [
    { key: "c-ready", sizeBytes: 100, lifecycle: "ready", rawState: "present", expectedPresence: true },
    { key: "c-mismatch", sizeBytes: 90, lifecycle: "ready", rawState: "present", expectedPresence: true },
    { key: "c-stage", sizeBytes: 50, lifecycle: "staging", rawState: "present=0", expectedPresence: false },
    { key: "c-cond", sizeBytes: 30, lifecycle: "condemned", rawState: "gc_candidate", expectedPresence: false },
  ];
  readonly packInventory: InventoryEntry[] = [
    { key: "p-active", sizeBytes: 10, lifecycle: "ready", rawState: "ready", expectedPresence: true, members: [{ sha: "a", active: true, retained: true }, { sha: "s", active: false, retained: false }] },
    { key: "p-history", sizeBytes: 20, lifecycle: "ready", rawState: "ready", expectedPresence: true, members: [{ sha: "h", active: false, retained: true }] },
    { key: "p-mixed", sizeBytes: 30, lifecycle: "ready", rawState: "ready", expectedPresence: true, members: [{ sha: "a", active: true, retained: true }, { sha: "h", active: false, retained: true }] },
    { key: "p-orphan", sizeBytes: 40, lifecycle: "ready", rawState: "ready", expectedPresence: true, members: [{ sha: "s", active: false, retained: false }] },
    { key: "p-uploading", sizeBytes: 5, lifecycle: "staging", rawState: "uploading", expectedPresence: false },
    { key: "p-swept", sizeBytes: 6, lifecycle: "condemned", rawState: "swept", expectedPresence: false },
    { key: "p-missing-ready", sizeBytes: 7, lifecycle: "ready", rawState: "ready", expectedPresence: true },
  ];
  now() { return this.clock++; }
  async account() { return { usedBytes: 999, retentionDays: 5 }; }
  async workspaces(_account: string, cursor: string | null, limit: number) { return paged([ws], cursor, limit); }
  async roots(_workspace: WorkspaceKey, cursor: string | null) {
    this.rootsCalls++;
    if (this.staleAlways) return { outcome: "snapshot_changed" as const };
    if (this.uninspectableReason) return { outcome: "uninspectable" as const, reason: this.uninspectableReason };
    if (this.staleOnce && cursor !== null && !this.staleInjected) {
      this.staleInjected = true;
      return { outcome: "snapshot_changed" as const };
    }
    const offset = cursor ? Number(cursor) : 0;
    const count = Math.min(20_000, this.uniqueRoots - offset);
    const entries = Array.from({ length: count }, (_, j) => {
      const i = offset + j;
      const cutoff = NOW - 5 * 86_400_000;
      if (i === 0) return { sha: "a-active", head: true, committedAt: cutoff - 1 };
      if (i === 1) return { sha: "b-history", head: false, committedAt: cutoff - 1 };
      if (i === 2 && this.duplicateOldHead) return { sha: "a-active", head: false, committedAt: cutoff - 1 };
      if (i === 2 && this.mixedHistoryWindow) return { sha: "b-history", head: false, committedAt: NOW };
      return { sha: `root-${String(i).padStart(7, "0")}`, head: false, committedAt: i === 2 ? cutoff : NOW };
    });
    return {
      outcome: "ok" as const, triple: pin, entries,
      nextCursor: offset + count < this.uniqueRoots ? String(offset + count) : null,
      droppedRows: offset === 0 ? this.droppedRows : 0, seqRootRows: offset === 0 ? this.seqRows : 0,
    };
  }
  async currentHead() {
    this.currentHeadAfterEntitlements = this.entitlementsComplete;
    return this.currentHeadUninspectableReason
      ? { outcome: "uninspectable" as const, reason: this.currentHeadUninspectableReason }
      : { outcome: "ok" as const, head: pin.head + 101 };
  }
  async catalog(cursor: string | null, limit: number) {
    return paged([
      { sha: "a-active", sizeBytes: 10 }, { sha: "b-history", sizeBytes: 20 },
      { sha: "root-0000002", sizeBytes: 5 },
    ], cursor, limit);
  }
  async fleetReachability(cursor: string | null, limit: number) {
    if (this.fleetUninspectableReason) throw new WorkspaceInspectionFailure("uninspectable", ws, this.fleetUninspectableReason);
    return paged([
      { sha: "a", active: true, retained: true },
      { sha: "h", active: false, retained: true },
    ], cursor, limit);
  }
  async entitlements(_account: string, cursor: { accountId: string; sha: string } | null, limit: number) {
    expect(limit).toBe(BLOB_REF_PAGE_LIMIT);
    const start = cursor ? this.ent.findIndex((r) => r.sha === cursor.sha) + 1 : 0;
    const rows = this.ent.slice(start, start + limit);
    const last = rows.at(-1);
    const nextCursor = start + rows.length < this.ent.length && last ? `${last.accountId}\n${last.sha}` : null;
    if (nextCursor === null) this.entitlementsComplete = true;
    return { rows, nextCursor };
  }
  async inventory(prefix: "canonical" | "pack", cursor: string | null, limit: number) {
    if (prefix === "canonical") {
      this.canonicalInventoryCursors.push(cursor);
      if (cursor !== null && this.failCanonicalInventoryContinuation) {
        this.failCanonicalInventoryContinuation = false;
        throw new Error("injected inventory interruption");
      }
    }
    return paged(prefix === "canonical" ? this.canonicalInventory : this.packInventory, cursor, Math.min(limit, this.physicalPageSize));
  }
  async r2(prefix: "canonical" | "pack", cursor: string | null, limit: number) {
    const at = this.clock;
    const rows: ObservedObject[] = prefix === "canonical" ? [
      { key: "c-ready", sizeBytes: 100, uploadedAt: at - 10 },
      { key: "c-mismatch", sizeBytes: 95, uploadedAt: at - 10 },
      { key: "c-r2-only", sizeBytes: 40, uploadedAt: at - 10 },
      { key: "c-post-start", sizeBytes: 60, uploadedAt: at + 1 },
    ] : [
      ...this.packInventory.slice(0, 6).map((p) => ({ key: p.key, sizeBytes: p.sizeBytes, uploadedAt: at - 10 })),
      { key: "p-r2-only", sizeBytes: 8, uploadedAt: at - 10 },
    ];
    return paged(rows, cursor, limit);
  }
  async catalogGrantedBytes() { return 13; }
  async inventoryChangedBytes() { return 17; }
}

describe("storage truth pure contracts", () => {
  test("classifier uses exact grace boundaries and carries both anomaly flags", () => {
    const row: EntitlementRow = { accountId: "a", sha: "x", grantedAt: NOW - GRACE_1_MS, sizeBytes: null, location: { packId: "missing", length: 99, packInventoryPresent: false } };
    expect(classifyEntitlement(row, false, false, NOW)).toEqual({ label: "aged-unmarked", missingCatalog: true, inconsistent: true });
    expect(classifyEntitlement({ ...row, grantedAt: row.grantedAt + 1 }, false, false, NOW).label).toBe("fresh");
    expect(classifyEntitlement({ ...row, markedAt: NOW - GRACE_1_MS }, false, false, NOW).label).toBe("purge-eligible");
    expect(classifyEntitlement(row, true, true, NOW).label).toBe("active-head");
  });

  test("Phase-1 proximity preserves exact boundary and initial empty page", () => {
    expect(phase1PageCount(0)).toBe(1);
    expect(phase1PageCount(320_001)).toBe(17);
    expect(capProximity(PHASE1_UNIQUE_ROOT_CAP, PHASE1_UNIQUE_ROOT_CAP).wouldFail).toBe(false);
    expect(capProximity(PHASE1_UNIQUE_ROOT_CAP + 1, PHASE1_UNIQUE_ROOT_CAP)).toMatchObject({ delta: -1, wouldFail: true });
  });

  test("per-key lifecycle reconciliation uses observed mismatch bytes and timestamp bound", () => {
    const inv: InventoryEntry[] = [
      { key: "ok", sizeBytes: 10, lifecycle: "ready", rawState: "ready", expectedPresence: true },
      { key: "bad", sizeBytes: 20, lifecycle: "ready", rawState: "ready", expectedPresence: true },
      { key: "missing-ready", sizeBytes: 30, lifecycle: "ready", rawState: "ready", expectedPresence: true },
      { key: "missing-stage", sizeBytes: 40, lifecycle: "staging", rawState: "uploading", expectedPresence: false },
    ];
    const obs = [{ key: "ok", sizeBytes: 10, uploadedAt: 100 }, { key: "bad", sizeBytes: 25, uploadedAt: 100 }, { key: "orphan", sizeBytes: 7, uploadedAt: 100 }, { key: "post", sizeBytes: 99, uploadedAt: 101 }];
    const got = reconcilePrefix(obs, inv, 100);
    expect(got.observedBytes).toBe(42);
    expect(got.observedIdentityBytes).toBe(42);
    expect(got.byLifecycle.ready["size-mismatch"]).toMatchObject({ observedBytes: 25, inventoryBytes: 20 });
    expect(got.byLifecycle.ready["inventory-only"].missingAnomaly).toBe(1);
    expect(got.byLifecycle.staging["inventory-only"].missingAnomaly).toBe(0);
    expect(got.identityHolds).toBe(true);
  });
});

describe("disk-backed constructed cap fixture", () => {
  test("completes past every Phase-1 cap with exact counts and one-pass buckets", async () => {
    const source = new FixtureSource();
    source.uniqueRoots = 750_001;
    source.droppedRows = 320_001;
    source.seqRows = 80_001;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-truth-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("complete");
      expect(report.sectionB.phase1).toMatchObject({
        outcome: "would-fail-closed",
        uniqueRoots: { observed: 750_001, cap: 750_000, delta: -1, wouldFail: true },
        droppedPages: { observed: 17, cap: 16, delta: -1, wouldFail: true },
        seqRootPages: { observed: 5, cap: 4, delta: -1, wouldFail: true },
      });
      const buckets = report.sectionA.buckets;
      expect(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.count]))).toEqual({
        "active-head": 1, "retained-history": 1, fresh: 1, "aged-unmarked": 1, "marked-young": 1, "purge-eligible": 1,
      });
      expect(report.sectionA).toMatchObject({ totalEntitlements: 6, partitionCount: 6, partitionHolds: true, anomalies: { missingCatalog: 1, inconsistent: 1, both: 1 } });
      expect(report.sectionB.arithmeticDrift).toMatchObject({ entitlementCatalogBytes: 170, signedBytes: 829, unknownCatalogRows: 1 });
      expect(report.sectionB.reachableUnentitled.count).toBe(749_999);
      expect(report.sectionB.reachableUnentitled).toMatchObject({ knownBytes: 5, unknownByteRows: 749_998 });
      expect(report.sectionB.windowExpiredRetained.count).toBe(1);
      expect(report.sectionB.rescanOffered).toBe(true);
      expect(source.currentHeadAfterEntitlements).toBe(true);
      expect(report.sectionB.physical.skewBoundBytes).toBe(30);
      expect(report.sectionB.physical.canonical).toMatchObject({ observedBytes: 235, observedIdentityBytes: 235, identityHolds: true });
      expect(report.sectionB.physical.canonical.byLifecycle.ready["inventory-only"].missingAnomaly).toBe(0);
      expect(report.sectionB.physical.pack.byLifecycle.ready["inventory-only"].missingAnomaly).toBe(1);
      expect(report.sectionB.physical.pack.packClasses).toMatchObject({
        "active-only": { count: 1 }, "history-only": { count: 1 }, mixed: { count: 1 }, orphan: { count: 2 },
      });
      expect(report.sectionB.physical.pack.packStrandedMembers).toBe(2);
      const human = renderHuman(report);
      expect(human).toContain("Section A — entitlement partition");
      expect(human).toContain("Section B — diagnostics (overlapping)");
      expect(human).toContain("roots: 750001/750000");
      expect(human).toContain("ready/inventory-only");
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("discards partial roots and returns stale-pin only after three retries", async () => {
    const source = new FixtureSource();
    source.staleAlways = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-stale-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("stale-pin");
      expect(source.rootsCalls).toBe(SNAPSHOT_RETRIES + 1);
      expect(report.sectionA.totalEntitlements).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-pins after one stale continuation and reports the recovered buckets", async () => {
    const source = new FixtureSource();
    source.uniqueRoots = 20_001;
    source.staleOnce = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-recover-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("complete");
      expect(report.sectionB.workspaces[0]?.retries).toBe(1);
      expect(Object.fromEntries(Object.entries(report.sectionA.buckets).map(([label, value]) => [label, value.count]))).toEqual({
        "active-head": 1, "retained-history": 1, fresh: 1, "aged-unmarked": 1, "marked-young": 1, "purge-eligible": 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns a structured uninspectable report", async () => {
    const source = new FixtureSource();
    source.uninspectableReason = "index_unavailable";
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-uninspectable-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("uninspectable");
      expect(report.failure).toEqual({ workspace: ws, reason: "index_unavailable" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured uninspectable when the post-entitlement head read is unavailable", async () => {
    const source = new FixtureSource();
    source.currentHeadUninspectableReason = "timestamp_unavailable";
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-head-uninspectable-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(source.currentHeadAfterEntitlements).toBe(true);
      expect(report.status).toBe("uninspectable");
      expect(report.failure).toEqual({ workspace: ws, reason: "timestamp_unavailable" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured uninspectable when a fleet workspace cannot be inspected", async () => {
    const source = new FixtureSource();
    source.fleetUninspectableReason = "sidecar missing";
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-fleet-uninspectable-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("uninspectable");
      expect(report.failure).toEqual({ workspace: ws, reason: "sidecar missing" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not call a SHA window-expired when the same SHA is also in the head", async () => {
    const source = new FixtureSource();
    source.duplicateOldHead = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-head-expiry-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("complete");
      expect(report.sectionB.windowExpiredRetained.count).toBe(1);
      expect(report.sectionA.buckets["active-head"].count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not call a SHA window-expired when any retained history reference is recent", async () => {
    const source = new FixtureSource();
    source.mixedHistoryWindow = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-mixed-history-expiry-"));
    try {
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("complete");
      expect(report.sectionB.windowExpiredRetained.count).toBe(0);
      expect(report.sectionA.buckets["retained-history"].count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resumes physical inventory from the page cursor persisted before interruption", async () => {
    const source = new FixtureSource();
    source.physicalPageSize = 2;
    source.failCanonicalInventoryContinuation = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-resume-"));
    try {
      await expect(measureStorageTruth(source, "acct", dir)).rejects.toThrow("injected inventory interruption");
      const report = await measureStorageTruth(source, "acct", dir);
      expect(report.status).toBe("complete");
      expect(source.canonicalInventoryCursors).toEqual([null, "2", "2"]);
      expect(report.sectionB.physical.canonical.byLifecycle.ready.matched.count).toBe(1);
      expect(report.sectionB.physical.canonical.byLifecycle.ready["size-mismatch"].count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
