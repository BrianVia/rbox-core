import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmodSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import { repoCtx } from "./git-state.js";
import { gitObjectFormat, gitPreflight } from "./preflight.js";

const exec = promisify(execFile);
const roots: string[] = [];
const skipUnreadableConfig = process.geteuid?.() === undefined || process.geteuid?.() === 0;

async function initRepo(...args: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-object-format-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-q", ...args]);
  return root;
}

afterEach(async () => {
  setGitSpawnObserver(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("ordinary and explicit SHA-1 repositories pass object-format admission", async () => {
  const ordinary = await initRepo();
  expect(await gitObjectFormat(ordinary)).toBe("sha1");
  expect(await gitPreflight(ordinary)).toEqual({ ok: true, kind: "dir" });

  const explicit = await initRepo();
  await exec("git", ["-C", explicit, "config", "core.repositoryFormatVersion", "1"]);
  await exec("git", ["-C", explicit, "config", "extensions.objectFormat", "sha1"]);
  expect(await gitObjectFormat(explicit)).toBe("sha1");
  expect(await gitPreflight(explicit)).toEqual({ ok: true, kind: "dir" });
});

test("SHA-256 is structurally refused before bundle or stash work", async () => {
  const repo = await initRepo("--object-format=sha256");
  const spawns: string[][] = [];
  setGitSpawnObserver((_root, args) => spawns.push([...args]));

  expect(await gitObjectFormat(repo)).toBe("sha256");
  expect(await gitPreflight(repo)).toEqual({
    ok: false,
    kind: "dir",
    structural: true,
    reason: "SHA-256 object format is unsupported — rbox syncs SHA-1 repositories only (convert or exclude this repository)",
  });
  expect(spawns.some((args) => args.includes("bundle") || args.includes("stash"))).toBe(false);
});

test.skipIf(skipUnreadableConfig)(
  "unreadable object-format config is a retryable refusal",
  async () => {
    const repo = await initRepo();
    const config = path.join(repo, ".git", "config");
    const knownCtx = await repoCtx(repo);
    expect(knownCtx).toBeDefined();
    setGitSpawnObserver((_root, args) => {
      if (args.at(-1) === "extensions.objectFormat") chmodSync(config, 0);
    });
    try {
      const result = await gitPreflight(repo, knownCtx);
      expect(result).toEqual({
        ok: false,
        kind: "dir",
        reason: "repository object-format config could not be read — retry after Git configuration is readable",
      });
      expect(result.structural).toBeUndefined();
    } finally {
      await fs.chmod(config, 0o600);
    }
  },
);
