import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectGitBusyShared, type GitBusyInspection, type GitBusySharedInspection, type RepoCtx } from "../../engine/git/shared.js";
import {
  loadState,
  repoRecordsForState,
  saveStateUnsafeLegacyOrTest,
  type GitDeferral,
  type StateSavePacket,
  type StateSaveResult,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";
import { GitBusyClassifier, reconcileGitDeferrals } from "./deferral-hygiene.js";

const STREAM = "test-stream";
const CFG = {} as WorkspaceConfig;
const T0 = Date.parse("2026-07-22T12:00:00.000Z");
let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-deferral-hygiene-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function busy(lane: GitDeferral["lane"] = "capture", reason: GitDeferral["reason"] = "git-busy"): GitDeferral {
  return {
    lane,
    reason,
    deferredSince: new Date(T0 - 60_000).toISOString(),
    reasonSince: new Date(T0 - 60_000).toISOString(),
    lastSeen: new Date(T0 - 60_000).toISOString(),
  };
}

function stateWith(records: SyncState["repoRecords"]): SyncState {
  return {
    stream: STREAM,
    stateNonce: "1".repeat(32),
    stateRevision: 1,
    lastSyncedSequence: 3,
    lastSyncedManifest: { generatedAt: "fixture", files: [] },
    repoRecords: records,
  };
}

function ctx(repoDir: string, commonDir = path.join(root, ".shared")): RepoCtx {
  return { repoDir, kind: "dir", gitDir: path.join(repoDir, ".git"), commonDir };
}

function depsFor(inspection: GitBusyInspection, extras: Record<string, unknown> = {}) {
  return {
    now: () => T0,
    resolveRepoContext: async (repoDir: string) => ctx(repoDir),
    inspectShared: async (): Promise<GitBusySharedInspection> => ({ status: "ok", locks: [] }),
    inspectRepo: async () => inspection,
    ...extras,
  };
}

test("design 178 C: idle durable repo absent from discovery/base/pending is swept", async () => {
  const initial = stateWith({ gone: { repoGen: 4, sourceSeq: 3, deferrals: { capture: busy() } } });
  await saveStateUnsafeLegacyOrTest(root, initial);
  const result = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "ok", locks: [] }));
  expect(result.accepted).toBe(true);
  expect(repoRecordsForState(result.state).gone?.deferrals).toBeUndefined();
  expect(repoRecordsForState(await loadState(root, STREAM)).gone?.deferrals).toBeUndefined();
});

test("review M5: bounded hygiene resumes from the next repo on the following pass", async () => {
  const initial = stateWith(Object.fromEntries(["a", "b", "c"].map((repo) => [repo, {
    repoGen: 1,
    sourceSeq: 3,
    deferrals: { capture: busy() },
  }])));
  await saveStateUnsafeLegacyOrTest(root, initial);
  const cursor: { nextRepo?: string } = {};
  const inspected: string[] = [];
  let budgetTick = 0;
  const overrides = depsFor({ status: "ok", locks: [] }, {
    cursor,
    timeBudgetMs: 1,
    budgetNow: () => budgetTick++ * 2,
    inspectRepo: async (repo: RepoCtx) => {
      inspected.push(path.basename(repo.repoDir));
      return { status: "ok" as const, locks: [] };
    },
  });

  const first = await reconcileGitDeferrals(root, CFG, initial, overrides);
  expect(inspected).toEqual(["a"]);
  expect(cursor.nextRepo).toBe("b");
  expect(repoRecordsForState(first.state).a?.deferrals).toBeUndefined();
  expect(repoRecordsForState(first.state).b?.deferrals?.capture).toBeDefined();
  expect(repoRecordsForState(first.state).c?.deferrals?.capture).toBeDefined();

  budgetTick = 0;
  const second = await reconcileGitDeferrals(root, CFG, first.state, overrides);
  expect(inspected).toEqual(["a", "b"]);
  expect(cursor.nextRepo).toBe("c");
  expect(repoRecordsForState(second.state).b?.deferrals).toBeUndefined();
  expect(repoRecordsForState(second.state).c?.deferrals?.capture).toBeDefined();
});

test("design 178 C: exact stale lane clears without pending/partial/attempt/attention or mixed-lane damage", async () => {
  const apply = busy("apply", "local-commits");
  const pending = {
    bundleEncSha: "a".repeat(64),
    bundleCipherSize: 1,
    head: "ref: refs/heads/main",
    refs: { "refs/heads/main": "b".repeat(40) },
    refScope: "all" as const,
    generatedAt: new Date(T0).toISOString(),
  };
  const protectedMembers = {
    pending,
    partial: { opaque: "partial" },
    attempt: { opaque: "attempt" },
    resolutionKey: "attention",
  } as unknown as Pick<NonNullable<SyncState["repoRecords"]>[string], "pending" | "partial" | "attempt" | "resolutionKey">;
  const initial = stateWith({
    repo: {
      repoGen: 8,
      sourceSeq: 3,
      ...protectedMembers,
      deferrals: { capture: busy(), apply },
    },
  });
  await saveStateUnsafeLegacyOrTest(root, initial);
  const result = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "ok", locks: [] }));
  const record = repoRecordsForState(result.state).repo!;
  expect(record.deferrals).toEqual({ apply });
  expect(record.pending).toEqual(protectedMembers.pending);
  expect(record.partial).toEqual(protectedMembers.partial);
  expect(record.attempt).toEqual(protectedMembers.attempt);
  expect(record.resolutionKey).toBe("attention");
});

test("design 178 C: live cohorts and inspection failures retain the exact episode", async () => {
  const episode = { ...busy(), forwardField: { untouched: true } } as GitDeferral;
  const initial = stateWith({ repo: { repoGen: 2, sourceSeq: 3, deferrals: { capture: episode } } });
  const lock = { path: "/tmp/index.lock", dev: "1", ino: "2", size: 0, mtimeMs: T0 - 10_000 };
  const live = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "ok", locks: [lock] }));
  expect(live.accepted).toBe(false);
  expect(repoRecordsForState(live.state).repo?.deferrals?.capture).toEqual(episode);
  const failed = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "indeterminate", detail: "EACCES" }));
  expect(failed.accepted).toBe(false);
  expect(repoRecordsForState(failed.state).repo?.deferrals?.capture).toEqual(episode);
  const unresolved = await reconcileGitDeferrals(root, CFG, initial, {
    ...depsFor({ status: "ok", locks: [] }),
    resolveRepoContext: async () => undefined,
  });
  expect(unresolved.accepted).toBe(false);
  expect(repoRecordsForState(unresolved.state).repo?.deferrals?.capture).toEqual(episode);
});

test("design 178 C: linked worktrees inspect one common dir and clear independently", async () => {
  const initial = stateWith({
    main: { repoGen: 1, sourceSeq: 3, deferrals: { capture: busy() } },
    wt: { repoGen: 7, sourceSeq: 3, deferrals: { apply: busy("apply") } },
  });
  await saveStateUnsafeLegacyOrTest(root, initial);
  await fs.mkdir(path.join(root, "main", ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "wt", ".git"), { recursive: true });
  await fs.mkdir(path.join(root, ".shared", "refs", "heads"), { recursive: true });
  const sharedLock = path.join(root, ".shared", "refs", "heads", "topic.lock");
  const mainLock = path.join(root, "main", ".git", "index.lock");
  await fs.writeFile(sharedLock, "");
  await fs.writeFile(mainLock, "");
  await fs.utimes(sharedLock, new Date(T0 - 20_000), new Date(T0 - 20_000));
  await fs.utimes(mainLock, new Date(T0 - 10_000), new Date(T0 - 10_000));
  let sharedCalls = 0;
  const overrides = {
    now: () => T0,
    resolveRepoContext: async (repoDir) => ctx(repoDir),
    inspectShared: async (commonDir: string) => { sharedCalls++; return inspectGitBusyShared(commonDir); },
  };
  const blocked = await reconcileGitDeferrals(root, CFG, initial, overrides);
  expect(blocked.accepted).toBe(false);
  expect(sharedCalls).toBe(1);
  expect([...blocked.displayDetails.values()].map((detail) => detail.lockCount).sort()).toEqual([1, 2]);
  await fs.rm(sharedLock);
  await fs.rm(mainLock);
  const cleared = await reconcileGitDeferrals(root, CFG, initial, overrides);
  expect(cleared.accepted).toBe(true);
  expect(sharedCalls).toBe(2);
  expect(cleared.commonDirsInspected).toBe(1);
  expect(repoRecordsForState(cleared.state).main?.deferrals).toBeUndefined();
  expect(repoRecordsForState(cleared.state).wt?.deferrals).toBeUndefined();
});

test("design 178 C: CAS loss reloads the newer reason and episode", async () => {
  const predecessor = busy();
  const newer = { ...predecessor, reason: "local-edits" as const, lastSeen: new Date(T0 + 1_000).toISOString() };
  const initial = stateWith({ repo: { repoGen: 1, sourceSeq: 3, deferrals: { capture: predecessor } } });
  const winner = stateWith({ repo: { repoGen: 2, sourceSeq: 3, deferrals: { capture: newer } } });
  const save = async (): Promise<StateSaveResult> => ({ status: "rejected", reason: "repo-generation", state: winner });
  const result = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "ok", locks: [] }, {
    save,
    reload: async () => winner,
  }));
  expect(result.accepted).toBe(false);
  expect(repoRecordsForState(result.state).repo?.deferrals?.capture).toEqual(newer);
});

test("design 178 C: repo-generation race reapplies only when the exact predecessor episode survives", async () => {
  const predecessor = busy();
  const initial = stateWith({ repo: { repoGen: 1, sourceSeq: 3, deferrals: { capture: predecessor } } });
  const winner = stateWith({ repo: { repoGen: 2, sourceSeq: 3, resolutionKey: "concurrent-attention", deferrals: { capture: predecessor } } });
  const accepted = stateWith({ repo: { repoGen: 3, sourceSeq: 3, resolutionKey: "concurrent-attention" } });
  let saves = 0;
  const save = async (_root: string, packet: StateSavePacket): Promise<StateSaveResult> => {
    saves++;
    if (saves === 1) return { status: "rejected", reason: "repo-generation", state: winner };
    expect(packet.repos).toHaveLength(1);
    expect(packet.repos[0]?.expectedRepoGen).toBe(2);
    expect(packet.repos[0]?.newRecord.resolutionKey).toBe("concurrent-attention");
    expect(packet.repos[0]?.newRecord.deferrals).toBeUndefined();
    return { status: "accepted", state: accepted };
  };
  const result = await reconcileGitDeferrals(root, CFG, initial, depsFor({ status: "ok", locks: [] }, {
    save,
    reload: async () => winner,
  }));
  expect(saves).toBe(2);
  expect(result.accepted).toBe(true);
  expect(repoRecordsForState(result.state).repo?.resolutionKey).toBe("concurrent-attention");
  expect(repoRecordsForState(result.state).repo?.deferrals).toBeUndefined();
});

test("design 178 C: unknown future reasons round-trip untouched and are never probed", async () => {
  const future = { ...busy("config"), reason: "future-reason", future: ["opaque", 9] } as unknown as GitDeferral;
  const initial = stateWith({
    future: { repoGen: 1, sourceSeq: 3, deferrals: { config: future } },
    stale: { repoGen: 1, sourceSeq: 3, deferrals: { capture: busy() } },
  });
  await saveStateUnsafeLegacyOrTest(root, initial);
  const probed: string[] = [];
  const result = await reconcileGitDeferrals(root, CFG, initial, {
    ...depsFor({ status: "ok", locks: [] }),
    resolveRepoContext: async (repoDir) => { probed.push(path.basename(repoDir)); return ctx(repoDir); },
  });
  expect(probed).toEqual(["stale"]);
  expect(repoRecordsForState(result.state).future?.deferrals?.config).toEqual(future);
});

test("design 178 C: two stable observations at 30s upgrade categorically, detail is recomputed, and removal clears", async () => {
  let now = T0;
  let locks = [{ path: path.join(root, "repo/.git/index.lock"), dev: "1", ino: "2", size: 0, mtimeMs: T0 - 10_000 }];
  const classifier = new GitBusyClassifier();
  const initial = stateWith({ repo: { repoGen: 1, sourceSeq: 3, deferrals: { capture: busy() } } });
  await saveStateUnsafeLegacyOrTest(root, initial);
  const overrides = {
    now: () => now,
    classifier,
    resolveRepoContext: async (repoDir: string) => ctx(repoDir),
    inspectShared: async (): Promise<GitBusySharedInspection> => ({ status: "ok", locks: [] }),
    inspectRepo: async (): Promise<GitBusyInspection> => ({ status: "ok", locks }),
  };
  const first = await reconcileGitDeferrals(root, CFG, initial, overrides);
  expect(first.accepted).toBe(false);
  expect(first.displayDetails.values().next().value).toMatchObject({ lockCount: 1, oldestAgeMs: 10_000 });
  now += 30_000;
  const upgraded = await reconcileGitDeferrals(root, CFG, initial, overrides);
  expect(upgraded.accepted).toBe(true);
  expect(repoRecordsForState(upgraded.state).repo?.deferrals?.capture?.reason).toBe("stale-unattributed");
  locks = [
    ...locks,
    { path: path.join(root, "repo/.git/HEAD.lock"), dev: "1", ino: "3", size: 0, mtimeMs: T0 + 5_000 },
  ];
  const detailed = await reconcileGitDeferrals(root, CFG, upgraded.state, overrides);
  expect(detailed.displayDetails.values().next().value).toMatchObject({ lockCount: 2, oldestAgeMs: 40_000 });
  locks = [];
  const cleared = await reconcileGitDeferrals(root, CFG, upgraded.state, overrides);
  expect(cleared.accepted).toBe(true);
  expect(repoRecordsForState(cleared.state).repo?.deferrals).toBeUndefined();
});

test("design 178 C: invalid or future lock timestamps classify indeterminate", async () => {
  const classifier = new GitBusyClassifier();
  for (const mtimeMs of [Number.NaN, T0 + 1]) {
    expect(classifier.classify(String(mtimeMs), {
      status: "ok",
      locks: [{ path: "/lock", dev: "1", ino: "2", size: 0, mtimeMs }],
    }, T0)).toBe("indeterminate");
  }
});
