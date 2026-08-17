import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore, buildIgnoreMatcher, hashBytes, oracleFromState, probeReceiverEquivalence, scanManifest, setReceiverEquivalenceProbeForTests, type AppliedManifestOracle, type GitSection, type Manifest } from "../../engine/index.js";
import { BASE_ABSENT_PREFIX, BASE_PRESENT_PREFIX, SETTLED_ABSENCE_PREFIX } from "./base-artifacts.js";
import { checkoutJournalPresent } from "./journal.js";
import { captureGitState } from "./capture.js";
import { indexIdentityV2 } from "./index-identity.js";
import { ownershipProofContext } from "./reachability.js";
import { resetCheckoutCapabilityProbeCacheForTests } from "./checkout-txn.js";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import { keepPinRef, readKeepPinOrigins } from "./keep-pins.js";
import { hasInProgressOpState, readOpStateSnapshot } from "./refs.js";
import { repoCtx } from "./git-state.js";
import { OP_STATE_CLASSIFICATION, OP_STATE_DIRS, OP_STATE_FILES } from "../../engine/manifest-validate.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, syncStreamId, type RepoRecord, type SyncState, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { applyPulledManifest } from "../sync.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { applyGitSections } from "./apply.js";
import { settleCommittedBranchArtifacts, withRevalidatedGitPartialApplies } from "./received-git-transition-commit.js";
import { CONFLICT_COPY_POPULATION_WHY } from "../../engine/apply-receipt.js";
import { checkoutJournalBinding, classifyCheckoutOwnership, FollowCrashInjectedError, followDivergedRepo, recoverFollowJournal, selectCheckoutSelfRootWitness, type FollowCrashPoint } from "./follow.js";
import { opStateDetailToken } from "./follow-classify.js";
import { boundedOrigHeadPreservationError, origHeadPreservationFailureLine, origHeadWorktreeDiscriminator } from "./orig-head.js";
import { heldBlockersAllowSkip } from "./held-blockers.js";
import { planGitSections } from "./plan.js";
import { GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS, gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { fingerprintHitProbe, type GitDivergenceCache } from "./divergence-cache.js";
import { configCredentialSkipLogged, configInvalidSkipLogged, configOwnershipSkipLogged, gitFollowEnabled, gitIncomingKey, repoEquivalenceWarningLogged } from "./shared.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const gitExec = (args: string[]) => exec("git", args, { env: TEST_GIT_ENV });
const git = (dir: string, ...args: string[]) => gitExec(["-C", dir, ...args]).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 19);
const heldNowAfterRacyWindow = () => Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 100;

const hostReceiverEquivalence = await (async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-equivalence-"));
  try {
    return await probeReceiverEquivalence(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})();

let tmp: string;
let sender: string;
let workspace: string;
let receiver: string;
let store: LocalBlobStore;
let cfg: WorkspaceConfig;
let priorGitFollow: string | undefined;
let priorTraceHeld: string | undefined;
let materializedSection: GitSection | undefined;
let materializedState: SyncState | undefined;

beforeEach(async () => {
  priorGitFollow = process.env.RBOX_GIT_FOLLOW;
  priorTraceHeld = process.env.RBOX_TRACE_HELD;
  materializedSection = undefined;
  materializedState = undefined;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-"));
  sender = path.join(tmp, "sender");
  workspace = path.join(tmp, "workspace");
  receiver = path.join(workspace, "repo");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(workspace, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "follow@example.invalid");
  await git(sender, "config", "user.name", "follow");
  store = new LocalBlobStore(path.join(tmp, "blobs"));
  cfg = {
    remoteWorkspaceId: "ws_follow",
    projectId: "root",
    deviceId: "receiver",
    rootPath: workspace,
    remoteUrl: "https://example.invalid",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});

afterEach(async () => {
  if (priorGitFollow === undefined) delete process.env.RBOX_GIT_FOLLOW;
  else process.env.RBOX_GIT_FOLLOW = priorGitFollow;
  if (priorTraceHeld === undefined) delete process.env.RBOX_TRACE_HELD;
  else process.env.RBOX_TRACE_HELD = priorTraceHeld;
  resetCheckoutCapabilityProbeCacheForTests();
  setReceiverEquivalenceProbeForTests(undefined);
  setGitSpawnObserver(undefined);
  configOwnershipSkipLogged.clear();
  configInvalidSkipLogged.clear();
  configCredentialSkipLogged.clear();
  repoEquivalenceWarningLogged.clear();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function commit(content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(sender, "tracked.txt"), content);
  await git(sender, "add", "tracked.txt");
  await git(sender, "commit", "-qm", message);
  return git(sender, "rev-parse", "HEAD");
}

const manifest = (section: GitSection): Manifest => ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: { repo: section } });
const stateWith = (section?: GitSection): SyncState => {
  if (section && section === materializedSection && materializedState) return structuredClone(materializedState);
  const state: SyncState = {
    stream: "test-stream",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: section ? 1 : 0,
    lastSyncedManifest: section ? manifest(section) : { generatedAt: "", files: [] },
  };
  if (section) state.repoRecords = { repo: { repoGen: 1, sourceSeq: 1, base: section } };
  return state;
};

const matchingOracle: AppliedManifestOracle = {
  proveRepo: async () => ({ kind: "match" }),
  reproveRepo: async () => ({ kind: "match" }),
  receiptHash: () => "receipt",
};

async function capture(): Promise<GitSection> {
  const section = await captureGitState(sender, store, KEK);
  if (!section) throw new Error("capture returned no section");
  return section;
}

async function materialize(section: GitSection): Promise<void> {
  const empty = stateWith();
  const outcome = await applyGitSections(workspace, cfg, empty, manifest(section), store, buildIgnoreMatcher(workspace), () => {});
  expect(outcome.gitRepos?.repo).toEqual(section);
  const record: RepoRecord = { repoGen: 1, sourceSeq: 1, base: section };
  if (outcome.branchBaseOrigins?.repo) record.branchBaseOrigins = outcome.branchBaseOrigins.repo;
  const initial: SyncState = {
    ...empty,
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(section),
    repoRecords: { repo: record },
  };
  await saveStateUnsafeLegacyOrTest(workspace, initial);
  materializedSection = section;
  materializedState = await settleCommittedBranchArtifacts(workspace, initial, outcome);
}

async function baseAndIncoming(mode: "same" | "switch" | "detached" = "same"): Promise<{ c1: string; base: GitSection; incoming: GitSection; state: SyncState }> {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  const base = await capture();
  await materialize(base);
  if (mode === "switch") await git(sender, "checkout", "-qb", "next");
  else if (mode === "detached") await git(sender, "checkout", "-q", "--detach");
  await commit("three\n", "c3");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  return { c1, base, incoming, state: stateWith(base) };
}

const SWITCH_BACK_REF = "refs/heads/feature/prop-test";

async function switchBackFixture(): Promise<{
  base: GitSection;
  incoming: GitSection;
  state: SyncState;
  mainTip: string;
  featureTip: string;
}> {
  await commit("one\n", "switch-back-c1");
  const mainTip = await commit("two\n", "switch-back-c2");
  await git(sender, "checkout", "-qb", SWITCH_BACK_REF.replace(/^refs\/heads\//, ""));
  const featureTip = await commit("feature\n", "switch-back-feature");
  const base = await capture();
  await materialize(base);
  await git(sender, "switch", "-q", "main");
  const incoming = await capture();
  // The file plane has already applied the incoming main snapshot when Git
  // follow runs in production.
  await fs.writeFile(path.join(receiver, "tracked.txt"), "two\n");
  return { base, incoming, state: stateWith(base), mainTip, featureTip };
}

async function breadcrumbBaseAndIncoming(opts: { markerRel?: string; incomingAbsent?: boolean } = {}): Promise<{
  c1: string; c2: string; c3: string; base: GitSection; incoming: GitSection; state: SyncState;
}> {
  const c1 = await commit("one\n", "breadcrumb-c1");
  const c2 = await commit("two\n", "breadcrumb-c2");
  await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${c1}\n`);
  let markerBytes: string | undefined;
  if (opts.markerRel) {
    markerBytes = opts.markerRel === "AUTO_MERGE" ? `${await git(sender, "rev-parse", `${c1}^{tree}`)}\n`
      : ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].includes(opts.markerRel) ? `${c1}\n`
      : `synced ${opts.markerRel}\n`;
    await fs.mkdir(path.dirname(path.join(sender, ".git", opts.markerRel)), { recursive: true });
    await fs.writeFile(path.join(sender, ".git", opts.markerRel), markerBytes);
  }
  const base = await capture();
  if (opts.markerRel) {
    const top = opts.markerRel.split("/")[0]!;
    await fs.rm(path.join(sender, ".git", top), { recursive: opts.markerRel.includes("/"), force: true });
  }
  await materialize(base);
  const c3 = await commit("three\n", "breadcrumb-c3");
  if (opts.markerRel) {
    await fs.mkdir(path.dirname(path.join(sender, ".git", opts.markerRel)), { recursive: true });
    await fs.writeFile(path.join(sender, ".git", opts.markerRel), markerBytes!);
  }
  if (opts.incomingAbsent) await fs.rm(path.join(sender, ".git", "ORIG_HEAD"), { force: true });
  else await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${c2}\n`);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${c3}\n`);
  return { c1, c2, c3, base, incoming, state: stateWith(base) };
}

async function applyIncoming(state: SyncState, incoming: GitSection, oracle: AppliedManifestOracle = matchingOracle, extra: Parameters<typeof applyGitSections>[7] = {}) {
  const logs: string[] = [];
  const outcome = await applyGitSections(workspace, cfg, state, manifest(incoming), store, buildIgnoreMatcher(workspace), (line) => logs.push(line), {
    oracle,
    sourceGlobalSeq: 2,
    capabilityProbe: async () => true,
    ...extra,
  });
  return { outcome, logs };
}

async function convertReceiverToLinkedWorktree(): Promise<Awaited<ReturnType<typeof repoCtx>>> {
  const primary = path.join(tmp, "receiver-primary");
  await fs.rename(receiver, primary);
  await git(primary, "checkout", "-q", "--detach");
  await git(primary, "worktree", "add", "-q", receiver, "main");
  return repoCtx(receiver);
}

async function rebaseClassifierState(repoDir: string): Promise<boolean> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("rebase fixture context missing");
  const snapshot = await readOpStateSnapshot(ctx.gitDir, async (file) => hashBytes(await fs.readFile(file)));
  return hasInProgressOpState(snapshot);
}

async function initConflictingRebase(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  await git(repoDir, "init", "-qb", "main");
  await git(repoDir, "config", "user.email", "follow@example.invalid");
  await git(repoDir, "config", "user.name", "follow");
  await fs.writeFile(path.join(repoDir, "conflict.txt"), "base\n");
  await git(repoDir, "add", "conflict.txt");
  await git(repoDir, "commit", "-qm", "base");
  await git(repoDir, "checkout", "-qb", "topic");
  await fs.writeFile(path.join(repoDir, "conflict.txt"), "topic\n");
  await git(repoDir, "commit", "-qam", "topic");
  await git(repoDir, "checkout", "-q", "main");
  await fs.writeFile(path.join(repoDir, "conflict.txt"), "main\n");
  await git(repoDir, "commit", "-qam", "main");
  await git(repoDir, "checkout", "-q", "topic");
  await gitExec(["-C", repoDir, "rebase", "main"]).catch(() => undefined);
}

async function landOutcome(state: SyncState, outcome: Awaited<ReturnType<typeof applyGitSections>>, sourceGlobalSeq: number): Promise<SyncState> {
  const saved = await withRevalidatedGitPartialApplies(workspace, state, outcome, () => saveStateSource(workspace, state, {
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
  return settleCommittedBranchArtifacts(workspace, saved, outcome);
}

test("RBOX_GIT_FOLLOW parses only exact zero as disabled", () => {
  expect(gitFollowEnabled({})).toBe(true);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "0" })).toBe(false);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "00" })).toBe(true);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "invalid" })).toBe(true);
});

test("issue 569: follow-shaped current plus N stash proofs stay constant-spawn and preserve mapping", async () => {
  const base = await commit("base\n", "spawn base");
  const rootOne = await commit("root one\n", "spawn root one");
  const rootTwo = await commit("root two\n", "spawn root two");
  await git(sender, "checkout", "-qb", "receiver-local", base);
  const localTips: string[] = [];
  for (let i = 0; i < 40; i++) {
    await git(sender, "commit", "--allow-empty", "-qm", `local stash-like ${i}`);
    localTips.push(await git(sender, "rev-parse", "HEAD"));
  }
  const ctx = await repoCtx(sender);
  if (!ctx) throw new Error("sender context missing");
  const proofContext = await ownershipProofContext(ctx);
  const roots = [rootOne, rootTwo];

  const unreadableReflog = await classifyCheckoutOwnership(
    sender,
    localTips.at(-1),
    roots,
    proofContext,
    async () => { throw new Error("forced reflog read failure"); },
  );
  expect(unreadableReflog.reasons).toEqual(["local-commits", "unreadable"]);
  expect(unreadableReflog.details).toEqual([
    "current tip has receiver-only commits",
    "stash reflog could not be read",
  ]);

  const missing = "f".repeat(40);
  const mixedStash = await classifyCheckoutOwnership(
    sender,
    base,
    roots,
    proofContext,
    async () => [localTips[0]!, missing],
  );
  expect(mixedStash.reasons).toEqual(["local-stash", "unreadable"]);
  expect(mixedStash.details).toEqual([
    "stash reflog contains receiver-only work",
    "stash reachability missing-object",
  ]);

  const observe = async (tips: readonly string[]) => {
    const commands: string[][] = [];
    setGitSpawnObserver((_root, args) => commands.push([...args]));
    const classification = await classifyCheckoutOwnership(
      sender,
      base,
      roots,
      proofContext,
      async () => tips,
    );
    setGitSpawnObserver(undefined);
    return { classification, commands };
  };
  const small = await observe(localTips.slice(0, 2));
  const large = await observe(localTips);
  expect(small.classification.reasons).toEqual(["local-stash", "local-stash"]);
  expect(large.classification.reasons).toEqual(Array.from({ length: localTips.length }, () => "local-stash"));
  expect(large.commands).toHaveLength(small.commands.length);
  expect(large.commands.length).toBeLessThanOrEqual(10);
  expect(large.commands.map((args) => args[0])).toEqual(["cat-file", "rev-list", "rev-list"]);
  expect(large.commands.some((args) => args[0] === "merge-base")).toBe(false);
});

test("contained attached tip follows HEAD, tip, and semantic index with BASE equality", async () => {
  const setup = await baseAndIncoming();
  const { c1, base, state } = setup;
  await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${c1}\n`);
  const incoming = await capture();
  const baseTip = await git(receiver, "rev-parse", "refs/heads/main");

  const { outcome, logs } = await applyIncoming(state, incoming);

  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(await fs.readFile(path.join(receiver, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  const liveProjection = await indexIdentityV2(receiver, path.join(receiver, ".git", "index"));
  expect(liveProjection).toBe(outcome.idxProj?.repo);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(await fs.readFile(path.join(receiver, ".git", "MERGE_HEAD"), "utf8")).toBe(`${c1}\n`);

  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal"))).toEqual([]);
});

test("§130 checked-out branch without live/BASE equality holds and never invents P authority", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const baseTip = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, baseTip);
  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeDefined();
  expect(result.logs.some((line) => line.includes("branch transition does not match logical BASE pre-state"))).toBe(true);
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(c1);
});

test("§130 follower prune crosses publishRefPlane, survives carry, fingerprints reflog, and compacts A to Z", async () => {
  const topic = "refs/heads/topic";
  await commit("main base\n", "main base");
  await git(sender, "checkout", "-qb", "topic");
  const topicTip = await commit("topic work\n", "topic work");
  await git(sender, "checkout", "-q", "main");
  const base = await capture();
  await materialize(base);
  let state = stateWith(base);

  // An uneventful pull must not erase the positive origin needed by a later
  // exact attestation.
  const unchanged = await applyIncoming(state, base);
  state = await landOutcome(state, unchanged.outcome, 2);
  expect(state.repoRecords?.repo?.branchBaseOrigins?.[topic]?.oid).toBe(topicTip);

  // Model the common squash-merge-delete publisher workflow.
  await git(sender, "merge", "--squash", "topic");
  await git(sender, "commit", "-qm", "squash topic");
  await git(sender, "branch", "-D", "topic");
  const omitted = await capture();
  const held = await applyIncoming(state, omitted);
  expect(held.outcome.partial?.repo?.heldRefs[topic]).toBe("local-commits");
  expect(await git(receiver, "rev-parse", topic)).toBe(topicTip);
  state = await landOutcome(state, held.outcome, 3);

  const tombstoned: GitSection = {
    ...omitted,
    refTombstones: { [topic]: [{ oid: topicTip, ts: new Date().toISOString(), generation: 1 }] },
    refTombstoneGeneration: 1,
  };
  // Create receiver-only U without moving the working checkout. The injected
  // T→U→T episode lands after pin enumeration; expected-old still sees T, so
  // only the widened reflog fingerprint can abort the first prune.
  const tree = await git(receiver, "rev-parse", `${topicTip}^{tree}`);
  const u = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", topicTip, "-m", "reflog-only U"])
    .then(({ stdout }) => stdout.toString().trim());
  let injected = false;
  const raced = await applyIncoming(state, tombstoned, matchingOracle, {
    afterBranchPinsPrepared: async (ref) => {
      if (ref !== topic || injected) return;
      injected = true;
      await git(receiver, "update-ref", topic, u, topicTip);
      await git(receiver, "update-ref", topic, topicTip, u);
    },
  });
  expect(injected).toBe(true);
  expect(await git(receiver, "rev-parse", topic)).toBe(topicTip);
  expect(await git(receiver, "for-each-ref", "--format=%(refname)", BASE_ABSENT_PREFIX)).toBe("");
  expect(raced.logs.some((line) => line.startsWith("git-sync: pruned tombstoned branch"))).toBe(false);

  const pruned = await applyIncoming(state, tombstoned);
  const success = pruned.logs.filter((line) => line.startsWith(`git-sync: pruned tombstoned branch ${topic} `));
  expect(success).toEqual([`git-sync: pruned tombstoned branch ${topic} (was ${topicTip.slice(0, 12)})`]);
  expect(success[0]!.length).toBeLessThan(180);
  expect(await git(receiver, "rev-parse", "--verify", "--quiet", topic).catch(() => "")).toBe("");
  expect(await git(receiver, "rev-parse", keepPinRef(u))).toBe(u);
  expect((await readKeepPinOrigins(receiver))[u]?.some((origin) => origin.ref === topic && origin.class === "human")).toBe(true);

  state = await landOutcome(state, pruned.outcome, 4);
  expect(state.repoRecords?.repo?.base?.refs[topic]).toBeUndefined();
  expect(state.repoRecords?.repo?.branchBaseOrigins?.[topic]).toBeUndefined();
  expect(await git(receiver, "for-each-ref", "--format=%(refname)", BASE_ABSENT_PREFIX)).toBe("");
  expect((await git(receiver, "for-each-ref", "--format=%(refname)", SETTLED_ABSENCE_PREFIX)).split("\n").filter(Boolean)).toHaveLength(1);
});

test("design 200 P3 real publish loop waives only a non-destructive cascade and never feeds a branch deletion", async () => {
  const topicRef = "refs/heads/topic-p3";
  const carrierRef = "refs/heads/carrier-p3";
  const baseTip = await commit("base\n", "p3 base");

  await git(sender, "checkout", "-qb", "topic-p3", baseTip);
  const topicTip = await commit("topic\n", "p3 topic");
  await git(sender, "checkout", "-qb", "stash-line", baseTip);
  const stashOld = await commit("stash old\n", "p3 stash old");
  await git(sender, "update-ref", "refs/stash", stashOld);
  await git(sender, "checkout", "-qb", "carrier-p3", baseTip);
  await commit("carrier old\n", "p3 carrier old");
  await git(sender, "checkout", "-q", "main");

  const base = await capture();
  await materialize(base);
  const state = stateWith(base);

  // Receiver-only stash history contains the squash-equivalent topic tip. Its
  // current value still advances by fast-forward, so this is the non-destructive
  // ref whose second-pass cascade P3 may waive.
  await git(receiver, "update-ref", "--create-reflog", "refs/stash", topicTip, stashOld);
  await git(receiver, "update-ref", "refs/stash", stashOld, topicTip);

  await git(sender, "checkout", "-q", "main");
  await git(sender, "merge", "--squash", "topic-p3");
  await git(sender, "commit", "-qm", "p3 squash topic");
  await git(sender, "checkout", "-q", "stash-line");
  const stashNew = await commit("stash new\n", "p3 stash new");
  await git(sender, "update-ref", "refs/stash", stashNew, stashOld);
  await git(sender, "branch", "-f", "carrier-p3", "topic-p3");
  await git(sender, "checkout", "-q", "carrier-p3");
  await commit("carrier new\n", "p3 carrier new");
  await git(sender, "checkout", "-q", "main");
  await git(sender, "branch", "-D", "topic-p3");
  const incoming = await capture();

  // The file plane precedes Git follow in production.
  await fs.writeFile(path.join(receiver, "tracked.txt"), "topic\n");
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  const waived = new Set<string>();
  const destructiveHolds = new Set<string>();
  const plannedDeletions = new Set<string>();
  const result = await followDivergedRepo({
    workspaceRoot: workspace,
    relPath: "repo",
    ctx,
    base,
    incoming,
    store,
    kek: KEK,
    oracle: matchingOracle,
    record: state.repoRecords!.repo,
    binding: await checkoutJournalBinding(state.stream, state.stateNonce!, ctx),
    followEnabled: true,
    forcedHeldRefs: { [carrierRef]: "ownership" },
    capabilityProbe: async () => true,
    makeIntended: () => ({ record: { sourceSeq: 2, base: incoming }, expectedRepoGen: 1, relPath: "repo" }),
    onContentEquivalentWaiver: (ref) => waived.add(ref),
    onContentEquivalentDestructiveHold: (ref) => destructiveHolds.add(ref),
    beforePlanBranchTransition: (ref, afterOid) => { if (afterOid === null) plannedDeletions.add(ref); },
  });

  expect(waived).toContain("refs/stash");
  expect(destructiveHolds).toContain(topicRef);
  expect(result.heldRefs["refs/stash"]).toBeUndefined();
  expect(await git(receiver, "rev-parse", "refs/stash")).toBe(stashNew);
  expect(result.heldRefs[topicRef]).toBe("local-commits");
  expect([...waived].filter((ref) => plannedDeletions.has(ref))).toEqual([]);
  expect(plannedDeletions.has(topicRef)).toBe(false);
});

test("§130 crash after prune reconstructs the breadcrumb veto from A exactly once", async () => {
  const topic = "refs/heads/crash-topic";
  const main = await commit("crash main\n", "crash main");
  await git(sender, "checkout", "-qb", "crash-topic");
  const topicTip = await commit("crash topic\n", "crash topic");
  await git(sender, "checkout", "-q", "main");
  const base = await capture();
  await materialize(base);
  let state = stateWith(base);
  await git(sender, "branch", "-D", "crash-topic");
  await fs.rm(path.join(sender, ".git", "ORIG_HEAD"), { force: true });
  const omitted = await capture();
  const incoming: GitSection = {
    ...omitted,
    refTombstones: { [topic]: [{ oid: topicTip, ts: new Date().toISOString(), generation: 1 }] },
    refTombstoneGeneration: 1,
  };
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${main}\n`);

  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-safe-refs") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-safe-refs");
  expect(await git(receiver, "rev-parse", "--verify", "--quiet", topic).catch(() => "")).toBe("");
  expect(state.repoRecords?.repo?.base?.refs[topic]).toBe(topicTip);
  expect((await git(receiver, "for-each-ref", "--format=%(refname)", BASE_ABSENT_PREFIX)).split("\n").filter(Boolean)).toHaveLength(1);

  const reconstructed = await applyIncoming(state, incoming);
  expect(reconstructed.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(reconstructed.logs.filter((line) => line.includes("tombstone-pruned-this-cycle"))).toHaveLength(1);
  state = await landOutcome(state, reconstructed.outcome, 2);
  expect(state.repoRecords?.repo?.base?.refs[topic]).toBeUndefined();

  const nextCycle = await applyIncoming(state, incoming);
  expect(nextCycle.logs.some((line) => line.includes("tombstone-pruned-this-cycle"))).toBe(false);
  expect(nextCycle.outcome.deferrals?.repo?.apply?.reason).not.toBe("local-operation");
});

test("design 200 accepted-residual 24-ref prune is non-latching after a dropped state save", async () => {
  const tip = await commit("residual base\n", "residual base");
  const tree = await git(sender, "rev-parse", `${tip}^{tree}`);
  const refs: Record<string, string> = {};
  for (let index = 0; index < 24; index++) {
    const ref = `refs/heads/residual-${index.toString().padStart(2, "0")}`;
    const oid = await gitExec([
      "-C", sender, "-c", "user.email=t@t.t", "-c", "user.name=t",
      "commit-tree", tree, "-p", tip, "-m", `residual ${index}`,
    ]).then(({ stdout }) => stdout.toString().trim());
    refs[ref] = oid;
    await git(sender, "update-ref", ref, oid);
  }
  const base = await capture();
  await materialize(base);

  // Establish ordinary publisher-ACK origins before simulating the accepted
  // omission whose local ACK state save is lost.
  let state = stateWith(base);
  state = await landOutcome(state, (await applyIncoming(state, base)).outcome, 2);
  for (const ref of Object.keys(refs)) await git(sender, "update-ref", "-d", ref);
  const omitted = await capture();
  const tombstoned: GitSection = {
    ...omitted,
    refTombstones: Object.fromEntries(Object.entries(refs).map(([ref, oid]) => [
      ref,
      [{ oid, ts: "2026-07-25T00:00:00.000Z", generation: 1 }],
    ])),
    refTombstoneGeneration: 1,
  };

  // First applying pull consumes every exact-X ref. Deliberately drop its
  // state save, leaving serialized BASE positive: the accepted residual.
  const first = await applyIncoming(state, tombstoned);
  for (const ref of Object.keys(refs)) {
    expect(await git(receiver, "rev-parse", "--verify", "--quiet", ref).catch(() => "")).toBe("");
    const oid = refs[ref]!;
    expect(await git(receiver, "rev-parse", keepPinRef(oid))).toBe(oid);
    expect((await readKeepPinOrigins(receiver))[oid]?.some(
      (origin) => origin.ref === ref && origin.class === "tombstone",
    )).toBe(true);
  }

  // Re-create every X before retry. The owning A artifacts from the first
  // transaction prevent a second consumption; the retry retires BASE without
  // pruning the re-creations, proving the failure does not latch per ref.
  for (const ref of Object.keys(refs)) await git(receiver, "update-ref", ref, tip);
  const retry = await applyIncoming(state, tombstoned);
  for (const ref of Object.keys(refs)) expect(await git(receiver, "rev-parse", ref)).toBe(tip);
  state = await landOutcome(state, retry.outcome, 3);
  for (const ref of Object.keys(refs)) expect(state.repoRecords?.repo?.base?.refs[ref]).toBeUndefined();
}, 30_000);

test("design 126: all-distinct ORIG_HEAD is adopted only after preserving the exact old object", async () => {
  const { c2, c3, state, incoming } = await breadcrumbBaseAndIncoming();
  const result = await applyIncoming(state, incoming);

  expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c2}\n`);
  const refs = (await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).split("\n").filter(Boolean);
  expect(refs).toHaveLength(1);
  expect(await git(receiver, "rev-parse", refs[0]!)).toBe(c3);
  const adoption = result.logs.filter((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD breadcrumb for repo"));
  expect(adoption).toEqual([`git-sync: adopted stale ORIG_HEAD breadcrumb for repo (old value preserved at ${refs[0]})`]);
});

const breadcrumbDirtyGuards = [
  ["local edit", "local-edits", async () => ({
    proveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  })],
  ["index divergence", "local-index", async () => {
    await fs.writeFile(path.join(receiver, "guard-index.txt"), "guard\n");
    await git(receiver, "add", "guard-index.txt");
  }],
  ["receiver-only commit", "local-commits", async () => {
    await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "guard local commit");
  }],
  ["stash", "local-stash", async () => {
    await fs.writeFile(path.join(receiver, "guard-stash.txt"), "guard\n");
    await git(receiver, "stash", "push", "-uqm", "guard stash");
  }],
  ["MERGE_HEAD mismatch", "local-operation", async () => {
    await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${"f".repeat(40)}\n`);
  }],
  ["unreadable tip", "unreadable", async () => {
    await fs.writeFile(path.join(receiver, ".git", "HEAD"), "ref: refs/heads/missing\n");
  }],
] as const;

for (const [label, expectedReason, dirty] of breadcrumbDirtyGuards) {
  test(`design 126: breadcrumb plus ${label} still defers with truthful detail`, async () => {
    const { c3, state, incoming } = await breadcrumbBaseAndIncoming();
    const result = await dirty();
    if (label === "stash") await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${c3}\n`);
    const applied = await applyIncoming(state, incoming, result && "proveRepo" in result ? result : matchingOracle);
    expect(applied.outcome.deferrals?.repo?.apply?.reason).toBe(label === "local edit" || label === "index divergence" ? expectedReason : "local-operation");
    expect(applied.logs.some((line) => line.includes("operation state differs at ORIG_HEAD"))).toBe(true);
    if (label === "local edit") {
      expect(applied.logs.some((line) => line.includes("working tree differs from applied manifest (differs at repo/tracked.txt)"))).toBe(true);
    }
    expect(applied.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
  });
}

const inProgressFiles = OP_STATE_FILES.filter((rel) => OP_STATE_CLASSIFICATION[rel] === "in-progress");
test("design 126 classification map covers every op-state root exactly", () => {
  expect(Object.keys(OP_STATE_CLASSIFICATION).sort()).toEqual([...OP_STATE_FILES, ...OP_STATE_DIRS].sort());
  // Pinned by NAME, not by count: in-progress is exactly git's own wt_status set.
  // MERGE_MSG/AUTO_MERGE/REBASE_HEAD are breadcrumbs (fossils of concluded
  // operations) — classifying them in-progress has stranded customer repos.
  expect(inProgressFiles).toEqual(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]);
  expect(OP_STATE_FILES.filter((rel) => OP_STATE_CLASSIFICATION[rel] === "breadcrumb"))
    .toEqual(["REBASE_HEAD", "ORIG_HEAD", "MERGE_MSG", "AUTO_MERGE"]);
  expect(OP_STATE_DIRS.every((dir) => OP_STATE_CLASSIFICATION[dir] === "in-progress")).toBe(true);
});

test("a MERGE_MSG mismatch follows and checkout conformance removes the fossil", async () => {
  const { c2, state, incoming } = await breadcrumbBaseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${c2}\n`);
  await fs.writeFile(path.join(receiver, ".git", "MERGE_MSG"), "receiver-only draft\n");
  const applied = await applyIncoming(state, incoming, matchingOracle);
  expect(applied.outcome.deferrals?.repo?.apply).toBeUndefined();
  await expect(fs.access(path.join(receiver, ".git", "MERGE_MSG"))).rejects.toThrow();
  expect(applied.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("op-state detail tokens are segment-built and never expose absolute gitdirs", () => {
  const commonDir = "/private/customer/repo/.git";
  expect(opStateDetailToken({
    repoDir: "/private/customer/linked",
    kind: "pointer",
    gitDir: path.join(commonDir, "worktrees", "linked-name"),
    commonDir,
  }, "REBASE_HEAD")).toBe("worktrees/linked-name/REBASE_HEAD");
  expect(opStateDetailToken({
    repoDir: "/private/customer/repo",
    kind: "dir",
    gitDir: commonDir,
    commonDir,
  }, "AUTO_MERGE")).toBe("AUTO_MERGE");
});

test("stale REBASE_HEAD in a linked worktree follows", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const ctx = await convertReceiverToLinkedWorktree();
  if (!ctx) throw new Error("linked receiver context missing");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await fs.writeFile(path.join(ctx.gitDir, "REBASE_HEAD"), `${c1}\n`);

  const applied = await applyIncoming(state, incoming);

  expect(applied.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(applied.logs).toContain("git-sync followed repo");
  await expect(fs.access(path.join(ctx.gitDir, "REBASE_HEAD"))).rejects.toThrow();
});

test("linked-worktree fossil plus real MERGE_HEAD defers and names both roots", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const ctx = await convertReceiverToLinkedWorktree();
  if (!ctx) throw new Error("linked receiver context missing");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await fs.writeFile(path.join(ctx.gitDir, "REBASE_HEAD"), `${c1}\n`);
  await fs.writeFile(path.join(ctx.gitDir, "MERGE_HEAD"), `${c1}\n`);
  const tokenPrefix = `worktrees/${path.basename(ctx.gitDir)}/`;

  const applied = await applyIncoming(state, incoming);
  const evidence = [
    ...applied.logs,
    ...((applied.outcome.attempt?.repo?.blockers ?? []).map((blocker) => blocker.detail ?? "")),
  ].join("\n");

  expect(applied.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(evidence).toContain(`${tokenPrefix}REBASE_HEAD`);
  expect(evidence).toContain(`${tokenPrefix}MERGE_HEAD`);
  expect(evidence).not.toContain(ctx.commonDir);
});

test("real-git REBASE_HEAD lifecycle follows Git resumability", async () => {
  const quitRepo = path.join(tmp, "rebase-quit");
  await initConflictingRebase(quitRepo);
  expect(await rebaseClassifierState(quitRepo)).toBe(true);
  await git(quitRepo, "rebase", "--quit");
  await expect(fs.access(path.join(quitRepo, ".git", "REBASE_HEAD"))).resolves.toBeNull();
  expect(await rebaseClassifierState(quitRepo)).toBe(false);

  const abortRepo = path.join(tmp, "rebase-abort");
  await initConflictingRebase(abortRepo);
  expect(await rebaseClassifierState(abortRepo)).toBe(true);
  await git(abortRepo, "rebase", "--abort");
  expect(await rebaseClassifierState(abortRepo)).toBe(false);

  const editRepo = path.join(tmp, "rebase-edit");
  await fs.mkdir(editRepo, { recursive: true });
  await git(editRepo, "init", "-qb", "main");
  await git(editRepo, "config", "user.email", "follow@example.invalid");
  await git(editRepo, "config", "user.name", "follow");
  await fs.writeFile(path.join(editRepo, "base.txt"), "base\n");
  await git(editRepo, "add", "base.txt");
  await git(editRepo, "commit", "-qm", "base");
  await git(editRepo, "checkout", "-qb", "topic");
  await fs.writeFile(path.join(editRepo, "topic.txt"), "topic\n");
  await git(editRepo, "add", "topic.txt");
  await git(editRepo, "commit", "-qm", "topic");
  await git(editRepo, "checkout", "-q", "main");
  await fs.writeFile(path.join(editRepo, "main.txt"), "main\n");
  await git(editRepo, "add", "main.txt");
  await git(editRepo, "commit", "-qm", "main");
  await git(editRepo, "checkout", "-q", "topic");
  await exec("git", ["-C", editRepo, "rebase", "-i", "main"], {
    env: { ...TEST_GIT_ENV, GIT_SEQUENCE_EDITOR: "sed -i '1s/^pick /edit /'" },
  });
  expect(await rebaseClassifierState(editRepo)).toBe(true);
  await exec("git", ["-C", editRepo, "rebase", "--continue"], { env: { ...TEST_GIT_ENV, GIT_EDITOR: "true" } });
  expect(await rebaseClassifierState(editRepo)).toBe(false);
});

test("design 126 worktree discriminator is primary or a stable per-gitdir hash", async () => {
  const commonDir = path.join(tmp, "discriminator-common");
  const linkedA = path.join(commonDir, "worktrees", "a");
  const linkedB = path.join(commonDir, "worktrees", "b");
  await fs.mkdir(linkedA, { recursive: true });
  await fs.mkdir(linkedB, { recursive: true });
  const fake = (gitDir: string, common: string) => ({ gitDir, commonDir: common, repoDir: receiver, kind: "pointer" as const });
  expect(await origHeadWorktreeDiscriminator(fake(commonDir, commonDir))).toBe("primary");
  const a = await origHeadWorktreeDiscriminator(fake(linkedA, commonDir));
  const b = await origHeadWorktreeDiscriminator(fake(linkedB, commonDir));
  expect(a).toBe(`wt-${hashBytes(Buffer.from(await fs.realpath(linkedA))).slice(0, 12)}`);
  expect(b).toMatch(/^wt-[0-9a-f]{12}$/);
  expect(b).not.toBe(a);
});

test("design 126 preservation errors are single-line and bounded", () => {
  const message = boundedOrigHeadPreservationError(new Error(`first\nsecond\u0085${"x".repeat(700)}`));
  expect(message).not.toMatch(/[\r\n\t]/);
  expect([...message].length).toBeLessThanOrEqual(512);
  expect(message).toStartWith("first second ");
  expect(message).toEndWith("…");
  const line = origHeadPreservationFailureLine(`repo\nforged\u200b${"r".repeat(700)}`, new Error("denied\r\nnext"));
  expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  expect([...line].length).toBeLessThanOrEqual(1100);
});

for (const rel of inProgressFiles) {
  test(`design 126 presence gate: equal live ${rel} vetoes breadcrumb adoption`, async () => {
    const { c3, state, incoming } = await breadcrumbBaseAndIncoming({ markerRel: rel });
    const result = await applyIncoming(state, incoming);
    expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
    expect(result.logs.some((line) => line.includes("operation state differs at ORIG_HEAD"))).toBe(true);
    expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c3}\n`);
  });
}

for (const dir of OP_STATE_DIRS) {
  test(`design 126 presence gate: equal live ${dir}/ descendant vetoes breadcrumb adoption`, async () => {
    const { state, incoming } = await breadcrumbBaseAndIncoming({ markerRel: `${dir}/state` });
    const result = await applyIncoming(state, incoming);
    expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
    expect(result.logs.some((line) => line.includes("operation state differs at ORIG_HEAD"))).toBe(true);
  });

  test(`design 126 presence gate: empty live ${dir}/ vetoes breadcrumb adoption`, async () => {
    const { state, incoming } = await breadcrumbBaseAndIncoming();
    await fs.mkdir(path.join(receiver, ".git", dir), { recursive: true });
    const result = await applyIncoming(state, incoming);
    expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
    expect(await fs.stat(path.join(receiver, ".git", dir)).then((stat) => stat.isDirectory())).toBe(true);
  });
}

test("design 126 presence gate treats a dangling op-state directory symlink as present", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  const marker = path.join(receiver, ".git", "rebase-merge");
  await fs.symlink("missing-rebase-state", marker);
  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(await fs.readlink(marker)).toBe("missing-rebase-state");
});

test("design 126 preservation: receiver-only commit U survives breadcrumb adoption", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "commit U");
  const commitU = await git(receiver, "rev-parse", "HEAD");
  await git(receiver, "reset", "--hard", state.repoRecords!.repo!.base!.refs["refs/heads/main"]!);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
  const refs = (await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).split("\n").filter(Boolean);
  expect(refs).toHaveLength(1);
  expect(await git(receiver, "rev-parse", refs[0]!)).toBe(commitU);
  await expect(git(receiver, "cat-file", "-e", `${commitU}^{commit}`)).resolves.toBe("");
});

test("design 126 preservation: malformed ORIG_HEAD is quarantined as capped raw bytes", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  const hostile = Buffer.alloc(70 * 1024, 0x78);
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), hostile);

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
  const repoHash = hashBytes(Buffer.from("repo")).slice(0, 16);
  const qDir = path.join(workspace, ".rbox", "git-quarantine", repoHash);
  const names = await fs.readdir(qDir);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^orig-head-\d+-[0-9a-f]+\.bytes$/);
  const saved = await fs.readFile(path.join(qDir, names[0]!));
  expect(saved).toHaveLength(64 * 1024);
  expect(saved.toString("utf8")).toContain("[rbox: ORIG_HEAD truncated from 71680 bytes at 65536-byte cap]");
  expect(result.logs.some((line) => line.includes(path.join(qDir, names[0]!)))).toBe(true);
});

test("design 126 raw preservation fails closed on a symlinked quarantine repo directory", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  const malformed = "malformed breadcrumb\n";
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), malformed);
  const repoHash = hashBytes(Buffer.from("repo")).slice(0, 16);
  const quarantineRoot = path.join(workspace, ".rbox", "git-quarantine");
  const outside = path.join(tmp, "outside-quarantine");
  await fs.mkdir(quarantineRoot, { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(quarantineRoot, repoHash));

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(await fs.readdir(outside)).toEqual([]);
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(malformed);
  const preservationFailures = result.logs.filter((line) => line.startsWith("git-sync: ORIG_HEAD preservation failed for repo: "));
  expect(preservationFailures).toHaveLength(1);
  expect(preservationFailures[0]).not.toMatch(/[\r\n]/);
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("design 126 raw preservation never masks a malformed ordinary ref", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), "malformed breadcrumb\n");
  await fs.mkdir(path.join(receiver, ".git", "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "bad-side"), "garbage\n");

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeDefined();
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
  expect(await fs.readFile(path.join(receiver, ".git", "refs", "heads", "bad-side"), "utf8")).toBe("garbage\n");
});

test("design 126 raw preservation supports a healthy detached repository with no refs", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  const detachedIncoming: GitSection = { ...incoming, head: incoming.refs["refs/heads/main"]!, refs: {} };
  await git(receiver, "checkout", "-q", "--detach", state.repoRecords!.repo!.base!.refs["refs/heads/main"]!);
  await git(receiver, "update-ref", "-d", "refs/heads/main");
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), "malformed detached breadcrumb\n");
  await expect(git(receiver, "show-ref")).rejects.toThrow();
  const before = await git(receiver, "rev-parse", "HEAD");

  const result = await applyIncoming(state, detachedIncoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(detachedIncoming.head);
  expect(await git(receiver, "rev-parse", "HEAD")).not.toBe(before);
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(true);
});

test("design 126 preservation: ninth adoption prunes the oldest recovery ref but never the current ref", async () => {
  const { c1, state, incoming } = await breadcrumbBaseAndIncoming();
  const future = Date.now() + 60_000;
  for (let n = 1; n <= 8; n++) await git(receiver, "update-ref", `refs/rbox-recovery/orig-head/primary/${future + n}-deadbeef`, c1);
  for (let n = 1; n <= 3; n++) await git(receiver, "update-ref", `refs/rbox-recovery/orig-head/wt-aaaaaaaaaaaa/${n}000-deadbeef`, c1);

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
  const refs = (await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).split("\n").filter(Boolean);
  expect(refs).toHaveLength(8);
  expect(refs.some((ref) => ref.endsWith(`/${future + 1}-deadbeef`))).toBe(false);
  const current = result.logs.find((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))?.match(/at (refs\/[^)]+)\)/)?.[1];
  expect(current).toBeDefined();
  expect(refs).toContain(current!);
  expect((await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/wt-aaaaaaaaaaaa")).split("\n").filter(Boolean)).toHaveLength(3);
});

test("design 126 preservation: incoming absence deletes ORIG_HEAD only after preserving it", async () => {
  const { c3, state, incoming } = await breadcrumbBaseAndIncoming({ incomingAbsent: true });
  const result = await applyIncoming(state, incoming);
  await expect(fs.access(path.join(receiver, ".git", "ORIG_HEAD"))).rejects.toThrow();
  const recoveryRef = (await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).trim();
  expect(await git(receiver, "rev-parse", recoveryRef)).toBe(c3);
  expect(result.logs.filter((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toHaveLength(1);
});

test("design 126 pipeline: heldRefs vetoes a provisional breadcrumb waiver", async () => {
  const { c3, state, incoming } = await breadcrumbBaseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(result.outcome.partial?.repo?.heldRefs["refs/heads/local-side"]).toBe("local-commits");
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c3}\n`);
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("design 126 pipeline: an invalidated design-116 applied-ref marker remains held and vetoes adoption", async () => {
  const c1 = await commit("one\n", "partial-c1");
  const c2 = await commit("two\n", "partial-c2");
  await git(sender, "branch", "side", c1);
  await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${c1}\n`);
  const base = await capture();
  await materialize(base);
  const c3 = await commit("three\n", "partial-c3");
  await git(sender, "branch", "-f", "side", c3);
  await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${c2}\n`);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${c3}\n`);
  const state = stateWith(base);
  state.gitPendingRemote = { repo: incoming };
  state.repoRecords!.repo!.pending = incoming;
  state.repoRecords!.repo!.partial = {
    incomingKey: gitIncomingKey(incoming), checkoutPending: true,
    appliedRefs: { "refs/heads/side": { kind: "direct", oid: incoming.refs["refs/heads/side"]! } },
    heldRefs: {}, configApplied: true,
  };

  const result = await applyIncoming(state, incoming);
  expect(result.outcome.partial?.repo?.heldRefs["refs/heads/side"]).toBe("local-commits");
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(base.refs["refs/heads/side"]);
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c3}\n`);
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("design 126 pipeline: boundary re-proof veto leaves no adoption or log", async () => {
  const { c3, state, incoming } = await breadcrumbBaseAndIncoming();
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "match" }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => "receipt",
  };
  const result = await applyIncoming(state, incoming, oracle);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c3}\n`);
  expect(await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).toBe("");
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("design 126 boundary mismatch first appearing after the initial proof is never adopted unpreserved", async () => {
  const { c1, c3, state, incoming } = await breadcrumbBaseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${c1}\n`);

  const result = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => {
      if (point === "after-index-lock") fsSync.writeFileSync(path.join(receiver, ".git", "ORIG_HEAD"), `${c3}\n`);
    },
  });

  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(`${c3}\n`);
  expect(await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-recovery/orig-head/primary")).toBe("");
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("ORIG_HEAD preservation cannot authorize a boundary where its mismatch disappeared", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming({ incomingAbsent: true });
  const result = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => {
      if (point === "after-index-lock") fsSync.unlinkSync(path.join(receiver, ".git", "ORIG_HEAD"));
    },
  });

  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("a real merge starting at the checkout boundary vetoes a fossil waiver", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const sideWorktree = path.join(tmp, "boundary-conflict-worktree");
  await git(receiver, "branch", "boundary-conflict", c1);
  await git(receiver, "worktree", "add", "-q", sideWorktree, "boundary-conflict");
  await fs.writeFile(path.join(sideWorktree, "tracked.txt"), "boundary conflict\n");
  await git(sideWorktree, "commit", "-qam", "boundary conflict");
  const boundaryConflictOid = await git(sideWorktree, "rev-parse", "HEAD");
  await git(receiver, "worktree", "remove", sideWorktree);
  await git(receiver, "branch", "-D", "boundary-conflict");
  await fs.writeFile(path.join(receiver, ".git", "AUTO_MERGE"), `${await git(receiver, "rev-parse", `${c1}^{tree}`)}\n`);
  let boundaryMergeError = "";

  const result = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => {
      if (point !== "after-journal-write") return;
      try {
        execFileSync("git", ["-C", receiver, "merge", "--no-edit", "--autostash", boundaryConflictOid], {
          env: TEST_GIT_ENV,
          stdio: "ignore",
        });
      } catch (error) {
        // A conflict exit is the real in-progress state this fixture needs.
        boundaryMergeError = String((error as { stderr?: Buffer }).stderr ?? error);
      }
    },
  });

  expect(result.outcome.deferrals?.repo?.apply?.reason).toBeDefined();
  const mergeHeadPresent = await fs.access(path.join(receiver, ".git", "MERGE_HEAD")).then(() => true, () => false);
  if (!mergeHeadPresent) throw new Error(`boundary merge did not start: ${boundaryMergeError}`);
  expect(result.logs.some((line) => line.includes("MERGE_HEAD"))).toBe(true);
});

test("design 126 pipeline: unrelated manual waivedReasons do not unlock a breadcrumb mismatch", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  const logs: string[] = [];
  const result = await followDivergedRepo({
    workspaceRoot: workspace,
    relPath: "repo",
    ctx,
    base: state.repoRecords!.repo!.base,
    incoming,
    store,
    kek: KEK,
    oracle: matchingOracle,
    record: state.repoRecords!.repo,
    binding: await checkoutJournalBinding(state.stream, state.stateNonce!, ctx),
    followEnabled: true,
    capabilityProbe: async () => true,
    log: (line) => logs.push(line),
    makeIntended: () => ({ record: { sourceSeq: 2, base: incoming }, expectedRepoGen: 1, relPath: "repo" }),
    manualResolution: {
      snapshotId: "manual-negative",
      waivedReasons: ["local-edits"],
      protectedOids: [],
      secondProof: async () => true,
    },
  });
  expect(result.status).toBe("defer");
  if (result.status !== "defer") throw new Error("expected defer");
  expect(result.reason).toBe("local-operation");
  expect(result.detail).toContain("operation state differs at ORIG_HEAD");
  expect(logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
});

test("manual take-theirs with a stale AUTO_MERGE still applies", async () => {
  const { c1, state, incoming } = await baseAndIncoming("detached");
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  await fs.writeFile(path.join(ctx.gitDir, "AUTO_MERGE"), `${await git(receiver, "rev-parse", `${c1}^{tree}`)}\n`);
  const result = await followDivergedRepo({
    workspaceRoot: workspace,
    relPath: "repo",
    ctx,
    base: state.repoRecords!.repo!.base,
    incoming,
    store,
    kek: KEK,
    oracle: matchingOracle,
    record: state.repoRecords!.repo,
    binding: await checkoutJournalBinding(state.stream, state.stateNonce!, ctx),
    followEnabled: true,
    capabilityProbe: async () => true,
    log: () => {},
    makeIntended: () => ({ record: { sourceSeq: 2, base: incoming }, expectedRepoGen: 1, relPath: "repo" }),
    manualResolution: {
      snapshotId: "manual-fossil",
      waivedReasons: ["local-operation"],
      protectedOids: [],
      secondProof: async () => true,
    },
  });

  expect(result.status).toBe("followed");
  await expect(fs.access(path.join(ctx.gitDir, "AUTO_MERGE"))).rejects.toThrow();
});

test("design 126 crash recovery clears the journal-owned ORIG_HEAD.lock after a mid-op-state death", async () => {
  const { state, incoming } = await breadcrumbBaseAndIncoming();
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "mid-op-state") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("mid-op-state");
  const lockPath = path.join(receiver, ".git", "ORIG_HEAD.lock");
  const lockId = await fs.readFile(lockPath, "utf8");
  const journalRoot = path.join(workspace, ".rbox", "state", "git-journal");
  const journalDir = path.join(journalRoot, (await fs.readdir(journalRoot))[0]!);
  expect(await fs.readFile(path.join(journalDir, "journal.id"), "utf8")).toBe(lockId);

  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming);
  expect(retry.outcome.deferrals?.repo?.apply).toBeUndefined();
  await expect(fs.access(lockPath)).rejects.toThrow();
});

test("design 126 bookkeeping: successful waiver clears an existing local-operation episode", async () => {
  const { base, state, incoming } = await breadcrumbBaseAndIncoming();
  state.repoRecords!.repo!.deferrals = { apply: {
    lane: "apply", reason: "local-operation", subjectKey: "old-breadcrumb", reproof: true,
    deferredSince: "2026-07-12T00:00:00.000Z", reasonSince: "2026-07-12T00:00:00.000Z", lastSeen: "2026-07-12T00:00:00.000Z",
  } };
  state.repoRecords!.repo!.pending = incoming;
  state.repoRecords!.repo!.base = base;
  const result = await applyIncoming(state, incoming);
  expect(result.outcome.deferrals?.repo?.apply).toBeNull();
  expect(result.outcome.gitPendingRemote?.repo).toBeUndefined();
});

for (const incomingAbsent of [false, true]) {
  test(`design 126 fingerprint: adopted ORIG_HEAD ${incomingAbsent ? "deletion" : "replacement"} invalidates the op-state fingerprint`, async () => {
    const { state, incoming } = await breadcrumbBaseAndIncoming({ incomingAbsent });
    const before = await gitFingerprint(gitFingerprintRun("per-decision"), workspace, "repo");
    const cache: GitDivergenceCache = { repos: new Map([["repo", {
      fingerprint: before.hash, writtenAtMs: Date.now() + 10_000, identityKey: "warm",
      kind: "dir", probe: { busy: false, preflightOk: true, identityKey: "warm" },
    }]]), dirty: false };
    expect((await fingerprintHitProbe(gitFingerprintRun("per-decision"), workspace, "repo", cache, "dir", false)).status).toBe("hit");
    const result = await applyIncoming(state, incoming);
    expect(result.outcome.deferrals?.repo?.apply).toBeUndefined();
    const after = await gitFingerprint(gitFingerprintRun("per-decision"), workspace, "repo");
    expect(after.hash).not.toBe(before.hash);
    expect((await fingerprintHitProbe(gitFingerprintRun("per-decision"), workspace, "repo", cache, "dir", false)).status).toBe("miss");
  });
}

test("design 165 exact unchanged current tip follows through a locked branch witness", async () => {
  const { state, incoming, mainTip, featureTip } = await switchBackFixture();
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  let witnessLockedAfterRefCommit = false;

  const { outcome, logs } = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => {
      if (point === "after-ref-commit") {
        witnessLockedAfterRefCommit = fsSync.existsSync(path.join(ctx.commonDir, `${SWITCH_BACK_REF}.lock`));
      }
    },
  });

  expect(logs).toContain("git-sync followed repo");
  expect(witnessLockedAfterRefCommit).toBe(true);
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(mainTip);
  expect(await git(receiver, "rev-parse", SWITCH_BACK_REF)).toBe(featureTip);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
});

test("design 165 self-root eligibility is exact, branch-only, effective, and disposition-aware", () => {
  const tip = "1".repeat(40);
  const other = "2".repeat(40);
  const branch = "refs/heads/current";
  const exact = {
    currentTip: tip,
    effectiveIncomingRefs: { [branch]: tip },
    receiverRefs: { [branch]: tip },
  };

  expect(selectCheckoutSelfRootWitness(exact)).toEqual({ ref: branch, oid: tip });
  expect(selectCheckoutSelfRootWitness({ ...exact, effectiveIncomingRefs: { [branch]: other } })).toBeUndefined();
  expect(selectCheckoutSelfRootWitness({ ...exact, receiverRefs: { [branch]: other } })).toBeUndefined();

  expect(selectCheckoutSelfRootWitness({ ...exact, heldRefs: new Set([branch]) }), "held").toBeUndefined();
  expect(selectCheckoutSelfRootWitness({ ...exact, forcedRefs: new Set([branch]) }), "forced").toBeUndefined();
  expect(selectCheckoutSelfRootWitness({ ...exact, ambiguousRefs: new Set([branch]) }), "ambiguous").toBeUndefined();
  expect(selectCheckoutSelfRootWitness({ ...exact, ambiguousRefs: new Set([branch]) }), "receiver-equivalent").toBeUndefined();
  // A pointer receiver's filtered tag/stash values are absent from effective
  // refs, so raw incoming values cannot become witnesses.
  expect(selectCheckoutSelfRootWitness({
    currentTip: tip,
    effectiveIncomingRefs: {},
    receiverRefs: { "refs/tags/scoped-out": tip, "refs/stash": tip },
  })).toBeUndefined();

  for (const ref of [
    "refs/tags/lightweight-commit",
    "refs/tags/annotated-commit",
    "refs/tags/non-commit",
    "refs/stash",
  ]) {
    expect(selectCheckoutSelfRootWitness({
      currentTip: tip,
      effectiveIncomingRefs: { [ref]: tip },
      receiverRefs: { [ref]: tip },
    }), ref).toBeUndefined();
  }

  // Equal sibling-owned refs are not blanket-excluded: only an actual ref-plane
  // hold enters heldRefs, preserving their existing ordinary-root role.
  const sibling = "refs/heads/equal-sibling";
  expect(selectCheckoutSelfRootWitness({
    currentTip: tip,
    effectiveIncomingRefs: { [sibling]: tip },
    receiverRefs: { [sibling]: tip },
  })).toEqual({ ref: sibling, oid: tip });
  expect(selectCheckoutSelfRootWitness({ ...exact, requiredRef: "refs/heads/missing" })).toBeUndefined();
});

test("design 165 local-ahead tip unreachable from every admissible root still defers", async () => {
  const { state, incoming } = await switchBackFixture();
  await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "receiver ahead");
  const localTip = await git(receiver, "rev-parse", "HEAD");

  const { outcome } = await applyIncoming(state, incoming);

  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe(SWITCH_BACK_REF);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(localTip);
});

test("design 200 locally deleted published branch is held per-ref, then converged omission retires BASE", async () => {
  await commit("main\n", "base");
  await git(sender, "branch", "published");
  const base = await capture();
  await materialize(base);
  const state = stateWith(base);
  const ref = "refs/heads/published";
  const prior = base.refs[ref]!;
  await git(receiver, "update-ref", "-d", ref, prior);

  await git(sender, "commit", "--allow-empty", "-qm", "reassert");
  const reasserted = await capture();
  const held = await applyIncoming(state, reasserted);
  expect(held.outcome.partial?.repo?.heldRefs[ref]).toBe("local-commits");
  expect(held.outcome.deferrals?.repo?.apply?.reason).toBe("deletion-pending");
  expect(await git(receiver, "rev-parse", "--verify", "--quiet", ref).catch(() => "")).toBe("");

  await git(sender, "branch", "-D", "published");
  const omitted = await capture();
  const converged = await applyIncoming(state, omitted);
  expect(converged.outcome.gitRepos?.repo?.refs[ref]).toBeUndefined();
  expect(converged.outcome.partial?.repo?.heldRefs[ref]).toBeUndefined();
  expect(converged.outcome.deferrals?.repo?.apply).toBeNull();
});

test("corrupt loose ref during converged deletion keeps durable ref-read-unreadable reason", async () => {
  await commit("main\n", "base");
  await git(sender, "branch", "published");
  const base = await capture();
  await materialize(base);
  const state = stateWith(base);
  const ref = "refs/heads/published";
  const prior = base.refs[ref]!;
  await git(receiver, "update-ref", "-d", ref, prior);
  await git(sender, "branch", "-D", "published");
  const omitted = await capture();

  const result = await applyIncoming(state, omitted, matchingOracle, {
    beforeManualAbsentTransition: async (_rel, candidateRef) => {
      if (candidateRef !== ref) return;
      await fs.mkdir(path.join(receiver, ".git", "refs", "heads"), { recursive: true });
      await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "broken-during-proof"), "not-an-oid\n");
    },
  });
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("ref-read-unreadable");
  expect(result.outcome.deferrals?.repo?.apply?.reason).not.toBe("deletion-pending");
});

test("apply-side worktree ownership evidence failure refuses instead of authorizing an empty map", async () => {
  const { state, incoming } = await baseAndIncoming();
  const result = await applyIncoming(state, incoming, matchingOracle, {
    beforeWorktreeOwnershipRead: async () => {
      throw new Error("simulated git worktree list failure");
    },
  });
  expect(result.outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});

test("design 165 local-ahead tip remains owned through another durable descendant root", async () => {
  const mainTip = await commit("main\n", "ahead-main");
  await git(sender, "checkout", "-qb", "ahead");
  const ownIncoming = await commit("ahead-own\n", "ahead-own");
  const liveTip = await commit("ahead-live\n", "ahead-live");
  const base = await capture();
  await materialize(base);
  const otherRoot = await commit("ahead-other\n", "ahead-other");
  await git(sender, "branch", "other-root", otherRoot);
  await git(sender, "switch", "-q", "main");
  await git(sender, "branch", "-f", "ahead", ownIncoming);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "main\n");

  expect(selectCheckoutSelfRootWitness({
    currentTip: liveTip,
    effectiveIncomingRefs: incoming.refs,
    receiverRefs: { ...base.refs, "refs/heads/other-root": otherRoot },
  })).toBeUndefined();
  const { outcome, logs } = await applyIncoming(stateWith(base), incoming);

  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(mainTip);
  expect(await git(receiver, "rev-parse", "refs/heads/ahead")).toBe(ownIncoming);
  expect(await git(receiver, "merge-base", "--is-ancestor", liveTip, otherRoot).then(() => "owned")).toBe("owned");
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
});

for (const mutation of ["move", "delete"] as const) {
  test(`design 165 ${mutation} of the selected witness before reservation aborts checkout`, async () => {
    const { state, incoming, featureTip } = await switchBackFixture();
    const ctx = await repoCtx(receiver);
    if (!ctx) throw new Error("receiver context missing");
    const tree = await git(receiver, "rev-parse", `${featureTip}^{tree}`);
    const movedTip = mutation === "move"
      ? await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", featureTip, "-m", "boundary witness move"])
          .then(({ stdout }) => stdout.toString().trim())
      : undefined;
    let mutated = false;

    const { outcome } = await applyIncoming(state, incoming, matchingOracle, {
      crashAt: (point) => {
        if (point !== "after-journal-write" || mutated) return;
        mutated = true;
        if (mutation === "move") {
          execFileSync("git", ["-C", receiver, "update-ref", SWITCH_BACK_REF, movedTip!, featureTip], { env: TEST_GIT_ENV });
        } else {
          execFileSync("git", ["-C", receiver, "update-ref", "refs/heads/witness-race-backup", featureTip], { env: TEST_GIT_ENV });
          execFileSync("git", ["-C", receiver, "update-ref", "-d", SWITCH_BACK_REF, featureTip], { env: TEST_GIT_ENV });
        }
      },
    });

    expect(mutated).toBe(true);
    expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
    expect(outcome.deferrals?.repo?.apply).toBeDefined();
    expect(await git(receiver, "symbolic-ref", "HEAD")).toBe(SWITCH_BACK_REF);
    const durableRef = mutation === "move" ? SWITCH_BACK_REF : "refs/heads/witness-race-backup";
    const durableTip = await git(receiver, "rev-parse", durableRef);
    await expect(git(receiver, "merge-base", "--is-ancestor", featureTip, durableTip)).resolves.toBe("");
    await expect(git(receiver, "cat-file", "-e", `${featureTip}^{commit}`)).resolves.toBe("");
    await expect(fs.access(path.join(ctx.commonDir, `${SWITCH_BACK_REF}.lock`))).rejects.toThrow();
  });
}

test("design 165 scoped incoming refs remain non-deleting and cannot supply an absent witness", async () => {
  const { state, incoming, featureTip } = await switchBackFixture();
  const scoped: GitSection = {
    ...incoming,
    refScope: "scoped",
    refs: { "refs/heads/main": incoming.refs["refs/heads/main"]! },
  };

  const { outcome } = await applyIncoming(state, scoped);

  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
  expect(outcome.gitPendingRemote?.repo).toEqual(scoped);
  expect(await git(receiver, "rev-parse", SWITCH_BACK_REF)).toBe(featureTip);
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe(SWITCH_BACK_REF);
});

test("design 165 detached receiver follows only with an exact reserved branch witness", async () => {
  const { state, incoming, mainTip, featureTip } = await switchBackFixture();
  await git(receiver, "checkout", "-q", "--detach", featureTip);
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  let witnessLocked = false;

  const { outcome } = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => {
      if (point === "after-ref-commit") witnessLocked = fsSync.existsSync(path.join(ctx.commonDir, `${SWITCH_BACK_REF}.lock`));
    },
  });

  expect(witnessLocked).toBe(true);
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(mainTip);
  expect(selectCheckoutSelfRootWitness({
    currentTip: "3".repeat(40),
    effectiveIncomingRefs: incoming.refs,
    receiverRefs: incoming.refs,
  })).toBeUndefined();
});

for (const withContainingRoot of [false, true]) {
  test(`design 165 all-scope checked-out branch deletion ${withContainingRoot ? "uses another durable root" : "defers without a containing root"}`, async () => {
    const mainTip = await commit("delete-main\n", "delete-main");
    await git(sender, "checkout", "-qb", "delete-me");
    const deletedTip = await commit("delete-feature\n", "delete-feature");
    const base = await capture();
    await materialize(base);
    let containingRoot: string | undefined;
    if (withContainingRoot) {
      containingRoot = await commit("delete-descendant\n", "delete-descendant");
      await git(sender, "branch", "delete-container", containingRoot);
    }
    await git(sender, "switch", "-q", "main");
    await git(sender, "branch", "-D", "delete-me");
    const incoming = await capture();
    await fs.writeFile(path.join(receiver, "tracked.txt"), "delete-main\n");

    const { outcome, logs } = await applyIncoming(stateWith(base), incoming);
    if (!withContainingRoot) {
      expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
      expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
      expect(await git(receiver, "rev-parse", "refs/heads/delete-me")).toBe(deletedTip);
      expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/delete-me");
    } else {
      expect(logs).toContain("git-sync followed repo");
      expect(outcome.deferrals?.repo?.apply).toBeUndefined();
      await expect(git(receiver, "rev-parse", "--verify", "refs/heads/delete-me")).rejects.toThrow();
      expect(await git(receiver, "rev-parse", "refs/heads/delete-container")).toBe(containingRoot!);
      await expect(git(receiver, "merge-base", "--is-ancestor", deletedTip, containingRoot!)).resolves.toBe("");
      expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(await git(receiver, "rev-parse", "HEAD")).toBe(mainTip);
      expect(await git(receiver, "rev-parse", keepPinRef(deletedTip))).toBe(deletedTip);
      const origins = (await readKeepPinOrigins(receiver))[deletedTip] ?? [];
      expect(origins.some((origin) => origin.ref === "refs/heads/delete-me" && origin.class === "human")).toBe(true);
      expect(origins.some((origin) => origin.ref === "refs/heads/delete-me" && origin.class === "tombstone")).toBe(false);
    }
  });
}

test("design 165 applies a closed snapshot before converging to a newer publish", async () => {
  const { state, incoming: closed, mainTip, featureTip } = await switchBackFixture();
  await git(sender, "switch", "-q", SWITCH_BACK_REF.replace(/^refs\/heads\//, ""));
  const newer = await capture();

  const first = await applyIncoming(state, closed);
  expect(first.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(mainTip);
  const advanced = await landOutcome(state, first.outcome, 2);

  await fs.writeFile(path.join(receiver, "tracked.txt"), "feature\n");
  const second = await applyIncoming(advanced, newer, matchingOracle, { sourceGlobalSeq: 3 });
  expect(second.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe(SWITCH_BACK_REF);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(featureTip);
  expect(second.outcome.gitRepos?.repo).toEqual(newer);
});

test("field incident follows an incoming branch switch", async () => {
  const { c1, state, incoming } = await baseAndIncoming("switch");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/next");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/next"]);
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
});

test("degraded clean arm defers a sibling-owned intersection as a whole section", async () => {
  await commit("one\n", "c1");
  const baseTip = await commit("two\n", "c2");
  await git(sender, "branch", "side", baseTip);
  const base = await capture();
  await materialize(base);

  const sibling = path.join(tmp, "receiver-side-worktree");
  await git(receiver, "worktree", "add", "-q", sibling, "side");
  const incomingTip = await commit("three\n", "c3");
  await git(sender, "branch", "-f", "side", incomingTip);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  const { outcome } = await applyIncoming(stateWith(base), incoming, matchingOracle, { degradedMutex: true });
  expect(outcome.gitRepos?.repo).toEqual(base);
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
  expect(outcome.partial?.repo).toBeUndefined();
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(base.refs["refs/heads/main"]);
  expect(await git(sibling, "rev-parse", "refs/heads/side")).toBe(baseTip);
});

for (const location of ["inside", "outside"] as const) {
  test(`design 200 P2: ${location}-workspace non-HEAD ownership stays per-ref, skips, and removal invalidates the digest`, async () => {
    await commit("one\n", "p2-c1");
    const baseTip = await commit("two\n", "p2-c2");
    await git(sender, "branch", "side", baseTip);
    const base = await capture();
    await materialize(base);

    const sibling = location === "inside"
      ? path.join(workspace, "linked-side")
      : path.join(tmp, "linked-side");
    await git(receiver, "worktree", "add", "-q", sibling, "side");
    const incomingTip = await commit("three\n", "p2-c3");
    await git(sender, "branch", "-f", "side", incomingTip);
    const incoming = await capture();
    await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

    const first = await applyIncoming(stateWith(base), incoming, matchingOracle, { collectMetrics: true });
    // Design 273 P2: the hold keeps a visible record instead of deleting one.
    expect(first.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
    expect(first.outcome.gitPendingRemote?.repo).toEqual(incoming);
    expect(first.outcome.partial?.repo?.heldRefs["refs/heads/side"]).toBe("ownership");
    expect(first.outcome.partial?.repo?.appliedRefs["refs/heads/main"]).toBeDefined();
    expect(first.outcome.attempt?.repo?.worktreeRegistryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.outcome.attempt?.repo?.blockers).toEqual([{
      provenance: "ref-plane", reason: "worktree-ownership", ref: "refs/heads/side",
    }]);
    expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(incoming.refs["refs/heads/main"]);
    expect(await git(sibling, "rev-parse", "refs/heads/side")).toBe(baseTip);

    const saved = await landOutcome(stateWith(base), first.outcome, 2);
    let capabilityCalls = 0;
    const skipped = await applyIncoming(saved, incoming, matchingOracle, {
      collectMetrics: true,
      heldNow: heldNowAfterRacyWindow,
      capabilityProbe: async () => { capabilityCalls++; return true; },
    });
    expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
    // The skip RE-STANDS the record rather than clearing it, so the repo does
    // not disappear from every surface one pull after the follow restored it.
    expect(skipped.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
    expect(capabilityCalls).toBe(0);

    await git(receiver, "worktree", "remove", "--force", sibling);
    capabilityCalls = 0;
    const released = await applyIncoming(saved, incoming, matchingOracle, {
      collectMetrics: true,
      heldNow: heldNowAfterRacyWindow,
      capabilityProbe: async () => { capabilityCalls++; return true; },
    });
    expect(released.outcome.gitApplyMetrics?.results.skipped).toBe(0);
    expect(capabilityCalls).toBeGreaterThan(0);
    expect(released.outcome.gitPendingRemote?.repo).toBeUndefined();
    expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingTip);
  });
}

test("design 200 P2: a sibling branch switch during classification records no stale ownership attempt", async () => {
  await commit("one\n", "p2-race-c1");
  const baseTip = await commit("two\n", "p2-race-c2");
  await git(sender, "branch", "side", baseTip);
  await git(sender, "branch", "other", baseTip);
  const base = await capture();
  await materialize(base);
  const sibling = path.join(tmp, "race-linked-side");
  await git(receiver, "worktree", "add", "-q", sibling, "side");
  const incomingTip = await commit("three\n", "p2-race-c3");
  await git(sender, "branch", "-f", "side", incomingTip);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  let hookCalls = 0;
  const raced = await applyIncoming(stateWith(base), incoming, matchingOracle, {
    afterHeldClassification: async () => {
      hookCalls++;
      await git(sibling, "switch", "-q", "other");
    },
  });
  expect(hookCalls).toBe(1);
  expect(raced.outcome.partial?.repo?.heldRefs["refs/heads/side"]).toBe("ownership");
  expect(raced.outcome.attempt?.repo).toBeNull();

  const saved = await landOutcome(stateWith(base), raced.outcome, 2);
  let capabilityCalls = 0;
  const released = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(released.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(capabilityCalls).toBeGreaterThan(0);
  expect(released.outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingTip);
});

// Design 273 P2: RBOX_GIT_OWNERSHIP_NO_ESCALATE now CLASSES the record rather
// than deleting it, so both settings record `worktree-ownership`. What the flag
// still controls is escalation, which the projection's `ownership-hold` class
// owns. RBOX_GIT_OWNERSHIP_HELD_SKIP is unchanged: it re-follows instead of
// skipping.
test("design 200 P2 kill switches independently restore legacy ownership behavior", async () => {
  await commit("one\n", "p2-switch-c1");
  const baseTip = await commit("two\n", "p2-switch-c2");
  await git(sender, "branch", "side", baseTip);
  const base = await capture();
  await materialize(base);
  const sibling = path.join(tmp, "switch-linked-side");
  await git(receiver, "worktree", "add", "-q", sibling, "side");
  const incomingTip = await commit("three\n", "p2-switch-c3");
  await git(sender, "branch", "-f", "side", incomingTip);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  const first = await applyIncoming(stateWith(base), incoming);
  const saved = await landOutcome(stateWith(base), first.outcome, 2);
  let followedState: SyncState;
  process.env.RBOX_GIT_OWNERSHIP_HELD_SKIP = "0";
  try {
    let capabilityCalls = 0;
    const fullFollow = await applyIncoming(saved, incoming, matchingOracle, {
      collectMetrics: true,
      heldNow: heldNowAfterRacyWindow,
      capabilityProbe: async () => { capabilityCalls++; return true; },
    });
    expect(fullFollow.outcome.gitApplyMetrics?.results.skipped).toBe(0);
    expect(fullFollow.outcome.attempt?.repo?.blockers).toEqual([{
      provenance: "ref-plane", reason: "worktree-ownership", ref: "refs/heads/side",
    }]);
    expect(fullFollow.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
    expect(capabilityCalls).toBeGreaterThan(0);
    followedState = await landOutcome(saved, fullFollow.outcome, 3);
  } finally {
    delete process.env.RBOX_GIT_OWNERSHIP_HELD_SKIP;
  }

  let legacyState: SyncState;
  process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE = "0";
  try {
    const legacyEscalation = await applyIncoming(followedState!, incoming);
    expect(legacyEscalation.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
    legacyState = await landOutcome(followedState!, legacyEscalation.outcome, 4);
  } finally {
    delete process.env.RBOX_GIT_OWNERSHIP_NO_ESCALATE;
  }

  let capabilityCalls = 0;
  const reenabled = await applyIncoming(legacyState!, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(reenabled.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(reenabled.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
  expect(capabilityCalls).toBe(0);
});

test("design 200 P2: incoming HEAD ownership remains a whole-repository defer", async () => {
  await commit("one\n", "p2-head-c1");
  const baseTip = await commit("two\n", "p2-head-c2");
  await git(sender, "branch", "side", baseTip);
  const base = await capture();
  await materialize(base);
  const sibling = path.join(tmp, "head-linked-side");
  await git(receiver, "worktree", "add", "-q", sibling, "side");
  await git(sender, "switch", "-q", "side");
  await commit("side incoming\n", "p2-head-c3");
  const incoming = await capture();

  const held = await applyIncoming(stateWith(base), incoming);
  expect(held.outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
  expect(held.outcome.gitRepos?.repo).toEqual(base);
  expect(held.outcome.gitPendingRemote?.repo).toEqual(incoming);
});

test("field incident follows a contained stale tip to detached incoming HEAD", async () => {
  const { c1, state, incoming } = await baseAndIncoming("detached");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  await expect(git(receiver, "symbolic-ref", "HEAD")).rejects.toThrow();
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.head.trim());
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
});

test("design safety: detached receiver follows an incoming attached branch", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "HEAD"), `${c1}\n`);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
});

test("disposition: staged index changes defer local-index", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "staged.txt"), "human\n");
  await git(receiver, "add", "staged.txt");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
});

for (const semanticEdit of ["skip-worktree", "assume-unchanged", "intent-to-add"] as const) {
  test(`clean production arm preserves ${semanticEdit} and defers local-index`, async () => {
    const { state, incoming } = await baseAndIncoming();
    const baseTip = await git(receiver, "rev-parse", "HEAD");
    if (semanticEdit === "intent-to-add") {
      await fs.writeFile(path.join(receiver, "intent.txt"), "human intent\n");
      await git(receiver, "add", "-N", "intent.txt");
    } else {
      await git(receiver, "update-index", `--${semanticEdit}`, "tracked.txt");
    }
    const projectionBefore = await indexIdentityV2(receiver, path.join(receiver, ".git", "index"));
    const { outcome } = await applyIncoming(state, incoming);
    expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
    expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
    expect(await git(receiver, "rev-parse", "HEAD")).toBe(baseTip);
    expect(await indexIdentityV2(receiver, path.join(receiver, ".git", "index"))).toBe(projectionBefore);
    if (semanticEdit === "skip-worktree") {
      expect(await git(receiver, "ls-files", "-v", "tracked.txt")).toStartWith("S ");
    } else if (semanticEdit === "assume-unchanged") {
      expect(await git(receiver, "ls-files", "-v", "tracked.txt")).toStartWith("h ");
    } else {
      expect(await git(receiver, "ls-files", "--debug", "intent.txt")).toContain("flags: 20004000");
    }
  });
}

test("design safety: local merge state defers local-operation", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
});

for (const [label, rel] of [
  ["rebase", "rebase-merge/head-name"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
] as const) {
  test(`design safety: local ${label} state defers local-operation`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    await fs.mkdir(path.dirname(path.join(receiver, ".git", rel)), { recursive: true });
    await fs.writeFile(path.join(receiver, ".git", rel), `${c1}\n`);
    const { outcome } = await applyIncoming(state, incoming);
    expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
    expect(await fs.readFile(path.join(receiver, ".git", rel), "utf8")).toBe(`${c1}\n`);
  });
}

test("design safety: mode-only index edit defers local-index with working bytes untouched", async () => {
  const { state, incoming } = await baseAndIncoming();
  const bytes = await fs.readFile(path.join(receiver, "tracked.txt"));
  await git(receiver, "update-index", "--chmod=+x", "tracked.txt");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
  expect(await fs.readFile(path.join(receiver, "tracked.txt"))).toEqual(bytes);
  expect(await git(receiver, "ls-files", "-s", "tracked.txt")).toStartWith("100755 ");
});

test("disposition: oracle mismatch wins display precedence as local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const { outcome } = await applyIncoming(state, incoming, oracle);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
});

test("disposition: receiver-only current commit defers local-commits", async () => {
  const { state, incoming } = await baseAndIncoming();
  const withSafeRef = { ...incoming, refs: { ...incoming.refs, "refs/heads/incoming-side": incoming.refs["refs/heads/main"]! } };
  await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "receiver only");
  const { outcome } = await applyIncoming(state, withSafeRef);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
  expect(await git(receiver, "rev-parse", "refs/heads/incoming-side")).toBe(withSafeRef.refs["refs/heads/incoming-side"]);
  expect(outcome.partial?.repo?.appliedRefs["refs/heads/incoming-side"]).toBeDefined();
});

test("R2-2 invalidated partial ref moved back to base is held, never republished", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side", c1);
  const base = await capture();
  await materialize(base);
  await commit("three\n", "c3");
  await git(sender, "branch", "-f", "side", await git(sender, "rev-parse", "main"));
  const incoming = await capture();
  const state = stateWith(base);
  await saveStateUnsafeLegacyOrTest(workspace, state);

  await fs.writeFile(path.join(receiver, "tracked.txt"), "human first episode\n");
  const mismatch: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const first = await applyIncoming(state, incoming, mismatch);
  const incomingSide = incoming.refs["refs/heads/side"]!;
  const baseSide = base.refs["refs/heads/side"]!;
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);
  expect(first.outcome.partial?.repo?.appliedRefs["refs/heads/side"]).toMatchObject({ kind: "present", oid: incomingSide });
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  });

  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await git(receiver, "update-ref", "refs/heads/side", baseSide, incomingSide);
  const retry = await applyIncoming(saved, incoming);

  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(baseSide);
  expect(retry.outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(retry.outcome.partial?.repo?.heldRefs["refs/heads/side"]).toBe("local-commits");
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
});

test("disposition: receiver-only non-current branch is held while checkout follows", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "side only"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs.some((line) => line.startsWith("git-sync followed repo"))).toBe(true);
  expect(outcome.partial?.repo?.heldRefs["refs/heads/local-side"]).toBe("local-commits");
  expect(outcome.partial?.repo?.checkoutPending).toBe(false);
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/local-side")).toBe(local);
});

test("unchanged allowlisted hold skips before fetch and prep; a ref move resumes follow", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);

  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  expect(first.outcome.attempt?.repo?.blockers).toContainEqual({
    provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/local-side",
  });
  const saved = await landOutcome(state, first.outcome, 2);
  let exceptionHookCalled = false;
  const exceptional = await applyIncoming(
    saved,
    { ...incoming, head: incoming.refs["refs/heads/main"]! },
    matchingOracle,
    { heldNow: heldNowAfterRacyWindow, afterHeldSkipPrepass: () => { exceptionHookCalled = true; throw new Error("injected outer apply exception"); } },
  );
  expect(exceptionHookCalled).toBe(true);
  expect(exceptional.outcome.gitPendingRemote?.repo?.head).toBe(incoming.refs["refs/heads/main"]!);

  let capabilityCalls = 0;
  let pinCalls = 0;
  const ordering: string[] = [];
  process.env.RBOX_TRACE_HELD = "1";
  const fetch = spyOn(store, "get");
  const fetchToFile = spyOn(store, "getToFile");
  const skipped = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    afterHeldSkipPrepass: () => { ordering.push("prepass"); },
    capabilityProbe: async () => { capabilityCalls++; ordering.push("follow"); return true; },
    afterBranchPinsPrepared: () => { pinCalls++; },
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  const skippedTiming = skipped.outcome.gitApplyMetrics?.repoTimings[0];
  if (!skippedTiming?.chain) throw new Error("missing held-skip timing partition");
  expect(skippedTiming.chain.heldInputMs).toBeGreaterThan(0);
  expect(capabilityCalls).toBe(0);
  expect(pinCalls).toBe(0);
  expect(ordering).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(fetchToFile).not.toHaveBeenCalled();
  fetch.mockRestore();
  fetchToFile.mockRestore();
  const trace = skipped.logs.filter((line) => line.startsWith("git-sync held-trace "));
  expect(trace).toHaveLength(1);
  expect(trace[0]).toMatch(/repo="repo" storedAttempt=1 earlySkip=1 matchConsulted=1 mismatch=none earlyReason=none blocker=/);
  expect(trace[0]).toMatch(/ allMs=\d+$/);
  for (const field of ["fetchDecryptMs", "verifyMs", "importMs", "classifyMs", "supersessionProofMs", "otherMs"]) {
    expect(trace[0]).toMatch(new RegExp(`${field}=\\d+`));
  }
  expect(skipped.outcome.gitRepos?.repo).toEqual(saved.lastSyncedManifest.gitRepos?.repo);
  expect(skipped.outcome.attempt?.repo).toBeUndefined();

  await git(receiver, "update-ref", "refs/heads/local-side", await git(receiver, "rev-parse", "refs/heads/main"), local);
  capabilityCalls = 0;
  const resumed = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(resumed.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(capabilityCalls).toBeGreaterThan(0);
});

test("legacy held attempt upgrades after one late match, then early-skips without fetch", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree,
    "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);

  const initial = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  const initialAttempt = initial.outcome.attempt?.repo;
  expect(initialAttempt?.classifierInputKey).toBeDefined();
  if (!initialAttempt) throw new Error("expected held attempt");
  const legacy = await landOutcome(state, initial.outcome, 2);
  const persistedAttempt = repoRecordsForState(legacy).repo?.attempt;
  if (!persistedAttempt) throw new Error("expected persisted held attempt");
  delete persistedAttempt.classifierInputKey;
  await saveStateUnsafeLegacyOrTest(workspace, legacy);

  process.env.RBOX_TRACE_HELD = "1";
  const fetch = spyOn(store, "get");
  const fetchToFile = spyOn(store, "getToFile");
  let fullPathCalls = 0;
  const upgraded = await applyIncoming(legacy, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    afterHeldSkipPrepass: () => { fullPathCalls++; },
  });
  expect(upgraded.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(fullPathCalls).toBe(1);
  expect(upgraded.outcome.attempt?.repo?.classifierInputKey).toBeDefined();
  expect(upgraded.logs.find((line) => line.startsWith("git-sync held-trace ")))
    .toMatch(/earlySkip=0 .*mismatch=none earlyReason=legacy-classifier-key /);

  const modern = await landOutcome(legacy, upgraded.outcome, 3);
  fetch.mockClear();
  fetchToFile.mockClear();
  const skipped = await applyIncoming(modern, incoming, matchingOracle, {
    sourceGlobalSeq: 4,
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    afterHeldSkipPrepass: () => { fullPathCalls++; },
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(fullPathCalls).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(fetchToFile).not.toHaveBeenCalled();
  expect(skipped.logs.find((line) => line.startsWith("git-sync held-trace ")))
    .toMatch(/earlySkip=1 .*mismatch=none earlyReason=none /);
  fetch.mockRestore();
  fetchToFile.mockRestore();
});

test("disk-backed pull durably upgrades a matched legacy held attempt", async () => {
  const { state, base, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree,
    "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);

  const initial = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  const legacy = await landOutcome(state, initial.outcome, 2);
  const persistedAttempt = repoRecordsForState(legacy).repo?.attempt;
  if (!persistedAttempt) throw new Error("expected persisted held attempt");
  delete persistedAttempt.classifierInputKey;

  const disk = await scanManifest(workspace, buildIgnoreMatcher(workspace));
  legacy.stream = syncStreamId(cfg);
  legacy.lastSyncedManifest = { ...disk, manifestSchema: 2, gitRepos: { repo: base } };
  await saveStateUnsafeLegacyOrTest(workspace, legacy);
  await Bun.sleep(GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 100);

  const remote = { ...disk, manifestSchema: 2 as const, gitRepos: { repo: incoming } };
  const api = { blobStore: () => store } as SyncRemote;
  const logs: string[] = [];
  process.env.RBOX_TRACE_HELD = "1";
  expect(repoRecordsForState(await loadState(workspace, syncStreamId(cfg))).repo?.attempt?.classifierInputKey).toBeUndefined();
  await applyPulledManifest(workspace, cfg, { remote: api, onGitLog: (line) => logs.push(line) }, api, { sequence: 3, manifest: remote });

  const reloaded = await loadState(workspace, syncStreamId(cfg));
  expect(repoRecordsForState(reloaded).repo?.attempt?.classifierInputKey).toBeDefined();
  expect(logs.find((line) => line.startsWith("git-sync held-trace ")))
    .toMatch(/earlySkip=0 .*mismatch=none earlyReason=legacy-classifier-key /);

  const fetch = spyOn(store, "get");
  const fetchToFile = spyOn(store, "getToFile");
  await applyPulledManifest(workspace, cfg, { remote: api, onGitLog: (line) => logs.push(line) }, api, { sequence: 4, manifest: remote });
  expect(fetch).not.toHaveBeenCalled();
  expect(fetchToFile).not.toHaveBeenCalled();
  expect(logs.filter((line) => line.startsWith("git-sync held-trace ")).at(-1))
    .toMatch(/earlySkip=1 .*mismatch=none earlyReason=none /);
  fetch.mockRestore();
  fetchToFile.mockRestore();
});

test("disk-backed pull follows pending checkout when a local edit clears without another push", async () => {
  const { state, base, incoming } = await baseAndIncoming();
  const cleanDisk = await scanManifest(workspace, buildIgnoreMatcher(workspace));
  state.stream = syncStreamId(cfg);
  state.lastSyncedManifest = { ...cleanDisk, manifestSchema: 2, gitRepos: { repo: base } };
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "receiver-only edit\n");

  const remote = { ...cleanDisk, manifestSchema: 2 as const, gitRepos: { repo: incoming } };
  const api = { blobStore: () => store } as SyncRemote;
  await applyPulledManifest(workspace, cfg, { remote: api }, api, { sequence: 2, manifest: remote });
  const held = await loadState(workspace, syncStreamId(cfg));
  expect(repoRecordsForState(held).repo?.attempt?.blockers).toContainEqual(expect.objectContaining({
    provenance: "checkout", reason: "local-edits",
  }));
  expect(repoRecordsForState(held).repo?.pending).toEqual(incoming);
  expect(repoRecordsForState(held).repo?.deferrals?.apply?.reason).toBe("local-edits");

  await Bun.sleep(GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 100);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  const logs: string[] = [];
  process.env.RBOX_TRACE_HELD = "1";
  await applyPulledManifest(workspace, cfg, { remote: api, onGitLog: (line) => logs.push(line) }, api, { sequence: 3, manifest: remote });

  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  const settled = repoRecordsForState(await loadState(workspace, syncStreamId(cfg))).repo;
  expect(settled?.pending).toBeUndefined();
  expect(settled?.partial).toBeUndefined();
  expect(settled?.attempt).toBeUndefined();
  expect(settled?.deferrals?.apply).toBeUndefined();
  expect(logs.find((line) => line.startsWith("git-sync held-trace ")))
    .toMatch(/earlySkip=0 .*mismatch=none earlyReason=retention-ineligible /);
});

test("held skip survives a higher-sequence transport recapture and retries a semantic change", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree,
    "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);

  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  const saved = await landOutcome(state, first.outcome, 2);
  const recaptured = {
    ...incoming,
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: incoming.bundleCipherSize + 1,
  };
  let followCalls = 0;
  const skipped = await applyIncoming(saved, recaptured, matchingOracle, {
    sourceGlobalSeq: 3,
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { followCalls++; return true; },
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(followCalls).toBe(0);

  const changed = await applyIncoming(saved, {
    ...incoming,
    head: incoming.refs["refs/heads/main"]!,
  }, matchingOracle, {
    sourceGlobalSeq: 4,
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { followCalls++; return true; },
  });
  expect(changed.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(followCalls).toBeGreaterThan(0);
});

test("design 176: own composer-pending hold maps to its causal ref blocker and becomes skippable", async () => {
  await commit("main base\n", "main base");
  await git(sender, "branch", "topic");
  const base = await capture();
  await materialize(base);
  await git(sender, "switch", "-q", "topic");
  await commit("incoming topic\n", "incoming topic");
  await git(sender, "switch", "-q", "main");
  const incoming = await capture();

  const topic = "refs/heads/topic";
  const oldTopic = await git(receiver, "rev-parse", topic);
  const tree = await git(receiver, "rev-parse", `${oldTopic}^{tree}`);
  const localTopic = await gitExec([
    "-C", receiver,
    "-c", "user.email=t@t.t",
    "-c", "user.name=t",
    "commit-tree", tree,
    "-p", oldTopic,
    "-m", "local topic",
  ]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", topic, localTopic, oldTopic);

  const state = stateWith(base);
  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  expect(first.outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(first.outcome.partial?.repo?.heldRefs[topic]).toBe("local-commits");
  expect(first.outcome.attempt?.repo?.blockers).toContainEqual({
    provenance: "ref-plane", reason: "local-commits", ref: topic,
  });
  expect(first.outcome.attempt?.repo?.blockers.some((blocker) => blocker.provenance === "composer")).toBe(false);

  const saved = await landOutcome(state, first.outcome, 2);
  let followCalls = 0;
  const second = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { followCalls++; return true; },
  });
  expect(second.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(followCalls).toBe(0);
});

test("local-edits never held-skips because working-tree bytes are outside the Git fingerprint", async () => {
  const { state, incoming } = await baseAndIncoming();
  const oracle = {
    proveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const first = await applyIncoming(state, incoming, oracle, { collectMetrics: true });
  expect(first.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
  expect(first.outcome.attempt?.repo).toBeDefined();
  const saved = await landOutcome(state, first.outcome, 2);
  const withoutStanding = structuredClone(saved);
  delete withoutStanding.repoRecords?.repo?.deferrals;
  let capabilityCalls = 0;
  const unguarded = await applyIncoming(withoutStanding, incoming, oracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(unguarded.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(capabilityCalls).toBeGreaterThan(0);

  capabilityCalls = 0;
  const guarded = await applyIncoming(saved, incoming, oracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(guarded.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(guarded.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
  expect(capabilityCalls).toBeGreaterThan(0);
});

test("stale AUTO_MERGE mismatch follows and checkout conformance removes the fossil", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const autoMerge = await git(receiver, "rev-parse", `${c1}^{tree}`);
  await fs.writeFile(path.join(receiver, ".git", "AUTO_MERGE"), `${autoMerge}\n`);
  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  expect(first.outcome.deferrals?.repo?.apply).toBeUndefined();
  expect(first.logs).toContain("git-sync followed repo");
  await expect(fs.access(path.join(receiver, ".git", "AUTO_MERGE"))).rejects.toThrow();
});

test("design 176 v6: unchanged local-index hold is eligible for held-skip", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "held-index.txt"), "held\n");
  await git(receiver, "add", "held-index.txt");
  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  expect(first.outcome.attempt?.repo?.blockers).toContainEqual(expect.objectContaining({
    provenance: "checkout", reason: "local-index",
  }));
  const saved = await landOutcome(state, first.outcome, 2);
  let capabilityCalls = 0;
  const retried = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(retried.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(capabilityCalls).toBe(0);
});

test("design 176 v6: index repair after classification records no stale attempt", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "held-index.txt"), "held\n");
  await git(receiver, "add", "held-index.txt");
  let seamCalls = 0;
  const first = await applyIncoming(state, incoming, matchingOracle, {
    collectMetrics: true,
    afterHeldClassification: async () => {
      seamCalls++;
      await git(receiver, "reset", "--mixed", "HEAD");
    },
  });
  expect(seamCalls).toBe(1);
  expect(first.outcome.attempt?.repo).toBeNull();
  const saved = await landOutcome(state, first.outcome, 2);
  let capabilityCalls = 0;
  const retried = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(retried.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(capabilityCalls).toBeGreaterThan(0);
});

test("#573: a receiver branch with no BASE authority holds as local-commits, never an untyped checkout blocker", async () => {
  const { state, incoming } = await baseAndIncoming();
  // Receiver-only branch at a tip the incoming refs still reach: displacement
  // pins succeed, so publication reaches the branch transition, which has no
  // BASE authority for this ref (absent from BASE and from incoming).
  await git(receiver, "update-ref", "refs/heads/side-at-base", await git(receiver, "rev-parse", "refs/heads/main"));

  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  const blockers = first.outcome.attempt?.repo?.blockers ?? [];
  expect(blockers).not.toHaveLength(0);
  expect(blockers.filter((blocker) => blocker.reason === "other")).toEqual([]);
  expect(blockers).toContainEqual({
    provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/side-at-base",
  });
  expect(heldBlockersAllowSkip(blockers)).toBe(true);

  const saved = await landOutcome(state, first.outcome, 2);
  let capabilityCalls = 0;
  const skipped = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(capabilityCalls).toBe(0);
});

test("#573: a genuinely untypeable publication failure stays reason other and never held-skips", async () => {
  // A tag the publisher dropped: BASE authorizes the receiver's value, so
  // publication proceeds and the injected failure is a genuinely unclassified
  // one — it must stay `other` and stay held-skip ineligible.
  await commit("one\n", "tag-c1");
  await git(sender, "tag", "dropped-tag");
  const base = await capture();
  await materialize(base);
  await git(sender, "tag", "-d", "dropped-tag");
  await commit("two\n", "tag-c2");
  const incoming = await capture();
  const state = stateWith(base);

  const first = await applyIncoming(state, incoming, matchingOracle, {
    collectMetrics: true,
    afterBranchPinsPrepared: (ref: string) => {
      if (ref === "refs/tags/dropped-tag") throw new Error("injected unclassifiable publication failure");
    },
  });
  const blockers = first.outcome.attempt?.repo?.blockers ?? [];
  expect(blockers).toContainEqual({
    provenance: "checkout",
    reason: "other",
    detail: "publishing ref refs/tags/dropped-tag failed: injected unclassifiable publication failure",
  });
  expect(heldBlockersAllowSkip(blockers)).toBe(false);

  const saved = await landOutcome(state, first.outcome, 2);
  let capabilityCalls = 0;
  const retried = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => { capabilityCalls++; return true; },
  });
  expect(retried.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(capabilityCalls).toBeGreaterThan(0);
});

test("design 176 v6: rejected attempt is cleared when full follow defers before classification", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "held-index.txt"), "held\n");
  await git(receiver, "add", "held-index.txt");
  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  const saved = await landOutcome(state, first.outcome, 2);
  saved.repoRecords!.repo!.attempt!.at = new Date(Date.now() - 3_700_000).toISOString();

  const deferred = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    capabilityProbe: async () => false,
  });
  expect(deferred.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(deferred.outcome.attempt?.repo == null).toBe(true);
});

test("design 174 A: elapsed floor re-follows and refreshes the same held outcome", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held floor side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  const first = await applyIncoming(state, incoming);
  const saved = await landOutcome(state, first.outcome, 2);
  const expiredAt = new Date(Date.now() - 3_700_000).toISOString();
  saved.repoRecords!.repo!.attempt!.at = expiredAt;

  const same = await applyIncoming(saved, incoming, matchingOracle, { collectMetrics: true, heldNow: heldNowAfterRacyWindow });
  expect(same.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(Date.parse(same.outcome.attempt!.repo!.at)).toBeGreaterThan(Date.parse(expiredAt));
  expect(same.logs.some((line) => line.includes("held-skip fingerprint miss"))).toBe(false);
});

test("design 174 A: elapsed floor warns when unchanged bound inputs yield a different blocker set", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "held warning side"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  const first = await applyIncoming(state, incoming);
  const saved = await landOutcome(state, first.outcome, 2);
  saved.repoRecords!.repo!.attempt!.at = new Date(Date.now() - 3_700_000).toISOString();
  const unreadable: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "indeterminate", why: "floor adversary" }),
    reproveRepo: async () => ({ kind: "indeterminate", why: "floor adversary" }),
    receiptHash: () => undefined,
  };
  const changed = await applyIncoming(saved, incoming, unreadable, { collectMetrics: true, heldNow: heldNowAfterRacyWindow });
  expect(changed.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  expect(changed.logs.some((line) => line.includes("held-skip fingerprint miss"))).toBe(true);
});

test("design safety: receiver-only tag is held and reachable while the safe checkout follows", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "tag-only commit"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/tags/receiver-only", local);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(outcome.partial?.repo?.heldRefs["refs/tags/receiver-only"]).toBe("local-commits");
  expect(outcome.partial?.repo?.checkoutPending).toBe(false);
  expect(await git(receiver, "rev-parse", "refs/tags/receiver-only")).toBe(local);
  await expect(git(receiver, "cat-file", "-e", `${local}^{commit}`)).resolves.toBe("");
});

test("design safety: ignored human file stays byte-identical and does not block metadata follow", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(workspace, ".rboxignore"), "repo/*.local\n");
  await fs.writeFile(path.join(receiver, "human.local"), "precious ignored bytes\n");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const expected = "three\n";
  const oracle = oracleFromState({
    root: workspace,
    matcher: buildIgnoreMatcher(workspace),
    base: {
      generatedAt: "",
      files: [{
        path: "repo/tracked.txt", type: "file", sha256: hashBytes(Buffer.from(expected)),
        size: Buffer.byteLength(expected), mode: 0o644, mtimeMs: 0,
      }],
    },
  });
  const { logs } = await applyIncoming(state, incoming, oracle);
  expect(logs).toContain("git-sync followed repo");
  expect(await fs.readFile(path.join(receiver, "human.local"), "utf8")).toBe("precious ignored bytes\n");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
});

test("deferredSince survives a partial follow followed by a new defer reason", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "side only"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  await saveStateUnsafeLegacyOrTest(workspace, state);
  const first = await applyIncoming(state, incoming);
  const since = first.outcome.deferrals?.repo?.apply?.deferredSince;
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream", sourceGlobalSeq: 2, observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  });
  const unreadable: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "indeterminate", why: "later read failure" }),
    reproveRepo: async () => ({ kind: "indeterminate", why: "later read failure" }),
    receiptHash: () => undefined,
  };
  await commit("four\n", "c4 after partial");
  const newer = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "four\n");
  const second = await applyIncoming(saved, newer, unreadable, { sourceGlobalSeq: 3 });
  expect(second.outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
  expect(second.outcome.deferrals?.repo?.apply?.deferredSince).toBe(since);
});

test("disposition: receiver-only stash defers local-stash and preserves stash", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "stash.txt"), "stash work\n");
  await git(receiver, "add", "stash.txt");
  await git(receiver, "stash", "push", "-qm", "receiver stash");
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  const stash = await git(receiver, "rev-parse", "refs/stash");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-stash");
  expect(await git(receiver, "rev-parse", "refs/stash")).toBe(stash);
});

test("incoming stash publishes a usable receiver reflog entry", async () => {
  const { c1, state } = await baseAndIncoming();
  await fs.writeFile(path.join(sender, "stash.txt"), "incoming stash\n");
  await git(sender, "add", "stash.txt");
  await git(sender, "stash", "push", "-qm", "incoming stash row");
  const incoming = await capture();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const result = await applyIncoming(state, incoming);
  expect(result.logs).toContain("git-sync followed repo");
  expect(await git(receiver, "stash", "list")).toContain("incoming stash row");
  await git(receiver, "stash", "pop", "-q");
  expect(await fs.readFile(path.join(receiver, "stash.txt"), "utf8")).toBe("incoming stash\n");
});

test("oracle indeterminate defers unreadable", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "indeterminate", why: "test unreadable" }),
    reproveRepo: async () => ({ kind: "indeterminate", why: "test unreadable" }),
    receiptHash: () => undefined,
  };
  const { outcome } = await applyIncoming(state, incoming, oracle);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});

test("flag zero keeps the legacy conflict checkpoint; invalid values stay on", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "local flag-off edit\n");
  await git(receiver, "add", "tracked.txt");
  process.env.RBOX_GIT_FOLLOW = "0";
  const flagged = { ...incoming, refs: { ...incoming.refs, "refs/heads/flag-safe": incoming.refs["refs/heads/main"]! } };
  const off = await applyIncoming(state, flagged);
  expect(off.outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(off.outcome.deferrals?.repo?.apply?.reason).toBe("conflict");
  expect(await git(receiver, "rev-parse", "refs/heads/flag-safe")).toBe(flagged.refs["refs/heads/flag-safe"]);

  process.env.RBOX_GIT_FOLLOW = "invalid";
  const checkpoint: SyncState = {
    stream: state.stream,
    stateNonce: state.stateNonce,
    lastSyncedSequence: 2,
    lastSyncedManifest: manifest(flagged),
    gitNeedsResolution: { repo: off.outcome.gitNeedsResolution!.repo },
    repoRecords: {
      repo: {
        repoGen: 2,
        sourceSeq: 2,
        base: flagged,
        idxProj: off.outcome.idxProj?.repo ?? undefined,
        resolutionKey: off.outcome.gitNeedsResolution!.repo,
        deferrals: { apply: off.outcome.deferrals!.repo!.apply! },
      },
    },
  };
  await saveStateUnsafeLegacyOrTest(workspace, checkpoint);
  const on = await applyIncoming(checkpoint, flagged);
  expect(on.outcome.gitNeedsResolution?.repo).toBeDefined();
});

test("unsupported checkout capability defers without creating a legacy checkpoint", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const unsupported = { ...incoming, refs: { ...incoming.refs, "refs/heads/unsupported-safe": incoming.refs["refs/heads/main"]! } };
  const { outcome } = await applyIncoming(state, unsupported, matchingOracle, { capabilityProbe: async () => false });
  expect(outcome.gitNeedsResolution?.repo).toBeUndefined();
  expect(outcome.gitRepos?.repo).toEqual(state.lastSyncedManifest.gitRepos?.repo);
  expect(outcome.gitPendingRemote?.repo).toEqual(unsupported);
  expect(outcome.partial?.repo?.checkoutPending).toBe(true);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unsupported");
  expect(await git(receiver, "rev-parse", "refs/heads/unsupported-safe")).toBe(unsupported.refs["refs/heads/unsupported-safe"]);
});

test("degraded mutex keeps legacy conflict and performs no independent follow", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "local degraded edit\n");
  await git(receiver, "add", "tracked.txt");
  const { outcome } = await applyIncoming(state, incoming, matchingOracle, { degradedMutex: true });
  expect(outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(old);
});

test("degraded retry performs intent rollback before taking the legacy path", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "local degraded retry edit\n");
  await git(receiver, "add", "tracked.txt");
  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming, matchingOracle, { degradedMutex: true });
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(old);
  expect(retry.outcome.gitNeedsResolution?.repo).toBeDefined();
});

test("second-proof oracle mismatch aborts with local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "match" }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const result = await applyIncoming(state, incoming, oracle);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(old);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal")).catch(() => [])).toEqual([]);
});

type BoundaryMutation = "git-add" | "commit" | "checkout" | "stash" | "op-state";
const boundaryMutations: Array<{ mutation: BoundaryMutation; reason: string }> = [
  { mutation: "git-add", reason: "local-index" },
  // These move the current ref after the first live snapshot, so the pinned
  // transaction's exact-old-value CAS is the protecting guard.
  { mutation: "commit", reason: "other" },
  { mutation: "checkout", reason: "other" },
  { mutation: "stash", reason: "local-stash" },
  { mutation: "op-state", reason: "local-operation" },
];

for (const { mutation, reason } of boundaryMutations) {
  test(`design safety linearization: ${mutation} before the boundary is protected`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    let mutated = false;
    let protectedOid: string | undefined;
    const mutate = async (): Promise<void> => {
      if (mutated) return;
      mutated = true;
      if (mutation === "git-add") {
        await fs.writeFile(path.join(receiver, "boundary-index.txt"), "boundary\n");
        await git(receiver, "add", "boundary-index.txt");
      } else if (mutation === "commit") {
        await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "boundary commit");
      } else if (mutation === "checkout") {
        const tree = await git(receiver, "rev-parse", `${c1}^{tree}`);
        protectedOid = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "boundary checkout commit"])
          .then(({ stdout }) => stdout.toString().trim());
        await git(receiver, "branch", "boundary-checkout", protectedOid);
        await git(receiver, "symbolic-ref", "HEAD", "refs/heads/boundary-checkout");
      } else if (mutation === "stash") {
        await fs.writeFile(path.join(receiver, "boundary-stash.txt"), "boundary stash\n");
        await git(receiver, "stash", "push", "-uqm", "boundary stash");
        protectedOid = await git(receiver, "rev-parse", "refs/stash");
      } else {
        await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
      }
    };
    const result = await applyIncoming(state, incoming, matchingOracle, { capabilityProbe: async () => { await mutate(); return true; } });
    expect(result.outcome.deferrals?.repo?.apply?.reason).toBe(reason);
    expect(result.outcome.gitPendingRemote?.repo).toEqual(incoming);
    if (mutation === "checkout") {
      expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/boundary-checkout");
      expect(await git(receiver, "rev-parse", "HEAD")).toBe(protectedOid);
    } else if (mutation === "stash") {
      expect(await git(receiver, "rev-parse", "refs/stash")).toBe(protectedOid);
      await expect(git(receiver, "cat-file", "-e", `${protectedOid}^{commit}`)).resolves.toBe("");
    }
  });
}

for (const { mutation } of boundaryMutations) {
  test(`design safety linearization: ${mutation} after the boundary remains ordinary post-follow work`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    let mutated = false;
    const postFollow = (point: FollowCrashPoint): void => {
      if (point !== "after-published-flip" || mutated) return;
      mutated = true;
      if (mutation === "git-add") {
        fsSync.writeFileSync(path.join(receiver, "post-index.txt"), "post\n");
        execFileSync("git", ["-C", receiver, "add", "post-index.txt"], { env: TEST_GIT_ENV });
      } else if (mutation === "commit") {
        execFileSync("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "post-follow commit"], { env: TEST_GIT_ENV });
      } else if (mutation === "checkout") {
        execFileSync("git", ["-C", receiver, "checkout", "-qb", "post-follow-checkout"], { env: TEST_GIT_ENV });
      } else if (mutation === "stash") {
        fsSync.writeFileSync(path.join(receiver, "post-stash.txt"), "post stash\n");
        execFileSync("git", ["-C", receiver, "stash", "push", "-uqm", "post-follow stash"], { env: TEST_GIT_ENV });
      } else {
        fsSync.writeFileSync(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
      }
    };
    const result = await applyIncoming(state, incoming, matchingOracle, { crashAt: postFollow });
    expect(result.logs).toContain("git-sync followed repo");
    expect(mutated).toBe(true);
    if (mutation === "git-add") expect(await git(receiver, "diff", "--cached", "--name-only")).toContain("post-index.txt");
    else if (mutation === "commit") expect(await git(receiver, "log", "-1", "--format=%s")).toBe("post-follow commit");
    else if (mutation === "checkout") expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/post-follow-checkout");
    else if (mutation === "stash") expect(await git(receiver, "stash", "list")).toContain("post-follow stash");
    else expect(await fs.readFile(path.join(receiver, ".git", "MERGE_HEAD"), "utf8")).toBe(`${c1}\n`);
  });
}

for (const point of [
  "after-safe-refs",
  "after-journal-write",
  "after-connectivity-proof",
  "after-prepare",
  "after-index-lock",
  "after-head-commit",
  "after-ref-commit",
  "before-index-publish",
  "after-index-publish",
  "mid-op-state",
  "after-published-flip",
] as const satisfies readonly FollowCrashPoint[]) {
  test(`crash recovery at ${point} is coherent and retry converges`, async () => {
    const { c1, base, state, incoming: firstIncoming } = await baseAndIncoming(point === "after-head-commit" ? "switch" : "same");
    let incoming = firstIncoming;
    if (point === "mid-op-state") {
      await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${c1}\n`);
      incoming = await capture();
    }
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    await saveStateUnsafeLegacyOrTest(workspace, state);
    const crashAt = (seen: FollowCrashPoint) => { if (seen === point) throw new FollowCrashInjectedError(seen); };
    await expect(applyIncoming(state, incoming, matchingOracle, { crashAt })).rejects.toThrow(`injected follow crash at ${point}`);

    const retryState = await loadState(workspace, "test-stream");
    const retry = await applyIncoming(retryState, incoming);
    expect(retry.logs.some((line) => line === "git-sync followed repo" || line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
    const incomingHeadRef = /^ref:\s*(refs\/\S+)/.exec(incoming.head)?.[1];
    expect(await git(receiver, "rev-parse", "HEAD")).toBe(incomingHeadRef ? incoming.refs[incomingHeadRef] : incoming.head.trim());
    const persistedAfterRetry = await loadState(workspace, "test-stream");
    expect(await indexIdentityV2(receiver, path.join(receiver, ".git", "index"))).toBe(retry.outcome.idxProj?.repo ?? persistedAfterRetry.repoRecords?.repo?.idxProj);
    await withRevalidatedGitPartialApplies(workspace, retryState, retry.outcome, async () => undefined);
    const journalRoot = path.join(workspace, ".rbox", "state", "git-journal");
    expect(await fs.readdir(journalRoot).catch(() => [])).toEqual([]);
    if (point !== "after-head-commit") expect(base.refs["refs/heads/main"]).not.toBe(incoming.refs["refs/heads/main"]);
  }, 20_000);
}

test("crash-window human ref move is preserved and takes conflict path", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  const tree = await git(receiver, "rev-parse", `${incoming.refs["refs/heads/main"]}^{tree}`);
  const human = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", incoming.refs["refs/heads/main"]!, "-m", "human crash-window move"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/main", human, incoming.refs["refs/heads/main"]!);

  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(human);
  expect(retry.outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(retry.logs.some((line) => line.includes("crash-window human changes preserved"))).toBe(true);
});

test("rebind with a surviving intent journal quarantines it without touching Git", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  const crashTip = await git(receiver, "rev-parse", "HEAD");
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  const rebound = await recoverFollowJournal(workspace, "repo", await checkoutJournalBinding("new-stream", "new-nonce", ctx));
  expect(rebound.status).toBe("binding-mismatch");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(crashTip);
  if (rebound.status === "binding-mismatch") expect(await fs.stat(rebound.quarantinePath)).toBeDefined();
});

test("crash after safe-ref publish is idempotent and retry does not duplicate mutation", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side");
  const base = await capture();
  await materialize(base);
  await git(sender, "checkout", "-q", "side");
  await commit("side-three\n", "side c3");
  const incomingSide = await git(sender, "rev-parse", "side");
  await git(sender, "checkout", "-q", "main");
  await commit("main-three\n", "main c3");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "main-three\n");
  const state = stateWith(base);
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-safe-refs") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-safe-refs");
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);

  const retryState = await loadState(workspace, "test-stream");
  const retry = await applyIncoming(retryState, incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);
  expect(retry.logs).toContain("git-sync followed repo");
  expect(retry.outcome.gitPendingRemote?.repo).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, retryState, retry.outcome, async () => undefined);
});

test("design safety: artifact failure after safe-ref progress preserves the published ref", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const withSafeRef = { ...incoming, refs: { ...incoming.refs, "refs/heads/artifact-safe": incoming.refs["refs/heads/main"]! } };
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await expect(applyIncoming(state, withSafeRef, matchingOracle, {
    crashAt: (point) => { if (point === "after-safe-refs") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-safe-refs");
  const safeTip = withSafeRef.refs["refs/heads/artifact-safe"]!;
  expect(await git(receiver, "rev-parse", "refs/heads/artifact-safe")).toBe(safeTip);

  const missing = withSafeRef.bundleEncSha;
  await fs.rm(path.join(tmp, "blobs", "blobs", missing.slice(0, 2), missing));
  const retry = await applyIncoming(state, withSafeRef);
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("artifact");
  expect(retry.outcome.gitPendingRemote?.repo).toEqual(withSafeRef);
  expect(await git(receiver, "rev-parse", "refs/heads/artifact-safe")).toBe(safeTip);
});

test("non-current NFF publication pins the displaced live tip in the same episode", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side");
  const base = await capture();
  await materialize(base);
  await commit("three\n", "c3");
  const tree = await git(sender, "write-tree");
  const replacement = await gitExec(["-C", sender, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-m", "unrelated side replacement"]).then(({ stdout }) => stdout.toString().trim());
  const displaced = base.refs["refs/heads/side"]!;
  await git(sender, "update-ref", "refs/heads/side", replacement, displaced);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  const result = await applyIncoming(stateWith(base), incoming);
  expect(result.logs).toContain("git-sync followed repo");
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(replacement);
  expect(await git(receiver, "rev-parse", `refs/rbox-local/keep/${displaced}`)).toBe(displaced);
  const origins = JSON.parse(await fs.readFile(path.join(receiver, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(origins[displaced]?.some((origin: { ref: string; class: string }) => origin.ref === "refs/heads/side" && origin.class === "human")).toBe(true);
});

test("working edit made after an intent crash is untouched and retry defers local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-journal-write") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-journal-write");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "human crash-window edit\n");
  const mismatch: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming, mismatch);
  expect(await fs.readFile(path.join(receiver, "tracked.txt"), "utf8")).toBe("human crash-window edit\n");
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
});

test("crash before journal clear leaves published state recoverable without duplicate mutation", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  const first = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "before-journal-clear") throw new FollowCrashInjectedError(point); },
  });
  await expect(withRevalidatedGitPartialApplies(workspace, state, first.outcome, async () => saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      resolutions: first.outcome.gitNeedsResolution,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  }))).rejects.toThrow("before-journal-clear");
  const tip = await git(receiver, "rev-parse", "HEAD");
  const landed = await loadState(workspace, "test-stream");
  const landedGen = landed.repoRecords?.repo?.repoGen;
  const retry = await applyIncoming(landed, incoming);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(tip);
  expect(retry.logs.some((line) => line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.repoGen).toBeGreaterThanOrEqual(landedGen!);
});

test("terminal state-save ref failure uses carry authority while retaining artifact settlement", async () => {
  const { state, incoming } = await baseAndIncoming();
  const first = await applyIncoming(state, incoming);
  expect(first.outcome.repoProofs?.repo).toBeDefined();
  await fs.mkdir(path.join(receiver, ".git", "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "broken"), "not-an-oid\n");

  await withRevalidatedGitPartialApplies(workspace, state, first.outcome, async () => undefined);

  expect(first.outcome.deferrals?.repo?.apply?.reason).toBe("ref-read-unreadable");
  expect(first.outcome.repoProofs?.repo?.authority.kind).toBe("pull-carry");
  expect(first.outcome.artifactSettlementProofs?.repo?.authority.kind).toBe("pull-ref-transaction");
  expect(first.outcome.gitRepos?.repo).toEqual(repoRecordsForState(state).repo?.base);
  expect(first.outcome.gitPendingRemote?.repo).toEqual(incoming);
  await fs.rm(path.join(receiver, ".git", "refs", "heads", "broken"));
  await expect(settleCommittedBranchArtifacts(workspace, state, first.outcome)).resolves.toBeDefined();
});

test("checkout-boundary excluded ref read is lossy and over-holds instead of throwing", async () => {
  const { state, incoming } = await baseAndIncoming();
  const result = await applyIncoming(state, incoming, matchingOracle, {
    beforeCheckoutSecondProof: async () => {
      await fs.mkdir(path.join(receiver, ".git", "refs", "heads"), { recursive: true });
      await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "boundary-broken"), "not-an-oid\n");
    },
  });
  expect(result.outcome.deferrals?.repo?.apply?.reason).not.toBe("other");
});

test("issue 569: checkout boundary revalidates shallow state instead of reusing admission evidence", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "HEAD");
  const shallowPath = path.join(receiver, ".git", "shallow");
  const result = await applyIncoming(state, incoming, matchingOracle, {
    beforeCheckoutSecondProof: () => fs.writeFile(shallowPath, `${c1}\n`),
  });
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("unsupported");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(old);
  await fs.rm(shallowPath, { force: true });
});

test("post-commit finalLive bookkeeping ref failure cannot convert a committed cycle to other", async () => {
  const { state, incoming } = await baseAndIncoming();
  let injected = false;
  const result = await applyIncoming(state, incoming, matchingOracle, {
    afterHeldClassification: async () => {},
    beforeFinalLive: async () => {
      injected = true;
      await fs.mkdir(path.join(receiver, ".git", "refs", "heads"), { recursive: true });
      await fs.writeFile(path.join(receiver, ".git", "refs", "heads", "final-broken"), "not-an-oid\n");
    },
  });
  expect(injected).toBe(true);
  expect(result.outcome.deferrals?.repo?.apply?.reason).not.toBe("other");
});

test("push planning completes a published journal and publishes the tombstone schema once", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await saveStateUnsafeLegacyOrTest(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-published-flip") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-published-flip");
  const logs: string[] = [];
  const plan = await planGitSections(
    workspace,
    cfg,
    await loadState(workspace, "test-stream"),
    {} as SyncRemote,
    new Set(),
    buildIgnoreMatcher(workspace),
    undefined,
    undefined,
    { onGitLog: (line) => logs.push(line) },
  );
  expect(logs.some((line) => line.includes("recovered published checkout repo before capture"))).toBe(true);
  expect(plan.gitRepos?.repo).toEqual({ ...incoming, refTombstones: {}, refTombstoneGeneration: 0 });
  expect(plan.changed).toBe(true);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.base).toEqual(incoming);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal")).catch(() => [])).toEqual([]);
});

test("published partial recovery is idempotent after a branch-switch hold", async () => {
  const { c1, state, incoming } = await baseAndIncoming("switch");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  const tree = await git(receiver, "write-tree");
  const local = await gitExec(["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "held local side"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  await saveStateUnsafeLegacyOrTest(workspace, state);
  const first = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "before-journal-clear") throw new FollowCrashInjectedError(point); },
  });
  expect(first.outcome.partial?.repo?.heldRefs["refs/heads/local-side"]).toBe("local-commits");
  await expect(withRevalidatedGitPartialApplies(workspace, state, first.outcome, async () => saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  }))).rejects.toThrow("before-journal-clear");
  const landed = await loadState(workspace, "test-stream");
  const landedGen = landed.repoRecords?.repo?.repoGen;
  const retry = await applyIncoming(landed, incoming);
  expect(retry.logs.some((line) => line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.repoGen).toBeGreaterThanOrEqual(landedGen!);
});

test("steady base-clean follow repairs a stale index cache before the next contained follow", async () => {
  const { base, state, incoming } = await baseAndIncoming();
  state.repoRecords!.repo!.idxProj = "v2:stale-cache";
  await saveStateUnsafeLegacyOrTest(workspace, state);
  const clean = await applyIncoming(state, incoming);
  expect(clean.logs).toContain("git-sync followed repo");
  expect(clean.outcome.idxProj?.repo).toStartWith("v2:");
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: { bases: clean.outcome.gitRepos, partial: clean.outcome.partial, idxProj: clean.outcome.idxProj },
  });
  await commit("four\n", "c4");
  const newer = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "four\n");
  const live = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", base.refs["refs/heads/main"]!, live);
  const followed = await applyIncoming(saved, newer, matchingOracle, { sourceGlobalSeq: 3 });
  expect(followed.outcome.deferrals?.repo?.apply).toBeDefined();
  expect(followed.logs.some((line) => line.includes("branch transition does not match logical BASE pre-state"))).toBe(true);
});

async function captureWithLiteralIndexTwins(first: string, second: string): Promise<GitSection> {
  const parent = await git(sender, "rev-parse", "HEAD");
  await fs.writeFile(path.join(sender, "blob-source"), "same bytes\n");
  const blob = await git(sender, "hash-object", "-w", "blob-source");
  await git(sender, "read-tree", "--empty");
  await git(sender, "update-index", "--add", "--cacheinfo", "100644", blob, first);
  await git(sender, "update-index", "--add", "--cacheinfo", "100644", blob, second);
  const tree = await git(sender, "write-tree");
  const commitOid = await git(sender, "commit-tree", tree, "-p", parent, "-m", "literal index twins");
  await git(sender, "update-ref", "refs/heads/main", commitOid, parent);
  return capture();
}

test("R2-9: injected NFC receiver equivalence rejects an incoming index with NFC/NFD literal twins", async () => {
  await commit("base\n", "base");
  const base = await capture();
  await materialize(base);
  const incoming = await captureWithLiteralIndexTwins("é.txt", "e\u0301.txt");
  setReceiverEquivalenceProbeForTests(async () => ({ caseAliases: false, unicodeAliases: true }));

  const { outcome, logs } = await applyIncoming(stateWith(base), incoming);

  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
  expect(logs.some((line) => line.includes("incoming index has receiver-equivalent paths"))).toBe(true);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(base.refs["refs/heads/main"]);
});

test.skipIf(!hostReceiverEquivalence.caseAliases)("R2-9: actual case-aliasing receiver rejects a case-colliding incoming index", async () => {
  await commit("base\n", "base");
  const base = await capture();
  await materialize(base);
  const incoming = await captureWithLiteralIndexTwins("Case.txt", "case.txt");

  const { outcome } = await applyIncoming(stateWith(base), incoming);

  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});

test("R2-10: NFC/NFD-twin repo keys are all deferred before either target mutates", async () => {
  await commit("base\n", "base");
  const section = await capture();
  const wireSection = { ...section, config: { "remote.origin.url": [] } };
  const first = "repos/é";
  const second = "repos/e\u0301";
  const logs: string[] = [];
  const remote: Manifest = {
    generatedAt: "",
    files: [],
    manifestSchema: 2,
    gitRepos: { [first]: wireSection, [second]: wireSection },
  };

  const outcome = await applyGitSections(workspace, cfg, stateWith(), remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line));

  expect(outcome.gitPendingRemote?.[first]).toEqual(section);
  expect(outcome.gitPendingRemote?.[second]).toEqual(section);
  expect(outcome.deferrals?.[first]?.apply?.reason).toBe("unreadable");
  expect(outcome.deferrals?.[second]?.apply?.reason).toBe("unreadable");
  expect(logs.filter((line) => line.includes("receiver-equivalent Git repo keys"))).toHaveLength(1);
  await applyGitSections(workspace, cfg, stateWith(), remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line));
  expect(logs.filter((line) => line.includes("receiver-equivalent Git repo keys"))).toHaveLength(1);
  await expect(fs.lstat(path.join(workspace, first, ".git"))).rejects.toThrow();
  await expect(fs.lstat(path.join(workspace, second, ".git"))).rejects.toThrow();
});

test("R2-11: refname alias group is held while an unrelated checkout follows", async () => {
  await commit("base\n", "base");
  await git(sender, "branch", "Foo");
  const base = await capture();
  await materialize(base);
  const sibling = path.join(tmp, "sibling-Foo");
  await git(receiver, "worktree", "add", sibling, "Foo");
  await git(sender, "branch", "foo");
  await git(sender, "branch", "-D", "Foo");
  await commit("incoming\n", "advance unrelated main");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "incoming\n");

  const { outcome, logs } = await applyIncoming(stateWith(base), incoming);

  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(await git(receiver, "rev-parse", "refs/heads/Foo")).toBe(base.refs["refs/heads/Foo"]);
  await expect(git(receiver, "rev-parse", "--verify", "refs/heads/foo")).rejects.toThrow();
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.partial?.repo?.heldRefs["refs/heads/Foo"]).toBe("ownership");
  expect(outcome.partial?.repo?.heldRefs["refs/heads/foo"]).toBe("ownership");
  expect(logs.some((line) => line.includes("receiver-equivalent Git refnames held"))).toBe(true);
});

test("design 174 C: many-ref follow has exclusive leaf coverage and an explicit residual", async () => {
  const c1 = await commit("base\n", "many-ref base");
  for (let i = 0; i < 40; i++) await git(sender, "branch", `many-${i}`, c1);
  const base = await capture();
  await materialize(base);
  const c2 = await commit("incoming\n", "many-ref incoming");
  for (let i = 0; i < 40; i++) await git(sender, "branch", "-f", `many-${i}`, c2);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "incoming\n");

  const { outcome } = await applyIncoming(stateWith(base), incoming, matchingOracle, { collectMetrics: true });
  const timing = outcome.gitApplyMetrics?.repoTimings[0];
  const chain = timing?.chain;
  if (!timing || !chain) throw new Error("missing instrumented repo timing");
  const leafSum = chain.fetchDecryptMs + chain.bundleVerifyMs + chain.gitImportMs
    + chain.refTxnExclusiveMs + chain.ownershipMs + chain.reflogMs
    + chain.connectivityProofMs + chain.indexOpStateMs + chain.journalMs
    + chain.classifyExclusiveMs + chain.heldInputMs + chain.standingProofMs;
  expect(chain.classifyMs).toBeGreaterThan(0);
  expect(chain.classifyExclusiveMs).toBeGreaterThan(0);
  expect(chain.heldInputMs).toBeGreaterThan(0);
  expect(chain.standingProofMs).toBeGreaterThan(0);
  expect(chain.journalMs).toBeGreaterThan(0);
  expect(chain.residualMs).toBeCloseTo(Math.max(0, timing.wallMs - leafSum), 5);
  expect(Math.abs(leafSum + chain.residualMs - timing.wallMs)).toBeLessThan(2);
  expect(chain.residualMs).toBeLessThanOrEqual(timing.wallMs * 0.10);
}, 30_000);

// Design 270: the artifact-plane digest and the early partial identity are new
// inputs to a shipped fast path. These pin that the path still behaves — and
// that a repair the fingerprint cannot see now invalidates it.

async function heldFixpointState(): Promise<{ saved: SyncState; incoming: GitSection }> {
  const { state, incoming } = await baseAndIncoming();
  await git(receiver, "update-ref", "refs/heads/side-at-base", await git(receiver, "rev-parse", "refs/heads/main"));
  const first = await applyIncoming(state, incoming, matchingOracle, { collectMetrics: true });
  expect(heldBlockersAllowSkip(first.outcome.attempt?.repo?.blockers ?? [])).toBe(true);
  return { saved: await landOutcome(state, first.outcome, 2), incoming };
}

function comparableRecord(state: SyncState) {
  const record = repoRecordsForState(state).repo!;
  const attempt = record.attempt ? (({ at: _at, ...rest }) => rest)(record.attempt) : undefined;
  // `at`/`lastSeen` are wall clocks the two lanes stamp independently; every
  // other durable field must be identical.
  const deferrals = record.deferrals?.apply
    ? { ...record.deferrals, apply: { ...record.deferrals.apply, lastSeen: "normalized" } }
    : record.deferrals;
  return {
    base: record.base, branchBaseOrigins: record.branchBaseOrigins, pending: record.pending,
    partial: record.partial, deferrals, idxProj: record.idxProj, attempt,
  };
}

test("design 270: skipping and re-following leave the same durable record, and publish no journal", async () => {
  const { saved, incoming } = await heldFixpointState();

  process.env.RBOX_GIT_HELD_SKIP = "0";
  const followed = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true, heldNow: heldNowAfterRacyWindow,
  }).finally(() => { delete process.env.RBOX_GIT_HELD_SKIP; });
  expect(followed.outcome.gitApplyMetrics?.results.skipped).toBe(0);
  const followedState = await landOutcome(saved, followed.outcome, 3);

  let cycles = saved;
  for (let cycle = 0; cycle < 3; cycle++) {
    const skipped = await applyIncoming(cycles, incoming, matchingOracle, {
      collectMetrics: true, heldNow: heldNowAfterRacyWindow,
    });
    expect(skipped.outcome.gitApplyMetrics?.results.skipped, `cycle ${cycle}`).toBe(1);
    // A skip performs no follow, so it publishes no checkout journal at all.
    expect(skipped.outcome.publishedJournals, `cycle ${cycle}`).toBeUndefined();
    expect(await checkoutJournalPresent(workspace, "repo"), `cycle ${cycle}`).toBe(false);
    cycles = await landOutcome(cycles, skipped.outcome, 3 + cycle);
  }
  expect(comparableRecord(cycles)).toEqual(comparableRecord(followedState));
});

test("design 270: an rbox artifact ref written between cycles forces the next pull down the full path", async () => {
  const { saved, incoming } = await heldFixpointState();
  const skipped = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true, heldNow: heldNowAfterRacyWindow,
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);

  const artifactRef = BASE_PRESENT_PREFIX + "/" + "a".repeat(64) + "/" + "b".repeat(64);
  await git(receiver, "update-ref", artifactRef, await git(receiver, "rev-parse", "refs/heads/main"));
  const invalidated = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true, heldNow: heldNowAfterRacyWindow,
  });
  expect(invalidated.outcome.gitApplyMetrics?.results.skipped).toBe(0);

  // Restoring the exact prior artifact plane restores the skip, so the digest —
  // not some incidental side effect of the write — is what invalidated it.
  await git(receiver, "update-ref", "-d", artifactRef);
  const restored = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true, heldNow: heldNowAfterRacyWindow,
  });
  expect(restored.outcome.gitApplyMetrics?.results.skipped).toBe(1);
});

/** The wedged shape of design 271: a materialized receiver whose record carries
 * NO serialized BASE. `localDivergedFromBase` (shared.ts:117) makes an absent
 * BASE unconditional local divergence, which is what routes it through the
 * follow at all. `hidden` reproduces the OTHER way a BASE leaves the manifest
 * projection (sync-state-records.ts:144-145) while the record keeps it. */
async function landingFixture(hidden?: Partial<RepoRecord>): Promise<{ state: SyncState; incoming: GitSection; prior: RepoRecord }> {
  await commit("one\n", "landing-c1");
  await commit("two\n", "landing-c2");
  const base = await capture();
  await materialize(base);
  // The sender publishes a NEW BRANCH only: the receiver's checkout, worktree
  // and index stay exactly where materialization left them, so the sole reason
  // this repository routes through the follow is its absent BASE.
  await git(sender, "branch", "feature/two");
  const incoming = await capture();
  const materialized = stateWith(base);
  const prior = materialized.repoRecords!.repo!;
  const record: RepoRecord = hidden
    ? { ...prior, ...hidden }
    : { repoGen: prior.repoGen, sourceSeq: prior.sourceSeq };
  const state: SyncState = {
    ...materialized,
    // Exactly what stateFromRepoRecords projects for each of these records.
    lastSyncedManifest: { ...materialized.lastSyncedManifest, gitRepos: {} },
    repoRecords: { repo: record },
  };
  await saveStateUnsafeLegacyOrTest(workspace, state);
  return { state, incoming, prior };
}

test("design 271: a BASE-less record lands its FIRST BASE under observed-landing authority", async () => {
  const { state, incoming } = await landingFixture();

  const { outcome } = await applyIncoming(state, incoming);

  expect(outcome.repoProofs?.repo?.authority.kind).toBe("observed-landing");
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
});

test("design 271: the published journal intent composes BEFORE the observation and carries no first BASE", async () => {
  const { state, incoming } = await landingFixture();

  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-journal-write") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-journal-write");

  const journalRoot = path.join(workspace, ".rbox", "state", "git-journal");
  const journalDir = path.join(journalRoot, (await fs.readdir(journalRoot))[0]!);
  const journal = JSON.parse(await fs.readFile(path.join(journalDir, "journal.json"), "utf8")) as {
    intended?: { record?: RepoRecord };
  };
  expect(journal.intended).toBeDefined();
  expect(journal.intended?.record?.base).toBeUndefined();
});

/** F1: the manifest projection HIDES a durable BASE for a structurally-absent or
 * removed repository. Arming on that projection would mint a replacement BASE
 * with no per-ref witness and drop the record's branch origins, so the arming
 * authority is the RECORD itself. */
for (const [label, hidden] of [
  ["structurally absent", { repoAbsent: true }],
  ["removal-marked", { removedKey: "removed-identity-1" }],
] as const) {
  test(`design 271: a ${label} record whose BASE is hidden from the projection never arms a landing`, async () => {
    const { state, incoming, prior } = await landingFixture(hidden);

    const { outcome } = await applyIncoming(state, incoming);

    expect(outcome.repoProofs?.repo?.authority.kind).toBe("pull-ref-transaction");
    // Composition holds exactly as it did before: the unmoved branch has no
    // per-ref witness, so the section stays pending and no BASE is written.
    expect(outcome.gitRepos?.repo).toBeUndefined();
    expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
    // The record's durable BASE and its origins survive untouched.
    expect(outcome.branchBaseOrigins?.repo).toBeUndefined();
    expect(prior.base).toBeDefined();
  });
}

const indeterminateOracle = (why: string): AppliedManifestOracle => ({
  proveRepo: async () => ({ kind: "indeterminate", why }),
  reproveRepo: async () => ({ kind: "indeterminate", why }),
  receiptHash: () => undefined,
});

test("disposition: a grammar-emptied oracle defers conflict-copies, not unreadable", async () => {
  const { state, incoming } = await baseAndIncoming();
  const { outcome } = await applyIncoming(state, incoming, indeterminateOracle(CONFLICT_COPY_POPULATION_WHY));
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("conflict-copies");
});

test("disposition: any other indeterminate why still defers unreadable", async () => {
  const { state, incoming } = await baseAndIncoming();
  const { outcome } = await applyIncoming(state, incoming, indeterminateOracle("repo entry is unreadable"));
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});
