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
  startDaemonAndRecordDesired,
  stopDaemonAndRecordDesired,
} from "./autostart-cmd.js";

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
