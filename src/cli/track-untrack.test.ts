import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { track } from "./track-cmd.js";
import { untrack } from "./untrack-cmd.js";
import { findRoot, loadConfig } from "./config.js";

let dir: string;
let logs: string[];
const origLog = console.log;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-"));
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
});
afterEach(async () => {
  console.log = origLog;
  await fs.rm(dir, { recursive: true, force: true });
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
