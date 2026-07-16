import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyActions,
  diffManifests,
  LocalBlobStore,
  reconcile,
  scanManifest,
  type Manifest,
} from "./index.js";
import { uploadManifestBlobs } from "./apply.js";

// Two working trees (A, B) sharing one blob store == two machines syncing
// through a remote. We drive the real engine end-to-end and assert on the
// resulting bytes on disk, not on internal shapes.
let tmp: string;
let A: string;
let B: string;
let storeDir: string;
let store: LocalBlobStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-test-"));
  A = path.join(tmp, "A");
  B = path.join(tmp, "B");
  storeDir = path.join(tmp, "store");
  await fs.mkdir(A, { recursive: true });
  await fs.mkdir(B, { recursive: true });
  store = new LocalBlobStore(storeDir);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const write = async (root: string, rel: string, content: string) => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
};
const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), "utf8");
const exists = async (root: string, rel: string) => {
  try {
    await fs.access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
};
const EMPTY: Manifest = { generatedAt: "", files: [] };

// "Push" A: scan + upload blobs. "Pull onto B": scan B, reconcile against base, apply.
const push = async (root: string) => {
  const m = await scanManifest(root);
  await uploadManifestBlobs(root, m, store);
  return m;
};
const pullOnto = async (root: string, base: Manifest, remote: Manifest, device = "B") => {
  const local = await scanManifest(root);
  const actions = reconcile(base, local, remote, device, new Date().toISOString());
  await applyActions(root, actions, store);
  return actions;
};

test("round-trip: a fresh tree materializes byte-identically on the other side", async () => {
  await write(A, "src/index.ts", "export const x = 1;\n");
  await write(A, "package.json", '{"name":"demo"}\n');
  await write(A, "nested/deep/readme.md", "# hi\n");

  const remote = await push(A);
  await pullOnto(B, EMPTY, remote);

  const a = await scanManifest(A);
  const b = await scanManifest(B);
  // Same set of paths + same hashes => same bytes.
  expect(b.files.map((f) => f.path)).toEqual(a.files.map((f) => f.path));
  expect(b.files.map((f) => f.sha256)).toEqual(a.files.map((f) => f.sha256));
  expect(await read(B, "src/index.ts")).toBe("export const x = 1;\n");
});

test("ignore rules: node_modules / .env are never synced, .env.example is", async () => {
  await write(A, "src/app.ts", "ok\n");
  await write(A, "node_modules/lib/index.js", "vendor\n");
  await write(A, ".env", "SECRET=1\n");
  await write(A, ".env.example", "SECRET=\n");

  const remote = await push(A);
  const synced = remote.files.map((f) => f.path);
  expect(synced).toContain("src/app.ts");
  expect(synced).toContain(".env.example");
  expect(synced).not.toContain(".env");
  expect(synced.some((p) => p.startsWith("node_modules/"))).toBe(false);
});

test("update propagates: editing a file on A updates B", async () => {
  await write(A, "a.txt", "v1\n");
  const m1 = await push(A);
  await pullOnto(B, EMPTY, m1);
  expect(await read(B, "a.txt")).toBe("v1\n");

  await write(A, "a.txt", "v2\n");
  const m2 = await push(A);
  await pullOnto(B, m1, m2);
  expect(await read(B, "a.txt")).toBe("v2\n");
});

test("delete propagates: removing a file on A removes it on B", async () => {
  await write(A, "keep.txt", "keep\n");
  await write(A, "gone.txt", "bye\n");
  const m1 = await push(A);
  await pullOnto(B, EMPTY, m1);
  expect(await exists(B, "gone.txt")).toBe(true);

  await fs.rm(path.join(A, "gone.txt"));
  const m2 = await push(A);
  await pullOnto(B, m1, m2);

  expect(await exists(B, "gone.txt")).toBe(false);
  expect(await exists(B, "keep.txt")).toBe(true);
});

test("conflict: same file edited on both sides keeps both copies, loses nothing", async () => {
  await write(A, "shared.ts", "base\n");
  const m1 = await push(A);
  await pullOnto(B, EMPTY, m1); // A and B now agree on base

  // Divergent edits to the SAME path.
  await write(A, "shared.ts", "from-A\n");
  await write(B, "shared.ts", "from-B\n");

  const mA = await push(A); // A pushes its version
  const actions = await pullOnto(B, m1, mA, "macbook");

  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  // Canonical path holds the remote (A) version...
  expect(await read(B, "shared.ts")).toBe("from-A\n");
  // ...and B's local edit is preserved in a conflict copy.
  const files = await fs.readdir(B);
  const conflictFile = files.find((f) => f.includes(".conflict."));
  expect(conflictFile).toBeDefined();
  expect(await read(B, conflictFile!)).toBe("from-B\n");
});

test("no spurious sync: changing only mtime is not a content change", async () => {
  await write(A, "a.txt", "same\n");
  const m1 = await scanManifest(A);

  // Touch the file's mtime into the future without changing bytes.
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(A, "a.txt"), future, future);

  const m2 = await scanManifest(A);
  const d = diffManifests(m1, m2);
  expect(d.added).toEqual([]);
  expect(d.changed).toEqual([]);
  expect(d.deleted).toEqual([]);
});

// scanManifest's optional discovery callback drives the CLI's indeterminate `scan`
// spinner. It must fire on a running count as the recursive walk crosses the stride,
// across nested directories — proving the counter is threaded through recursion, not
// reset per directory.
test("scanManifest reports discovery progress every 500 entries across the recursive walk", async () => {
  const TOTAL = 1050;
  // Spread across nested dirs so the recursion (not a single readdir) is exercised.
  await Promise.all(
    Array.from({ length: TOTAL }, (_, i) => write(A, `d${i % 7}/sub${i % 3}/f${i}.txt`, `x${i}`))
  );
  const ticks: number[] = [];
  const m = await scanManifest(A, undefined, undefined, (n) => ticks.push(n));
  expect(m.files.length).toBe(TOTAL);
  // 1050 entries → callbacks at 500 and 1000 (stride 500), and only those.
  expect(ticks).toEqual([500, 1000]);
});

test("scanManifest omits progress entirely when no callback is given (no-op fast path)", async () => {
  await write(A, "a.txt", "a");
  const m = await scanManifest(A); // 3-arg call — the callback is optional
  expect(m.files.length).toBe(1);
});
