import { expect, test } from "bun:test";
import type { FileEntry, Manifest } from "../../engine/index.js";
import { composeScopedBase, metadataRuleFiles, ScopeProjection } from "./projection.js";

const file = (path: string, sha = "a"): FileEntry => ({ path, type: "file", size: 1, mtimeMs: 0, sha256: sha } as FileEntry);
const manifest = (paths: string[], sha = "a"): Manifest => ({ generatedAt: "", files: paths.map((p) => file(p, sha)) });

test("repos are classified IN / STRADDLE / OOS, segment-aware", () => {
  const p = new ScopeProjection(["Personal/repo-A"]);
  expect(p.classifyRepo("Personal/repo-A")).toBe("in");
  expect(p.classifyRepo("Personal/repo-A/vendor/dep")).toBe("in");
  expect(p.classifyRepo("Personal")).toBe("straddle");
  expect(p.classifyRepo(".")).toBe("straddle");
  expect(p.classifyRepo("Work/other")).toBe("oos");
  // `Personal/repo-AB` is a sibling, not a member.
  expect(p.classifyRepo("Personal/repo-AB")).toBe("oos");
});

test("a straddling repo quarantines its whole subtree, unrelated paths advance", () => {
  const p = new ScopeProjection(["Personal/repo-A", "Work/repo-B"], ["Personal"]);
  expect(p.straddling).toEqual(["Personal"]);
  expect(p.includes("Personal/repo-A/src/main.ts")).toBe(false);
  expect(p.includes("Work/repo-B/src/main.ts")).toBe(true);
});

test("ignore-rule metadata is always materialized, including scope ancestors", () => {
  expect(metadataRuleFiles(["Personal/repo-A"]))
    .toEqual([".gitignore", ".rboxignore", "Personal/.gitignore"]);
  const p = new ScopeProjection(["Personal/repo-A"]);
  expect(p.includes(".rboxignore")).toBe(true);
  expect(p.includes("Personal/.gitignore")).toBe(true);
  expect(p.includes("Work/.gitignore")).toBe(false);
});

test("the file projection is what gates writes and blob fetches", () => {
  const p = new ScopeProjection(["Personal/repo-A"]);
  expect(p.projectFiles(manifest(["Personal/repo-A/a", "Work/b", ".rboxignore"])).files.map((f) => f.path))
    .toEqual(["Personal/repo-A/a", ".rboxignore"]);
});

test("probe keys exclude every carried repo, so no out-of-scope probe is issued", () => {
  const p = new ScopeProjection(["Personal/repo-A"], ["Personal", "Work/other", "Personal/repo-A"]);
  expect(p.probeKeys(["Personal", "Work/other", "Personal/repo-A"])).toEqual(["Personal/repo-A"]);
  expect(p.carriedKeys(["Personal", "Work/other", "Personal/repo-A"])).toEqual(["Personal", "Work/other"]);
});

test("with no straddle the stored base is the remote verbatim (out-of-scope carry)", () => {
  const p = new ScopeProjection(["Personal/repo-A"]);
  const remote = manifest(["Personal/repo-A/a", "Work/b"]);
  expect(composeScopedBase(manifest([]), remote, p)).toBe(remote);
});

test("a straddling repo retains its PRIOR file base while everything else advances", () => {
  const p = new ScopeProjection(["Personal/repo-A"], ["Personal"]);
  const base = manifest(["Personal/repo-A/a", "Work/b"], "old");
  const remote = manifest(["Personal/repo-A/a", "Work/b"], "new");
  const composed = composeScopedBase(base, remote, p);
  expect(composed.files.find((f) => f.path === "Personal/repo-A/a")?.sha256).toBe("old");
  expect(composed.files.find((f) => f.path === "Work/b")?.sha256).toBe("new");
});
