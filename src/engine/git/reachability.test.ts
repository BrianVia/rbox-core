import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSection } from "../types.js";
import {
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  noDropProof,
  tipOwnedByIncoming,
} from "./reachability.js";

const exec = promisify(execFile);

let tmp: string;
let repo: string;

async function gitAt(dir: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", dir, ...args]);
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reachability-"));
  repo = await initRepo();
});

afterEach(async () => {
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
    await exec("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
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
