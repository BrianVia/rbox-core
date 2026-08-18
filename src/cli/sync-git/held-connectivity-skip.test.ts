import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  type AppliedManifestOracle,
  type BlobStore,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import { applyGitSections } from "./apply.js";
import { captureGitState } from "./capture.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { settleCommittedBranchArtifacts, withRevalidatedGitPartialApplies } from "./received-git-transition-commit.js";
import { resetCheckoutCapabilityProbeCacheForTests } from "./checkout-txn.js";
import { GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS } from "./fingerprint.js";
import {
  repoRecordsForState,
  saveStateUnsafeLegacyOrTest,
  type GitDeferral,
  type RepoRecord,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";

/**
 * Design 278: a repo that defers at the checkout transaction's connectivity
 * proof is a self-sustaining fixpoint — every pull re-fetches, re-imports, and
 * fails the same proof. These cases run against real on-disk repositories and a
 * counting blob store, because the whole claim is about work that must stop
 * happening on the wire and in git spawns.
 */

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 19);

let tmp: string;
let sender: string;
let workspace: string;
let receiver: string;
let store: LocalBlobStore;
let cfg: WorkspaceConfig;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-278-"));
  sender = path.join(tmp, "sender");
  workspace = path.join(tmp, "workspace");
  receiver = path.join(workspace, "repo");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(workspace, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "c278@example.invalid");
  await git(sender, "config", "user.name", "c278");
  store = new LocalBlobStore(path.join(tmp, "blobs"));
  cfg = {
    remoteWorkspaceId: "ws_278", projectId: "root", deviceId: "receiver", rootPath: workspace,
    remoteUrl: "https://example.invalid", token: "", syncGit: true, encrypted: true, kek: KEK,
    accountId: "acct", accountEpoch: 0, keyEpoch: 0,
  };
});

afterEach(async () => {
  resetCheckoutCapabilityProbeCacheForTests();
  setGitSpawnObserver(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

const manifest = (section: GitSection): Manifest =>
  ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: { repo: section } });

const matchingOracle: AppliedManifestOracle = {
  proveRepo: async () => ({ kind: "match" }),
  reproveRepo: async () => ({ kind: "match" }),
  receiptHash: () => "receipt",
};

async function commit(content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(sender, "tracked.txt"), content);
  await git(sender, "add", "tracked.txt");
  await git(sender, "commit", "-qm", message);
  return git(sender, "rev-parse", "HEAD");
}

async function capture(basisTips?: string[]): Promise<GitSection> {
  const section = await captureGitState(sender, store, KEK, basisTips ? { basis: { tips: basisTips } } : {});
  if (!section) throw new Error("capture returned no section");
  return section;
}

async function materialize(section: GitSection): Promise<SyncState> {
  const empty: SyncState = {
    stream: "test-stream", stateNonce: "a".repeat(32), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  };
  const outcome = await applyGitSections(
    workspace, cfg, empty, manifest(section), store, buildIgnoreMatcher(workspace), () => {},
  );
  const record: RepoRecord = { repoGen: 1, sourceSeq: 1, base: section };
  if (outcome.branchBaseOrigins?.repo) record.branchBaseOrigins = outcome.branchBaseOrigins.repo;
  const initial: SyncState = {
    ...empty, lastSyncedSequence: 1, lastSyncedManifest: manifest(section), repoRecords: { repo: record },
  };
  await saveStateUnsafeLegacyOrTest(workspace, initial);
  return settleCommittedBranchArtifacts(workspace, initial, outcome);
}

/** The verbs that move bytes onto this receiver: any of them in cycle 2 means
 * the fixpoint is still paying for a bundle that changes nothing. */
const IMPORT_VERBS = new Set(["fetch", "unbundle", "index-pack", "bundle"]);

interface CycleCounts { blobGets: number; fetchOrImportSpawns: number }

/** One pull, instrumented exactly where design 278 promises the work stops. */
async function pull(state: SyncState, incoming: GitSection, sourceGlobalSeq: number, extra: Parameters<typeof applyGitSections>[7] = {}): Promise<{
  state: SyncState;
  logs: string[];
  counts: CycleCounts;
  record: RepoRecord | undefined;
  deferral: GitDeferral | undefined;
}> {
  const logs: string[] = [];
  const counts: CycleCounts = { blobGets: 0, fetchOrImportSpawns: 0 };
  const counting: BlobStore = {
    ...store,
    get: (sha) => { counts.blobGets += 1; return store.get(sha); },
  };
  setGitSpawnObserver((_root, args) => {
    if (args.some((arg) => IMPORT_VERBS.has(arg))) counts.fetchOrImportSpawns += 1;
  });
  try {
    const outcome = await applyGitSections(
      workspace, cfg, state, manifest(incoming), counting,
      buildIgnoreMatcher(workspace), (line) => logs.push(line),
      {
        oracle: matchingOracle,
        sourceGlobalSeq,
        capabilityProbe: async () => true,
        heldNow: () => Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 100,
        ...extra,
      },
    );
    const saved = await withRevalidatedGitPartialApplies(workspace, state, outcome, () =>
      saveStateSource(workspace, state, {
        expectedStream: "test-stream",
        sourceGlobalSeq,
        observedRepos: ["repo"],
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
      }));
    const next = await settleCommittedBranchArtifacts(workspace, saved, outcome);
    const record = repoRecordsForState(next).repo;
    return { state: next, logs, counts, record, deferral: record?.deferrals?.apply };
  } finally {
    setGitSpawnObserver(undefined);
  }
}

/** Rewrite the receiver's packed objects as loose ones so a single object can
 * be removed — the only way to reproduce an object database that is incomplete
 * below the ref plane. */
async function looseAllObjects(): Promise<void> {
  const packDir = path.join(receiver, ".git", "objects", "pack");
  for (const name of (await fs.readdir(packDir)).filter((entry) => entry.endsWith(".pack"))) {
    const kept = path.join(tmp, name);
    await fs.rename(path.join(packDir, name), kept);
    await fs.rm(path.join(packDir, `${name.slice(0, -5)}.idx`), { force: true });
    execFileSync("git", ["-C", receiver, "unpack-objects"], { env: TEST_GIT_ENV, input: await fs.readFile(kept) });
  }
}

/** The OTHER producer of `reason:"artifact"` with no attempt: the bundle's
 * basis names a tip this receiver never had, so `stageIncoming` fails before
 * any classification runs (follow.ts:64-67). It mints no typed code. */
async function unsatisfiableImportFixture(): Promise<{ state: SyncState; incoming: GitSection }> {
  await commit("one\n", "c1");
  const base = await capture();
  const state = await materialize(base);
  const c2 = await commit("two\n", "c2");
  await commit("three\n", "c3");
  const incoming = await capture([c2]);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  return { state, incoming };
}

/**
 * A repository whose import can never satisfy the planned-graph connectivity
 * proof. `main` is the checked-out branch and stays intact; an unrelated
 * `archive` branch (its own root o1 <- o2) loses o1's TREE from the receiver's
 * object database — the commit walk still succeeds, so classification is clean,
 * and only `fsck --connectivity-only` over the planned roots can see it. `archive` does not move in this sync, so the ref plane publishes
 * nothing for it — but it is still a planned graph root, because the proof is a
 * whole-graph fence. The incoming bundle is cut against basis tips the receiver
 * does have, so it verifies and imports on every pull and never re-supplies o1.
 * Every pull therefore fetches, decrypts, imports, fails the same proof, and
 * defers again: the fixpoint design 278 exists to break.
 */
async function connectivityFixpointFixture(): Promise<{ state: SyncState; incoming: GitSection }> {
  await commit("one\n", "c1");
  const c2 = await commit("two\n", "c2");
  await exec("git", ["-C", sender, "checkout", "-q", "--orphan", "archive"], { env: TEST_GIT_ENV });
  await fs.writeFile(path.join(sender, "archive.txt"), "archived one\n");
  await git(sender, "add", "archive.txt");
  await git(sender, "commit", "-qm", "archive root");
  const o1Tree = await git(sender, "rev-parse", "HEAD^{tree}");
  await fs.writeFile(path.join(sender, "archive.txt"), "archived two\n");
  await git(sender, "commit", "-qam", "archive tip");
  const o2 = await git(sender, "rev-parse", "HEAD");
  await git(sender, "checkout", "-q", "main");
  const base = await capture();
  const state = await materialize(base);

  await commit("three\n", "c3");
  const incoming = await capture([c2, o2]);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  await looseAllObjects();
  await fs.rm(path.join(receiver, ".git", "objects", o1Tree.slice(0, 2), o1Tree.slice(2)), { force: true });
  return { state, incoming };
}


test("red-first: a connectivity-defer fixpoint stops re-fetching the bundle that changes nothing", async () => {
  const { state, incoming } = await connectivityFixpointFixture();

  const one = await pull(state, incoming, 2);
  expect(one.logs).toEqual(["git-sync deferred repo: planned graph connectivity proof failed"]);
  expect(one.deferral?.reason).toBe("artifact");
  // M1: the exit that never stored anything now leaves a completed, bracketed
  // observation behind. Without it every later pull starts from "no-attempt".
  expect(one.record?.attempt?.blockers).toEqual([
    { provenance: "boundary", reason: "artifact", detail: "planned graph connectivity proof failed", code: "connectivity-unproven" },
  ]);
  expect(one.counts.blobGets).toBeGreaterThan(0);
  expect(one.counts.fetchOrImportSpawns).toBeGreaterThan(0);

  // Cycle 2 is the whole design: nothing is fetched, nothing is imported, and
  // the standing refusal keeps its age (design 273 P2).
  const two = await pull(one.state, incoming, 3);
  expect(two.counts).toEqual({ blobGets: 0, fetchOrImportSpawns: 0 });
  expect(two.deferral?.reason).toBe("artifact");
  expect(two.deferral?.deferredSince).toBe(one.deferral!.deferredSince);
  expect(two.deferral?.lastSeen).toBe(one.deferral!.lastSeen);
  expect(two.logs).toEqual([]);
});

test("the kill switch restores today's behaviour exactly", async () => {
  const saved = process.env.RBOX_GIT_CONNECTIVITY_SKIP;
  process.env.RBOX_GIT_CONNECTIVITY_SKIP = "0";
  try {
    const { state, incoming } = await connectivityFixpointFixture();
    const one = await pull(state, incoming, 2);
    expect(one.deferral?.reason).toBe("artifact");
    const two = await pull(one.state, incoming, 3);
    expect(two.counts.blobGets).toBeGreaterThan(0);
    expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
    expect(two.logs).toEqual(["git-sync deferred repo: planned graph connectivity proof failed"]);
  } finally {
    if (saved === undefined) delete process.env.RBOX_GIT_CONNECTIVITY_SKIP;
    else process.env.RBOX_GIT_CONNECTIVITY_SKIP = saved;
  }
});

test("a local commit in the deferred repository refuses the skip and re-proves", async () => {
  const { state, incoming } = await connectivityFixpointFixture();
  const one = await pull(state, incoming, 2);
  expect(one.record?.attempt).toBeDefined();

  await fs.writeFile(path.join(receiver, "local.txt"), "mine\n");
  await git(receiver, "add", "local.txt");
  await git(receiver, "commit", "-qm", "receiver work");

  const two = await pull(one.state, incoming, 3);
  expect(two.counts.blobGets).toBeGreaterThan(0);
  expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
});

test("a newly published sequence refuses the skip through the incoming key", async () => {
  const { state, incoming } = await connectivityFixpointFixture();
  const one = await pull(state, incoming, 2);
  expect(one.record?.attempt).toBeDefined();

  await commit("four\n", "c4");
  const next = await capture([await git(sender, "rev-parse", "HEAD~1")]);
  const two = await pull(one.state, next, 3);
  expect(two.counts.blobGets).toBeGreaterThan(0);
  expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
});

test("the hourly safety floor re-proves a repository that has been skipping", async () => {
  const { state, incoming } = await connectivityFixpointFixture();
  const one = await pull(state, incoming, 2);
  expect(one.record?.attempt).toBeDefined();

  const anHourAndAChangeLater = () => Date.now() + 61 * 60 * 1000;
  const two = await pull(one.state, incoming, 3, { heldNow: anHourAndAChangeLater });
  expect(two.counts.blobGets).toBeGreaterThan(0);
  expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
  expect(two.deferral?.reason).toBe("artifact");
});

test("producer isolation: a staging fetch/import failure stores no attempt and never rides the skip", async () => {
  const { state, incoming } = await unsatisfiableImportFixture();
  const one = await pull(state, incoming, 2);
  expect(one.deferral?.reason).toBe("artifact");
  expect(one.logs[0]).toContain("git artifact fetch/decrypt/import failed");
  // Same durable deferral reason as the connectivity class, and deliberately
  // no attempt: this producer mints no code, so it can never be allowlisted.
  expect(one.record?.attempt).toBeUndefined();

  const two = await pull(one.state, incoming, 3);
  expect(two.counts.blobGets).toBeGreaterThan(0);
  expect(two.record?.attempt).toBeUndefined();
});

test("a boundary race defers without storing an attempt, so the next pull re-attempts at once", async () => {
  await commit("one\n", "c1");
  const c1 = await git(sender, "rev-parse", "HEAD");
  await git(sender, "branch", "side");
  await commit("two\n", "c2");
  const base = await capture();
  const state = await materialize(base);
  await commit("three\n", "c3");
  await git(sender, "branch", "-f", "side", "main");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  // A concurrent writer moves an already-published ref inside the checkout
  // boundary. The transaction refuses, and its reason — `local-commits` — is one
  // the held allowlist admits on reason alone. Storing an attempt here would
  // stall a repository that is ready to apply until the hourly floor, so the M1
  // store is gated on the connectivity code and this exit must write nothing.
  let raced = false;
  const one = await pull(state, incoming, 2, {
    beforeCheckoutSecondProof: async () => {
      if (raced) return;
      raced = true;
      await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "side"), `${c1}\n`);
    },
  });
  expect(raced).toBe(true);
  expect(one.logs).toEqual(["git-sync deferred repo: published ref changed at refs/heads/side"]);
  expect(one.deferral?.reason).toBe("local-commits");
  expect(one.record?.attempt).toBeUndefined();

  const two = await pull(one.state, incoming, 3);
  expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
  expect(two.logs).toEqual(["git-sync followed repo"]);
});

test("a repository that moves inside the observation bracket stores nothing and keeps re-proving", async () => {
  // The store is fingerprint-bracketed (design 176 section 4 v6), so anything
  // that writes into the git directory while the classification is being
  // observed refuses it. That is the design's silent-degrade mode: correct, and
  // indistinguishable from "not fixed yet" unless it is pinned here.
  const { state, incoming } = await connectivityFixpointFixture();
  let mutated = false;
  const one = await pull(state, incoming, 2, {
    afterHeldClassification: async () => {
      if (mutated) return;
      mutated = true;
      await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${"0".repeat(39)}1\n`);
    },
  });
  expect(mutated).toBe(true);
  expect(one.deferral?.reason).toBe("artifact");
  expect(one.record?.attempt).toBeUndefined();

  const two = await pull(one.state, incoming, 3);
  expect(two.counts.blobGets).toBeGreaterThan(0);
  expect(two.counts.fetchOrImportSpawns).toBeGreaterThan(0);
  expect(two.logs).toEqual(["git-sync deferred repo: planned graph connectivity proof failed"]);
});
