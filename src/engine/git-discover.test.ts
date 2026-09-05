import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "./ignore.js";
import { discoverGitRepos, discoverGitReposUnder } from "./git-discover.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.chmod(path.join(root, "locked"), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-discover-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "a", ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "b", "nested", ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "locked", "hidden", ".git"), { recursive: true });
  return root;
}

test("design 307: a complete walk reports no faults and every repo", async () => {
  const root = await fixture();
  const faults: string[] = [];
  const repos = await discoverGitRepos(root, await buildIgnoreMatcher(root), (rel) => faults.push(rel));
  expect(faults).toEqual([]);
  expect(repos.map((repo) => repo.relPath)).toEqual(["a", "b/nested", "locked/hidden"]);
});

test("design 307: an unreadable directory is reported by relPath and the rest is still returned", async () => {
  if (process.getuid?.() === 0) return; // root ignores modes
  const root = await fixture();
  await fs.chmod(path.join(root, "locked"), 0o000);
  const faults: string[] = [];
  const repos = await discoverGitRepos(root, await buildIgnoreMatcher(root), (rel) => faults.push(rel));
  expect(faults).toEqual(["locked"]);
  expect(repos.map((repo) => repo.relPath)).toEqual(["a", "b/nested"]);
  const under: string[] = [];
  expect(await discoverGitReposUnder(root, "locked", await buildIgnoreMatcher(root), (rel) => under.push(rel))).toEqual([]);
  expect(under).toEqual(["locked"]);
});
