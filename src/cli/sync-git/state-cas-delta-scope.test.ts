/**
 * Design 279 — the state CAS locks what THIS commit authored, not every partial
 * marker the workspace carries.
 *
 * A carried marker's CAS-time proof protects nothing: every consumer re-proves
 * before acting. These pins hold both halves — the lock set is delta-scoped, and
 * the use-time defenses that now carry the safety are exercised for real.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  type AppliedManifestOracle,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { MutationGateClosedError } from "../../engine/mutation-gate.js";
import {
  loadRawState,
  repoRecordsForState,
  saveStateUnsafeLegacyOrTest,
  type GitPartialApply,
  type RepoRecord,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { applyGitSections } from "./apply.js";
import { captureGitState } from "./capture.js";
import { resetCheckoutCapabilityProbeCacheForTests } from "./checkout-txn.js";
import { settleCommittedBranchArtifacts, withRevalidatedGitPartialApplies } from "./received-git-transition-commit.js";
import { gitIncomingKey } from "./shared.js";
import { stateCasJournalDir } from "./state-cas-locks.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());

let root = "";

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-279-scope-")); });
afterEach(async () => {
  resetCheckoutCapabilityProbeCacheForTests();
  delete process.env.RBOX_CAS_DELTA_LOCKS;
  await fs.rm(root, { recursive: true, force: true });
});

// ── direct CAS-plan pins ────────────────────────────────────────────────────

/** One initialized repository at `rel` carrying `count` branches at one commit. */
async function repoWithBranches(rel: string, count: number): Promise<{ dir: string; refs: string[]; oid: string }> {
  const dir = path.join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await fs.writeFile(path.join(dir, "seed"), "seed\n");
  await git(dir, "add", "seed");
  await git(dir, "commit", "-qm", "seed");
  const oid = await git(dir, "rev-parse", "HEAD");
  const refs = ["refs/heads/main"];
  for (let index = 1; index < count; index++) {
    const ref = `refs/heads/b${index}`;
    await git(dir, "update-ref", ref, oid);
    refs.push(ref);
  }
  return { dir, refs, oid };
}

function marker(refs: string[], oid: string, incomingKey = "k1"): GitPartialApply {
  return {
    incomingKey, checkoutPending: false, configApplied: true, heldRefs: {},
    appliedRefs: Object.fromEntries(refs.map((ref) => [ref, { kind: "direct" as const, oid }])),
  };
}

async function persistRecords(records: Record<string, RepoRecord>): Promise<SyncState> {
  await saveStateUnsafeLegacyOrTest(root, {
    stream: "stream", stateNonce: "1".repeat(32), stateRevision: 1, lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "old", files: [], gitRepos: {} },
    repoRecords: records,
  });
  const loaded = await loadRawState(root);
  if (!loaded) throw new Error("fixture state unavailable");
  return loaded;
}

interface CasRun {
  locks: { locks: number; blocked: number } | undefined;
  heldLockFiles: string[];
  journalEntries: string[];
}

/** Run the commit window and observe exactly what it locked. */
async function runCas(
  state: SyncState,
  outcome: Parameters<typeof withRevalidatedGitPartialApplies>[2],
  options: Parameters<typeof withRevalidatedGitPartialApplies>[4] = {},
): Promise<CasRun> {
  const run: CasRun = { locks: undefined, heldLockFiles: [], journalEntries: [] };
  await withRevalidatedGitPartialApplies(root, state, outcome, async () => {
    run.heldLockFiles = await listLockFiles();
    run.journalEntries = await fs.readdir(stateCasJournalDir(root)).catch(() => []);
  }, { ...options, observeLockCounts: (locks, blocked) => { run.locks = { locks, blocked }; } });
  return run;
}

async function listLockFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".lock")) found.push(path.relative(root, full));
    }
  };
  await walk(root);
  return found.sort();
}

test("(b) a steady pull with carried markers plans no locks and writes no journal", async () => {
  const a = await repoWithBranches("carried-a", 3);
  const b = await repoWithBranches("carried-b", 4);
  const state = await persistRecords({
    "carried-a": { repoGen: 1, sourceSeq: 1, partial: marker(a.refs, a.oid) },
    "carried-b": { repoGen: 1, sourceSeq: 1, partial: marker(b.refs, b.oid) },
  });

  const run = await runCas(state, {});

  expect(run.locks).toBeUndefined();
  expect(run.heldLockFiles).toEqual([]);
  expect(run.journalEntries).toEqual([]);
  expect(await fs.readdir(stateCasJournalDir(root)).catch(() => [])).toEqual([]);
});

test("(c) an authoring pull plans exactly the refs it authored", async () => {
  const carried = await repoWithBranches("carried", 3);
  const authored = await repoWithBranches("authored", 2);
  const state = await persistRecords({
    carried: { repoGen: 1, sourceSeq: 1, partial: marker(carried.refs, carried.oid) },
    authored: { repoGen: 1, sourceSeq: 1 },
  });

  const run = await runCas(state, { partial: { authored: marker(authored.refs, authored.oid) } });

  expect(run.locks).toEqual({ locks: 2, blocked: 0 });
  expect(run.heldLockFiles).toEqual([
    "authored/.git/refs/heads/b1.lock",
    "authored/.git/refs/heads/main.lock",
  ]);
});

test("(d) RBOX_CAS_DELTA_LOCKS=0 restores the carried+authored union", async () => {
  const carried = await repoWithBranches("carried", 3);
  const authored = await repoWithBranches("authored", 2);
  const state = await persistRecords({
    carried: { repoGen: 1, sourceSeq: 1, partial: marker(carried.refs, carried.oid) },
    authored: { repoGen: 1, sourceSeq: 1 },
  });
  process.env.RBOX_CAS_DELTA_LOCKS = "0";

  const run = await runCas(state, { partial: { authored: marker(authored.refs, authored.oid) } });

  expect(run.locks).toEqual({ locks: 5, blocked: 0 });
});

test("(e) two repositories sharing a common dir and refname dedupe to one lock carrying both proofs", async () => {
  const main = await repoWithBranches("shared", 1);
  await git(main.dir, "branch", "linked", main.oid);
  await git(main.dir, "worktree", "add", "-q", path.join(root, "linked"), "linked");
  const state = await persistRecords({
    shared: { repoGen: 1, sourceSeq: 1 },
    linked: { repoGen: 1, sourceSeq: 1 },
  });
  const shared = marker(["refs/heads/linked"], main.oid);

  const run = await runCas(state, { partial: { shared, linked: shared } });

  expect(run.locks).toEqual({ locks: 1, blocked: 0 });
  expect(run.heldLockFiles).toEqual(["shared/.git/refs/heads/linked.lock"]);
});

test("(f) a blocked shared lock drops only the authoring repository's marker", async () => {
  const main = await repoWithBranches("shared", 1);
  await git(main.dir, "branch", "linked", main.oid);
  await git(main.dir, "worktree", "add", "-q", path.join(root, "linked"), "linked");
  const shared = marker(["refs/heads/linked"], main.oid);
  const state = await persistRecords({
    shared: { repoGen: 1, sourceSeq: 1 },
    linked: { repoGen: 1, sourceSeq: 1, partial: shared },
  });
  await fs.writeFile(path.join(main.dir, ".git", "refs", "heads", "linked.lock"), "foreign\n");
  const outcome = { partial: { shared } };

  await withRevalidatedGitPartialApplies(root, state, outcome, async () => undefined);

  expect(outcome.partial).toEqual({ shared: null });
});

test("(h) a steady zero-lock pull refused at the commit boundary leaves no journal residue", async () => {
  const carried = await repoWithBranches("carried", 3);
  const state = await persistRecords({
    carried: { repoGen: 1, sourceSeq: 1, partial: marker(carried.refs, carried.oid) },
  });
  let saved = false;
  let beginCommits = 0;
  const steps: string[] = [];

  await expect(withRevalidatedGitPartialApplies(root, state, {}, async () => { saved = true; }, {
    observeStep: (step) => { steps.push(step); },
    mutationBoundary: {
      enter: () => ({
        get abortRequested() { return false; },
        beginCommit: () => { beginCommits++; return false; },
        finish: () => {},
      }),
    },
  })).rejects.toBeInstanceOf(MutationGateClosedError);

  expect(saved).toBe(false);
  expect(beginCommits).toBe(1);
  // Abortable all the way to the save: no lock was ever acquired to commit on.
  expect(steps).not.toContain("acquire");
  expect(await fs.readdir(stateCasJournalDir(root)).catch(() => [])).toEqual([]);
  expect(await listLockFiles()).toEqual([]);
});

test("(i) a carried marker whose incoming key no longer matches is inert: no lock, no drop", async () => {
  const carried = await repoWithBranches("immortal", 3);
  const stale = marker(carried.refs, carried.oid, "superseded-key");
  const state = await persistRecords({
    immortal: { repoGen: 1, sourceSeq: 1, partial: stale },
  });
  await git(carried.dir, "update-ref", "-d", "refs/heads/b1");
  const outcome = {};

  const run = await runCas(state, outcome);

  expect(run.locks).toBeUndefined();
  // Not re-proved, not dropped — it keeps the proof it was committed with, and
  // consumption is the only thing that may ever retire it.
  expect(outcome).toEqual({});
  expect(repoRecordsForState(state).immortal?.partial).toEqual(stale);
});

// ── apply-seam pins, against real repositories ──────────────────────────────

const KEK = Buffer.alloc(32, 79);
const REL = "repo";

interface Bench {
  sender: string;
  workspace: string;
  receiver: string;
  store: LocalBlobStore;
  cfg: WorkspaceConfig;
}

const oracle: AppliedManifestOracle = {
  proveRepo: async () => ({ kind: "match" }),
  reproveRepo: async () => ({ kind: "match" }),
  receiptHash: () => "receipt",
};

const manifestOf = (section: GitSection): Manifest =>
  ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: { [REL]: section } });

async function bench(): Promise<Bench> {
  const sender = path.join(root, "sender");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(workspace, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "c279@example.invalid");
  await git(sender, "config", "user.name", "c279");
  return {
    sender, workspace, receiver: path.join(workspace, REL),
    store: new LocalBlobStore(path.join(root, "blobs")),
    cfg: {
      remoteWorkspaceId: "ws_279", projectId: "root", deviceId: "receiver", rootPath: workspace,
      remoteUrl: "https://example.invalid", token: "", syncGit: true, encrypted: true, kek: KEK,
      accountId: "acct", accountEpoch: 0, keyEpoch: 0,
    },
  };
}

async function senderCommit(bx: Bench, content: string, message: string): Promise<void> {
  await fs.writeFile(path.join(bx.sender, "tracked.txt"), content);
  await git(bx.sender, "add", "tracked.txt");
  await git(bx.sender, "commit", "-qm", message);
}

async function capture(bx: Bench): Promise<GitSection> {
  const section = await captureGitState(bx.sender, bx.store, KEK, {});
  if (!section) throw new Error("capture returned no section");
  return section;
}

/** One pull through the production apply + commit window. */
async function pullOnce(bx: Bench, state: SyncState, incoming: GitSection, seq: number): Promise<{
  state: SyncState;
  outcome: Awaited<ReturnType<typeof applyGitSections>>;
  locks: number;
}> {
  const outcome = await applyGitSections(
    bx.workspace, bx.cfg, state, manifestOf(incoming), bx.store,
    buildIgnoreMatcher(bx.workspace), () => {},
    { oracle, sourceGlobalSeq: seq, capabilityProbe: async () => true },
  );
  let locks = 0;
  const saved = await withRevalidatedGitPartialApplies(bx.workspace, state, outcome, () =>
    saveStateSource(bx.workspace, state, {
      expectedStream: state.stream, sourceGlobalSeq: seq, observedRepos: [REL],
      repoProofs: outcome.repoProofs,
      values: {
        bases: outcome.gitRepos,
        branchBaseOrigins: outcome.branchBaseOrigins,
        pending: outcome.gitPendingRemote,
        resolutions: outcome.gitNeedsResolution,
        deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), outcome.deferrals),
        partial: outcome.partial,
        attempt: outcome.attempt,
        idxProj: outcome.idxProj,
      },
    }), { observeLockCounts: (count) => { locks = count; } });
  return { state: await settleCommittedBranchArtifacts(bx.workspace, saved, outcome), outcome, locks };
}

async function materialize(bx: Bench, section: GitSection): Promise<SyncState> {
  const empty: SyncState = {
    stream: "test-stream", stateNonce: "a".repeat(32), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  };
  const outcome = await applyGitSections(
    bx.workspace, bx.cfg, empty, manifestOf(section), bx.store, buildIgnoreMatcher(bx.workspace), () => {},
  );
  const record: RepoRecord = { repoGen: 1, sourceSeq: 1, base: section };
  if (outcome.branchBaseOrigins?.[REL]) record.branchBaseOrigins = outcome.branchBaseOrigins[REL];
  const initial: SyncState = {
    ...empty, lastSyncedSequence: 1, lastSyncedManifest: manifestOf(section), repoRecords: { [REL]: record },
  };
  await saveStateUnsafeLegacyOrTest(bx.workspace, initial);
  return settleCommittedBranchArtifacts(bx.workspace, initial, outcome);
}

test("(a) a steady no-op pull authors no partial marker and therefore plans no locks", async () => {
  const bx = await bench();
  await senderCommit(bx, "one\n", "c1");
  const section = await capture(bx);
  const state = await materialize(bx, section);

  const cycle = await pullOnce(bx, state, section, 2);

  // The "→0" claim: a repository that changed nothing contributes no non-null
  // partial entry, so the delta-scoped plan has nothing to lock.
  expect(cycle.outcome.partial?.[REL] ?? null).toBeNull();
  expect(cycle.locks).toBe(0);
});

test("(g) a carried marker that went stale is dropped and held by the next consuming pull", async () => {
  const bx = await bench();
  await senderCommit(bx, "one\n", "c1");
  const base = await capture(bx);
  const state = await materialize(bx, base);
  await senderCommit(bx, "two\n", "c2");
  const incoming = await capture(bx);

  // A carried marker claiming refs that an external writer has since moved. No
  // pull consumed it, so nothing re-proved it at any CAS in between.
  const stale = marker(["refs/heads/main"], "0".repeat(40), gitIncomingKey(incoming));
  const records = repoRecordsForState(state);
  const withMarker: SyncState = {
    ...state,
    repoRecords: { [REL]: { ...records[REL]!, partial: stale } },
  };
  await saveStateUnsafeLegacyOrTest(bx.workspace, withMarker);

  const cycle = await pullOnce(bx, (await loadRawState(bx.workspace))!, incoming, 3);

  // Use-time re-proof carries what the CAS-time proof gave up: the marker is
  // dropped and its refs are held rather than trusted.
  expect(cycle.outcome.partial?.[REL] ?? null).toBeNull();
  expect(repoRecordsForState(cycle.state)[REL]?.partial).toBeUndefined();
});
