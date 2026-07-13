import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKLOAD_TAR, ensureWorkloadDir, resolveWorkloadTar, sha8OfFile, workloadDirName } from "./workload.js";

test("workloadDirName is content-addressed (same tarball bytes → same cache dir)", () => {
  expect(workloadDirName("deadbeef")).toBe("conductor-deadbeef");
});

test("ensureWorkloadDir: atomic staging — cache hit on 2nd call, .rbox stripped, orphan tmp cleared", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-workload-stage-"));
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "workspaces", ".rbox"), { recursive: true });
  fs.mkdirSync(path.join(src, "workspaces", "proj"), { recursive: true });
  fs.writeFileSync(path.join(src, "workspaces", "proj", "a.txt"), "hello");
  fs.writeFileSync(path.join(src, "workspaces", ".rbox", "workspace.json"), "{}");
  const tar = path.join(root, "w.tar.gz");
  Bun.spawnSync(["tar", "-czf", tar, "-C", src, "workspaces"]);
  const cache = path.join(root, "cache");
  // Orphan from a hypothetical interrupted extraction must get cleared.
  fs.mkdirSync(path.join(cache, ".tmp-conductor-dead-1"), { recursive: true });

  try {
    const first = await ensureWorkloadDir(tar, cache, () => {});
    expect(first.cached).toBe(false);
    expect(fs.readFileSync(path.join(first.dir, "workspaces", "proj", "a.txt"), "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(first.dir, "workspaces", ".rbox"))).toBe(false); // stripped
    expect(fs.readdirSync(cache).filter((e) => e.startsWith(".tmp-"))).toEqual([]); // orphan cleared
    const second = await ensureWorkloadDir(tar, cache, () => {});
    expect(second.cached).toBe(true);
    expect(second.dir).toBe(first.dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkloadTar prefers the flag, else the default backup path", () => {
  expect(resolveWorkloadTar({ "workload-tar": "/tmp/foo.tar.gz" })).toBe("/tmp/foo.tar.gz");
  expect(resolveWorkloadTar({})).toBe(DEFAULT_WORKLOAD_TAR);
  // A bare `--workload-tar` (no value → "true") must NOT be treated as a path.
  expect(resolveWorkloadTar({ "workload-tar": "true" })).toBe(DEFAULT_WORKLOAD_TAR);
  expect(DEFAULT_WORKLOAD_TAR).toContain("conductor-workspaces-backup");
});

test("sha8OfFile is a stable 8-hex-char digest of the bytes", async () => {
  const f = path.join(os.tmpdir(), `rig-workload-test-${process.pid}.bin`);
  fs.writeFileSync(f, "the quick brown fox");
  try {
    const a = await sha8OfFile(f);
    const b = await sha8OfFile(f);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    // Different bytes → (almost certainly) different key.
    fs.writeFileSync(f, "the quick brown fox!");
    expect(await sha8OfFile(f)).not.toBe(a);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

afterAll(() => {});
