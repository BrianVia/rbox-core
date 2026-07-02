import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  applyWatchEvents,
  buildIgnoreMatcher,
  hashBytes,
  LocalBlobStore,
  scanManifest,
  type Action,
  type FileEntry,
  type Manifest,
} from "./index.js";
import { openTrashBatch, listTrash } from "./trash.js";

// Drive the real apply/watch pipeline against a real filesystem and assert on the
// resulting bytes + trash contents — the safety guarantees are all on-disk effects.
let root: string;
let storeDir: string;
let store: LocalBlobStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-safety-"));
  storeDir = path.join(root, "..", `${path.basename(root)}-store`);
  store = new LocalBlobStore(storeDir);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

const write = async (rel: string, content: string) => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
};
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");
const exists = async (rel: string) => {
  try {
    await fs.lstat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
};
const lstatType = async (rel: string) => {
  const st = await fs.lstat(path.join(root, rel));
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
};

// A `write` action carrying `content` for `rel` — uploads the blob to the store.
const writeAction = async (rel: string, content: string): Promise<Action> => {
  const bytes = Buffer.from(content);
  const sha256 = hashBytes(bytes);
  await store.put(sha256, bytes);
  const entry: FileEntry = { path: rel, type: "file", sha256, size: bytes.length, mode: 0o644, mtimeMs: 0 };
  return { kind: "write", entry, expectedLocal: undefined };
};
const conflictCopies = async (dir = "") => {
  const abs = path.join(root, dir);
  const names = await fs.readdir(abs).catch(() => [] as string[]);
  return names.filter((n) => n.includes(".conflict"));
};

test("dir-obstruction write: the directory lands in trash, the entry publishes, onTypeFlip fires once", async () => {
  // Local has a materialized directory where the remote now has a file (the Conductor flip).
  await write("foo/inner.txt", "inner-bytes");
  const action = await writeAction("foo", "i am now a file");

  const trash = openTrashBatch(root);
  const flips: string[] = [];
  await applyActions(root, [action], store, { trash, onTypeFlip: (p) => flips.push(p) });
  await trash.finish();

  expect(await lstatType("foo")).toBe("file");
  expect(await read("foo")).toBe("i am now a file");
  expect(flips).toEqual(["foo"]);
  const trashed = await listTrash(root);
  expect(trashed.map((e) => e.path)).toContain("foo/inner.txt");
});

test("ancestor-file obstruction with two children in one call: exactly one conflict copy, both children written, no race", async () => {
  // A FILE `a` obstructs the directory both children need.
  await write("a", "old file at a");
  const b = await writeAction("a/b.txt", "child-b");
  const c = await writeAction("a/c.txt", "child-c");

  const flips: string[] = [];
  await applyActions(root, [b, c], store, { onTypeFlip: (p) => flips.push(p), concurrency: 8 });

  expect(await read("a/b.txt")).toBe("child-b");
  expect(await read("a/c.txt")).toBe("child-c");
  expect(await lstatType("a")).toBe("dir");
  expect(flips).toEqual(["a"]); // resolved ONCE by the serial preflight, not per-child
  const copies = await conflictCopies();
  expect(copies).toHaveLength(1);
  expect(await read(copies[0]!)).toBe("old file at a"); // the obstructing file's bytes survive
});

test("clean delete routes the file into trash, not oblivion", async () => {
  await write("gone.txt", "delete me");
  const local = await scanManifest(root);
  const expectedLocal = local.files.find((f) => f.path === "gone.txt");
  const action: Action = { kind: "delete", path: "gone.txt", expectedLocal };

  const trash = openTrashBatch(root);
  await applyActions(root, [action], store, { trash });
  await trash.finish();

  expect(await exists("gone.txt")).toBe(false);
  expect((await listTrash(root)).map((e) => e.path)).toContain("gone.txt");
});

test("dirty delete keeps a VISIBLE conflict copy and never trashes", async () => {
  await write("edited.txt", "local edit wins");
  // expectedLocal describes DIFFERENT bytes than what's on disk → concurrent edit.
  const stale: FileEntry = { path: "edited.txt", type: "file", sha256: hashBytes(Buffer.from("old base bytes")), size: 5, mode: 0o644, mtimeMs: 0 };
  const action: Action = { kind: "delete", path: "edited.txt", expectedLocal: stale };

  const trash = openTrashBatch(root);
  await applyActions(root, [action], store, { trash });
  await trash.finish();

  const copies = await conflictCopies();
  expect(copies).toHaveLength(1);
  expect(await read(copies[0]!)).toBe("local edit wins");
  expect(await listTrash(root)).toHaveLength(0); // dirty branch never trashes
});

test("delete precondition hitting ENOTDIR (descendant of an evicted dir) is a no-op, not a throw", async () => {
  await write("a", "a is a file"); // `a/b.txt` can't exist — lstat throws ENOTDIR
  const stale: FileEntry = { path: "a/b.txt", type: "file", sha256: hashBytes(Buffer.from("x")), size: 1, mode: 0o644, mtimeMs: 0 };
  const action: Action = { kind: "delete", path: "a/b.txt", expectedLocal: stale };

  await expect(applyActions(root, [action], store, {})).resolves.toBeUndefined();
  expect(await lstatType("a")).toBe("file"); // untouched
});

// --- applyWatchEvents stale-unlink (design 50 B1) ---------------------------

const buildManifest = async (): Promise<Manifest> => scanManifest(root);

test("a stale unlink for a path still on disk re-derives the entry instead of dropping it", async () => {
  await write("live.txt", "present");
  const base = await buildManifest();
  expect(base.files.some((f) => f.path === "live.txt")).toBe(true);

  const matcher = buildIgnoreMatcher(root);
  // The file is STILL on disk (pull-side eviction+rewrite echo) — the unlink is stale.
  const after = await applyWatchEvents(base, root, matcher, [{ relPath: "live.txt", kind: "unlink" }]);
  expect(after.files.some((f) => f.path === "live.txt")).toBe(true);
});

test("a genuine unlink (file absent) still removes the entry", async () => {
  await write("temp.txt", "here");
  const base = await buildManifest();
  await fs.rm(path.join(root, "temp.txt"));

  const matcher = buildIgnoreMatcher(root);
  const after = await applyWatchEvents(base, root, matcher, [{ relPath: "temp.txt", kind: "unlink" }]);
  expect(after.files.some((f) => f.path === "temp.txt")).toBe(false);
});

test("unlinkDir removes children only when the directory is genuinely gone", async () => {
  await write("d/one.txt", "1");
  await write("d/two.txt", "2");
  const base = await buildManifest();
  const matcher = buildIgnoreMatcher(root);

  // Dir still present → stale unlinkDir must not drop children.
  const survives = await applyWatchEvents(base, root, matcher, [{ relPath: "d", kind: "unlinkDir" }]);
  expect(survives.files.filter((f) => f.path.startsWith("d/")).length).toBe(2);

  // Now actually remove it → the prefix drop applies.
  await fs.rm(path.join(root, "d"), { recursive: true, force: true });
  const gone = await applyWatchEvents(base, root, matcher, [{ relPath: "d", kind: "unlinkDir" }]);
  expect(gone.files.some((f) => f.path.startsWith("d/"))).toBe(false);
});
