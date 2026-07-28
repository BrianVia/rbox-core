import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSection } from "../types.js";
import {
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  legacyPartitionOwnedByIncomingForTest,
  noDropProof,
  partitionOwnedByIncoming,
  tipOwnedByIncoming,
} from "./reachability.js";
import { setGitSpawnObserver } from "./shared.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};

let tmp: string;
let repo: string;
let priorContentEquivalence: string | undefined;

async function gitAt(dir: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV });
  return result.stdout.toString().trim();
}

async function git(...args: string[]): Promise<string> {
  return gitAt(repo, ...args);
}

async function initRepo(dir = path.join(tmp, "repo")): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await gitAt(dir, "init", "-qb", "main");
  await gitAt(dir, "config", "user.email", "reachability@test.invalid");
  await gitAt(dir, "config", "user.name", "reachability test");
  await gitAt(dir, "config", "gc.auto", "0");
  return dir;
}

async function commit(name: string, contents: string, message = contents.trim()): Promise<string> {
  await fs.writeFile(path.join(repo, name), contents);
  await git("add", "--", name);
  await git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

function section(head: string, refs: Record<string, string>): GitSection {
  return {
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 1,
    head,
    refs,
    refScope: "all",
    generatedAt: "2026-07-13T00:00:00.000Z",
  };
}

beforeEach(async () => {
  priorContentEquivalence = process.env.RBOX_GIT_CONTENT_EQUIV;
  delete process.env.RBOX_GIT_CONTENT_EQUIV;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reachability-"));
  repo = await initRepo();
});

afterEach(async () => {
  if (priorContentEquivalence === undefined) delete process.env.RBOX_GIT_CONTENT_EQUIV;
  else process.env.RBOX_GIT_CONTENT_EQUIV = priorContentEquivalence;
  setGitSpawnObserver(undefined);
  // No subprocess survives its fixture assertion; recursive removal is bounded.
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("incoming ownership roots", () => {
  test("extracts incoming checkout, heads, tags, stash, and commit-bearing op-state only", async () => {
    const oids = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).repeat(40));
    const roots = incomingOwnershipRoots(section("ref: refs/heads/main\n", {
      "refs/heads/main": oids[0]!,
      "refs/heads/side": oids[1]!,
      "refs/tags/release": oids[2]!,
      "refs/stash": oids[3]!,
      "refs/remotes/origin/main": oids[4]!,
      "refs/rbox-local/keep/ignored": oids[5]!,
    }), {
      prefix: "refs/rbox-incoming/episode/",
      opState: {
        MERGE_HEAD: `${oids[6]}\n`,
        "rebase-merge/done": `pick ${oids[7]} message\n`,
        AUTO_MERGE: oids[4]!,
      },
    });

    expect(roots).toEqual([oids[0], oids[1], oids[2], oids[3], oids[6], oids[7]].sort());
  });
});

describe("fail-closed reachability proofs", () => {
  const partitionProofs = async (dir: string, tips: string[], roots: string[]) =>
    (await partitionOwnedByIncoming(dir, tips, roots)).map((entry) => entry.proof);

  test("batched proofs are per-tip equivalent for owned, unowned, and annotated-tag tips", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("tag", "-a", "base-tag", base, "-m", "base tag");
    const tagTip = await git("rev-parse", "refs/tags/base-tag");
    await git("checkout", "-qb", "local", base);
    const local = await commit("local.txt", "local\n");
    const tips = [base, local, tagTip];
    const expected = await legacyPartitionOwnedByIncomingForTest(repo, tips, [incoming]);
    expect(await partitionOwnedByIncoming(repo, tips, [incoming])).toEqual(expected);
  });

  test("duplicate raw tips and distinct tags peeling to one commit retain positional proofs", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("tag", "-a", "tag-one", base, "-m", "one");
    await git("tag", "-a", "tag-two", base, "-m", "two");
    const tagOne = await git("rev-parse", "refs/tags/tag-one");
    const tagTwo = await git("rev-parse", "refs/tags/tag-two");
    const result = await partitionOwnedByIncoming(repo, [base, base, tagOne, tagTwo], [incoming]);
    expect(result.map((entry) => entry.tip)).toEqual([base, base, tagOne, tagTwo]);
    expect(new Set(result.map((entry) => entry.commit))).toEqual(new Set([base]));
    expect(result.map((entry) => entry.proof)).toEqual(Array.from({ length: 4 }, () => ({ status: "owned" })));
  });

  test("a missing tip is independent, while a missing root poisons the whole batch", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("checkout", "-qb", "local", base);
    const local = await commit("local.txt", "local\n");
    const missing = "f".repeat(40);
    const tips = [base, local, missing];
    expect(await partitionOwnedByIncoming(repo, tips, [incoming])).toEqual(
      await legacyPartitionOwnedByIncomingForTest(repo, tips, [incoming]),
    );
    expect(await partitionOwnedByIncoming(repo, [base, local], [missing])).toEqual(
      await legacyPartitionOwnedByIncomingForTest(repo, [base, local], [missing]),
    );
  });

  test("the integrity walk runs before classification and falls back per tip on a missing parent", async () => {
    const parent = await commit("parent.txt", "parent\n");
    const child = await commit("child.txt", "child\n");
    await fs.rm(path.join(repo, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
    const legacy = await tipOwnedByIncoming(repo, child, [child]);
    const commands: string[][] = [];
    setGitSpawnObserver((_root, args) => commands.push([...args]));
    const batched = await partitionProofs(repo, [child], [child]);
    expect(batched).toEqual([legacy]);
    expect(legacy).toEqual({ status: "indeterminate", marker: "missing-object" });
    expect(commands.some((args) => args[0] === "cat-file")).toBe(true);
    expect(commands.filter((args) => args[0] === "rev-list")).toHaveLength(2);
  });

  test("ownership rev-list failure falls back sequentially with exact walk-error markers and peeled commits", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    setGitSpawnObserver((_root, args) => {
      if (args[0] === "rev-list" && args.includes("--stdin") && !args.includes("--quiet")) throw new Error("forced ownership walk failure");
      if (args[0] === "merge-base") throw new Error("forced legacy walk failure");
    });
    const legacy = await tipOwnedByIncoming(repo, base, [incoming]);
    const result = await partitionOwnedByIncoming(repo, [base], [incoming]);
    expect(result).toEqual([{ tip: base, proof: legacy }]);
    expect(legacy).toEqual({ status: "indeterminate", marker: "walk-error" });
  });

  test("ownership rev-list failure preserves peeled commits for fallback-unowned subjects", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "incoming", base);
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("checkout", "-qb", "local", base);
    const local = await commit("local.txt", "local\n");
    const oracle = await legacyPartitionOwnedByIncomingForTest(repo, [local], [incoming]);
    let batchWalkFailures = 0;
    setGitSpawnObserver((_root, args) => {
      if (batchWalkFailures === 0 && args[0] === "rev-list" && args.includes("--stdin") && !args.includes("--quiet")) {
        batchWalkFailures++;
        throw new Error("forced ownership walk failure");
      }
    });
    expect(await partitionOwnedByIncoming(repo, [local], [incoming])).toEqual(oracle);
    expect(oracle).toEqual([{ tip: local, commit: local, proof: { status: "unowned" } }]);
    expect(batchWalkFailures).toBe(1);
  });

  test("a shallow store gives every batched tip the legacy marker", async () => {
    await commit("one.txt", "one\n");
    const sourceTip = await commit("two.txt", "two\n");
    const shallowRepo = path.join(tmp, "partition-shallow");
    await exec("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallowRepo], { env: TEST_GIT_ENV });
    const shallowTip = await gitAt(shallowRepo, "rev-parse", "HEAD");
    expect(shallowTip).toBe(sourceTip);
    expect(await partitionOwnedByIncoming(shallowRepo, [shallowTip], [shallowTip])).toEqual(
      await legacyPartitionOwnedByIncomingForTest(shallowRepo, [shallowTip], [shallowTip]),
    );
  });

  test("batched ownership is a full-entry differential of the legacy oracle across varied topologies", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("tag", "-a", "incoming-tag", incoming, "-m", "incoming tag");
    const incomingTag = await git("rev-parse", "refs/tags/incoming-tag");
    await git("tag", "-a", "base-tag", base, "-m", "base tag");
    const baseTag = await git("rev-parse", "refs/tags/base-tag");
    await git("checkout", "-qb", "local", base);
    const local = await commit("local.txt", "local\n");
    await fs.writeFile(path.join(repo, "local.txt"), "stash work\n");
    await git("stash", "push", "-qm", "differential stash");
    const stash = await git("rev-parse", "refs/stash");
    const missing = "f".repeat(40);
    const cases: Array<{ tips: string[]; roots: string[] }> = [
      { tips: [base, local, base, baseTag], roots: [incoming] },
      { tips: [base, local], roots: [incomingTag] },
      { tips: [base, local, stash], roots: [stash] },
      { tips: [base, local], roots: [] },
      { tips: [base, missing, local], roots: [incoming] },
      { tips: [base, local], roots: [missing] },
    ];
    for (const entry of cases) {
      expect(await partitionOwnedByIncoming(repo, entry.tips, entry.roots)).toEqual(
        await legacyPartitionOwnedByIncomingForTest(repo, entry.tips, entry.roots),
      );
    }

    const shallowRepo = path.join(tmp, "differential-shallow");
    await exec("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallowRepo], { env: TEST_GIT_ENV });
    const shallowTip = await gitAt(shallowRepo, "rev-parse", "HEAD");
    expect(await partitionOwnedByIncoming(shallowRepo, [shallowTip, missing], [shallowTip])).toEqual(
      await legacyPartitionOwnedByIncomingForTest(shallowRepo, [shallowTip, missing], [shallowTip]),
    );

    const corruptRepo = await initRepo(path.join(tmp, "differential-corrupt"));
    repo = corruptRepo;
    const parent = await commit("parent.txt", "parent\n");
    const child = await commit("child.txt", "child\n");
    await fs.rm(path.join(corruptRepo, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
    expect(await partitionOwnedByIncoming(corruptRepo, [child], [child])).toEqual(
      await legacyPartitionOwnedByIncomingForTest(corruptRepo, [child], [child]),
    );
  });

  test("ownership subprocess count is constant for 500 candidates", async () => {
    const base = await commit("base.txt", "base\n");
    const incoming = await commit("incoming.txt", "incoming\n");
    const commands: string[][] = [];
    setGitSpawnObserver((_root, args) => commands.push([...args]));
    const result = await partitionOwnedByIncoming(repo, Array.from({ length: 500 }, () => base), [incoming]);
    expect(result.every((entry) => entry.proof.status === "owned")).toBe(true);
    expect(commands.map((args) => args[0])).toEqual(["rev-parse", "cat-file", "rev-list", "rev-list"]);
    expect(commands).toHaveLength(4);
    expect(commands.some((args) => args[0] === "merge-base")).toBe(false);
  });

  test("detects a receiver-local commit that the planned incoming graph would drop", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "incoming", base);
    const incoming = await commit("incoming.txt", "incoming\n");
    await git("checkout", "-qb", "local", base);
    const localOnly = await commit("local.txt", "local\n");

    expect(await tipOwnedByIncoming(repo, localOnly, [incoming])).toEqual({ status: "unowned" });
    expect(await noDropProof(repo, [incoming], [], [], [localOnly])).toEqual({ status: "would-drop", tip: localOnly });
  });

  test("recognizes a stale receiver branch already contained by incoming", async () => {
    const stale = await commit("base.txt", "base\n");
    const incoming = await commit("later.txt", "later\n");

    expect(await tipOwnedByIncoming(repo, stale, [incoming])).toEqual({ status: "owned" });
    expect(await noDropProof(repo, { "refs/heads/main": incoming }, {}, {}, [stale])).toEqual({ status: "proven" });
  });

  test("proves a three-commit squash by the whole-range verbatim patch-id", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    await commit("one.txt", "one\n");
    await commit("two.txt", "two\n");
    const topic = await commit("three.txt", "three\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");

    expect(await noDropProof(repo, [durable], [], [], [topic])).toEqual({
      status: "proven",
      marker: "content-equivalent",
    });

    // A durable root sitting exactly at the fork point yields an empty
    // base..D range; the probe must move on to the next root, not abort.
    expect(await noDropProof(repo, [base, durable], [], [], [topic])).toEqual({
      status: "proven",
      marker: "content-equivalent",
    });
  });

  test("does not match unmerged, modified-squash, or rebased-but-unmerged work", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    const unrelated = await commit("main.txt", "main\n");
    expect(await noDropProof(repo, [unrelated], [], [], [topic])).toEqual({ status: "would-drop", tip: topic });

    await git("cherry-pick", "-n", topic);
    await fs.appendFile(path.join(repo, "topic.txt"), "modified\n");
    await git("add", "topic.txt");
    await git("commit", "-qm", "modified squash");
    const modified = await git("rev-parse", "HEAD");
    expect(await noDropProof(repo, [modified], [], [], [topic])).toEqual({ status: "would-drop", tip: topic });

    await git("checkout", "-qb", "rebase-topic", base);
    await commit("rebase.txt", "rebased work\n");
    await git("rebase", "main");
    const rebased = await git("rev-parse", "HEAD");
    expect(await noDropProof(repo, [modified], [], [], [rebased])).toEqual({ status: "would-drop", tip: rebased });
  });

  test("--verbatim refuses a whitespace-only near-match that --stable would accept", async () => {
    const base = await commit("code.txt", "root\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("code.txt", "  indented\n");
    await git("checkout", "-q", "main");
    const durable = await commit("code.txt", "    indented\n");

    expect(await noDropProof(repo, [durable], [], [], [topic])).toEqual({ status: "would-drop", tip: topic });
  });

  test("content equivalence reads the literal graph and ignores replacement objects", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    const durable = await commit("main.txt", "main\n");
    const topicTree = await git("rev-parse", `${topic}^{tree}`);
    const replacement = await git("commit-tree", topicTree, "-p", base, "-m", "replacement durable");
    await git("replace", durable, replacement);

    expect(await noDropProof(repo, [durable], [], [], [topic])).toEqual({ status: "would-drop", tip: topic });
  });

  test("pins the known apply-then-revert false positive as content-equivalent", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const squash = await git("rev-parse", "HEAD");
    await git("revert", "--no-edit", squash);
    const durable = await git("rev-parse", "HEAD");

    expect(await noDropProof(repo, [durable], [], [], [topic])).toEqual({
      status: "proven",
      marker: "content-equivalent",
    });
  });

  test("the content-equivalence walk cap preserves would-drop", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");
    expect(await noDropProof(repo, [durable], [], [], [topic], { contentEquivalenceCommitCap: 0 }))
      .toEqual({ status: "would-drop", tip: topic });
  });

  test("probe failures stay would-drop and never manufacture indeterminate", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");
    setGitSpawnObserver((_root, args) => {
      if (args[0] === "diff-tree") throw new Error("forced content-equivalence failure");
    });
    const result = await noDropProof(repo, [durable], [], [], [topic]);
    expect(result).toEqual({ status: "would-drop", tip: topic });
    expect(result.status).not.toBe("indeterminate");
  });

  test("an object disappearing inside the probe stays would-drop", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    const topicBlob = await git("rev-parse", `${topic}:topic.txt`);
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");
    setGitSpawnObserver((_root, args) => {
      if (args[0] !== "diff-tree") return;
      fsSync.rmSync(path.join(repo, ".git", "objects", topicBlob.slice(0, 2), topicBlob.slice(2)));
    });
    const result = await noDropProof(repo, [durable], [], [], [topic]);
    expect(result).toEqual({ status: "would-drop", tip: topic });
    expect(result.status).not.toBe("indeterminate");
  });

  test("RBOX_GIT_CONTENT_EQUIV=0 restores the ancestry-only answer", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");
    process.env.RBOX_GIT_CONTENT_EQUIV = "0";
    expect(await noDropProof(repo, [durable], [], [], [topic])).toEqual({ status: "would-drop", tip: topic });
  });

  test("an immutable (tip,durable-root) cache runs the probe only once", async () => {
    const base = await commit("base.txt", "base\n");
    await git("checkout", "-qb", "topic", base);
    const topic = await commit("topic.txt", "topic\n");
    await git("checkout", "-q", "main");
    await git("merge", "--squash", "topic");
    await git("commit", "-qm", "squash topic");
    const durable = await git("rev-parse", "HEAD");
    const entries = new Map<string, boolean>();
    const cache = {
      get: (tip: string, root: string) => entries.get(`${tip}:${root}`),
      set: (tip: string, root: string, equivalent: boolean) => { entries.set(`${tip}:${root}`, equivalent); },
    };
    let patchIdCalls = 0;
    setGitSpawnObserver((_root, args) => { if (args[0] === "patch-id") patchIdCalls++; });
    const first = await noDropProof(repo, [durable], [], [], [topic], { contentEquivalenceCache: cache });
    const second = await noDropProof(repo, [durable], [], [], [topic], { contentEquivalenceCache: cache });
    expect(first).toEqual({ status: "proven", marker: "content-equivalent" });
    expect(second).toEqual(first);
    expect(patchIdCalls).toBe(2);
  });

  test("explicitly peels annotated tag ownership roots", async () => {
    const stale = await commit("base.txt", "base\n");
    await commit("later.txt", "later\n");
    await git("tag", "-a", "release", "-m", "release");
    const tagObject = await git("rev-parse", "refs/tags/release");
    expect(tagObject).not.toBe(await git("rev-parse", "refs/tags/release^{commit}"));

    expect(await tipOwnedByIncoming(repo, stale, [tagObject])).toEqual({ status: "owned" });
  });

  test("a missing loose object is indeterminate, never unreachable", async () => {
    const base = await commit("base.txt", "base\n");
    const tip = await commit("tip.txt", "tip\n");
    const objectPath = path.join(repo, ".git", "objects", tip.slice(0, 2), tip.slice(2));
    expect(await fs.stat(objectPath)).toBeDefined();
    await fs.rm(objectPath);

    expect(await tipOwnedByIncoming(repo, base, [tip])).toEqual({ status: "indeterminate", marker: "missing-object" });
    expect(await noDropProof(repo, [tip], [], [], [base])).toEqual({ status: "indeterminate", marker: "missing-object" });
  });

  test("a shallow common store has its distinguishing indeterminate marker", async () => {
    await commit("one.txt", "one\n");
    const sourceTip = await commit("two.txt", "two\n");
    const shallow = path.join(tmp, "shallow");
    await exec("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow], { env: TEST_GIT_ENV });
    const shallowTip = await gitAt(shallow, "rev-parse", "HEAD");
    expect(shallowTip).toBe(sourceTip);

    expect(await tipOwnedByIncoming(shallow, shallowTip, [shallowTip])).toEqual({ status: "indeterminate", marker: "shallow-store" });
    expect(await noDropProof(shallow, [shallowTip], [], [], [shallowTip])).toEqual({ status: "indeterminate", marker: "shallow-store" });
  });
});

describe("stash reflog protection", () => {
  test("enumerates reflog-only stash OIDs, not only the current tip", async () => {
    await commit("tracked.txt", "base\n");
    await fs.writeFile(path.join(repo, "tracked.txt"), "first stash\n");
    await git("stash", "push", "-qm", "first");
    const older = await git("rev-parse", "stash@{0}");
    await fs.writeFile(path.join(repo, "tracked.txt"), "second stash\n");
    await git("stash", "push", "-qm", "second");
    const current = await git("rev-parse", "stash@{0}");
    expect(await git("rev-parse", "stash@{1}")).toBe(older);

    const enumerated = await enumerateStashReflogOids(repo);
    expect(enumerated).toContain(current);
    expect(enumerated).toContain(older);
    expect(enumerated).not.toContain("0".repeat(40));
  });
});
