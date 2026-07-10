import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "./ignore.js";

type Mutation = (abs: string) => Promise<void>;
let mutation: Mutation | undefined;

mock.module("./hash.js", () => ({
  hashBytes: (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex"),
  hashFile: async (abs: string, sizeHint?: number): Promise<string> => {
    const run = mutation;
    mutation = undefined;
    if (run) await run(abs);
    void sizeHint;
    return createHash("sha256").update(await fs.readFile(abs)).digest("hex");
  },
}));

const { applyWatchEvents, scanManifest } = await import("./manifest.js");

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(contents = "original"): Promise<{ root: string; abs: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-torn-scan-"));
  roots.push(root);
  const abs = path.join(root, "file.txt");
  await fs.writeFile(abs, contents);
  return { root, abs };
}

test("full scan defers an append injected at hash time and emits no torn entry", async () => {
  const { root } = await fixture();
  mutation = async (abs) => fs.appendFile(abs, "-appended");
  const deferred = new Set<string>();

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred);

  expect([...deferred]).toEqual(["file.txt"]);
  expect(manifest.files).toEqual([]);
});

test("full scan defers an atomic same-size replacement with restored mtime", async () => {
  const { root, abs } = await fixture("aaaaaaaa");
  const before = await fs.stat(abs);
  mutation = async (target) => {
    const replacement = `${target}.replacement`;
    await fs.writeFile(replacement, "bbbbbbbb");
    await fs.utimes(replacement, before.atime, before.mtime);
    await fs.rename(replacement, target);
  };
  const deferred = new Set<string>();

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred);

  expect([...deferred]).toEqual(["file.txt"]);
  expect(manifest.files).toEqual([]);
});

test("full scan defers chmod at hash time and emits no torn entry", async () => {
  const { root } = await fixture();
  mutation = async (abs) => fs.chmod(abs, 0o600);
  const deferred = new Set<string>();

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred);

  expect([...deferred]).toEqual(["file.txt"]);
  expect(manifest.files).toEqual([]);
});

test("a stable full scan defers nothing and records the post-stat values", async () => {
  const { root, abs } = await fixture("settled");
  const deferred = new Set<string>();

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred);
  const post = await fs.lstat(abs);

  expect([...deferred]).toEqual([]);
  expect(manifest.files).toHaveLength(1);
  expect(manifest.files[0]).toMatchObject({
    path: "file.txt",
    size: post.size,
    mode: post.mode & 0o777,
    mtimeMs: post.mtimeMs,
  });
});

test("applyWatchEvents defers chmod during hashing and emits no torn entry", async () => {
  const { root } = await fixture();
  const matcher = buildIgnoreMatcher(root);
  mutation = async (abs) => fs.chmod(abs, 0o600);
  const deferred = new Set<string>();

  const manifest = await applyWatchEvents(
    { generatedAt: "", files: [] },
    root,
    matcher,
    [{ relPath: "file.txt", kind: "change" }],
    undefined,
    deferred,
  );

  expect([...deferred]).toEqual(["file.txt"]);
  expect(manifest.files).toEqual([]);
});

test("unlinkDir subtree rescan defers a churning child instead of deleting its prior entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-torn-scan-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "dir"));
  const abs = path.join(root, "dir/file.txt");
  await fs.writeFile(abs, "settled");
  const matcher = buildIgnoreMatcher(root);

  // Prior coherent truth for the subtree, established without churn.
  const base = await scanManifest(root);
  const prior = base.files.find((f) => f.path === "dir/file.txt")!;

  // A stale unlinkDir (dir still exists) triggers the authoritative subtree
  // rescan; the child churns during its hash. Absence from the fresh walk must
  // read as UNSTABLE (keep prior entry + defer), never as a deletion.
  mutation = async (target) => fs.appendFile(target, "-appended");
  const deferred = new Set<string>();
  const manifest = await applyWatchEvents(base, root, matcher, [{ relPath: "dir", kind: "unlinkDir" }], undefined, deferred);

  expect([...deferred]).toEqual(["dir/file.txt"]);
  expect(manifest.files.find((f) => f.path === "dir/file.txt")).toEqual(prior);
});
