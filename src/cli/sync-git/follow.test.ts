import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  BASE_ABSENT_PREFIX,
  SETTLED_ABSENCE_PREFIX,
  buildIgnoreMatcher,
  captureGitState,
  hashBytes,
  indexIdentityV2,
  oracleFromState,
  probeReceiverEquivalence,
  resetCheckoutCapabilityProbeCacheForTests,
  setReceiverEquivalenceProbeForTests,
  type AppliedManifestOracle,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { keepPinRef, readKeepPinOrigins } from "../../engine/git/keep-pins.js";
import { repoCtx } from "../../engine/git/shared.js";
import { OP_STATE_CLASSIFICATION, OP_STATE_DIRS, OP_STATE_FILES } from "../../engine/manifest-validate.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, type SyncState, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { applyGitSections, settleCommittedBranchArtifacts, withRevalidatedGitPartialApplies } from "./apply.js";
import { checkoutJournalBinding, FollowCrashInjectedError, followDivergedRepo, recoverFollowJournal, selectCheckoutSelfRootWitness, type FollowCrashPoint } from "./follow.js";
import { boundedOrigHeadPreservationError, origHeadPreservationFailureLine, origHeadWorktreeDiscriminator } from "./orig-head.js";
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
let materializedSection: GitSection | undefined;
let materializedState: SyncState | undefined;

beforeEach(async () => {
  priorGitFollow = process.env.RBOX_GIT_FOLLOW;
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
  resetCheckoutCapabilityProbeCacheForTests();
  setReceiverEquivalenceProbeForTests(undefined);
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
  return {
    stream: "test-stream",
    stateNonce: "a".repeat(32),
    lastSyncedSequence: section ? 1 : 0,
    lastSyncedManifest: section ? manifest(section) : { generatedAt: "", files: [] },
    ...(section ? { repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base: section } } } : {}),
  };
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
  const initial: SyncState = {
    ...empty,
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(section),
    repoRecords: { repo: {
      repoGen: 1,
      sourceSeq: 1,
      base: section,
      ...(outcome.branchBaseOrigins?.repo ? { branchBaseOrigins: outcome.branchBaseOrigins.repo } : {}),
    } },
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
    expect(applied.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
  });
}

const inProgressFiles = OP_STATE_FILES.filter((rel) => OP_STATE_CLASSIFICATION[rel] === "in-progress");
test("design 126 classification map covers every op-state root exactly", () => {
  expect(Object.keys(OP_STATE_CLASSIFICATION).sort()).toEqual([...OP_STATE_FILES, ...OP_STATE_DIRS].sort());
  expect(OP_STATE_CLASSIFICATION.ORIG_HEAD).toBe("breadcrumb");
  expect(inProgressFiles).toHaveLength(OP_STATE_FILES.length - 1);
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
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(before);
  expect(result.logs.some((line) => line.startsWith("git-sync: adopted stale ORIG_HEAD"))).toBe(false);
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
    expect(first.outcome.deferrals?.repo?.apply).toBeUndefined();
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
    expect(skipped.outcome.deferrals?.repo?.apply).toBeUndefined();
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
    expect(fullFollow.outcome.deferrals?.repo?.apply).toBeUndefined();
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
  expect(reenabled.outcome.deferrals?.repo?.apply == null).toBe(true);
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

test("design 174 A: unchanged allowlisted hold skips only after the mandatory prepass; a ref move resumes follow", async () => {
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
    { ...incoming, config: { "remote.origin.url": [] } },
    matchingOracle,
    { heldNow: heldNowAfterRacyWindow, afterHeldSkipPrepass: () => { exceptionHookCalled = true; throw new Error("injected outer apply exception"); } },
  );
  expect(exceptionHookCalled).toBe(true);
  expect(exceptional.outcome.gitPendingRemote?.repo?.config).toBeUndefined();

  let capabilityCalls = 0;
  let pinCalls = 0;
  const ordering: string[] = [];
  const skipped = await applyIncoming(saved, incoming, matchingOracle, {
    collectMetrics: true,
    heldNow: heldNowAfterRacyWindow,
    afterHeldSkipPrepass: () => { ordering.push("prepass"); },
    capabilityProbe: async () => { capabilityCalls++; ordering.push("follow"); return true; },
    afterBranchPinsPrepared: () => { pinCalls++; },
  });
  expect(skipped.outcome.gitApplyMetrics?.results.skipped).toBe(1);
  expect(capabilityCalls).toBe(0);
  expect(pinCalls).toBe(0);
  expect(ordering).toEqual(["prepass"]);
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

for (const [label, expectedReason, prepare] of [
  ["local-edits", "local-edits", async () => ({
    proveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch" as const, sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  })],
  ["local-operation", "local-operation", async (c1: string) => {
    await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
    return matchingOracle;
  }],
] as const) {
  test(`design 174 A: ${label} blockers never take held-skip`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    const oracle = await prepare(c1);
    const first = await applyIncoming(state, incoming, oracle, { collectMetrics: true });
    expect(first.outcome.deferrals?.repo?.apply?.reason).toBe(expectedReason);
    expect(first.outcome.attempt?.repo).toBeDefined();
    const saved = await landOutcome(state, first.outcome, 2);
    let capabilityCalls = 0;
    const retried = await applyIncoming(saved, incoming, oracle, {
      collectMetrics: true,
      heldNow: heldNowAfterRacyWindow,
      capabilityProbe: async () => { capabilityCalls++; return true; },
    });
    expect(retried.outcome.gitApplyMetrics?.results.skipped).toBe(0);
    expect(capabilityCalls).toBeGreaterThan(0);
  });
}

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
    + chain.connectivityProofMs + chain.indexOpStateMs + chain.journalMs;
  expect(chain.classifyMs).toBeGreaterThan(0);
  expect(chain.journalMs).toBeGreaterThan(0);
  expect(chain.residualMs).toBeCloseTo(Math.max(0, timing.wallMs - leafSum), 5);
  expect(chain.residualMs).toBeLessThanOrEqual(timing.wallMs * 0.10);
}, 30_000);
