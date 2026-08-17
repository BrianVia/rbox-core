import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { receiverEquivalentCollisionNames, poolMap, type AppliedManifestOracle, type GitSection, type IgnoreMatcher, type Manifest, type BlobStore } from "../../engine/index.js";
import { applyGitState } from "./git-state-apply.js";
import { assertGitTargetWithinRoot } from "./containment.js";
import { checkoutJournalPresent, clearCheckoutJournal } from "./journal.js";
import { finalizeGitChainTimings, type GitChainTimings, zeroGitChainTimings } from "./chain-timings.js";
import { gitIdentity, gitIdentityKey, type GitIdentity } from "./identity.js";
import { gitPreflight, isGitBusy } from "./preflight.js";
import { indexIdentityV2 } from "./index-identity.js";
import { inspectLockedPRepairReceipt, persistPRepairTerminal, runLockedPRepairAttempt, resumeLockedAcceptedPRepair, refreshLockedAcceptedPRepair } from "./p-repair-transaction.js";
import { preserveGitConflict } from "./quarantine.js";
import { repoCtxFromDisk, type RepoCtx } from "./git-state.js";
import { readBasePresentArtifact } from "./base-artifacts.js";
import { type CheckoutCapabilityProbe } from "./checkout-txn.js";
import { canonicalizeGitConfig, sanitizeGitSectionForPersistence } from "./config-sync.js";
import { applyConfigTransaction, materializeFreshGitConfig, readParsedConfigSnapshot } from "./config-txn.js";
import { addTimedMs } from "./chain-timings.js";
import { readAllRefs, readAllRefsStrict } from "./refs.js";
import { readHead, warnOnce } from "./git-state.js";
import { git } from "../../engine/git-spawn.js";
import { expectedStateNonce, loadRawState, repoRecordsForState, type GitDeferral, type GitDeferralReason, type GitHeldAttempt, type GitPartialApply, type RepoRecord, type RepoRecordInput, type SyncState, type TypedBlocker, type WorkspaceConfig } from "../config.js";
import { configLaneState, inputRecord, type ConfigLaneState, type GitDeferralUpdates } from "../sync-state.js";
import { checkoutJournalBinding, deriveBaseIndexProjection, followDivergedRepo, FollowCrashInjectedError, quarantineUnboundFollowJournal, recoverAndLandFollowJournal, type FollowCrashPoint, type FollowIntended, type FollowProgress } from "./follow.js";
import { checkoutLabel, repoDirOf, localDivergedFromBase, narrowerScope, projectedKey, emptyToUndef, errMsg, chainLock, gitApplyMutationKey, nestedRepoChains, gitApplyConcurrency, gitFollowEnabled, gitIncomingKey, nextDeferral, repoEquivalenceWarningLogged, sectionOpState, type HeldChainLock } from "./shared.js";
import { executeRemoteRepositoryDeletion, planRemoteRepositoryDeletion, sweepRemovedRepoSkeleton, type RemoteRepositoryDeletionEffects, type RemoteRepositoryDeletionIdentity, type RepoSkeletonSweepOptions } from "./remote-repository-deletion.js";
import type { ScopeProjection } from "../scope/projection.js";
import { configReceiver } from "./config-lane.js";
import { createReceivedGitConfig } from "./received-git-config.js";
import { prepareFollowerBranchProtocol } from "./follower-protocol.js";
import { settleStandingBranchProof, type StandingProofPort, type StandingRepairAttempt } from "./standing-branch-proof.js";
import { composeFollowAuthority, composeFollowRepoTransition, followHeldDeferralReason, mergeFollowDeferralLanes, type FollowCommitInput, type FollowRepoTransition, type FollowTransitionIdentity, type StandingBranchProofReceipt } from "./follow-repo-transition.js";
import { materializeCleanGit } from "./clean-materialization.js";
import { createPRepairStatePort } from "./p-repair-state.js";
import { settleExactPresentArtifact } from "./p-settlement.js";
import { MutationGateClosedError, type MutationBoundary } from "../../engine/mutation-gate.js";
import { blockersAfterComposer, gitOwnershipNoEscalateEnabled } from "./held-blockers.js";
import { readWorktreeRegistryDigest } from "./held-skip.js";
import { createHeldDecisionPlane, heldTraceEnabled, type HeldRepoDecision } from "./held-decision.js";
import { startGitApplyRun, type GitApplyMetrics, type GitApplyRepoResult, type GitApplyRunKind } from "./apply-metrics.js";
import {
  carryRepoBaseProof,
  recordOriginLineage,
  type RepoBaseProof,
} from "./base-composer.js";
import { asyncMemo } from "./async-memo.js";
import { partialRefsStillMatch } from "./received-git-transition-commit.js";
import { fingerprintHitProbe, loadGitDivergenceCache } from "./divergence-cache.js";
import { gitFingerprintRun } from "./fingerprint.js";
import { gitConfigHash } from "./config-lane.js";

interface KeySnapshot<T> {
  present: boolean;
  value: T | undefined;
}

function snapshotKey<T>(record: Record<string, T>, key: string): KeySnapshot<T> {
  return {
    present: Object.prototype.hasOwnProperty.call(record, key),
    value: record[key],
  };
}

function restoreKey<T>(record: Record<string, T>, key: string, snapshot: KeySnapshot<T>): void {
  if (snapshot.present) record[key] = snapshot.value!;
  else delete record[key];
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
  /** Transactional proofs retained only for post-save A/P settlement when the
   * terminal ref read forced the state composer onto carry authority. */
  artifactSettlementProofs?: Record<string, RepoBaseProof>;
  branchBaseOrigins?: Record<string, NonNullable<RepoRecord["branchBaseOrigins"]>>;
  /** Published checkout journals clear only after the surrounding state CAS. */
  publishedJournals?: string[];
  journalCrashAt?: (point: FollowCrashPoint) => void;
  gitApplyMetrics?: GitApplyMetrics;
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
    /** Tests only: fault injection at deliberately lossy follow read sites. */
    beforeCheckoutSecondProof?: (relPath: string) => void | Promise<void>;
    beforeFinalLive?: (relPath: string) => void | Promise<void>;
    beforeManualAbsentTransition?: (relPath: string, ref: string) => void | Promise<void>;
    beforeWorktreeOwnershipRead?: (relPath: string) => void | Promise<void>;
    /** Tests only: after removal state transitions, before journal/skeleton cleanup. */
    beforeRemovalCleanup?: (relPath: string) => void | Promise<void>;
    /** Shared logical time for held-attempt tests; omitted production call sites
     * retain the helpers' individual wall-clock reads. */
    heldNow?: () => number;
    warningSink?: (message: string) => void;
    mutationBoundary?: MutationBoundary;
    /** Tests only: observes/injects the anchored empty-directory removal call. */
    sweepRmdir?: RepoSkeletonSweepOptions["rmdir"];
    /** Tests only: observes repos admitted to the serialized apply work. */
    onApplyQueued?: (relPath: string) => void;
    /** Design 212: the shared pre-probe scope projection. Present ⇒ only `IN` repos
     * are visited at all. Out-of-scope and boundary-crossing keys never reach key
     * construction, collision analysis, disk probing, journal recovery, or config —
     * their BASE and every durable sidecar lane stay exactly as they were. */
    scope?: ScopeProjection;
  } = {}
): Promise<GitPullOutcome> {
  const sanitizeSections = (sections: Record<string, GitSection> | undefined): Record<string, GitSection> =>
    Object.fromEntries(Object.entries(sections ?? {}).map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));
  const baseRepos = sanitizeSections(state.lastSyncedManifest.gitRepos);
  const applied = { ...baseRepos };
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
  let run: ReturnType<typeof startGitApplyRun> | undefined;
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
    gitApplyMetrics: run?.snapshot(),
  });
  if (!cfg.syncGit) return pack();
  const allKeys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  const keys = opts.scope ? opts.scope.probeKeys(allKeys) : allKeys;
  if (opts.scope) {
    for (const carried of opts.scope.carriedKeys(allKeys)) {
      if (opts.scope.classifyRepo(carried) !== "straddle") continue;
      glog(`git-sync WARNING: ${carried} crosses the folders this machine syncs — leaving it untouched until the scope covers the whole repository`);
    }
  }
  const lazyProbes = process.env.RBOX_GIT_APPLY_LAZY !== "0";
  // Logical repo keys must remain one-to-one with receiver targets even if this
  // state later lands on an NFC/case-aliasing filesystem.
  const collidingRepoKeys = receiverEquivalentCollisionNames(keys);
  if (collidingRepoKeys.size > 0) warnOnce(
    repoEquivalenceWarningLogged,
    root,
    `git-sync WARNING: receiver-equivalent Git repo keys all deferred: ${[...collidingRepoKeys].sort().join(", ")}`,
    glog,
  );
  const runKind: GitApplyRunKind = Object.keys(baseRepos).length === 0 && Object.keys(pending).length === 0 ? "fresh" : "steady";
  if (opts.collectMetrics) run = startGitApplyRun(runKind, keys.length);
  if (keys.length === 0) return pack();
  // Fail closed ONCE, before any per-repo work: git sections (incl. pending ones) are
  // E2EE artifacts — without the key nothing below can decrypt-verify.
  if (!cfg.kek && keys.some((k) => remote.gitRepos?.[k] !== undefined || pending[k] !== undefined)) {
    throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox key recover`.");
  }

  const commonDirGroupFor = (ctx: RepoCtx | undefined): number | undefined =>
    run && ctx ? run.groupFor(path.resolve(ctx.commonDir)) : undefined;

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
  // The held-skip owner. It decides every skip and writes every held attempt;
  // this frame only lends it the two lanes a skip is allowed to touch.
  const heldDecisions = createHeldDecisionPlane({
    root,
    log: glog,
    attempts: attempt,
    now: opts.heldNow,
    deferrals: {
      standingApply: (rel) => currentDeferral(rel, "apply"),
      restandApply: (rel, standing) => setDeferral(rel, "apply", standing.reason, standing.subjectKey, standing.checkout),
    },
  });
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

  const installRecoveredRecord = (rel: string, record: RepoRecord): void => {
    records[rel] = record;
    if (record.base) { baseRepos[rel] = record.base; applied[rel] = record.base; }
    else { delete baseRepos[rel]; delete applied[rel]; }
    if (record.pending) pending[rel] = record.pending; else delete pending[rel];
    if (record.removedKey) removedMem[rel] = record.removedKey; else delete removedMem[rel];
    if (record.resolutionKey) needsRes[rel] = record.resolutionKey; else delete needsRes[rel];
  };

  const processRepo = async (
    rel: string,
    chainTimings: GitChainTimings | undefined,
    commonDirLock: HeldChainLock,
    held: HeldRepoDecision,
  ): Promise<{ result: GitApplyRepoResult; commonDirGroup?: number }> => {
    const wireRemoteSec = remote.gitRepos?.[rel];
    const remoteSec = wireRemoteSec === undefined ? undefined : sanitizeGitSectionForPersistence(wireRemoteSec);
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    let baseSec = baseRepos[rel];
    let pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    let dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    const getDiskCtx = asyncMemo(async () => dotGit ? await repoCtxFromDisk(repoDir).catch(() => undefined) : undefined);
    const commonDirGroup = commonDirGroupFor(await getDiskCtx());
    const receivedConfig = createReceivedGitConfig({
      root,
      relPath: rel,
      repoDir,
      wireSection: wireRemoteSec,
      incoming: remoteSec?.config,
      laneDisabled: opts.disableConfigLane === true,
      priorRecord: () => ({
        sourceSeq: records[rel]?.sourceSeq ?? state.lastSyncedSequence,
        ...configLaneState(records[rel] ?? {}),
      }),
      leftoverPresent: () => dotGit !== undefined,
      repoContext: getDiskCtx,
      commonDirLock,
      materializeFresh: async (incoming) => {
        await runMutation(repoDir, () => (opts.materializeFreshConfig ?? materializeFreshGitConfig)(
          repoDir, incoming, path.join(repoDir, ".git")));
      },
      inspectFreshInstall: async () => {
        const ctx = await repoCtxFromDisk(repoDir);
        if (!ctx) throw new Error("fresh config apply lost repository context");
        // The receiver identity is carried forward untouched: this frame binds
        // the config lane's evidence, it does not interpret it.
        const { owned, configPath, ...receiverIdentity } = await configReceiver(root, ctx);
        if (!owned) throw new Error("fresh config target is not receiver-owned");
        const installed = await readParsedConfigSnapshot(repoDir, configPath, "locked");
        if (!installed.ok) throw new Error(`fresh config post-read: ${installed.fault.reason}`);
        const post = canonicalizeGitConfig(installed.snapshot.entries);
        if (!post.ok) throw new Error(`fresh config post-parse: ${post.reason}`);
        return { ...receiverIdentity, config: post.config, token: installed.snapshot.token };
      },
      applyExisting: (configPath, incoming, baseConfig) => runMutation(repoDir, () =>
        (opts.applyConfig ?? applyConfigTransaction)(repoDir, configPath, incoming, { baseConfig })),
      log: glog,
    });
    const publishConfigTransition = (next: ConfigLaneState | undefined): void => {
      if (next !== undefined) configLane[rel] = next;
    };
    publishConfigTransition(await receivedConfig.recordBaseline());

    // Design 116 recovery is the first per-repo operation in every arm. The
    // surrounding runRepo chain lock is already keyed by this common dir.
    let recoveryConflict = false;
    const recoverJournal = !lazyProbes || await checkoutJournalPresent(root, rel);
    const recoveryCtx = recoverJournal ? await getDiskCtx() : undefined;
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
        getDiskCtx.reset();
      }
    } else if (recoverJournal) {
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
    // Legacy mode passes no ctx so isGitBusy spawns exactly as today (the kill
    // switch's spawn-count fidelity is pinned by test); lazy mode reuses the
    // memoized fs-derived ctx.
    const getBusy = asyncMemo(async () =>
      dotGit !== undefined && await isGitBusy(repoDir, lazyProbes ? await getDiskCtx() : undefined));
    if (!lazyProbes) await getBusy(); // legacy order: busy probed for every repo, as today
    if (remoteSec && await getBusy()) {
      pending[rel] = remoteSec; // apply needs quiescence — retry next pull; outbound carries newest truth
      setDeferral(rel, "apply", "git-busy", incomingKey, await checkoutOf(repoDir));
      glog(`git-sync deferred ${rel}: receiver git busy`);
      return { result: "deferred", commonDirGroup };
    }
    // NOTE: remote ABSENCE is processed even when busy — it never mutates local .git,
    // and skipping it would leave gitPendingRemote/base carrying a section the remote
    // deleted, which the next file-only push would resurrect.
    const getLocalId = asyncMemo(async (): Promise<GitIdentity | undefined> => {
      await getBusy(); // busy-known-first: identity under a held lock reads as false divergence
      return dotGit ? await gitIdentity(repoDir) : undefined;
    });
    if (!lazyProbes) await getLocalId();

    if (!remoteSec) {
      // Genuine wire absence. `ReconcileRemoteRepositoryDeletion` owns the whole
      // transition; this block only binds the already-read evidence to the plan
      // and lends the executor the sidecar lanes it may change.
      const identity = await getLocalId();
      const deletionIdentity: RemoteRepositoryDeletionIdentity = { root, relPath: rel, repoDir, incoming: "absent" };
      const plan = planRemoteRepositoryDeletion({
        identity: deletionIdentity,
        pendingSection: pend,
        baseSection: baseSec,
        localIdentity: identity,
        gitBusy: await getBusy(),
        leftover: dotGit ? (dotGit.isFile() ? "scoped" : "all") : undefined,
        baseApplied: rel in applied,
        originLineage: recordOriginLineage(records[rel]?.branchBaseOrigins),
      });
      const effects: RemoteRepositoryDeletionEffects = {
        identity: deletionIdentity,
        commit: (transition) => {
          const before = {
            applied: snapshotKey(applied, rel),
            removedMem: snapshotKey(removedMem, rel),
            needsRes: snapshotKey(needsRes, rel),
            pending: snapshotKey(pending, rel),
            deferrals: snapshotKey(deferrals, rel),
            partial: snapshotKey(partial, rel),
            attempt: snapshotKey(attempt, rel),
            idxProj: snapshotKey(idxProj, rel),
            repoProofs: snapshotKey(repoProofs, rel),
          };
          delete applied[rel];
          delete pending[rel];
          delete needsRes[rel];
          deferrals[rel] = transition.deferrals;
          partial[rel] = transition.partial;
          attempt[rel] = transition.heldAttempt;
          idxProj[rel] = transition.indexProjection;
          repoProofs[rel] = transition.proof;
          if (transition.removedKey !== null) removedMem[rel] = transition.removedKey;
          return () => {
            restoreKey(applied, rel, before.applied);
            restoreKey(removedMem, rel, before.removedMem);
            restoreKey(needsRes, rel, before.needsRes);
            restoreKey(pending, rel, before.pending);
            restoreKey(deferrals, rel, before.deferrals);
            restoreKey(partial, rel, before.partial);
            restoreKey(attempt, rel, before.attempt);
            restoreKey(idxProj, rel, before.idxProj);
            restoreKey(repoProofs, rel, before.repoProofs);
          };
        },
        beforeCleanup: opts.beforeRemovalCleanup ? async () => { await opts.beforeRemovalCleanup!(rel); } : undefined,
        clearJournal: () => clearCheckoutJournal(root, rel),
        sweepSkeleton: () => sweepRemovedRepoSkeleton(root, rel, opts.sweepRmdir ? { rmdir: opts.sweepRmdir } : {}),
        preservePending: (sec) => preserveGitConflict(repoDir, sec, store, cfg.kek!),
        log: glog,
      };
      await executeRemoteRepositoryDeletion(plan, effects);
      return { result: "removed", commonDirGroup };
    }
    const inheritedConfigBase = records[rel]?.partial?.configBase ?? baseSec?.config;
    const partialFrom = (
      progress: Pick<GitPartialApply, "appliedRefs" | "heldRefs" | "configApplied">,
      checkoutPending: boolean,
    ): GitPartialApply => {
      const record: GitPartialApply = {
        incomingKey: incomingKey!,
        checkoutPending,
        appliedRefs: progress.appliedRefs,
        heldRefs: progress.heldRefs,
        configApplied: progress.configApplied,
      };
      if (!progress.configApplied && inheritedConfigBase !== undefined) record.configBase = inheritedConfigBase;
      return record;
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
      } else {
        const removalLocalId = await getLocalId();
        if (gitIdentityKey(removalLocalId) === removedMem[rel]) {
          cleanMaterialize = true;
        } else if (!removalLocalId && dotGit.isFile()) {
          pending[rel] = remoteSec;
          setDeferral(rel, "apply", "unreadable", incomingKey, await checkoutOf(repoDir));
          glog(`git-sync deferred ${rel}: leftover pointer repo unreadable — keeping removal memory`);
          return { result: "deferred", commonDirGroup };
        } else {
          delete removedMem[rel]; // identity genuinely changed (incl. a re-init'd empty dir repo)
        }
      }
    }

    const defer = async (reason: string, typedReason: GitDeferralReason = "other") => {
      pending[rel] = remoteSec; // [v5]: outbound pushes carry newest unapplied truth
      clearAttempt(rel);
      setDeferral(rel, "apply", typedReason, incomingKey, await checkoutOf(repoDir));
      glog(`git-sync deferred ${rel}: ${reason}`);
    };

    const configDisposition = await receivedConfig.prepare(inheritedConfigBase);
    publishConfigTransition(configDisposition.transition);
    const configDue = configDisposition.due;
    const configRequiresMaterialization = configDisposition.requiresMaterialization;
    if (!opts.disableConfigLane && !configDue) clearDeferral(rel, "config");

    const tryConfigApply = async (
      operation: () => Promise<ConfigLaneState | undefined>,
    ): Promise<boolean> => {
      try {
        const next = await operation();
        if (next === undefined) return false;
        publishConfigTransition(next);
        clearDeferral(rel, "config");
        return true;
      } catch (error) {
        // Same rule as the per-repo frame: a closed shutdown gate is not a config
        // fault and must not be recorded as one — let it abort the pull.
        if (error instanceof MutationGateClosedError) throw error;
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
      if (gitIdentityKey(await getLocalId()) === needsRes[rel]) {
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
      if (!configDue) return true;
      if (configRequiresMaterialization) return false;
      if (await tryConfigApply(receivedConfig.applyExisting)) return true;
      configFailed = true;
      partial[rel] = partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
      return true;
    };

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    // On a scoped binding an absent repo may have an already-equal BASE — carried
    // from before the folder left the scope. Taking the unchanged shortcut there
    // would advance nothing and materialize nothing, so `include add` would report
    // CLEAN forever without ever putting the repository on disk (design 212 §3.2).
    const materializationOwed = opts.scope !== undefined && dotGit === undefined;
    if (!materializationOwed && !remoteChanged && !pend && !resolutionChanged && !checkpointReproof && !(configDue && configRequiresMaterialization)) {
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
    const shortcutLocalId = await getLocalId();
    if (shortcutLocalId && !cleanMaterialize) {
      const n = narrowerScope(shortcutLocalId.refScope, remoteSec.refScope);
      if (projectedKey(shortcutLocalId, n) === projectedKey(remoteSec, n)) {
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
    const divergenceLocalId = await getLocalId();
    let divergenceId = divergenceLocalId;
    if (recordedPartial && divergenceLocalId && pend && gitIncomingKey(pend) === recordedPartial.incomingKey) {
      if (await partialRefsStillMatch(repoDir, recordedPartial)) {
        divergenceId = withoutRboxAuthoredRefs(
          divergenceLocalId,
          baseSec,
          !recordedPartial.checkoutPending && !checkoutMatchesIncoming(divergenceLocalId, pend)
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
      const projectionBase = baseSec;
      await addTimedMs(chainTimings, "indexOpStateMs", async () => {
        const ctx = await repoCtxFromDisk(repoDir).catch(() => undefined);
        if (!ctx) {
          semanticIndexDiverged = true;
        } else {
          const liveIndexPath = path.join(ctx.gitDir, "index");
          const liveIndexPresent = await fs.lstat(liveIndexPath).then(
            (stat) => stat.isFile(),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error),
          ).catch(() => undefined);
          const baseHasIndex = projectionBase.indexSha !== undefined
            && projectionBase.indexEncSha !== undefined
            && projectionBase.indexCipherSize !== undefined;
          let baseProjection = records[rel]?.idxProj;
          const deriveProjection = async (ignoreCache = false): Promise<string | undefined> => {
            const tmpDir = await fs.mkdtemp(path.join(ctx.gitDir, `.rbox-base-projection-${process.pid}-`));
            try {
              return await deriveBaseIndexProjection({ ctx, base: projectionBase, store, kek, record: records[rel] }, tmpDir, ignoreCache);
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
      });
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
      needsRes[rel] = gitIdentityKey(progress ? await gitIdentity(repoDir) : await getLocalId());
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
        if (!configDue) return true;
        if (configRequiresMaterialization) return false;
        return tryConfigApply(receivedConfig.applyWhileCommonDirLocked);
      };

      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
      const preparedProtocol = await prepareFollowerBranchProtocol({
        workspaceRoot: root, relPath: rel, state, ctx, record: records[rel], base: baseSec,
        incoming: remoteSec, liveRefs: await readAllRefs(repoDir), d2RejectedRefs,
      });
      if (preparedProtocol.status === "hold") {
        await defer(preparedProtocol.reason, "artifact");
        clearAttempt(rel);
        return { result: "deferred", commonDirGroup };
      }
      const standingPInvalidatedAttempt = Object.keys(records[rel]?.partial?.pRepaired ?? {}).length > 0
        || preparedProtocol.protocol.presentArtifacts.length > 0;
      if (standingPInvalidatedAttempt) clearAttempt(rel);
      const repairStatePort = (attempt: StandingRepairAttempt) => createPRepairStatePort({
        root, stream: attempt.stream, relPath: rel, repoKind: ctx.kind,
        effectiveRefScope: attempt.effectiveRefScope, p: attempt.p,
      });
      const standingProofEffects: StandingProofPort = {
        now: () => new Date().toISOString(),
        inspectTerminalReceipt: (receipt) => inspectLockedPRepairReceipt(repoDir, receipt),
        compactTerminalReceipt: async ({ receipt, stream, effectiveRefScope }) => {
          const payload = receipt.q.value.p.payload;
          const port = createPRepairStatePort({
            root, stream, relPath: rel, repoKind: ctx.kind, effectiveRefScope,
            p: { ref: receipt.p.ref, targetOid: receipt.p.targetOid, payload: {
              v: 2, lineageHash: receipt.lineageHash, repositoryIdentityHash: receipt.repositoryIdentityHash,
              ref: receipt.ref, episode: receipt.episode, priorOid: payload.priorOid, nextOid: payload.nextOid,
            }, payloadBytes: Buffer.alloc(0) },
          });
          const snapshot = await port.read();
          return persistPRepairTerminal(port, "compact", snapshot, receipt);
        },
        settleExactArtifact: (settle) => settleExactPresentArtifact({
          root, stream: settle.state.stream, state: settle.state, relPath: rel, ctx,
          binding: settle.binding, p: settle.p, mutationBoundary: opts.mutationBoundary,
        }),
        resumeAcceptedRepair: ({ receipt, validateArtifacts }) =>
          resumeLockedAcceptedPRepair({ repoDir, receipt, validateArtifacts }),
        refreshAcceptedRepair: (attempt) => refreshLockedAcceptedPRepair({
          repoDir, p: attempt.p, state: repairStatePort(attempt), repairAt: attempt.repairAt,
          acceptedReceipt: attempt.acceptedReceipt, mismatches: attempt.mismatches,
          validateArtifacts: attempt.validateArtifacts,
        }),
        runRepairAttempt: (attempt) => runLockedPRepairAttempt({
          repoDir, p: attempt.p, state: repairStatePort(attempt), repairAt: attempt.repairAt,
          mismatches: attempt.mismatches, validateArtifacts: attempt.validateArtifacts,
        }),
        readStandingArtifact: (artifact, ref) => readBasePresentArtifact(repoDir, artifact, ref),
        reloadState: () => loadRawState(root),
        refreshProtocol: async (source) => prepareFollowerBranchProtocol({
          workspaceRoot: root, relPath: rel, state: source.state, ctx, record: source.record, base: source.base,
          incoming: remoteSec, liveRefs: await readAllRefs(repoDir), d2RejectedRefs,
        }),
      };
      const settlement = await addTimedMs(chainTimings, "standingProofMs", () => settleStandingBranchProof({
        identity: { relPath: rel, incomingKey: incomingKey! },
        state, record: records[rel], serializedBase: baseSec, incomingRefScope: remoteSec.refScope,
        protocol: preparedProtocol.protocol, retryBudget: 8,
      }, standingProofEffects));
      state = settlement.carry.state;
      if (settlement.carry.recoveredRecord) installRecoveredRecord(rel, settlement.carry.recoveredRecord);
      baseSec = baseRepos[rel];
      if (settlement.kind === "held" || settlement.kind === "retry-exhausted") {
        const refusal = settlement.kind === "held" ? settlement.hold : settlement.lastProof;
        await defer(refusal.reason, refusal.deferralReason);
        return { result: "deferred", commonDirGroup };
      }
      // A `landing` leaves the standing P standing: nothing settled it, and the
      // follow may serialize a FIRST BASE from what it is observed to land.
      let landingObservation: Readonly<Record<string, string>> | undefined;
      const settledProtocol = settlement.protocol;
      // Everything downstream composes against this exact pair: the repository
      // and wire section the follow is bound to, and the lineage the settled
      // standing-branch proof licensed it to stamp.
      const followIdentity: FollowTransitionIdentity = {
        relPath: rel,
        incomingKey: incomingKey!,
        repoKind: ctx.kind,
        effectiveRefScope: remoteSec.refScope,
      };
      const followProof: StandingBranchProofReceipt = {
        relPath: rel,
        incomingKey: incomingKey!,
        lineageHash: settledProtocol.lineageHash,
        repositoryIdentityHash: settledProtocol.repositoryIdentityHash,
        unmaterializedAbsenceRefs: settledProtocol.unmaterializedAbsenceRefs,
      };
      await opts.afterHeldSkipPrepass?.(rel);
      if (await held.steadySkip({
        attempt: pend && !standingPInvalidatedAttempt ? records[rel]?.attempt : undefined,
        record: records[rel],
        partial: currentPartial(rel),
        stateNonce: expectedStateNonce(state),
        effectiveBaseIndexProjection: records[rel]?.idxProj
          ?? (baseSec?.indexSha === undefined ? null : undefined),
      })) return { result: "skipped", commonDirGroup };
      // Once a full follow is required, omission must not preserve the rejected
      // attempt across an early artifact/capability/boundary exit. Only a
      // completed stable classification callback may install its replacement.
      clearAttempt(rel);
      /** The pair every downstream composition binds: the prior authoritative
       * anchor and the incoming section this follow is bound to. */
      const followComposition = (): FollowCommitInput => {
        const bound: FollowCommitInput = {
          identity: followIdentity,
          incoming: remoteSec,
          baseComposition: {
            prior: { base: baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
            candidate: { base: remoteSec },
          },
        };
        return landingObservation ? { ...bound, landingObservation } : bound;
      };
      const intendedFor = async (progress: FollowProgress): Promise<FollowIntended> => {
        const authority = composeFollowAuthority(followComposition(), followProof, progress, true);
        const effectiveDeferrals = mergeFollowDeferralLanes(records[rel]?.deferrals, deferrals[rel]);
        // Design 273 P2 mirror of the follow-transition site: every held repo
        // keeps a record. An ownership-only hold records `worktree-ownership`,
        // which the projection classes `ownership-hold` — visible everywhere,
        // escalated nowhere.
        if (authority.held) {
          const heldReason = gitOwnershipNoEscalateEnabled() && authority.ownershipOnly
            ? "worktree-ownership" as const
            : followHeldDeferralReason(progress);
          const next = nextDeferral("apply", effectiveDeferrals.apply, heldReason, new Date().toISOString(), incomingKey, await checkoutOf(repoDir));
          effectiveDeferrals.apply = next;
        } else delete effectiveDeferrals.apply;
        const lane = receivedConfig.transition() ?? configLaneState(records[rel] ?? {});
        const part = authority.held || !progress.configApplied ? partialFrom(progress, false) : undefined;
        const previous = records[rel];
        const previousRecord = previous === undefined ? undefined : inputRecord(previous);
        // Assembled in the durable record's field order; a key is written only
        // when the composed authority actually carries it.
        const record: RepoRecordInput = { sourceSeq: opts.sourceGlobalSeq ?? state.lastSyncedSequence };
        if (authority.composed.base) record.base = authority.composed.base;
        if (authority.composed.branchBaseOrigins) record.branchBaseOrigins = authority.composed.branchBaseOrigins;
        if (authority.held) record.pending = remoteSec;
        Object.assign(record, configLaneState(lane));
        if (Object.keys(effectiveDeferrals).length) record.deferrals = effectiveDeferrals;
        if (part) record.partial = part;
        if (progress.incomingIndexProjection) record.idxProj = progress.incomingIndexProjection;
        const intended: FollowIntended = { record, expectedRepoGen: records[rel]?.repoGen ?? 0, relPath: rel, baseProof: authority.proof };
        if (previousRecord) intended.previousRecord = previousRecord;
        return intended;
      };

      /** Applies one composed transition to this pull's sidecar lanes in the
       * order the durable packet composer reads them. */
      const commitFollowTransition = async (
        transition: FollowRepoTransition,
        progress: FollowProgress,
      ): Promise<void> => {
        if (transition.resolutionMemory === "clear") delete needsRes[rel];
        if (transition.removalMemory === "clear") delete removedMem[rel];
        if (transition.baseAdvance) {
          repoProofs[rel] = transition.baseAdvance.proof;
          if (transition.baseAdvance.appliedSection) applied[rel] = transition.baseAdvance.appliedSection;
          else delete applied[rel];
          if (transition.baseAdvance.branchOrigins) branchBaseOrigins[rel] = transition.baseAdvance.branchOrigins;
        }
        if (transition.indexProjection !== "retain") idxProj[rel] = transition.indexProjection;
        if (transition.pending === null) delete pending[rel];
        else pending[rel] = transition.pending;
        if (transition.heldAttempt === "clear") clearAttempt(rel);
        partial[rel] = transition.partial.kind === "from-progress"
          ? partialFrom(progress, transition.partial.checkoutPending)
          : transition.partial.kind === "config-carry"
            ? partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false)
            : null;
        if (transition.deferral.kind === "clear") clearDeferral(rel, "apply");
        else setDeferral(rel, "apply", transition.deferral.reason, incomingKey, await checkoutOf(repoDir));
        if (transition.publishJournal) publishedJournals.push(rel);
      };
      const classificationWorktreeRegistryDigest = await readWorktreeRegistryDigest(repoDir);
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
        branchProtocol: settledProtocol,
        followEnabled: gitFollowEnabled(),
        runConfig: runFollowConfig,
        makeIntended: intendedFor,
        chainTimings,
        capabilityProbe: opts.capabilityProbe,
        crashAt: opts.crashAt,
        log: glog,
        forcedHeldRefs,
        afterBranchPinsPrepared: opts.afterBranchPinsPrepared,
        beforeCheckoutSecondProof: () => opts.beforeCheckoutSecondProof?.(rel),
        beforeFinalLive: () => opts.beforeFinalLive?.(rel),
        beforeManualAbsentTransition: (ref) => opts.beforeManualAbsentTransition?.(rel, ref),
        beforeWorktreeOwnershipRead: () => opts.beforeWorktreeOwnershipRead?.(rel),
        mutationBoundary: opts.mutationBoundary,
        afterHeldClassification: async (classification) => {
          await opts.afterHeldClassification?.(rel);
          const followed = classification.phase === "followed"
            ? composeFollowAuthority(followComposition(), followProof, classification.progress, true)
            : undefined;
          await held.recordClassification({
            ...classification,
            record: records[rel],
            stateNonce: expectedStateNonce(state),
            expectedWorktreeRegistryDigest: classificationWorktreeRegistryDigest,
            boundBase: followed?.composed.base ?? applied[rel],
            boundOrigins: followed?.composed.branchBaseOrigins ?? branchBaseOrigins[rel],
            partial: partialFrom(classification.progress, followed === undefined),
            blockers: followed
              ? blockersAfterComposer({
                  classification: classification.blockers,
                  disposition: followed.composed.disposition,
                  holds: followed.composed.holds,
                  checkoutComplete: followed.proof.lockedProof.checkoutComplete,
                })
              : classification.blockers,
          });
        },
      }));
      if (follow.derivedBaseIndexProjection) idxProj[rel] = follow.derivedBaseIndexProjection;
      if (follow.status === "legacy") {
        clearAttempt(rel);
        return legacyConflict(follow.reason, follow);
      }
      if (follow.status === "defer") {
        held.noteBlockers(follow.blockers, follow.reason);
        if (checkpointReproof && follow.reason !== "unsupported") {
          pending[rel] = remoteSec;
          partial[rel] = partialFrom(follow, true);
          needsRes[rel] = gitIdentityKey(await gitIdentity(repoDir));
          setDeferral(rel, "apply", "conflict", incomingKey, await checkoutOf(repoDir));
          clearAttempt(rel);
          markCheckpointReproof(rel);
          return { result: "unchanged", commonDirGroup };
        }
        await commitFollowTransition(composeFollowRepoTransition(followComposition(), {
          relPath: rel,
          incomingKey: incomingKey!,
          outcome: "deferred",
          deferralReason: follow.reason,
          progress: follow,
        }, followProof), follow);
        glog(`git-sync deferred ${rel}: ${follow.detail}`);
        return { result: "deferred", commonDirGroup };
      }

      // Read AFTER the follow published its refs and BEFORE the transition
      // composes; the journal intent and held-attempt binding above deliberately
      // compose without it. Armed off the RECORD's BASE, never the manifest
      // projection, which HIDES a durable BASE for a removed or structurally
      // absent repository (sync-state-records.ts:144-145). The legacy and
      // deferred paths returned above and can never land a first BASE.
      if (records[rel]?.base === undefined && baseSec === undefined) {
        const observed = await readAllRefsStrict(repoDir);
        if (observed.status !== "unreadable") landingObservation = observed.refs;
      }
      await commitFollowTransition(composeFollowRepoTransition(followComposition(), {
        relPath: rel,
        incomingKey: incomingKey!,
        outcome: "followed",
        progress: follow,
      }, followProof), follow);
      glog(`git-sync followed ${rel}`);
      return { result: "applied", commonDirGroup };
    }

    // Clean apply — one repository-bound config operation.
    // Refusals and containment are decided BEFORE any mutation [v2, B5].
    // The ignore refusal deliberately short-circuits the containment probe: an
    // ignored target must not pay for a realpath walk it can never use.
    const ignoredTarget = rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`));
    // Suppression deliberately removes the repo from the manifest projection,
    // but §130 retains the protected BASE anchor in RepoRecord for this
    // operation. Never compose A/P from the suppressed projection.
    const cleanBaseComposition = {
      prior: { base: records[rel]?.base ?? baseSec, branchBaseOrigins: records[rel]?.branchBaseOrigins },
      candidate: { base: remoteSec },
    };
    let cleanProtocol: Awaited<ReturnType<typeof prepareFollowerBranchProtocol>> | undefined;
    const receipt = await materializeCleanGit({
      root,
      relPath: rel,
      repoDir,
      incomingKey: incomingKey!,
      incoming: remoteSec,
      ignoredTarget,
      cleanMaterialize,
      dotGit: dotGit && { isDirectory: dotGit.isDirectory() },
      stateNonce: state.stateNonce,
      localRefs: () => readAllRefs(repoDir),
      degradedMutex: opts.degradedMutex === true,
      chainTimings,
      warningSink: opts.warningSink,
      applyConfig: configDue
        ? () => tryConfigApply(receivedConfig.applyAfterMaterialization)
        : undefined,
      inheritedConfigBase,
      baseComposition: cleanBaseComposition,
      runMutation: (fn) => runMutation(repoDir, fn),
      applyState: (options) => applyGitState(repoDir, remoteSec, store, kek, options),
      branchProtocol: async (ctx) => {
        if (!cleanProtocol) cleanProtocol = await prepareFollowerBranchProtocol({
          workspaceRoot: root,
          relPath: rel,
          state,
          ctx,
          record: records[rel],
          base: cleanBaseComposition.prior.base,
          incoming: remoteSec,
          liveRefs: await readAllRefs(repoDir),
        });
        if (cleanProtocol.status === "hold") throw new Error(cleanProtocol.reason);
        return cleanProtocol.protocol;
      },
      repoContext: async () => (await repoCtxFromDisk(repoDir))!,
      log: glog,
    });
    if (receipt.status === "deferred") {
      if (receipt.configLaneDeferred) {
        setDeferral(rel, "config", "config", incomingKey, await checkoutOf(repoDir));
      }
      await defer(receipt.reason, receipt.deferralReason);
      return { result: "deferred", commonDirGroup };
    }
    const materialized = receipt.transition;
    if (materialized.proof) repoProofs[rel] = materialized.proof;
    if (materialized.appliedSection !== "retain") {
      if (materialized.appliedSection) applied[rel] = materialized.appliedSection;
      else delete applied[rel];
    }
    if (materialized.branchOrigins) branchBaseOrigins[rel] = materialized.branchOrigins;
    if (materialized.pending) pending[rel] = materialized.pending; else delete pending[rel];
    partial[rel] = materialized.partial;
    if (materialized.deferral === "clear") clearDeferral(rel, "apply");
    else setDeferral(rel, "apply", materialized.deferral, incomingKey, await checkoutOf(repoDir));
    if (materialized.attempt === "clear") clearAttempt(rel);
    delete removedMem[rel];
    idxProj[rel] = materialized.indexProjection;
    glog(receipt.announcement);
    return { result: "applied", commonDirGroup };
  };

  const queuedAt = Date.now();
  const commonDirLocks = new Map<string, Promise<void>>();
  const indexes = new Map(keys.map((rel, i) => [rel, i]));
  let progressDone = 0;
  // A steady delta normally names only a few repos. Prove the other repositories
  // unchanged before pool admission so they do not serialize behind real apply
  // work. Every uncertain state (missing/stale fingerprint, journal, sidecar,
  // config work, or wire difference) deliberately remains on the old path.
  const bypassed = new Set<string>();
  if (runKind === "steady") {
    const cache = await loadGitDivergenceCache(root);
    const fingerprintRun = gitFingerprintRun("per-decision");
    for (const rel of keys) {
      const remoteSec = remote.gitRepos?.[rel];
      const baseSec = baseRepos[rel];
      const record = records[rel];
      if (!remoteSec || !baseSec || !isDeepStrictEqual(remoteSec, baseSec)
        || pending[rel] || removedMem[rel] !== undefined || needsRes[rel] !== undefined
        || record?.partial || record?.attempt || record?.resolutionReceipt
        || Object.keys(record?.deferrals ?? {}).length > 0
        || await checkoutJournalPresent(root, rel)) continue;
      const hit = await fingerprintHitProbe(fingerprintRun, root, rel, cache, undefined, !opts.disableConfigLane);
      if (hit.status !== "hit" || hit.probe.busy || !hit.probe.preflightOk
        || hit.probe.identityKey !== gitIdentityKey(baseSec)) continue;
      if (!opts.disableConfigLane) {
        if (remoteSec.config === undefined) {
          if (record?.cfgSynced !== undefined) continue;
        } else {
          const hash = gitConfigHash(remoteSec.config);
          if (record?.cfgApplied !== hash || hit.cachedLocalCfg?.hash !== hash) continue;
        }
      }
      bypassed.add(rel);
      applied[rel] = sanitizeGitSectionForPersistence(remoteSec);
      run?.record({ index: indexes.get(rel)!, queueMs: 0, wallMs: 0, result: "unchanged" });
      opts.onProgress?.(++progressDone, keys.length);
    }
  }
  // Shutdown latch. poolMap has no cancellation: a task that throws stops only
  // its own worker, and the siblings keep pulling repos while the caller has
  // already unwound — during shutdown that is ungated disk work (pack import,
  // scratch refs, journal writes) racing the stop deadline. Latching instead
  // makes every not-yet-started repo a no-op and raises the abort exactly once,
  // after the pool has fully drained.
  let gateClosure: MutationGateClosedError | undefined;
  const runRepo = async (rel: string): Promise<void> => {
    if (gateClosure) return;
    opts.onApplyQueued?.(rel);
    const wireRemoteSec = remote.gitRepos?.[rel];
    const remoteSec = wireRemoteSec === undefined ? undefined : sanitizeGitSectionForPersistence(wireRemoteSec);
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    const i = indexes.get(rel)!;
    let startedAt = Date.now();
    let result: GitApplyRepoResult = "deferred";
    let commonDirGroup: number | undefined;
    const traceHeld = heldTraceEnabled(pending[rel] !== undefined);
    const chainTimings = run || traceHeld ? zeroGitChainTimings() : undefined;
    const held = heldDecisions.repo({
      relPath: rel, incoming: remoteSec, storedAttempt: records[rel]?.attempt,
      traced: traceHeld, timings: chainTimings,
    });
    try {
      if (collidingRepoKeys.has(rel)) {
        if (remoteSec) pending[rel] = remoteSec;
        clearAttempt(rel);
        setDeferral(rel, "apply", "unreadable", incomingKey);
        result = "deferred";
        return;
      }
      const lockKey = await gitApplyMutationKey(root, rel);
      await chainLock(commonDirLocks, lockKey, async (commonDirLock) => {
        startedAt = Date.now();
        if (await held.earlySkip({
          pending: pending[rel] !== undefined,
          attempt: records[rel]?.attempt,
          partial: records[rel]?.partial,
        })) {
          result = "skipped";
          return;
        }
        const processed = await processRepo(rel, chainTimings, commonDirLock, held);
        result = processed.result;
        commonDirGroup = processed.commonDirGroup;
      });
    } catch (e) {
      if (e instanceof FollowCrashInjectedError) throw e;
      if (e instanceof MutationGateClosedError) {
        // Shutdown closed the mutation gate: NOT this repo's failure. Recording a
        // deferral here would clear held-attempt state for a repo that never
        // failed, and the whole outcome is discarded anyway — so latch the abort
        // and let every remaining repo short-circuit (p-settlement.ts re-throws
        // this same error one level down for the same reason).
        gateClosure = e;
        glog(`git-sync aborted ${rel}: ${errMsg(e)}`);
        return;
      }
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
      const wallMs = Date.now() - startedAt;
      if (chainTimings) finalizeGitChainTimings(chainTimings, wallMs);
      held.emitTrace({ result, wallMs });
      run?.record({
        index: i,
        queueMs: startedAt - queuedAt,
        wallMs,
        result,
        commonDirGroup,
        chain: chainTimings,
      });
      opts.onProgress?.(++progressDone, keys.length);
    }
  };
  const queuedChains = nestedRepoChains(keys)
    .map((chain) => chain.filter((rel) => !bypassed.has(rel)))
    .filter((chain) => chain.length > 0);
  await poolMap(queuedChains, gitApplyConcurrency(), async (chain) => {
    for (const rel of chain) {
      try {
        await runRepo(rel);
      } catch (e) {
        // Once the latch is set, MutationGateClosedError is the ONLY error allowed
        // out of the pool. Anything else escaping here — a throwing injected git
        // logger, a throwing onProgress sink — would reject Promise.all first, so
        // the caller would get THAT error instead of the shutdown signal while the
        // sibling workers kept mutating disk detached: exactly what the latch
        // exists to prevent. Outside a shutdown every error still propagates.
        if (!gateClosure) throw e;
        return;
      }
    }
  });
  if (gateClosure) throw gateClosure;
  return pack();
}
