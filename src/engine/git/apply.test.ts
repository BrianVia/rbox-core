import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyGitState, captureGitState, gitIdentity, LocalBlobStore, type GitSection } from "../index.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());
const KEK = Buffer.alloc(32, 116);

let tmp: string;
let store: LocalBlobStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d116-apply-"));
  store = new LocalBlobStore(path.join(tmp, "store"));
});

afterEach(async () => {
  // Every git child above is awaited; removal therefore cannot race a live worktree command.
  await fs.rm(tmp, { recursive: true, force: true });
});

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
}

async function commit(dir: string, file: string, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  await git(dir, "commit", "-qm", message);
}

async function capture(repo: string): Promise<GitSection> {
  const section = await captureGitState(repo, store, KEK);
  expect(section).toBeDefined();
  return section!;
}

async function incidentBaseline(): Promise<{ sender: string; receiver: string; sideOid: string }> {
  const sender = path.join(tmp, "sender");
  const receiver = path.join(tmp, "receiver");
  await initRepo(sender);
  await commit(sender, "base.txt", "base", "base");
  await git(sender, "branch", "side");
  const sideOid = await git(sender, "rev-parse", "side");
  expect((await applyGitState(receiver, await capture(sender), store, KEK)).applied).toBe(true);
  return { sender, receiver, sideOid };
}

test("design 116 phase-0: identical-OID sibling branch is a no-op and main/HEAD follow", async () => {
  const { sender, receiver, sideOid } = await incidentBaseline();
  const worktree = path.join(tmp, "incident-side");
  await git(receiver, "worktree", "add", worktree, "side");
  await git(receiver, "checkout", "-q", "--detach"); // field shape: checkout must move too
  await commit(sender, "main.txt", "incoming", "advance main");
  const incoming = await capture(sender);

  const result = await applyGitState(receiver, incoming, store, KEK);

  expect(result.applied).toBe(true);
  expect(result.heldRefs).toBeUndefined();
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "main")).toBe(incoming.refs["refs/heads/main"]);
  expect(await git(receiver, "rev-parse", "side")).toBe(sideOid);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(sideOid);
  expect((await gitIdentity(receiver))!.indexTree).toBe(incoming.indexTree);
});

test("design 116 phase-0: diverged sibling branch is held while main/HEAD/index follow", async () => {
  const { sender, receiver, sideOid } = await incidentBaseline();
  const worktree = path.join(tmp, "held-side");
  await git(receiver, "worktree", "add", worktree, "side");
  await git(sender, "checkout", "-q", "side");
  await commit(sender, "side.txt", "incoming side", "advance side");
  const incomingSide = await git(sender, "rev-parse", "side");
  await git(sender, "checkout", "-q", "main");
  await commit(sender, "main.txt", "incoming main", "advance main");
  const incoming = await capture(sender);

  const result = await applyGitState(receiver, incoming, store, KEK);

  expect(result.applied).toBe(true);
  expect(result.heldRefs).toEqual({ "refs/heads/side": path.basename(worktree) });
  expect(await git(receiver, "rev-parse", "main")).toBe(incoming.refs["refs/heads/main"]);
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect((await gitIdentity(receiver))!.indexTree).toBe(incoming.indexTree);
  expect(await git(receiver, "rev-parse", "side")).toBe(sideOid);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(sideOid);
  expect(incomingSide).not.toBe(sideOid);
});

test("design 116 phase-0: all-scope deletion holds an absent sibling branch but deletes other absent refs", async () => {
  const { sender, receiver, sideOid } = await incidentBaseline();
  await git(sender, "branch", "junk");
  // Re-seed both receiver refs before making them absent from the next all-scope section.
  expect((await applyGitState(receiver, await capture(sender), store, KEK)).applied).toBe(true);
  const worktree = path.join(tmp, "delete-held-side");
  await git(receiver, "worktree", "add", worktree, "side");
  await git(sender, "branch", "-D", "side", "junk");

  const result = await applyGitState(receiver, await capture(sender), store, KEK);

  expect(result.applied).toBe(true);
  expect(result.heldRefs).toEqual({ "refs/heads/side": path.basename(worktree) });
  expect(await git(receiver, "rev-parse", "side")).toBe(sideOid);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(sideOid);
  await expect(git(receiver, "rev-parse", "--verify", "junk")).rejects.toThrow();
});

test("design 116 phase-0: incoming HEAD owned by a sibling defers even at identical OID", async () => {
  const { sender, receiver } = await incidentBaseline();
  const worktree = path.join(tmp, "head-owned-side");
  await git(receiver, "worktree", "add", worktree, "side");
  await git(sender, "checkout", "-q", "side");
  const mainBefore = await git(receiver, "rev-parse", "main");

  const result = await applyGitState(receiver, await capture(sender), store, KEK);

  expect(result.applied).toBe(false);
  expect(result.reason).toContain("worktree-ownership");
  expect(result.reason).toContain(path.basename(worktree));
  expect(await git(receiver, "rev-parse", "main")).toBe(mainBefore);
});

test("design 116 phase-0: clean-materialization wipe still defers for a sibling-owned branch", async () => {
  const { sender, receiver } = await incidentBaseline();
  const worktree = path.join(tmp, "wipe-owned-side");
  await git(receiver, "worktree", "add", worktree, "side");
  let hookRan = false;

  const result = await applyGitState(receiver, await capture(sender), store, KEK, {
    beforeMutateWipesRefs: true,
    beforeMutate: async () => {
      hookRan = true;
    },
  });

  expect(result.applied).toBe(false);
  expect(result.reason).toContain("worktree-ownership");
  expect(result.reason).toContain("would be wiped");
  expect(hookRan).toBe(false);
});

test("design 116 phase-0: pointer publish to an identical sibling-owned OID is not filtered", async () => {
  const main = path.join(tmp, "main");
  const pointer = path.join(tmp, "pointer");
  await initRepo(main);
  await commit(main, "base.txt", "base", "base");
  await git(main, "worktree", "add", pointer, "-b", "feat");

  const standalone = path.join(tmp, "standalone");
  expect((await applyGitState(standalone, await capture(pointer), store, KEK)).applied).toBe(true);
  await git(standalone, "branch", "main", await git(main, "rev-parse", "main"));
  const incoming = await capture(standalone);

  const result = await applyGitState(pointer, incoming, store, KEK);

  expect(result.applied).toBe(true);
  expect(result.filteredRefs).toBeUndefined();
  expect(await git(main, "rev-parse", "main")).toBe(incoming.refs["refs/heads/main"]);
});
