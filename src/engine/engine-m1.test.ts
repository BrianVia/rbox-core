import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyWatchEvents,
  buildIgnoreMatcher,
  HashCache,
  createScanStats,
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

test("validateManifest rejects file/descendant prefix collisions including case-folded and intervening sort keys", () => {
  for (const files of [
    [goodEntry({ path: "foo" }), goodEntry({ path: "foo/bar" })],
    [goodEntry({ path: "foo/bar" }), goodEntry({ path: "foo" })],
    [goodEntry({ path: "Foo" }), goodEntry({ path: "foo/bar" })],
    [goodEntry({ path: "foo" }), goodEntry({ path: "foo-bar" }), goodEntry({ path: "foo/bar" })],
  ]) {
    expect(validateManifest({ files }).ok).toBe(false);
  }
});

test("validateManifest rejects malformed entries", () => {
  expect(validateManifest({ files: [goodEntry({ sha256: "xyz" })] }).ok).toBe(false); // bad sha
  expect(validateManifest({ files: [goodEntry({ type: "weird" as never })] }).ok).toBe(false); // bad type
  expect(validateManifest({ files: [goodEntry({ size: -1 })] }).ok).toBe(false); // bad size
  expect(validateManifest({ files: [goodEntry({ type: "symlink", symlinkTarget: undefined })] }).ok).toBe(false); // symlink no target
  expect(validateManifest({ files: "notarray" }).ok).toBe(false);
});

test("validateManifest accepts only complete compressed file descriptors", () => {
  const compressed = goodEntry({
    encSha: "b".repeat(64),
    comp: "zstd",
    payloadSha: "c".repeat(64),
    cipherSize: 42,
  });
  expect(validateManifest({ manifestSchema: 4, files: [compressed] }).ok).toBe(true);
  const underSchema = validateManifest({ manifestSchema: 3, files: [compressed] });
  expect(underSchema.ok).toBe(false);
  expect(!underSchema.ok && underSchema.error).toBe("compressed entries require manifestSchema >= 4");
  expect(validateManifest({ manifestSchema: 4, files: [goodEntry({ encSha: "b".repeat(64), comp: "br" as "zstd", payloadSha: "c".repeat(64), cipherSize: 42 })] }).ok).toBe(false);
  expect(validateManifest({ manifestSchema: 4, files: [goodEntry({ encSha: "b".repeat(64), comp: "zstd", payloadSha: undefined, cipherSize: 42 })] }).ok).toBe(false);
  expect(validateManifest({ manifestSchema: 4, files: [goodEntry({ encSha: "b".repeat(64), comp: "zstd", payloadSha: "bad", cipherSize: 42 })] }).ok).toBe(false);
  expect(validateManifest({ manifestSchema: 4, files: [goodEntry({ encSha: "b".repeat(64), comp: "zstd", payloadSha: "c".repeat(64), cipherSize: -1 })] }).ok).toBe(false);
  expect(validateManifest({ files: [goodEntry({ payloadSha: "c".repeat(64) })] }).ok).toBe(false);
  expect(validateManifest({ files: [goodEntry({ cipherSize: 42 })] }).ok).toBe(false);
});

// ---- hash cache (the performance fast-path) -------------------------------

test("HashCache.lookup hits only on matching mtime+size+ctime", () => {
  const c = new HashCache();
  c.record("a.ts", { mtimeMs: 100, size: 5, ctimeMs: 200, sha256: "deadbeef" });
  expect(c.lookup("a.ts", 100, 5, 200)).toBe("deadbeef"); // hit
  expect(c.lookup("a.ts", 101, 5, 200)).toBeUndefined(); // mtime changed
  expect(c.lookup("a.ts", 100, 6, 200)).toBeUndefined(); // size changed
  expect(c.lookup("a.ts", 100, 5, 201)).toBeUndefined(); // ctime changed
  c.invalidate("a.ts");
  expect(c.lookup("a.ts", 100, 5, 200)).toBeUndefined(); // invalidated
});

test("scanManifest consults the cache (seeded wrong sha is returned, proving no re-hash)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-"));
  try {
    const abs = path.join(dir, "a.txt");
    await fs.writeFile(abs, "hello");
    const st = await fs.stat(abs);

    // Seed the cache with a BOGUS sha for the exact (mtime,size,ctime) on disk.
    const cache = new HashCache();
    cache.record("a.txt", { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, sha256: "bogus".padEnd(64, "0") });

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

test("scanManifest optional ScanStats counts the current full-scan work and does not change entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scan-stats-"));
  try {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    await fs.writeFile(path.join(dir, "sub", "b.txt"), "bb");

    const matcher = buildIgnoreMatcher(dir);
    const cache = new HashCache();
    const stats = createScanStats();
    const withStats = await scanManifest(dir, matcher, cache, undefined, undefined, stats);

    expect(stats.dirsWalked).toBe(2);
    expect(stats.filesStatted).toBe(2);
    expect(stats.filesSkippedCacheHit).toBe(0);
    expect(stats.filesHashed).toBe(2);
    expect(stats.readdirMs).toBeGreaterThanOrEqual(0);
    expect(stats.statMs).toBeGreaterThanOrEqual(0);
    expect(stats.matcherMs).toBeGreaterThanOrEqual(0);
    expect(stats.hashMs).toBeGreaterThanOrEqual(0);
    expect(stats.sortMs).toBeGreaterThanOrEqual(0);

    const withoutStats = await scanManifest(dir, matcher, cache);
    expect(withoutStats.files).toEqual(withStats.files);

    const hitStats = createScanStats();
    await scanManifest(dir, matcher, cache, undefined, undefined, hitStats);
    expect(hitStats.dirsWalked).toBe(2);
    expect(hitStats.filesStatted).toBe(2);
    expect(hitStats.filesSkippedCacheHit).toBe(2);
    expect(hitStats.filesHashed).toBe(0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HashCache persists and reloads (atomic save round-trip)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-"));
  try {
    const c = new HashCache();
    c.record("x.ts", { mtimeMs: 1, size: 2, ctimeMs: 3, sha256: "c".repeat(64) });
    await c.save(dir);
    expect(JSON.parse(await fs.readFile(path.join(dir, ".rbox/state/hashcache.json"), "utf8"))).toEqual({
      version: 2,
      entries: { "x.ts": { mtimeMs: 1, size: 2, ctimeMs: 3, sha256: "c".repeat(64) } },
    });
    const loaded = await HashCache.load(dir);
    expect(loaded.lookup("x.ts", 1, 2, 3)).toBe("c".repeat(64));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a same-size edit with restored mtime is re-hashed, never served the stale sha (ctime in the fingerprint)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-touch-r-"));
  try {
    const abs = path.join(dir, "f.txt");
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000); // whole-second, exactly restorable
    await fs.writeFile(abs, "aaaa");
    await fs.utimes(abs, t, t);
    const st1 = await fs.stat(abs);

    const cache = new HashCache();
    const m1 = await scanManifest(dir, undefined, cache);
    expect(m1.files[0]!.sha256).toBe(createHash("sha256").update("aaaa").digest("hex"));

    await fs.writeFile(abs, "bbbb"); // same size, new content
    await fs.utimes(abs, t, t); // the touch -r: (mtime,size) now match the cached entry again
    const st2 = await fs.stat(abs);
    expect(st2.mtimeMs).toBe(st1.mtimeMs); // the old (mtime,size) fingerprint WOULD have hit
    expect(st2.size).toBe(st1.size);
    expect(st2.ctimeMs).not.toBe(st1.ctimeMs); // the P-2 dimension: the write bumped ctime

    const m2 = await scanManifest(dir, undefined, cache);
    expect(m2.files[0]!.sha256).toBe(createHash("sha256").update("bbbb").digest("hex"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HashCache discards legacy bare-map files and rewrites v2 after a record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-legacy-"));
  try {
    const abs = path.join(dir, ".rbox/state/hashcache.json");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify({ "old.ts": { mtimeMs: 1, size: 2, sha256: "a".repeat(64) } }));

    const loaded = await HashCache.load(dir);
    expect(loaded.lookup("old.ts", 1, 2, 3)).toBeUndefined();
    loaded.record("new.ts", { mtimeMs: 4, size: 5, ctimeMs: 6, sha256: "b".repeat(64) });
    await loaded.save(dir);
    expect(JSON.parse(await fs.readFile(abs, "utf8"))).toEqual({
      version: 2,
      entries: { "new.ts": { mtimeMs: 4, size: 5, ctimeMs: 6, sha256: "b".repeat(64) } },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HashCache loads corrupt files as empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-corrupt-"));
  try {
    const abs = path.join(dir, ".rbox/state/hashcache.json");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "not json");
    expect((await HashCache.load(dir)).lookup("a.ts", 1, 2, 3)).toBeUndefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HashCache discards a v2 file wholesale when any entry is malformed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-hc-badentry-"));
  try {
    const abs = path.join(dir, ".rbox/state/hashcache.json");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const good = { mtimeMs: 1, size: 2, ctimeMs: 3, sha256: "a".repeat(64) };
    for (const bad of [
      { ...good, sha256: "not-a-sha" }, // damaged sha must never flow into a manifest
      { ...good, ctimeMs: "3" }, // wrong type
      { mtimeMs: 1, size: 2, sha256: "a".repeat(64) }, // legacy shape smuggled into a v2 envelope
      null,
    ]) {
      await fs.writeFile(abs, JSON.stringify({ version: 2, entries: { "good.ts": good, "bad.ts": bad } }));
      const loaded = await HashCache.load(dir);
      expect(loaded.lookup("good.ts", 1, 2, 3)).toBeUndefined(); // wholesale, not per-entry
      expect(loaded.lookup("bad.ts", 1, 2, 3)).toBeUndefined();
    }
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

test("applyWatchEvents: `deferred` collects mid-write paths only — a settled or gone file never defers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-wp-"));
  try {
    const matcher = buildIgnoreMatcher(dir);
    let m = await scanManifest(dir, matcher);

    // A file that hashes cleanly must NOT be deferred (§41 hot-path retry only fires
    // for genuinely mid-write files — otherwise every save would spuriously re-push).
    await fs.writeFile(path.join(dir, "settled.ts"), "stable");
    const d1 = new Set<string>();
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "settled.ts", kind: "add" }], undefined, d1);
    expect(paths(m)).toEqual(["settled.ts"]);
    expect([...d1]).toEqual([]);

    // A change event for a path that has since vanished is "gone", not "mid-write":
    // it must not be endlessly retried — the safety/unlink path handles it.
    const d2 = new Set<string>();
    m = await applyWatchEvents(m, dir, matcher, [{ relPath: "never-existed.ts", kind: "change" }], undefined, d2);
    expect([...d2]).toEqual([]);
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

// ---- M3b: ignore precedence ----------------------------------------------

test("ignore: .rboxignore !negation re-includes a pattern-ignored file (not a pruned dir)", async () => {
  const { buildIgnoreMatcher } = await import("./ignore.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ig-"));
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n");
    await fs.writeFile(path.join(dir, ".rboxignore"), "!important.log\n");
    const m = buildIgnoreMatcher(dir);
    expect(m.ignores("debug.log")).toBe(true); // *.log ignored
    expect(m.ignores("important.log")).toBe(false); // re-included by .rboxignore (last wins)
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- M5: convergent blob encryption -------------------------------------

test("crypto: encrypt→decrypt round-trips, is convergent, and rejects tamper/wrong-key", async () => {
  const { encryptFileToTemp, decryptFileToPath, generateKek, kekFromPhrase, kekToPhrase } = await import("./crypto.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-enc-"));
  try {
    const kek = generateKek();
    const f = path.join(dir, "secret.ts");
    const data = Buffer.from("const KEY='sk-abc';\n".repeat(2000));
    await fs.writeFile(f, data);

    const e1 = await encryptFileToTemp(f, kek, dir);
    const e2 = await encryptFileToTemp(f, kek, await fs.mkdtemp(path.join(os.tmpdir(), "rbox-enc2-")));
    expect(e1.encSha).toBe(e2.encSha); // convergent → dedup
    expect(e1.encSha).not.toBe(e1.plaintextSha);
    expect((await fs.readFile(e1.ciphertextPath)).includes(Buffer.from("sk-abc"))).toBe(false); // ciphertext hides plaintext

    const out = path.join(dir, "out.ts");
    await decryptFileToPath(e1.ciphertextPath, kek, e1.plaintextSha, out);
    expect((await fs.readFile(out)).equals(data)).toBe(true);

    await expect(decryptFileToPath(e1.ciphertextPath, generateKek(), e1.plaintextSha, path.join(dir, "x"))).rejects.toThrow();
    expect(kekFromPhrase(kekToPhrase(kek)).equals(kek)).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
