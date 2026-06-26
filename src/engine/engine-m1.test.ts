import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyWatchEvents,
  buildIgnoreMatcher,
  HashCache,
  scanManifest,
  validateManifest,
  isSafeRelPath,
  type WatchEvent,
} from "./index.js";
import type { FileEntry } from "./index.js";
import { createHash, randomBytes } from "node:crypto";
import { Sha256 } from "./sha256-stream.js";

// ---- manifest validation (the path-traversal / corruption defense) --------

const goodEntry = (over: Partial<FileEntry> = {}): FileEntry => ({
  path: "src/index.ts",
  sha256: "a".repeat(64),
  size: 10,
  mode: 0o644,
  mtimeMs: 0,
  type: "file",
  ...over,
});

test("validateManifest accepts a well-formed manifest", () => {
  const m = { generatedAt: "", files: [goodEntry(), goodEntry({ path: "b.ts" })] };
  expect(validateManifest(m).ok).toBe(true);
});

test("validateManifest rejects path traversal and unsafe paths", () => {
  for (const bad of ["../escape", "/abs/path", "a/../b", "a/./b", "a//b", "with\0nul", "win\\style", ""]) {
    const r = validateManifest({ files: [goodEntry({ path: bad })] });
    expect(r.ok).toBe(false);
  }
  // isSafeRelPath agrees
  expect(isSafeRelPath("a/b/c.ts")).toBe(true);
  expect(isSafeRelPath("../x")).toBe(false);
  expect(isSafeRelPath("/x")).toBe(false);
});

test("validateManifest rejects exact and case-insensitive duplicate paths", () => {
  expect(validateManifest({ files: [goodEntry({ path: "a.ts" }), goodEntry({ path: "a.ts" })] }).ok).toBe(false);
  expect(validateManifest({ files: [goodEntry({ path: "Foo.ts" }), goodEntry({ path: "foo.ts" })] }).ok).toBe(false);
});

test("validateManifest rejects malformed entries", () => {
  expect(validateManifest({ files: [goodEntry({ sha256: "xyz" })] }).ok).toBe(false); // bad sha
  expect(validateManifest({ files: [goodEntry({ type: "weird" as never })] }).ok).toBe(false); // bad type
  expect(validateManifest({ files: [goodEntry({ size: -1 })] }).ok).toBe(false); // bad size
  expect(validateManifest({ files: [goodEntry({ type: "symlink", symlinkTarget: undefined })] }).ok).toBe(false); // symlink no target
  expect(validateManifest({ files: "notarray" }).ok).toBe(false);
});

// ---- hash cache (the performance fast-path) -------------------------------

test("HashCache.lookup hits only on matching mtime+size", () => {
  const c = new HashCache();
  c.record("a.ts", { mtimeMs: 100, size: 5, sha256: "deadbeef" });
  expect(c.lookup("a.ts", 100, 5)).toBe("deadbeef"); // hit
  expect(c.lookup("a.ts", 101, 5)).toBeUndefined(); // mtime changed
  expect(c.lookup("a.ts", 100, 6)).toBeUndefined(); // size changed
  c.invalidate("a.ts");
  expect(c.lookup("a.ts", 100, 5)).toBeUndefined(); // invalidated
});

test("scanManifest consults the cache (seeded wrong sha is returned, proving no re-hash)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-"));
  try {
    const abs = path.join(dir, "a.txt");
    await fs.writeFile(abs, "hello");
    const st = await fs.stat(abs);

    // Seed the cache with a BOGUS sha for the exact (mtime,size) on disk.
    const cache = new HashCache();
    cache.record("a.txt", { mtimeMs: st.mtimeMs, size: st.size, sha256: "bogus".padEnd(64, "0") });

    const m = await scanManifest(dir, undefined, cache);
    const entry = m.files.find((f) => f.path === "a.txt")!;
    // If scan consulted the cache, it returns the bogus sha (didn't re-hash).
    expect(entry.sha256).toBe("bogus".padEnd(64, "0"));

    // After invalidation, scan recomputes the real sha.
    cache.invalidate("a.txt");
    const m2 = await scanManifest(dir, undefined, cache);
    const entry2 = m2.files.find((f) => f.path === "a.txt")!;
    expect(entry2.sha256).not.toBe("bogus".padEnd(64, "0"));
    expect(entry2.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HashCache persists and reloads (atomic save round-trip)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-"));
  try {
    const c = new HashCache();
    c.record("x.ts", { mtimeMs: 1, size: 2, sha256: "c".repeat(64) });
    await c.save(dir);
    const loaded = await HashCache.load(dir);
    expect(loaded.lookup("x.ts", 1, 2)).toBe("c".repeat(64));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- event-driven incremental patch (the O(changed) hot path) -------------

const paths = (m: { files: FileEntry[] }) => m.files.map((f) => f.path).sort();

test("applyWatchEvents: file add/change/unlink patch the manifest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-wp-"));
  try {
    const matcher = buildIgnoreMatcher(dir);
    let m = await scanManifest(dir, matcher);
    expect(paths(m)).toEqual([]);

    await fs.writeFile(path.join(dir, "a.ts"), "v1");
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "a.ts", kind: "add" }]);
    expect(paths(m)).toEqual(["a.ts"]);
    const sha1 = m.files[0]!.sha256;

    await fs.writeFile(path.join(dir, "a.ts"), "v2-different-length");
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "a.ts", kind: "change" }]);
    expect(m.files[0]!.sha256).not.toBe(sha1);

    await fs.rm(path.join(dir, "a.ts"));
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "a.ts", kind: "unlink" }]);
    expect(paths(m)).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applyWatchEvents: addDir scans the whole subtree; unlinkDir removes dir/** ", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-wp-"));
  try {
    const matcher = buildIgnoreMatcher(dir);
    let m = await scanManifest(dir, matcher);

    // A whole subtree appears (clone/copy) → one addDir event must surface all children.
    await fs.mkdir(path.join(dir, "pkg/src"), { recursive: true });
    await fs.writeFile(path.join(dir, "pkg/index.ts"), "a");
    await fs.writeFile(path.join(dir, "pkg/src/util.ts"), "b");
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "pkg", kind: "addDir" }]);
    expect(paths(m)).toEqual(["pkg/index.ts", "pkg/src/util.ts"]);

    // The subtree is removed → one unlinkDir must drop every child, not just the dir.
    await fs.rm(path.join(dir, "pkg"), { recursive: true, force: true });
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "pkg", kind: "unlinkDir" }]);
    expect(paths(m)).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- streaming SHA-256 (Worker-side multipart verify) ---------------------

test("Sha256 matches node:crypto across boundaries and odd-chunk streaming", () => {
  const node = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const oneShot = (b: Buffer) => new Sha256().update(b).digestHex();
  for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 1000]) {
    const b = Buffer.from("a".repeat(n));
    expect(oneShot(b)).toBe(node(b));
  }
  // Large buffer fed in irregular chunks must match a one-shot hash.
  const big = randomBytes(2_000_003);
  const h = new Sha256();
  let o = 0;
  for (const c of [1, 63, 64, 65, 127, 4096, 100000]) {
    h.update(big.subarray(o, o + c));
    o += c;
  }
  h.update(big.subarray(o));
  expect(h.digestHex()).toBe(node(big));
});

test("applyWatchEvents: ignored paths never enter the manifest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-wp-"));
  try {
    const matcher = buildIgnoreMatcher(dir);
    let m = await scanManifest(dir, matcher);
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules/x.js"), "vendor");
    const events: WatchEvent[] = [{ relPath: "node_modules/x.js", kind: "add" }];
    m = await applyWatchEvents(m, dir, matcher, events);
    expect(paths(m)).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
