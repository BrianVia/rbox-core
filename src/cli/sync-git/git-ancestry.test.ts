import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../../engine/git-spawn.js";
import { gitCommitAncestry } from "./git-ancestry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; ancestor: string; descendant: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-ancestry-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "ancestor");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "ancestor"]);
  const ancestor = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "f"), "descendant");
  await git(root, ["commit", "-am", "descendant"]);
  const descendant = await git(root, ["rev-parse", "HEAD"]);
  return { root, ancestor, descendant };
}

test("classifies equal, ancestor, and not-ancestor commits", async () => {
  const { root, ancestor, descendant } = await fixture();
  expect(await gitCommitAncestry(root, ancestor, ancestor)).toBe("equal");
  expect(await gitCommitAncestry(root, ancestor, descendant)).toBe("ancestor");
  expect(await gitCommitAncestry(root, descendant, ancestor)).toBe("not-ancestor");
});

test("throws when commit ancestry is indeterminate", async () => {
  const { root, descendant } = await fixture();
  await expect(gitCommitAncestry(root, "f".repeat(40), descendant)).rejects.toThrow();
});
