import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coverageOf, createScanStats, DirCache, HashCache, RACY_MARGIN_MS, scanManifest, UNPRUNED_DEADLINE_MS } from "./index.js";

const roots: string[] = [];
async function tmp(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-dircache-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const settle = () => Bun.sleep(RACY_MARGIN_MS + 40);
const filesOf = (manifest: Awaited<ReturnType<typeof scanManifest>>) => manifest.files;

test("DirCache round-trips and safely discards missing, corrupt, old, or malformed files", async () => {
  const root = await tmp();
  const cache = new DirCache();
  cache.record("", { mtimeMs: 1, ctimeMs: 2, children: [{ name: "a", type: "file" }] });
  cache.stampUnprunedRebuild(3, [{ relPath: ".gitignore", absent: true }]);
  await cache.save(root);
  const loaded = await DirCache.load(root);
  expect(loaded.lastScanStartMs).toBe(3);
  expect(loaded.ruleFiles).toEqual([{ relPath: ".gitignore", absent: true }]);
  // An entry whose timestamps sit within the racy margin of the caching scan
  // (lastScanStartMs=3) must NOT be reused — the cutoff is 3 - RACY_MARGIN_MS.
  expect(loaded.reuse("", { mtimeMs: 1, ctimeMs: 2 } as never)).toBeUndefined();
  loaded.setLastScanStartMs(10_000 + RACY_MARGIN_MS);
  expect(loaded.reuse("", { mtimeMs: 1, ctimeMs: 2 } as never)?.[0]?.name).toBe("a");

  const file = path.join(root, ".rbox/state/dircache.json");
  for (const text of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, lastScanStartMs: 1, lastUnprunedScanAtMs: 1, ruleFiles: [], entries: { "": { mtimeMs: 1, ctimeMs: 2, children: [{ name: "x", type: "wat" }] } } })]) {
    await fs.writeFile(file, text);
    expect((await DirCache.load(root)).lastUnprunedScanAtMs).toBe(0);
  }
  await fs.rm(file);
  expect((await DirCache.load(root)).lastUnprunedScanAtMs).toBe(0);
});

test("reuse requires the exact mtime+ctime pair outside the racy-clean margin", () => {
  // The cutoff is anchored on the PERSISTED lastScanStartMs (the caching scan),
  // not the current scan — matching probeEligible. Entry d has (mtime 100, ctime 200).
  const cache = new DirCache({ version: 1, lastScanStartMs: 201 + RACY_MARGIN_MS, lastUnprunedScanAtMs: 0, ruleFiles: [], entries: { d: { mtimeMs: 100, ctimeMs: 200, children: [] } } });
  const st = { mtimeMs: 100, ctimeMs: 200 } as never;
  expect(cache.reuse("d", st)).toEqual([]); // cutoff 201: both 100,200 strictly older → reuse
  expect(cache.reuse("d", { mtimeMs: 101, ctimeMs: 200 } as never)).toBeUndefined(); // mtime mismatch
  expect(cache.reuse("d", { mtimeMs: 100, ctimeMs: 201 } as never)).toBeUndefined(); // ctime mismatch
  // Like statsStableAcrossHash, ambiguity at the granularity boundary fails closed:
  // with lastScanStartMs one tick earlier the cutoff is 200, so ctime 200 is NOT < 200.
  cache.setLastScanStartMs(200 + RACY_MARGIN_MS);
  expect(cache.reuse("d", st)).toBeUndefined();
});

test("pruned scan is equivalent, skips directory readdir, and still detects in-place edits", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "a/b"), { recursive: true });
  await fs.writeFile(path.join(root, "a/b/x.txt"), "old");
  await fs.writeFile(path.join(root, "top.txt"), "top");
  const dc = new DirCache();
  const hc = new HashCache();
  // Settle BEFORE the caching scan: a dir is reusable only once its (mtime,ctime)
  // sit strictly older than the caching scan's start minus the racy margin. Dirs
  // created moments before that scan are correctly within-margin and won't reuse.
  await settle();
  const firstStats = createScanStats();
  const unpruned = await scanManifest(root, undefined, hc, undefined, undefined, firstStats, undefined, undefined, dc, "unpruned");
  const stats = createScanStats();
  const pruned = await scanManifest(root, undefined, hc, undefined, undefined, stats, undefined, undefined, dc, "pruned");
  const offStats = createScanStats();
  const off = await scanManifest(root, undefined, hc, undefined, undefined, offStats);
  expect(filesOf(pruned)).toEqual(filesOf(unpruned));
  expect(filesOf(off)).toEqual(filesOf(unpruned));
  expect(stats.dirsReusedFromCache).toBe(3);
  expect(stats.dirsWalked).toBe(0);
  expect(stats.dircacheOutcome).toBe("hit");
  expect(offStats.dircacheOutcome).toBe("off");

  const before = pruned.files.find((f) => f.path === "a/b/x.txt")!.sha256;
  await fs.writeFile(path.join(root, "a/b/x.txt"), "new");
  const editedStats = createScanStats();
  const edited = await scanManifest(root, undefined, hc, undefined, undefined, editedStats, undefined, undefined, dc, "pruned");
  expect(edited.files.find((f) => f.path === "a/b/x.txt")!.sha256).not.toBe(before);
  expect(editedStats.dirsReusedFromCache).toBe(3);
});

test("structural mutations miss changed parents and are reflected", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "left")); await fs.mkdir(path.join(root, "right"));
  await fs.writeFile(path.join(root, "left/a"), "a");
  const dc = new DirCache(); const hc = new HashCache();
  // Settle before the caching scan so unchanged dirs become genuinely reusable —
  // then only the MUTATED parents should miss while the untouched root reuses.
  await settle();
  await scanManifest(root, undefined, hc, undefined, undefined, undefined, undefined, undefined, dc, "unpruned");
  const parentBefore = await fs.lstat(path.join(root, "left"));
  await fs.unlink(path.join(root, "left/a"));
  const parentAfter = await fs.lstat(path.join(root, "left"));
  // A deletion inside a parent is impossible under POSIX without bumping the
  // parent's ctime — assert the load-bearing assumption directly.
  expect(parentAfter.ctimeMs).toBeGreaterThan(parentBefore.ctimeMs);
  await fs.writeFile(path.join(root, "left/b"), "b");
  await fs.rename(path.join(root, "left/b"), path.join(root, "right/c"));
  const stats = createScanStats();
  const manifest = await scanManifest(root, undefined, hc, undefined, undefined, stats, undefined, undefined, dc, "pruned");
  expect(manifest.files.map((f) => f.path)).toEqual(["right/c"]);
  // left + right mutated → readdir; the untouched root dir reuses its listing.
  expect(stats.dirsWalked).toBe(2);
  expect(stats.dirsReusedFromCache).toBe(1);
});

test("type swaps and a newly appeared nested rule force fresh structural truth", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "d"));
  await fs.writeFile(path.join(root, "d/item"), "file");
  const dc = new DirCache();
  await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dc, "unpruned");
  await settle();
  await fs.unlink(path.join(root, "d/item"));
  await fs.symlink("target", path.join(root, "d/item"));
  await fs.writeFile(path.join(root, "d/.gitignore"), "ignored\n");
  const stats = createScanStats();
  const symlinked = await scanManifest(root, undefined, undefined, undefined, undefined, stats, undefined, undefined, dc, "pruned");
  expect(symlinked.files.find((f) => f.path === "d/item")?.type).toBe("symlink");
  expect(stats.dircacheOutcome).toBe("rules-dropped");
  expect(stats.dirsReusedFromCache).toBe(0);

  await fs.unlink(path.join(root, "d/item"));
  await fs.mkdir(path.join(root, "d/item"));
  await fs.writeFile(path.join(root, "d/item/inside"), "inside");
  const asDir = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dc, "pruned");
  expect(asDir.files.some((f) => f.path === "d/item/inside")).toBeTrue();
});

test("rule changes, deadline, backward clock, and forced unpruned fail closed", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "hidden")); await fs.writeFile(path.join(root, "hidden/x"), "x");
  await fs.writeFile(path.join(root, ".gitignore"), "hidden/\n");
  const dc = new DirCache();
  await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dc, "unpruned");
  await settle();
  await fs.writeFile(path.join(root, ".gitignore"), "# open\n");
  const rules = createScanStats();
  const revealed = await scanManifest(root, undefined, undefined, undefined, undefined, rules, undefined, undefined, dc, "pruned");
  expect(rules.dircacheOutcome).toBe("rules-dropped");
  expect(rules.dirsReusedFromCache).toBe(0);
  expect(revealed.files.some((f) => f.path === "hidden/x")).toBeTrue();

  const lowered = Date.now() - UNPRUNED_DEADLINE_MS - 1;
  dc.lastUnprunedScanAtMs = lowered;
  const deadline = createScanStats();
  await scanManifest(root, undefined, undefined, undefined, undefined, deadline, undefined, undefined, dc, "pruned");
  // The deadline scan self-demotes to unpruned and REFRESHES the stamp back to ~now
  // (well past the artificially-lowered deadline). Assert freshness, not strict `>`
  // against a prior stamp — two scans can share a Date.now() millisecond.
  expect(deadline.dircacheOutcome).toBe("deadline"); expect(deadline.dirsReusedFromCache).toBe(0);
  expect(dc.lastUnprunedScanAtMs).toBeGreaterThan(lowered); expect(Date.now() - dc.lastUnprunedScanAtMs).toBeLessThan(60_000);
  dc.lastScanStartMs = Date.now() + 10_000;
  const clock = createScanStats();
  await scanManifest(root, undefined, undefined, undefined, undefined, clock, undefined, undefined, dc, "pruned");
  expect(clock.dircacheOutcome).toBe("deadline");
  const forced = createScanStats();
  await scanManifest(root, undefined, undefined, undefined, undefined, forced, undefined, undefined, dc, "unpruned");
  expect(forced.dircacheOutcome).toBe("unpruned"); expect(forced.dirsReusedFromCache).toBe(0);
});

test("coverageOf only marks successful pruned-mode walks pruned", () => {
  expect(coverageOf("hit")).toBe("pruned"); expect(coverageOf("cold")).toBe("pruned");
  for (const outcome of ["off", "unpruned", "deadline", "rules-dropped"] as const) expect(coverageOf(outcome)).toBe("full-tree");
});
