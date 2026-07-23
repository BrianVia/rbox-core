import fs from "node:fs/promises";
import path from "node:path";
import { applyGitState, assertGitTargetWithinRoot, finalizeGitChainTimings, gitIdentity, gitIdentityKey, gitPreflight, indexIdentityV2, inspectLockedPRepairReceipt, isGitBusy, persistPRepairTerminal, preserveGitConflict, receiverEquivalentCollisionNames, repoCtxFromDisk, poolMap, readBaseAbsentArtifact, readBasePresentArtifact, runLockedPRepairAttempt, resumeLockedAcceptedPRepair, refreshLockedAcceptedPRepair, settleBaseAbsentArtifact, type AppliedManifestOracle, type ApplyBranchTransitionAdapter, type ApplyBranchTransitionInput, type CheckoutCapabilityProbe, type GitIdentity, type GitChainTimings, type GitSection, type IgnoreMatcher, type Manifest, type BlobStore, zeroGitChainTimings } from "../../engine/index.js";
import { canonicalizeGitConfig, sanitizeGitSectionForPersistence, validateCanonicalGitConfig, type GitConfig } from "../../engine/git/config-sync.js";
import { applyConfigTransaction, materializeFreshGitConfig, readConfigSnapshot, readParsedConfigSnapshot, sameConfigStatToken, type ConfigStatToken, type ConfigTransactionResult } from "../../engine/git/config-txn.js";
import { readAllRefs } from "../../engine/git/refs.js";
import { git, readHead, warnOnce } from "../../engine/git/shared.js";
import { DEFERRAL_LANES, expectedStateNonce, loadRawState, repoRecordsForState, type ConfigShapeIdentity, type GitDeferral, type GitDeferralReason, type GitHeldAttempt, type GitPartialApply, type RepoRecord, type RepoRecordInput, type SyncState, type TypedBlocker, type WorkspaceConfig } from "../config.js";
import { completeConfigApply, configLaneState, inputRecord, type ConfigLaneState, type GitDeferralUpdates } from "../sync-state.js";
import { checkoutJournalBinding, clearFollowJournal, deriveBaseIndexProjection, followDivergedRepo, FollowCrashInjectedError, quarantineUnboundFollowJournal, recoverAndLandFollowJournal, type FollowCrashPoint, type FollowIntended, type FollowProgress } from "./follow.js";
import { checkoutLabel, configInvalidSkipLogged, configOwnershipSkipLogged, repoDirOf, narrowerScope, projectedKey, emptyToUndef, errMsg, chainLock, gitApplyMutationKey, nestedRepoChains, gitApplyConcurrency, gitFollowEnabled, gitIncomingKey, nextDeferral, repoEquivalenceWarningLogged, sectionOpState } from "./shared.js";
import { gitConfigHash, readLocalGitConfig, sameConfigShape, configReceiver } from "./config-lane.js";
import { prepareFollowerBranchProtocol } from "./follower-protocol.js";
import { createPRepairStatePort } from "./p-repair-state.js";
import { settleExactPresentArtifact } from "./p-settlement.js";
import { commitPlannedBranchTransition, planBranchTransition } from "./branch-transition.js";
import { runUpdateRefTransaction } from "../../engine/git/keep-pins.js";
import { MutationGateClosedError, type MutationBoundary } from "../../engine/mutation-gate.js";
import { blockersAfterComposer, createHeldAttempt, gitHeldSkipEnabled, heldAttemptFloorElapsed, heldAttemptMatches, heldBlockersAllowSkip, incomingIndexArtifactDescriptor, observeHeldInputs, rebindHeldAttemptsAfterSettlement, sameHeldOutcome, sortedTypedBlockers } from "./held-skip.js";
import {
  carryRepoBaseProof,
  composeRepoBase,
  recordOriginLineage,
  type RepoBaseProof,
  type RepoBaseLockedProof,
} from "./base-composer.js";
import { acquirePreparedStateCasLocks, markStateCasCommitted, prepareStateCasLocks, releaseStateCasLocks, type HeldStateCasLock, type StateCasLockRequest } from "./state-cas-locks.js";
import type { LockfileHooks } from "../../engine/git/lockfile.js";
/** Local-vs-base divergence, projected onto the narrower of the two scopes (§7).
 *  No base → ANY local git identity is divergence-from-nothing (an independently
 *  created local repo must never be clobbered). No local identity (no repo, empty
 *  repo, deleted/unusable `.git`) → never diverged: there is no committed local work
 *  to preserve, so a clean (re)materialization loses nothing. */
function localDivergedFromBase(localId: GitIdentity | undefined, base: GitSection | undefined): boolean {
  if (!localId) return false;
  if (!base) return true;
  const n = narrowerScope(localId.refScope, base.refScope);
  return projectedKey(localId, n) !== projectedKey(base, n);
}

async function partialRefsStillMatch(repoDir: string, partial: GitPartialApply): Promise<boolean> {
  const directRefs = await readAllRefs(repoDir);
  for (const [ref, expected] of Object.entries(partial.appliedRefs)) {
    if (expected.kind === "symbolic") {
      const target = await git(repoDir, ["symbolic-ref", "-q", ref]).catch(() => undefined);
      if (target !== expected.target) return false;
    } else if (expected.kind === "absent") {
      if (directRefs[ref] !== undefined) return false;
    } else if (expected.kind === "safe-ref") {
      if ((directRefs[ref] ?? null) !== expected.afterOid) return false;
    } else {
      if (directRefs[ref] !== expected.oid) return false;
    }
  }
  return true;
}

function withoutRboxAuthoredRefs(localId: GitIdentity, base: GitSection | undefined, partial: GitPartialApply): GitIdentity {
  const refs = { ...localId.refs };
  for (const ref of Object.keys(partial.appliedRefs)) {
    const old = base?.refs[ref];
    if (old === undefined) delete refs[ref];
    else refs[ref] = old;
  }
  if (partial.checkoutPending) return { ...localId, refs };
  return {
    ...localId,
    refs,
    head: base?.head ?? localId.head,
    indexTree: base?.indexTree,
    opState: base?.opState === undefined ? undefined : sectionOpState(base),
  };
}

function checkoutMatchesIncoming(localId: GitIdentity, incoming: GitSection): boolean {
  const incomingOp = incoming.opState === undefined ? undefined : sectionOpState(incoming);
  return localId.head.trimEnd() === incoming.head.trimEnd()
    && localId.indexTree === incoming.indexTree
    && JSON.stringify(localId.opState ?? null) === JSON.stringify(incomingOp ?? null);
}
export interface GitPullOutcome {
  gitRepos?: Record<string, GitSection>;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Completed/invalidation config-lane updates, saved atomically with this
   * pull's base and pending transitions by the step-4 packet composer. */
  configLane?: Record<string, ConfigLaneState>;
  deferrals?: Record<string, GitDeferralUpdates | null>;
  partial?: Record<string, GitPartialApply | null>;
  attempt?: Record<string, GitHeldAttempt | null>;
  idxProj?: Record<string, string | null>;
  repoProofs?: Record<string, RepoBaseProof>;
  branchBaseOrigins?: Record<string, NonNullable<RepoRecord["branchBaseOrigins"]>>;
  /** Published checkout journals clear only after the surrounding state CAS. */
  publishedJournals?: string[];
  journalCrashAt?: (point: FollowCrashPoint) => void;
  gitApplyMetrics?: GitApplyMetrics;
}

export type GitApplyRunKind = "fresh" | "steady";
export type GitApplyRepoResult =
  | "unchanged"
  | "applied"
  | "deferred"
  | "conflict"
  | "removed"
  | "skipped";

export interface GitApplyRepoTiming {
  index: number;
  queueMs: number;
  wallMs: number;
  result: GitApplyRepoResult;
  commonDirGroup?: number;
  chain?: GitChainTimings;
}

export interface GitApplyMetrics {
  runKind: GitApplyRunKind;
  repos: number;
  commonDirGroups: number;
  results: Record<GitApplyRepoResult, number>;
  repoTimings: GitApplyRepoTiming[];
}

const emptyGitApplyResults = (): Record<GitApplyRepoResult, number> => ({
  unchanged: 0,
  applied: 0,
  deferred: 0,
  conflict: 0,
  removed: 0,
  skipped: 0,
});

const GIT_APPLY_RESULT_ABBR: Record<GitApplyRepoResult, string> = {
  unchanged: "u",
  applied: "a",
  deferred: "d",
  conflict: "c",
  removed: "rm",
  skipped: "s",
};

const GIT_APPLY_REPO_EXEMPLAR_CAP = 8;

interface GitApplyDistribution {
  p50: number;
  p95: number;
  max: number;
}

function gitApplyDistribution(values: number[]): GitApplyDistribution {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1]!;
  return { p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

function formatGitApplyDistribution(name: string, values: number[]): string {
  const distribution = gitApplyDistribution(values);
  return `${name} p50=${Math.round(distribution.p50)} p95=${Math.round(distribution.p95)} max=${Math.round(distribution.max)}`;
}

function gitApplyRepoExemplars(repoTimings: GitApplyRepoTiming[]): GitApplyRepoTiming[] {
  if (process.env.RBOX_DEBUG) return repoTimings;
  if (repoTimings.length <= GIT_APPLY_REPO_EXEMPLAR_CAP) {
    return [...repoTimings].sort((a, b) => a.index - b.index);
  }

  const byWall = [...repoTimings].sort((a, b) => b.wallMs - a.wallMs || a.index - b.index);
  const byQueue = [...repoTimings].sort((a, b) => b.queueMs - a.queueMs || a.index - b.index);
  const selected = new Map<number, GitApplyRepoTiming>();
  const add = (timing: GitApplyRepoTiming | undefined): void => {
    if (timing && selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) selected.set(timing.index, timing);
  };

  add(byWall[0]);
  add(byQueue[0]);
  for (const timing of [...repoTimings].sort((a, b) => a.index - b.index)) {
    if (timing.result !== "unchanged") add(timing);
  }

  let wallIndex = 0;
  let queueIndex = 0;
  const addNext = (ranked: GitApplyRepoTiming[], cursor: number): number => {
    while (cursor < ranked.length && selected.has(ranked[cursor]!.index)) cursor += 1;
    add(ranked[cursor]);
    return cursor + 1;
  };
  while (selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) {
    const sizeBefore = selected.size;
    wallIndex = addNext(byWall, wallIndex);
    if (selected.size < GIT_APPLY_REPO_EXEMPLAR_CAP) queueIndex = addNext(byQueue, queueIndex);
    if (selected.size === sizeBefore) break;
  }

  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function finishGitApplyMetrics(
  metrics: GitApplyMetrics | undefined,
  commonDirGroups: Map<string, number> | undefined
): GitApplyMetrics | undefined {
  if (!metrics) return undefined;
  return {
    ...metrics,
    commonDirGroups: commonDirGroups?.size ?? 0,
    results: { ...metrics.results },
    repoTimings: metrics.repoTimings.map((timing) => ({
      ...timing,
      ...(timing.chain ? { chain: { ...timing.chain } } : {}),
    })),
  };
}

export function formatGitApplyMetrics(metrics: GitApplyMetrics): string {
  const resultBits = (Object.entries(metrics.results) as Array<[GitApplyRepoResult, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(",");
  const repoBits = gitApplyRepoExemplars(metrics.repoTimings)
    .map((t) => {
      const group = t.commonDirGroup === undefined ? "" : `g${t.commonDirGroup}`;
      const chain = t.chain && hasGitChainTiming(t.chain)
        ? ` L${t.chain.chainLength}fd${Math.round(chainMetric(t.chain.fetchDecryptMs))}bv${Math.round(chainMetric(t.chain.bundleVerifyMs))}gi${Math.round(chainMetric(t.chain.gitImportMs))}io${Math.round(chainMetric(t.chain.indexOpStateMs))}jr${Math.round(chainMetric(t.chain.journalMs))}rt${Math.round(chainMetric(t.chain.refTxnExclusiveMs))}ow${Math.round(chainMetric(t.chain.ownershipMs))}rl${Math.round(chainMetric(t.chain.reflogMs))}cp${Math.round(chainMetric(t.chain.connectivityProofMs))}cl${Math.round(chainMetric(t.chain.classifyMs))}rs${Math.round(chainMetric(t.chain.residualMs))}`
        : "";
      return `i${t.index}q${t.queueMs}w${t.wallMs}${GIT_APPLY_RESULT_ABBR[t.result]}${group}${chain}`;
    })
    .join(",");
  const distributions = [
    formatGitApplyDistribution("queueMs", metrics.repoTimings.map((timing) => timing.queueMs)),
    formatGitApplyDistribution("wallMs", metrics.repoTimings.map((timing) => timing.wallMs)),
  ];
  const chainTimings = metrics.repoTimings
    .map((timing) => timing.chain)
    .filter((chain): chain is GitChainTimings => chain !== undefined && hasGitChainTiming(chain));
  if (chainTimings.length > 0) {
    distributions.push(
      formatGitApplyDistribution("fetchDecryptMs", chainTimings.map((chain) => chain.fetchDecryptMs)),
      formatGitApplyDistribution("bundleVerifyMs", chainTimings.map((chain) => chain.bundleVerifyMs)),
      formatGitApplyDistribution("gitImportMs", chainTimings.map((chain) => chain.gitImportMs)),
      formatGitApplyDistribution("indexOpStateMs", chainTimings.map((chain) => chain.indexOpStateMs)),
      formatGitApplyDistribution("journalMs", chainTimings.map((chain) => chainMetric(chain.journalMs))),
      formatGitApplyDistribution("refTxnExclusiveMs", chainTimings.map((chain) => chainMetric(chain.refTxnExclusiveMs))),
      formatGitApplyDistribution("ownershipMs", chainTimings.map((chain) => chainMetric(chain.ownershipMs))),
      formatGitApplyDistribution("reflogMs", chainTimings.map((chain) => chainMetric(chain.reflogMs))),
      formatGitApplyDistribution("connectivityProofMs", chainTimings.map((chain) => chainMetric(chain.connectivityProofMs))),
      formatGitApplyDistribution("classifyMs", chainTimings.map((chain) => chainMetric(chain.classifyMs))),
      formatGitApplyDistribution("residualMs", chainTimings.map((chain) => chainMetric(chain.residualMs))),
    );
  }
  return `mode=${metrics.runKind} repos=${metrics.repos} commonDirs=${metrics.commonDirGroups} skippedHeld=${metrics.results.skipped} results=${resultBits || "none"} ${distributions.join(" ")} repoMs=${repoBits || "none"}`;
}

function hasGitChainTiming(chain: GitChainTimings): boolean {
  return chain.chainLength > 0 || chain.fetchDecryptMs > 0 || chain.bundleVerifyMs > 0
    || chain.gitImportMs > 0 || chain.refTxnExclusiveMs > 0 || chain.ownershipMs > 0
    || chain.reflogMs > 0 || chain.connectivityProofMs > 0 || chain.indexOpStateMs > 0
    || chain.journalMs > 0 || chain.classifyMs > 0;
}

function chainMetric(value: number | undefined): number {
  return Number.isFinite(value) ? value! : 0;
}

/**
 * Pull-side git orchestration (design 43 §7, §9, §13.5): iterate
 * `remote.gitRepos ∪ base.gitRepos ∪ gitPendingRemote` per key. Per repo:
 *  - remote ABSENT → conflict-precedence first if a pending repo's local diverged
 *    (§13.5), then clear pending ([v6] absence supersedes pending), record a removal
 *    memory when the local `.git` survives, drop the base entry — NEVER touch local .git.
 *  - unchanged (projected onto the narrower scope) → base advances, no apply.
 *  - existing usable steady receiver + remote change → design-116 follow pipeline
 *    (oracle, classifier, safe-ref plane, journaled checkout transaction), including
 *    metadata-base-clean receivers; legacy modes retain the conflict checkpoint.
 *  - fresh targets and removal-memory clean-materialization wipes → applyGitState
 *    (containment + ignored-subtree refusal BEFORE any mutation); dir leftovers
 *    quarantine + ref-wipe first, pointer leftovers remain guarded update-only.
 *  - deferred apply → record `gitPendingRemote`; that repo's base does not advance;
 *    every other repo advances independently.
 */
export async function applyGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  remote: Manifest,
  store: BlobStore,
  matcher: IgnoreMatcher,
  glog: (line: string) => void,
opts: {
    /** D3 typed passthrough; D4b owns all follow decisions that consume it. */
    oracle?: AppliedManifestOracle;
    collectMetrics?: boolean;
    onProgress?: (done: number, total: number) => void;
    /** Workspace-wide legacy fallback: Git applies, config is left untouched. */
    disableConfigLane?: boolean;
    /** Deterministic fault injection for §11 pull-lane tests. */
    applyConfig?: typeof applyConfigTransaction;
    materializeFreshConfig?: typeof materializeFreshGitConfig;
    /** Incoming sequence used by a published journal's intended RepoRecord. */
    sourceGlobalSeq?: number;
    /** Degraded workspace mutex disables follow and independent ref publication. */
    degradedMutex?: boolean;
    capabilityProbe?: CheckoutCapabilityProbe;
    crashAt?: (point: FollowCrashPoint) => void;
    /** Test seam for a reflog-only move after pin enumeration. */
    afterBranchPinsPrepared?: (ref: string) => void | Promise<void>;
    /** Test observation point after recovery/protocol/P/partial prepasses, before A. */
    afterHeldSkipPrepass?: (relPath: string) => void | Promise<void>;
    /** Test seam after the persisted classifier but before attempt completion. */
    afterHeldClassification?: (relPath: string) => void | Promise<void>;
    /** Shared logical time for held-attempt tests; omitted production call sites
     * retain the helpers' individual wall-clock reads. */
    heldNow?: () => number;
    warningSink?: (message: string) => void;
    mutationBoundary?: MutationBoundary;
  } = {}
): Promise<GitPullOutcome> {
  const sanitizeSections = (sections: Record<string, GitSection> | undefined): Record<string, GitSection> =>
    Object.fromEntries(Object.entries(sections ?? {}).map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));
  const baseRepos = sanitizeSections(state.lastSyncedManifest.gitRepos);
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = sanitizeSections(state.gitPendingRemote);
  const records = repoRecordsForState(state);
  const configLane: Record<string, ConfigLaneState> = {};
  const deferrals: Record<string, GitDeferralUpdates | null> = {};
  const partial: Record<string, GitPartialApply | null> = {};
  const attempt: Record<string, GitHeldAttempt | null> = {};
  const idxProj: Record<string, string | null> = {};
  const repoProofs: Record<string, RepoBaseProof> = {};
  const branchBaseOrigins: Record<string, NonNullable<RepoRecord["branchBaseOrigins"]>> = {};
  const publishedJournals: string[] = [];
  let commonDirGroups: Map<string, number> | undefined;
  let metrics: GitApplyMetrics | undefined;
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(sanitizeSections(applied)),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(sanitizeSections(pending)),
    configLane: emptyToUndef(configLane),
    deferrals: emptyToUndef(deferrals),
    partial: emptyToUndef(partial),
    attempt: emptyToUndef(attempt),
    idxProj: emptyToUndef(idxProj),
    repoProofs: emptyToUndef(repoProofs),
    branchBaseOrigins: emptyToUndef(branchBaseOrigins),
    publishedJournals: publishedJournals.length ? [...publishedJournals] : undefined,
    journalCrashAt: opts.crashAt,
    gitApplyMetrics: finishGitApplyMetrics(metrics, commonDirGroups),
  });
  if (!cfg.syncGit) return pack();
  const keys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  // Logical repo keys must remain one-to-one with receiver targets even if this
  // state later lands on an NFC/case-aliasing filesystem.
  const collidingRepoKeys = receiverEquivalentCollisionNames(keys);
  if (collidingRepoKeys.size > 0) warnOnce(
    repoEquivalenceWarningLogged,
    root,
    `git-sync WARNING: receiver-equivalent Git repo keys all deferred: ${[...collidingRepoKeys].sort().join(", ")}`,
    glog,
  );
  if (opts.collectMetrics) {
    commonDirGroups = new Map();
    metrics = {
      // "fresh" = no useful local/base git state (design 74 §3) — NOT sequence 0:
      // a file-synced workspace receiving its first remote.gitRepos is fresh for
      // git purposes even at a nonzero baseline (sequence-keyed
      // classification would poison the Phase-1 gate data).
      runKind: Object.keys(baseRepos).length === 0 && Object.keys(pending).length === 0 ? "fresh" : "steady",
      repos: keys.length,
      commonDirGroups: 0,
      results: emptyGitApplyResults(),
      repoTimings: [],
    };
  }
  if (keys.length === 0) return pack();
  // Fail closed ONCE, before any per-repo work: git sections (incl. pending ones) are
  // E2EE artifacts — without the key nothing below can decrypt-verify.
  if (!cfg.kek && keys.some((k) => remote.gitRepos?.[k] !== undefined || pending[k] !== undefined)) {
    throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox key recover`.");
  }

  const commonDirGroupFor = async (repoDir: string, hasDotGit: boolean): Promise<number | undefined> => {
    if (!commonDirGroups || !hasDotGit) return undefined;
    const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!ctx) return undefined;
    const key = path.resolve(ctx.commonDir);
    let group = commonDirGroups.get(key);
    if (group === undefined) {
      group = commonDirGroups.size + 1;
      commonDirGroups.set(key, group);
    }
    return group;
  };

  const laneRecord = (rel: string): RepoRecordInput => ({
    sourceSeq: records[rel]?.sourceSeq ?? state.lastSyncedSequence,
    ...(configLane[rel] ?? configLaneState(records[rel] ?? { repoGen: 0, sourceSeq: state.lastSyncedSequence })),
  });
  const currentDeferral = (rel: string, lane: GitDeferral["lane"]): GitDeferral | undefined => {
    const transition = deferrals[rel];
    if (transition === null) return undefined;
    if (transition && Object.prototype.hasOwnProperty.call(transition, lane)) return transition[lane] ?? undefined;
    return records[rel]?.deferrals?.[lane];
  };
  const currentPartial = (rel: string): GitPartialApply | undefined =>
    partial[rel] === null ? undefined : partial[rel] ?? records[rel]?.partial;
  const setDeferral = (
    rel: string,
    lane: GitDeferral["lane"],
    reason: GitDeferralReason,
    subjectKey?: string,
    checkout?: GitDeferral["checkout"],
  ): void => {
    const next = nextDeferral(lane, currentDeferral(rel, lane), reason, new Date().toISOString(), subjectKey, checkout);
    deferrals[rel] = { ...(deferrals[rel] ?? {}), [lane]: next };
  };
  const clearDeferral = (rel: string, lane: GitDeferral["lane"]): void => {
    if (!currentDeferral(rel, lane)) return;
    // Runtime transition supports explicit-null lanes; sync-state merges mechanically.
    deferrals[rel] = { ...(deferrals[rel] ?? {}), [lane]: null };
  };
  const clearAttempt = (rel: string): void => {
    attempt[rel] = null;
  };
  const markCheckpointReproof = (rel: string): void => {
    const transition = deferrals[rel];
    const apply = transition && transition !== null ? transition.apply : undefined;
    if (apply) apply.reproof = true;
  };
  const checkoutOf = async (repoDir: string): Promise<GitDeferral["checkout"] | undefined> => {
    const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!ctx) return undefined;
    return checkoutLabel(await readHead(ctx).catch(() => ""));
  };
  const replaceLane = (rel: string, record: RepoRecordInput): void => {
    configLane[rel] = configLaneState(record);
  };
  const invalidateLaneShape = (rel: string, shape: ConfigShapeIdentity | undefined): RepoRecordInput => {
    const current = laneRecord(rel);
    if (sameConfigShape(current.cfgShape, shape)) return current;
    const reset: RepoRecordInput = { sourceSeq: current.sourceSeq, ...(shape === undefined ? {} : { cfgShape: shape }) };
    replaceLane(rel, reset);
    return reset;
  };
  const completeLane = (
    rel: string,
    shape: ConfigShapeIdentity,
    hashes: { pre: string; post: string; incoming: string; basePre?: string; postToken: ConfigStatToken }
  ): void => {
    replaceLane(rel, {
      ...completeConfigApply(laneRecord(rel), {
        pre: hashes.pre,
        post: hashes.post,
        incoming: hashes.incoming,
        ...(hashes.basePre === undefined ? {} : { basePre: hashes.basePre }),
        postToken: hashes.postToken,
      }),
      cfgShape: shape,
    });
  };
  const configFailure = (result: Exclude<ConfigTransactionResult, { status: "completed" }>): Error =>
    new Error(`config ${result.status}: ${result.fault.reason}`);
  const runMutation = async <T>(repository: string, fn: () => Promise<T>): Promise<T> => {
    const lease = opts.mutationBoundary?.enter({ phase: "git-commit", repository });
    if (lease && !lease.beginCommit()) {
      lease.finish();
      throw new MutationGateClosedError();
    }
    try {
      return await fn();
    } finally {
      lease?.finish();
    }
  };

  /** Run the config mutation only after the caller has selected the correct Git
   * disposition. Existing repos use the optimistic locked transaction; a truly
   * fresh repo uses the step-3 private-target helper. */
  const runConfigApply = async (
    rel: string,
    repoDir: string,
    incoming: GitConfig,
    baseConfig: GitConfig | undefined,
    receiver: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string }
  ): Promise<void> => {
    if (receiver.fresh) {
      await runMutation(repoDir, () =>
        (opts.materializeFreshConfig ?? materializeFreshGitConfig)(repoDir, incoming, path.join(repoDir, ".git")));
      const ctx = await repoCtxFromDisk(repoDir);
      if (!ctx) throw new Error("fresh config apply lost repository context");
      const owned = await configReceiver(root, ctx);
      if (!owned.owned) throw new Error("fresh config target is not receiver-owned");
      const installed = await readParsedConfigSnapshot(repoDir, owned.configPath, "locked");
      if (!installed.ok) throw new Error(`fresh config post-read: ${installed.fault.reason}`);
      const post = canonicalizeGitConfig(installed.snapshot.entries);
      if (!post.ok) throw new Error(`fresh config post-parse: ${post.reason}`);
      completeLane(rel, owned.shape, {
        pre: gitConfigHash({}),
        post: gitConfigHash(post.config),
        incoming: gitConfigHash(incoming),
        ...(baseConfig === undefined ? {} : { basePre: gitConfigHash(baseConfig) }),
        postToken: installed.snapshot.token,
      });
      return;
    }

    const result = await runMutation(repoDir, () =>
      (opts.applyConfig ?? applyConfigTransaction)(repoDir, receiver.configPath, incoming, { baseConfig }));
    if (result.status !== "completed") throw configFailure(result);
    for (const warning of result.warnings) {
      try {
        glog(`git-sync WARNING ${rel}: config ${warning}`);
      } catch {
        // Observability after the rename commit point is strictly non-fatal.
      }
    }
    completeLane(rel, receiver.shape, {
      pre: result.preHash,
      post: result.postHash,
      incoming: result.incomingHash,
      ...(result.baseHash === undefined ? {} : { basePre: result.baseHash }),
      postToken: result.postToken,
    });
  };

  const installRecoveredRecord = (rel: string, record: RepoRecord): void => {
    records[rel] = record;
    if (record.base) { baseRepos[rel] = record.base; applied[rel] = record.base; }
    else { delete baseRepos[rel]; delete applied[rel]; }
    if (record.pending) pending[rel] = record.pending; else delete pending[rel];
    if (record.removedKey) removedMem[rel] = record.removedKey; else delete removedMem[rel];
    if (record.resolutionKey) needsRes[rel] = record.resolutionKey; else delete needsRes[rel];
  };

  const processRepo = async (rel: string, chainTimings?: GitChainTimings): Promise<{ result: GitApplyRepoResult; commonDirGroup?: number }> => {
    const wireRemoteSec = remote.gitRepos?.[rel];
    const remoteSec = wireRemoteSec === undefined ? undefined : sanitizeGitSectionForPersistence(wireRemoteSec);
    let sanitizedConfigReason: string | undefined;
    if (wireRemoteSec?.config !== undefined) {
      const config = validateCanonicalGitConfig(wireRemoteSec.config);
      sanitizedConfigReason = !config.ok
        ? config.reason
        : wireRemoteSec.refScope === "scoped"
          ? "scoped git section cannot carry config"
          : undefined;
      if (sanitizedConfigReason) {
        const logKey = `${root}\0${rel}`;
        if (!configInvalidSkipLogged.has(logKey)) {
          configInvalidSkipLogged.add(logKey);
          glog(`git-sync WARNING ${rel}: ignored invalid incoming config (${sanitizedConfigReason}); Git state continues`);
        }
      }
    }
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    let baseSec = baseRepos[rel];
    let pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    let dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    const commonDirGroup = await commonDirGroupFor(repoDir, dotGit !== undefined);

    // Sanitizing an invalid incoming config must not make the next push author a
    // corrective echo. Record the unchanged owned local config as the config-lane
    // baseline; only a later genuine local edit is publishable.
    if (sanitizedConfigReason && !opts.disableConfigLane && dotGit) {
      const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
      if (diskCtx?.kind === "dir") {
        const receiver = await configReceiver(root, diskCtx).catch(() => undefined);
        if (receiver?.owned) {
          const local = await readLocalGitConfig(root, rel, diskCtx, undefined, () => {
            const logKey = `${root}\0${rel}`;
            if (!configInvalidSkipLogged.has(`${logKey}\0credential`)) {
              configInvalidSkipLogged.add(`${logKey}\0credential`);
              glog(`git-sync WARNING ${rel}: skipped credential-bearing remote URL from config baseline`);
            }
          });
          if (local.status === "ok") {
            const beforeLane = laneRecord(rel);
            const lane = invalidateLaneShape(rel, receiver.shape);
            const priorBaseline = beforeLane.cfgShape === undefined || sameConfigShape(beforeLane.cfgShape, receiver.shape)
              ? beforeLane.cfgSynced
              : undefined;
            replaceLane(rel, {
              ...lane,
              // Preserve an existing same-shape baseline: if the user changed
              // A→B before this pull, B must remain publishable. Seed the current
              // hash only for the first sanitation observation.
              cfgSynced: priorBaseline ?? local.cached.hash,
              cfgShape: receiver.shape,
            });
          }
        }
      }
    } else if (wireRemoteSec && wireRemoteSec.config === undefined && !opts.disableConfigLane && dotGit) {
      // Genuine wire absence is not sanitation. Clear an old authorship/baseline
      // marker so the established presence rule can heal an old writer that
      // stripped a valid config field. Invalid-present input takes the branch
      // above and deliberately retains the local hash instead.
      const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
      if (diskCtx?.kind === "dir") {
        const receiver = await configReceiver(root, diskCtx).catch(() => undefined);
        if (receiver?.owned) {
          const beforeLane = laneRecord(rel);
          // Ordinary wire absence only consumes an existing authorship
          // baseline. It must not materialize cfgShape in an otherwise empty
          // lane merely because this receiver happens to own config.
          if (beforeLane.cfgSynced !== undefined) {
            const { cfgSynced: _cfgSynced, ...withoutSynced } = beforeLane;
            replaceLane(rel, withoutSynced);
          }
        }
      }
    }

    // Design 116 recovery is the first per-repo operation in every arm. The
    // surrounding runRepo chain lock is already keyed by this common dir.
    let recoveryConflict = false;
    const recoveryCtx = dotGit ? await repoCtxFromDisk(repoDir).catch(() => undefined) : undefined;
    if (recoveryCtx) {
      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), recoveryCtx);
      const landed = await runMutation(repoDir, () => recoverAndLandFollowJournal(root, rel, binding, state, {
        land: !opts.degradedMutex,
        crashAt: opts.crashAt,
      }));
      const recovery = landed.recovery;
      if (recovery.status === "keep") {
        if (opts.degradedMutex) {
          if (remoteSec) {
            pending[rel] = remoteSec;
            setDeferral(rel, "apply", "unsupported", incomingKey, await checkoutOf(repoDir));
          }
          glog(`git-sync deferred ${rel}: published checkout journal awaits non-degraded state save`);
          return { result: "deferred", commonDirGroup };
        }
        state = landed.state;
        const recoveredRecord = repoRecordsForState(state)[rel];
        if (recoveredRecord) installRecoveredRecord(rel, recoveredRecord);
        baseSec = baseRepos[rel];
        pend = pending[rel];
        glog(`git-sync recovered published checkout ${rel}`);
      } else if (recovery.status === "defer") {
        if (remoteSec) {
          pending[rel] = remoteSec;
          setDeferral(rel, "apply", "unreadable", incomingKey, await checkoutOf(repoDir));
        }
        glog(`git-sync deferred ${rel}: ${recovery.reason}`);
        return { result: "deferred", commonDirGroup };
      } else if (recovery.status === "human-intervened") {
        recoveryConflict = true;
        glog(`git-sync WARNING ${rel}: crash-window human changes preserved (${recovery.fields.join(", ")}); journal quarantined at ${recovery.quarantinePath}`);
      } else if (recovery.status === "binding-mismatch") {
        glog(`git-sync WARNING ${rel}: stale checkout journal quarantined at ${recovery.quarantinePath}`);
      } else if (recovery.status === "fresh-quarantined") {
        glog(`git-sync WARNING ${rel}: partial fresh repository quarantined at ${recovery.quarantinePath}`);
        dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
      }
    } else {
      const recovery = await runMutation(repoDir, () =>
        quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state)));
      if (recovery.status === "binding-mismatch") {
        glog(`git-sync WARNING ${rel}: journal for an absent/unreadable repository quarantined at ${recovery.quarantinePath}`);
      } else if (recovery.status === "defer") {
        if (remoteSec) {
          pending[rel] = remoteSec;
          setDeferral(rel, "apply", "unreadable", incomingKey, await checkoutOf(repoDir));
        }
        glog(`git-sync deferred ${rel}: ${recovery.reason}`);
        return { result: "deferred", commonDirGroup };
      }
    }

    // Receiver quiescence (design 43 §7): a busy repo defers only itself, and the busy
    // check must run BEFORE any identity comparison — a lock makes write-tree fail,
    // flipping gitIdentity onto the raw-index fallback, which would read as FALSE
    // divergence (spurious conflict) or poison a removal memory with a transient key.
    const busy = dotGit !== undefined && (await isGitBusy(repoDir));
    if (busy && remoteSec) {
      pending[rel] = remoteSec; // apply needs quiescence — retry next pull; outbound carries newest truth
      setDeferral(rel, "apply", "git-busy", incomingKey, await checkoutOf(repoDir));
      glog(`git-sync deferred ${rel}: receiver git busy`);
      return { result: "deferred", commonDirGroup };
    }
    // NOTE: remote ABSENCE is processed even when busy — it never mutates local .git,
    // and skipping it would leave gitPendingRemote/base carrying a section the remote
    // deleted, which the next file-only push would resurrect.
    const localId = dotGit ? await gitIdentity(repoDir) : undefined;

    if (!remoteSec) {
      // §9 removal + [v6] absence-supersedes-pending. The DIVERGENCE EXAMINATION runs
      // first (§13.5: never stamp a removal memory over unexamined local divergence),
      // then the pure state transitions apply UNCONDITIONALLY — absence is the newer
      // truth no matter what else succeeds — and only then the best-effort recovery
      // preserve. Ordering is crash-safety: if the
      // preserve throws (blob/fs failure), the per-repo catch must not leave a stale
      // pending/base entry for the next push to resurrect.
      const diverged = pend !== undefined && localDivergedFromBase(localId, baseSec);
      delete pending[rel];
      delete needsRes[rel];
      deferrals[rel] = null;
      partial[rel] = null;
      clearAttempt(rel);
      idxProj[rel] = null;
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched). Your local Git repository is safe.`);
      }
      const retainedLineage = recordOriginLineage(records[rel]?.branchBaseOrigins) ?? "legacy-untrusted";
      repoProofs[rel] = carryRepoBaseProof(retainedLineage);
      if (dotGit) {
        // Resurrection guard [v2, B4]: the leftover's identity at removal. On a BUSY
        // repo the live identity is the volatile raw-index fallback — record the base
        // section's identity instead (projected onto the leftover's shape), which is
        // lock-immune and equals the live identity whenever the leftover is untouched.
        removedMem[rel] =
          busy && baseSec ? projectedKey(baseSec, dotGit.isFile() ? "scoped" : "all") : gitIdentityKey(localId);
      }
      // §13.5 conflict precedence: the pending remote section is preserved for manual
      // recovery. Best-effort — preserve never mutates local branches/index/identity,
      // so a failure loses only the convenience recovery bundle (logged loudly); the
      // user's diverged local work is untouched either way. (On a busy repo the
      // raw-index fallback can only over-trigger this — a safe, logged no-clobber.)
      if (diverged && pend) {
        try {
          const { recoveryBundle } = await preserveGitConflict(repoDir, pend, store, cfg.kek!);
          glog(
            `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Your local Git work is safe; inspect the preserved incoming state before resolving.`
          );
        } catch (e) {
          glog(`git-sync WARNING ${rel}: could not preserve the pending remote section after the remote deletion (local work untouched): ${errMsg(e)}`);
        }
      }
      return { result: "removed", commonDirGroup };
    }
    const inheritedConfigBase = records[rel]?.partial?.configBase ?? baseSec?.config;
    const partialFrom = (
      progress: Pick<GitPartialApply, "appliedRefs" | "heldRefs" | "configApplied">,
      checkoutPending: boolean,
    ): GitPartialApply => ({
      incomingKey: incomingKey!,
      checkoutPending,
      appliedRefs: progress.appliedRefs,
      heldRefs: progress.heldRefs,
      configApplied: progress.configApplied,
      ...(!progress.configApplied && inheritedConfigBase !== undefined ? { configBase: inheritedConfigBase } : {}),
    });
    const heldReasonOf = (heldRefs: GitPartialApply["heldRefs"]): GitDeferralReason => {
      const reasons = Object.values(heldRefs);
      return reasons.includes("local-commits") ? "local-commits"
        : reasons.includes("local-stash") ? "local-stash"
        : "worktree-ownership";
    };

    // Removal memory: a leftover whose identity still EQUALS the memory is treated as
    // ABSENT (clean materialization target [v3/v4]); a leftover that CHANGED re-enters
    // the normal rules (conflict path) with the memory cleared. An UNREADABLE pointer
    // leftover (dangling gitfile — identity unknowable) defers instead: guessing would
    // either wipe the guard or mis-run the conflict path.
    let cleanMaterialize = false;
    if (removedMem[rel] !== undefined) {
      if (!dotGit) {
        delete removedMem[rel]; // leftover gone → memory pruned; plain fresh target
      } else if (gitIdentityKey(localId) === removedMem[rel]) {
        cleanMaterialize = true;
      } else if (!localId && dotGit.isFile()) {
        pending[rel] = remoteSec;
        setDeferral(rel, "apply", "unreadable", incomingKey, await checkoutOf(repoDir));
        glog(`git-sync deferred ${rel}: leftover pointer repo unreadable — keeping removal memory`);
        return { result: "deferred", commonDirGroup };
      } else {
        delete removedMem[rel]; // identity genuinely changed (incl. a re-init'd empty dir repo)
      }
    }

    const defer = async (reason: string, typedReason: GitDeferralReason = "other") => {
      pending[rel] = remoteSec; // [v5]: outbound pushes carry newest unapplied truth
      clearAttempt(rel);
      setDeferral(rel, "apply", typedReason, incomingKey, await checkoutOf(repoDir));
      glog(`git-sync deferred ${rel}: ${reason}`);
    };

    // Design 93 §6/§9. The config predicate is deliberately decided before
    // EITHER unchanged shortcut. Receiver ownership is local shape, not sender
    // shape; cross-shape rows skip config loudly once while Git keeps its existing
    // disposition. A shape mismatch first clears the old lane markers and records
    // the new identity in this pull's atomic repo transition.
    let configDue = false;
    let configTarget: { fresh: true } | { fresh: false; shape: ConfigShapeIdentity; configPath: string } | undefined;
    if (!opts.disableConfigLane && remoteSec.config !== undefined) {
      if (!dotGit) {
        invalidateLaneShape(rel, undefined);
        configDue = true;
        configTarget = { fresh: true };
      } else {
        const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
        if (!diskCtx) {
          invalidateLaneShape(rel, undefined);
          const logKey = `${root}\0${rel}`;
          if (!configOwnershipSkipLogged.has(logKey)) {
            configOwnershipSkipLogged.add(logKey);
            glog(`git-sync config skipped ${rel}: receiver repository shape is unreadable/non-owned. rbox left shared Git settings alone; Git history can still sync.`);
          }
        } else {
          const receiver = await configReceiver(root, diskCtx);
          const lane = invalidateLaneShape(rel, receiver.shape);
          if (!receiver.owned) {
            const logKey = `${root}\0${rel}`;
            if (!configOwnershipSkipLogged.has(logKey)) {
              configOwnershipSkipLogged.add(logKey);
              glog(`git-sync config skipped ${rel}: receiver ${diskCtx.kind} shape does not own the common config. rbox left shared Git settings alone; Git history can still sync.`);
            }
          } else {
            configTarget = { fresh: false, shape: receiver.shape, configPath: receiver.configPath };
            const current = await readConfigSnapshot(receiver.configPath);
            const token = current.ok ? current.snapshot.token : undefined;
            configDue = gitConfigHash(remoteSec.config) !== lane.cfgApplied || !sameConfigStatToken(token, lane.cfgToken);
          }
        }
      }
    }
    if (!opts.disableConfigLane && !configDue) clearDeferral(rel, "config");

    const tryConfigApply = async (): Promise<boolean> => {
      try {
        await runConfigApply(rel, repoDir, remoteSec.config!, inheritedConfigBase, configTarget!);
        clearDeferral(rel, "config");
        return true;
      } catch (error) {
        setDeferral(rel, "config", "config", incomingKey, await checkoutOf(repoDir));
        glog(`git-sync deferred ${rel}: ${errMsg(error)}`);
        return false;
      }
    };

    // A conflict checkpoint owns the Git disposition until the user changes the
    // recorded local identity. Config waits; after that change the same due
    // predicate above feeds either the converged shortcut or a new conflict/apply.
    let resolutionChanged = false;
    let checkpointReproof = false;
    if (needsRes[rel] !== undefined) {
      if (gitIdentityKey(localId) === needsRes[rel]) {
        const alreadyReproved = records[rel]?.deferrals?.apply?.subjectKey === incomingKey && records[rel]?.deferrals?.apply?.reproof === true;
        if (opts.degradedMutex || !gitFollowEnabled() || !opts.oracle || alreadyReproved) {
          clearAttempt(rel);
          setDeferral(rel, "apply", "conflict", incomingKey, await checkoutOf(repoDir));
          return { result: "unchanged", commonDirGroup };
        }
        checkpointReproof = true;
      } else {
        delete needsRes[rel];
        resolutionChanged = true;
      }
    }

    let configFailed = false;
    const applyConfigOnly = async (): Promise<boolean> => {
      if (!configDue || !configTarget || configTarget.fresh) return !configDue;
      if (await tryConfigApply()) return true;
      configFailed = true;
      partial[rel] = partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
      return true;
    };

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    if (!remoteChanged && !pend && !resolutionChanged && !checkpointReproof && !(configDue && configTarget?.fresh)) {
      if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
      applied[rel] = remoteSec; // unchanged → base advances (possibly across scopes)
      clearAttempt(rel);
      clearDeferral(rel, "apply");
      if (!configFailed) partial[rel] = null;
      return { result: "unchanged", commonDirGroup };
    }

    // Already converged? (e.g. a pending retry finding the user manually resolved, or a
    // remote change that equals local work) → advance base, clear pending, no mutation.
    // A removal-memory leftover never takes this shortcut: it must go through the §9
    // clean-materialization path (wipe on dir targets) so stale refs can't survive.
    if (localId && !cleanMaterialize) {
      const n = narrowerScope(localId.refScope, remoteSec.refScope);
      if (projectedKey(localId, n) === projectedKey(remoteSec, n)) {
        const priorRefs = baseSec?.refs ?? {};
        const candidateRefs = remoteSec.refs;
        const refChanged = [...new Set([...Object.keys(priorRefs), ...Object.keys(candidateRefs)])]
          .some((ref) => (priorRefs[ref] ?? null) !== (candidateRefs[ref] ?? null));
        if (refChanged) {
          // Equality after another writer/user mutation is observation, not
          // authority. Continue into the prepared witness path.
        } else {
          if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
          applied[rel] = remoteSec;
          clearAttempt(rel);
          delete pending[rel];
          delete removedMem[rel];
          clearDeferral(rel, "apply");
          if (!configFailed) partial[rel] = null;
          idxProj[rel] = null;
          return { result: "unchanged", commonDirGroup };
        }
      }
    }

    const kek = cfg.kek!; // guaranteed by the fail-closed gate above
    const recordedPartial = records[rel]?.partial;
    let forcedHeldRefs: GitPartialApply["heldRefs"] | undefined;
    const d2RejectedRefs = new Set<string>();
    let divergenceId = localId;
    if (recordedPartial && localId && pend && gitIncomingKey(pend) === recordedPartial.incomingKey) {
      if (await partialRefsStillMatch(repoDir, recordedPartial)) {
        divergenceId = withoutRboxAuthoredRefs(
          localId,
          baseSec,
          !recordedPartial.checkoutPending && !checkoutMatchesIncoming(localId, pend)
            ? { ...recordedPartial, checkoutPending: true }
            : recordedPartial,
        );
      } else {
        for (const ref of Object.keys(recordedPartial.appliedRefs)) d2RejectedRefs.add(ref);
        forcedHeldRefs = Object.fromEntries(Object.keys(recordedPartial.appliedRefs).map((ref) => [ref, "local-commits" as const]));
        partial[rel] = null;
      }
    }
    // Legacy GitIdentity deliberately projects the index through write-tree, which
    // cannot see assume-unchanged, skip-worktree, intent-to-add, sparse, or
    // resolve-undo semantics. Pay for the v2 projection only after every unchanged
    // shortcut, immediately before a clean-path mutation would otherwise begin.
    const legacyDiverged = !cleanMaterialize && localDivergedFromBase(divergenceId, baseSec);
    let semanticIndexDiverged = false;
    if (!legacyDiverged && !cleanMaterialize && dotGit && baseSec) {
      const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
      if (!ctx) {
        semanticIndexDiverged = true;
      } else {
        const liveIndexPath = path.join(ctx.gitDir, "index");
        const liveIndexPresent = await fs.lstat(liveIndexPath).then(
          (stat) => stat.isFile(),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error),
        ).catch(() => undefined);
        const baseHasIndex = baseSec.indexSha !== undefined
          && baseSec.indexEncSha !== undefined
          && baseSec.indexCipherSize !== undefined;
        let baseProjection = records[rel]?.idxProj;
        const deriveProjection = async (ignoreCache = false): Promise<string | undefined> => {
          const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, `.rbox-base-projection-${process.pid}-`));
          try {
            return await deriveBaseIndexProjection({ ctx, base: baseSec, store, kek, record: records[rel] }, tmpDir, ignoreCache);
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        };
        if (baseHasIndex && baseProjection === undefined) {
          baseProjection = await deriveProjection();
          if (baseProjection !== undefined) idxProj[rel] = baseProjection;
        }
        const liveProjection = liveIndexPresent === true
          ? await indexIdentityV2(repoDir, liveIndexPath)
          : undefined;
        // A projection cached by an older client may be stale. Re-derive only
        // on disagreement; a real semantic edit still disagrees, while a stale
        // cache is repaired without manufacturing a local-index episode.
        if (baseHasIndex && liveProjection !== undefined && baseProjection !== liveProjection && records[rel]?.idxProj) {
          baseProjection = await deriveProjection(true);
          if (baseProjection !== undefined) idxProj[rel] = baseProjection;
        }
        let matchesRboxPartial = false;
        if (recordedPartial && pend
          && recordedPartial.incomingKey === gitIncomingKey(pend)
          && recordedPartial.checkoutPending === false
          && liveIndexPresent !== undefined) {
          const partialHasIndex = pend.indexSha !== undefined
            && pend.indexEncSha !== undefined
            && pend.indexCipherSize !== undefined;
          if (!partialHasIndex) {
            matchesRboxPartial = liveIndexPresent === false;
          } else if (liveProjection !== undefined) {
            const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, `.rbox-partial-projection-${process.pid}-`));
            try {
              const partialProjection = await deriveBaseIndexProjection(
                { ctx, base: pend, store, kek, record: undefined },
                tmpDir,
              );
              matchesRboxPartial = partialProjection !== undefined && liveProjection === partialProjection;
            } finally {
              await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
        semanticIndexDiverged = !matchesRboxPartial && (liveIndexPresent === undefined
          || liveIndexPresent !== baseHasIndex
          || (liveIndexPresent && (liveProjection === undefined || baseProjection === undefined || liveProjection !== baseProjection)));
      }
    }
    const localDiverged = legacyDiverged || semanticIndexDiverged;
    // Design 116 review R2-1/R2-2: a usable, already-materialized STEADY
    // receiver always takes the oracle + journal follow pipeline when the
    // remote changed, even when its Git metadata still equals the base.  That
    // is what lets working-byte-only human dirt classify as local-edits, and an
    // invalidated applied-ref marker must likewise reach the forced-hold plane
    // instead of falling back through the base-clean shortcut.
    const steadyFollowCtx = remoteChanged && baseSec && dotGit && !cleanMaterialize
      && !opts.degradedMutex && opts.oracle && gitFollowEnabled()
      ? await repoCtxFromDisk(repoDir).catch(() => undefined)
      : undefined;
    const routeThroughFollow = localDiverged || checkpointReproof
      || Object.keys(forcedHeldRefs ?? {}).length > 0
      || steadyFollowCtx !== undefined;
    const legacyConflict = async (reason: GitDeferralReason = "conflict", progress?: FollowProgress): Promise<{ result: GitApplyRepoResult; commonDirGroup?: number }> => {
      const { recoveryBundle } = await preserveGitConflict(repoDir, remoteSec, store, kek);
      const configApplied = progress?.configApplied ?? true;
      // Conflict preservation performs no branch CAS and therefore cannot
      // advance any incoming branch BASE member. Retain the entire prior
      // authoritative anchor and keep the incoming section pending even when
      // a pre-conflict safe-ref phase made physical progress.
      if (baseSec) applied[rel] = baseSec; else delete applied[rel];
      pending[rel] = remoteSec;
      const retainedLineage = recordOriginLineage(records[rel]?.branchBaseOrigins) ?? "legacy-untrusted";
      repoProofs[rel] = carryRepoBaseProof(retainedLineage);
      partial[rel] = progress
        ? partialFrom({ ...progress, configApplied }, true)
        : null;
      needsRes[rel] = gitIdentityKey(progress ? await gitIdentity(repoDir) : localId);
      clearAttempt(rel);
      setDeferral(rel, "apply", reason, incomingKey, await checkoutOf(repoDir));
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually. Your local Git work is safe; inspect the preserved incoming state before resolving.`);
      return { result: "conflict", commonDirGroup };
    };
    if (routeThroughFollow) {
      // Design-43 containment and ignored-target refusals remain ahead of every
      // artifact import or ref-plane mutation in the new diverged path.
      if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
        await defer("target is inside an ignored subtree — refusing to follow", "ignored-target");
        return { result: "deferred", commonDirGroup };
      }
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (error) {
        await defer(errMsg(error), "containment");
        return { result: "deferred", commonDirGroup };
      }
      if (recoveryConflict || opts.degradedMutex || !opts.oracle) return legacyConflict(opts.oracle ? "conflict" : "unsupported");
      const ctx = steadyFollowCtx ?? await repoCtxFromDisk(repoDir).catch(() => undefined);
      if (!ctx) return legacyConflict("unreadable");
      const preflight = await gitPreflight(repoDir, ctx);
      if (!preflight.ok) {
        await defer(preflight.reason ?? "git preflight refused follow", preflight.structural ? "unsupported" : "unreadable");
        return { result: "deferred", commonDirGroup };
      }

      const runFollowConfig = async (): Promise<boolean> => {
        if (!configDue || !configTarget || configTarget.fresh || remoteSec.config === undefined) return !configDue || configTarget === undefined;
        return tryConfigApply();
      };

      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
      let protocolResult = await prepareFollowerBranchProtocol({
        workspaceRoot: root, relPath: rel, state, ctx, record: records[rel], base: baseSec,
        incoming: remoteSec, liveRefs: await readAllRefs(repoDir),
        ...(d2RejectedRefs.size ? { d2RejectedRefs } : {}),
      });
      if (protocolResult.status === "hold") {
        await defer(protocolResult.reason, "artifact");
        clearAttempt(rel);
        return { result: "deferred", commonDirGroup };
      }
      const standingPInvalidatedAttempt = Object.keys(records[rel]?.partial?.pRepaired ?? {}).length > 0
        || protocolResult.protocol.presentArtifacts.length > 0;
      if (standingPInvalidatedAttempt) clearAttempt(rel);
      for (const [ref, receipt] of Object.entries(records[rel]?.partial?.pRepaired ?? {})) {
        const inspected = await inspectLockedPRepairReceipt(repoDir, receipt);
        if (inspected.action === "compact-and-restart") {
          const payload = receipt.q.value.p.payload;
          const port = createPRepairStatePort({
            root, stream: state.stream, relPath: rel, repoKind: ctx.kind,
            effectiveRefScope: baseSec?.refScope ?? remoteSec.refScope,
            p: { ref: receipt.p.ref, targetOid: receipt.p.targetOid, payload: {
              v: 2, lineageHash: receipt.lineageHash, repositoryIdentityHash: receipt.repositoryIdentityHash,
              ref: receipt.ref, episode: receipt.episode, priorOid: payload.priorOid, nextOid: payload.nextOid,
            }, payloadBytes: Buffer.alloc(0) },
          });
          const snapshot = await port.read();
          if (await persistPRepairTerminal(port, "compact", snapshot, receipt) !== "accepted") {
            await defer(`P-repair terminal receipt CAS rejected for ${ref}`, "artifact");
            return { result: "deferred", commonDirGroup };
          }
          const refreshed = await loadRawState(root);
          if (!refreshed) {
            await defer("P-repair terminal state reload failed", "artifact");
            return { result: "deferred", commonDirGroup };
          }
          state = refreshed;
          const refreshedRecord = repoRecordsForState(state)[rel];
          if (refreshedRecord) installRecoveredRecord(rel, refreshedRecord);
          baseSec = baseRepos[rel];
        } else if (inspected.action === "corruption-hold" || inspected.action === "artifact-contradiction-hold") {
          await defer(`P-repair terminal inspection refused ${ref}: ${inspected.action}`, "artifact");
          return { result: "deferred", commonDirGroup };
        }
      }
      // A standing P makes serialized positive BASE unavailable until exact
      // settlement or bounded repair completes. Every successful row mandates a
      // full re-plan with fresh state, artifacts, attestations, and snapshots.
      for (let pass = 0; protocolResult.protocol.presentArtifacts.length > 0 && pass < 8; pass++) {
        const p = protocolResult.protocol.presentArtifacts[0]!;
        const exact = await settleExactPresentArtifact({
          root, stream: state.stream, state, relPath: rel, ctx,
          binding: protocolResult.protocol.binding, p, mutationBoundary: opts.mutationBoundary,
        });
        if (exact.status === "hold") {
          await defer(exact.reason, "artifact");
          return { result: "deferred", commonDirGroup };
        }
        if (exact.status === "moved") {
          const port = createPRepairStatePort({
            root, stream: state.stream, relPath: rel, repoKind: ctx.kind,
            effectiveRefScope: baseSec?.refScope ?? remoteSec.refScope, p,
          });
          const disposition = protocolResult.protocol.artifacts[p.payload.ref];
          const validateArtifacts = async (): Promise<boolean> => {
            const fresh = await readBasePresentArtifact(repoDir, protocolResult.status === "ready"
              ? protocolResult.protocol.binding : p.payload, p.payload.ref);
            return fresh.status === "valid" && fresh.artifact.targetOid === p.targetOid
              && disposition?.present === "valid-owning" && disposition.keeps === "exact"
              && disposition.absence === "absent" && disposition.settledAbsence === "absent";
          };
          const accepted = records[rel]?.partial?.pRepaired?.[p.payload.ref];
          let repaired;
          if (accepted) {
            const resumed = await resumeLockedAcceptedPRepair({ repoDir, receipt: accepted, validateArtifacts });
            repaired = resumed.status === "refresh-receipt"
              ? await refreshLockedAcceptedPRepair({
                  repoDir, p, state: port, repairAt: new Date().toISOString(), acceptedReceipt: accepted,
                  mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
                  validateArtifacts,
                })
              : resumed.status === "restart"
                ? { status: "restart" as const }
                : { status: "hold" as const, reason: resumed.reason };
          } else {
            repaired = await runLockedPRepairAttempt({
              repoDir, p, state: port, repairAt: new Date().toISOString(),
              mismatches: { live: exact.reason === "live", reflog: exact.reason === "reflog", baseShape: exact.reason === "base-shape" },
              validateArtifacts,
            });
          }
          if (repaired.status === "hold") {
            await defer(repaired.reason, "artifact");
            return { result: "deferred", commonDirGroup };
          }
          if (repaired.status === "retry") continue;
          const refreshed = await loadRawState(root);
          if (!refreshed) {
            await defer("P-repair state reload failed", "artifact");
            return { result: "deferred", commonDirGroup };
          }
          state = refreshed;
        } else if (exact.status === "settled") {
          state = exact.state;
        } else break;
        const refreshedRecord = repoRecordsForState(state)[rel];
        if (refreshedRecord) installRecoveredRecord(rel, refreshedRecord);
        baseSec = baseRepos[rel];
        protocolResult = await prepareFollowerBranchProtocol({
          workspaceRoot: root, relPath: rel, state, ctx, record: records[rel], base: baseSec,
          incoming: remoteSec, liveRefs: await readAllRefs(repoDir),
          ...(d2RejectedRefs.size ? { d2RejectedRefs } : {}),
        });
        if (protocolResult.status === "hold") {
          await defer(protocolResult.reason, "artifact");
          return { result: "deferred", commonDirGroup };
        }
      }
      if (protocolResult.protocol.presentArtifacts.length > 0) {
        await defer("P settlement did not stabilize", "artifact");
        return { result: "deferred", commonDirGroup };
      }
      await opts.afterHeldSkipPrepass?.(rel);
      const heldNowMs = opts.heldNow?.();
      const effectivePartial = currentPartial(rel);
      const priorAttempt = pend && !standingPInvalidatedAttempt ? records[rel]?.attempt : undefined;
      const priorObservation = priorAttempt
        ? await observeHeldInputs({
            root, relPath: rel, incomingKey: incomingKey!, incoming: remoteSec,
            record: records[rel], partial: effectivePartial,
            stateNonce: expectedStateNonce(state),
            effectiveBaseIndexProjection: records[rel]?.idxProj
              ?? (baseSec?.indexSha === undefined ? null : undefined),
            effectiveIncomingIndexProjection:
              incomingIndexArtifactDescriptor(remoteSec) === priorAttempt.incomingIndexArtifactDescriptor
                ? priorAttempt.effectiveIncomingIndexProjection
                : undefined,
            reflogPaths: priorAttempt.reflogs.map((entry) => entry.path),
          })
        : undefined;
      const priorInputsMatch = priorAttempt !== undefined && priorObservation !== undefined
        && (heldNowMs === undefined
          ? heldAttemptMatches(priorAttempt, priorObservation)
          : heldAttemptMatches(priorAttempt, priorObservation, heldNowMs));
      const priorFloorElapsed = priorAttempt !== undefined && (heldNowMs === undefined
        ? heldAttemptFloorElapsed(priorAttempt)
        : heldAttemptFloorElapsed(priorAttempt, heldNowMs));
      const standingApply = currentDeferral(rel, "apply");
      if (gitHeldSkipEnabled() && pend && priorAttempt && priorInputsMatch && !priorFloorElapsed
        && heldBlockersAllowSkip(priorAttempt.blockers) && standingApply) {
        // Sidecar-only ordered refresh: pending, partial, BASE, and attempt remain exact.
        setDeferral(rel, "apply", standingApply.reason, standingApply.subjectKey, standingApply.checkout);
        return { result: "skipped", commonDirGroup };
      }
      // Once a full follow is required, omission must not preserve the rejected
      // attempt across an early artifact/capability/boundary exit. Only a
      // completed stable classification callback may install its replacement.
      clearAttempt(rel);
      const recordAttempt = async (input: {
        blockers: readonly TypedBlocker[];
        reflogPaths: readonly string[];
        trustedFingerprint: import("./fingerprint.js").GitFingerprint | undefined;
        effectiveBaseIndexProjection: string | null | undefined;
        effectiveIncomingIndexProjection: string | null | undefined;
        boundBase?: GitSection;
        boundOrigins?: RepoRecord["branchBaseOrigins"];
        observationPartial?: GitPartialApply;
      }): Promise<void> => {
        const priorRecord = records[rel];
        const observationPartial = input.observationPartial ?? currentPartial(rel);
        if (!input.trustedFingerprint) {
          clearAttempt(rel);
          return;
        }
        const observed = await observeHeldInputs({
          root, relPath: rel, incomingKey: incomingKey!, incoming: remoteSec,
          record: priorRecord,
          ...((input.boundBase ?? applied[rel]) === undefined ? {} : { boundBase: input.boundBase ?? applied[rel] }),
          ...((input.boundOrigins ?? branchBaseOrigins[rel]) === undefined ? {} : { boundOrigins: input.boundOrigins ?? branchBaseOrigins[rel] }),
          partial: observationPartial,
          stateNonce: expectedStateNonce(state), reflogPaths: input.reflogPaths,
          trustedFingerprint: input.trustedFingerprint,
          effectiveBaseIndexProjection: input.effectiveBaseIndexProjection,
          effectiveIncomingIndexProjection: input.effectiveIncomingIndexProjection,
        });
        if (!observed) {
          clearAttempt(rel);
          return;
        }
        const merged = sortedTypedBlockers(input.blockers);
        if (priorFloorElapsed && priorInputsMatch && priorAttempt && !sameHeldOutcome(priorAttempt.blockers, merged)) {
          glog(`git-sync WARNING ${rel}: held-skip fingerprint miss`);
        }
        attempt[rel] = heldNowMs === undefined
          ? createHeldAttempt(observed, merged)
          : createHeldAttempt(observed, merged, new Date(heldNowMs).toISOString());
      };
      const proofFor = (progress: FollowProgress, checkoutComplete: boolean): RepoBaseProof => {
        const branches: RepoBaseLockedProof["branches"] = { ...(progress.branchLockedProofs ?? {}) };
        const safeRefs: RepoBaseLockedProof["safeRefs"] = Object.fromEntries(Object.entries(progress.safeRefWitnesses ?? {}).map(([ref, witness]) => [ref, {
          liveOid: witness.afterOid,
          witness,
          ...(ref === "refs/stash" && witness.afterOid !== null ? { stashReflogReady: true } : {}),
        }]));
        return {
          authority: {
            kind: "pull-ref-transaction",
            lineageHash: protocolResult.protocol.lineageHash,
            repositoryIdentityHash: protocolResult.protocol.repositoryIdentityHash,
            incomingKey: incomingKey!,
            branchWitnesses: progress.branchWitnesses ?? {},
            safeRefWitnesses: progress.safeRefWitnesses ?? {},
          },
          lockedProof: {
            repoKind: ctx.kind,
            effectiveRefScope: remoteSec.refScope,
            checkoutComplete,
            incomingKey: incomingKey!,
            branches,
            safeRefs,
          },
        };
      };

      const intendedFor = async (progress: FollowProgress): Promise<FollowIntended> => {
        const proof = proofFor(progress, true);
        const composed = composeRepoBase(
          { base: baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
          { base: remoteSec },
          proof.authority,
          proof.lockedProof,
        );
        const held = Object.keys(progress.heldRefs).length > 0 || composed.disposition === "pending";
        const effectiveDeferrals = { ...(records[rel]?.deferrals ?? {}) };
        const transition = deferrals[rel];
        if (transition === null) {
          for (const lane of DEFERRAL_LANES) delete effectiveDeferrals[lane];
        } else if (transition) {
          for (const lane of DEFERRAL_LANES) {
            if (transition[lane] === null) delete effectiveDeferrals[lane];
            else if (transition[lane]) effectiveDeferrals[lane] = transition[lane]!;
          }
        }
        if (held) {
          const heldReason = heldReasonOf(progress.heldRefs);
          const next = nextDeferral("apply", effectiveDeferrals.apply, heldReason, new Date().toISOString(), incomingKey, await checkoutOf(repoDir));
          effectiveDeferrals.apply = next;
        } else delete effectiveDeferrals.apply;
        const lane = laneRecord(rel);
        const part = held || !progress.configApplied ? partialFrom(progress, false) : undefined;
        const previous = records[rel];
        const previousRecord = previous === undefined ? undefined : inputRecord(previous);
        const record: RepoRecordInput = {
          sourceSeq: opts.sourceGlobalSeq ?? state.lastSyncedSequence,
          ...(composed.base ? { base: composed.base } : {}),
          ...(composed.branchBaseOrigins ? { branchBaseOrigins: composed.branchBaseOrigins } : {}),
          ...(held ? { pending: remoteSec } : {}),
          ...configLaneState(lane),
          ...(Object.keys(effectiveDeferrals).length ? { deferrals: effectiveDeferrals } : {}),
          ...(part ? { partial: part } : {}),
          ...(progress.incomingIndexProjection ? { idxProj: progress.incomingIndexProjection } : {}),
        };
        return { record, expectedRepoGen: records[rel]?.repoGen ?? 0, relPath: rel, baseProof: proof, ...(previousRecord ? { previousRecord } : {}) };
      };
      const follow = await runMutation(repoDir, () => followDivergedRepo({
        workspaceRoot: root,
        relPath: rel,
        ctx,
        base: baseSec,
        incoming: remoteSec,
        store,
        kek,
        // applyGitSections establishes the oracle before any follow path runs.
        oracle: opts.oracle!,
        record: idxProj[rel] && records[rel]
          ? { ...records[rel], idxProj: idxProj[rel]! }
          : records[rel],
        binding,
        branchProtocol: protocolResult.protocol,
        followEnabled: gitFollowEnabled(),
        runConfig: runFollowConfig,
        makeIntended: intendedFor,
        chainTimings,
        capabilityProbe: opts.capabilityProbe,
        crashAt: opts.crashAt,
        log: glog,
        forcedHeldRefs,
        afterBranchPinsPrepared: opts.afterBranchPinsPrepared,
        mutationBoundary: opts.mutationBoundary,
        afterHeldClassification: async (classification) => {
          await opts.afterHeldClassification?.(rel);
          if (classification.phase === "followed") {
            const finalProof = proofFor(classification.progress, true);
            const finalComposed = composeRepoBase(
              { base: baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
              { base: remoteSec },
              finalProof.authority,
              finalProof.lockedProof,
            );
            await recordAttempt({
              ...classification,
              ...(finalComposed.base ? { boundBase: finalComposed.base } : {}),
              ...(finalComposed.branchBaseOrigins ? { boundOrigins: finalComposed.branchBaseOrigins } : {}),
              observationPartial: partialFrom(classification.progress, false),
              blockers: blockersAfterComposer({
                classification: classification.blockers,
                disposition: finalComposed.disposition,
                holds: finalComposed.holds,
                checkoutComplete: finalProof.lockedProof.checkoutComplete,
              }),
            });
          } else {
            await recordAttempt({
              ...classification,
              observationPartial: partialFrom(classification.progress, true),
            });
          }
        },
      }));
      if (follow.derivedBaseIndexProjection) idxProj[rel] = follow.derivedBaseIndexProjection;
      if (follow.status === "legacy") {
        clearAttempt(rel);
        return legacyConflict(follow.reason, follow);
      }
      if (follow.status === "defer") {
        if (checkpointReproof && follow.reason !== "unsupported") {
          pending[rel] = remoteSec;
          partial[rel] = partialFrom(follow, true);
          needsRes[rel] = gitIdentityKey(await gitIdentity(repoDir));
          setDeferral(rel, "apply", "conflict", incomingKey, await checkoutOf(repoDir));
          clearAttempt(rel);
          markCheckpointReproof(rel);
          return { result: "unchanged", commonDirGroup };
        }
        // Deferred checkout has historically kept serialized BASE unchanged even
        // when earlier ref phases made physical progress. The sole exception is
        // a crash-reconstructed owning A: it must consume its stale BASE member
        // once so the §126 veto does not recur forever. Narrow the proof to those
        // absences; do not accidentally publish unrelated pre-checkout progress.
        const reconstructed = [...protocolResult.protocol.unmaterializedAbsenceRefs]
          .filter((ref) => follow.appliedRefs[ref]?.kind === "absent"
            && follow.branchWitnesses?.[ref]?.kind === "absent"
            && follow.branchLockedProofs?.[ref] !== undefined);
        if (reconstructed.length > 0) {
          const only = new Set(reconstructed);
          const absenceProgress: FollowProgress = {
            appliedRefs: Object.fromEntries(Object.entries(follow.appliedRefs).filter(([ref]) => only.has(ref))),
            heldRefs: follow.heldRefs,
            blockers: follow.blockers,
            configApplied: false,
            branchWitnesses: Object.fromEntries(Object.entries(follow.branchWitnesses ?? {}).filter(([ref]) => only.has(ref))),
            branchLockedProofs: Object.fromEntries(Object.entries(follow.branchLockedProofs ?? {}).filter(([ref]) => only.has(ref))),
            safeRefWitnesses: {},
          };
          const deferredProof = proofFor(absenceProgress, false);
          const deferredComposed = composeRepoBase(
            { base: baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
            { base: remoteSec },
            deferredProof.authority,
            deferredProof.lockedProof,
          );
          repoProofs[rel] = deferredProof;
          if (deferredComposed.base) applied[rel] = deferredComposed.base; else delete applied[rel];
          if (deferredComposed.branchBaseOrigins) branchBaseOrigins[rel] = deferredComposed.branchBaseOrigins;
        }
        pending[rel] = remoteSec;
        partial[rel] = partialFrom(follow, true);
        setDeferral(rel, "apply", follow.reason, incomingKey, await checkoutOf(repoDir));
        glog(`git-sync deferred ${rel}: ${follow.detail}`);
        return { result: "deferred", commonDirGroup };
      }

      delete needsRes[rel];
      delete removedMem[rel];
      const held = Object.entries(follow.heldRefs);
      const settledProof = proofFor(follow, true);
      const composedFollow = composeRepoBase(
        { base: baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
        { base: remoteSec },
        settledProof.authority,
        settledProof.lockedProof,
      );
      repoProofs[rel] = settledProof;
      if (composedFollow.base) applied[rel] = composedFollow.base; else delete applied[rel];
      if (composedFollow.branchBaseOrigins) branchBaseOrigins[rel] = composedFollow.branchBaseOrigins;
      idxProj[rel] = follow.incomingIndexProjection ?? null;
      if (held.length > 0 || composedFollow.disposition === "pending") {
        pending[rel] = remoteSec;
        partial[rel] = partialFrom(follow, false);
        setDeferral(rel, "apply", held.length ? heldReasonOf(follow.heldRefs) : "artifact", incomingKey, await checkoutOf(repoDir));
      } else {
        delete pending[rel];
        clearAttempt(rel);
        partial[rel] = follow.configApplied
          ? null
          : partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
        clearDeferral(rel, "apply");
      }
      publishedJournals.push(rel);
      glog(`git-sync followed ${rel}`);
      return { result: "applied", commonDirGroup };
    }

    // Clean apply. Refusals and containment run BEFORE any mutation [v2, B5].
    if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
      await defer("target is inside an ignored subtree — refusing to materialize", "ignored-target");
      return { result: "deferred", commonDirGroup };
    }
    try {
      await assertGitTargetWithinRoot(root, rel);
    } catch (e) {
      await defer(errMsg(e), "containment");
      return { result: "deferred", commonDirGroup };
    }

    // Dir leftover clean materialization [v5]: applyGitState performs capture-grade
    // quarantine after artifact verification, then routes every branch create/update/
    // delete through §130's typed A/P/K transition adapter. cleanWipeRefs widens only
    // the physical wipe set (including scoped omissions); it never widens authority.
    // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
    // update-only apply is the whole treatment; the memory clears on success.
    const wipeLeftover = cleanMaterialize && dotGit !== undefined && dotGit.isDirectory();
    const capableLineage = /^[0-9a-f]{32}$/.test(state.stateNonce ?? "");
    if (!capableLineage) {
      const remoteBranches = Object.keys(remoteSec.refs).some((ref) => ref.startsWith("refs/heads/"));
      const localBranches = dotGit
        ? Object.keys(await readAllRefs(repoDir).catch(() => ({}))).some((ref) => ref.startsWith("refs/heads/"))
        : false;
      if (remoteBranches || (wipeLeftover && localBranches)) {
        await defer("branch materialization requires a durable capable state lineage", "artifact");
        return { result: "deferred", commonDirGroup };
      }
    }
    // Suppression deliberately removes the repo from the manifest projection, but
    // §130 retains the protected BASE anchor in RepoRecord for the later clean
    // materialization transaction. Never plan A/P from the suppressed projection.
    const cleanBaseSec = records[rel]?.base ?? baseSec;
    let cleanProtocol: Awaited<ReturnType<typeof prepareFollowerBranchProtocol>> | undefined;
    const protocolFor = async (ctx: NonNullable<Awaited<ReturnType<typeof repoCtxFromDisk>>>) => {
      if (!cleanProtocol) cleanProtocol = await prepareFollowerBranchProtocol({
        workspaceRoot: root,
        relPath: rel,
        state,
        ctx,
        record: records[rel],
        base: cleanBaseSec,
        incoming: remoteSec,
        liveRefs: await readAllRefs(repoDir),
      });
      if (cleanProtocol.status === "hold") throw new Error(cleanProtocol.reason);
      return cleanProtocol.protocol;
    };
    const cleanBranchTransitions: ApplyBranchTransitionAdapter = {
      commit: async (input: ApplyBranchTransitionInput) => {
        const protocol = await protocolFor(input.ctx);
        const logicalBaseOid = protocol.logicalBaseRefs[input.ref] ?? null;
        if (input.afterOid === null && logicalBaseOid === null && input.beforeOid !== null) {
          // A clean wipe may encounter a quarantined local-only branch. Its
          // logical BASE is already absent, so no A is authored; the typed
          // physical-only plan still has an exact expected-old inverse.
          await runUpdateRefTransaction(repoDir, [
            ...input.extraTransactionLines,
            `delete ${input.ref} ${input.beforeOid}`,
          ]);
          return {
            ref: input.ref,
            beforeOid: input.beforeOid,
            afterOid: null,
            inverseLines: [`create ${input.ref} ${input.beforeOid}`],
          };
        }
        const plan = await planBranchTransition({
          repoDir,
          binding: protocol.binding,
          ref: input.ref,
          beforeOid: input.beforeOid,
          afterOid: input.afterOid,
          logicalBaseOid,
          extraTransactionLines: input.extraTransactionLines,
          ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
        });
        const committed = await commitPlannedBranchTransition(plan);
        return {
          ref: plan.ref,
          beforeOid: plan.beforeOid,
          afterOid: plan.afterOid,
          inverseLines: plan.inverseLines,
          witness: committed.witness,
          lockedProof: committed.lockedProof,
        };
      },
      rollback: async (_ctx, transition) => {
        await runUpdateRefTransaction(repoDir, transition.inverseLines);
      },
    };
    const res = await runMutation(repoDir, () => applyGitState(
      repoDir,
      remoteSec,
      store,
      kek,
      {
        ...(opts.degradedMutex ? { legacyWholeSectionOwnership: true } : {}),
        ...(capableLineage ? { branchTransitions: cleanBranchTransitions } : {}),
        ...(wipeLeftover ? { beforeMutateWipesRefs: true, cleanWipeRefs: true } : {}),
        ...(chainTimings ? { chainTimings } : {}),
        ...(opts.warningSink ? { warningSink: opts.warningSink } : {}),
      }
    ));
    if (res.applied) {
      // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (e) {
        glog(`git-sync WARNING ${rel}: post-apply containment check failed: ${errMsg(e)}`);
      }
      const held = Object.entries(res.heldRefs ?? {}).sort(([a], [b]) => a.localeCompare(b));
      let configApplied = !configDue || configTarget === undefined;
      if (configDue && configTarget && remoteSec.config !== undefined) {
        configApplied = await tryConfigApply();
      }
      if (held.length > 0) {
        pending[rel] = remoteSec;
        const filtered = new Set(res.filteredRefs ?? []);
        const heldSet = new Set(held.map(([ref]) => ref));
        const transitionPartials: GitPartialApply["appliedRefs"] = {};
        for (const [ref, transition] of Object.entries(res.branchTransitions ?? {})) {
          if (!transition.witness) continue;
          transitionPartials[ref] = transition.witness.kind === "present"
            ? { kind: "present", oid: transition.witness.nextOid, artifactOid: transition.witness.artifactOid, episode: transition.witness.episode }
            : { kind: "absent", artifactOid: transition.witness.artifactOid };
        }
        Object.assign(transitionPartials, res.safeRefTransitions ?? {});
        for (const [ref, oid] of Object.entries(remoteSec.refs)) {
          if (!heldSet.has(ref) && !filtered.has(ref) && transitionPartials[ref] === undefined) {
            transitionPartials[ref] = { kind: "direct", oid };
          }
        }
        partial[rel] = partialFrom({
          appliedRefs: transitionPartials,
          heldRefs: Object.fromEntries(held.map(([ref]) => [ref, "ownership" as const])),
          configApplied,
        }, false);
        setDeferral(rel, "apply", "worktree-ownership", incomingKey, await checkoutOf(repoDir));
      } else if (res.branchTransitions || res.safeRefTransitions) {
        const protocol = await protocolFor((await repoCtxFromDisk(repoDir))!);
        const branchWitnesses = Object.fromEntries(Object.entries(res.branchTransitions ?? {})
          .flatMap(([ref, transition]) => transition.witness ? [[ref, transition.witness] as const] : []));
        const safeRefWitnesses = res.safeRefTransitions ?? {};
        const proof: RepoBaseProof = {
          authority: {
            kind: "pull-ref-transaction",
            lineageHash: protocol.lineageHash,
            repositoryIdentityHash: protocol.repositoryIdentityHash,
            incomingKey: incomingKey!,
            branchWitnesses,
            safeRefWitnesses,
          },
          lockedProof: {
            repoKind: (await repoCtxFromDisk(repoDir))!.kind,
            effectiveRefScope: wipeLeftover ? "all" : remoteSec.refScope,
            checkoutComplete: true,
            incomingKey: incomingKey!,
            branches: Object.fromEntries(Object.entries(res.branchTransitions ?? {})
              .flatMap(([ref, transition]) => transition.witness && transition.lockedProof
                ? [[ref, transition.lockedProof] as const]
                : [])),
            safeRefs: Object.fromEntries(Object.entries(safeRefWitnesses).map(([ref, witness]) => [ref, {
              liveOid: witness.afterOid,
              witness,
              ...(ref === "refs/stash" && witness.afterOid !== null ? { stashReflogReady: true } : {}),
            }])),
          },
        };
        const composed = composeRepoBase(
          { base: cleanBaseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
          { base: remoteSec },
          proof.authority,
          proof.lockedProof,
        );
        repoProofs[rel] = proof;
        if (composed.base) applied[rel] = composed.base; else delete applied[rel];
        if (composed.branchBaseOrigins) branchBaseOrigins[rel] = composed.branchBaseOrigins;
        if (composed.disposition === "pending") pending[rel] = remoteSec; else delete pending[rel];
        partial[rel] = configApplied
          ? null
          : partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
        if (composed.disposition === "pending") setDeferral(rel, "apply", "artifact", incomingKey, await checkoutOf(repoDir));
        else { clearDeferral(rel, "apply"); clearAttempt(rel); }
      } else {
        applied[rel] = remoteSec;
        delete pending[rel];
        partial[rel] = configApplied
          ? null
          : partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
        clearDeferral(rel, "apply");
        clearAttempt(rel);
      }
      delete removedMem[rel];
      // A legacy clean apply may normalize the index. Never retain a semantic
      // projection cached for the prior base; the next follow derives it once
      // from the decrypt-verified new base artifact.
      idxProj[rel] = null;
      glog(
        `git-sync applied ${rel}${held.length
          ? ` (held refs: ${held.map(([ref, worktree]) => `${ref}=${worktree}`).join(" ")})`
          : res.filteredRefs?.length
            ? ` (filtered refs: ${res.filteredRefs.join(" ")})`
            : ""}`
      );
      return { result: "applied", commonDirGroup };
    } else {
      const reason = res.reason ?? "apply deferred";
      if (/\bconfig\b/i.test(reason)) {
        setDeferral(rel, "config", "config", incomingKey, await checkoutOf(repoDir));
      }
      const typed: GitDeferralReason = /worktree-ownership|ownership-deferred/.test(reason) ? "worktree-ownership"
        : reason.includes("busy") ? "git-busy"
        : /\bconfig\b/i.test(reason) ? "config"
        : /quarantine/i.test(reason) ? "other"
        : /artifact|bundle|decrypt|import/i.test(reason) ? "artifact"
        : /unsupported|invalid git section/i.test(reason) ? "unsupported"
        : "other";
      await defer(reason, typed);
      return { result: "deferred", commonDirGroup };
    }
  };

  const queuedAt = Date.now();
  const commonDirLocks = new Map<string, Promise<void>>();
  const indexes = new Map(keys.map((rel, i) => [rel, i]));
  let progressDone = 0;
  const runRepo = async (rel: string): Promise<void> => {
    const wireRemoteSec = remote.gitRepos?.[rel];
    const remoteSec = wireRemoteSec === undefined ? undefined : sanitizeGitSectionForPersistence(wireRemoteSec);
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    const i = indexes.get(rel)!;
    let startedAt = Date.now();
    let result: GitApplyRepoResult = "deferred";
    let commonDirGroup: number | undefined;
    const chainTimings = metrics ? zeroGitChainTimings() : undefined;
    try {
      if (collidingRepoKeys.has(rel)) {
        if (remoteSec) pending[rel] = remoteSec;
        clearAttempt(rel);
        setDeferral(rel, "apply", "unreadable", incomingKey);
        result = "deferred";
        return;
      }
      const lockKey = await gitApplyMutationKey(root, rel);
      await chainLock(commonDirLocks, lockKey, async () => {
        startedAt = Date.now();
        const processed = await processRepo(rel, chainTimings);
        result = processed.result;
        commonDirGroup = processed.commonDirGroup;
      });
    } catch (e) {
      if (e instanceof FollowCrashInjectedError) throw e;
      // Per-repo failures defer only THAT repo — one bad repo (a blob missing mid
      // conflict-preserve, an ENOTDIR/hostile target, an fs error) must never abort
      // the whole pull or block the other repos' base advance.
      if (remoteSec) {
        pending[rel] = remoteSec;
        clearAttempt(rel);
        setDeferral(rel, "apply", "other", incomingKey, await checkoutOf(repoDirOf(root, rel)));
      }
      glog(`git-sync deferred ${rel}: ${errMsg(e)}`);
      result = "deferred";
    } finally {
      if (metrics) {
        const wallMs = Date.now() - startedAt;
        if (chainTimings) finalizeGitChainTimings(chainTimings, wallMs);
        metrics.results[result] += 1;
        metrics.repoTimings.push({
          index: i,
          queueMs: startedAt - queuedAt,
          wallMs,
          result,
          commonDirGroup,
          chain: chainTimings,
        });
      }
      opts.onProgress?.(++progressDone, keys.length);
    }
  };
  await poolMap(nestedRepoChains(keys), gitApplyConcurrency(), async (chain) => {
    for (const rel of chain) await runRepo(rel);
  });
  return pack();
}

/** Re-prove partial crash hints immediately before the state CAS. */
export async function revalidateGitPartialApplies(
  root: string,
  state: SyncState,
  outcome: GitPullOutcome,
): Promise<void> {
  const records = repoRecordsForState(state);
  const rels = new Set([
    ...Object.entries(records).filter(([, record]) => record.partial !== undefined).map(([rel]) => rel),
    ...Object.entries(outcome.partial ?? {}).filter(([, value]) => value !== null).map(([rel]) => rel),
  ]);
  const locks = new Map<string, Promise<void>>();
  await Promise.all([...rels].map(async (rel) => {
    const transition = outcome.partial?.[rel];
    const effective = transition === null ? undefined : transition ?? records[rel]?.partial;
    if (!effective) return;
    const key = await gitApplyMutationKey(root, rel);
    await chainLock(locks, key, async () => {
      if (await partialRefsStillMatch(repoDirOf(root, rel), effective)) return;
      outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
    });
  }));
}

/** Hold the per-common-dir serialization boundary from the final exact-ref proof
 * through the state CAS that persists the marker. */
export async function withRevalidatedGitPartialApplies<T>(
  root: string,
  state: SyncState,
  outcome: GitPullOutcome,
  save: () => Promise<T>,
  options: {
    mutationBoundary?: MutationBoundary;
    /** Deterministic shutdown seam after journaled first-lock ownership. */
    afterFirstStateCasLockAcquired?: () => void | Promise<void>;
    /** Real-process crash seams; tests only. */
    afterStateCasJournalPrepared?: () => void | Promise<void>;
    afterStateCasLockPersisted?: (count: number, lockPath: string) => void | Promise<void>;
    afterStateCasLocksAcquired?: () => void | Promise<void>;
    afterStateCasCommitted?: () => void | Promise<void>;
    stateCasLockHooks?: LockfileHooks;
  } = {},
): Promise<T> {
  const records = repoRecordsForState(state);
  const partials = [...new Set([
    ...Object.keys(records),
    ...Object.keys(outcome.partial ?? {}),
  ])].flatMap((rel) => {
    const transition = outcome.partial?.[rel];
    const partial = transition === null ? undefined : transition ?? records[rel]?.partial;
    return partial ? [{ rel, partial }] : [];
  });
  const requested = new Map<string, { commonDir: string; rels: Set<string>; proofs: StateCasLockRequest["proofs"] }>();
  for (const { rel, partial } of partials) {
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!ctx) {
      outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
      continue;
    }
    const commonDir = path.resolve(ctx.commonDir);
    for (const [ref, expected] of Object.entries(partial.appliedRefs)) {
      const lockPath = path.resolve(ctx.commonDir, `${ref}.lock`);
      if (!lockPath.startsWith(`${commonDir}${path.sep}`)) {
        outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
        continue;
      }
      const current = requested.get(lockPath) ?? { commonDir, rels: new Set<string>(), proofs: [] };
      current.rels.add(rel);
      current.proofs.push({
        repo: rel,
        ref,
        expectedOid: "oid" in expected ? expected.oid : expected.kind === "safe-ref" ? expected.afterOid : null,
      });
      requested.set(lockPath, current);
    }
  }
  for (const [rel, proof] of Object.entries(outcome.repoProofs ?? {})) {
    if (proof.authority.kind !== "pull-ref-transaction" && proof.authority.kind !== "journal-recovery") continue;
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!ctx) continue;
    const commonDir = path.resolve(ctx.commonDir);
    for (const witness of Object.values(proof.authority.branchWitnesses)) {
      const lockPath = path.resolve(commonDir, `${witness.artifactRef}.lock`);
      if (!lockPath.startsWith(`${commonDir}${path.sep}`)) throw new Error(`artifact lock escaped common dir for ${rel}:${witness.ref}`);
      const current = requested.get(lockPath) ?? { commonDir, rels: new Set<string>(), proofs: [] };
      current.rels.add(rel);
      current.proofs.push({ repo: rel, ref: witness.ref, expectedOid: witness.kind === "present" ? witness.nextOid : null });
      requested.set(lockPath, current);
    }
  }
  const mutationRepos = [...new Set([
    ...partials.map(({ rel }) => rel),
    ...Object.keys(outcome.repoProofs ?? {}),
  ])].sort();
  const lease = options.mutationBoundary?.enter({
    phase: "state-cas",
    ...(mutationRepos.length > 0 ? { repository: mutationRepos.join(",") } : {}),
  });
  let prepared: Awaited<ReturnType<typeof prepareStateCasLocks>>;
  let held: HeldStateCasLock[] = [];
  try {
    prepared = await prepareStateCasLocks(
      root,
      { stream: state.stream, stateNonce: expectedStateNonce(state) },
      [...requested.entries()].map(([lockPath, request]) => ({ lockPath, commonDir: request.commonDir, proofs: request.proofs })),
    );
    await options.afterStateCasJournalPrepared?.();
    if (lease?.abortRequested) throw new MutationGateClosedError();
    if (prepared) {
      const acquired = await acquirePreparedStateCasLocks(prepared, {
        beforeLockPublish: () => {
          if (lease?.abortRequested) throw new MutationGateClosedError();
        },
        onFirstAcquired: async () => {
          if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
          await options.afterFirstStateCasLockAcquired?.();
        },
        afterAcquisitionPersisted: options.afterStateCasLockPersisted,
        hooks: options.stateCasLockHooks,
      });
      held = acquired.held;
      await options.afterStateCasLocksAcquired?.();
      for (const lockPath of acquired.blocked) {
        for (const rel of requested.get(lockPath)?.rels ?? []) {
          outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
        }
      }
    }
    await revalidateGitPartialApplies(root, state, outcome);
    for (const [rel, proof] of Object.entries(outcome.repoProofs ?? {})) {
      if (proof.authority.kind !== "pull-ref-transaction" && proof.authority.kind !== "journal-recovery") continue;
      const ctx = await repoCtxFromDisk(repoDirOf(root, rel));
      if (!ctx) throw new Error(`branch proof repository disappeared for ${rel}`);
      const live = await readAllRefs(ctx.repoDir);
      for (const [ref, witness] of Object.entries(proof.authority.branchWitnesses)) {
        const locked = proof.lockedProof.branches[ref];
        const terminal = witness.kind === "present" ? witness.nextOid : null;
        if (!locked || locked.liveOid !== terminal || (live[ref] ?? null) !== terminal) {
          throw new Error(`branch proof terminal moved for ${rel}:${ref}`);
        }
        if (witness.kind === "absent" && witness.source === "a") {
          const artifact = await readBaseAbsentArtifact(ctx.repoDir, {
            lineageHash: witness.lineageHash,
            repositoryIdentityHash: witness.repositoryIdentityHash,
          }, ref);
          if (artifact.status !== "valid" || artifact.artifact.targetOid !== witness.artifactOid) {
            throw new Error(`branch absence artifact moved for ${rel}:${ref}`);
          }
        }
      }
    }
    if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
    const saved = await save();
    await markStateCasCommitted(prepared);
    await options.afterStateCasCommitted?.();
    for (const rel of outcome.publishedJournals ?? []) await clearFollowJournal(root, rel, outcome.journalCrashAt);
    return saved;
  } finally {
    await releaseStateCasLocks(prepared, held).catch(() => false);
    lease?.finish();
  }
}

/** Retire exact P/K and compact A→Z only after their composed BASE is durable.
 * A moved P episode remains standing for the next preflight's mandatory
 * P-repair; malformed exact-settlement state is surfaced as a hard failure. */
export async function settleCommittedBranchArtifacts(
  root: string,
  initialState: SyncState,
  outcome: GitPullOutcome,
  mutationBoundary?: MutationBoundary,
): Promise<SyncState> {
  let state = initialState;
  const attemptsToRebind: Array<{ relPath: string; attempt: GitHeldAttempt }> = [];
  const settlementRepos = Object.entries(outcome.repoProofs ?? {})
    .filter(([, proof]) => proof.authority.kind === "pull-ref-transaction" || proof.authority.kind === "journal-recovery")
    .map(([rel]) => rel)
    .sort();
  const lease = settlementRepos.length > 0 ? mutationBoundary?.enter({
    phase: "git-prepare",
    repository: settlementRepos.join(","),
  }) : undefined;
  const beginSettlement = (): void => {
    if (lease && !lease.beginCommit("git-commit")) throw new MutationGateClosedError();
  };
  try {
    for (const [rel, proof] of Object.entries(outcome.repoProofs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (proof.authority.kind !== "pull-ref-transaction" && proof.authority.kind !== "journal-recovery") continue;
      const ctx = await repoCtxFromDisk(repoDirOf(root, rel));
      if (!ctx) throw new Error(`P settlement repository disappeared for ${rel}`);
      for (const [ref, witness] of Object.entries(proof.authority.branchWitnesses).sort(([a], [b]) => a.localeCompare(b))) {
        const binding = { lineageHash: witness.lineageHash, repositoryIdentityHash: witness.repositoryIdentityHash };
        if (witness.kind === "absent") {
          if (witness.source === "z") continue;
          const read = await readBaseAbsentArtifact(ctx.repoDir, binding, ref);
          if (read.status !== "valid" || read.artifact.targetOid !== witness.artifactOid) {
            throw new Error(`A settlement artifact mismatch for ${rel}:${ref}`);
          }
          beginSettlement();
          await settleBaseAbsentArtifact(ctx.repoDir, binding, ref);
          continue;
        }
        const read = await readBasePresentArtifact(ctx.repoDir, binding, ref);
        if (read.status === "absent") continue;
        if (read.status !== "valid" || read.artifact.targetOid !== witness.artifactOid) {
          throw new Error(`P settlement artifact mismatch for ${rel}:${ref}`);
        }
        beginSettlement();
        const settled = await settleExactPresentArtifact({
          root, stream: state.stream, state, relPath: rel, ctx, binding, p: read.artifact,
          mutationBoundary,
        });
        if (settled.status === "settled") state = settled.state;
        else if (settled.status === "absent" || settled.status === "moved") continue;
        else throw new Error(`P settlement refused for ${rel}:${ref}: ${settled.reason}`);
      }

      const completedAttempt = outcome.attempt?.[rel];
      if (completedAttempt) attemptsToRebind.push({ relPath: rel, attempt: completedAttempt });
    }
    if (attemptsToRebind.length > 0) beginSettlement();
    return await rebindHeldAttemptsAfterSettlement({ root, state, attempts: attemptsToRebind });
  } finally {
    lease?.finish();
  }
}
