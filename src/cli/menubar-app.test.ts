import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncMenuBarApp, type MenuBarDeps } from "./menubar-app.js";
import type { Manifest } from "./release-verify.js";

const version = "2.0.0";
const zipBytes = Buffer.from("rboxbar-zip");
const zipSha = createHash("sha256").update(zipBytes).digest("hex");
let sandbox: string;
let home: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-menubar-"));
  home = path.join(sandbox, "home");
  await fs.mkdir(home);
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function manifest(overrides: Partial<Manifest["artifacts"][string]> = {}): Manifest {
  return {
    version,
    keyId: "test",
    artifacts: {
      "RboxBar.zip": {
        sha256: zipSha,
        path: `v${version}/RboxBar-${version}.zip`,
        ...overrides,
      },
    },
  };
}

type HarnessOptions = {
  running?: boolean;
  downloadSha?: string;
  openCode?: number;
};

function harness(options: HarnessOptions = {}) {
  const commands: string[][] = [];
  const downloads: Array<{ url: string; dir: string }> = [];
  const logs: string[] = [];
  let running = options.running ?? false;
  const run: NonNullable<MenuBarDeps["run"]> = async (cmd) => {
    commands.push(cmd);
    if (cmd[0] === "plutil") {
      try {
        return { code: 0, stdout: await fs.readFile(cmd[4]!, "utf8") };
      } catch {
        return { code: 1, stdout: "" };
      }
    }
    if (cmd[0] === "ditto") {
      const extracted = path.join(cmd[4]!, "RboxBar.app", "Contents");
      await fs.mkdir(extracted, { recursive: true });
      await fs.writeFile(path.join(extracted, "Info.plist"), version);
      return { code: 0, stdout: "" };
    }
    if (cmd[0] === "pgrep") return { code: running ? 0 : 1, stdout: "" };
    if (cmd[0] === "pkill") {
      running = false;
      return { code: 0, stdout: "" };
    }
    if (cmd[0] === "open") return { code: options.openCode ?? 0, stdout: "" };
    return { code: 0, stdout: "" };
  };
  const download: NonNullable<MenuBarDeps["download"]> = async (url, dir) => {
    downloads.push({ url, dir });
    const tmp = path.join(dir, "RboxBar.zip");
    await fs.writeFile(tmp, zipBytes);
    return { tmp, sha256: options.downloadSha ?? zipSha };
  };
  return {
    commands,
    downloads,
    logs,
    deps: { platform: "darwin", env: {}, homeDir: home, run, download, log: (line) => logs.push(line) } satisfies MenuBarDeps,
  };
}

const destination = () => path.join(home, "Applications", "RboxBar.app");
const infoPlist = () => path.join(destination(), "Contents", "Info.plist");

async function existingApp(installedVersion = "1.9.0"): Promise<void> {
  await fs.mkdir(path.dirname(infoPlist()), { recursive: true });
  await fs.writeFile(infoPlist(), installedVersion);
}

test("non-darwin, opt-out, and missing artifact are silent no-ops", async () => {
  for (const setup of [
    (deps: MenuBarDeps) => { deps.platform = "linux"; },
    (deps: MenuBarDeps) => { deps.env = { RBOX_NO_MENUBAR_APP: "1" }; },
  ]) {
    const h = harness();
    setup(h.deps);
    await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
    expect(h.commands).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(h.logs).toEqual([]);
  }
  const h = harness();
  await syncMenuBarApp({ ...manifest(), artifacts: {} }, "https://releases.test", h.deps);
  expect(h.commands).toEqual([]);
  expect(h.downloads).toEqual([]);
  expect(h.logs).toEqual([]);
});

test("bad artifact binding refuses before download", async () => {
  const h = harness();
  await syncMenuBarApp(manifest({ path: "v9.9.9/RboxBar-9.9.9.zip" }), "https://releases.test", h.deps);
  expect(h.downloads).toEqual([]);
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0]).toContain("rbox Bar not updated:");
});

test("bad sha refuses and leaves the old bundle byte-identical", async () => {
  await existingApp();
  const before = await fs.readFile(infoPlist());
  const h = harness({ downloadSha: "0".repeat(64) });
  await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
  expect(await fs.readFile(infoPlist())).toEqual(before);
  expect(h.logs).toHaveLength(1);
  expect(h.commands.some(([cmd]) => cmd === "ditto")).toBe(false);
});

test("an already-current bundle is a true no-op", async () => {
  await existingApp(version);
  const h = harness({ running: true });
  await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
  expect(h.downloads).toEqual([]);
  expect(h.commands.map(([cmd]) => cmd)).toEqual(["plutil"]);
  expect(h.logs).toEqual([]);
});

test("fresh install creates the user bundle and starts it", async () => {
  const h = harness();
  await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
  expect(await fs.readFile(infoPlist(), "utf8")).toBe(version);
  expect(h.downloads[0]?.url).toBe(`https://releases.test/bin/v${version}/RboxBar-${version}.zip`);
  // Default-on is only real if the icon appears without a second command.
  expect(h.commands.map(([cmd]) => cmd)).toContain("open");
  expect(h.commands.map(([cmd]) => cmd)).not.toContain("pkill");
  expect(h.logs).toEqual([`rbox Bar (macOS menu-bar app) installed to ${destination()} and started`]);
});

test("an existing system installation takes precedence over the user destination", async () => {
  const exists = spyOn(fsSync, "existsSync").mockImplementation((candidate) =>
    candidate === "/Applications/RboxBar.app" || fsSync.statSync(candidate, { throwIfNoEntry: false }) !== undefined);
  const h = harness();
  h.deps.run = async (cmd) => {
    h.commands.push(cmd);
    if (cmd[0] === "plutil") return { code: 0, stdout: `${version}\n` };
    return { code: 0, stdout: "" };
  };
  try {
    await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
  } finally {
    exists.mockRestore();
  }
  expect(h.commands[0]?.[4]).toBe("/Applications/RboxBar.app/Contents/Info.plist");
  expect(fsSync.existsSync(destination())).toBe(false);
});

test("running and stopped updates preserve launch state", async () => {
  await existingApp();
  const running = harness({ running: true });
  await syncMenuBarApp(manifest(), "https://releases.test", running.deps);
  expect(running.commands.map(([cmd]) => cmd)).toContain("pkill");
  expect(running.commands.map(([cmd]) => cmd)).toContain("open");
  expect(running.logs).toEqual([`rbox Bar updated to ${version} and restarted`]);

  // A bundle the user had quit stays quit — an update must not resurrect it.
  await fs.writeFile(infoPlist(), "1.9.0");
  const stopped = harness();
  await syncMenuBarApp(manifest(), "https://releases.test", stopped.deps);
  expect(stopped.commands.map(([cmd]) => cmd)).not.toContain("pkill");
  expect(stopped.commands.map(([cmd]) => cmd)).not.toContain("open");
  expect(stopped.logs).toEqual([`rbox Bar updated to ${version}`]);
});

test("open failure reports the completed update and still resolves", async () => {
  await existingApp();
  const h = harness({ running: true, openCode: 1 });
  await expect(syncMenuBarApp(manifest(), "https://releases.test", h.deps)).resolves.toBeUndefined();
  expect(h.logs).toEqual([`rbox Bar updated to ${version} — run \`open -a RboxBar\` to start it`]);
});

test("an unwritable destination logs one failure and resolves", async () => {
  const blockedHome = path.join(sandbox, "not-a-directory");
  await fs.writeFile(blockedHome, "blocked");
  const h = harness();
  h.deps.homeDir = blockedHome;
  await expect(syncMenuBarApp(manifest(), "https://releases.test", h.deps)).resolves.toBeUndefined();
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0]).toContain("rbox Bar not updated:");
});

test("a stale backup from a crashed pass is removed", async () => {
  await existingApp();
  const old = `${destination()}.old`;
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, "stale"), "stale");
  const h = harness();
  await syncMenuBarApp(manifest(), "https://releases.test", h.deps);
  expect(fsSync.existsSync(old)).toBe(false);
  expect(await fs.readFile(infoPlist(), "utf8")).toBe(version);
});
