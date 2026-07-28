/**
 * Design 212 acceptance 9 — ignore authority. A scoped binding has no publish with
 * which to reconcile a local rule edit, so remote wins and the user is told.
 */
import { expect, test } from "bun:test";
import type { Action, FileEntry, Manifest } from "../../engine/index.js";
import { ScopeProjection } from "./projection.js";
import { applyRuleFileAuthority } from "./rule-authority.js";

const entry = (path: string, sha: string): FileEntry =>
  ({ path, type: "file", size: 1, mtimeMs: 0, sha256: sha } as FileEntry);
const manifest = (...files: FileEntry[]): Manifest => ({ generatedAt: "", files });
const projection = new ScopeProjection(["Personal/repo-A"]);
const pathOf = (a: Action): string => (a.kind === "write" ? a.entry.path : a.path);

test("a rule file the publisher CREATED lands, and is not reported as a local edit", () => {
  const result = applyRuleFileAuthority([], projection, manifest(), manifest(), manifest(entry(".rboxignore", "r1")));
  expect(result.actions.map(pathOf)).toEqual([".rboxignore"]);
  expect(result.diverged).toEqual([]);
});

test("a rule file the publisher CHANGED overwrites a local edit and IS reported", () => {
  const result = applyRuleFileAuthority(
    [{ kind: "conflict", path: ".rboxignore", keepLocalAs: ".rboxignore.conflict", entry: entry(".rboxignore", "r2") }],
    projection,
    manifest(entry(".rboxignore", "r1")),
    manifest(entry(".rboxignore", "local")),
    manifest(entry(".rboxignore", "r2")),
  );
  // The conflict is REPLACED: a `.conflict` copy would leave the matcher able to
  // read the losing bytes.
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0]!.kind).toBe("write");
  expect(result.diverged).toEqual([".rboxignore"]);
});

test("a rule file the publisher DELETED is removed even when it was edited here", () => {
  const result = applyRuleFileAuthority(
    [],
    projection,
    manifest(entry("Personal/.gitignore", "r1")),
    manifest(entry("Personal/.gitignore", "local")),
    manifest(),
  );
  expect(result.actions).toEqual([
    { kind: "delete", path: "Personal/.gitignore", expectedLocal: entry("Personal/.gitignore", "local") },
  ]);
  expect(result.diverged).toEqual(["Personal/.gitignore"]);
});

test("a rule file that merely lags behind is not a divergence finding", () => {
  const result = applyRuleFileAuthority([], projection,
    manifest(entry(".gitignore", "r1")), manifest(entry(".gitignore", "r1")), manifest(entry(".gitignore", "r2")));
  expect(result.actions.map(pathOf)).toEqual([".gitignore"]);
  expect(result.diverged).toEqual([]);
});

test("ordinary files are left entirely to reconcile", () => {
  const planned: Action[] = [{ kind: "write", entry: entry("Personal/repo-A/x", "a") }];
  const result = applyRuleFileAuthority(planned, projection, manifest(), manifest(), manifest(entry("Personal/repo-A/x", "a")));
  expect(result.actions).toEqual(planned);
  expect(result.diverged).toEqual([]);
});
