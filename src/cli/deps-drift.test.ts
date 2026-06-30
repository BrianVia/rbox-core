import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkDrift,
  loadDepsState,
  nudgeForWrittenPaths,
  renderNotices,
  saveDepsState,
} from "./deps-drift.js";

let cfgDir: string;
let proj: string;

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-cfg-"));
  proj = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-proj-"));
  process.env.RBOX_CONFIG_DIR = cfgDir;
  delete process.env.RBOX_NO_DRIFT;
});
afterEach(async () => {
  delete process.env.RBOX_CONFIG_DIR;
  await fs.rm(cfgDir, { recursive: true, force: true });
  await fs.rm(proj, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(proj, rel), content);

test("first sighting establishes a silent baseline; a later content change nudges with the right command", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", JSON.stringify({ v: 1 }));

  // Baseline (the cd hook's first visit) — no notice.
  expect(await checkDrift(proj)).toEqual([]);

  // Lockfile content changes (different length → bypasses the mtime/size gate).
  await write("package-lock.json", JSON.stringify({ v: 2, more: "data here" }));
  const notices = await checkDrift(proj);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.lockfile).toBe("package-lock.json");
  expect(notices[0]!.command).toBe("npm ci"); // exactly the engine baseArgs

  // No further change → silent (and nudges at most once per change).
  expect(await checkDrift(proj)).toEqual([]);
  expect(await checkDrift(proj)).toEqual([]);
});

test("cargo (global cache, no installDir) relies on the hash signal and suggests `cargo fetch --locked`", async () => {
  await write("Cargo.toml", "[package]");
  await write("Cargo.lock", "v1");
  expect(await checkDrift(proj)).toEqual([]);
  await write("Cargo.lock", "version two longer");
  const notices = await checkDrift(proj);
  expect(notices[0]!.command).toBe("cargo fetch --locked");
});

test("install-dir suppressor: node_modules newer than the lockfile suppresses the nudge", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", "v1");
  await checkDrift(proj); // baseline

  await write("package-lock.json", "v2 changed and longer");
  const lockStat = await fs.stat(path.join(proj, "package-lock.json"));
  await fs.mkdir(path.join(proj, "node_modules"));
  // node_modules mtime in the future relative to the lock → "looks freshly installed".
  const future = new Date(lockStat.mtimeMs + 100_000);
  await fs.utimes(path.join(proj, "node_modules"), future, future);

  expect(await checkDrift(proj)).toEqual([]); // suppressed
});

test("post-sync nudge forces a notice on the just-written lockfile (no baseline grace)", async () => {
  await write("go.mod", "module x");
  await write("go.sum", "hashes");
  // A sync wrote go.sum — we KNOW it changed, so the first sighting still nudges.
  const notices = await nudgeForWrittenPaths(proj, ["go.sum"]);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.command).toBe("go mod download");

  // It records state, so a subsequent cd-hook check for the same content is silent.
  expect(await checkDrift(proj)).toEqual([]);
});

test("post-sync nudge ignores non-lockfile writes", async () => {
  await write("README.md", "hi");
  expect(await nudgeForWrittenPaths(proj, ["README.md", "src/app.ts"])).toEqual([]);
});

test("ambiguous node dir (multiple lockfiles) → tier-b notice with no command", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", "npm");
  await write("pnpm-lock.yaml", "pnpm");
  const notices = await nudgeForWrittenPaths(proj, ["package-lock.json", "pnpm-lock.yaml"]);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.command).toBeUndefined();
});

test("RBOX_NO_DRIFT disables the check entirely", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", "v1");
  process.env.RBOX_NO_DRIFT = "1";
  expect(await checkDrift(proj)).toEqual([]);
  expect(await nudgeForWrittenPaths(proj, ["package-lock.json"])).toEqual([]);
});

test("quiet mode honors the notify toggle; explicit mode always runs", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", "v1");
  await checkDrift(proj); // baseline
  await write("package-lock.json", "v2 longer changed");

  const state = await loadDepsState();
  state.notifyEnabled = false;
  await saveDepsState(state);

  // Hook (quiet) stays silent when paused…
  expect(await checkDrift(proj, { quiet: true })).toEqual([]);
  // …but the explicit `rbox deps drift` still reports.
  expect(await checkDrift(proj, { quiet: false })).toHaveLength(1);
});

test("state round-trips through the global store (atomic write)", async () => {
  await write("package.json", "{}");
  await write("package-lock.json", "v1");
  await checkDrift(proj);
  const onDisk = await loadDepsState();
  const key = path.join(proj, "package-lock.json");
  expect(onDisk.locks[key]).toBeDefined();
  expect(onDisk.locks[key]!.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("renderNotices caps at the top 3 and prefixes each line", () => {
  const out = renderNotices([
    { dir: "a", lockfile: "package-lock.json", command: "npm ci" },
    { dir: "b", lockfile: "Cargo.lock", command: "cargo fetch --locked" },
    { dir: "c", lockfile: "go.sum", command: "go mod download" },
    { dir: "d", lockfile: "uv.lock", command: "uv sync --frozen" },
  ]);
  const lines = out.split("\n");
  expect(lines).toHaveLength(4); // 3 notices + "… and 1 more"
  expect(lines[0]).toBe("> dependencies changed in a — run `npm ci` to update.");
  expect(lines[3]).toBe("> … and 1 more");
});
