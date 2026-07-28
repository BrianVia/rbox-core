import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import {
  desiredStatePath,
  promotePendingModeIntent,
  startDaemonAndRecordDesired,
  stopDaemonAndRecordDesired,
} from "../autostart-cmd.js";
import { daemonPidPath, daemonStatusPath } from "../rbox-paths.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  recordDesired,
  workspace,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("slow witness parks pull-only with running state, retry promotes it, and stop/bare-start preserves it", async () => {
  const root = await workspace("ws_spawn_witness");
  await recordDesired(root, "stopped", "acct_spawn", "2026-07-03T18:00:00.000Z");

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_spawn"),
    mode: "pull-only",
    now: () => new Date("2026-07-03T18:05:00.000Z"),
    modeWitnessTimeoutMs: 1,
    startDaemon: async (_root, opts) => {
      expect(opts.modeWitnessTimeoutMs).toBe(1);
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "explicit" });
      await fs.writeFile(daemonPidPath(root), "v2 4321 boot-slow\n");
      await opts.onSpawned?.({ pid: 4321, bootId: "boot-slow" });
      expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toEqual({
        rootPath: root,
        state: "running",
        accountId: "acct_spawn",
        workspaceId: "ws_spawn_witness",
        at: "2026-07-03T18:05:00.000Z",
        pendingModeIntent: "pull-only",
      });
      return "retry-later";
    },
  });

  const parked = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(parked).toMatchObject({ state: "running", pendingModeIntent: "pull-only" });
  expect(parked.pullOnly).toBeUndefined();

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_spawn"),
    now: () => new Date("2026-07-03T18:06:00.000Z"),
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "pending" });
      await opts.onLive?.({ pid: 4321, bootId: "boot-slow" });
      await fs.writeFile(daemonStatusPath(root), JSON.stringify({
        schemaVersion: 1,
        daemonVersion: "1.7.19",
        mode: "pull-only",
        bootId: "boot-slow",
        state: "synced",
        heartbeatAt: "2026-07-03T18:06:00.000Z",
        sequence: 1,
        lastSyncedAt: null,
      }));
      await opts.onModeWitness?.({ kind: "known", mode: "pull-only", bootId: "boot-slow" });
      return "already-running";
    },
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toEqual({
    rootPath: root,
    state: "running",
    accountId: "acct_spawn",
    workspaceId: "ws_spawn_witness",
    at: "2026-07-03T18:06:00.000Z",
    pullOnly: true,
  });

  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_spawn"),
    now: () => new Date("2026-07-03T18:07:00.000Z"),
    stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
  });
  let bareMode: boolean | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_spawn"),
    now: () => new Date("2026-07-03T18:08:00.000Z"),
    startDaemon: async (_root, opts) => {
      bareMode = opts.pullOnly;
      expect(opts.modeIntent).toBe("preserve");
      return "started";
    },
  });
  expect(bareMode).toBe(true);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "running", pullOnly: true });
});

test("explicit pull-only survives stop before promotion and a bare start resumes pull-only without manufacturing pending", async () => {
  const root = await workspace("ws_slow_witness_stop_resume");
  await recordDesired(root, "stopped", "acct_trace", "2026-07-03T18:00:00.000Z");

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_trace"),
    mode: "pull-only",
    now: () => new Date("2026-07-03T18:05:00.000Z"),
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 5101 boot-trace-slow\n");
      await opts.onSpawned?.({ pid: 5101, bootId: "boot-trace-slow" });
      return "retry-later";
    },
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({
    state: "running",
    pendingModeIntent: "pull-only",
  });

  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_trace"),
    now: () => new Date("2026-07-03T18:06:00.000Z"),
    stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
  });
  const stopped = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(stopped).toMatchObject({ state: "stopped", pendingModeIntent: "pull-only" });
  expect(stopped.pullOnly).toBeUndefined();

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_trace"),
    now: () => new Date("2026-07-03T18:07:00.000Z"),
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "pending" });
      await fs.writeFile(daemonPidPath(root), "v2 5102 boot-trace-resume\n");
      await opts.onSpawned?.({ pid: 5102, bootId: "boot-trace-resume" });
      return "retry-later";
    },
  });
  const resumed = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(resumed).toMatchObject({ state: "running", pendingModeIntent: "pull-only" });
  expect(resumed.pullOnly).toBeUndefined();
});

test("an explicit opposite flag replaces durable pending intent", async () => {
  const root = await workspace("ws_pending_opposite");
  await recordDesired(root, "stopped", "acct_opposite");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_opposite"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 5201 boot-opposite\n");
      await opts.onSpawned?.({ pid: 5201, bootId: "boot-opposite" });
      return "retry-later";
    },
  });

  await expect(startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_opposite"),
    mode: "read-write",
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: false, modeIntent: "explicit" });
      await opts.onLive?.({ pid: 5201, bootId: "boot-opposite" });
      throw new Error("the live daemon is pull-only; restart required: rbox stop && rbox start --read-write");
    },
  })).rejects.toThrow("the live daemon is pull-only");

  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "running", pendingModeIntent: "read-write" });
  expect(desired.pullOnly).toBeUndefined();
});

test("an explicit opposite flag replaces pending even when daemon admission defers without callbacks", async () => {
  const root = await workspace("ws_pending_opposite_deferred");
  await recordDesired(root, "stopped", "acct_opposite_deferred");
  const before = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  before.pendingModeIntent = "pull-only";
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify(before, null, 2)}\n`);

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_opposite_deferred"),
    mode: "read-write",
    startDaemon: async () => "retry-later",
  });

  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "stopped", pendingModeIntent: "read-write" });
  expect(desired.pullOnly).toBeUndefined();
});

test("bare slow-witness starts never author pending intent without an explicit request", async () => {
  for (const accepted of ["read-write", "pull-only"] as const) {
    const root = await workspace(`ws_bare_no_pending_${accepted}`);
    await recordDesired(root, "stopped", "acct_bare_no_pending");
    if (accepted === "pull-only") {
      await startDaemonAndRecordDesired(root, {
        loadCredentials: creds("acct_bare_no_pending"),
        mode: "pull-only",
        startDaemon: async () => "started",
      });
      await stopDaemonAndRecordDesired(root, {
        loadCredentials: creds("acct_bare_no_pending"),
        stopDaemon: async () => {},
      });
    }

    await startDaemonAndRecordDesired(root, {
      loadCredentials: creds("acct_bare_no_pending"),
      startDaemon: async (_root, opts) => {
        expect(opts.pullOnly).toBe(accepted === "pull-only");
        expect(opts.modeIntent).toBe("preserve");
        const pid = accepted === "pull-only" ? 5402 : 5401;
        await fs.writeFile(daemonPidPath(root), `v2 ${pid} boot-bare-${accepted}\n`);
        await opts.onSpawned?.({ pid, bootId: `boot-bare-${accepted}` });
        return "retry-later";
      },
    });
    const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
    expect(desired.state).toBe("running");
    expect(desired.pendingModeIntent).toBeUndefined();
    expect(desired.pullOnly === true ? "pull-only" : "read-write").toBe(accepted);
  }
});

test("a bare start cannot promote over a newer explicit pending intent", async () => {
  const root = await workspace("ws_bare_newer_explicit");
  await recordDesired(root, "stopped", "acct_bare_newer");
  const initial = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  initial.pendingModeIntent = "pull-only";
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify(initial, null, 2)}\n`);

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_bare_newer"),
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "pending" });
      await startDaemonAndRecordDesired(root, {
        loadCredentials: creds("acct_bare_newer"),
        mode: "read-write",
        startDaemon: async () => "retry-later",
      });
      await fs.writeFile(daemonPidPath(root), "v2 5450 boot-bare-newer\n");
      await opts.onSpawned?.({ pid: 5450, bootId: "boot-bare-newer" });
      await fs.writeFile(daemonStatusPath(root), JSON.stringify({
        schemaVersion: 1,
        daemonVersion: "1.7.19",
        mode: "pull-only",
        bootId: "boot-bare-newer",
        state: "synced",
        heartbeatAt: "2026-07-03T18:06:00.000Z",
        sequence: 1,
        lastSyncedAt: null,
      }));
      await opts.onModeWitness?.({ kind: "known", mode: "pull-only", bootId: "boot-bare-newer" });
      return "started";
    },
  });

  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "running", pendingModeIntent: "read-write" });
  expect(desired.pullOnly).toBeUndefined();
});

test("stop promotes a matching boot-bound pending witness before carrying mode forward", async () => {
  const root = await workspace("ws_stop_promotes_witness");
  await recordDesired(root, "stopped", "acct_stop_promote");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_stop_promote"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 5301 boot-stop-promote\n");
      await opts.onSpawned?.({ pid: 5301, bootId: "boot-stop-promote" });
      return "retry-later";
    },
  });
  await fs.writeFile(daemonStatusPath(root), JSON.stringify({
    schemaVersion: 1,
    daemonVersion: "1.7.19",
    mode: "pull-only",
    bootId: "boot-stop-promote",
    state: "synced",
    heartbeatAt: "2026-07-03T18:06:00.000Z",
    sequence: 1,
    lastSyncedAt: null,
  }));

  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_stop_promote"),
    stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
  });
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "stopped", pullOnly: true });
  expect(desired.pendingModeIntent).toBeUndefined();
});

test("stop retains pending intent for stale-boot and differing-mode witnesses", async () => {
  for (const witness of [
    { bootId: "boot-stale", mode: "pull-only" },
    { bootId: "boot-live", mode: "read-write" },
  ] as const) {
    const root = await workspace(`ws_stop_retains_${witness.bootId}_${witness.mode}`);
    await recordDesired(root, "stopped", "acct_stop_retain");
    await startDaemonAndRecordDesired(root, {
      loadCredentials: creds("acct_stop_retain"),
      mode: "pull-only",
      startDaemon: async (_root, opts) => {
        await fs.writeFile(daemonPidPath(root), "v2 5501 boot-live\n");
        await opts.onSpawned?.({ pid: 5501, bootId: "boot-live" });
        return "retry-later";
      },
    });
    await fs.writeFile(daemonStatusPath(root), JSON.stringify({
      schemaVersion: 1,
      daemonVersion: "1.7.19",
      mode: witness.mode,
      bootId: witness.bootId,
      state: "synced",
      heartbeatAt: "2026-07-03T18:06:00.000Z",
      sequence: 1,
      lastSyncedAt: null,
    }));
    await stopDaemonAndRecordDesired(root, {
      loadCredentials: creds("acct_stop_retain"),
      stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
    });
    const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
    expect(desired).toMatchObject({ state: "stopped", pendingModeIntent: "pull-only" });
    expect(desired.pullOnly).toBeUndefined();
  }
});

test("status promotion helper accepts only a matching running boot witness", async () => {
  const matching = await workspace("ws_status_promote_matching");
  await recordDesired(matching, "stopped", "acct_status_promote");
  await startDaemonAndRecordDesired(matching, {
    loadCredentials: creds("acct_status_promote"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(matching), "v2 5601 boot-status-match\n");
      await opts.onSpawned?.({ pid: 5601, bootId: "boot-status-match" });
      return "retry-later";
    },
  });
  await fs.writeFile(daemonStatusPath(matching), JSON.stringify({
    schemaVersion: 1,
    daemonVersion: "1.7.19",
    mode: "pull-only",
    bootId: "boot-status-match",
    state: "synced",
    heartbeatAt: "2026-07-03T18:06:00.000Z",
    sequence: 1,
    lastSyncedAt: null,
  }));
  expect(await promotePendingModeIntent(matching)).toBe(true);
  expect(JSON.parse(await fs.readFile(desiredStatePath(matching), "utf8"))).toMatchObject({
    state: "running",
    pullOnly: true,
  });

  const stale = await workspace("ws_status_promote_stale");
  await recordDesired(stale, "stopped", "acct_status_promote");
  const staleDesired = JSON.parse(await fs.readFile(desiredStatePath(stale), "utf8"));
  staleDesired.state = "running";
  staleDesired.pendingModeIntent = "pull-only";
  await fs.writeFile(desiredStatePath(stale), `${JSON.stringify(staleDesired, null, 2)}\n`);
  await fs.writeFile(daemonPidPath(stale), "v2 5602 boot-status-live\n");
  await fs.writeFile(daemonStatusPath(stale), JSON.stringify({
    schemaVersion: 1,
    daemonVersion: "1.7.19",
    mode: "pull-only",
    bootId: "boot-status-stale",
    state: "synced",
    heartbeatAt: "2026-07-03T18:06:00.000Z",
    sequence: 1,
    lastSyncedAt: null,
  }));
  expect(await promotePendingModeIntent(stale)).toBe(false);
  expect(JSON.parse(await fs.readFile(desiredStatePath(stale), "utf8"))).toMatchObject({
    state: "running",
    pendingModeIntent: "pull-only",
  });
});

test("a stop published while a spawned start waits prevents late witness promotion", async () => {
  const root = await workspace("ws_stop_wins");
  await recordDesired(root, "stopped", "acct_stop_wins");
  let release!: () => void;
  const witnessed = new Promise<void>((resolve) => { release = resolve; });
  let parked!: () => void;
  const parkedPromise = new Promise<void>((resolve) => { parked = resolve; });
  const starting = startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_stop_wins"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 9876 boot-stop-wins\n");
      await opts.onSpawned?.({ pid: 9876, bootId: "boot-stop-wins" });
      parked();
      await witnessed;
      return "started";
    },
  });
  await parkedPromise;
  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_stop_wins"),
    stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
  });
  release();
  await starting;
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "stopped", pendingModeIntent: "pull-only" });
  expect(desired.pullOnly).toBeUndefined();
});

test("an old boot witness cannot promote a replacement boot's same-mode pending intent", async () => {
  const root = await workspace("ws_boot_aba");
  await recordDesired(root, "stopped", "acct_aba");
  let releaseOld!: () => void;
  const releaseOldWitness = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldParked!: () => void;
  const oldParkedPromise = new Promise<void>((resolve) => { oldParked = resolve; });
  const oldStart = startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_aba"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 4441 boot-old\n");
      await opts.onSpawned?.({ pid: 4441, bootId: "boot-old" });
      oldParked();
      await releaseOldWitness;
      await opts.onModeWitness?.({ kind: "known", mode: "pull-only", bootId: "boot-old" });
      return "started";
    },
  });
  await oldParkedPromise;
  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_aba"),
    stopDaemon: async () => { await fs.rm(daemonPidPath(root), { force: true }); },
  });
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_aba"),
    mode: "pull-only",
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 4442 boot-replacement\n");
      await opts.onSpawned?.({ pid: 4442, bootId: "boot-replacement" });
      return "retry-later";
    },
  });
  releaseOld();
  await oldStart;

  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "running", pendingModeIntent: "pull-only" });
  expect(desired.pullOnly).toBeUndefined();
});

