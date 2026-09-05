import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import {
  legacyNoDropProofForTest,
  noDropProof,
  type ContentEquivalenceCache,
  type NoDropProofOptions,
} from "./reachability.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "no-drop test",
  GIT_AUTHOR_EMAIL: "no-drop@test.invalid",
  GIT_COMMITTER_NAME: "no-drop test",
  GIT_COMMITTER_EMAIL: "no-drop@test.invalid",
};

let tmp: string;
let repo: string;
let priorContentEquivalence: string | undefined;

async function gitAt(dir: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", dir, ...args], { env: GIT_ENV })).stdout.toString().trim();
}

async function git(...args: string[]): Promise<string> {
  return gitAt(repo, ...args);
}

async function initRepo(dir = path.join(tmp, "repo")): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await gitAt(dir, "init", "-qb", "main");
  await gitAt(dir, "config", "user.name", "no-drop test");
  await gitAt(dir, "config", "user.email", "no-drop@test.invalid");
  await gitAt(dir, "config", "gc.auto", "0");
  return dir;
}

async function commit(name: string, contents: string, message = contents.trim()): Promise<string> {
  await fs.writeFile(path.join(repo, name), contents);
  await git("add", "--", name);
  await git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

async function compare(
  planned: Readonly<Record<string, string>> | readonly string[],
  held: Readonly<Record<string, string>> | readonly string[],
  pins: Readonly<Record<string, string>> | readonly string[],
  tips: readonly string[],
  options: NoDropProofOptions = {},
): Promise<void> {
  const expected = await legacyNoDropProofForTest(repo, planned, held, pins, tips, options);
  expect(await noDropProof(repo, planned, held, pins, tips, options)).toEqual(expected);
}

beforeEach(async () => {
  priorContentEquivalence = process.env.RBOX_GIT_CONTENT_EQUIV;
  delete process.env.RBOX_GIT_CONTENT_EQUIV;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-nodrop-batch-"));
  repo = await initRepo();
});

afterEach(async () => {
  setGitSpawnObserver(undefined);
  if (priorContentEquivalence === undefined) delete process.env.RBOX_GIT_CONTENT_EQUIV;
  else process.env.RBOX_GIT_CONTENT_EQUIV = priorContentEquivalence;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("batched no-drop differential", () => {
  test("owned, unowned, duplicate, identical, and empty positional inputs equal the oracle", async () => {
    const base = await commit("base.txt", "base\n");
    const durable = await commit("durable.txt", "durable\n");
    await git("checkout", "-qb", "local", base);
    const local = await commit("local.txt", "local\n");

    await compare([durable], [], [], [base]);
    await compare([durable], [], [], [local]);
    await compare([durable], [], [], [base, base]);
    await compare([durable, durable], [], [], [base]);
    await compare([durable], [], [], [durable]);
    await compare([durable], [], [], []);
    await compare([], [], [], [local]);
  });

  test("annotated tag tips and roots equal the oracle", async () => {
    const base = await commit("base.txt", "base\n");
    const durable = await commit("durable.txt", "durable\n");
    await git("tag", "-a", "base-tag", base, "-m", "base tag");
    await git("tag", "-a", "durable-tag", durable, "-m", "durable tag");
    await compare([await git("rev-parse", "durable-tag")], [], [], [await git("rev-parse", "base-tag")]);
  });

  test("missing root and missing tip objects equal oracle marker precedence", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "local", base);
    const tip = await commit("tip.txt", "tip\n");
    await git("checkout", "-q", "main");
    const durable = await commit("durable.txt", "durable\n");
    const missing = "f".repeat(40);
    await compare([missing], [], [], [tip, missing]);
    expect(await noDropProof(repo, [missing], [], [], [tip, missing])).toEqual({ status: "indeterminate", marker: "missing-object" });
    process.env.RBOX_GIT_CONTENT_EQUIV = "0";
    await compare([durable], [], [], [tip, missing]);
    expect(await noDropProof(repo, [durable], [], [], [tip, missing])).toEqual({ status: "indeterminate", marker: "missing-object" });
  });

  test("a real corrupt object preserves Git exit-128 missing-object semantics", async () => {
    const parent = await commit("parent.txt", "parent\n");
    const tip = await commit("tip.txt", "tip\n");
    const objectPath = path.join(repo, ".git", "objects", parent.slice(0, 2), parent.slice(2));
    await fs.chmod(objectPath, 0o600);
    await fs.writeFile(objectPath, "corrupt");
    await compare([tip], [], [], [tip]);
    expect(await noDropProof(repo, [tip], [], [], [tip])).toEqual({ status: "indeterminate", marker: "missing-object" });
  });

  test("a non-exit ancestry walk failure remains walk-error", async () => {
    const tip = await commit("tip.txt", "tip\n");
    setGitSpawnObserver((_root, args) => {
      if (args[0] === "rev-list") throw new Error("corrupt walk fixture");
    });
    await compare([tip], [], [], [tip]);
    expect(await noDropProof(repo, [tip], [], [], [tip])).toEqual({ status: "indeterminate", marker: "walk-error" });
  });

  test("a shallow clone and supplied shallow evidence equal the oracle", async () => {
    await commit("one.txt", "one\n");
    await commit("two.txt", "two\n");
    const shallowRepo = path.join(tmp, "shallow");
    await exec("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallowRepo], { env: GIT_ENV });
    repo = shallowRepo;
    const tip = await git("rev-parse", "HEAD");
    await compare([tip], [], [], [tip]);
    await compare([tip], [], [], [tip], { ownershipContext: { shallow: true } });
    await compare([tip], [], [], [], { ownershipContext: { shallow: true } });
    expect(await noDropProof(repo, [tip], [], [], [], { ownershipContext: { shallow: true } })).toEqual({
      status: "indeterminate",
      marker: "shallow-store",
    });
  });

  test("a missing durable root remains missing-object with no protected tips", async () => {
    const missing = "f".repeat(40);
    await compare([missing], [], [], []);
    expect(await noDropProof(repo, [missing], [], [], [])).toEqual({ status: "indeterminate", marker: "missing-object" });
  });

  test("content-equivalent squash matches with and without the disable switch", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("cherry-pick", "-n", topic);
    await git("commit", "-qm", "same patch, distinct commit");
    const durable = await git("rev-parse", "HEAD");
    await compare([durable], [], [], [topic]);
    process.env.RBOX_GIT_CONTENT_EQUIV = "0";
    await compare([durable], [], [], [topic]);
  });

  test("content equivalence cap and cache hit equal the oracle", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("cherry-pick", "-n", topic);
    await git("commit", "-qm", "durable equivalent");
    const durable = await git("rev-parse", "HEAD");
    await compare([durable], [], [], [topic], { contentEquivalenceCommitCap: 0 });

    const cache: ContentEquivalenceCache = {
      get: (tip, root) => tip === topic && root === durable ? true : undefined,
      set: () => undefined,
    };
    let patchIdCalls = 0;
    setGitSpawnObserver((_root, args) => { if (args[0] === "patch-id") patchIdCalls++; });
    await compare([durable], [], [], [topic], { contentEquivalenceCache: cache });
    expect(patchIdCalls).toBe(0);
  });

  test("30 tips use the same constant spawn count as 3 and fewer than the oracle", async () => {
    const base = await commit("base.txt", "base\n");
    const roots: string[] = [];
    for (let index = 0; index < 4; index++) {
      await git("checkout", "-qB", `root-${index}`, base);
      roots.push(await commit(`root-${index}.txt`, `${index}\n`));
    }
    await git("checkout", "-qB", "tip", base);
    const tip = await commit("tip.txt", "tip\n");
    roots.push(tip);

    const count = async (run: () => Promise<unknown>): Promise<number> => {
      let spawns = 0;
      setGitSpawnObserver(() => { spawns++; });
      await run();
      setGitSpawnObserver(undefined);
      return spawns;
    };
    const three = await count(() => noDropProof(repo, roots, [], [], Array.from({ length: 3 }, () => tip)));
    const thirty = await count(() => noDropProof(repo, roots, [], [], Array.from({ length: 30 }, () => tip)));
    const legacy = await count(() => legacyNoDropProofForTest(repo, roots, [], [], Array.from({ length: 30 }, () => tip)));
    expect(thirty).toBe(three);
    expect(thirty).toBeLessThan(legacy);
  });
});
