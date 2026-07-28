import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hashBytes } from "../hash.js";
import { captureCommonDirIdentity } from "./lockfile.js";
import type { BlobStore, GitSection, Manifest } from "../types.js";
import { loadState, repoRecordsForState, saveConfig, saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "../../cli/config.js";
import { RboxDaemon } from "../../cli/daemon.js";
import type { SyncRemote } from "../../cli/remote.js";
import { pull } from "../../cli/sync.js";
import { gitIncomingKey } from "../../cli/sync-git/shared.js";
import {
  checkoutJournalDir,
  markCheckoutJournalPublished,
  recoverJournal,
  writeCheckoutJournal,
  type CheckoutJournal,
  type CheckoutJournalBinding,
} from "./journal.js";
import { writeV1724BranchSwitchFixture } from "./v1724-journal-fixture.test-helper.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const runGit = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());
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
    commonDirIdentity: await captureCommonDirIdentity(gitDir),
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
    env: { ...TEST_GIT_ENV, GIT_INDEX_FILE: candidate },
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
    journalId: `1700000000000-${"a".repeat(16)}`,
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
      branchInverses: Object.entries(args.expectedRefs ?? {})
        .filter(([ref, afterOid]) => ref.startsWith("refs/heads/") && (ref === "refs/heads/main" ? args.oldOid ?? null : null) !== afterOid)
        .map(([ref, afterOid]) => {
          const beforeOid = ref === "refs/heads/main" ? args.oldOid ?? null : null;
          return {
            ref,
            beforeOid,
            afterOid,
            lines: beforeOid
              ? [`update ${ref} ${beforeOid} ${afterOid}`]
              : [`delete ${ref} ${afterOid}`],
          };
        }),
    },
    binding,
    createdFresh: args.createdFresh ?? false,
    intended: args.intended,
  };
}

async function writtenJournal<T>(intended: T): Promise<{
  oldOid: string;
  oldHead: string;
  index: Buffer;
  journal: CheckoutJournal<T>;
  journalPath: string;
}> {
  const { oldOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": oldOid }, expectedIndex: index, intended });
  const journalPath = await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  return { oldOid, oldHead, index, journal, journalPath };
}

const TEST_KEK = Buffer.alloc(32, 7);

function upgradeConfig(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws-v1724",
    projectId: "root",
    deviceId: "dev-v1724",
    rootPath: root,
    remoteUrl: "mem://v1724",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: TEST_KEK,
    accountId: "acct-v1724",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

function manifest(section: GitSection): Manifest {
  return { generatedAt: "", files: [], manifestSchema: 2, gitRepos: { repo: section } };
}

function oldSection(oldOid: string): GitSection {
  return incoming("ref: refs/heads/main", { "refs/heads/main": oldOid });
}

function staticRemote(section: GitSection, sequence = 2): SyncRemote {
  const store: BlobStore = {
    has: async () => false,
    put: async () => {},
    get: async () => { throw new Error("legacy recovery unexpectedly fetched a blob"); },
  };
  return {
    latest: async () => ({ sequence, manifest: manifest(section) }),
    blobStore: () => store,
  } as unknown as SyncRemote;
}

async function installUpgradeState(section: GitSection, cfg: WorkspaceConfig, sourceSeq = 1): Promise<SyncState> {
  const state: SyncState = {
    stream: syncStreamId(cfg),
    stateNonce: "a".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: sourceSeq,
    lastSyncedManifest: manifest(section),
    repoRecords: { repo: { repoGen: 1, sourceSeq, base: section } },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  binding = { ...binding, stream: state.stream, stateNonce: state.stateNonce! };
  return state;
}

function intendedRecord(section: GitSection, previous: GitSection) {
  return {
    record: { sourceSeq: 2, base: section },
    previousRecord: { sourceSeq: 1, base: previous },
    expectedRepoGen: 1,
    relPath: "repo",
  };
}

test("v1.7.24 committed intent is generated by the release writer and rolls back through daemon startup", async () => {
  const { oldOid, newOid } = await history();
  const cfg = upgradeConfig();
  const placeholder = oldSection(oldOid);
  await installUpgradeState(placeholder, cfg);
  const fixture = await writeV1724BranchSwitchFixture({
    workspaceRoot: root, relPath: "repo", repoDir: repo, binding,
    oldOid, newOid, point: "committed-intent", intended: intendedRecord(placeholder, placeholder),
  });
  // Use the release-derived incoming section as the no-op remote/base only
  // after the fixture exists; startup must still traverse the real pull path.
  await installUpgradeState(fixture.incoming, cfg);
  await saveConfig(root, cfg);

  expect(fixture.raw.endsWith("\n")).toBe(true);
  expect(fixture.raw).not.toContain("commonDirIdentity");
  expect(JSON.parse(fixture.raw).incomingKey).toBe(gitIncomingKey(fixture.incoming));
  expect(JSON.parse(fixture.raw).expectedNew.indexHash).toBe(hashBytes(fixture.candidateIndex));
  expect(fixture.raw.indexOf('"locks"')).toBeLessThan(fixture.raw.indexOf('"completed"'));
  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/incoming");

  const oldWsDisabled = process.env.RBOX_DAEMON_WS_DISABLED;
  const oldRboxHome = process.env.RBOX_HOME;
  process.env.RBOX_DAEMON_WS_DISABLED = "1";
  process.env.RBOX_HOME = path.join(root, ".daemon-home");
  const logs: string[] = [];
  const daemon = new RboxDaemon(root, cfg, { remote: staticRemote(fixture.incoming), backoff: async () => {} }, {
    bootId: "v1724-startup", pullOnly: true, log: (line) => logs.push(line),
  });
  try {
    await daemon.start();
  } finally {
    await daemon.stop();
    if (oldWsDisabled === undefined) delete process.env.RBOX_DAEMON_WS_DISABLED;
    else process.env.RBOX_DAEMON_WS_DISABLED = oldWsDisabled;
    if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = oldRboxHome;
  }

  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await runGit(repo, "rev-parse", "HEAD")).toBe(oldOid);
  expect(await runGit(repo, "rev-parse", "refs/heads/incoming")).toBe(newOid);
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(fixture.oldIndex);
  await expect(fs.access(fixture.journalDir)).rejects.toThrow();
  expect(logs.some((line) => line.includes("prepared Git transaction owner is live"))).toBe(false);
}, 20_000);

test("v1.7.24 tokenized prepared transaction is reaped through the upgraded pull entry point", async () => {
  const { oldOid, newOid } = await history();
  const cfg = upgradeConfig();
  await installUpgradeState(oldSection(oldOid), cfg);
  const fixture = await writeV1724BranchSwitchFixture({
    workspaceRoot: root, relPath: "repo", repoDir: repo, binding,
    oldOid, newOid, point: "prepared-tokenized", intended: intendedRecord(oldSection(oldOid), oldSection(oldOid)),
  });
  await installUpgradeState(fixture.incoming, cfg);
  const logs: string[] = [];

  expect(fixture.raw).toContain('"preparedTransactions"');
  expect(fixture.raw).toContain('"token"');
  for (const lockPath of fixture.preparedLockPaths) await fs.access(lockPath);
  await pull(root, cfg, { remote: staticRemote(fixture.incoming), onGitLog: (line) => logs.push(line) });

  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await runGit(repo, "rev-parse", "HEAD")).toBe(oldOid);
  for (const lockPath of fixture.preparedLockPaths) await expect(fs.access(lockPath)).rejects.toThrow();
  await expect(fs.access(fixture.journalDir)).rejects.toThrow();
  expect(logs.some((line) => line.includes("stale-unattributed"))).toBe(false);
});

test("v1.7.24 tokenless prepared transaction is preserved once with stale-unattributed diagnostics", async () => {
  const { oldOid, newOid } = await history();
  const cfg = upgradeConfig();
  await installUpgradeState(oldSection(oldOid), cfg);
  const fixture = await writeV1724BranchSwitchFixture({
    workspaceRoot: root, relPath: "repo", repoDir: repo, binding,
    oldOid, newOid, point: "prepared-tokenless", intended: intendedRecord(oldSection(oldOid), oldSection(oldOid)),
  });
  await installUpgradeState(fixture.incoming, cfg);
  const firstLogs: string[] = [];

  expect(fixture.raw).toContain('"preparedTransactions"');
  expect(fixture.raw).not.toContain('"token"');
  for (const lockPath of fixture.preparedLockPaths) await fs.access(lockPath);
  await pull(root, cfg, { remote: staticRemote(fixture.incoming), onGitLog: (line) => firstLogs.push(line) });

  expect(firstLogs.some((line) => line.includes("stale-unattributed") && line.includes("rbox doctor"))).toBe(true);
  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await runGit(repo, "rev-parse", "HEAD")).toBe(oldOid);
  for (const lockPath of fixture.preparedLockPaths) await fs.access(lockPath);
  await expect(fs.access(fixture.journalDir)).rejects.toThrow();

  const secondLogs: string[] = [];
  await pull(root, cfg, { remote: staticRemote(fixture.incoming), onGitLog: (line) => secondLogs.push(line) });
  expect(secondLogs.some((line) => line.includes("journal") && line.includes("deferred"))).toBe(false);
  expect(secondLogs.some((line) => line.includes("stale-unattributed"))).toBe(false);
});

test("v1.7.24 published branch switch lands through pull and never enters recovery deferral", async () => {
  const { oldOid, newOid } = await history();
  const cfg = upgradeConfig();
  const previous = oldSection(oldOid);
  await installUpgradeState(previous, cfg);
  const fixture = await writeV1724BranchSwitchFixture({
    workspaceRoot: root, relPath: "repo", repoDir: repo, binding,
    oldOid, newOid, point: "published", intended: intendedRecord(
      incoming("ref: refs/heads/incoming", { "refs/heads/main": oldOid, "refs/heads/incoming": newOid }),
      previous,
    ),
  });
  const logs: string[] = [];

  expect(JSON.parse(fixture.raw).phase).toBe("published");
  await pull(root, cfg, { remote: staticRemote(fixture.incoming), onGitLog: (line) => logs.push(line) });

  expect(await runGit(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/incoming");
  expect(await runGit(repo, "rev-parse", "HEAD")).toBe(newOid);
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(fixture.candidateIndex);
  await expect(fs.access(fixture.journalDir)).rejects.toThrow();
  const saved = await loadState(root, syncStreamId(cfg));
  expect(repoRecordsForState(saved).repo?.base).toEqual(fixture.incoming);
  expect(logs.some((line) => line.includes("recovered published checkout repo"))).toBe(true);
  expect(logs.some((line) => line.includes("deferred"))).toBe(false);
});

test("a published journal whose intended record claims a ref never on disk cannot install it", async () => {
  // Findings 2/3 regression: a forged or stale published journal must not
  // install unmaterialized BASE. The fixture only ever checks out main+incoming;
  // the intended record additionally claims refs/heads/evil, which no repository
  // was ever seen to hold. Recovery composes BASE from the refs actually on disk,
  // so the fabricated ref is held, never recorded.
  const { oldOid, newOid } = await history();
  const cfg = upgradeConfig();
  const previous = oldSection(oldOid);
  await installUpgradeState(previous, cfg);
  const evilOid = "d".repeat(40);
  const fixture = await writeV1724BranchSwitchFixture({
    workspaceRoot: root, relPath: "repo", repoDir: repo, binding,
    oldOid, newOid, point: "published", intended: intendedRecord(
      incoming("ref: refs/heads/incoming", {
        "refs/heads/main": oldOid, "refs/heads/incoming": newOid, "refs/heads/evil": evilOid,
      }),
      previous,
    ),
  });

  expect(JSON.parse(fixture.raw).phase).toBe("published");
  await pull(root, cfg, { remote: staticRemote(fixture.incoming) });

  const saved = await loadState(root, syncStreamId(cfg));
  // The fabricated ref never reaches BASE — the observed-landing witness held it.
  expect(repoRecordsForState(saved).repo?.base?.refs?.["refs/heads/evil"]).toBeUndefined();
  expect(await runGit(repo, "rev-parse", "--verify", "--quiet", "refs/heads/evil").catch(() => "")).toBe("");
});

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

test("intent recovery preserves tokenless native locks in the prepare-to-token journal window", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex: index, intended: "prepare-window" });
  const refLock = path.join(gitDir, "refs/heads/main.lock");
  const headLock = path.join(gitDir, "HEAD.lock");
  const owner = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 1234, startTime: "7" };
  journal.expectedNew.preparedTransactions = [{
    id: "primary",
    ownerPid: owner.pid,
    owner,
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

  expect((await recoverJournal(root, "repo", binding, {
    identity: { current: async () => owner, probe: async () => ({ status: "dead" }) },
  })).status).toBe("human-intervened");
  expect(await fs.readFile(refLock, "utf8")).toBe(`${newOid}\n`);
  expect(await fs.readFile(headLock, "utf8")).toBe("");
});

test("reservedRefs without reservedLocks is a legal pre-acquisition intermediate", async () => {
  const { oldOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": oldOid }, expectedIndex: index, intended: "intermediate" });
  journal.expectedNew.reservedRefs = { "refs/rbox-local/intermediate": null };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
});

test("empty reserved-lock authority is rejected and cannot delete a lock", async () => {
  const { oldOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": oldOid }, expectedIndex: index, intended: "malformed" });
  const ref = "refs/rbox-local/malformed";
  journal.expectedNew.reservedRefs = { [ref]: null };
  (journal.expectedNew as any).reservedLocks = { [ref]: {} };
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  const lockPath = path.join(gitDir, `${ref}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");

  expect((await recoverJournal(root, "repo", binding)).status).toBe("defer");
  expect(await fs.readFile(lockPath, "utf8")).toBe("");
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
  expect(result.fields).toEqual(expect.arrayContaining(["ref:refs/heads/main"]));
  expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(thirdIndex);
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(thirdOid);
  expect(result.quarantinePath).toContain("git-journal-quarantine");
  expect(await fs.readFile(path.join(result.quarantinePath, "journal.json"), "utf8")).toContain("incoming-key-1");
});

test("multi-ref inverse mismatch performs zero ref mutations", async () => {
  const { oldOid, newOid, thirdOid } = await history();
  await runGit(repo, "update-ref", "refs/heads/topic", oldOid);
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({
    oldOid, oldHead, expectedHead: oldHead,
    expectedRefs: { "refs/heads/main": newOid, "refs/heads/topic": newOid },
    expectedIndex: index, intended: "atomic-refs",
  });
  journal.old.refs = { "refs/heads/topic": oldOid };
  journal.expectedNew.branchInverses = ["refs/heads/main", "refs/heads/topic"].map((ref) => ({
    ref, beforeOid: oldOid, afterOid: newOid, lines: [`update ${ref} ${oldOid} ${newOid}`],
  }));
  await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await runGit(repo, "update-ref", "refs/heads/main", newOid, oldOid);
  await runGit(repo, "update-ref", "refs/heads/topic", newOid, oldOid);
  await runGit(repo, "update-ref", "refs/heads/topic", thirdOid, newOid);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("human-intervened");
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
  expect(await runGit(repo, "rev-parse", "refs/heads/topic")).toBe(thirdOid);
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

test("checkout recovery refuses a repository replaced at the same common-dir path", async () => {
  const { oldOid, newOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": newOid }, expectedIndex: index, intended: "identity-fence" });
  const journalPath = await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  const displaced = `${gitDir}.old`;
  await fs.rename(gitDir, displaced);
  await fs.mkdir(gitDir);
  await fs.writeFile(path.join(gitDir, "sentinel"), "replacement\n");

  expect(await recoverJournal(root, "repo", binding)).toEqual({
    status: "defer", reason: "checkout common-directory identity changed", journalPath,
  });
  expect(await fs.readFile(path.join(gitDir, "sentinel"), "utf8")).toBe("replacement\n");
});

test("an unreadable ref database defers the published landing instead of composing an empty witness", async () => {
  // Fail-open guard: readAllRefs turns a failed show-ref into {}, which the
  // observed-landing composer would read as every ref proven-deleted — a BASE
  // wipe authorized by a read error. The strict read distinguishes a corrupt
  // ref DB from a genuinely empty one, and a corrupt one defers untouched.
  const { oldOid } = await history();
  const oldHead = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
  const index = await fs.readFile(path.join(gitDir, "index"));
  const journal = makeJournal({ oldOid, oldHead, expectedHead: oldHead, expectedRefs: { "refs/heads/main": oldOid }, expectedIndex: index, intended: { record: "x" } });
  const journalPath = await writeCheckoutJournal(root, "repo", journal, { indexPath: path.join(gitDir, "index"), gitDir });
  await markCheckoutJournalPublished(root, "repo");
  await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(gitDir, "refs", "heads", "broken"), "not-an-oid\n");

  const result = await recoverJournal(root, "repo", binding);
  expect(result.status).toBe("defer");
  if (result.status === "defer") expect(result.reason).toMatch(/ref database unreadable/);

  // A genuinely readable repository — even after removing the corruption — keeps.
  await fs.rm(path.join(gitDir, "refs", "heads", "broken"));
  expect(await recoverJournal(root, "repo", binding)).toMatchObject({
    status: "keep", observedRefs: { "refs/heads/main": oldOid },
  });
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
    observedRefs: { "refs/heads/main": oldOid },
    journalPath: checkoutJournalDir(root, "repo"),
  });
  expect(await fs.readFile(path.join(checkoutJournalDir(root, "repo"), "journal.json"), "utf8")).toContain('"phase": "published"');
});

test("created-fresh intent quarantines the entire partial .git instead of deleting it", async () => {
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

for (const exit of ["rollback", "published", "binding-mismatch", "corrupt"] as const) {
  test(`design 126 recovery fences ORIG_HEAD.lock handling on the ${exit} exit`, async () => {
    const { journal, journalPath } = await writtenJournal(exit);
    expect(await fs.readFile(path.join(journalPath, "journal.id"), "utf8")).toBe(journal.journalId);
    if (exit === "published") await markCheckoutJournalPublished(root, "repo");
    if (exit === "corrupt") await fs.writeFile(path.join(journalPath, "journal.json"), "{not json\n");
    await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

    const result = await recoverJournal(root, "repo", exit === "binding-mismatch" ? { ...binding, stateNonce: "other" } : binding);
    expect(result.status).toBe(exit === "rollback" ? "rolled-back" : exit === "published" ? "keep" : exit === "binding-mismatch" ? "binding-mismatch" : "defer");
    if (exit === "binding-mismatch") expect(await fs.readFile(path.join(gitDir, "ORIG_HEAD.lock"), "utf8")).toBe(journal.journalId);
    else await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
  });
}

test("design 126 recovery never removes a foreign ORIG_HEAD.lock", async () => {
  const { journal } = await writtenJournal("foreign");
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), "foreign-owner");

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  expect(await fs.readFile(path.join(gitDir, "ORIG_HEAD.lock"), "utf8")).toBe("foreign-owner");
});

test("design 126 recovery retains pre-journalId checkout-journal compatibility", async () => {
  const { journalPath } = await writtenJournal("legacy");
  const legacy = JSON.parse(await fs.readFile(path.join(journalPath, "journal.json"), "utf8"));
  delete legacy.journalId;
  await fs.writeFile(path.join(journalPath, "journal.json"), `${JSON.stringify(legacy)}\n`);
  await fs.rm(path.join(journalPath, "journal.id"));

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
});

test("design 126 write crash after journal.id but before journal.json is not a permanent strand", async () => {
  const { journal, journalPath } = await writtenJournal("sidecar-only");
  await fs.rm(path.join(journalPath, "journal.json"));
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

  expect(await recoverJournal(root, "repo", binding)).toEqual({ status: "none" });
  await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
});

test("design 126 clear crash after journal.id unlink keeps published JSON authoritative", async () => {
  const intended = { crashWindow: "json-only" };
  const { oldOid, journal, journalPath } = await writtenJournal(intended);
  await markCheckoutJournalPublished(root, "repo");
  await fs.rm(path.join(journalPath, "journal.id"));
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

  expect(await recoverJournal(root, "repo", binding)).toEqual({
    status: "keep",
    intended,
    incomingKey: "incoming-key-1",
    observedRefs: { "refs/heads/main": oldOid },
    journalPath,
  });
  await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
});

test("design 126 missing sidecar does not strand parseable intent arbitration", async () => {
  const { journal, journalPath } = await writtenJournal("missing");
  await fs.rm(path.join(journalPath, "journal.id"));
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
});

test("design 126 invalid sidecar does not override parseable JSON arbitration", async () => {
  const { journal, journalPath } = await writtenJournal("invalid");
  await fs.writeFile(path.join(journalPath, "journal.id"), "not-a-journal-id\n");
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("rolled-back");
  await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
});

test("design 126 two valid mismatched ownership ids remain fail-closed", async () => {
  const { journal, journalPath } = await writtenJournal("mismatch");
  await fs.writeFile(path.join(journalPath, "journal.id"), `1700000000000-${"c".repeat(16)}`);
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), journal.journalId);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("defer");
  await expect(fs.access(path.join(gitDir, "ORIG_HEAD.lock"))).rejects.toThrow();
  expect(await fs.access(journalPath).then(() => true, () => false)).toBe(true);
});

test("design 126 sidecar mismatch never removes a lock matching only the foreign sidecar id", async () => {
  const { journal, journalPath } = await writtenJournal("mismatch-foreign");
  const foreignSidecarId = `1700000000000-${"d".repeat(16)}`;
  await fs.writeFile(path.join(journalPath, "journal.id"), foreignSidecarId);
  await fs.writeFile(path.join(gitDir, "ORIG_HEAD.lock"), foreignSidecarId);

  expect((await recoverJournal(root, "repo", binding)).status).toBe("defer");
  expect(await fs.readFile(path.join(gitDir, "ORIG_HEAD.lock"), "utf8")).toBe(foreignSidecarId);
});
