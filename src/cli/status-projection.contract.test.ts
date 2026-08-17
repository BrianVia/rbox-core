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
  };
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

const stoppedWorkspaceObservation = (readActivity: () => Promise<DaemonActivity | undefined> = async () => undefined) => ({
  depth: "ambient" as const,
  root: ROOT,
  observedAt: NOW,
  config: CFG,
  daemon: {
    ownership: "stopped" as const,
    running: false,
    stale: false,
    ownsRoot: false,
    ownsWorkspace: false,
    sidecarBinding: "absent" as const,
    ambient: { kind: "absent" as const },
    ambientTrust: "absent" as const,
  },
  readActivity,
});

const ownedWorkspaceObservation = (activity: DaemonActivity) => ({
  ...stoppedWorkspaceObservation(async () => activity),
  daemon: {
    ownership: "owned" as const,
    running: true,
    pid: 9,
    bootId: "boot-1",
    boundWorkspaceId: CFG.remoteWorkspaceId,
    stale: false,
    ownsRoot: true,
    ownsWorkspace: true,
    sidecarBinding: "workspace" as const,
    ambient: { kind: "absent" as const },
    ambientTrust: "absent" as const,
  },
});

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
    readWorkspaceObservation: note("readWorkspaceObservation", async () => stoppedWorkspaceObservation(
      note("readWorkspaceActivity", async () => undefined),
    )),
    inspectResetJournal: note("inspectResetJournal", async () => ({ status: "none" as const })),
    readState: note("readState", async () => current),
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
    // Overrides are recorded too. A raw spread replaced the recorder, which made
    // every call-count assertion about an overridden read vacuously true.
    ...Object.fromEntries(
      Object.entries(overrides).map(([name, value]) => [
        name,
        typeof value === "function" ? note(name, value as (...args: unknown[]) => unknown) : value,
      ]),
    ) as Partial<StatusReadPort<M>>,
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
    "readWorkspaceObservation",
    "readWorkspaceActivity",
    "readState",
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
  expect(calls.filter((call) => call === "readWorkspaceObservation")).toHaveLength(1);
  expect(calls).not.toContain("readWorkspaceActivity");
  expect(calls).not.toContain("scanManifest");
});

test("trusted local observation skips the hashcache and the manifest scan", async () => {
  const { port, calls } = readPort("brief", {
    readWorkspaceObservation: async () => ownedWorkspaceObservation(trustedActivity()),
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

test("watcher trust projects only from trusted ambient", async () => {
  const activity = trustedActivity();
  const admitted = ownedWorkspaceObservation(activity);
  admitted.daemon.ambient = {
    kind: "ok",
    status: {
      schemaVersion: 1,
      bootId: "boot-1",
      state: "synced",
      heartbeatAt: AT,
      sequence: 7,
      lastSyncedAt: AT,
      watcherTrust: "fused",
    },
  };
  Object.assign(admitted.daemon, { ambientTrust: "trusted", trustedAmbient: admitted.daemon.ambient.status });
  const { port } = readPort("brief", { readWorkspaceObservation: async () => admitted });
  const projected = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, port, {
    refresh: async (_cfg, next) => refreshed(next),
  });
  expect(projected.daemon.watcherTrust).toBe("fused");

  const rejected = { ...admitted, daemon: { ...admitted.daemon, ambientTrust: "stale" as const, trustedAmbient: undefined } };
  const { port: stalePort } = readPort("brief", { readWorkspaceObservation: async () => rejected });
  const staleProjection = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, stalePort, {
    refresh: async (_cfg, next) => refreshed(next),
  });
  expect(staleProjection.daemon.watcherTrust).toBeUndefined();
});

test("an unowned mixed-format daemon cannot make rejected activity renderable", async () => {
  const { port, countOf } = readPort("brief", {
    readWorkspaceObservation: async () => ({
      ...stoppedWorkspaceObservation(async () => trustedActivity()),
      daemon: {
        ownership: "record-format-mismatch",
        running: true,
        pid: 9,
        bootId: "boot-1",
        boundWorkspaceId: CFG.remoteWorkspaceId,
        stale: false,
        ownsRoot: true,
        ownsWorkspace: false,
        sidecarBinding: "workspace",
        ambient: { kind: "absent" },
        ambientTrust: "binding-untrusted",
      },
    }),
  });

  const projection = await projectWorkspaceStatusDetail(ROOT, { mode: "brief" }, port, {
    refresh: async (_cfg, next) => refreshed(next),
  });

  expect(projection.kind).toBe("detail");
  if (projection.kind !== "detail") throw new Error("unreachable");
  // One observation, and its binding is not proven — so the daemon's own local
  // snapshot cannot be quoted as the file counts.
  expect(countOf("readWorkspaceObservation")).toBe(1);
  expect(projection.counts.source).not.toBe("daemon");
  expect(projection.health).toBe("ok");
});

test("a local base mismatch re-reads state before falling back to the scan", async () => {
  const stale = trustedActivity();
  stale.local!.baseSequence = 6;
  const { port, calls, countOf } = readPort("brief", {
    readWorkspaceObservation: async () => ownedWorkspaceObservation(stale),
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
  const mismatched: StatusReadPort<"json"> = { ...port, probes: probePort("verbose", calls) };

  await expect(projectWorkspaceStatusDetail(ROOT, { mode: "json" }, mismatched, {
    refresh: async (_cfg, next) => refreshed(next),
  })).rejects.toThrow(/mode/);
  expect(calls).toEqual([]);
});
