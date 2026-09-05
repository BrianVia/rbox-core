import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache } from "./hashcache.js";
import { overrideHashFileForTests } from "./hash.js";
import { applyWatchEvents } from "./manifest.js";
import type { WatchEventKind } from "./manifest-observation.js";
import type { FileEntry, Manifest } from "./types.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-absent-delete-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (rel: string): FileEntry => ({ path: rel, type: "file", size: 1, mode: 0o644, mtimeMs: 0, sha256: "a".repeat(64) });
const manifest = (...paths: string[]): Manifest => ({ generatedAt: "", files: paths.map(entry) });
const identity = { mtimeMs: 0, size: 1, ctimeMs: 0, sha256: "a".repeat(64) };

test("absent runs preserve literal boundaries, deferred entries, input and cache-only exact roots", async () => {
  const base = manifest("gone/child", "gone/nested/f", "gone-other/f", "other/f");
  const cache = new HashCache(
    Object.fromEntries(
      [...base.files.map((f) => f.path), "gone", "gone/nested", "empty", "empty/cache-only-child"].map((rel) => [rel, identity])
    )
  );
  expect(cache.needsSave).toBe(false);
  const deferred = new Set(["gone/child", "unrelated"]);
  const result = await applyWatchEvents(
    base,
    root,
    {
      ignores: () => {
        throw new Error("absent unlinkDir must not consult ignore rules");
      }
    },
    ["gone/nested", "gone", "gone", "empty"].map((relPath) => ({ relPath, kind: "unlinkDir" })),
    cache,
    deferred
  );
  expect(result.files.map((f) => f.path)).toEqual(["gone-other/f", "other/f"]);
  expect(base.files.map((f) => f.path)).toEqual(["gone/child", "gone/nested/f", "gone-other/f", "other/f"]);
  for (const rel of ["gone/child", "gone/nested/f", "gone", "gone/nested", "empty"])
    expect(cache.statIdentity(rel, identity.sha256)).toBeUndefined();
  expect(cache.statIdentity("gone-other/f", identity.sha256)).toBeDefined();
  // Baseline invalidates descendants present in the manifest, not every cached prefix.
  expect(cache.statIdentity("empty/cache-only-child", identity.sha256)).toBeDefined();
  expect(cache.needsSave).toBe(true);
  expect(deferred).toEqual(new Set(["gone/child", "unrelated"]));
});

test("noncanonical event spellings retain the old literal prefix semantics", async () => {
  const base = manifest("gone/child", "gone//child", "./gone/child", "back\\slash/child", "gone/");
  const result = await applyWatchEvents(
    base,
    root,
    { ignores: () => false },
    ["gone/", "./gone", "back\\slash", ""].map((relPath) => ({ relPath, kind: "unlinkDir" }))
  );
  expect(result.files.map((f) => f.path)).toEqual(["gone/child"]);
});

test("ENOTDIR joins absent runs without deleting the parent file", async () => {
  await fs.writeFile(path.join(root, "parent"), "x");
  const result = await applyWatchEvents(manifest("parent", "parent/child/f", "other/f"), root, { ignores: () => false }, [
    { relPath: "other", kind: "unlinkDir" },
    { relPath: "parent/child", kind: "unlinkDir" }
  ]);
  expect(result.files.map((f) => f.path)).toEqual(["parent"]);
});

const boundaries: WatchEventKind[] = ["add", "change", "unlink", "addDir", "unlinkDir"];
for (const kind of boundaries) {
  test(`pending deletes flush before ${kind} can consult ignore rules or cached identities`, async () => {
    if (kind.endsWith("Dir")) await fs.mkdir(path.join(root, "live"));
    else await fs.writeFile(path.join(root, "live"), "x");
    const cache = new HashCache();
    cache.record("gone/f", identity);
    let observed = false;
    const result = await applyWatchEvents(
      manifest("gone/f"),
      root,
      {
        ignores: () => {
          observed = true;
          expect(cache.statIdentity("gone/f", identity.sha256)).toBeUndefined();
          return false;
        }
      },
      [
        { relPath: "gone", kind: "unlinkDir" },
        { relPath: "live", kind }
      ],
      cache
    );
    expect(observed).toBe(true);
    expect(result.files.some((f) => f.path === "gone/f")).toBe(false);
  });
}

test.skipIf(process.getuid?.() === 0)("unreadable unlinkDir preserves its subtree and adds deferral after an absent run", async () => {
  await fs.mkdir(path.join(root, "locked"));
  await fs.chmod(path.join(root, "locked"), 0o000);
  const deferred = new Set(["gone/f"]);
  try {
    const result = await applyWatchEvents(
      manifest("gone/f", "locked/child/f"),
      root,
      { ignores: () => false },
      [
        { relPath: "gone", kind: "unlinkDir" },
        { relPath: "locked/child", kind: "unlinkDir" }
      ],
      undefined,
      deferred
    );
    expect(result.files.map((f) => f.path)).toEqual(["locked/child/f"]);
    expect(deferred).toEqual(new Set(["gone/f", "locked/child"]));
  } finally {
    await fs.chmod(path.join(root, "locked"), 0o700);
  }
});

test("a later hash failure still leaves prior absent cache invalidations applied", async () => {
  await fs.writeFile(path.join(root, "live"), "x");
  const cache = new HashCache();
  cache.record("gone/f", identity);
  const reset = overrideHashFileForTests(async () => {
    throw Object.assign(new Error("injected failure"), { code: "EMFILE" });
  });
  try {
    await expect(
      applyWatchEvents(
        manifest("gone/f"),
        root,
        { ignores: () => false },
        [
          { relPath: "gone", kind: "unlinkDir" },
          { relPath: "live", kind: "change" }
        ],
        cache
      )
    ).rejects.toMatchObject({ code: "EMFILE" });
    expect(cache.statIdentity("gone/f", identity.sha256)).toBeUndefined();
  } finally {
    reset();
  }
});
