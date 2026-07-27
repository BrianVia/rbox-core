import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncState, WorkspaceConfig } from "./config.js";
import type { DaemonActivity } from "./activity.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import type { StatusMode, StatusProbePort, StatusReadPort } from "./status-contract.js";
import type { StatusRefreshReceipt } from "./status-maintenance.js";

const ROOT = "/tmp/rbox-status-projection";
const NOW = Date.parse("2026-07-08T12:00:00Z");
const AT = new Date(NOW - 1_000).toISOString();

const CFG: WorkspaceConfig = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws_projection",
  projectId: "root",
  deviceId: "dev_projection",
  rootPath: ROOT,
  remoteUrl: "https://api.test",
  token: "",
  encrypted: true,
};

function state(sequence = 7): SyncState {
  return {
    stream: "stream_projection",
    lastSyncedSequence: sequence,
    lastSyncedManifest: { generatedAt: AT, files: [] },
    repoRecords: {},
  } as unknown as SyncState;
}

function trustedActivity(): DaemonActivity {
  return {
    at: AT,
    ws: { connected: true, at: AT, caughtUp: false, bootId: "boot-1", pid: 42 },
    local: {
      at: AT,
      stream: "stream_projection",
      baseSequence: 7,
      trackedFiles: 3,
      added: 1,
      changed: 0,
      deleted: 0,
      settled: true,
      sourceVersion: 1,
    },
  };
}

interface Recorder {
  calls: string[];
  countOf: (name: string) => number;
}

function probePort(mode: StatusMode, calls: string[]): StatusProbePort {
  const note = <T>(name: string, value: T) => async (): Promise<T> => {
    calls.push(name);
    return value;
  };
  if (mode === "json") return { mode, readAccountUsage: note("readAccountUsage", { plan: null, usedBytes: null, capBytes: null }) };
  if (mode === "verbose") {
    return {
      mode,
      readAccountSummary: note("readAccountSummary", { state: "signed-out" as const }),
      readMetrics: note("readMetrics", { syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 }),
      readUpdateState: note("readUpdateState", undefined),
    };
  }
  return {
    mode,
    readBriefAccount: note("readBriefAccount", { state: "signed-out" as const }),
    readUpdateState: note("readUpdateState", undefined),
  };
}

function readPort<M extends StatusMode>(
  mode: M,
  overrides: Partial<StatusReadPort<M>> = {},
  current: SyncState = state(),
): { port: StatusReadPort<M> } & Recorder {
  const calls: string[] = [];
  const note = <A extends unknown[], T>(name: string, value: (...args: A) => T) => (...args: A): T => {
    calls.push(name);
    return value(...args);
  };
  const port: StatusReadPort<M> = {
    mode,
    now: () => NOW,
    readCredentials: note("readCredentials", async () => ({ state: "absent" as const })),
    readPendingGenesis: note("readPendingGenesis", async () => false),
    readConfig: note("readConfig", async () => CFG),
    readDaemonBinding: note("readDaemonBinding", () => ({ alive: { running: false }, stale: false })),
    readAmbientDaemonStatus: note("readAmbientDaemonStatus", () => ({ kind: "absent" as const })),
    inspectResetJournal: note("inspectResetJournal", async () => ({ status: "none" as const })),
    readResetHaltHealth: note("readResetHaltHealth", async () => undefined),
    readState: note("readState", async () => current),
    readActivity: note("readActivity", async () => undefined),
    readPathWarnings: note("readPathWarnings", async () => undefined),
    readTrashStats: note("readTrashStats", async () => undefined),
    readLockingHealth: note("readLockingHealth", async () => ({ status: "ok" as const })),
    readPopulateStatus: note("readPopulateStatus", async () => undefined),
    readRemoteSequence: note("readRemoteSequence", async () => undefined),
    readCryptoPoolStatus: note("readCryptoPoolStatus", () => ({ state: "off" as const, workers: 0, jobsRun: 0, workerExecutions: 0 })),
    buildMatcher: note("buildMatcher", () => ({ ignores: () => false }) as never),
    loadHashCache: note("loadHashCache", async () => ({ prune: () => {}, save: async () => {} }) as never),
    scanManifest: note("scanManifest", async () => ({ generatedAt: AT, files: [] })) as StatusReadPort<M>["scanManifest"],
    gitDivergenceFastRepoSource: note("gitDivergenceFastRepoSource", async () => []),
    gitDivergenceCount: note("gitDivergenceCount", async () => 0) as StatusReadPort<M>["gitDivergenceCount"],
    readConflictSnapshotStatus: note("readConflictSnapshotStatus", async () => ({ total: 0, prunable: 0 })),
    readCheckoutTransactionCapability: note("readCheckoutTransactionCapability", async () => ({}) as never),
    probes: probePort(mode, calls) as StatusReadPort<M>["probes"],
    ...overrides,
  };
  return { port, calls, countOf: (name) => calls.filter((entry) => entry === name).length };
}

const refreshed = (next: SyncState): StatusRefreshReceipt => ({
  kind: "refreshed",
  root: ROOT,
  state: next,
  displayDetails: new Map(),
  changed: false,
  accepted: false,
  recoveredLocks: 0,
  commonDirsInspected: 0,
});

test("one invocation performs one projection: every admitted read happens exactly once", async () => {
  const { port, calls, countOf } = readPort("brief");
  const refreshes: SyncState[] = [];

  const projection = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, port, {
    refresh: async (_cfg, next) => {
      refreshes.push(next);
      return refreshed(next);
    },
  });

  expect(projection.kind).toBe("detail");
  expect(refreshes).toHaveLength(1);
  for (const read of [
    "readCredentials",
    "readConfig",
    "readDaemonBinding",
    "readState",
    "readActivity",
    "readPathWarnings",
    "readTrashStats",
    "readLockingHealth",
    "readCryptoPoolStatus",
    "scanManifest",
    "loadHashCache",
    "readBriefAccount",
    "readUpdateState",
  ]) {
    expect([read, countOf(read)]).toEqual([read, 1]);
  }
  // Nothing is read twice: a second projection pass would double at least one.
  expect(calls.length).toBe(new Set(calls).size);
});

test("the renderer performs zero I/O: the composition root and its renderers hold no reader of their own", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // Both halves of the emission surface: cycle 3 moved rendering out of
  // status-cmd.ts, so the lock must follow the behavior, not the filename.
  const locked = ["status-cmd.ts", "status-render.ts"];
  const source = (await Promise.all(locked.map((file) => fs.readFile(path.join(dir, file), "utf8")))).join("\n");
  // Composition-root effects cycle 1 kept: the hashcache writeback's ownership
  // probe and the best-effort desired-mode promotion. Everything else a status
  // surface shows must arrive through the projection.
  const forbidden = [
    "loadState", "loadActivity", "loadConfig", "loadMetrics", "loadCredentials", "scanManifest",
    "trashStats", "readUpdateCheckState", "fetchAccountSummary", "readLockingHealth", "readPathWarnings",
    "inspectResetJournalSafety", "readResetHaltHealth", "readFreshPopulateStatus", "cryptoPoolStatus",
    "conflictSnapshotStatus", "checkoutTransactionCapability", "buildIgnoreMatcher", "HashCache",
    "fetchWithDeadline", "readAccountProfile", "pendingGenesisState", "readAmbientDaemonStatusRecord",
    "gitDivergenceCount", "gitDivergenceStatus", "gitDivergenceFastRepoSource", "daemonBindingStatus",
  ];
  expect(forbidden.filter((name) => new RegExp(`\\b${name}\\b`).test(source))).toEqual([]);
});

test("reset halt never dereferences state", async () => {
  const { port, calls } = readPort("json", {
    inspectResetJournal: async () => ({ status: "halt", reason: "unreadable-journal" }),
    readState: async () => {
      throw new Error("state must not be read on the halt path");
    },
  });

  const projection = await projectWorkspaceStatusDetail(ROOT, { mode: "json" }, port, {
    refresh: async () => {
      throw new Error("hygiene must not run on the halt path");
    },
  });

  expect(projection.kind).toBe("reset-halt");
  if (projection.kind !== "reset-halt") throw new Error("unreachable");
  expect(projection.reason).toBe("unreadable-journal");
  expect(calls).not.toContain("readState");
  expect(calls).not.toContain("readActivity");
  expect(calls).not.toContain("scanManifest");
});

test("trusted local observation skips the hashcache and the manifest scan", async () => {
  const { port, calls } = readPort("brief", {
    readDaemonBinding: () => ({ alive: { running: true, pid: 9, bootId: "boot-1" }, bound: CFG.remoteWorkspaceId, stale: false }),
    readActivity: async () => trustedActivity(),
    loadHashCache: async () => {
      throw new Error("trusted local must not load the hashcache");
    },
    scanManifest: (async () => {
      throw new Error("trusted local must not scan the manifest");
    }) as StatusReadPort<"brief">["scanManifest"],
  });

  const projection = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, port, {
    refresh: async (_cfg, next) => refreshed(next),
  });

  expect(projection.kind).toBe("detail");
  if (projection.kind !== "detail") throw new Error("unreachable");
  expect(projection.counts.source).toBe("daemon");
  expect(projection.cacheHint).toBeUndefined();
  expect(calls).not.toContain("loadHashCache");
  expect(calls).not.toContain("scanManifest");
});

test("a local base mismatch re-reads state before falling back to the scan", async () => {
  const stale = trustedActivity();
  stale.local!.baseSequence = 6;
  const { port, calls, countOf } = readPort("brief", {
    readDaemonBinding: () => ({ alive: { running: true, pid: 9, bootId: "boot-1" }, bound: CFG.remoteWorkspaceId, stale: false }),
    readActivity: async () => stale,
  });
  const refreshes: number[] = [];

  const projection = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, port, {
    refresh: async (_cfg, next) => {
      refreshes.push(next.lastSyncedSequence);
      return refreshed(next);
    },
  });

  expect(countOf("readState")).toBe(2);
  expect(refreshes).toHaveLength(2);
  expect(calls.indexOf("scanManifest")).toBeGreaterThan(calls.lastIndexOf("readState"));
  expect(projection.kind).toBe("detail");
  if (projection.kind !== "detail") throw new Error("unreachable");
  expect(projection.counts.source).toBe("computed");
  expect(projection.cacheHint).toBeDefined();
});

test("each mode performs only its admitted probes", async () => {
  const probeNames = ["readAccountUsage", "readAccountSummary", "readMetrics", "readUpdateState", "readBriefAccount"];
  const observed = new Map<StatusMode, string[]>();

  for (const mode of ["json", "verbose", "brief", "git"] as const) {
    const { port, calls } = readPort(mode);
    await projectWorkspaceStatusDetail(ROOT, { mode }, port, { refresh: async (_cfg, next) => refreshed(next) });
    observed.set(mode, calls.filter((call) => probeNames.includes(call)).sort());
  }

  expect(observed.get("json")).toEqual(["readAccountUsage"]);
  expect(observed.get("verbose")).toEqual(["readAccountSummary", "readMetrics", "readUpdateState"]);
  expect(observed.get("brief")).toEqual(["readBriefAccount", "readUpdateState"]);
  expect(observed.get("git")).toEqual(["readBriefAccount", "readUpdateState"]);
});

test("a probe port bound to another mode is refused before any read", async () => {
  const { port, calls } = readPort("json");
  const mismatched = { ...port, probes: probePort("verbose", calls) } as unknown as StatusReadPort<"json">;

  await expect(projectWorkspaceStatusDetail(ROOT, { mode: "json" }, mismatched, {
    refresh: async (_cfg, next) => refreshed(next),
  })).rejects.toThrow(/mode/);
  expect(calls).toEqual([]);
});
