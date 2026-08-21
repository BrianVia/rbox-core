/**
 * Design 212 acceptance 9 — ignore authority. A scoped binding has no publish with
 * which to reconcile a local rule edit, so remote wins and the user is told.
 */
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyActions, buildIgnoreMatcher, hashBytes, isIgnoreRuleFile, LocalBlobStore, type Action, type FileEntry, type Manifest } from "../../engine/index.js";
import { ScopeProjection } from "./projection.js";
import { applyRuleFileAuthority } from "./rule-authority.js";

const entry = (path: string, sha: string): FileEntry =>
  ({ path, type: "file", size: 1, mtimeMs: 0, sha256: sha } as FileEntry);
const manifest = (...files: FileEntry[]): Manifest => ({ generatedAt: "", files });
const projection = new ScopeProjection(["Personal/repo-A"]);
const pathOf = (a: Action): string => (a.kind === "write" ? a.entry.path : a.path);

test("a rule file the publisher CREATED lands, and is not reported as a local edit", () => {
  const result = applyRuleFileAuthority([], projection, manifest(), manifest(), manifest(entry(".rboxignore", "r1")), "dev", "2026-08-20T12:34:56Z");
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
    "dev",
    "2026-08-20T12:34:56Z",
  );
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0]).toEqual({
    kind: "conflict",
    path: ".rboxignore",
    keepLocalAs: ".rboxignore.dev.20260820123456.conflict",
    entry: entry(".rboxignore", "r2"),
  });
  expect(result.diverged).toEqual([".rboxignore"]);
});

test("an edited scoped rule is preserved outside matcher authority while remote rules take effect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-rule-authority-"));
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-rule-authority-store-"));
  try {
    const localBytes = Buffer.from("local-only.txt\n");
    const remoteBytes = Buffer.from("remote-only.txt\n");
    await fs.writeFile(path.join(root, ".rboxignore"), localBytes);
    const remoteEntry: FileEntry = {
      path: ".rboxignore", type: "file", size: remoteBytes.length, mtimeMs: 0,
      sha256: hashBytes(remoteBytes), mode: 0o644,
    };
    const baseEntry: FileEntry = { ...remoteEntry, sha256: hashBytes(Buffer.from("base-only.txt\n")) };
    const localEntry: FileEntry = { ...remoteEntry, sha256: hashBytes(localBytes), size: localBytes.length };
    const result = applyRuleFileAuthority(
      [], projection, manifest(baseEntry), manifest(localEntry), manifest(remoteEntry),
      "dev", "2026-08-20T12:34:56Z",
    );
    const action = result.actions[0]!;
    expect(action.kind).toBe("conflict");
    if (action.kind !== "conflict") throw new Error("edited rule must plan a conflict");

    const store = new LocalBlobStore(storeDir);
    await store.put(remoteEntry.sha256, remoteBytes);
    await applyActions(root, [action], store);

    expect(await fs.readFile(path.join(root, ".rboxignore"), "utf8")).toBe("remote-only.txt\n");
    expect(await fs.readFile(path.join(root, action.keepLocalAs), "utf8")).toBe("local-only.txt\n");
    expect(isIgnoreRuleFile(action.keepLocalAs)).toBe(false);
    const rebuilt = buildIgnoreMatcher(root);
    expect(rebuilt.ignores("remote-only.txt")).toBe(true);
    expect(rebuilt.ignores("local-only.txt")).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

test("a rule file the publisher DELETED is removed even when it was edited here", () => {
  const result = applyRuleFileAuthority(
    [],
    projection,
    manifest(entry("Personal/.gitignore", "r1")),
    manifest(entry("Personal/.gitignore", "local")),
    manifest(),
    "dev",
    "2026-08-20T12:34:56Z",
  );
  expect(result.actions).toEqual([
    { kind: "delete", path: "Personal/.gitignore", expectedLocal: entry("Personal/.gitignore", "local") },
  ]);
  expect(result.diverged).toEqual(["Personal/.gitignore"]);
});

test("a rule file that merely lags behind is not a divergence finding", () => {
  const result = applyRuleFileAuthority([], projection,
    manifest(entry(".gitignore", "r1")), manifest(entry(".gitignore", "r1")), manifest(entry(".gitignore", "r2")),
    "dev", "2026-08-20T12:34:56Z");
  expect(result.actions.map(pathOf)).toEqual([".gitignore"]);
  expect(result.actions[0]!.kind).toBe("write");
  expect(result.diverged).toEqual([]);
});

test("ordinary files are left entirely to reconcile", () => {
  const planned: Action[] = [{ kind: "write", entry: entry("Personal/repo-A/x", "a") }];
  const result = applyRuleFileAuthority(planned, projection, manifest(), manifest(), manifest(entry("Personal/repo-A/x", "a")), "dev", "2026-08-20T12:34:56Z");
  expect(result.actions).toEqual(planned);
  expect(result.diverged).toEqual([]);
});
