import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCmd } from "./upgrade-cmd.js";
import { workspaceKey } from "./rbox-paths.js";
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
  const [major, minor, patch] = RBOX_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
};

const versionAfter = (offset: number): string => {
  const [major, minor, patch] = RBOX_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch! + offset}`;
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
  const root = path.join(home, name);
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
  expect(consoleLogs).toEqual([`already up to date (${RBOX_VERSION})`]);
});

test.skipIf(typeof process.geteuid !== "function" || process.geteuid() === 0)(
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
  expect(consoleLogs).toEqual([`already up to date (${RBOX_VERSION})`]);
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
    `upgraded ${RBOX_VERSION} → ${version}`,
    "run `rbox upgrade` once without sudo to restart user daemons on the new version",
  ]);
});

test("pending floor survives failure before rename, blocks intermediates, and permits exact repair", async () => {
  const target = versionAfter(2);
  const intermediate = versionAfter(1);
  const targetBinary = Buffer.from("target-binary");
  serve(targetBinary);
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: {
      ...commandDeps(manifest(target, targetBinary)),
      isElevated: () => true,
      afterPendingState: () => { throw new Error("injected pre-rename failure"); },
    },
  })).rejects.toThrow("injected pre-rename failure");
  expect(await fs.readFile(executable, "utf8")).toBe("old-binary");
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({
    version: target,
    phase: "pending",
  });

  const logs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(intermediate)), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(await fs.readFile(executable, "utf8")).toBe("old-binary");
  expect(logs).toEqual([
    `verified upgrade floor is ${target}; this process is ${RBOX_VERSION} — run \`rbox upgrade\` again from a fresh shell`,
  ]);

  serve(targetBinary);
  const repairLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(target, targetBinary)), isElevated: () => true },
    });
  } finally {
    repairLog.mockRestore();
  }
  expect(await fs.readFile(executable)).toEqual(targetBinary);
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({
    version: target,
    phase: "committed",
  });
});

test("failure after executable rename retains a pending floor that blocks rollback", async () => {
  const target = versionAfter(2);
  const intermediate = versionAfter(1);
  const targetBinary = Buffer.from("renamed-before-failure");
  serve(targetBinary);
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: {
      ...commandDeps(manifest(target, targetBinary)),
      isElevated: () => true,
      afterExecutableRename: () => { throw new Error("injected post-rename failure"); },
    },
  })).rejects.toThrow("injected post-rename failure");
  expect(await fs.readFile(executable)).toEqual(targetBinary);
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({
    version: target,
    phase: "pending",
  });

  serve(Buffer.from("intermediate-rollback"));
  const logs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(intermediate, Buffer.from("intermediate-rollback"))), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(await fs.readFile(executable)).toEqual(targetBinary);
  expect(logs).toEqual([
    `verified upgrade floor is ${target}; this process is ${RBOX_VERSION} — run \`rbox upgrade\` again from a fresh shell`,
  ]);
});

test("elevated and non-elevated contenders share the executable-scoped lock", async () => {
  const high = versionAfter(2);
  const low = versionAfter(1);
  const highBinary = Buffer.from("highest-binary");
  let entered!: () => void;
  const downloadEntered = new Promise<void>((resolve) => { entered = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(`/bin/v${high}/`)) {
      entered();
      await blocked;
      return new Response(highBinary, { status: 200 });
    }
    return new Response(Buffer.from("fixture"), { status: 200 });
  };
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    const highUpgrade = upgradeCmd("https://releases.example", {
      commandDeps: {
        ...commandDeps(manifest(high, highBinary)),
        isElevated: () => true,
      },
    });
    await downloadEntered;
    await expect(upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(low)), isElevated: () => false },
    })).rejects.toThrow(/another rbox upgrade is already running/);
    unblock();
    await highUpgrade;
  } finally {
    consoleLog.mockRestore();
  }
  expect(await fs.readFile(executable)).toEqual(highBinary);
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({
    version: high,
    phase: "committed",
  });
});

test("existing malformed or symlinked canonical release state fails closed", async () => {
  serve();
  await fs.writeFile(`${executable}.release.json`, "{broken");
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => true },
  })).rejects.toThrow(/release state is malformed/);

  await fs.rm(`${executable}.release.json`);
  const target = path.join(sandbox, "state-target");
  await fs.writeFile(target, JSON.stringify({ schema: 1, version: nextVersion(), phase: "committed" }));
  await fs.symlink(target, `${executable}.release.json`);
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => true },
  })).rejects.toThrow(/not a safe regular file/);

  await fs.rm(`${executable}.release.json`);
  await fs.writeFile(`${executable}.release.json`, "x".repeat(4097));
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => true },
  })).rejects.toThrow(/not a safe regular file/);

  if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
    await fs.rm(`${executable}.release.json`);
    await fs.writeFile(`${executable}.release.json`, JSON.stringify({
      schema: 1,
      version: nextVersion(),
      phase: "committed",
    }));
    await fs.chmod(`${executable}.release.json`, 0o000);
    await expect(upgradeCmd("https://releases.example", {
      commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => true },
    })).rejects.toThrow(/release state is unreadable/);
  }
});

test("upgrade lock marker and release state stay exactly readable under a restrictive umask", async () => {
  const binary = Buffer.from("umask-replacement");
  const version = nextVersion();
  serve(binary);
  let lockMode = 0;
  const oldUmask = process.umask(0o077);
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: {
        ...commandDeps(manifest(version, binary)),
        isElevated: () => true,
        afterPendingState: async () => {
          lockMode = (await fs.stat(`${executable}.upgrade.lock`)).mode & 0o777;
        },
      },
    });
  } finally {
    consoleLog.mockRestore();
    process.umask(oldUmask);
  }
  expect(lockMode).toBe(0o644);
  expect((await fs.stat(`${executable}.release.json`)).mode & 0o777).toBe(0o644);
});
