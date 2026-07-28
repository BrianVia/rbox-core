import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  autostartWorkspaceStatuses,
  autostartCmd,
  bootResume,
  desiredStatePath,
  enableAutostart,
  promotePendingModeIntent,
  readDesiredDaemonRows,
  resumeDesiredDaemon,
  startDaemonAndRecordDesired,
  stopDaemonAndRecordDesired,
  parkDaemonForMaintenance,
  resumeDaemonAfterMaintenance,
} from "./autostart-cmd.js";
import { daemonPidPath, daemonStatusPath } from "./rbox-paths.js";

let home: string;
let roots: string[];

const creds = (accountId: string) => async () => ({
  state: "valid" as const,
  source: "disk" as const,
  credentials: { v: 1 as const, token: "tok", deviceId: "dev_test", remoteUrl: "https://api.test", accountId },
  legacy: false,
  extensions: {},
});
const absent = async () => ({ state: "absent" as const, path: "/test/credentials.json" });

async function writeWorkspaceBinding(root: string, workspaceId: string): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({
      schema: "e2ee/v1",
      remoteWorkspaceId: workspaceId,
      projectId: "root",
      deviceId: "dev_test",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
    })
  );
}

async function workspace(workspaceId: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auto-root-"));
  roots.push(root);
  await writeWorkspaceBinding(root, workspaceId);
  return root;
}

async function fakeBinary(): Promise<string> {
  const binary = path.join(home, ".rbox", "bin", "rbox");
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "#!/bin/sh\n");
  return binary;
}

async function recordDesired(root: string, state: "running" | "stopped", accountId: string, at = "2026-07-03T18:00:00.000Z"): Promise<void> {
  const base = { loadCredentials: creds(accountId), now: () => new Date(at) };
  if (state === "running") {
    await startDaemonAndRecordDesired(root, { ...base, startDaemon: async () => "started" });
  } else {
    await stopDaemonAndRecordDesired(root, { ...base, stopDaemon: async () => {} });
  }
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auto-home-"));
  roots = [];
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

test("enable autostart writes a login-only LaunchAgent", async () => {
  const binary = await fakeBinary();
  const commands: string[] = [];
  await enableAutostart({
    platform: "darwin",
    home,
    binaryPath: binary,
    exec: async (cmd, args) => void commands.push([cmd, ...args].join(" ")),
  });

  const plistPath = path.join(home, "Library", "LaunchAgents", "to.rbox.daemon.plist");
  const plist = await fs.readFile(plistPath, "utf8");
  const resolvedBinary = await fs.realpath(binary);
  expect(plist).toContain("<key>Label</key>");
  expect(plist).toContain("<string>to.rbox.daemon</string>");
  expect(plist).toContain("<key>ProgramArguments</key>");
  expect(plist).toContain(`<string>${resolvedBinary}</string>`);
  expect(plist).toContain("<string>__boot-resume</string>");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).not.toContain("KeepAlive");
  expect(commands).toEqual([`launchctl load -w ${plistPath}`]);
});

test("enable autostart writes a oneshot systemd resume", async () => {
  const binary = await fakeBinary();
  const commands: string[] = [];
  await enableAutostart({
    platform: "linux",
    home,
    binaryPath: binary,
    exec: async (cmd, args) => void commands.push([cmd, ...args].join(" ")),
  });

  const unit = await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
  expect(unit).toContain("Type=oneshot");
  expect(unit).toContain("RemainAfterExit=yes");
  expect(unit).toContain("load-bearing");
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain(`ExecStart=${await fs.realpath(binary)} __boot-resume`);
  expect(unit).not.toContain("%h/.rbox/bin/rbox");
  expect(unit).not.toContain("Restart=");
  expect(commands).toEqual(["systemctl --user daemon-reload", "systemctl --user enable rbox.service"]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`enable autostart defaults to the resolved running binary on ${platform}`, async () => {
    const runningBinary = path.join(home, "installed-elsewhere", "rbox");
    await fs.mkdir(path.dirname(runningBinary), { recursive: true });
    await fs.writeFile(runningBinary, "#!/bin/sh\n");
    const oldExecPath = process.execPath;
    process.execPath = runningBinary;
    try {
      await enableAutostart({ platform, home, exec: async () => {} });
    } finally {
      process.execPath = oldExecPath;
    }

    const generated = platform === "darwin"
      ? await fs.readFile(path.join(home, "Library", "LaunchAgents", "to.rbox.daemon.plist"), "utf8")
      : await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
    expect(generated).toContain(await fs.realpath(runningBinary));
    expect(generated).not.toContain(path.join(home, ".rbox", "bin", "rbox"));
  });
}

test("enable autostart falls back to the canonical binary when execPath does not exist", async () => {
  const canonical = await fakeBinary();
  const oldExecPath = process.execPath;
  process.execPath = path.join(home, "missing", "rbox");
  try {
    await enableAutostart({ platform: "linux", home, exec: async () => {} });
  } finally {
    process.execPath = oldExecPath;
  }

  const unit = await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
  expect(unit).toContain(`ExecStart=${await fs.realpath(canonical)} __boot-resume`);
});

test("enable autostart keeps an explicit empty binary override authoritative", async () => {
  await expect(enableAutostart({ platform: "linux", home, binaryPath: "", exec: async () => {} }))
    .rejects.toThrow("rbox binary not found at ; install rbox before enabling autostart");
});

for (const [lingerOutput, showsNote] of [["Linger=no\n", true], ["Linger=yes\n", false]] as const) {
  test(`autostart status ${showsNote ? "shows" : "hides"} the linger note for ${lingerOutput.trim()}`, async () => {
    const lines: string[] = [];
    const oldLog = console.log;
    console.log = (line?: unknown) => void lines.push(String(line ?? ""));
    try {
      await autostartCmd("status", { platform: "linux", home, loadCredentials: absent, exec: async () => lingerOutput });
    } finally {
      console.log = oldLog;
    }
    expect(lines.some((line) => line.includes("enable-linger"))).toBe(showsNote);
  });
}

test("autostart status hides the linger note when loginctl fails", async () => {
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line?: unknown) => void lines.push(String(line ?? ""));
  try {
    await autostartCmd("status", {
      platform: "linux",
      home,
      loadCredentials: absent,
      exec: async () => { throw new Error("loginctl unavailable"); },
    });
  } finally {
    console.log = oldLog;
  }
  expect(lines.some((line) => line.includes("enable-linger"))).toBe(false);
});

test("start and stop record desired state with account and workspace guards", async () => {
  const root = await workspace("ws_record");
  const started: string[] = [];
  const stopped: string[] = [];

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_record"),
    startDaemon: async (r) => {
      started.push(r);
      return "started";
    },
    now: () => new Date("2026-07-03T18:00:00.000Z"),
  });
  expect(started).toEqual([root]);

  const running = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(running).toMatchObject({
    rootPath: root,
    state: "running",
    accountId: "acct_record",
    workspaceId: "ws_record",
    at: "2026-07-03T18:00:00.000Z",
  });
  expect((await fs.stat(desiredStatePath(root))).mode & 0o777).toBe(0o600);

  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_record"),
    stopDaemon: async (r) => void stopped.push(r),
    now: () => new Date("2026-07-03T18:05:00.000Z"),
  });
  expect(stopped).toEqual([root]);
  const stoppedState = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(stoppedState).toMatchObject({
    rootPath: root,
    state: "stopped",
    accountId: "acct_record",
    workspaceId: "ws_record",
    at: "2026-07-03T18:05:00.000Z",
  });
});

test("retry-later start does not create or replace desired running state", async () => {
  const absent = await workspace("ws_retry_absent");
  await startDaemonAndRecordDesired(absent, {
    loadCredentials: creds("acct_retry"),
    startDaemon: async () => "retry-later",
    now: () => new Date("2026-07-03T18:10:00.000Z"),
  });
  await expect(fs.access(desiredStatePath(absent))).rejects.toThrow();

  const stopped = await workspace("ws_retry_stopped");
  await recordDesired(stopped, "stopped", "acct_retry");
  const before = await fs.readFile(desiredStatePath(stopped), "utf8");
  await startDaemonAndRecordDesired(stopped, {
    loadCredentials: creds("acct_retry"),
    startDaemon: async () => "retry-later",
    now: () => new Date("2026-07-03T18:10:00.000Z"),
  });
  expect(await fs.readFile(desiredStatePath(stopped), "utf8")).toBe(before);
});

test("bare stopped-daemon resume preserves pull-only mode and stop carries it forward", async () => {
  const root = await workspace("ws_resume_pull_only");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    pullOnly: true,
    startDaemon: async () => "started",
  });
  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    stopDaemon: async () => {},
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "stopped", pullOnly: true });

  let options: { pullOnly?: boolean; modeIntent?: "preserve" | "explicit" } | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    startDaemon: async (_root, opts) => { options = opts; return "started"; },
  });
  expect(options).toMatchObject({ pullOnly: true, modeIntent: "preserve" });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "running", pullOnly: true });
});

test("stopped legacy desired state preserves the read-write default", async () => {
  const root = await workspace("ws_resume_legacy");
  await fs.mkdir(path.dirname(desiredStatePath(root)), { recursive: true });
  await fs.writeFile(desiredStatePath(root), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_resume",
    workspaceId: "ws_resume_legacy",
    at: "2026-07-03T18:00:00.000Z",
  }));
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_resume"), stopDaemon: async () => {} });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).pullOnly).toBeUndefined();

  let pullOnly: boolean | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    startDaemon: async (_root, opts) => { pullOnly = opts.pullOnly; return "started"; },
  });
  expect(pullOnly).toBe(false);
});

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

test("unknown live mode on bare start records running without changing accepted mode", async () => {
  const root = await workspace("ws_live_unknown");
  await recordDesired(root, "stopped", "acct_unknown", "2026-07-03T18:00:00.000Z");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_unknown"),
    now: () => new Date("2026-07-03T19:00:00.000Z"),
    startDaemon: async () => "already-running-unknown-mode",
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toEqual({
    rootPath: root,
    state: "running",
    accountId: "acct_unknown",
    workspaceId: "ws_live_unknown",
    at: "2026-07-03T19:00:00.000Z",
  });
});

test("a live mode mismatch still records running without accepting the requested mode", async () => {
  const root = await workspace("ws_live_mismatch");
  await recordDesired(root, "stopped", "acct_mismatch", "2026-07-03T18:00:00.000Z");
  await expect(startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_mismatch"),
    mode: "pull-only",
    now: () => new Date("2026-07-03T19:00:00.000Z"),
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 3333 boot-mismatch\n");
      await opts.onLive?.({ pid: 3333, bootId: "boot-mismatch" });
      throw new Error("the live daemon is read-write; restart required: rbox stop && rbox start --pull-only");
    },
  })).rejects.toThrow("the live daemon is read-write");
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "running", at: "2026-07-03T19:00:00.000Z" });
  expect(desired.pullOnly).toBeUndefined();
  expect(desired.pendingModeIntent).toBe("pull-only");
});

test("desired-state enumeration returns only running roots for the current account", async () => {
  const running = await workspace("ws_running");
  const stopped = await workspace("ws_stopped");
  const stale = await workspace("ws_stale");
  const mismatch = await workspace("ws_mismatch");

  await recordDesired(running, "running", "acct_current");
  await recordDesired(stopped, "stopped", "acct_current");
  await recordDesired(stale, "running", "acct_current");
  await recordDesired(mismatch, "running", "acct_other");
  await fs.rm(stale, { recursive: true, force: true });

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_current"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });
  expect(started).toEqual([running]);

  const statuses = await autostartWorkspaceStatuses("acct_current");
  const byRoot = new Map(statuses.map((s) => [s.rootPath, s]));
  expect(byRoot.get(running)?.status).toBe("running");
  expect(byRoot.get(stopped)?.status).toBe("stopped");
  expect(byRoot.get(stale)?.status).toBe("stale");
  expect(byRoot.get(mismatch)?.status).toBe("mismatch");
});

test("stopped desired records retain a valid pending mode intent", async () => {
  const root = await workspace("ws_stopped_pending_invalid");
  await fs.mkdir(path.dirname(desiredStatePath(root)), { recursive: true });
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify({
    rootPath: root,
    state: "stopped",
    accountId: "acct_stopped",
    workspaceId: "ws_stopped_pending_invalid",
    at: "2026-07-03T18:00:00.000Z",
    pendingModeIntent: "pull-only",
  })}\n`);
  const row = (await readDesiredDaemonRows()).find((candidate) => candidate.desired.rootPath === root);
  expect(row?.desired.state).toBe("stopped");
  expect(row?.desired.pendingModeIntent).toBe("pull-only");
});

test("desired-state enumeration excludes rows rebound to a different workspace", async () => {
  const rebound = await workspace("ws_old");
  await recordDesired(rebound, "running", "acct_boot");
  await writeWorkspaceBinding(rebound, "ws_new");

  const statuses = await autostartWorkspaceStatuses("acct_boot");
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({
    rootPath: rebound,
    status: "mismatch",
    workspaceId: "ws_old",
    reason: "desired workspace ws_old, current ws_new",
  });

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });
  expect(started).toEqual([]);
});

test("__boot-resume starts matching running roots through an injected daemon seam", async () => {
  const running = await workspace("ws_boot_running");
  const stopped = await workspace("ws_boot_stopped");
  const mismatch = await workspace("ws_boot_mismatch");
  await recordDesired(running, "running", "acct_boot");
  await recordDesired(stopped, "stopped", "acct_boot");
  await recordDesired(mismatch, "running", "acct_other");

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });

  expect(started).toEqual([running]);
});

test("__boot-resume gives durable pending mode precedence and promotes it on a witnessed match", async () => {
  const root = await workspace("ws_boot_pending");
  await recordDesired(root, "running", "acct_boot");
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  desired.pendingModeIntent = "pull-only";
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify(desired, null, 2)}\n`);

  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "pending" });
      await fs.writeFile(daemonPidPath(root), "v2 2222 boot-pending\n");
      await opts.onLive?.({ pid: 2222, bootId: "boot-pending" });
      await fs.writeFile(daemonStatusPath(root), JSON.stringify({
        schemaVersion: 1,
        daemonVersion: "1.7.19",
        mode: "pull-only",
        bootId: "boot-pending",
        state: "synced",
        heartbeatAt: "2026-07-03T18:06:00.000Z",
        sequence: 1,
        lastSyncedAt: null,
      }));
      await opts.onModeWitness?.({ kind: "known", mode: "pull-only", bootId: "boot-pending" });
      return "already-running";
    },
  });

  const promoted = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(promoted).toMatchObject({ state: "running", pullOnly: true });
  expect(promoted.pendingModeIntent).toBeUndefined();
});

test("a stale boot-resume generation cannot undo a completed stop", async () => {
  const root = await workspace("ws_boot_stop_wins");
  await recordDesired(root, "running", "acct_boot");
  const expected = (await readDesiredDaemonRows()).find((row) => row.desired.rootPath === root)!.desired;
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_boot"), stopDaemon: async () => {} });
  let starts = 0;
  expect(await resumeDesiredDaemon(expected, {
    startDaemon: async () => { starts++; return "started"; },
  })).toBe(false);
  expect(starts).toBe(0);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "stopped" });
});

test("__boot-resume without credentials logs once and starts nothing", async () => {
  const running = await workspace("ws_no_creds");
  await recordDesired(running, "running", "acct_boot");

  const started: string[] = [];
  const logs: string[] = [];
  await bootResume({
    loadCredentials: absent,
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
    log: (line) => void logs.push(line),
  });

  expect(started).toEqual([]);
  expect(logs).toEqual(["autostart: not logged in"]);
});

test("credential degradation is actionable in status and starts zero boot-resume daemons", async () => {
  const degraded = async () => ({ state: "corrupt" as const, path: "/test/credentials.json", detail: "bad schema" });
  const started: string[] = [];
  const logs: string[] = [];
  await bootResume({
    loadCredentials: degraded,
    startDaemon: async (root) => { started.push(root); return "started"; },
    log: (line) => logs.push(line),
  });
  expect(started).toEqual([]);
  expect(logs.join("\n")).toContain("credential-degraded");
  expect(logs.join("\n")).toContain("corrupt");

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line?: unknown) => void lines.push(String(line ?? ""));
  try {
    await autostartCmd("status", { platform: "linux", home, loadCredentials: degraded, exec: async () => "Linger=yes\n" });
  } finally {
    console.log = oldLog;
  }
  expect(lines.join("\n")).toContain("credential-degraded");
});

test("parking records the resume obligation before the daemon is stopped", async () => {
  const root = await workspace("ws_park");
  await recordDesired(root, "running", "acct_park");
  const stopped: string[] = [];
  await parkDaemonForMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_park"),
    stopDaemon: async (r) => {
      // The obligation is already on disk while the process is still being stopped.
      const midPark = JSON.parse(await fs.readFile(desiredStatePath(r), "utf8"));
      expect(midPark.maintenance).toMatchObject({ id: "mt_1", resume: "running" });
      stopped.push(r);
    },
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  expect(stopped).toEqual([root]);
  const parked = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(parked).toMatchObject({ state: "stopped", maintenance: { id: "mt_1", resume: "running" } });
});

test("only the matching token resumes, and it resumes exactly once", async () => {
  const root = await workspace("ws_resume");
  await recordDesired(root, "running", "acct_resume");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), stopDaemon: async () => {} });

  const started: string[] = [];
  const start = async (r: string) => {
    started.push(r);
    return "started" as const;
  };
  expect(await resumeDaemonAfterMaintenance(root, "mt_other", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(false);
  expect(started).toEqual([]);

  expect(await resumeDaemonAfterMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(true);
  expect(started).toEqual([root]);
  const resumed = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(resumed.state).toBe("running");
  expect(resumed.maintenance).toBeUndefined();

  // Replaying the same token is a no-op: the obligation was consumed.
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(false);
  expect(started).toEqual([root]);
});

test("an explicit stop cancels the maintenance obligation", async () => {
  const root = await workspace("ws_userstop");
  await recordDesired(root, "running", "acct_userstop");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_userstop"), stopDaemon: async () => {} });
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_userstop"), stopDaemon: async () => {} });

  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toBeUndefined();
  const started: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_userstop"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  })).toBe(false);
  expect(started).toEqual([]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).state).toBe("stopped");
});

test("parking a daemon the user had already stopped does not start it later", async () => {
  const root = await workspace("ws_parkstopped");
  await recordDesired(root, "stopped", "acct_parkstopped");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_parkstopped"), stopDaemon: async () => {} });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toMatchObject({ resume: "stopped" });

  const started: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_parkstopped"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  })).toBe(false);
  expect(started).toEqual([]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toBeUndefined();
});
