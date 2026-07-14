import fs from "node:fs/promises";
import path from "node:path";
import { applyGitState, assertGitTargetWithinRoot, gitIdentity, gitIdentityKey, gitPreflight, indexIdentityV2, isGitBusy, preserveGitConflict, quarantineAndWipeGitState, receiverEquivalentCollisionNames, repoCtxFromDisk, poolMap, type AppliedManifestOracle, type CheckoutCapabilityProbe, type GitIdentity, type GitChainTimings, type GitSection, type IgnoreMatcher, type Manifest, type BlobStore, zeroGitChainTimings } from "../../engine/index.js";
import { canonicalizeGitConfig, validateCanonicalGitConfig, type GitConfig } from "../../engine/git/config-sync.js";
import { applyConfigTransaction, materializeFreshGitConfig, readConfigSnapshot, readParsedConfigSnapshot, sameConfigStatToken, type ConfigStatToken, type ConfigTransactionResult } from "../../engine/git/config-txn.js";
import { readAllRefs } from "../../engine/git/refs.js";
import { git, readHead, warnOnce } from "../../engine/git/shared.js";
import { DEFERRAL_LANES, expectedStateNonce, repoRecordsForState, type ConfigShapeIdentity, type GitDeferral, type GitDeferralReason, type GitPartialApply, type RepoRecord, type RepoRecordInput, type SyncState, type WorkspaceConfig } from "../config.js";
import { completeConfigApply, configLaneState, inputRecord, type ConfigLaneState, type GitDeferralUpdates } from "../sync-state.js";
import { checkoutJournalBinding, clearFollowJournal, deriveBaseIndexProjection, followDivergedRepo, FollowCrashInjectedError, quarantineUnboundFollowJournal, recoverAndLandFollowJournal, type FollowCrashPoint, type FollowIntended, type FollowProgress } from "./follow.js";
import { checkoutLabel, configInvalidSkipLogged, configOwnershipSkipLogged, repoDirOf, narrowerScope, projectedKey, emptyToUndef, errMsg, chainLock, gitApplyMutationKey, nestedRepoChains, gitApplyConcurrency, gitFollowEnabled, gitIncomingKey, nextDeferral, repoEquivalenceWarningLogged, sectionOpState } from "./shared.js";
import { gitConfigHash, sameConfigShape, configReceiver } from "./config-lane.js";
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
  idxProj?: Record<string, string | null>;
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
  const repoBits = metrics.repoTimings
    .map((t) => {
      const group = t.commonDirGroup === undefined ? "" : `g${t.commonDirGroup}`;
      const chain = t.chain && t.chain.chainLength > 0
        ? ` L${t.chain.chainLength}fd${Math.round(t.chain.fetchDecryptMs)}bv${Math.round(t.chain.bundleVerifyMs)}gi${Math.round(t.chain.gitImportMs)}io${Math.round(t.chain.indexOpStateMs)}`
        : "";
      return `i${t.index}q${t.queueMs}w${t.wallMs}${GIT_APPLY_RESULT_ABBR[t.result]}${group}${chain}`;
    })
    .join(",");
  return `mode=${metrics.runKind} repos=${metrics.repos} commonDirs=${metrics.commonDirGroups} results=${resultBits || "none"} repoMs=${repoBits || "none"}`;
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
  } = {}
): Promise<GitPullOutcome> {
  const baseRepos = { ...(state.lastSyncedManifest.gitRepos ?? {}) };
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const records = repoRecordsForState(state);
  const configLane: Record<string, ConfigLaneState> = {};
  const deferrals: Record<string, GitDeferralUpdates | null> = {};
  const partial: Record<string, GitPartialApply | null> = {};
  const idxProj: Record<string, string | null> = {};
  const publishedJournals: string[] = [];
  let commonDirGroups: Map<string, number> | undefined;
  let metrics: GitApplyMetrics | undefined;
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(applied),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(pending),
    configLane: emptyToUndef(configLane),
    deferrals: emptyToUndef(deferrals),
    partial: emptyToUndef(partial),
    idxProj: emptyToUndef(idxProj),
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
      await (opts.materializeFreshConfig ?? materializeFreshGitConfig)(repoDir, incoming, path.join(repoDir, ".git"));
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

    const result = await (opts.applyConfig ?? applyConfigTransaction)(repoDir, receiver.configPath, incoming, { baseConfig });
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
    let remoteSec = wireRemoteSec;
    if (wireRemoteSec?.config !== undefined) {
      const config = validateCanonicalGitConfig(wireRemoteSec.config);
      const invalidReason = !config.ok
        ? config.reason
        : wireRemoteSec.refScope === "scoped"
          ? "scoped git section cannot carry config"
          : undefined;
      if (invalidReason) {
        // Treat the field as truly absent for every downstream decision and for
        // the persisted base/pending section. This prevents a later push from
        // carrying the invalid field back onto the wire.
        remoteSec = { ...wireRemoteSec };
        delete remoteSec.config;
        const logKey = `${root}\0${rel}`;
        if (!configInvalidSkipLogged.has(logKey)) {
          configInvalidSkipLogged.add(logKey);
          glog(`git-sync WARNING ${rel}: ignored invalid incoming config (${invalidReason}); Git state continues`);
        }
      }
    }
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    let baseSec = baseRepos[rel];
    let pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    let dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    const commonDirGroup = await commonDirGroupFor(repoDir, dotGit !== undefined);

    // Design 116 recovery is the first per-repo operation in every arm. The
    // surrounding runRepo chain lock is already keyed by this common dir.
    let recoveryConflict = false;
    const recoveryCtx = dotGit ? await repoCtxFromDisk(repoDir).catch(() => undefined) : undefined;
    if (recoveryCtx) {
      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), recoveryCtx);
      const landed = await recoverAndLandFollowJournal(root, rel, binding, state, {
        land: !opts.degradedMutex,
        crashAt: opts.crashAt,
      });
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
      const recovery = await quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state));
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
      idxProj[rel] = null;
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched)`);
      }
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
            `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}`
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
            glog(`git-sync config skipped ${rel}: receiver repository shape is unreadable/non-owned`);
          }
        } else {
          const receiver = await configReceiver(root, diskCtx);
          const lane = invalidateLaneShape(rel, receiver.shape);
          if (!receiver.owned) {
            const logKey = `${root}\0${rel}`;
            if (!configOwnershipSkipLogged.has(logKey)) {
              configOwnershipSkipLogged.add(logKey);
              glog(`git-sync config skipped ${rel}: receiver ${diskCtx.kind} shape does not own the common config`);
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
        if (!(await applyConfigOnly())) return { result: "deferred", commonDirGroup };
        applied[rel] = remoteSec;
        delete pending[rel];
        delete removedMem[rel];
        clearDeferral(rel, "apply");
        if (!configFailed) partial[rel] = null;
        idxProj[rel] = null;
        return { result: "unchanged", commonDirGroup };
      }
    }

    const kek = cfg.kek!; // guaranteed by the fail-closed gate above
    const recordedPartial = records[rel]?.partial;
    let forcedHeldRefs: GitPartialApply["heldRefs"] | undefined;
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
      const held = Object.keys(progress?.heldRefs ?? {}).length > 0;
      const configApplied = progress?.configApplied ?? true;
      if (held) {
        pending[rel] = remoteSec;
      } else {
        applied[rel] = remoteSec;
        delete pending[rel];
      }
      partial[rel] = progress && (held || !configApplied)
        ? partialFrom({ ...progress, configApplied }, true)
        : null;
      needsRes[rel] = gitIdentityKey(progress ? await gitIdentity(repoDir) : localId);
      setDeferral(rel, "apply", reason, incomingKey, await checkoutOf(repoDir));
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually.`);
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

      const intendedFor = async (progress: FollowProgress): Promise<FollowIntended> => {
        const held = Object.keys(progress.heldRefs).length > 0;
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
          base: held ? baseSec : remoteSec,
          ...(held ? { pending: remoteSec } : {}),
          ...configLaneState(lane),
          ...(Object.keys(effectiveDeferrals).length ? { deferrals: effectiveDeferrals } : {}),
          ...(part ? { partial: part } : {}),
          ...(progress.incomingIndexProjection ? { idxProj: progress.incomingIndexProjection } : {}),
        };
        return { record, expectedRepoGen: records[rel]?.repoGen ?? 0, relPath: rel, ...(previousRecord ? { previousRecord } : {}) };
      };

      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
      const follow = await followDivergedRepo({
        workspaceRoot: root,
        relPath: rel,
        ctx,
        base: baseSec,
        incoming: remoteSec,
        store,
        kek,
        oracle: opts.oracle,
        record: idxProj[rel] && records[rel]
          ? { ...records[rel], idxProj: idxProj[rel]! }
          : records[rel],
        binding,
        followEnabled: gitFollowEnabled(),
        runConfig: runFollowConfig,
        makeIntended: intendedFor,
        chainTimings,
        capabilityProbe: opts.capabilityProbe,
        crashAt: opts.crashAt,
        log: glog,
        forcedHeldRefs,
      });
      if (follow.derivedBaseIndexProjection) idxProj[rel] = follow.derivedBaseIndexProjection;
      if (follow.status === "legacy") return legacyConflict(follow.reason, follow);
      if (follow.status === "defer") {
        if (checkpointReproof && follow.reason !== "unsupported") {
          pending[rel] = remoteSec;
          partial[rel] = partialFrom(follow, true);
          needsRes[rel] = gitIdentityKey(await gitIdentity(repoDir));
          setDeferral(rel, "apply", "conflict", incomingKey, await checkoutOf(repoDir));
          markCheckpointReproof(rel);
          return { result: "unchanged", commonDirGroup };
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
      idxProj[rel] = follow.incomingIndexProjection ?? null;
      if (held.length > 0) {
        pending[rel] = remoteSec;
        partial[rel] = partialFrom(follow, false);
        setDeferral(rel, "apply", heldReasonOf(follow.heldRefs), incomingKey, await checkoutOf(repoDir));
      } else {
        applied[rel] = remoteSec;
        delete pending[rel];
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

    // Dir leftover clean materialization [v5]: quarantine (capture-grade pinning +
    // index/op-state copies) then wipe syncable refs/index/op-state, so the leftover's
    // old refs can never re-enter a later all-scope capture. Runs as applyGitState's
    // beforeMutate hook — i.e. ONLY after every remote artifact has been fetched,
    // decrypted, and verified — so a missing/corrupt bundle can never strand a wiped
    // repo. Hook/quarantine failure → defer, nothing wiped.
    // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
    // update-only apply is the whole treatment; the memory clears on success.
    const wipeLeftover = cleanMaterialize && dotGit !== undefined && dotGit.isDirectory();
    // Documented residual (design 116 review R2-1): genuinely fresh targets
    // and clean-materialization wipes have no pre-existing checkout to
    // clobber, so they remain on legacy applyGitState. Journal coverage for
    // fresh/wipe materialization lands with the next design cycle. Degraded,
    // flag-off, and no-oracle modes likewise retain their legacy path.
    const res = await applyGitState(
      repoDir,
      remoteSec,
      store,
      kek,
      {
        ...(opts.degradedMutex ? { legacyWholeSectionOwnership: true } : {}),
        ...(wipeLeftover
          ? {
            beforeMutateWipesRefs: true,
            beforeMutate: async () => {
              await quarantineAndWipeGitState(repoDir);
              delete removedMem[rel]; // leftover quarantined + wiped — the memory served its purpose
            },
          }
          : {}),
        ...(chainTimings ? { chainTimings } : {}),
      }
    );
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
        partial[rel] = partialFrom({
          appliedRefs: Object.fromEntries(Object.entries(remoteSec.refs)
            .filter(([ref]) => !heldSet.has(ref) && !filtered.has(ref))
            .map(([ref, oid]) => [ref, { kind: "direct" as const, oid }])),
          heldRefs: Object.fromEntries(held.map(([ref]) => [ref, "ownership" as const])),
          configApplied,
        }, false);
        setDeferral(rel, "apply", "worktree-ownership", incomingKey, await checkoutOf(repoDir));
      } else {
        applied[rel] = remoteSec;
        delete pending[rel];
        partial[rel] = configApplied
          ? null
          : partialFrom({ appliedRefs: {}, heldRefs: {}, configApplied: false }, false);
        clearDeferral(rel, "apply");
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
    const remoteSec = remote.gitRepos?.[rel];
    const incomingKey = remoteSec === undefined ? undefined : gitIncomingKey(remoteSec);
    const i = indexes.get(rel)!;
    let startedAt = Date.now();
    let result: GitApplyRepoResult = "deferred";
    let commonDirGroup: number | undefined;
    const chainTimings = metrics ? zeroGitChainTimings() : undefined;
    try {
      if (collidingRepoKeys.has(rel)) {
        if (remoteSec) pending[rel] = remoteSec;
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
        setDeferral(rel, "apply", "other", incomingKey, await checkoutOf(repoDirOf(root, rel)));
      }
      glog(`git-sync deferred ${rel}: ${errMsg(e)}`);
      result = "deferred";
    } finally {
      if (metrics) {
        metrics.results[result] += 1;
        metrics.repoTimings.push({
          index: i,
          queueMs: startedAt - queuedAt,
          wallMs: Date.now() - startedAt,
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
  const requested = new Map<string, Set<string>>();
  for (const { rel, partial } of partials) {
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!ctx) {
      outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
      continue;
    }
    const commonDir = path.resolve(ctx.commonDir);
    for (const ref of Object.keys(partial.appliedRefs)) {
      const lockPath = path.resolve(ctx.commonDir, `${ref}.lock`);
      if (!lockPath.startsWith(`${commonDir}${path.sep}`)) {
        outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
        continue;
      }
      const rels = requested.get(lockPath) ?? new Set<string>();
      rels.add(rel);
      requested.set(lockPath, rels);
    }
  }
  const held: Array<{ lockPath: string; handle: Awaited<ReturnType<typeof fs.open>> }> = [];
  try {
    for (const [lockPath, rels] of [...requested.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        held.push({ lockPath, handle: await fs.open(lockPath, "wx") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        for (const rel of rels) outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
      }
    }
    await revalidateGitPartialApplies(root, state, outcome);
    const saved = await save();
    for (const rel of outcome.publishedJournals ?? []) await clearFollowJournal(root, rel, outcome.journalCrashAt);
    return saved;
  } finally {
    for (const { lockPath, handle } of held.reverse()) {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}
