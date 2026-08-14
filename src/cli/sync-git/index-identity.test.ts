import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { indexIdentityV2 } from "./index-identity.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};

let tmp: string;
let repo: string;

async function git(...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", repo, ...args], { env: TEST_GIT_ENV });
  return result.stdout.toString().trim();
}

async function initRepo(): Promise<void> {
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git("init", "-qb", "main");
  await git("config", "user.email", "index@test.invalid");
  await git("config", "user.name", "index test");
  await git("config", "gc.auto", "0");
}

async function commitFile(name: string, contents: string): Promise<void> {
  const target = path.join(repo, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  await git("add", "--", name);
  await git("commit", "-qm", `add ${name}`);
}

async function indexPath(): Promise<string> {
  const value = await git("rev-parse", "--git-path", "index");
  return path.isAbsolute(value) ? value : path.join(repo, value);
}

async function identity(): Promise<string> {
  const result = await indexIdentityV2(repo, await indexPath());
  expect(result).toMatch(/^v2:[0-9a-f]{64}$/);
  return result!;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-index-identity-"));
  await initRepo();
});

afterEach(async () => {
  // Every Git child is awaited above, so teardown cannot race an index reader.
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("indexIdentityV2", () => {
  test("projects staged object IDs and executable modes", async () => {
    await commitFile("tracked.txt", "one\n");
    const committed = await identity();

    await fs.writeFile(path.join(repo, "tracked.txt"), "two\n");
    await git("add", "tracked.txt");
    const changedOid = await identity();
    expect(changedOid).not.toBe(committed);

    await git("update-index", "--chmod=+x", "tracked.txt");
    const changedMode = await identity();
    expect(changedMode).not.toBe(changedOid);
    expect(await git("ls-files", "--stage", "tracked.txt")).toMatch(/^100755 [0-9a-f]{40} 0\ttracked\.txt$/);
  });

  test("projects every conflict stage and changes after resolution", async () => {
    await commitFile("conflict.txt", "base\n");
    await git("checkout", "-qb", "other");
    await fs.writeFile(path.join(repo, "conflict.txt"), "other\n");
    await git("commit", "-qam", "other side");
    await git("checkout", "-q", "main");
    await fs.writeFile(path.join(repo, "conflict.txt"), "main\n");
    await git("commit", "-qam", "main side");
    await exec("git", ["-C", repo, "merge", "other"], { env: TEST_GIT_ENV }).catch(() => undefined);

    const stages = (await git("ls-files", "--unmerged", "conflict.txt")).split("\n");
    expect(stages).toHaveLength(3);
    expect(stages.map((line) => line.split(/\s+/)[2])).toEqual(["1", "2", "3"]);
    const conflicted = await identity();

    await fs.writeFile(path.join(repo, "conflict.txt"), "resolved\n");
    await git("add", "conflict.txt");
    expect(await identity()).not.toBe(conflicted);
  });

  test("distinguishes intent-to-add from a normally staged empty file", async () => {
    await commitFile("base.txt", "base\n");
    await fs.writeFile(path.join(repo, "empty.txt"), "");
    await git("add", "-N", "empty.txt");
    const intentToAdd = await identity();

    await git("add", "empty.txt");
    const staged = await identity();
    expect(staged).not.toBe(intentToAdd);
  });

  test("projects assume-unchanged and skip-worktree flags", async () => {
    await commitFile("assume.txt", "assume\n");
    await commitFile("skip.txt", "skip\n");
    const ordinary = await identity();

    await git("update-index", "--assume-unchanged", "assume.txt");
    const assumed = await identity();
    expect(assumed).not.toBe(ordinary);
    await git("update-index", "--no-assume-unchanged", "assume.txt");
    expect(await identity()).toBe(ordinary);

    await git("update-index", "--skip-worktree", "skip.txt");
    expect(await identity()).not.toBe(ordinary);
  });

  test("ignores a benign stat refresh caused by touch plus git status", async () => {
    await commitFile("refresh.txt", "unchanged\n");
    const before = await identity();
    const target = path.join(repo, "refresh.txt");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(target, future, future);
    expect(await git("status", "--porcelain")).toBe("");
    expect(await identity()).toBe(before);
  });

  test("ignores raw index encoding changes with identical semantics", async () => {
    await commitFile("prefix/alpha.txt", "alpha\n");
    await commitFile("prefix/alpine.txt", "alpine\n");
    await git("update-index", "--index-version=2");
    const index = await indexPath();
    const bytesV2 = await fs.readFile(index);
    const semanticV2 = await identity();

    await git("update-index", "--index-version=4");
    const bytesV4 = await fs.readFile(index);
    expect(bytesV4.equals(bytesV2)).toBe(false);
    expect(bytesV4.readUInt32BE(4)).toBe(4);
    expect(await identity()).toBe(semanticV2);
  });

  test("returns undefined when any projection probe cannot read an index", async () => {
    expect(await indexIdentityV2(repo, path.join(repo, "missing-index"))).toBeUndefined();
  });
});
