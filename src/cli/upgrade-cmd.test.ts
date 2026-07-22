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

let home: string;
let executable: string;
let originalExecPath: string;
let originalFetch: typeof globalThis.fetch;
const rows: DesiredStateRow[] = [];

const nextVersion = (): string => {
  const [major, minor, patch] = RBOX_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
};

const artifact = (): string => `rbox-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upgrade-cmd-"));
  executable = path.join(home, "bin", "rbox");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "old-binary");
  originalExecPath = process.execPath;
  process.execPath = executable;
  process.env.RBOX_HOME = home;
  originalFetch = globalThis.fetch;
  rows.length = 0;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.execPath = originalExecPath;
  delete process.env.RBOX_HOME;
  rows.length = 0;
  await fs.rm(home, { recursive: true, force: true });
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

test("upgrade command post-lock current-version gate restarts stale daemons", async () => {
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
  await upgradeCmd("https://releases.example", {
    commandDeps: commandDeps(release),
    daemonDeps: daemonDeps(actions, logs),
  });
  expect(actions).toEqual(["stop", "start"]);
  expect(logs[0]).toBe(`binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`);
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
