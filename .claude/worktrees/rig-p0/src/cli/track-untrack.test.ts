import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { track } from "./track-cmd.js";
import { untrack } from "./untrack-cmd.js";
import { findRoot, loadConfig } from "./config.js";
import { daemonRuntimeDir } from "./daemon-control.js";
import { desiredStatePath } from "./autostart-cmd.js";

let dir: string;
let home: string;
let logs: string[];
const origLog = console.log;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-home-"));
  process.env.RBOX_HOME = home; // redirect ~/.rbox so daemon runtime files are inspectable
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
});
afterEach(async () => {
  console.log = origLog;
  delete process.env.RBOX_HOME;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("track writes a `.rbox/` binding; untrack removes it (round-trip)", async () => {
  // `--workspace` adopts an id offline (no network/login) — the bind-only path.
  const { cfg, root } = await track(dir, { workspace: "ws_abc123" }, "https://api.test");
  expect(cfg.remoteWorkspaceId).toBe("ws_abc123");
  expect(root).toBe(path.resolve(dir)); // track resolves (not realpaths) the arg

  // The workspace config is on disk and resolvable like every path command.
  const loaded = await loadConfig(root);
  expect(loaded.remoteWorkspaceId).toBe("ws_abc123");
  expect(loaded.token).toBe(""); // never persisted (injected at runtime)
  expect(await findRoot(root)).toBe(root);

  // untrack (no daemon running) removes the whole `.rbox/` tree.
  await untrack({ root, force: true });
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow();
  expect(await findRoot(root)).toBeUndefined();
});

test("track is bind-only: it persists config but does NOT create state.json (no first sync)", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  await fs.access(path.join(root, ".rbox", "workspace.json")); // exists (throws if missing)
  // state.json is written by sync, not by track — proves no first sync happened.
  await expect(fs.access(path.join(root, ".rbox", "state.json"))).rejects.toThrow();
});

test("untrack also removes the global daemon runtime dir (no orphans under ~/.rbox)", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  // Simulate a daemon having written its pid/log to the global per-workspace dir.
  const runtimeDir = daemonRuntimeDir(root);
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "daemon.log"), "sync\n");
  await fs.writeFile(path.join(runtimeDir, "daemon.pid"), "12345");
  await fs.writeFile(desiredStatePath(root), JSON.stringify({ rootPath: root, state: "running", accountId: "acct_x", workspaceId: "ws_x", at: "2026-07-03T18:00:00.000Z" }));

  await untrack({ root, force: true });

  await expect(fs.access(runtimeDir)).rejects.toThrow(); // global runtime dir is gone
  await expect(fs.access(desiredStatePath(root))).rejects.toThrow();
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow(); // workspace binding too
});

test("untrack refuses when there is no binding to remove", async () => {
  await expect(untrack({ root: dir, force: true })).rejects.toThrow(/nothing to untrack/);
});

test("untrack refuses a symlinked `.rbox` instead of blindly removing it", async () => {
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-evil-"));
  await fs.writeFile(path.join(elsewhere, "keep.txt"), "important");
  await fs.symlink(elsewhere, path.join(dir, ".rbox"));
  try {
    await expect(untrack({ root: dir, force: true })).rejects.toThrow(/symlink/);
    // The symlink target is untouched.
    await fs.access(path.join(elsewhere, "keep.txt")); // exists (throws if missing)
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("untrack honors an interactive 'no' (confirm returns false) and changes nothing", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  await untrack({ root, force: false, confirm: async () => false });
  await fs.access(path.join(root, ".rbox", "workspace.json")); // exists (throws if missing)
});

// ── design 44 §2: track rebind resets the sync baseline ─────────────────────

test("re-tracking a DIFFERENT workspace resets the baseline (even a legacy unstamped one) and keeps the device id", async () => {
  const { cfg: first } = await track(dir, { workspace: "ws_old" }, "https://api.test");

  // A LEGACY (pre-stamp) baseline from the old workspace: the ownership check can't
  // tell it apart, so track itself must reset it on rebind (codex BLOCKER).
  const statePath = path.join(dir, ".rbox", "state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({ lastSyncedSequence: 9, lastSyncedManifest: { generatedAt: "", files: [{ path: "old.txt", type: "file", sha256: "x", size: 1, mode: 420, mtimeMs: 1 }] } })
  );

  const { cfg: rebound } = await track(dir, { workspace: "ws_new" }, "https://api.test");
  expect(rebound.remoteWorkspaceId).toBe("ws_new");
  expect(rebound.deviceId).toBe(first.deviceId); // rebinding must not mint a new device
  await expect(fs.access(statePath)).rejects.toThrow(); // poisoned baseline gone

  // Re-tracking the SAME workspace keeps an existing baseline untouched.
  await fs.writeFile(statePath, JSON.stringify({ stream: "https://api.test::ws_new::root", lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] } }));
  await track(dir, { workspace: "ws_new" }, "https://api.test");
  expect(JSON.parse(await fs.readFile(statePath, "utf8")).lastSyncedSequence).toBe(3);
});
