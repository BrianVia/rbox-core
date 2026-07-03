import { test, expect } from "bun:test";
import type { Fingerprint } from "./convergence.js";
import {
  canonicalManifest,
  compareManifests,
  diskCheckDetail,
  findUnsyncedExtras,
  fpExpectedSha256,
  isPrunedPath,
  manifestDiffDetail,
  normPath,
  parseManifestState,
  sha256Hex,
  verifyManifestOnDisk,
  type ManifestEntry,
} from "./manifest-check.js";

// A real state.json is a SyncState; the check only reads lastSyncedManifest.files.
const stateJson = (files: unknown[]) =>
  JSON.stringify({ stream: "https://api::ws::root", lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files } });

const file = (path: string, sha256: string, size = 1): ManifestEntry => ({ path, sha256, size, type: "file" });

test("normPath strips a leading ./ so fingerprint and manifest paths align", () => {
  expect(normPath("./a/b")).toBe("a/b");
  expect(normPath("a/b")).toBe("a/b");
  expect(normPath("./")).toBe("");
});

test("isPrunedPath matches .rbox/.git/node_modules at any depth, by segment", () => {
  expect(isPrunedPath("node_modules/left-pad/index.js")).toBe(true);
  expect(isPrunedPath("pkg/.git/config")).toBe(true);
  expect(isPrunedPath(".rbox/state.json")).toBe(true);
  // Substring, not segment — must NOT prune.
  expect(isPrunedPath("src/node_modules_helper.ts")).toBe(false);
  expect(isPrunedPath("src/app.ts")).toBe(false);
});

test("parseManifestState reads files, normalizes paths, and keeps type", () => {
  const entries = parseManifestState(
    stateJson([
      { path: "./a.txt", sha256: "aaa", size: 3, mode: 420, mtimeMs: 111, type: "file" },
      { path: "link", sha256: "bbb", size: 5, mode: 511, mtimeMs: 222, type: "symlink", symlinkTarget: "a.txt" },
    ])
  );
  expect(entries).toEqual([
    { path: "a.txt", sha256: "aaa", size: 3, type: "file" },
    { path: "link", sha256: "bbb", size: 5, type: "symlink" },
  ]);
});

test("parseManifestState throws on invalid JSON and on a missing files array", () => {
  expect(() => parseManifestState("{not json")).toThrow("not valid JSON");
  expect(() => parseManifestState(JSON.stringify({ lastSyncedManifest: {} }))).toThrow("no lastSyncedManifest.files");
  expect(() => parseManifestState(JSON.stringify({}))).toThrow("no lastSyncedManifest.files");
});

test("canonicalManifest sorts by path without mutating input", () => {
  const input = [file("b", "2"), file("a", "1")];
  const sorted = canonicalManifest(input);
  expect(sorted.map((e) => e.path)).toEqual(["a", "b"]);
  expect(input.map((e) => e.path)).toEqual(["b", "a"]); // untouched
});

test("compareManifests: identity ignores order; sha256 and size drift both surface", () => {
  const a = [file("x", "1", 10), file("y", "2", 20)];
  const same = [file("y", "2", 20), file("x", "1", 10)];
  expect(compareManifests(a, same).identical).toBe(true);

  // z only in B; y differs by sha; x differs by size.
  const b = [file("x", "1", 99), file("y", "9", 20), file("z", "3", 1)];
  const diff = compareManifests(a, b);
  expect(diff.identical).toBe(false);
  expect(diff.onlyA).toEqual([]);
  expect(diff.onlyB).toEqual(["z"]);
  expect(diff.differing).toEqual(["x", "y"]);
});

test("fpExpectedSha256: file digest passes through; symlink re-hashes the target string", () => {
  expect(fpExpectedSha256({ path: "./f", digest: "deadbeef", kind: "file" })).toBe("deadbeef");
  expect(fpExpectedSha256({ path: "./l", digest: "symlink:../t.txt", kind: "symlink" })).toBe(sha256Hex("../t.txt"));
});

// A fingerprint as convergence.fingerprintTree would yield it: file digests are hex
// sha256; symlink digests are `symlink:<target>`; paths carry the `./` prefix.
const fp = (entries: Fingerprint["entries"]): Fingerprint => ({ entries, fileCount: entries.filter((e) => e.kind === "file").length });

test("verifyManifestOnDisk: matches files + symlinks, flags missing/mismatched, exempts pruned", () => {
  const linkTarget = "a.txt";
  const linkSha = sha256Hex(linkTarget); // manifest sha256 for a symlink = hash of target string
  const manifest: ManifestEntry[] = [
    file("a.txt", "sha-a"),
    { path: "link", sha256: linkSha, size: linkTarget.length, type: "symlink" },
    file("node_modules/dep/index.js", "sha-nm"), // pruned → exempt (not on the fingerprint)
    file("gone.txt", "sha-gone"), // absent on disk → missing
    file("drift.txt", "sha-expected"), // present but wrong digest → mismatched
  ];
  const disk = fp([
    { path: "./a.txt", digest: "sha-a", kind: "file" },
    { path: "./link", digest: `symlink:${linkTarget}`, kind: "symlink" },
    { path: "./drift.txt", digest: "sha-actual", kind: "file" },
  ]);
  const res = verifyManifestOnDisk(manifest, disk);
  expect(res.ok).toBe(false);
  expect(res.missing).toEqual(["gone.txt"]);
  expect(res.mismatched).toEqual(["drift.txt"]);
  expect(res.exemptCount).toBe(1);
});

test("verifyManifestOnDisk: clean set (incl. symlink + pruned) is ok", () => {
  const manifest: ManifestEntry[] = [
    file("a.txt", "sha-a"),
    { path: "link", sha256: sha256Hex("a.txt"), size: 5, type: "symlink" },
    file(".git/config", "sha-git"), // exempt
  ];
  const disk = fp([
    { path: "./a.txt", digest: "sha-a", kind: "file" },
    { path: "./link", digest: "symlink:a.txt", kind: "symlink" },
  ]);
  const res = verifyManifestOnDisk(manifest, disk);
  expect(res.ok).toBe(true);
  expect(res.exemptCount).toBe(1);
});

test("findUnsyncedExtras: on-disk files absent from the manifest are offenders", () => {
  const manifest = [file("a.txt", "sha-a")];
  const disk = fp([
    { path: "./a.txt", digest: "sha-a", kind: "file" },
    { path: "./sneaky.txt", digest: "sha-x", kind: "file" },
    { path: "./also-link", digest: "symlink:x", kind: "symlink" },
  ]);
  expect(findUnsyncedExtras(disk, manifest)).toEqual(["also-link", "sneaky.txt"]);
});

test("detail summaries are one-liners capped at five offenders", () => {
  const md = manifestDiffDetail({ identical: false, onlyA: ["a"], onlyB: ["b", "c"], differing: ["d"] });
  expect(md).toContain("onlyA=1 onlyB=2 diff=1");
  expect(md).toContain("A:a");
  const dc = diskCheckDetail({ ok: false, missing: ["m1", "m2"], mismatched: ["x"], exemptCount: 7 });
  expect(dc).toContain("missing=2 mismatched=1 exempt=7");
});
