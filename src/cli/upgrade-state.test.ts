import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgradeCmd } from "./upgrade-cmd.js";
import { RBOX_VERSION } from "./version.js";
import type { Manifest as ReleaseManifest } from "./release-verify.js";

let sandbox: string;
let executable: string;
let originalExecPath: string;
let originalFetch: typeof globalThis.fetch;
const originalRboxHome = process.env.RBOX_HOME;
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

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
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upgrade-state-"));
  executable = path.join(sandbox, "install", "rbox");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "old-binary");
  originalExecPath = process.execPath;
  process.execPath = executable;
  process.env.RBOX_HOME = path.join(sandbox, "rbox-home");
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg");
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.execPath = originalExecPath;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = originalRboxHome;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

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
const commandDeps = (release: ReleaseManifest) => ({
  isStandaloneBinary: () => true,
  verifyAndParseManifest: () => release,
});
function serve(binary = Buffer.from("new-binary")): void {
  globalThis.fetch = async (input) => new Response(String(input).includes("/bin/") ? binary : Buffer.from("fixture"), { status: 200 });
}

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
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({ version: target, phase: "pending" });

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
    "checking the latest channel…",
    `an upgrade to ${target} is incomplete — run \`rbox upgrade\` again to finish it`,
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
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({ version: target, phase: "committed" });
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
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({ version: target, phase: "pending" });

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
    "checking the latest channel…",
    `an upgrade to ${target} is incomplete — run \`rbox upgrade\` again to finish it`,
  ]);
});

test("check mode distinguishes pending and committed floors above the running version", async () => {
  const target = nextVersion();
  serve();
  const logs: string[] = [];
  const consoleLog = spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  try {
    await fs.writeFile(`${executable}.release.json`, `${JSON.stringify({ schema: 1, version: target, phase: "pending" })}\n`);
    await upgradeCmd("https://releases.example", {
      check: true,
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    });
    await fs.writeFile(`${executable}.release.json`, `${JSON.stringify({ schema: 1, version: target, phase: "committed" })}\n`);
    await upgradeCmd("https://releases.example", {
      check: true,
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    });
  } finally {
    consoleLog.mockRestore();
  }
  expect(logs).toEqual([
    "checking the latest channel…",
    `an upgrade to ${target} is incomplete — run \`rbox upgrade\` again to finish it`,
    "checking the latest channel…",
    `verified upgrade floor is ${target}; this process is ${RBOX_VERSION} — run \`rbox upgrade\` again from a fresh shell`,
  ]);
});

test("non-durable lock release warns without replacing a primary error that already has a cause", async () => {
  const primary = new Error("injected upgrade failure", { cause: new Error("original cause") });
  const errors: string[] = [];
  const consoleError = spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
  let thrown: unknown;
  serve();
  try {
    await upgradeCmd("https://releases.example", {
      commandDeps: {
        ...commandDeps(manifest(nextVersion())),
        isElevated: () => true,
        afterPendingState: async () => {
          await fs.rm(`${executable}.upgrade.lock`);
          throw primary;
        },
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    consoleError.mockRestore();
  }
  expect(thrown).toBe(primary);
  expect(errors).toEqual(["upgrade finished without durably releasing its lock; retry after checking the install directory"]);
});

test.skipIf(typeof process.geteuid !== "function" || process.geteuid() === 0)(
  "non-elevated lock acquisition permission errors suggest sudo",
  async () => {
    const installDir = path.dirname(executable);
    const accessSync = fsSync.accessSync;
    const access = spyOn(fsSync, "accessSync").mockImplementation((target, mode) => {
      accessSync(target, mode);
      if (path.resolve(String(target)) === installDir && mode === fsSync.constants.W_OK) fsSync.chmodSync(installDir, 0o500);
    });
    serve();
    try {
      await expect(upgradeCmd("https://releases.example", {
        commandDeps: { ...commandDeps(manifest(nextVersion())), isElevated: () => false },
      })).rejects.toThrow(
        `cannot acquire the rbox upgrade lock at ${executable}.upgrade.lock — if this rbox install is root-owned, retry with \`sudo rbox upgrade\``,
      );
    } finally {
      access.mockRestore();
      fsSync.chmodSync(installDir, 0o700);
    }
  },
);

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
      commandDeps: { ...commandDeps(manifest(high, highBinary)), isElevated: () => true },
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
  expect(JSON.parse(await fs.readFile(`${executable}.release.json`, "utf8"))).toMatchObject({ version: high, phase: "committed" });
});

test("a concurrent latest switch cannot escape the next upgrade lock", async () => {
  const next = "2.0.0-beta.1";
  const nextBinary = Buffer.from("next-binary");
  let entered!: () => void;
  const downloadEntered = new Promise<void>((resolve) => { entered = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  globalThis.fetch = async (input) => {
    if (String(input).includes(`/bin/v${next}/`)) {
      entered();
      await blocked;
      return new Response(nextBinary, { status: 200 });
    }
    return new Response("fixture", { status: 200 });
  };
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    const nextUpgrade = upgradeCmd("https://releases.example", {
      channel: "next",
      commandDeps: { ...commandDeps(manifest(next, nextBinary)), isElevated: () => true },
    });
    await downloadEntered;
    await expect(upgradeCmd("https://releases.example", {
      check: true,
      channel: "latest",
      commandDeps: { ...commandDeps(manifest(RBOX_VERSION)), isElevated: () => true },
    })).rejects.toThrow(/another rbox upgrade is already running/);
    expect(JSON.parse(await fs.readFile(`${executable}.channel.json`, "utf8"))).toEqual({ schema: 1, channel: "next" });
    unblock();
    await nextUpgrade;
  } finally {
    consoleLog.mockRestore();
  }
  expect(await fs.readFile(executable)).toEqual(nextBinary);
  expect(JSON.parse(await fs.readFile(`${executable}.channel.json`, "utf8"))).toEqual({ schema: 1, channel: "next" });
});

test("an unflagged upgrade aborts if its persisted channel changes after fetch", async () => {
  const version = nextVersion();
  serve();
  await expect(upgradeCmd("https://releases.example", {
    commandDeps: {
      isStandaloneBinary: () => true,
      isElevated: () => true,
      verifyAndParseManifest: () => {
        fsSync.writeFileSync(`${executable}.channel.json`, `${JSON.stringify({ schema: 1, channel: "next" })}\n`);
        return manifest(version);
      },
    },
  })).rejects.toThrow("upgrade channel changed while this upgrade was running — retry");
  expect(await fs.readFile(executable, "utf8")).toBe("old-binary");
  expect(fsSync.existsSync(`${executable}.release.json`)).toBe(false);
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
