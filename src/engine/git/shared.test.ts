import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanGitEnv, gitBusy, gitRaw, readLocalGitConfigEntries, setGitSpawnObserver, type RepoCtx } from "./shared.js";
import { gitPreflight, gitRefStorage } from "./preflight.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-shared-"));
  roots.push(root);
  return root;
}

async function initRepo(): Promise<string> {
  const root = await tempDir();
  await exec("git", ["-C", root, "init", "-q"], { env: TEST_GIT_ENV });
  return root;
}

afterEach(async () => {
  setGitSpawnObserver(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("gitRaw feeds stdin, streams stdout without returning it, and retains observer notification", async () => {
  const repo = await initRepo();
  await exec("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "subject"], { env: TEST_GIT_ENV });
  const oid = (await exec("git", ["-C", repo, "rev-parse", "HEAD"], { env: TEST_GIT_ENV })).stdout.toString().trim();
  const observed: string[][] = [];
  const chunks: string[] = [];
  setGitSpawnObserver((_root, args) => observed.push([...args]));
  const returned = await gitRaw(repo, ["rev-list", "--stdin"], {
    stdin: `${oid}\n`,
    onStdoutChunk: (chunk) => chunks.push(chunk),
  });
  expect(returned).toBe("");
  expect(chunks.join("").trim()).toBe(oid);
  expect(observed).toEqual([["rev-list", "--stdin"]]);
});

test("cleanGitEnv supplies reflog identity fallbacks without replacing caller identity", () => {
  const env = cleanGitEnv();
  expect(env.GIT_AUTHOR_NAME).toBe(process.env.GIT_AUTHOR_NAME ?? "rbox");
  expect(env.GIT_AUTHOR_EMAIL).toBe(process.env.GIT_AUTHOR_EMAIL ?? "rbox@local");
  expect(env.GIT_COMMITTER_NAME).toBe(process.env.GIT_COMMITTER_NAME ?? "rbox");
  expect(env.GIT_COMMITTER_EMAIL).toBe(process.env.GIT_COMMITTER_EMAIL ?? "rbox@local");
  expect(cleanGitEnv({ GIT_COMMITTER_NAME: "fixture caller" }).GIT_COMMITTER_NAME).toBe("fixture caller");
});

describe("raw NUL-delimited local config reads", () => {
  test("gitRaw preserves stdout whitespace, including a successful empty value", async () => {
    const repo = await initRepo();
    await exec("git", ["-C", repo, "config", "remote.origin.url", ""], { env: TEST_GIT_ENV });
    expect(await gitRaw(repo, ["config", "--local", "--get", "remote.origin.url"])).toBe("\n");
  });

  test("readLocalGitConfigEntries preserves order, empty strings, and embedded newlines", async () => {
    const repo = await initRepo();
    await exec("git", ["-C", repo, "config", "remote.origin.url", ""], { env: TEST_GIT_ENV });
    await exec("git", ["-C", repo, "config", "--add", "remote.origin.url", "line1\nline2"], { env: TEST_GIT_ENV });
    await exec("git", ["-C", repo, "config", "branch.main.rebase", "false"], { env: TEST_GIT_ENV });
    expect(await readLocalGitConfigEntries(repo)).toEqual([
      ["remote.origin.url", ""],
      ["remote.origin.url", "line1\nline2"],
      ["branch.main.rebase", "false"],
    ]);
  });

  test("exit 1 means no matching keys, while a true Git failure rejects", async () => {
    const repo = await initRepo();
    expect(await readLocalGitConfigEntries(repo)).toEqual([]);
    const notRepo = await tempDir();
    await expect(readLocalGitConfigEntries(notRepo)).rejects.toThrow();
  });

  test("does not follow include.path out of the common local config", async () => {
    const repo = await initRepo();
    const included = path.join(await tempDir(), "included.config");
    await fs.writeFile(included, '[remote "included"]\n\turl = https://included.example/repo\n');
    await exec("git", ["-C", repo, "config", "include.path", included], { env: TEST_GIT_ENV });
    await exec("git", ["-C", repo, "config", "remote.local.url", "https://local.example/repo"], { env: TEST_GIT_ENV });
    expect(await readLocalGitConfigEntries(repo)).toEqual([
      ["remote.local.url", "https://local.example/repo"],
    ]);
  });
});

describe("gitBusy common-config lock", () => {
  test("config.lock in the common dir marks both dir and pointer shapes busy", async () => {
    const root = await tempDir();
    const gitDir = path.join(root, "worktree-gitdir");
    const commonDir = path.join(root, "common.git");
    await fs.mkdir(path.join(commonDir, "refs"), { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    const ctx: RepoCtx = { repoDir: root, kind: "pointer", gitDir, commonDir };
    expect(await gitBusy(ctx)).toBe(false);
    await fs.writeFile(path.join(commonDir, "config.lock"), "held");
    expect(await gitBusy(ctx)).toBe(true);
  });

  test("a pointer worktree-local config.lock is not mistaken for the common config lock", async () => {
    const root = await tempDir();
    const gitDir = path.join(root, "worktree-gitdir");
    const commonDir = path.join(root, "common.git");
    await fs.mkdir(path.join(commonDir, "refs"), { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "config.lock"), "not-the-common-config");
    const ctx: RepoCtx = { repoDir: root, kind: "pointer", gitDir, commonDir };
    expect(await gitBusy(ctx)).toBe(false);
  });

  test("packed-refs.lock in the common dir marks every worktree busy", async () => {
    const root = await tempDir();
    const gitDir = path.join(root, "worktree-gitdir");
    const commonDir = path.join(root, "common.git");
    await fs.mkdir(path.join(commonDir, "refs"), { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    const ctx: RepoCtx = { repoDir: root, kind: "pointer", gitDir, commonDir };
    await fs.writeFile(path.join(commonDir, "packed-refs.lock"), "held");
    expect(await gitBusy(ctx)).toBe(true);
  });
});

test("reftable refusal uses extensions.refStorage config authority and a teachable structural result", async () => {
  const root = await tempDir();
  await exec("git", ["-C", root, "init", "--ref-format=reftable", "-q"], { env: TEST_GIT_ENV });
  expect(await gitRefStorage(root)).toBe("reftable");
  expect((await fs.lstat(path.join(root, ".git", "refs", "heads"))).isFile()).toBe(true); // layout is not authority
  expect(await gitPreflight(root)).toEqual(expect.objectContaining({
    ok: false,
    kind: "dir",
    structural: true,
    reason: expect.stringMatching(/reftable.*unsupported.*convert/i),
  }));
});
