import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type FileEntry, type Manifest } from "../engine/index.js";
import { projectLocalManifest } from "./local-file-projection.js";

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lfp-"));
  await fs.writeFile(path.join(root, ".rboxignore"), "secrets.txt\n");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const manifest = (files: FileEntry[]): Manifest => ({ generatedAt: "2026-07-29T00:00:00.000Z", files });

// Design 224 §1.3 + §3.3 test 13: the forward-only carry is what makes "add one
// ignore rule" safe — a base entry the matcher now ignores keeps its last copy on
// every other machine instead of becoming a fleet-wide delete. It must hold for a
// BUILTIN match and a user `.rboxignore` match alike.
test("an absent, now-ignored base entry is CARRIED, not deleted — builtin and .rboxignore alike", () => {
  const matcher = buildIgnoreMatcher(root);
  const base = manifest([entry("app/node_modules/x.js"), entry("secrets.txt"), entry("keep.txt")]);
  const local = manifest([entry("keep.txt")]);

  const projected = projectLocalManifest(local, base, matcher);

  expect(projected.manifest.files.map((f) => f.path)).toEqual(["app/node_modules/x.js", "keep.txt", "secrets.txt"]);
  expect(projected.strandedIgnored).toBe(2);
});

test("a base entry still present on disk is not double-carried and is not stranded", () => {
  const matcher = buildIgnoreMatcher(root);
  const base = manifest([entry("keep.txt"), entry("app/node_modules/x.js")]);
  const local = manifest([entry("keep.txt"), entry("app/node_modules/x.js")]);

  const projected = projectLocalManifest(local, base, matcher);

  expect(projected.manifest.files.map((f) => f.path)).toEqual(["keep.txt", "app/node_modules/x.js"]);
  expect(projected.strandedIgnored).toBe(0);
});

test("a base entry absent from disk and NOT ignored stays a deletion", () => {
  const matcher = buildIgnoreMatcher(root);
  const base = manifest([entry("gone.txt"), entry("keep.txt")]);

  const projected = projectLocalManifest(manifest([entry("keep.txt")]), base, matcher);

  expect(projected.manifest.files.map((f) => f.path)).toEqual(["keep.txt"]);
  expect(projected.strandedIgnored).toBe(0);
});

// §2.3: the count is total — the return says the same thing on both branches, so a
// caller never has to know which mode it asked for to read the strand.
test("purge drops the carry but the stranded count is still returned", () => {
  const matcher = buildIgnoreMatcher(root);
  const base = manifest([entry("app/node_modules/x.js"), entry("secrets.txt"), entry("keep.txt")]);

  const projected = projectLocalManifest(manifest([entry("keep.txt")]), base, matcher, true);

  expect(projected.manifest.files.map((f) => f.path)).toEqual(["keep.txt"]);
  expect(projected.strandedIgnored).toBe(2);
});
