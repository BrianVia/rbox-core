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
import { encryptFileToTempInline, generateKek } from "./crypto.js";

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

const encryptedEntry = async (rel: string, content: Buffer, kek: Buffer, compress: boolean): Promise<{ entry: FileEntry; ciphertext: Buffer }> => {
  const src = path.join(storeDir, `${rel.replaceAll("/", "-")}.src`);
  const tmp = path.join(storeDir, "crypto-tmp");
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(src, content);
  const blob = await encryptFileToTempInline(src, kek, tmp, { compress });
  const ciphertext = await fs.readFile(blob.ciphertextPath);
  await store.put(blob.encSha, ciphertext);
  return {
    entry: {
      path: rel,
      type: "file",
      sha256: blob.plaintextSha,
      encSha: blob.encSha,
      size: content.length,
      mode: 0o644,
      mtimeMs: 0,
      ...(blob.comp ? { comp: blob.comp, payloadSha: blob.payloadSha, cipherSize: blob.cipherSize } : {}),
    },
    ciphertext,
  };
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

test("poisoned conflict and ancestor-obstruction writes verify before displacing any local bytes", async () => {
  const kek = generateKek();
  const incoming = await encryptedEntry("placeholder", Buffer.from("remote bytes\n"), kek, false);
  const poisoned = (rel: string): FileEntry => ({ ...incoming.entry, path: rel, sha256: hashBytes(Buffer.from("different expected bytes")) });

  await write("live.log", "local writer bytes\n");
  const conflict: Action = { kind: "conflict", path: "live.log", keepLocalAs: "live.device.20260709000000.conflict.log", entry: poisoned("live.log") };
  await expect(applyActions(root, [conflict], store, { kek })).rejects.toThrow(/live\.log/);
  expect(await read("live.log")).toBe("local writer bytes\n");
  expect(await exists("live.device.20260709000000.conflict.log")).toBe(false);

  await write("tree", "ancestor obstruction\n");
  const child: Action = { kind: "write", entry: poisoned("tree/child.txt"), expectedLocal: undefined };
  await expect(applyActions(root, [child], store, { kek })).rejects.toThrow(/tree\/child\.txt/);
  expect(await lstatType("tree")).toBe("file");
  expect(await read("tree")).toBe("ancestor obstruction\n");
  expect((await conflictCopies()).some((name) => name.startsWith("tree."))).toBe(false);
});

test("size-cap, plaintext-SHA, GCM, and zstd staging failures all name the entry path", async () => {
  const kek = generateKek();
  const compressedBytes = Buffer.from("highly compressible integrity payload\n".repeat(2_000));
  const compressed = await encryptedEntry("base-compressed", compressedBytes, kek, true);
  expect(compressed.entry.comp).toBe("zstd");
  const raw = await encryptedEntry("base-raw", Buffer.from("raw ciphertext interpreted as zstd\n"), kek, false);

  const tamperedAddress = hashBytes(Buffer.from("tampered-address"));
  const tampered = Buffer.from(compressed.ciphertext);
  tampered[0] = tampered[0]! ^ 0xff;
  await store.put(tamperedAddress, tampered);

  const cases: Array<{ path: string; entry: FileEntry; message: RegExp }> = [
    {
      path: "errors/size-cap.log",
      entry: { ...compressed.entry, path: "errors/size-cap.log", size: compressedBytes.length - 1 },
      message: /exceeds declared size/,
    },
    {
      path: "errors/plaintext-sha.log",
      entry: { ...compressed.entry, path: "errors/plaintext-sha.log", sha256: hashBytes(Buffer.from("wrong plaintext sha")) },
      message: /decrypt integrity mismatch/,
    },
    {
      path: "errors/gcm.log",
      entry: { ...compressed.entry, path: "errors/gcm.log", encSha: tamperedAddress },
      message: /authenticate|operation-specific reason/i,
    },
    {
      path: "errors/zstd.log",
      entry: {
        ...raw.entry,
        path: "errors/zstd.log",
        comp: "zstd",
        payloadSha: raw.entry.sha256,
        cipherSize: raw.ciphertext.length,
      },
      message: /zstd|frame|data|compression|dictionary/i,
    },
  ];

  for (const c of cases) {
    let error: Error | undefined;
    try {
      await applyActions(root, [{ kind: "write", entry: c.entry, expectedLocal: undefined }], store, { kek });
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      error = e;
    }
    expect(error?.message).toContain(c.path);
    expect(error?.message).toMatch(c.message);
    expect(await exists(c.path)).toBe(false);
  }
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

// --- review-regression guards ----------------------------------------------

test("unlinkDir for a path that is NOW A FILE (the eviction-echo flip) re-derives the file, drops only dir children", async () => {
  // Base: foo/ is a directory with a child. Then the pull evicts foo/ and writes FILE foo.
  await write("foo/child.txt", "old");
  const base = await buildManifest();
  expect(base.files.some((f) => f.path === "foo/child.txt")).toBe(true);
  await fs.rm(path.join(root, "foo"), { recursive: true, force: true });
  await write("foo", "now a file");

  // The stale queued `unlinkDir foo` must NOT delete the fresh `foo` entry
  // This exact case pushed a sub-threshold delete.
  const after = await applyWatchEvents(base, root, buildIgnoreMatcher(root), [{ relPath: "foo", kind: "unlinkDir" }]);
  expect(after.files.some((f) => f.path === "foo")).toBe(true);
  expect(after.files.some((f) => f.path === "foo/child.txt")).toBe(false); // children impossible under a file
});

test("stale unlinkDir on a still-present dir is AUTHORITATIVE: vanished children drop, fresh ones upsert", async () => {
  await write("d/old.txt", "x");
  const base = await buildManifest();
  await fs.rm(path.join(root, "d/old.txt"));
  await write("d/new.txt", "y");

  const after = await applyWatchEvents(base, root, buildIgnoreMatcher(root), [{ relPath: "d", kind: "unlinkDir" }]);
  expect(after.files.some((f) => f.path === "d/new.txt")).toBe(true);
  expect(after.files.some((f) => f.path === "d/old.txt")).toBe(false); // rescan is truth, not a merge
});

test("two conflict move-asides for the same path in the same second never clobber each other", async () => {
  // deleteEntry's dirty branch names the copy with second-precision conflictName —
  // drive it twice with the same wall-second and device.
  const mkDelete = (expected: FileEntry): Action => ({ kind: "delete", path: "c.txt", expectedLocal: expected });
  const staleExpected: FileEntry = { path: "c.txt", type: "file", sha256: hashBytes(Buffer.from("other")), size: 5, mode: 0o644, mtimeMs: 0 };

  await write("c.txt", "v1");
  await applyActions(root, [mkDelete(staleExpected)], store, { device: "dev" });
  await write("c.txt", "v2");
  await applyActions(root, [mkDelete(staleExpected)], store, { device: "dev" });

  const copies = (await fs.readdir(root)).filter((n) => n.includes("conflict"));
  expect(copies.length).toBe(2); // both preserved — second got a ~2 suffix
  const contents = await Promise.all(copies.map((n) => read(n)));
  expect(contents.sort()).toEqual(["v1", "v2"]);
});
