import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitCaptureDeferredError, artifactBinding, checkoutJournalPresent, discoverGitRepos, gitIdentity, gitIdentityKey, gitPreflight, inTreeWorktreeParentRel, isGitBusy, isPresentButUnreadableError, gitSectionBlobRefs, oracleFromState, readRepoIdentityV1, readStateLineageV1, receiverEquivalentCollisionNames, repoCtxFromDisk, poolMap, stateLineageV1FromRealRoot, type DiscoveredGitRepo, type GitRepoKind, type GitSection, type IgnoreMatcher, type RepoCtx } from "../../engine/index.js";
import { pinDisplaced } from "../../engine/git/keep-pins.js";
import { git } from "../../engine/git/shared.js";
import { type GitConfigRunner } from "../../engine/git/config-txn.js";
import { sanitizeGitSectionForPersistence } from "../../engine/git/config-sync.js";
import { expectedStateNonce, repoRecordsForState, syncStreamId, type GitDeferralReason, type SyncState, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import type { TransferProgress } from "../transfer-progress.js";
import { GIT_CAPTURE_CONCURRENCY, configCredentialSkipLogged, configOwnershipSkipLogged, pendingCarryLogged, gitRepoCap, repoDirOf, carryMatrixMatches, emptyToUndef, errMsg, gitIncomingKey, capturePlannedGitSection, observePackedRefsIdentity, packedRefsMtimeRegressed, type ResolutionCaptureTestHooks } from "./shared.js";
import { configReceiver, gitConfigHash, readLocalGitConfig, shouldPublishGitConfig, type LocalCfgRead } from "./config-lane.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { loadGitDivergenceCache, saveGitDivergenceCache, fingerprintHitProbe, buildPlanProbe, writeDivergenceCacheEntry, isGitRepoKind, type FingerprintHitProbeResult, type DivergenceCacheProbeSnapshot, type DivergenceCacheWriteResult } from "./divergence-cache.js";
import { checkoutJournalBinding, quarantineUnboundFollowJournal, recoverAndLandFollowJournal } from "./follow.js";
import { normalizeOutgoingGitSections, tombstoneFindingLine } from "./publisher-tombstones.js";
import { gitPendingSupersedeEnabled, journalAllowsPendingSupersession, pendingSupersessionAckConverges, pendingSupersessionPreProbe, provePendingSupersession } from "./pending-supersession.js";
import { CONFLICT_REF_PRUNE_LIMIT, pruneConflictRefs } from "./conflict-retention.js";
import { discardedIncomingOids, finalResolutionReport, reportAuthorized, resolutionReportHash, type GitResolutionRider } from "./resolution-intent.js";
import { branchesCheckedOutElsewhereStrict } from "../../engine/git/apply.js";
import { readHead } from "../../engine/git/shared.js";
import { branchBaseOriginMatches } from "./base-composer.js";
import { prepareFollowerBranchProtocol } from "./follower-protocol.js";
import { commitAbsentBranchVerification, planAbsentBranchVerification } from "./branch-transition.js";
import { asyncMemo } from "./async-memo.js";
import { republishPlanInput } from "./republish-requests.js";
/** The outcome of push-side git orchestration: the outbound `gitRepos` map, whether it
 *  differs from what the last commit carried, the local-only state after this cycle
 *  (persisted only on a successful commit — recomputed idempotently otherwise), and
 *  the forensic counts for the §10 log line. */
export interface GitPushPlan {
  gitRepos?: Record<string, GitSection>;
  changed: boolean;
  /** Design 108 §3.1: this plan deferred git capture (files-first genesis) AND at least
   *  one repo actually exists to attach — so the driver should run commit 2. Absent when
   *  files-first was inactive or the workspace has no git repos (commit 1 is terminal). */
  filesFirstDeferred?: boolean;
  gitReposRemoved?: Record<string, string>;
  /** Repositories intentionally omitted by the publisher without any branch
   * CAS. Their RepoRecord BASE remains protected but is not wire-projected. */
  repoAbsent?: Record<string, true>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  /** Config hashes authored by this exact plan. Step 4 deliberately initializes
   * this empty; publication/capture rows add entries in steps 5 and 7. */
  authoredCfgHashByRepo: Record<string, string>;
  /** Plan-time physical/logical binding for accepted publisher ACK authority.
   * Captured before publication so a post-commit path replacement cannot lend
   * the committed section another repository's lineage. */
  publisherAckBindings?: Record<string, {
    lineageHash: string;
    repositoryIdentityHash: string;
    repoKind: "dir" | "pointer";
  }>;
  absentBranchProofs?: Record<string, Record<string, { priorOid: string }>>;
  packedRefsIdentity?: Record<string, { mtimeMs: number } | null>;
  captured: string[];
  carried: string[];
  /** Candidate-bound receipts consumed only by the accepted publisher ACK. */
  supersededPending: string[];
  /** Privacy-safe section identity keys proven by the ACK-composer dry run. */
  supersessionIdentityKeys?: Record<string, { pending: string; candidate: string; composed: string }>;
  /** Synchronous keep-mine candidate whose final directional report was authorized. */
  resolvedPending?: string[];
  /** Explicit disposition for the foreground resolver. Never infer this from changed. */
  resolution?: { outcome: "published" | "refused"; reason?: string; confirmedReportHash?: string };
  /** Repos whose entire P-bound record is immutable before accepted ACK. */
  protectedPending: string[];
  deferred: Array<{ relPath: string; reason: string; typedReason?: GitDeferralReason }>;
  captureDeferrals: Record<string, GitDeferralReason>;
  configDeferrals: Record<string, GitDeferralReason>;
  captureObserved: string[];
  configObserved: string[];
  /** Design 68 §3.3 — in-tree linked-worktree pointers whose full-store capture was
   *  policy-skipped because the owning main clone is captured in this same cycle (history
   *  travels with the parent bundle). Base-carry, never a drop — so no removal memory. */
  skipped: Array<{ relPath: string; reason: string }>;
  removed: string[];
  gitPlanStats?: GitPlanStats;
}

export interface GitPlanStats {
  repos: number;
  fpHits: number;
  fpMisses: number;
  fpUntrusted: number;
  spawnedRepos: number;
  pointerPreSkips: number;
  parentRelCached: number;
  carried: number;
  captured: number;
  totalMs: number;
  discoverMs: number;
  journalPreloopMs: number;
  fingerprintMs: number;
  hygieneMs: number;
  otherMs: number;
}

export interface GitPlanOptions {
  /** Forensic sink shared with the surrounding sync operation. */
  onGitLog?: (line: string) => void;
  /** Deterministic test seam for the snapshot-only config subprocess. */
  gitConfigRunner?: GitConfigRunner;
  /** Workspace lock identity/link support is unavailable. Preserve Git syncing,
   * but neither read nor author config-lane updates. */
  disableConfigLane?: boolean;
  /** Degraded workspace serialization permits rollback-only journal recovery. */
  degradedMutex?: boolean;
  /** Design 108 §3.2: files-first genesis defer. When true, planGitSections returns an
   *  empty/absent git section with changed=false WITHOUT discovering/capturing any repo
   *  and WITHOUT touching any local-only sidecar (base/pending/needsRes/removed are all
   *  empty on a genuine genesis, so they pass through untouched). Git is re-derived as
   *  owed by the next ordinary push. */
  filesFirstDefer?: boolean;
  /** Deterministic design-130 tombstone timestamp seam. */
  now?: () => Date;
  /** #526 test seam: the pending chain-restart set. Production reads it from
   *  `.rbox/state/git-republish.json`; tests inject it directly. */
  republish?: ReadonlySet<string>;
  /** Awaited daemon registry observer; errors are observability-only. */
  onGitReposDiscovered?: (repos: readonly DiscoveredGitRepo[]) => Promise<void>;
  /** Deterministic test seam for a ref race after B's provisional pre-probe. */
  afterPendingPreProbe?: (relPath: string) => void | Promise<void>;
  /** Deterministic test seam after capture and immediately before Step-D reads. */
  beforeAbsenceWitness?: (relPath: string) => void | Promise<void>;
  /** Tests only: after context/protocol reads, before authorization preflight. */
  beforeAbsencePreflight?: (relPath: string) => void | Promise<void>;
  /** Ephemeral foreground confirmation authority, retained by the push loop. */
  resolution?: GitResolutionRider;
  /** Publication-capture race seam. Tests only; ordinary/preliminary capture never receives it. */
  resolutionCaptureTestHooks?: ResolutionCaptureTestHooks;
  /** Tests only: observes journal-pair entry after the lazy presence gate. */
  onJournalRecovery?: (relPath: string) => void;
  /** Tests only: runs after the journal pre-loop and before stage-2 decisions. */
  afterJournalPreloop?: () => void | Promise<void>;
  /** Tests only: runs after read-only decisions and memo invalidation, before capture. */
  beforeCapturePool?: () => void | Promise<void>;
  /** Tests only: observes the fresh repository context used by hygiene. */
  onHygieneCtx?: (relPath: string, ctx: RepoCtx | undefined) => void;
}

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (protected pending, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (including a provisionally superseding P
 * candidate, bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced non-P repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 * The #526 republish set also skips the carry fast-path and captures with no basis, but
 * never inherits that drop: its base is still valid server-side, so a failed chain
 * restart defers with base carry and stays pending for the next push.
 */
export async function planGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher,
  /** Per-repo capture progress (the `gitcap` phase): the longest silent phase on a
   *  repo-heavy first push — one `git bundle` per repo, minutes each. Emits after each
   *  capture settles so `done` is a truthful completed-count under bounded concurrency;
   *  `detail` is the repo just captured. Display-only. */
  onProgress?: TransferProgress,
  backoff?: (attempt: number) => Promise<void>,
  options: GitPlanOptions = {}
): Promise<GitPushPlan> {
  const planStartedAt = performance.now();
  // #526: pending operator chain restarts. Read once at entry alongside the 422
  // force set. A republished repo must skip every carry fast-path and capture with
  // no basis, but — unlike a 422 force, whose BASE references blobs the server has
  // LOST — its base is still valid server-side, so a failed republish capture takes
  // the ordinary defer-with-base-carry path and stays pending.
  const republishInput = options.republish
    ? { repos: options.republish }
    : await republishPlanInput(root, syncStreamId(cfg));
  const republish = republishInput.repos;
  if (republishInput.warning) options.onGitLog?.(republishInput.warning);
  if (republish.size > 0) options.onGitLog?.(`git-sync republish pending ${[...republish].sort().join(", ")}`);
  const mustCapture = (rel: string): boolean => force.has(rel) || republish.has(rel);
  // Design 204 §5.1: one policy read at entry. The legacy arm retains the
  // pre-204 probe order and does not consume the scoped memo.
  const gitPlanLazy = process.env.RBOX_GIT_PLAN_LAZY !== "0";
  const timings = {
    discoverMs: 0,
    journalPreloopMs: 0,
    fingerprintMs: 0,
    hygieneMs: 0,
  };
  const measure = async <T>(key: keyof typeof timings, fn: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      timings[key] += performance.now() - startedAt;
    }
  };
  const preCaptureCtx = new Map<string, ReturnType<typeof asyncMemo<RepoCtx | undefined>>>();
  const preCaptureRepoCtx = (rel: string): Promise<RepoCtx | undefined> => {
    if (!gitPlanLazy) return repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    let get = preCaptureCtx.get(rel);
    if (!get) {
      get = asyncMemo(() => repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined));
      preCaptureCtx.set(rel, get);
    }
    return get();
  };
  const sanitizeSections = (sections: Record<string, GitSection> | undefined): Record<string, GitSection> =>
    Object.fromEntries(Object.entries(sections ?? {}).map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));
  const base = sanitizeSections(state.lastSyncedManifest.gitRepos);
  const repoAbsent: Record<string, true> = Object.fromEntries(
    Object.entries(repoRecordsForState(state))
      .filter(([, record]) => record.repoAbsent === true)
      .map(([relPath]) => [relPath, true as const]),
  );
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  // Immutable durable pre-plan checkpoint. Planner-local `pending` is allowed to
  // change (including syncGit:false deletion), but it can never rewrite the
  // expected-previous truth used by the final comparison.
  const durablePending = sanitizeSections(state.gitPendingRemote);
  const pending = { ...durablePending };
  const captured: string[] = [];
  let carried: string[] = [];
  const authoredCfgHashByRepo: Record<string, string> = {};
  const publisherAckBindings: NonNullable<GitPushPlan["publisherAckBindings"]> = {};
  const absentBranchProofs: NonNullable<GitPushPlan["absentBranchProofs"]> = {};
  const packedRefsIdentity: NonNullable<GitPushPlan["packedRefsIdentity"]> = {};
  const removed: string[] = [];
  const deferred: Array<{ relPath: string; reason: string; typedReason?: GitDeferralReason }> = [];
  const configLaneDefers = new Set<(typeof deferred)[number]>();
  const configLaneItems = new Set<(typeof deferred)[number]>();
  const captureObserved = new Set<string>();
  const configObserved = new Set<string>();
  const skipped: Array<{ relPath: string; reason: string }> = [];
  const out: Record<string, GitSection> = {};
  // Normalize exactly once, then prove-and-publish that exact object.
  // A failed proof restores the original P object by identity.
  let finalizedOutgoing: Record<string, GitSection> | undefined;
  const commitCapture = (rel: string, section: GitSection): void => {
    out[rel] = section;
    delete repoAbsent[rel];
    captured.push(rel);
  };
  const revertCapture = (
    rel: string,
    fallback: GitSection,
    reason: string,
    typedReason?: GitDeferralReason,
  ): void => {
    delete absentBranchProofs[rel];
    out[rel] = fallback;
    if (finalizedOutgoing) finalizedOutgoing[rel] = fallback;
    delete authoredCfgHashByRepo[rel];
    delete repoAbsent[rel];
    const capturedIndex = captured.indexOf(rel);
    if (capturedIndex >= 0) captured.splice(capturedIndex, 1);
    if (!carried.includes(rel)) carried.push(rel);
    deferred.push({ relPath: rel, reason, ...(typedReason ? { typedReason } : {}) });
  };
  const pendingSupersessionCandidates = new Set<string>();
  const supersededPending = new Set<string>();
  const supersessionIdentityKeys: NonNullable<GitPushPlan["supersessionIdentityKeys"]> = {};
  const resolutionCandidates = new Set<string>();
  const resolvedPending = new Set<string>();
  let resolutionDisposition: GitPushPlan["resolution"];
  const stableCarryHygiene = new Set<string>();
  const cache = await loadGitDivergenceCache(root);
  const fingerprintRun = gitFingerprintRun("per-decision");
  const fastPathParentRel = new Map<string, string | undefined>();
  const stats: Omit<
    GitPlanStats,
    keyof typeof timings | "carried" | "captured" | "totalMs" | "otherMs"
  > = {
    repos: 0,
    fpHits: 0,
    fpMisses: 0,
    fpUntrusted: 0,
    spawnedRepos: 0,
    pointerPreSkips: 0,
    parentRelCached: 0,
  };
  const glog = options.onGitLog ?? ((line: string) => console.error(line));
  const logOnce = (seen: Set<string>, rel: string, line: string) => {
    const key = `${root}\0${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    glog(line);
  };
  const normalizeCurrentOutgoing = () => {
    const records = repoRecordsForState(state);
    const advertised = Object.fromEntries(Object.entries(records).map(([relPath, record]) => [
      relPath,
      record.advertised === undefined ? undefined : sanitizeGitSectionForPersistence(record.advertised),
    ]));
    return normalizeOutgoingGitSections(
      out, pending, advertised, (options.now?.() ?? new Date()).toISOString(), absentBranchProofs,
    );
  };
  const noteCredentialSkip = (rel: string) =>
    logOnce(configCredentialSkipLogged, rel, `git-sync WARNING ${rel}: skipped credential-bearing remote URL from config capture`);
  const readConfigForPush = (rel: string, diskCtx?: RepoCtx) =>
    readLocalGitConfig(root, rel, diskCtx, options.gitConfigRunner, () => noteCredentialSkip(rel));
  const captureReason = (reason: string): GitDeferralReason => {
    if (/ref-read-unreadable/i.test(reason)) return "ref-read-unreadable";
    if (/\bbusy\b/i.test(reason)) return "git-busy";
    if (/ownership|worktree/i.test(reason)) return "worktree-ownership";
    if (/containment|outside.*root/i.test(reason)) return "containment";
    if (/unsupported|structural|shallow|bare|alternates/i.test(reason)) return "unsupported";
    if (/capture|artifact|blob|decrypt|import|bundle/i.test(reason)) return "artifact";
    if (/unreadable|no usable \.git|preflight/i.test(reason)) return "unreadable";
    return "other";
  };
  const plan = (): GitPushPlan => {
    const records = repoRecordsForState(state);
    const normalized = finalizedOutgoing === undefined
      ? normalizeCurrentOutgoing()
      : { sections: finalizedOutgoing, findings: [] };
    for (const { relPath, finding } of normalized.findings) glog(tombstoneFindingLine(relPath, finding));
    const outgoing = normalized.sections;
    // Changed = the outbound map differs from what the LAST COMMIT carried. For a
    // pending repo the last commit carried the pending section itself (see the per-repo
    // base-advance in pushManifest), so the expected-previous map is base ∪ pending —
    // a steady pending carry is NOT a change (no echo-commit storm).
    const prev: Record<string, GitSection> = { ...base };
    for (const [relPath, record] of Object.entries(records)) {
      if (record.advertised) {
        const expected = sanitizeGitSectionForPersistence(record.advertised);
        // A cfgSynced baseline over config-absent BASE is the pull lane's durable
        // witness that an invalid-present field was sanitized. Do not compare a
        // safe carry against this publisher's older config-present ACK and author
        // the very corrective echo the baseline suppresses. Genuine wire absence
        // clears cfgSynced during pull, preserving old-writer presence healing.
        if (base[relPath]?.config === undefined && record.cfgSynced !== undefined && expected.config !== undefined) {
          const withoutConfig = { ...expected };
          delete withoutConfig.config;
          prev[relPath] = withoutConfig;
        } else prev[relPath] = expected;
      }
    }
    Object.assign(prev, durablePending); // PENDING has final precedence.
    // Config authorship is selected against the current BASE/cfgSynced lane. It
    // may intentionally restore bytes equal to this publisher's older advertised
    // checkpoint after another writer stripped them, so authorship itself is a
    // one-shot publication reason (the ACK stamps cfgSynced and bounds it).
    let changed = supersededPending.size > 0 || resolvedPending.size > 0
      || Object.keys(authoredCfgHashByRepo).length > 0;
    for (const k of new Set([...Object.keys(outgoing), ...Object.keys(prev)])) {
      if (!outgoing[k] || !prev[k] || (outgoing[k] !== prev[k] && !isDeepStrictEqual(outgoing[k], prev[k]))) {
        changed = true;
        break;
      }
    }
    const captureDeferrals: Record<string, GitDeferralReason> = {};
    const configDeferrals: Record<string, GitDeferralReason> = {};
    for (const item of deferred) {
      if (configLaneDefers.has(item)) configDeferrals[item.relPath] = "config";
      else if (configLaneItems.has(item)) continue;
      else captureDeferrals[item.relPath] = item.typedReason ?? captureReason(item.reason);
    }
    const totalMs = performance.now() - planStartedAt;
    const otherMs = Math.max(0, totalMs - Object.values(timings).reduce((sum, value) => sum + value, 0));
    const gitPlanStats: GitPlanStats = {
      ...stats,
      ...timings,
      carried: carried.length,
      captured: captured.length,
      totalMs,
      otherMs,
    };
    return {
      gitRepos: emptyToUndef(outgoing),
      changed,
      repoAbsent: emptyToUndef(repoAbsent),
      gitReposRemoved: emptyToUndef(removedMem),
      gitNeedsResolution: emptyToUndef(needsRes),
      gitPendingRemote: emptyToUndef(pending),
      authoredCfgHashByRepo,
      ...(Object.keys(publisherAckBindings).length > 0 ? { publisherAckBindings } : {}),
      ...(Object.keys(absentBranchProofs).length > 0 ? { absentBranchProofs } : {}),
      ...(Object.keys(packedRefsIdentity).length > 0 ? { packedRefsIdentity } : {}),
      captured,
      carried,
      supersededPending: [...supersededPending].sort(),
      ...(Object.keys(supersessionIdentityKeys).length > 0 ? { supersessionIdentityKeys } : {}),
      resolvedPending: [...resolvedPending].sort(),
      ...(resolutionDisposition ? { resolution: resolutionDisposition } : {}),
      protectedPending: Object.keys(pending).sort(),
      deferred,
      captureDeferrals,
      configDeferrals,
      captureObserved: [...captureObserved].sort(),
      configObserved: [...configObserved].sort(),
      skipped,
      removed,
      gitPlanStats,
    };
  };
  // Design 108 §3.2/§3.1: genesis files-first defer — attach nothing this commit. On a
  // genuine genesis (parentSequence 0, fresh state) base/pending/needsRes/removed are
  // empty, so plan() yields gitRepos=undefined, changed=false, sidecars absent — git is
  // re-derived as owed by the next ordinary push. A cheap discovery (NO capture) decides
  // whether commit 2 is warranted: with ≥1 repo, flag `filesFirstDeferred` so the driver
  // attaches; with zero repos there is nothing owed and commit 1 is terminal (no wasted
  // second push, no "history attached" lie).
  if (options.filesFirstDefer && cfg.syncGit) {
    const discovered = await measure(
      "discoverMs",
      () => discoverGitRepos(root, matcher),
    );
    try { await options.onGitReposDiscovered?.(discovered); } catch { /* daemon observer never changes planning */ }
    return { ...plan(), ...(discovered.length > 0 ? { filesFirstDeferred: true } : {}) };
  }
  if (!cfg.syncGit) {
    // Opt-out: out stays empty → any base entries read as removal (the opt-out
    // propagates), and the local-only bookkeeping is abandoned with it — a surviving
    // pending entry would otherwise re-trigger the per-repo base restore every push
    // (changed forever → echo-commit loop).
    for (const k of new Set([...Object.keys(state.repoRecords ?? {}), ...Object.keys(base), ...Object.keys(pending)])) {
      captureObserved.add(k);
      configObserved.add(k);
      repoAbsent[k] = true;
    }
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(needsRes)) delete needsRes[k];
    for (const k of Object.keys(removedMem)) delete removedMem[k];
    return plan();
  }
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await measure(
    "discoverMs",
    () => discoverGitRepos(root, matcher),
  );
  try { await options.onGitReposDiscovered?.(discovered); } catch { /* daemon observer never changes planning */ }
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned ONLY when the local `.git` genuinely disappears —
  // never on mere discovery absence (an ignored-but-present leftover is undiscoverable
  // yet must keep its resurrection guard for when it is unignored).
  for (const rel of Object.keys(removedMem)) {
    if (kindByPath.has(rel)) continue;
    const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
    if (!dotGit) delete removedMem[rel];
  }

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  const recoveryBlocked = new Map<string, string>();
  const recoveryAllowsSupersession = new Map<string, boolean>();
  const workspaceRootReal = asyncMemo(() => fs.realpath(root));
  await measure("journalPreloopMs", async () => {
    if (gitPlanLazy) {
      await poolMap(keys, GIT_CAPTURE_CONCURRENCY, async (rel) => {
        await preCaptureRepoCtx(rel);
      });
    }
    for (const rel of keys) {
      const ctx = await preCaptureRepoCtx(rel);
      if (options.resolution?.repo === rel && pending[rel]) {
        const journalPresent = await checkoutJournalPresent(root, rel);
        if (journalPresent) {
          recoveryAllowsSupersession.set(rel, false);
          recoveryBlocked.set(rel, "checkout journal must be recovered before keep-mine can publish");
          continue;
        }
      }
      if (!ctx) {
        const recovery = await quarantineUnboundFollowJournal(root, rel, state.stream, expectedStateNonce(state));
        recoveryAllowsSupersession.set(rel, journalAllowsPendingSupersession(recovery.status));
        if (recovery.status === "binding-mismatch") glog(`git-sync WARNING ${rel}: journal for an absent/unreadable repository quarantined at ${recovery.quarantinePath}`);
        else if (recovery.status === "defer") recoveryBlocked.set(rel, recovery.reason);
        continue;
      }
      if (/^[0-9a-f]{32}$/.test(state.stateNonce ?? "")) {
        try {
          const identity = await readRepoIdentityV1(rel, ctx.kind, {
            worktreeId: ctx.repoDir,
            gitDirReal: ctx.gitDir,
            commonDirReal: ctx.commonDir,
          });
          const lineage = gitPlanLazy
            ? stateLineageV1FromRealRoot(await workspaceRootReal(), state.stream, state.stateNonce!, identity)
            : await readStateLineageV1(root, state.stream, state.stateNonce!, identity);
          const binding = artifactBinding(lineage);
          publisherAckBindings[rel] = {
            lineageHash: binding.lineageHash,
            repositoryIdentityHash: binding.repositoryIdentityHash,
            repoKind: ctx.kind,
          };
        } catch (error) {
          recoveryBlocked.set(rel, `publisher BASE binding unavailable: ${errMsg(error)}`);
          continue;
        }
      }
      const recover = !gitPlanLazy || await checkoutJournalPresent(root, rel);
      if (!recover) continue;
      options.onJournalRecovery?.(rel);
      const binding = await checkoutJournalBinding(state.stream, expectedStateNonce(state), ctx);
      const landedRecovery = await recoverAndLandFollowJournal(root, rel, binding, state, { land: !options.degradedMutex });
      const recovery = landedRecovery.recovery;
      recoveryAllowsSupersession.set(rel, journalAllowsPendingSupersession(recovery.status));
      if (recovery.status === "keep") {
        if (options.degradedMutex) {
          recoveryBlocked.set(rel, "published checkout journal awaits non-degraded state save");
          continue;
        }
        state = landedRecovery.state;
        const record = repoRecordsForState(state)[rel];
        if (record?.base) base[rel] = record.base; else delete base[rel];
        if (record?.pending) pending[rel] = record.pending; else delete pending[rel];
        if (record?.repoAbsent === true) repoAbsent[rel] = true; else delete repoAbsent[rel];
        if (record?.removedKey) removedMem[rel] = record.removedKey; else delete removedMem[rel];
        if (record?.resolutionKey) needsRes[rel] = record.resolutionKey; else delete needsRes[rel];
        glog(`git-sync recovered published checkout ${rel} before capture`);
      } else if (recovery.status === "defer") {
        recoveryBlocked.set(rel, recovery.reason);
      } else if (recovery.status === "human-intervened") {
        recoveryBlocked.set(rel, `crash-window human changes preserved; journal quarantined at ${recovery.quarantinePath}`);
      } else if (recovery.status === "binding-mismatch") {
        glog(`git-sync WARNING ${rel}: stale checkout journal quarantined at ${recovery.quarantinePath}`);
      } else if (recovery.status === "fresh-quarantined") {
        recoveryBlocked.set(rel, `partial fresh repository quarantined at ${recovery.quarantinePath}`);
      }
    }
  });
  await options.afterJournalPreloop?.();
  for (const rel of keys) captureObserved.add(rel);
  stats.repos = keys.length;
  // New-repo admission budget [v2, M4]: base/pending repos never count as new work.
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;

  let toCapture: string[] = [];
  const carryOwnedWithConfig = async (rel: string, baseSec: GitSection, bracketed?: LocalCfgRead, knownCtx?: RepoCtx): Promise<void> => {
    out[rel] = baseSec;
    carried.push(rel);
    if (options.disableConfigLane) return;
    configObserved.add(rel);
    const diskCtx = knownCtx ?? await preCaptureRepoCtx(rel);
    if (!diskCtx || diskCtx.kind !== "dir") {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local ${diskCtx?.kind ?? "unreadable"} shape does not own the common config. rbox left shared Git settings alone; Git history can still sync.`);
      return;
    }
    const receiver = await configReceiver(root, diskCtx).catch(() => undefined);
    if (!receiver?.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: local common config is outside workspace ownership. rbox left shared Git settings alone; Git history can still sync.`);
      return;
    }
    const localCfg = bracketed ?? (await readConfigForPush(rel));
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — publication disabled; carrying base verbatim (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      return;
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} (${localCfg.fault.reason}) — carrying base verbatim`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      if (localCfg.fault.disposition === "transient") configLaneDefers.add(item);
      return;
    }
    if (!shouldPublishGitConfig(baseSec.config, localCfg.cached, state.repoRecords?.[rel]?.cfgSynced)) return;
    out[rel] = { ...baseSec, config: localCfg.config };
    authoredCfgHashByRepo[rel] = localCfg.cached.hash;
  };
  const carryBaseConfig = (section: GitSection, baseSec: GitSection | undefined): GitSection => {
    const carried = { ...section };
    delete carried.config;
    if (baseSec?.config !== undefined) carried.config = baseSec.config;
    return carried;
  };
  const captureWithConfig = async (rel: string, section: GitSection): Promise<GitSection> => {
    if (options.disableConfigLane) return carryBaseConfig(section, base[rel]);
    configObserved.add(rel);
    const repoDir = repoDirOf(root, rel);
    const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
    if (!diskCtx || diskCtx.kind !== "dir" || section.refScope !== "all") {
      logOnce(
        configOwnershipSkipLogged,
        rel,
        `git-sync config skipped ${rel}: capture repository is ${diskCtx?.kind ?? "unreadable"}/scoped and does not own the common config. rbox left shared Git settings alone; Git history can still sync.`
      );
      const unowned = { ...section };
      delete unowned.config;
      return unowned;
    }
    let receiver: Awaited<ReturnType<typeof configReceiver>>;
    try {
      receiver = await configReceiver(root, diskCtx);
    } catch (error) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture ownership could not be proven (${errMsg(error)}). rbox left shared Git settings alone; Git history can still sync.`);
      return carryBaseConfig(section, undefined);
    }
    if (!receiver.owned) {
      logOnce(configOwnershipSkipLogged, rel, `git-sync config skipped ${rel}: capture common config is outside workspace ownership. rbox left shared Git settings alone; Git history can still sync.`);
      return carryBaseConfig(section, undefined);
    }

    let localCfg: LocalCfgRead;
    try {
      localCfg = await readConfigForPush(rel, diskCtx);
    } catch (error) {
      localCfg = {
        status: "failed",
        fault: { disposition: "transient", reason: "read-error", error },
      };
    }
    if (localCfg.status === "over-bounds") {
      const item = {
        relPath: rel,
        reason: `git config over wire bounds — capture config suppressed; carrying base config (${localCfg.reason})`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    if (localCfg.status === "failed") {
      const item = {
        relPath: rel,
        reason: `git config ${localCfg.fault.disposition === "permanent" ? "disabled" : "deferred"} during capture (${localCfg.fault.reason}) — carrying base config`,
      };
      deferred.push(item);
      configLaneItems.add(item);
      if (localCfg.fault.disposition === "transient") configLaneDefers.add(item);
      return carryBaseConfig(section, base[rel]);
    }
    const embedded = { ...section, config: localCfg.config };
    authoredCfgHashByRepo[rel] = gitConfigHash(embedded.config);
    return embedded;
  };
  /** Per-repo failure → defer. P always wins byte-for-byte. A forced non-P repo takes
   *  the legacy M5 drop because its BASE references the exact blob the server lost. */
  const deferOne = (rel: string, reason: string, typedReason?: GitDeferralReason) => {
    const protectedSection = pending[rel];
    if (protectedSection) {
      out[rel] = protectedSection;
      if (!carried.includes(rel)) carried.push(rel);
      deferred.push({ relPath: rel, reason, ...(typedReason ? { typedReason } : {}) });
      delete authoredCfgHashByRepo[rel];
      return;
    }
    // A forced repair may drop an ordinary failed section because its referenced
    // blobs are known missing server-side. An unreadable ref store is different:
    // treating that failed observation as a repository omission would turn local
    // corruption into deletion authority, so the active BASE must still carry.
    if (force.has(rel) && typedReason !== "ref-read-unreadable") {
      deferred.push({ relPath: rel, reason: `${reason} — section dropped from this commit (its blobs are missing server-side)`, ...(typedReason ? { typedReason } : {}) });
      return;
    }
    const b = base[rel];
    if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo (§6.4)
    if (b && !carried.includes(rel)) carried.push(rel);
    deferred.push({ relPath: rel, reason, ...(typedReason ? { typedReason } : {}) });
  };
  const pendingPointerPreSkips: Array<{ relPath: string; parentRel: string; admissionAlreadyCounted: boolean }> = [];
  const processRepoSlowPath = async (
    rel: string,
    kind: GitRepoKind | undefined,
    baseSec: GitSection | undefined,
    fastLookup?: FingerprintHitProbeResult,
    opts: { admissionAlreadyCounted?: boolean; forceCapture?: boolean; resolution?: boolean } = {}
  ): Promise<void> => {
    stats.spawnedRepos++;
    const probeBeforeFingerprint = fastLookup?.fingerprint
      ?? await gitFingerprint(fingerprintRun, root, rel);
    const recomputeCacheProbe = async (): Promise<DivergenceCacheProbeSnapshot> => {
      const beforeFingerprint = await gitFingerprint(fingerprintRun, root, rel);
      if (await isGitBusy(repoDirOf(root, rel))) {
        const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx);
        return { beforeFingerprint, probe, kind };
      }
      const pf = await gitPreflight(repoDirOf(root, rel));
      const { probe } = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, pf);
      return { beforeFingerprint, probe, kind: pf.kind ?? kind };
    };

    // Quiescence before ANY identity-based decision (mirrors the pull side): a lock
    // makes write-tree fail → raw-index identity fallback, which would spuriously
    // CLEAR a needsResolution suppression (republishing the conflicted state — the
    // exact [v2, M2] hazard) or a removal memory (resurrection), or re-capture a
    // mid-operation repo. Busy → defer with base carry; next cycle re-examines.
    if (await isGitBusy(repoDirOf(root, rel))) {
      const { probe } = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx);
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel),
        options.disableConfigLane
      ).catch(() => undefined);
      deferOne(rel, "git busy (lock present)");
      return;
    }

    // Removal memory [v2, B4]: a leftover whose identity still equals the memory is the
    // untouched residue of a remote deletion — NOT re-added. Identity changed → the
    // user worked there → re-adding is intentional; clear the memory and fall through.
    // An UNREADABLE leftover (dangling pointer, transient) keeps its guard and is
    // skipped — clearing on a transient would re-add unchanged git once it heals.
    if (!baseSec && removedMem[rel] !== undefined && !opts.resolution) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (!id || gitIdentityKey(id) === removedMem[rel]) return;
      delete removedMem[rel];
    }

    // needsResolution [v2, M2]: carry the checkpointed base until the local identity
    // CHANGES from the recorded conflict-time value (republish must be intentional).
    if (needsRes[rel] !== undefined && !opts.resolution) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === needsRes[rel]) {
        const carry = pending[rel] ?? baseSec;
        if (carry) {
          out[rel] = carry;
          carried.push(rel);
        }
        return;
      }
      delete needsRes[rel];
    }

    const precomputedPendingProbe = opts.forceCapture && fastLookup?.status === "hit"
      && fastLookup.probe.preflightOk && !fastLookup.probe.preflightStructural
      ? fastLookup.probe
      : undefined;
    const pf = precomputedPendingProbe
      ? { ok: true as const, kind: precomputedPendingProbe.preflightKind }
      : await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) {
      const builtProbe = await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
      if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
      const probe = builtProbe.probe;
      await writeDivergenceCacheEntry(
        fingerprintRun,
        root,
        rel,
        cache,
        probe,
        pf.kind ?? kind,
        probeBeforeFingerprint,
        recomputeCacheProbe,
        () => noteCredentialSkip(rel),
        options.disableConfigLane
      ).catch(() => undefined);
      // STRUCTURAL refusal (shallow/bare/alternates/…): the shape can't sync and won't
      // heal by waiting — DROP the section instead of carrying it. Carrying would be
      // permanent poison: identity can't see the structural property, so a base section
      // authored before the shape was detected (e.g. a shallow clone's incomplete
      // bundle, found by live validation) would carry — and fail-close on every
      // receiver — forever. Dropping self-heals: receivers clean their bookkeeping via
      // absence (never touching local .git), and when the user fixes the shape a fresh
      // preflight passes with no base tie to the old bad section.
      if (pf.structural) {
        if (pending[rel]) {
          deferOne(rel, `${pf.reason ?? "structural preflight refusal"} — carrying pending section`);
          return;
        }
        if (baseSec) removed.push(rel);
        if (baseSec || repoRecordsForState(state)[rel] !== undefined) repoAbsent[rel] = true;
        deferred.push({ relPath: rel, reason: `${pf.reason} — section ${baseSec ? "dropped" : "not captured"}` });
        delete needsRes[rel];
        return;
      }
      deferOne(rel, pf.reason ?? "preflight failed");
      return;
    }
    const builtProbe = precomputedPendingProbe && fastLookup
      ? {
          probe: precomputedPendingProbe,
          diskCtx: fastLookup.fingerprint.diskCtx,
          parentRel: precomputedPendingProbe.parentRel,
        }
      : await buildPlanProbe(root, rel, fastLookup?.fingerprint.diskCtx, pf);
    if (builtProbe.diskCtx?.kind === "pointer") fastPathParentRel.set(rel, builtProbe.parentRel);
    const idKey = builtProbe.probe.identityKey;
    const liveKind = pf.kind ?? kind;
    const probe = builtProbe.probe;
    const cacheWrite = await writeDivergenceCacheEntry(
      fingerprintRun,
      root,
      rel,
      cache,
      probe,
      liveKind,
      probeBeforeFingerprint,
      recomputeCacheProbe,
      () => noteCredentialSkip(rel),
      options.disableConfigLane
    ).catch((): DivergenceCacheWriteResult => ({ kind: liveKind, stable: false }));
    if (idKey === "none") {
      // empty repo (no commits yet): nothing to capture; keep any synced base.
      const carry = pending[rel] ?? baseSec;
      if (carry) {
        out[rel] = carry;
        carried.push(rel);
      }
      return;
    }

    // §7 capture-side carry-forward — the normative shape×scope matrix [v3; v4]:
    //   dir/all-base      → carry on full-identity match (design-02 semantics)
    //   dir/scoped-base   → ALWAYS capture fresh (a projected compare would hide a
    //                       genuinely new local branch forever)
    //   pointer/scoped    → carry on scoped-identity match
    //   pointer/all-base  → the explicit wider-carry exception: carry when the base's
    //                       SCOPED PROJECTION matches (terminates the convergence loop)
    if (baseSec && !mustCapture(rel) && !opts.forceCapture) {
      if (!isGitRepoKind(liveKind)) {
        deferOne(rel, "preflight did not report a usable git repo kind");
        return;
      }
      const carry = carryMatrixMatches(baseSec, liveKind, idKey);
      if (carry) {
        await carryOwnedWithConfig(rel, baseSec, cacheWrite.localCfg, builtProbe.diskCtx);
        if (cacheWrite.stable) stableCarryHygiene.add(rel);
        return;
      }
    }
    if (!baseSec) {
      if (!opts.admissionAlreadyCounted) {
        if (admitted >= cap) {
          deferred.push({ relPath: rel, reason: `over the ${cap}-repo cap — new repo not captured this cycle` });
          return;
        }
        admitted++;
      }
    }
    toCapture.push(rel);
  };

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    const pend = pending[rel];
    let fastLookup: FingerprintHitProbeResult | undefined;

    const recoveryReason = recoveryBlocked.get(rel);
    if (recoveryReason) {
      if (pend) {
        const rider = options.resolution?.repo === rel ? options.resolution : undefined;
        deferred.push({ relPath: rel, reason: recoveryReason });
        // P remains authoritative until an accepted ACK, including a forced 422
        // recapture. Recovery refusal is a typed keep-mine disposition and must
        // never make the protected section disappear from the retry manifest.
        out[rel] = pend;
        carried.push(rel);
        if (rider) resolutionDisposition = { outcome: "refused", reason: recoveryReason };
        continue;
      }
      deferOne(rel, recoveryReason);
      continue;
    }

    // Pending remains exact and authoritative until accepted ACK. The pre-probe
    // only admits a provisional candidate; final normalized-candidate proof below
    // decides whether publication is permitted.
    if (pend) {
      const rider = options.resolution?.repo === rel ? options.resolution : undefined;
      if (rider) {
        if (options.degradedMutex) {
          out[rel] = pend;
          carried.push(rel);
          const reason = "workspace locking is degraded; keep-mine publication requires safe serialization";
          deferred.push({ relPath: rel, reason });
          resolutionDisposition = { outcome: "refused", reason };
          continue;
        }
        resolutionCandidates.add(rel);
        await processRepoSlowPath(rel, kind, baseSec, undefined, {
          forceCapture: true,
          admissionAlreadyCounted: true,
          resolution: true,
        });
        continue;
      }
      if (recoveryAllowsSupersession.get(rel) === false || !gitPendingSupersedeEnabled()) {
        out[rel] = pend;
        carried.push(rel);
        continue;
      }
      const probe = await pendingSupersessionPreProbe(root, rel, pend, baseSec);
      if (probe.status === "carry") {
        out[rel] = pend;
        carried.push(rel);
        if (probe.busy) deferred.push({ relPath: rel, reason: probe.reason });
        // Field-forensics lesson (Mac wedge, 2026-07-21): a silent carry made the
        // no-heal diagnosis require SSH log archaeology. One bounded line per push.
        else logOnce(pendingCarryLogged, rel, `git-sync pending carry ${rel}: ${probe.reason}. Your local Git work is safe while rbox retries.`);
        continue;
      }
      pendingSupersessionCandidates.add(rel);
      await options.afterPendingPreProbe?.(rel);
      await processRepoSlowPath(rel, kind, baseSec, probe.fastLookup, { forceCapture: true });
      continue;
    }

    if (!kind) {
      if (!baseSec) continue; // never synced, nothing local → nothing to do
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch((e) => {
          // Only genuine absence drops the section; a permission/IO fault carries the base
          // (design 108 — a chmod-000 hiccup must not propagate a git-section removal).
          return isPresentButUnreadableError(e) ? undefined : false;
        });
      if (dirPresent === undefined) {
        deferOne(rel, "repo dir unreadable (permission/IO fault) — carrying base");
        continue;
      }
      if (!dirPresent) {
        // §9: repo dir GONE ENTIRELY → the pusher drops the section (receivers drop
        // their base entry but never touch local .git).
        removed.push(rel);
        repoAbsent[rel] = true;
        delete needsRes[rel];
        continue;
      }
      const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
      if (dotGit && rel !== "." && (matcher.prunesForGitDiscovery?.(`${rel}/`) ?? false)) {
        out[rel] = baseSec;
        skipped.push({ relPath: rel, reason: "gitignored by discovery pruning — carrying base" });
        continue;
      }
      deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
      continue;
    }

    // §3.3 fast-path guards:
    // 1 !mustCapture(rel) (422 force or #526 republish)
    // 2 no pending, needs-resolution, or removed-memory suppression
    // 3 repo was discovered this run
    // 4 base section exists
    // 5 trusted fingerprint hit with a probe
    // 6 probe is plannable-clean with a valid preflight kind
    // 7 design-43 §7 carry matrix reaches carry
    if (!mustCapture(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kindByPath.has(rel) && baseSec) {
      fastLookup = await measure(
        "fingerprintMs",
        () => fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane),
      );
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        const baseHeadMissing = Object.keys(baseSec.refs).some((ref) =>
          ref.startsWith("refs/heads/") && probe.identityRefs?.[ref] === undefined);
        if (!baseHeadMissing && !probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && carryMatrixMatches(baseSec, pfKind, probe.identityKey)) {
          // A trusted summary can prove a verbatim carry. If publication is due,
          // fall through: the wire needs the canonical config, not merely its hash.
          if (options.disableConfigLane || (fastLookup.cachedLocalCfg && !shouldPublishGitConfig(baseSec.config, fastLookup.cachedLocalCfg, state.repoRecords?.[rel]?.cfgSynced))) {
            out[rel] = baseSec;
            carried.push(rel);
            if (!options.disableConfigLane) configObserved.add(rel);
            fastPathParentRel.set(rel, probe.parentRel);
            stats.fpHits++;
            stableCarryHygiene.add(rel);
            continue;
          }
        }
        stats.fpMisses++;
      } else {
        stats.fpMisses++;
      }
    }

    // §3.8 post-gate extension: a baseless in-tree worktree pointer can only be
    // skipped after `sectioned` is known, but a trusted cached parentRel lets us
    // defer that decision without paying the identity/preflight spawn floor.
    if (!mustCapture(rel) && !pend && needsRes[rel] === undefined && removedMem[rel] === undefined && kind === "pointer" && !baseSec) {
      fastLookup = await measure(
        "fingerprintMs",
        () => fingerprintHitProbe(fingerprintRun, root, rel, cache, kind, !options.disableConfigLane),
      );
      if (fastLookup.status === "untrusted") {
        stats.fpUntrusted++;
      } else if (fastLookup.status === "hit") {
        const probe = fastLookup.probe;
        const pfKind = probe.preflightKind;
        if (!probe.busy && probe.preflightOk && !probe.preflightStructural && isGitRepoKind(pfKind) && probe.parentRel) {
          if (admitted < cap) {
            admitted++;
            pendingPointerPreSkips.push({ relPath: rel, parentRel: probe.parentRel, admissionAlreadyCounted: true });
            continue;
          }
          stats.fpMisses++;
        } else {
          stats.fpMisses++;
        }
      } else {
        stats.fpMisses++;
      }
    }

    await processRepoSlowPath(rel, kind, baseSec, fastLookup);
  }

  // Design 68 §3.3 — base-carry POLICY SKIP for in-tree linked-worktree pointers. A pointer
  // whose owning main clone is (a) an in-tree linked-worktree parent AND (b) itself authored
  // a section THIS cycle skips its own full-store capture: the shared history already rides
  // the main clone's `--single-worktree --all` bundle, so capturing the pointer would upload
  // the same object store again. Skip is BASE-CARRY, never a drop: an existing
  // section is carried forward unchanged (the remote never observes an absence → no removal
  // memory is stamped, sync-git.ts:443/:231 untouched), and a repo with no base is simply
  // never authored. `sectioned` is snapshotted BEFORE mutating toCapture — parents are dir
  // repos, never pointers, so removing a pointer can't change any parent's membership.
  const sectioned = new Set([...Object.keys(out), ...toCapture]);
  const skippedRelPaths = new Set<string>();
  const skipLinkedWorktreePointer = (rel: string, parentRel: string) => {
    skippedRelPaths.add(rel);
    // Ownership is known only now. Undo any provisional slow-carry lane result:
    // linked pointers are non-owned and therefore carry their base verbatim.
    delete authoredCfgHashByRepo[rel];
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (deferred[i]!.relPath === rel && configLaneItems.has(deferred[i]!)) deferred.splice(i, 1);
    }
    const b = base[rel];
    if (b) out[rel] = b; // base-carry: never a remote absence, never a removal memory
    else delete out[rel]; // fresh pointer: never authored
    skipped.push({ relPath: rel, reason: `linked worktree of in-tree repo ${parentRel} — history travels with the main clone` });
  };
  for (const { relPath: rel, parentRel, admissionAlreadyCounted } of pendingPointerPreSkips) {
    if (sectioned.has(parentRel)) {
      skipLinkedWorktreePointer(rel, parentRel);
      stats.pointerPreSkips++;
    } else {
      stats.fpMisses++;
      await processRepoSlowPath(rel, kindByPath.get(rel), base[rel], undefined, { admissionAlreadyCounted });
    }
  }
  for (const rel of [...toCapture, ...carried]) {
    if (mustCapture(rel)) continue; // 422 recapture / #526 republish must capture, not base-carry via policy skip
    if (kindByPath.get(rel) !== "pointer" || pending[rel] || needsRes[rel] !== undefined) continue;
    let parentRel: string | undefined;
    if (fastPathParentRel.has(rel)) {
      parentRel = fastPathParentRel.get(rel);
      stats.parentRelCached++;
    } else {
      parentRel = await inTreeWorktreeParentRel(root, repoDirOf(root, rel));
    }
    if (!parentRel || !sectioned.has(parentRel)) continue; // out-of-tree/submodule/uncaptured parent → unchanged
    skipLinkedWorktreePointer(rel, parentRel);
  }
  if (skippedRelPaths.size > 0) {
    toCapture = toCapture.filter((rel) => !skippedRelPaths.has(rel));
    carried = carried.filter((rel) => !skippedRelPaths.has(rel));
  }

  // Design 204 §5.4: the read-stage ctx memo must never cross into capture
  // or any later mutation/proof stage.
  preCaptureCtx.clear();
  await options.beforeCapturePool?.();

  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline). Progress
  // is a monotonic completed-count (captures run concurrently, so a settle counter is
  // the only truthful "done") with the just-settled repo's name as the display detail.
  const repoCount = toCapture.length;
  let captureDone = 0;
  let gitBytesDone = 0;
  const repoByteAbs = new Map<string, number>();
  const noteRepoBytes = (rel: string, abs: number) => {
    const prev = repoByteAbs.get(rel) ?? 0;
    if (abs < prev) {
      repoByteAbs.set(rel, abs);
      return;
    }
    gitBytesDone += abs - prev;
    repoByteAbs.set(rel, abs);
    onProgress?.(captureDone, repoCount, "gitcap", rel === "." ? path.basename(root) : rel, { bytesDone: gitBytesDone });
  };
  const uploadsDir = path.join(root, ".rbox", "state", "uploads");
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    try {
      const { section: sec, reason } = await capturePlannedGitSection(
        root, rel, cfg, base[rel], api, kek, uploadsDir, mustCapture(rel), backoff,
        (abs) => noteRepoBytes(rel, abs), resolutionCandidates.has(rel),
        resolutionCandidates.has(rel) ? options.resolutionCaptureTestHooks : undefined,
      );
      if (sec) {
        commitCapture(rel, await captureWithConfig(rel, sec));
      } else {
        deferOne(rel, reason ?? "capture returned nothing (repo vanished mid-capture or failed self-validation)");
      }
    } catch (e) {
      const reason = e instanceof GitCaptureDeferredError ? errMsg(e) : `capture failed: ${errMsg(e)}`;
      deferOne(rel, reason, reason.startsWith("ref-read-unreadable:") ? "ref-read-unreadable" : undefined);
    } finally {
      // Root repo (rel ".") shows the workspace folder name rather than a bare ".".
      onProgress?.(
        ++captureDone,
        repoCount,
        "gitcap",
        rel === "." ? path.basename(root) : rel,
        gitBytesDone > 0 ? { bytesDone: gitBytesDone } : undefined
      );
    }
  });

  // Design 200 W/L/D: observe the packed-refs mtime baseline on captured and
  // carried dir repos regardless of the kill switch. A strict capture may turn
  // a BASE-positive branch into an omission only after the full witness and a
  // prepared verify-only lock.
  const absenceCaptureEnabled = process.env.RBOX_GIT_ABSENCE_CAPTURE !== "0";
  for (const rel of [...new Set([...captured, ...carried])].sort()) {
      const candidate = out[rel];
      if (!candidate) continue;
      const record = repoRecordsForState(state)[rel];
      // A hidden BASE is provenance, never W/L/D refusal authority. A fresh
      // repository at the same path must flow through the normal re-add path.
      if (record?.repoAbsent === true || record?.removedKey !== undefined) continue;
      const baseSection = record?.base ?? base[rel];
      // W/L/D and absence proofs are CAPTURE authority only. A carried pending
      // section legitimately omits held BASE heads (it is protected inbound
      // state, not this cycle's evidence) — carried repos take the packed-refs
      // baseline observation below and nothing else.
      const missing = !captured.includes(rel) ? [] : Object.entries(baseSection?.refs ?? {})
        .filter(([ref]) => ref.startsWith("refs/heads/"))
        .filter(([ref]) => candidate.refs[ref] === undefined);

      if (absenceCaptureEnabled && missing.length > 0) await options.beforeAbsenceWitness?.(rel);
      let ctx: RepoCtx | undefined;
      let ctxFailure: unknown;
      try {
        ctx = await repoCtxFromDisk(repoDirOf(root, rel));
      } catch (error) {
        ctxFailure = error;
      }
      if (!ctx) {
        if (absenceCaptureEnabled && missing.length > 0) {
          const reason = `repository context became unreadable before branch deletion proof: ${errMsg(ctxFailure)}`;
          glog(`git-sync deferred ${rel}: finishing branch deletion: ${reason}`);
          const fallback = pending[rel] ?? baseSection;
          if (fallback) revertCapture(rel, fallback, reason, "unreadable");
        }
        continue;
      }
      if (ctx.kind !== "dir") continue;

      const packedObservation = await observePackedRefsIdentity(ctx.commonDir);
      const previousPacked = record?.packedRefsIdentity;
      const packedRegressed = packedRefsMtimeRegressed(previousPacked, packedObservation);
      if (packedObservation.status === "absent") {
        packedRefsIdentity[rel] = null;
      } else if (packedObservation.status === "present"
        && !packedRegressed) {
        packedRefsIdentity[rel] = packedObservation.identity;
      }

      if (!absenceCaptureEnabled || missing.length === 0) continue;

      let refusal: string | undefined = packedObservation.status === "unreadable"
        ? `packed-refs baseline could not be read: ${errMsg(packedObservation.error)}`
        : packedRegressed
          ? "packed-refs mtime regressed while a BASE branch was absent"
          : undefined;
      let refusalType: GitDeferralReason | undefined =
        packedObservation.status === "unreadable" ? "unreadable" : undefined;
      const headLog = await fs.readFile(path.join(ctx.commonDir, "logs", "HEAD")).catch(() => undefined);
      if (!headLog || headLog.byteLength === 0) refusal ??= "HEAD reflog is absent or empty";
      const protocol = refusal ? undefined : await prepareFollowerBranchProtocol({
        workspaceRoot: root, relPath: rel, state, ctx, record,
        base: baseSection, incoming: candidate, liveRefs: candidate.refs,
      });
      if (protocol?.status !== "ready") refusal ??= protocol?.reason ?? "BASE artifact/lineage proof unavailable";
      const readyProtocol = protocol?.status === "ready" ? protocol.protocol : undefined;
      const binding = publisherAckBindings[rel];
      if (readyProtocol && (!binding
        || binding.lineageHash !== readyProtocol.lineageHash
        || binding.repositoryIdentityHash !== readyProtocol.repositoryIdentityHash)) {
        refusal ??= "publisher repository binding changed before absence proof";
      }
      let busy = false;
      let preflight: Awaited<ReturnType<typeof gitPreflight>> = { ok: true };
      let owned = new Map<string, string>();
      let head = "";
      if (!refusal) {
        try {
          await options.beforeAbsencePreflight?.(rel);
          const [busyRead, preflightRead, ownedRead, headRead] = await Promise.all([
            isGitBusy(ctx.repoDir),
            gitPreflight(ctx.repoDir),
            branchesCheckedOutElsewhereStrict(ctx),
            readHead(ctx),
          ]);
          if (ownedRead.status === "unreadable") throw ownedRead.cause;
          busy = busyRead;
          preflight = preflightRead;
          owned = ownedRead.owned;
          head = headRead;
        } catch (error) {
          refusal = `branch deletion authorization evidence could not be read: ${errMsg(error)}`;
          refusalType = "unreadable";
        }
      }
      if (busy) refusal ??= "repository operation began before absence proof";
      if (!preflight.ok) refusal ??= preflight.reason;
      const collisions = receiverEquivalentCollisionNames([
        ...Object.keys(baseSection?.refs ?? {}),
        ...Object.keys(candidate.refs),
        ...owned.keys(),
      ]);
      const proofs: Record<string, { priorOid: string }> = {};

      for (const [ref, priorOid] of missing) {
        if (refusal) break;
        const origin = record?.branchBaseOrigins?.[ref];
        const artifacts = readyProtocol!.artifacts[ref];
        const artifactsClear = artifacts === undefined || (artifacts.absence === "absent"
          && artifacts.present === "absent"
          && artifacts.keeps === "clear"
          && artifacts.settledAbsence === "absent");
        const witnessRefusals = [
          ...(candidate.refScope !== "all" ? ["scoped-capture"] : []),
          ...(!branchBaseOriginMatches(origin, priorOid) ? ["origin-mismatch"] : []),
          ...(branchBaseOriginMatches(origin, priorOid) && origin.lineageHash !== readyProtocol!.lineageHash ? ["lineage-changed"] : []),
          ...(!artifactsClear ? ["artifacts-standing"] : []),
          ...(owned.has(ref) ? ["worktree-owned"] : []),
          ...(collisions.has(ref) ? ["name-collision"] : []),
          ...(head === `ref: ${ref}` ? ["head-symref"] : []),
        ];
        if (witnessRefusals.length > 0) {
          refusal = `branch deletion witness refused ${ref} (${witnessRefusals.join("+")})`;
          break;
        }
        try {
          const verification = await planAbsentBranchVerification(ctx.repoDir, ref);
          await commitAbsentBranchVerification(verification);
          proofs[ref] = { priorOid };
        } catch (error) {
          refusal = errMsg(error);
          break;
        }
      }

      if (!refusal && Object.keys(proofs).length === missing.length) {
        absentBranchProofs[rel] = proofs;
        continue;
      }

      const reason = refusal ?? "branch deletion proof unavailable";
      glog(`git-sync deferred ${rel}: finishing branch deletion: ${reason}`);
      delete absentBranchProofs[rel];
      const fallback = pending[rel] ?? baseSection;
      if (fallback) revertCapture(
        rel,
        fallback,
        reason,
        refusalType ?? (reason.includes("ref-read-unreadable") ? "ref-read-unreadable" : "deletion-pending"),
      );
  }

  const normalized = normalizeCurrentOutgoing();
  for (const { relPath, finding } of normalized.findings) glog(tombstoneFindingLine(relPath, finding));
  finalizedOutgoing = normalized.sections;
  for (const [rel, proofs] of Object.entries(absentBranchProofs)) {
    const section = finalizedOutgoing[rel];
    const exact = section !== undefined && Object.entries(proofs).every(([ref, proof]) =>
      section.refTombstones?.[ref]?.some((entry) => entry.oid === proof.priorOid) === true);
    if (exact) continue;
    delete absentBranchProofs[rel];
    const fallback = pending[rel] ?? base[rel];
    if (fallback) revertCapture(
      rel,
      fallback,
      "proof-backed tombstone could not be authored exactly",
      "deletion-pending",
    );
  }
  for (const rel of [...resolutionCandidates].sort()) {
    const rider = options.resolution?.repo === rel ? options.resolution : undefined;
    const p = pending[rel];
    const candidate = finalizedOutgoing[rel];
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!rider || !p || !candidate || !ctx || !captured.includes(rel)) {
      const reason = deferred.find((item) => item.relPath === rel)?.reason
        ?? "keep-mine capture did not produce a final candidate";
      if (p && candidate !== p) revertCapture(rel, p, reason);
      resolutionDisposition = { outcome: "refused", reason };
      continue;
    }
    const report = await finalResolutionReport({ ctx, pending: p, candidate, store: api.blobStore(), kek });
    if (!reportAuthorized(rider.authorizedLanes, report)) {
      const reason = report.lanes.some((lane) => lane.disposition === "indeterminate")
        ? "keep-mine final discard report was indeterminate"
        : "keep-mine final candidate would discard a lane that was not confirmed — review and confirm again";
      revertCapture(rel, p, reason);
      resolutionDisposition = { outcome: "refused", reason };
      continue;
    }
    const reachable: string[] = [];
    for (const oid of discardedIncomingOids(report)) {
      if (await git(ctx.repoDir, ["cat-file", "-e", `${oid}^{object}`]).then(() => true, () => false)) reachable.push(oid);
    }
    if (reachable.length > 0) {
      await pinDisplaced(ctx.repoDir, reachable, {
        ref: `keep-mine:${rel}`,
        episode: resolutionReportHash(rider.confirmedReport),
        time: (options.now?.() ?? new Date()).toISOString(),
        class: "human",
      });
    }
    resolvedPending.add(rel);
    resolutionDisposition = {
      outcome: "published",
      confirmedReportHash: resolutionReportHash(rider.confirmedReport),
    };
  }
  for (const rel of [...pendingSupersessionCandidates].sort()) {
    const p = pending[rel];
    const candidate = finalizedOutgoing[rel];
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    const binding = publisherAckBindings[rel];
    const proven = captured.includes(rel) && p !== undefined && candidate !== undefined && ctx !== undefined
      && binding !== undefined
      && await provePendingSupersession({
        ctx, pending: p, candidate, store: api.blobStore(), kek,
        base: base[rel], absentBranchProofs: absentBranchProofs[rel],
      })
      && pendingSupersessionAckConverges({
        previousBase: base[rel],
        previousOrigins: repoRecordsForState(state)[rel]?.branchBaseOrigins,
        candidate,
        binding,
        absentBranchProofs: absentBranchProofs[rel],
      });
    if (proven) {
      supersededPending.add(rel);
      const candidateKey = gitIncomingKey(candidate!);
      supersessionIdentityKeys[rel] = {
        pending: gitIncomingKey(p!),
        candidate: candidateKey,
        // Admission proved order-insensitive deep equality with the exact
        // composer output, so its section identity is necessarily identical.
        composed: candidateKey,
      };
      continue;
    }
    if (p) revertCapture(rel, p, "final candidate did not supersede pending section — carrying pending verbatim");
  }

  // Design 174 D: independently bounded scratch-ref hygiene. Only an exact
  // stable carry or a successful final capture qualifies; an unconditional P,
  // needs-resolution, policy, or failure carry never spends this authority.
  let conflictDeleteBudget = CONFLICT_REF_PRUNE_LIMIT;
  const cleanedCommonDirs = new Set<string>();
  const postCleanupCacheRefresh = new Set(captured);
  await measure("hygieneMs", async () => {
    for (const rel of [...new Set([...stableCarryHygiene, ...captured])]
      .filter((candidate) => !resolutionCandidates.has(candidate))
      .sort()) {
      if (conflictDeleteBudget === 0) break;
      const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
      options.onHygieneCtx?.(rel, ctx);
      if (!ctx) continue;
      const commonDir = path.resolve(ctx.commonDir);
      if (cleanedCommonDirs.has(commonDir)) continue;
      cleanedCommonDirs.add(commonDir);
      const result = await pruneConflictRefs(repoDirOf(root, rel), {
        limit: conflictDeleteBudget,
        ctx,
        onBatch: async () => {
          for (const cachedRel of [...cache.repos.keys()]) {
            const cachedCtx = await repoCtxFromDisk(repoDirOf(root, cachedRel)).catch(() => undefined);
            if (cachedCtx && path.resolve(cachedCtx.commonDir) === commonDir) {
              postCleanupCacheRefresh.add(cachedRel);
              cache.repos.delete(cachedRel);
            }
          }
          cache.dirty = true;
          fingerprintRun.commonDirFingerprints.delete(commonDir);
        },
      }).catch(() => undefined);
      conflictDeleteBudget -= result?.deleted ?? 0;
    }
  });

  // Refresh captured entries only after every capture-side cleanup, including
  // conflict-ref pruning above. A per-repo fingerprint run avoids reusing the
  // full-plan common-dir memo that predates capture scratch refs.
  const refreshOrder = [...postCleanupCacheRefresh].sort();
  for (const rel of refreshOrder) {
    cache.repos.delete(rel);
    cache.dirty = true;
    try {
      const postCaptureFingerprintRun = gitFingerprintRun("per-decision");
      const beforeFingerprint = await measure(
        "fingerprintMs",
        () => gitFingerprint(postCaptureFingerprintRun, root, rel),
      );
      const pf = await gitPreflight(repoDirOf(root, rel));
      const built = await buildPlanProbe(root, rel, beforeFingerprint.diskCtx, pf);
      await writeDivergenceCacheEntry(
        postCaptureFingerprintRun,
        root,
        rel,
        cache,
        built.probe,
        pf.kind ?? kindByPath.get(rel),
        beforeFingerprint,
        undefined,
        () => noteCredentialSkip(rel),
        options.disableConfigLane,
      );
    } catch {
      // Cache absence is the safe fallback; it is never correctness-bearing.
    }
  }

  const liveKeys = new Set(keys);
  for (const rel of [...cache.repos.keys()]) {
    if (!liveKeys.has(rel)) {
      cache.repos.delete(rel);
      cache.dirty = true;
    }
  }
  await saveGitDivergenceCache(root, cache).catch(() => {});

  return plan();
}

/** Format the §10 forensic push line:
 *  `git-sync: captured N (a, b) · carried N · skipped N (p: reason) · deferred N (p: reason) · removed N (x)`
 *  Skipped (design 68 §3.3 in-tree worktree pointers) is its own category — distinct from a
 *  failure defer — so the summary reads honestly instead of hiding N× redundant captures. */
export function formatGitPushLine(plan: GitPushPlan): string {
  const names = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  const reasons = (xs: Array<{ relPath: string; reason: string }>) => (xs.length ? ` (${xs.map((d) => `${d.relPath}: ${d.reason}`).join("; ")})` : "");
  return (
    `git-sync: captured ${plan.captured.length}${names(plan.captured)} · carried ${plan.carried.length}` +
    ` · skipped ${plan.skipped.length}${reasons(plan.skipped)}` +
    ` · deferred ${plan.deferred.length}${reasons(plan.deferred)} · removed ${plan.removed.length}${names(plan.removed)}`
  );
}

export function formatGitPlanStats(stats: GitPlanStats): string {
  const ms = (value: number) => Math.round(value);
  return (
    `hit${stats.fpHits}m${stats.fpMisses}u${stats.fpUntrusted} pps${stats.pointerPreSkips}` +
    ` sp${stats.spawnedRepos} prc${stats.parentRelCached}` +
    ` ms[t${ms(stats.totalMs)} d${ms(stats.discoverMs)} j${ms(stats.journalPreloopMs)}` +
    ` f${ms(stats.fingerprintMs)} h${ms(stats.hygieneMs)} o${ms(stats.otherMs)}]`
  );
}

/** Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
 *  remote's own unapplied truth — the saved git BASE must keep the OLD entry (or none)
 *  so the next pull still sees remote != base and retries the apply. Advancing the base
 *  to the pending section would make that pull read "unchanged" and clear pending
 *  without ever applying — silently regressing the other machine's work. */
export function gitBaseAfterCommit(
  committedGit: Record<string, GitSection> | undefined,
  pending: Record<string, GitSection> | undefined,
  baseGit: Record<string, GitSection> | undefined
): Record<string, GitSection> | undefined {
  const stateGit = { ...(committedGit ?? {}) };
  for (const rel of Object.keys(pending ?? {})) {
    const old = baseGit?.[rel];
    if (old) stateGit[rel] = old;
    else delete stateGit[rel];
  }
  return emptyToUndef(stateGit);
}

/** The per-relPath 422 recapture set [v2, M5]: ONLY the repos whose sections reference a
 *  missing (unsatisfied) encSha are force-recaptured — a missing GIT artifact can't be
 *  satisfied by a file re-upload, and the identity-carry would re-reference the absent
 *  bundle (§28). A naive "recapture everything" would drop exactly the repos the
 *  defer machinery is protecting. */
export function gitForceForMissingBlobs(committedGit: Record<string, GitSection> | undefined, missing: Set<string>): Set<string> {
  const gitForce = new Set<string>();
  for (const [rel, sec] of Object.entries(committedGit ?? {})) {
    if (gitSectionBlobRefs(sec).some((ref) => missing.has(ref.encSha))) gitForce.add(rel);
  }
  return gitForce;
}
