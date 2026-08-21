import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCmd } from "./upgrade-cmd.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import { recordFolder } from "./folder-config.js";
import { workspaceKey } from "./rbox-paths.js";
import { parseSemver } from "./semver.js";
import { RBOX_VERSION } from "./version.js";
import type { DesiredStateRow } from "./autostart-cmd.js";
import type { Manifest as ReleaseManifest } from "./release-verify.js";

let sandbox: string;
let home: string;
let executable: string;
let originalExecPath: string;
let originalFetch: typeof globalThis.fetch;
const originalRboxHome = process.env.RBOX_HOME;
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let poisonHome: string;
let poisonXdgConfigHome: string;
const rows: DesiredStateRow[] = [];

const nextVersion = (): string => {
  const { major, minor, patch } = parseSemver(RBOX_VERSION);
  return `${major}.${minor}.${patch + 1}`;
};

const versionAfter = (offset: number): string => {
  const { major, minor, patch } = parseSemver(RBOX_VERSION);
  return `${major}.${minor}.${patch + offset}`;
};

const artifact = (): string => `rbox-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upgrade-cmd-"));
  home = path.join(sandbox, "poison-rbox-home");
  poisonHome = path.join(sandbox, "poison-home");
  poisonXdgConfigHome = path.join(sandbox, "poison-xdg-config-home");
  executable = path.join(sandbox, "install", "rbox");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "old-binary");
  originalExecPath = process.execPath;
  process.execPath = executable;
  process.env.RBOX_HOME = home;
  process.env.HOME = poisonHome;
  process.env.XDG_CONFIG_HOME = poisonXdgConfigHome;
  originalFetch = globalThis.fetch;
  rows.length = 0;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.execPath = originalExecPath;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  rows.length = 0;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function liveRuntime(name: string, pid: number, daemonVersion: string): Promise<void> {
  if (rows.length === 0) await ensureFolderAuthority();
  const root = path.join(home, name);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    schema: "e2ee/v1",
    remoteWorkspaceId: `ws-${name}`,
    projectId: "root",
    deviceId: "dev-upgrade",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  }));
  await recordFolder(root);
  const key = workspaceKey(root);
  const dir = path.join(home, ".rbox", "daemons", key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "daemon.pid"), `v2 ${pid} boot-${pid}\n`);
  await fs.writeFile(path.join(dir, "daemon.status.json"), `${JSON.stringify({
    schemaVersion: 1,
    daemonVersion,
    state: "synced",
    heartbeatAt: "2026-07-22T00:00:00.000Z",
    sequence: null,
    lastSyncedAt: null,
  })}\n`);
  const desired = {
    rootPath: root,
    state: "running",
    accountId: "acct",
    workspaceId: `ws-${name}`,
    at: "2026-07-22T00:00:00.000Z",
  } as const;
  const desiredPath = path.join(dir, "desired.json");
  await fs.writeFile(desiredPath, `${JSON.stringify(desired)}\n`);
  rows.push({ key, path: desiredPath, desired });
}

function manifest(version: string, bytes = Buffer.from("new-binary")): ReleaseManifest {
  return {
    version,
    keyId: "test",
    artifacts: {
      [artifact()]: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        path: `v${version}/${artifact()}`,
      },
    },
  };
}

function commandDeps(release: ReleaseManifest) {
  return {
    isStandaloneBinary: () => true,
    verifyAndParseManifest: () => release,
  };
}

function daemonDeps(actions: string[], logs: string[]) {
  return {
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: (root: string) => `ws-${path.basename(root)}`,
    stopDaemon: async () => void actions.push("stop"),
    startDaemon: async () => { actions.push("start"); return "started" as const; },
    log: (line: string) => logs.push(line),
  };
}

function serve(binary = Buffer.from("new-binary")): void {
  globalThis.fetch = async (input) => {
    const url = String(input);
    return new Response(url.includes("/bin/") ? binary : Buffer.from("fixture"), { status: 200 });
  };
}

test("upgrade command first current-version gate restarts stale daemons", async () => {
  await liveRuntime("outer-gate", 501, "1.7.18");
  serve();
  const actions: string[] = [];
  const logs: string[] = [];
  await upgradeCmd("https://releases.example", {
    commandDeps: commandDeps(manifest(RBOX_VERSION)),
    daemonDeps: daemonDeps(actions, logs),
  });
  expect(actions).toEqual(["stop", "start"]);
  expect(logs[0]).toBe(`binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`);
});

test("upgrade command check mode does not restart stale daemons at the current-version gate", async () => {
  await liveRuntime("check-gate", 502, "1.7.18");
  serve();
  const actions: string[] = [];
  const logs: string[] = [];
  const consoleLogs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      check: true,
      commandDeps: commandDeps(manifest(RBOX_VERSION)),
      daemonDeps: daemonDeps(actions, logs),
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(actions).toEqual([]);
  expect(logs).toEqual([]);
  expect(consoleLogs).toEqual([
    "checking the latest channel…",
    `already up to date (${RBOX_VERSION})`,
  ]);
});

test("check mode never syncs the menu-bar app", async () => {
  serve();
  let syncs = 0;
  await upgradeCmd("https://releases.example", {
    check: true,
    commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), syncMenuBarApp: async () => { syncs += 1; } },
  });
  expect(syncs).toBe(0);
});

test("next channel persists per install and derives both manifest URLs", async () => {
  const urls: string[] = [];
  const consoleLogs: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("fixture", { status: 200 });
  };
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example/", {
      check: true,
      channel: "next",
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    });
    await upgradeCmd("https://releases.example/", {
      check: true,
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(urls).toEqual([
    "https://releases.example/next/version",
    "https://releases.example/next/version.sig",
    "https://releases.example/next/version",
    "https://releases.example/next/version.sig",
  ]);
  expect(consoleLogs.filter((line) => line === "checking the next channel…")).toHaveLength(2);
  expect(JSON.parse(await fs.readFile(`${executable}.channel.json`, "utf8"))).toEqual({ schema: 1, channel: "next" });
});

test("explicit channel repairs a corrupt persisted setting while an unflagged upgrade fails closed", async () => {
  const channelFile = `${executable}.channel.json`;
  await fs.writeFile(channelFile, '{"schema":1,"channel":"beta"}\n');
  serve();
  await expect(upgradeCmd("https://releases.example", {
    check: true,
    commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
  })).rejects.toThrow("expected latest or next");

  const consoleLogs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      check: true,
      channel: "next",
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(consoleLogs[0]).toBe("checking the next channel…");
  expect(JSON.parse(await fs.readFile(channelFile, "utf8"))).toEqual({ schema: 1, channel: "next" });
});

test("switching from next to an older latest refuses and leaves next persisted", async () => {
  await fs.writeFile(`${executable}.channel.json`, `${JSON.stringify({ schema: 1, channel: "next" })}\n`);
  serve();
  const latest = "1.0.0";
  await expect(upgradeCmd("https://releases.example", {
    check: true,
    channel: "latest",
    commandDeps: { ...commandDeps(manifest(latest)), isElevated: () => true },
  })).rejects.toThrow(
    `cannot switch to the latest channel: installed rbox ${RBOX_VERSION} is newer than latest ${latest}; install a newer latest release before switching back`,
  );
  expect(JSON.parse(await fs.readFile(`${executable}.channel.json`, "utf8"))).toEqual({ schema: 1, channel: "next" });
});

test("failed next manifest authentication does not persist the requested channel", async () => {
  serve();
  await expect(upgradeCmd("https://releases.example", {
    check: true,
    channel: "next",
    commandDeps: {
      isStandaloneBinary: () => true,
      isElevated: () => true,
      verifyAndParseManifest: () => { throw new Error("signature invalid"); },
    },
  })).rejects.toThrow("signature invalid");
  expect(fsSync.existsSync(`${executable}.channel.json`)).toBe(false);
});

test("a signed manifest without this platform does not persist the requested channel", async () => {
  serve();
  await expect(upgradeCmd("https://releases.example", {
    check: true,
    channel: "next",
    commandDeps: {
      isStandaloneBinary: () => true,
      isElevated: () => true,
      verifyAndParseManifest: () => ({ version: nextVersion(), keyId: "test", artifacts: {} }),
    },
  })).rejects.toThrow(`release has no valid artifact for ${artifact()}`);
  expect(fsSync.existsSync(`${executable}.channel.json`)).toBe(false);
});

test.skipIf(process.geteuid === undefined || process.geteuid() === 0)(
  "unreadable legacy sudo state cannot block the first non-sudo daemon repair",
  async () => {
    await liveRuntime("legacy-sudo-state", 5021, "1.7.18");
    const legacy = path.join(home, ".rbox", "release.json");
    await fs.writeFile(legacy, JSON.stringify({ version: nextVersion() }), { mode: 0o600 });
    await fs.chmod(legacy, 0o000);
    serve();
    const actions: string[] = [];
    const logs: string[] = [];
    await upgradeCmd("https://releases.example", {
      commandDeps: commandDeps(manifest(RBOX_VERSION)),
      daemonDeps: daemonDeps(actions, logs),
    });
    expect(actions).toEqual(["stop", "start"]);
    expect(logs[0]).toBe(`binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`);
  },
);

test("post-lock loser with a newer floor leaves daemons to a fresh process", async () => {
  await liveRuntime("locked-gate", 503, "1.7.18");
  serve();
  const version = nextVersion();
  const base = manifest(version);
  const release = {
    version: base.version,
    keyId: base.keyId,
    get artifacts() {
      fsSync.writeFileSync(path.join(home, ".rbox", "release.json"), JSON.stringify({ version }));
      return base.artifacts;
    },
  } as ReleaseManifest;
  const actions: string[] = [];
  const logs: string[] = [];
  const consoleLogs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: commandDeps(release),
      daemonDeps: daemonDeps(actions, logs),
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(actions).toEqual([]);
  expect(logs).toEqual([]);
  expect(consoleLogs).toEqual([
    "checking the latest channel…",
    `verified upgrade floor is ${version}; this process is ${RBOX_VERSION} — run \`rbox upgrade\` again from a fresh shell`,
  ]);
  expect(await fs.readFile(executable, "utf8")).toBe("old-binary");
});

test("successful upgrade runs the full daemon pass without current-version filtering", async () => {
  await liveRuntime("full-upgrade", 504, RBOX_VERSION);
  const binary = Buffer.from("replacement-binary");
  serve(binary);
  const release = manifest(nextVersion(), binary);
  const actions: string[] = [];
  const logs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: commandDeps(release),
      daemonDeps: daemonDeps(actions, logs),
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(actions).toEqual(["stop", "start"]);
  expect(await fs.readFile(executable)).toEqual(binary);
});

test("current and upgraded paths both sync the menu-bar app", async () => {
  serve();
  const synced: string[] = [];
  await upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), syncMenuBarApp: async (release) => { synced.push(release.version); } },
  });
  const binary = Buffer.from("menu-bar-upgrade");
  serve(binary);
  const release = manifest(nextVersion(), binary);
  await upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(release), syncMenuBarApp: async (candidate) => { synced.push(candidate.version); } },
  });
  expect(synced).toEqual([RBOX_VERSION, release.version]);
});

test("daemon restart failure still syncs the menu-bar app before propagating", async () => {
  await liveRuntime("restart-failure", 505, RBOX_VERSION);
  const binary = Buffer.from("restart-failure-upgrade");
  serve(binary);
  let synced = false;
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(manifest(nextVersion(), binary)), syncMenuBarApp: async () => { synced = true; } },
    daemonDeps: {
      ...daemonDeps([], []),
      stopDaemon: async () => { throw new Error("cannot stop"); },
    },
  })).rejects.toThrow("could not be restarted");
  expect(synced).toBe(true);
});

test("elevated equal-version upgrade never enters home-scoped daemon or release paths", async () => {
  serve();
  const actions: string[] = [];
  const logs: string[] = [];
  const consoleLogs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
      daemonDeps: daemonDeps(actions, logs),
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(actions).toEqual([]);
  expect(logs).toEqual([]);
  expect(consoleLogs).toEqual([
    "checking the latest channel…",
    `already up to date (${RBOX_VERSION})`,
  ]);
  expect(fsSync.existsSync(home)).toBe(false);
});

test("elevated check is read-only and home-isolated", async () => {
  serve();
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await upgradeCmd("https://releases.example", {
      check: true,
      commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(fsSync.existsSync(`${executable}.release.json`)).toBe(false);
  expect(fsSync.existsSync(`${executable}.upgrade.lock`)).toBe(false);
  expect(fsSync.existsSync(home)).toBe(false);
  expect(fsSync.existsSync(poisonHome)).toBe(false);
  expect(fsSync.existsSync(poisonXdgConfigHome)).toBe(false);
});

test("elevated successful upgrade keeps state beside the executable and skips user daemons", async () => {
  const binary = Buffer.from("elevated-replacement");
  const version = nextVersion();
  serve(binary);
  const actions: string[] = [];
  const logs: string[] = [];
  const consoleLogs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void consoleLogs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(version, binary)), isElevated: () => true },
      daemonDeps: daemonDeps(actions, logs),
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(await fs.readFile(executable)).toEqual(binary);
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toEqual({
    schema: 1,
    version,
    phase: "committed",
  });
  expect((await fs.stat(`${executable}.release.json`)).mode & 0o777).toBe(0o644);
  expect(fsSync.existsSync(`${executable}.upgrade.lock`)).toBe(false);
  expect(fsSync.existsSync(home)).toBe(false);
  expect(fsSync.existsSync(poisonHome)).toBe(false);
  expect(fsSync.existsSync(poisonXdgConfigHome)).toBe(false);
  expect(actions).toEqual([]);
  expect(logs).toEqual([]);
  expect(consoleLogs).toEqual([
    "checking the latest channel…",
    `upgraded ${RBOX_VERSION} → ${version}`,
    "run `rbox upgrade` once without sudo to restart user daemons on the new version",
  ]);
});
