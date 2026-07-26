import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  captureGitState,
  gitIdentity,
  gitIdentityKey,
  repoCtxFromDisk,
  setGitSpawnObserver,
  writeCheckoutJournal,
  type CheckoutJournal,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import type { MutationBoundary } from "../../engine/mutation-gate.js";
import { applyConfigTransaction } from "../../engine/git/config-txn.js";
import type { RepoRecord, SyncState, WorkspaceConfig } from "../config.js";
import { loadState, saveStateUnsafeLegacyOrTest, syncStreamId } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { pull } from "../sync.js";
import { applyGitSections } from "./apply.js";
import { checkoutJournalBinding } from "./follow.js";
import { gitIncomingKey } from "./shared.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test",
  GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test",
  GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then((result) => result.stdout.toString().trim());
const KEK = Buffer.alloc(32, 203);

let tmp = "";
let root = "";
let store: LocalBlobStore;

function cfg(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_203",
    projectId: "root",
    deviceId: "dev_203",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
  };
}

function manifest(sections: Record<string, GitSection>): Manifest {
  return { generatedAt: "remote", files: [], manifestSchema: 2, gitRepos: sections };
}

function stateWith(
  bases: Record<string, GitSection>,
  extra: Partial<SyncState> = {},
  records: Record<string, Partial<RepoRecord>> = {},
): SyncState {
  return {
    stream: "test",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(bases),
    repoRecords: Object.fromEntries(Object.entries(bases).map(([rel, base]) => [rel, {
      repoGen: 1,
      sourceSeq: 1,
      base,
      ...records[rel],
    }])),
    ...extra,
  };
}

async function initRepo(rel: string): Promise<string> {
  const dir = path.join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "tracked.txt"), `${rel}\n`);
  await git(dir, "add", "tracked.txt");
  await git(dir, "commit", "-qm", "initial");
  return dir;
}

async function capture(rel: string): Promise<GitSection> {
  return (await captureGitState(path.join(root, rel), store, KEK))!;
}

async function observe<T>(fn: () => Promise<T>): Promise<{ value: T; commands: string[][] }> {
  const commands: string[][] = [];
  setGitSpawnObserver((_repo, args) => commands.push([...args]));
  try {
    return { value: await fn(), commands };
  } finally {
    setGitSpawnObserver(undefined);
  }
}

function countingBoundary(): { boundary: MutationBoundary; count: () => number } {
  let enters = 0;
  return {
    boundary: {
      enter: () => {
        enters += 1;
        return { abortRequested: false, beginCommit: () => true, finish: () => {} };
      },
    },
    count: () => enters,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function writeValidIntentJournal(rel: string, section: GitSection): Promise<string> {
  const repo = path.join(root, rel);
  const ctx = await repoCtxFromDisk(repo);
  if (!ctx) throw new Error("test repository context missing");
  const headContent = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
  const currentRefName = /^ref:\s*(refs\/\S+)/.exec(headContent)?.[1];
  const currentRefOid = currentRefName ? section.refs[currentRefName] : undefined;
  const journal: CheckoutJournal<Record<string, never>> = {
    journalId: `1700000000000-${"c".repeat(16)}`,
    phase: "intent",
    incomingKey: gitIncomingKey(section),
    incomingSection: section,
    old: {
      ...(currentRefName ? { currentRefName } : {}),
      ...(currentRefOid ? { currentRefOid } : {}),
      headContent,
      indexPresent: true,
      opState: {},
    },
    expectedNew: {
      opState: {},
      refs: section.refs,
      head: headContent,
      branchInverses: [],
    },
    binding: await checkoutJournalBinding("test", "a".repeat(32), ctx),
    createdFresh: false,
    intended: {},
  };
  return writeCheckoutJournal(root, rel, journal, {
    indexPath: path.join(ctx.gitDir, "index"),
    gitDir: ctx.gitDir,
  });
}

beforeEach(async () => {
  // Each test pins its own probe-order mode; an ambient RBOX_GIT_APPLY_LAZY
  // (e.g. a kill-switch-off suite run) must not leak into the lazy-default pins.
  delete process.env.RBOX_GIT_APPLY_LAZY;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lazy-apply-"));
  root = path.join(tmp, "workspace");
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  store = new LocalBlobStore(path.join(tmp, "store"));
});

afterEach(async () => {
  setGitSpawnObserver(undefined);
  delete process.env.RBOX_GIT_APPLY_LAZY;
  delete process.env.RBOX_GIT_APPLY_CONCURRENCY;
  delete process.env.RBOX_PULL_TRUST_WATCHER;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("203.1: warm unchanged multi-repo apply issues zero git spawns", async () => {
  const sections: Record<string, GitSection> = {};
  for (const rel of ["a", "b", "c"]) {
    await initRepo(rel);
    sections[rel] = await capture(rel);
  }

  const run = await observe(() => applyGitSections(
    root, cfg(), stateWith(sections), manifest(sections), store,
    buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
  ));

  expect(run.commands).toEqual([]);
  expect(run.value.gitRepos).toEqual(sections);
});

test("203.3: state-keyed identity demanders stay lazy but preserve their outcomes", async () => {
  await initRepo("r");
  const section = await capture("r");
  const rows: Array<{ name: string; state: SyncState; check: (outcome: Awaited<ReturnType<typeof applyGitSections>>) => void }> = [
    {
      name: "needs-resolution",
      state: stateWith({ r: section }, { gitNeedsResolution: { r: "stale-resolution" } }),
      check: (outcome) => expect(outcome.gitNeedsResolution).toBeUndefined(),
    },
    {
      name: "removal-memory",
      state: stateWith({ r: section }, { gitReposRemoved: { r: "stale-removal" } }),
      check: (outcome) => expect(outcome.gitReposRemoved).toBeUndefined(),
    },
    {
      name: "pending-retry",
      state: stateWith({ r: section }, { gitPendingRemote: { r: section } }),
      check: (outcome) => expect(outcome.gitPendingRemote).toBeUndefined(),
    },
  ];

  for (const row of rows) {
    const run = await observe(() => applyGitSections(
      root, cfg(), row.state, manifest({ r: section }), store,
      buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
    ));
    expect(run.commands.length, row.name).toBeGreaterThan(0);
    row.check(run.value);
  }

  const oid = await git(path.join(root, "r"), "rev-parse", "HEAD");
  await git(path.join(root, "r"), "branch", "side");
  const incoming = await capture("r");
  const partial = {
    incomingKey: gitIncomingKey(incoming),
    checkoutPending: false,
    appliedRefs: { "refs/heads/side": { kind: "direct" as const, oid } },
    heldRefs: {},
    configApplied: true,
  };
  const partialRun = await observe(() => applyGitSections(
    root,
    cfg(),
    stateWith({ r: section }, { gitPendingRemote: { r: incoming } }, { r: { partial } }),
    manifest({ r: incoming }),
    store,
    buildIgnoreMatcher(root),
    () => {},
    { disableConfigLane: true },
  ));
  expect(partialRun.commands.filter((args) => args[0] === "show-ref").length).toBeGreaterThanOrEqual(2);
  expect(partialRun.value.partial?.r).toBeNull();
});

test("203.4-5: unchanged busy receiver defers spawn-free before identity and retains guards", async () => {
  const repo = await initRepo("r");
  const section = await capture("r");
  const remote = { ...section, generatedAt: "remote-new" };
  const identityKey = gitIdentityKey(await gitIdentity(repo));
  const prior = {
    lane: "apply" as const,
    reason: "git-busy" as const,
    deferredSince: "2026-01-01T00:00:00.000Z",
    reasonSince: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    subjectKey: "prior",
  };
  const state = stateWith(
    { r: section },
    { gitReposRemoved: { r: identityKey } },
    { r: { deferrals: { apply: prior } } },
  );
  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");

  const run = await observe(() => applyGitSections(
    root, cfg(), state, manifest({ r: remote }), store,
    buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
  ));

  expect(run.commands).toEqual([]);
  expect(run.value.gitRepos?.r).toEqual(section);
  expect(run.value.gitPendingRemote?.r).toEqual(remote);
  expect(run.value.gitReposRemoved?.r).toBe(identityKey);
  expect(run.value.deferrals?.r?.apply?.reason).toBe("git-busy");
  expect(run.value.deferrals?.r?.apply?.deferredSince).toBe(prior.deferredSince);

  const pendingRun = await observe(() => applyGitSections(
    root, cfg(), { ...state, gitPendingRemote: { r: remote } }, manifest({ r: remote }), store,
    buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
  ));
  expect(pendingRun.commands).toEqual([]);
  expect(pendingRun.value.gitPendingRemote?.r).toEqual(remote);
  expect(pendingRun.value.deferrals?.r?.apply?.reason).toBe("git-busy");
});

test("203.6: absent journals skip recovery; present journals recover under the lock", async () => {
  await initRepo("r");
  const section = await capture("r");
  const absentCounter = countingBoundary();
  const absent = await applyGitSections(
    root, cfg(), stateWith({ r: section }), manifest({ r: section }), store,
    buildIgnoreMatcher(root), () => {},
    { disableConfigLane: true, mutationBoundary: absentCounter.boundary },
  );
  expect(absent.gitRepos?.r).toEqual(section);
  expect(absentCounter.count()).toBe(0);

  const presentDir = await writeValidIntentJournal("r", section);
  const presentCounter = countingBoundary();
  const present = await applyGitSections(
    root, cfg(), stateWith({ r: section }), manifest({ r: section }), store,
    buildIgnoreMatcher(root), () => {},
    { disableConfigLane: true, mutationBoundary: presentCounter.boundary },
  );
  expect(presentCounter.count()).toBeGreaterThan(0);
  expect(present.gitPendingRemote).toBeUndefined();
  await expect(fs.lstat(presentDir)).rejects.toMatchObject({ code: "ENOENT" });

  await writeValidIntentJournal("r", section);
  await fs.rename(path.join(root, "r", ".git"), path.join(root, "r", ".git.saved"));
  const unboundCounter = countingBoundary();
  const unboundLogs: string[] = [];
  const unbound = await applyGitSections(
    root, cfg(), stateWith({ r: section }), manifest({ r: section }), store,
    buildIgnoreMatcher(root), (line) => unboundLogs.push(line),
    { disableConfigLane: true, mutationBoundary: unboundCounter.boundary },
  );
  expect(unboundCounter.count()).toBeGreaterThan(0);
  expect(unbound.gitPendingRemote).toBeUndefined();
  expect(unboundLogs.some((line) => line.includes("journal for an absent/unreadable repository quarantined"))).toBe(true);
  await expect(fs.lstat(presentDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("203.7: config apply remains serialized with a linked worktree sharing its common dir", async () => {
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "2";
  const main = await initRepo("a-main");
  const linked = path.join(root, "z-linked");
  await git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const baseMain = await capture("a-main");
  const baseLinked = await capture("z-linked");
  const desired = { "remote.upstream.url": ["git@example.com:team/repo.git"] };
  const remoteMain = { ...baseMain, config: desired };
  const remoteLinked = { ...baseLinked, config: desired };
  const mainEntered = deferred();
  const releaseMain = deferred();
  const progress: number[] = [];

  const applying = applyGitSections(
    root,
    cfg(),
    stateWith({ "a-main": baseMain, "z-linked": baseLinked }),
    manifest({ "a-main": remoteMain, "z-linked": remoteLinked }),
    store,
    buildIgnoreMatcher(root),
    () => {},
    {
      applyConfig: async (...args) => {
        mainEntered.resolve();
        await releaseMain.promise;
        return applyConfigTransaction(...args);
      },
      onProgress: (done) => progress.push(done),
    },
  );

  await mainEntered.promise;
  // Let z-linked reach and queue on the shared common-dir chain lock.
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(progress).toEqual([]);
  releaseMain.resolve();
  const outcome = await applying;

  expect(progress.sort()).toEqual([1, 2]);
  expect(outcome.gitPendingRemote).toBeUndefined();
  expect(await git(main, "config", "--get", "remote.upstream.url")).toBe(desired["remote.upstream.url"][0]!);
});

test("203.8-10: unchanged semantic-index path remains unreachable and metrics stay total", async () => {
  const sections: Record<string, GitSection> = {};
  for (const rel of ["a", "b"]) {
    const repo = await initRepo(rel);
    sections[rel] = await capture(rel);
    await git(repo, "update-index", "--assume-unchanged", "tracked.txt");
  }
  const progress: Array<[number, number]> = [];

  const run = await observe(() => applyGitSections(
    root, cfg(), stateWith(sections), manifest(sections), store,
    buildIgnoreMatcher(root), () => {},
    { disableConfigLane: true, collectMetrics: true, onProgress: (done, total) => progress.push([done, total]) },
  ));

  expect(run.commands).toEqual([]);
  expect(run.value.idxProj).toBeUndefined();
  expect(run.value.gitApplyMetrics?.repos).toBe(2);
  expect(run.value.gitApplyMetrics?.results).toEqual({
    unchanged: 2, applied: 0, deferred: 0, conflict: 0, removed: 0, skipped: 0,
  });
  expect(run.value.gitApplyMetrics?.repoTimings).toHaveLength(2);
  expect(run.value.gitApplyMetrics?.repoTimings.map(({ index, result }) => ({ index, result })).sort((a, b) => a.index - b.index))
    .toEqual([{ index: 0, result: "unchanged" }, { index: 1, result: "unchanged" }]);
  expect(progress.map(([, total]) => total)).toEqual([2, 2]);
  expect(progress.map(([done]) => done).sort()).toEqual([1, 2]);
});

test("203.9: remote absence is processed while the receiver is busy", async () => {
  const repo = await initRepo("r");
  const section = await capture("r");
  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");

  const outcome = await applyGitSections(
    root, cfg(), stateWith({ r: section }, { gitPendingRemote: { r: section } }),
    { generatedAt: "remote", files: [] }, store, buildIgnoreMatcher(root), () => {},
    { disableConfigLane: true },
  );

  expect(outcome.gitRepos).toBeUndefined();
  expect(outcome.gitPendingRemote).toBeUndefined();
  expect(outcome.gitReposRemoved?.r).toBe(gitIdentityKey(section));
});

test("203.11: lazy kill switch restores the legacy probe command order", async () => {
  await initRepo("r");
  const section = await capture("r");
  const expectedLegacy = [
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--git-common-dir"],
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--git-common-dir"],
    ["rev-parse", "--verify", "HEAD"],
    ["show-ref"],
    ["write-tree"],
  ];

  process.env.RBOX_PULL_TRUST_WATCHER = "0";
  const lazy = await observe(() => applyGitSections(
    root, cfg(), stateWith({ r: section }), manifest({ r: section }), store,
    buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
  ));
  expect(lazy.commands).toEqual([]);
  expect(lazy.value.gitRepos?.r).toEqual(section);

  process.env.RBOX_GIT_APPLY_LAZY = "0";
  delete process.env.RBOX_PULL_TRUST_WATCHER;
  const legacy = await observe(() => applyGitSections(
    root, cfg(), stateWith({ r: section }), manifest({ r: section }), store,
    buildIgnoreMatcher(root), () => {}, { disableConfigLane: true },
  ));
  expect(legacy.commands).toEqual(expectedLegacy);
  expect(legacy.value.gitRepos?.r).toEqual(section);
});

test("203.12: integration pull converges with both gates on and with either gate off", async () => {
  const repo = path.join(root, "joint");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "--allow-empty", "-qm", "empty");
  const section = await capture("joint");
  const remoteManifest = manifest({ joint: section });
  const config = cfg();
  const baseState = stateWith({ joint: section });
  baseState.stream = syncStreamId(config);
  const remote: SyncRemote = {
    latest: async () => ({ sequence: 2, manifest: remoteManifest }),
    missingBlobs: async () => [],
    putBlobFile: async () => {},
    commit: async () => ({ sequence: 3 }),
    blobStore: () => store,
  };
  const rows = [
    { name: "both-on", lazy: undefined, watcher: undefined },
    { name: "lazy-off", lazy: "0", watcher: undefined },
    { name: "watcher-off", lazy: undefined, watcher: "0" },
  ];

  for (const row of rows) {
    if (row.lazy === undefined) delete process.env.RBOX_GIT_APPLY_LAZY;
    else process.env.RBOX_GIT_APPLY_LAZY = row.lazy;
    if (row.watcher === undefined) delete process.env.RBOX_PULL_TRUST_WATCHER;
    else process.env.RBOX_PULL_TRUST_WATCHER = row.watcher;
    await saveStateUnsafeLegacyOrTest(root, structuredClone(baseState));

    await pull(root, config, { remote, onGitLog: () => {} });

    const saved = await loadState(root, syncStreamId(config));
    expect(saved.lastSyncedSequence, row.name).toBe(2);
    expect(saved.lastSyncedManifest.gitRepos?.joint, row.name).toEqual(section);
    expect(saved.gitPendingRemote, row.name).toBeUndefined();
  }
});
