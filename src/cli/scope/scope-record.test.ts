import { expect, test } from "bun:test";
import { normalizeScopePrefix, parseScopeFlag, scopeSplitsRepo, validateScopePrefixes, MAX_SCOPE_PREFIXES } from "./scope-record.js";

test("normalizes the shapes a person actually types", () => {
  expect(normalizeScopePrefix("./Personal/repo-A/")).toBe("Personal/repo-A");
  expect(normalizeScopePrefix("  Personal/repo-A  ")).toBe("Personal/repo-A");
  expect(normalizeScopePrefix("Personal")).toBe("Personal");
});

test("refuses anything that cannot name a workspace subtree", () => {
  for (const bad of ["", "/abs/path", "../escape", "Personal/../..", "a\\b", "a\u0000b", "."]) {
    expect(normalizeScopePrefix(bad)).toBeUndefined();
  }
});

test("the bind-time table: dedupe, sort, non-empty", () => {
  const ok = validateScopePrefixes(["b/two", "a/one", "b/two"]);
  expect(ok).toEqual({ ok: true, prefixes: ["a/one", "b/two"] });
  expect(validateScopePrefixes([]).ok).toBe(false);
  expect(validateScopePrefixes(["   "]).ok).toBe(false);
});

test("nested and overlapping prefixes are refused, segment-aware", () => {
  const nested = validateScopePrefixes(["Personal", "Personal/repo-A"]);
  expect(nested.ok).toBe(false);
  if (!nested.ok) expect(nested.error).toContain("already inside");
  // `foo` must not be read as containing `foobar`.
  expect(validateScopePrefixes(["foo", "foobar"]).ok).toBe(true);
});

test("the prefix count is bounded", () => {
  const many = Array.from({ length: MAX_SCOPE_PREFIXES + 1 }, (_, i) => `p${i}`);
  expect(validateScopePrefixes(many).ok).toBe(false);
});

test("a prefix may not cut a git repository in half", () => {
  expect(scopeSplitsRepo(["Personal/repo-A/src"], ["Personal/repo-A"]))
    .toEqual({ prefix: "Personal/repo-A/src", repo: "Personal/repo-A" });
  // The repo itself, and a repo INSIDE the prefix, are both fine.
  expect(scopeSplitsRepo(["Personal/repo-A"], ["Personal/repo-A"])).toBeUndefined();
  expect(scopeSplitsRepo(["Personal"], ["Personal/repo-A"])).toBeUndefined();
  // The workspace-root repo key never counts as a splitter of everything.
  expect(scopeSplitsRepo(["Personal"], ["."])).toBeUndefined();
});

test("--scope parses comma-separated lists", () => {
  expect(parseScopeFlag("a, b ,,c")).toEqual(["a", "b", "c"]);
  expect(parseScopeFlag("")).toEqual([]);
});
