import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openTrashBatch,
  pruneTrash,
  trashStats,
  listTrash,
  restoreFromTrash,
  TRASH_REL,
} from "./trash.js";

// Real temp dirs so every rename/prune runs against a real filesystem — the trash
// tier's whole contract is on-disk moves, so in-memory fakes would test nothing.
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-trash-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, content: string) => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
};
const exists = async (rel: string) => {
  try {
    await fs.lstat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
};
const readTrash = (batchDir: string, rel: string) => fs.readFile(path.join(batchDir, rel), "utf8");

// The batch dir name openTrashBatch derives for a given Date — used to seed old
// batches whose retention age is read from the NAME, not mtime.
const batchDirFor = (d: Date) => path.join(root, TRASH_REL, d.toISOString().replace(/[:.]/g, "-"));

test("put moves a file, a symlink, and a whole directory in one rename each", async () => {
  await write("a.txt", "hello");
  await fs.symlink("a.txt", path.join(root, "link"));
  await write("dir/nested/b.txt", "world");

  const batch = openTrashBatch(root);
  await batch.put("a.txt");
  await batch.put("link");
  await batch.put("dir");
  await batch.finish();

  // Sources are gone from the tree...
  expect(await exists("a.txt")).toBe(false);
  expect(await exists("link")).toBe(false);
  expect(await exists("dir")).toBe(false);
  // ...and present in the batch, byte-for-byte.
  expect(await readTrash(batch.dir, "a.txt")).toBe("hello");
  expect(await fs.readlink(path.join(batch.dir, "link"))).toBe("a.txt");
  expect(await readTrash(batch.dir, "dir/nested/b.txt")).toBe("world");
});

test("a same-batch name collision gets a ~2 suffix instead of clobbering", async () => {
  await write("x.txt", "first");
  const batch = openTrashBatch(root);
  await batch.put("x.txt");

  // Re-create the same path and trash it again in the SAME batch.
  await write("x.txt", "second");
  await batch.put("x.txt");
  await batch.finish();

  expect(await readTrash(batch.dir, "x.txt")).toBe("first");
  expect(await readTrash(batch.dir, "x.txt~2")).toBe("second");
});

test("finish removes the .active marker; a zero-put batch leaves nothing on disk", async () => {
  await write("a.txt", "hi");
  const batch = openTrashBatch(root);
  await batch.put("a.txt");
  // The marker is a SIBLING file (`<batchDir>.active`) — the batch's inside
  // belongs entirely to trashed user paths.
  expect(await exists(path.join(TRASH_REL, `${path.basename(batch.dir)}.active`))).toBe(true);
  await batch.finish();
  expect(await exists(path.join(TRASH_REL, `${path.basename(batch.dir)}.active`))).toBe(false);

  // A batch that never received a put arms nothing — its dir is never created.
  const empty = openTrashBatch(root);
  await empty.finish();
  expect(await exists(path.join(TRASH_REL, path.basename(empty.dir)))).toBe(false);
});

test("a vanished source is not an error (already-gone delete semantics)", async () => {
  const batch = openTrashBatch(root);
  await expect(batch.put("never-existed.txt")).resolves.toBe(false);
  await batch.finish();
});

// --- retention (pruneTrash) -------------------------------------------------

// Seed a settled (no .active) batch whose age comes from a chosen wall-clock.
const seedBatch = async (bornAt: Date, files: Record<string, string>) => {
  const dir = batchDirFor(bornAt);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
};

const DAY = 86_400_000;

test("age pass removes batches older than `days`, keeps younger ones", async () => {
  const now = Date.now();
  const old = await seedBatch(new Date(now - 40 * DAY), { "old.txt": "x" });
  const fresh = await seedBatch(new Date(now - 5 * DAY), { "fresh.txt": "y" });

  const res = await pruneTrash(root, { days: 30, maxBytes: Infinity, now });
  expect(res.removedBatches).toBe(1);
  expect(await exists(path.relative(root, old))).toBe(false);
  expect(await exists(path.relative(root, fresh))).toBe(true);
});

test("size cap evicts oldest-first until under maxBytes", async () => {
  const now = Date.now();
  // Three batches each ~100 bytes, all old enough to be past the 15-min floor.
  const b1 = await seedBatch(new Date(now - 3 * DAY), { "a": "a".repeat(100) });
  const b2 = await seedBatch(new Date(now - 2 * DAY), { "b": "b".repeat(100) });
  const b3 = await seedBatch(new Date(now - 1 * DAY), { "c": "c".repeat(100) });

  // Cap at 150 bytes: must drop the two oldest, keep the newest.
  const res = await pruneTrash(root, { days: 365, maxBytes: 150, now });
  expect(res.removedBatches).toBe(2);
  expect(await exists(path.relative(root, b1))).toBe(false);
  expect(await exists(path.relative(root, b2))).toBe(false);
  expect(await exists(path.relative(root, b3))).toBe(true);
});

test("a fresh .active batch is protected from both age and size passes", async () => {
  const now = Date.now();
  const dir = await seedBatch(new Date(now - 40 * DAY), { "a": "a".repeat(500) });
  await fs.writeFile(`${dir}.active`, ""); // fresh sibling marker

  const res = await pruneTrash(root, { days: 30, maxBytes: 1, now });
  expect(res.removedBatches).toBe(0);
  expect(await exists(path.relative(root, dir))).toBe(true);
});

test("a batch younger than 15 minutes survives even under cap pressure", async () => {
  const now = Date.now();
  const dir = await seedBatch(new Date(now - 60_000), { "a": "a".repeat(500) }); // 1 min old
  const res = await pruneTrash(root, { days: 365, maxBytes: 1, now });
  expect(res.removedBatches).toBe(0);
  expect(await exists(path.relative(root, dir))).toBe(true);
});

test("a stale (>24h) .active marker no longer protects the batch", async () => {
  const now = Date.now();
  const dir = await seedBatch(new Date(now - 40 * DAY), { "a": "x" });
  // Marker whose mtime is 25h in the past → a crashed pull; pruner may reclaim it.
  await fs.writeFile(path.join(dir, ".active"), "");
  const past = new Date(now - 25 * 60 * 60_000);
  await fs.utimes(path.join(dir, ".active"), past, past);

  const res = await pruneTrash(root, { days: 30, maxBytes: Infinity, now });
  expect(res.removedBatches).toBe(1);
  expect(await exists(path.relative(root, dir))).toBe(false);
});

test("days<=0 removes every unprotected batch (rbox trash empty)", async () => {
  const now = Date.now();
  const old = await seedBatch(new Date(now - 2 * DAY), { "a": "x" });
  const active = await seedBatch(new Date(now - 3 * DAY), { "b": "y" });
  await fs.writeFile(`${active}.active`, ""); // protected (sibling marker)
  const young = await seedBatch(new Date(now - 60_000), { "c": "z" }); // <15min, protected

  const res = await pruneTrash(root, { days: 0, maxBytes: Infinity, now });
  expect(res.removedBatches).toBe(1);
  expect(await exists(path.relative(root, old))).toBe(false);
  expect(await exists(path.relative(root, active))).toBe(true);
  expect(await exists(path.relative(root, young))).toBe(true);
});

// --- stats & listing --------------------------------------------------------

test("trashStats and listTrash count files across batches (ignoring markers)", async () => {
  const now = Date.now();
  await seedBatch(new Date(now - 3 * DAY), { "one.txt": "aa", "sub/two.txt": "bbb" });
  const b2 = await seedBatch(new Date(now - 1 * DAY), { "three.txt": "cccc" });
  await fs.writeFile(`${b2}.active`, "x"); // sibling markers never count as files

  const stats = await trashStats(root);
  expect(stats.batches).toBe(2);
  expect(stats.files).toBe(3);
  expect(stats.bytes).toBe(2 + 3 + 4);

  const entries = await listTrash(root);
  expect(entries.map((e) => e.path).sort()).toEqual(["one.txt", "sub/two.txt", "three.txt"]);
});

// --- restore ----------------------------------------------------------------

test("restore renames a trashed file back in place when the target is free", async () => {
  await write("doc.txt", "keep");
  const batch = openTrashBatch(root);
  await batch.put("doc.txt");
  await batch.finish();
  expect(await exists("doc.txt")).toBe(false);

  const res = await restoreFromTrash(root, "doc.txt");
  expect(res.restoredTo).toBe("doc.txt");
  expect(await readTrash(root, "doc.txt")).toBe("keep");
});

test("restore diverts to a conflict name rather than overwrite an existing target", async () => {
  await write("doc.txt", "trashed-copy");
  const batch = openTrashBatch(root);
  await batch.put("doc.txt");
  await batch.finish();
  await write("doc.txt", "live-copy"); // target now occupied

  const res = await restoreFromTrash(root, "doc.txt", { now: new Date("2026-07-02T12:00:00Z") });
  expect(res.restoredTo).not.toBe("doc.txt");
  expect(res.restoredTo).toContain(".conflict");
  expect(await readTrash(root, "doc.txt")).toBe("live-copy"); // never clobbered
  expect(await readTrash(root, res.restoredTo)).toBe("trashed-copy");
});

test("restore reports a descriptive error when a parent component is a file (ENOTDIR)", async () => {
  await write("a/b.txt", "bytes");
  const batch = openTrashBatch(root);
  await batch.put("a/b.txt");
  await batch.finish();
  // Put a FILE where the restore needs directory `a` (drop the now-empty dir first).
  await fs.rm(path.join(root, "a"), { recursive: true, force: true });
  await write("a", "i am a file now");

  await expect(restoreFromTrash(root, "a/b.txt")).rejects.toThrow(/parent path component is a file/);
});

test("restore with a `batch` pin selects the right copy when two batches hold the same path", async () => {
  const older = await seedBatch(new Date(Date.now() - 2 * DAY), { "shared.txt": "from-older" });
  const newer = await seedBatch(new Date(Date.now() - 1 * DAY), { "shared.txt": "from-newer" });

  const res = await restoreFromTrash(root, "shared.txt", { batch: path.basename(older) });
  expect(res.restoredTo).toBe("shared.txt");
  expect(await readTrash(root, "shared.txt")).toBe("from-older");
  // The unpinned copy stays in its batch.
  expect(await fs.readFile(path.join(newer, "shared.txt"), "utf8")).toBe("from-newer");
});

test("restore without a pin searches newest batch first", async () => {
  await seedBatch(new Date(Date.now() - 2 * DAY), { "shared.txt": "from-older" });
  await seedBatch(new Date(Date.now() - 1 * DAY), { "shared.txt": "from-newer" });

  const res = await restoreFromTrash(root, "shared.txt");
  expect(res.restoredTo).toBe("shared.txt");
  expect(await readTrash(root, "shared.txt")).toBe("from-newer");
});

// --- review-regression guards ----------------------------------------------

test("a user file literally named .active trashes, lists, and restores cleanly (marker is a sibling, not an inmate)", async () => {
  await write(".active", "user bytes");
  const batch = openTrashBatch(root);
  await batch.put(".active");
  // The in-flight marker lives BESIDE the batch dir; the user's file keeps its name inside.
  expect(await exists(`${path.relative(root, batch.dir)}.active`)).toBe(true);
  expect(await readTrash(batch.dir, ".active")).toBe("user bytes");
  await batch.finish();

  const listed = await listTrash(root);
  expect(listed.some((e) => e.path === ".active")).toBe(true);
  const res = await restoreFromTrash(root, ".active");
  expect(res.restoredTo).toBe(".active");
  expect(await fs.readFile(path.join(root, ".active"), "utf8")).toBe("user bytes");
});

test("unsafe relative paths are rejected at the trash boundary (put and restore)", async () => {
  const batch = openTrashBatch(root);
  await expect(batch.put("../victim")).rejects.toThrow(/unsafe trash path/);
  await expect(batch.put("/etc/hosts")).rejects.toThrow(/unsafe trash path/);
  await expect(batch.put("a/../../victim")).rejects.toThrow(/unsafe trash path/);
  await batch.finish();
  await expect(restoreFromTrash(root, "../victim")).rejects.toThrow(/unsafe trash path/);
  await expect(restoreFromTrash(root, "")).rejects.toThrow(/unsafe trash path/);
});

test("restore divert never clobbers an existing same-second conflict copy", async () => {
  const now = new Date();
  await write("f.txt", "trashed-1");
  const b1 = openTrashBatch(root);
  await b1.put("f.txt");
  await b1.finish();
  await write("f.txt", "trashed-2");
  const b2 = openTrashBatch(root);
  await b2.put("f.txt");
  await b2.finish();
  await write("f.txt", "current");

  // Both restores collide with the live f.txt AND (second) with the first divert's name.
  const r1 = await restoreFromTrash(root, "f.txt", { now });
  const r2 = await restoreFromTrash(root, "f.txt", { now });
  expect(r1.restoredTo).not.toBe("f.txt");
  expect(r2.restoredTo).not.toBe(r1.restoredTo); // ~2 suffix, no clobber
  expect(await fs.readFile(path.join(root, "f.txt"), "utf8")).toBe("current");
  const both = [await fs.readFile(path.join(root, r1.restoredTo), "utf8"), await fs.readFile(path.join(root, r2.restoredTo), "utf8")];
  expect(both.sort()).toEqual(["trashed-1", "trashed-2"]);
});

// --- review-regression guards ----------------------------------------------

test("restore refuses a destination whose real parent escapes the workspace (symlinked dir)", async () => {
  await write("out/pwn.txt", "payload");
  const batch = openTrashBatch(root);
  await batch.put("out/pwn.txt");
  await batch.finish();

  // Replace the (now empty) out/ with a symlink pointing OUTSIDE the workspace.
  const victim = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-victim-"));
  try {
    await fs.rm(path.join(root, "out"), { recursive: true, force: true });
    await fs.symlink(victim, path.join(root, "out"));
    await expect(restoreFromTrash(root, "out/pwn.txt")).rejects.toThrow(/outside workspace/);
    expect(await fs.readdir(victim)).toEqual([]); // nothing teleported out
  } finally {
    await fs.rm(victim, { recursive: true, force: true });
  }
});

test("a sibling DIRECTORY named <batch>.active is not mistaken for an active marker", async () => {
  const now = Date.now();
  const dir = await seedBatch(new Date(now - 40 * DAY), { "a.txt": "x" });
  await fs.mkdir(`${dir}.active`); // a directory, not a marker file
  const res = await pruneTrash(root, { days: 30, maxBytes: Infinity, now });
  expect(res.removedBatches).toBeGreaterThanOrEqual(1); // the 40-day batch must NOT be protected
});

test("restore refuses a SOURCE that resolves through a trashed symlink to outside the batch (round-3)", async () => {
  const victim = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-victim-"));
  try {
    await fs.writeFile(path.join(victim, "secret.txt"), "outside");
    await fs.symlink(victim, path.join(root, "out"));
    const batch = openTrashBatch(root);
    await batch.put("out"); // the batch now holds symlink out -> victim
    await batch.finish();

    // Following the trashed symlink would exfiltrate AND unlink victim/secret.txt.
    await expect(restoreFromTrash(root, "out/secret.txt")).rejects.toThrow(/outside workspace/);
    expect(await fs.readFile(path.join(victim, "secret.txt"), "utf8")).toBe("outside"); // untouched
    expect(await exists("out/secret.txt")).toBe(false); // nothing smuggled in
  } finally {
    await fs.rm(victim, { recursive: true, force: true });
  }
});
