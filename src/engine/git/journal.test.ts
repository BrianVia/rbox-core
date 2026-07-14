import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hashBytes } from "../hash.js";
import type { GitSection } from "../types.js";
import {
  checkoutJournalDir,
  markCheckoutJournalPublished,
  recoverJournal,
  writeCheckoutJournal,
  type CheckoutJournal,
  type CheckoutJournalBinding,
} from "./journal.js";

const exec = promisify(execFile);
const runGit = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.toString().trim());
const ZERO_SHA = "0".repeat(64);

let root: string;
let repo: string;
let gitDir: string;
let binding: CheckoutJournalBinding;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d116-journal-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await runGit(repo, "init", "-qb", "main");
  await runGit(repo, "config", "user.email", "test@example.com");
  await runGit(repo, "config", "user.name", "Test User");
  gitDir = await fs.realpath(path.join(repo, ".git"));
  binding = {
    stream: "stream-a",
    stateNonce: "nonce-a",
    gitDirReal: gitDir,
    commonDirReal: gitDir,
    worktreeId: await fs.realpath(repo),
  };
});

afterEach(async () => {
  // Every fixture subprocess is awaited, so recursive cleanup cannot race Git.
  await fs.rm(root, { recursive: true, force: true });
});

async function commit(contents: string): Promise<string> {
  await fs.writeFile(path.join(repo, "file.txt"), contents);
  await runGit(repo, "add", "file.txt");
  await runGit(repo, "commit", "-qm", contents.trim());
  return runGit(repo, "rev-parse", "HEAD");
}

async function history(): Promise<{ oldOid: string; newOid: string; thirdOid: string }> {
  const oldOid = await commit("old\n");
  const newOid = await commit("new\n");
  const thirdOid = await commit("third\n");
  await runGit(repo, "reset", "--hard", oldOid);
  return { oldOid, newOid, thirdOid };
}

async function privateIndexFor(oid: string, name: string): Promise<Buffer> {
  const index = path.join(gitDir, "index");
  const candidate = path.join(root, name);
  await fs.copyFile(index, candidate);
  await exec("git", ["-C", repo, "read-tree", oid], {
    env: { ...process.env, GIT_INDEX_FILE: candidate },
  });
  return fs.readFile(candidate);
}

function incoming(head: string, refs: Record<string, string>): GitSection {
  return {
    bundleSha: ZERO_SHA,
    bundleEncSha: ZERO_SHA,
    bundleCipherSize: 0,
    head,
    refs,
    refScope: "all",
    generatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function makeJournal<T>(args: {
  oldOid?: string;
  oldHead: string;
  expectedHead: string;
  expectedRefs?: Record<string, string>;
  expectedIndex?: Buffer;
  oldOp?: Record<string, true>;
  expectedOp?: Record<string, string | null>;
  preWipeRefs?: Record<string, string>;
  intended: T;
  createdFresh?: boolean;
}): CheckoutJournal<T> {
  return {
    phase: "intent",
    incomingKey: "incoming-key-1",
    incomingSection: incoming(args.expectedHead, args.expectedRefs ?? {}),
    old: {
      currentRefName: args.oldOid ? "refs/heads/main" : undefined,
      currentRefOid: args.oldOid,
      headContent: args.oldHead,
      indexPresent: !args.createdFresh,
      opState: args.oldOp ?? {},
      preWipeRefs: args.preWipeRefs,
    },
    expectedNew: {
      indexHash: args.expectedIndex ? hashBytes(args.expectedIndex) : undefined,
      opState: args.expectedOp ?? {},
      refs: args.expectedRefs ?? {},
      head: args.expectedHead,
    },
    binding,
    createdFresh: args.createdFresh ?? false,
    intended: args.intended,
  };
}

test("intent recovery restores exact index, nested op-state, attached ref/HEAD, and wiped refs", async () => {
  const { oldOid, newOid } = await history();
  await runGit(repo, "tag", "pre-wipe", oldOid);
  const oldIndex = await fs.readFile(path.join(gitDir, "index"));
  const candidateIndex = await privateIndexFor(newOid, "candidate-index");
  const oldTodo = Buffer.from("pick old-op\n");
  const newTodo = Buffer.from("pick expected-new-op\n");
  const newMergeHead = Buffer.from(`${newOid}\n`);
  await fs.mkdir(path.join(gitDir, "rebase-merge"), { recursive: true });
  await fs.writeFile(path.join(gitDir, "rebase-merge", "git-rebase-todo"), oldTodo);
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const intended = { record: { opaque: true }, expectedRepoGen: 7, relPath: "repo" };
  const journal = makeJournal({
    oldOid,
    oldHead,
    expectedHead: oldHead,
    expectedRefs: { "refs/heads/main": newOid },
    expectedIndex: candidateIndex,
    oldOp: { "rebase-merge/git-rebase-todo": true },
    expectedOp: {
      "rebase-merge/git-rebase-todo": hashBytes(newTodo),
      MERGE_HEAD: hashBytes(newMergeHead),
    },
    preWipeRefs: { "refs/tags/pre-wipe": oldOid },
    intended,
  });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });

  // Model every separately published checkout field in the intent crash window.
  await fs.writeFile(path.join(gitDir, "index"), candidateIndex);
  await fs.writeFile(path.join(gitDir, "rebase-merge", "git-rebase-todo"), newTodo);
  await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), newMergeHead);
  await runGit(repo, "update-ref", "refs/heads/main", newOid, oldOid);
  await runGit(repo, "update-ref", "-d", "refs/tags/pre-wipe", oldOid);

  expect(await recoverJournal(root, "repo", binding)).toEqual({ status: "rolled-back" });
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(oldIndex);
  expect(await fs.readFile(path.join(gitDir, "rebase-merge", "git-rebase-todo"))).toEqual(oldTodo);
  await expect(fs.access(path.join(gitDir, "MERGE_HEAD"))).rejects.toThrow();
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  expect(await runGit(repo, "rev-parse", "refs/tags/pre-wipe")).toBe(oldOid);
  expect(await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).toBe(oldHead);
  await expect(fs.access(checkoutJournalDir(root, "repo"))).rejects.toThrow();
});

test("intent recovery restores an attached branch switch and removes the newly-created branch", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const expectedHead = "ref: refs/heads/incoming\n";
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead, expectedRefs: { "refs/heads/incoming": newOid }, expectedIndex: index, intended: "switch" });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });

  await runGit(repo, "update-ref", "refs/heads/incoming", newOid);
  await fs.writeFile(path.join(gitDir, "HEAD"), expectedHead);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  expect(await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).toBe(oldHead);
  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  await expect(runGit(repo, "rev-parse", "--verify", "refs/heads/incoming")).rejects.toThrow();
});

test("intent recovery uses exact prepared-lock shape in the prepare-to-token journal window", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex: index, intended: "prepare-window" });
  const refLock = path.join(gitDir, "refs/heads/main.lock");
  const headLock = path.join(gitDir, "HEAD.lock");
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: 1234,
    prepareStarted: true,
    locks: [
      { path: refLock, expectedBytes: [Buffer.from(`${newOid}\n`).toString("base64")] },
      { path: headLock, expectedBytes: [Buffer.alloc(0).toString("base64")] },
    ],
  }];
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await fs.mkdir(path.dirname(refLock), { recursive: true });
  await fs.writeFile(refLock, `${newOid}\n`);
  await fs.writeFile(headLock, "");

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  await expect(fs.access(refLock)).rejects.toThrow();
  await expect(fs.access(headLock)).rejects.toThrow();
});

test("intent recovery preserves detached HEAD form", async () => {
  const { oldOid, newOid } = await history();
  await runGit(repo, "checkout", "-q", "--detach", oldOid);
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const expectedHead = `${newOid}\n`;
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldHead, expectedHead, expectedIndex: index, intended: { detached: true } });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await fs.writeFile(path.join(gitDir, "HEAD"), expectedHead);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  expect(await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).toBe(oldHead);
  expect(await runGit(repo, "rev-parse", "HEAD")).toBe(oldOid);
  await expect(runGit(repo, "symbolic-ref", "HEAD")).rejects.toThrow();
});

test("third-value human ref and index edits are untouched and retire the journal", async () => {
  const { oldOid, newOid, thirdOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const expectedIndex = await privateIndexFor(newOid, "expected-index");
  const thirdIndex = await privateIndexFor(thirdOid, "human-index");
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex, intended: "opaque" });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });

  await fs.writeFile(path.join(gitDir, "index"), thirdIndex);
  await runGit(repo, "update-ref", "refs/heads/main", thirdOid, oldOid);
  const result = await recoverJournal(root, "repo", binding);

  expect(result.status).toBe("human-intervened");
  if (result.status !== "human-intervened") throw new Error("expected third-value arbitration");
  expect(result.fields).toEqual(expect.arrayContaining(["index", "ref:refs/heads/main"]));
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(thirdIndex);
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(thirdOid);
  expect(result.quarantinePath).toContain("git-journal-quarantine");
  expect(await fs.readFile(path.join(result.quarantinePath, "journal.json"), "utf8")).toContain("incoming-key-1");
});

test("binding mismatch quarantines the complete journal without touching the repo", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const expectedIndex = await privateIndexFor(newOid, "binding-index");
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex, intended: "binding" });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await fs.writeFile(path.join(gitDir, "index"), expectedIndex);
  await runGit(repo, "update-ref", "refs/heads/main", newOid, oldOid);

  const result = await recoverJournal(root, "repo", { ...binding, stateNonce: "different-incarnation" });
  expect(result.status).toBe("binding-mismatch");
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(expectedIndex);
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  if (result.status === "binding-mismatch") expect(await fs.readFile(path.join(result.quarantinePath, "journal.json"), "utf8")).toContain("nonce-a");
});

test("published journal keeps checkout and returns opaque intended data for a fresh CAS save", async () => {
  const { oldOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const intended = { record: { lane: "git", value: 42 }, expectedRepoGen: 9, relPath: "repo" };
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": oldOid }, expectedIndex: index, intended });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await markCheckoutJournalPublished(root, "repo");

  expect(await recoverJournal<typeof intended>(root, "repo", binding)).toEqual({
    status: "keep",
    intended,
    incomingKey: "incoming-key-1",
    journalPath: checkoutJournalDir(root, "repo"),
  });
  expect(await fs.readFile(path.join(checkoutJournalDir(root, "repo"), "journal.json"), "utf8")).toContain('"phase": "published"');
});

test("created-fresh intent atomically quarantines the entire partial .git instead of deleting it", async () => {
  await fs.writeFile(path.join(gitDir, "human-hook-artifact"), "preserve me\n");
  const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const journal = makeJournal({ oldHead: head, expectedHead: head, intended: "fresh", createdFresh: true });
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });

  const result = await recoverJournal(root, "repo", binding);
  expect(result.status).toBe("fresh-quarantined");
  await expect(fs.access(path.join(repo, ".git"))).rejects.toThrow();
  if (result.status === "fresh-quarantined") {
    expect(await fs.readFile(path.join(result.quarantinePath, "human-hook-artifact"), "utf8")).toBe("preserve me\n");
    expect(await fs.readFile(path.join(result.quarantinePath, "HEAD"), "utf8")).toBe(head);
  }
  await expect(fs.access(checkoutJournalDir(root, "repo"))).rejects.toThrow();
});

test("corrupt old-index copy defers before mutation and leaves the journal intact", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const candidate = await privateIndexFor(newOid, "corrupt-candidate");
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex: candidate, intended: "corrupt" });
  const journalPath = await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await fs.writeFile(path.join(journalPath, "old-index"), "corrupt rollback bytes\n");
  await fs.writeFile(path.join(gitDir, "index"), candidate);

  const result = await recoverJournal(root, "repo", binding);
  expect(result).toEqual({ status: "defer", reason: "unreadable or corrupt journaled rollback bytes", journalPath });
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(candidate);
  expect(await fs.readFile(path.join(journalPath, "old-index"), "utf8")).toBe("corrupt rollback bytes\n");
});
