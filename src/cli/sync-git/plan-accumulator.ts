/** Never: probe/capture Git, retain/upload artifacts, authorize branch absence, or persist state. */
import path from "node:path";
import { gitSectionsDiffer, type GitSection } from "../../engine/index.js";
import type { GitDeferralReason, SyncState } from "../config.js";
import type { TransferProgress } from "../transfer-progress.js";
import { repoRecordsForState, validManifestMeta } from "../config.js";
import { emptyToUndef } from "./shared.js";
import { sanitizeGitSectionForPersistence } from "./config-sync.js";
import { normalizeOutgoingGitSections, tombstoneFindingLine } from "./publisher-tombstones.js";
import type { GitPlanOptions, GitPlanStats, GitPushPlan } from "./plan.js";

export type GitPlanTimingBucket =
  | "setupMs"
  | "discoverMs"
  | "removalPruneMs"
  | "journalPreloopMs"
  | "carryMs"
  | "fingerprintMs"
  | "captureMs"
  | "projectionMs"
  | "finalizeMs"
  | "hygieneMs"
  | "divergenceCacheMs";

type GitPlanTimings = Record<GitPlanTimingBucket, number>;
type MutableStats = Omit<GitPlanStats, GitPlanTimingBucket | "carried" | "captured" | "totalMs" | "otherMs">;
export type GitPlanDeferred = { relPath: string; reason: string; typedReason?: GitDeferralReason };

const sanitizeSections = (sections: Record<string, GitSection> | undefined): Record<string, GitSection> =>
  Object.fromEntries(Object.entries(sections ?? {}).map(([relPath, section]) => [relPath, sanitizeGitSectionForPersistence(section)]));

/** The git layer of the manifest the remote actually holds, verbatim — the exact bytes
 *  the delta encoder diffs against. `undefined` when no admissible meta is persisted. */
const wireBaseGitSections = (state: SyncState): Record<string, GitSection> | undefined =>
  validManifestMeta(state.manifestMeta)?.gitRepos;

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

export class GitPlanAccumulator {
  readonly startedAt: number;
  readonly timings: GitPlanTimings = {
    setupMs: 0,
    discoverMs: 0,
    removalPruneMs: 0,
    journalPreloopMs: 0,
    carryMs: 0,
    fingerprintMs: 0,
    captureMs: 0,
    projectionMs: 0,
    finalizeMs: 0,
    hygieneMs: 0,
    divergenceCacheMs: 0,
  };
  readonly stats: MutableStats = {
    repos: 0,
    fpHits: 0,
    fpMisses: 0,
    fpUntrusted: 0,
    spawnedRepos: 0,
    pointerPreSkips: 0,
    parentRelCached: 0,
  };
  readonly base: Record<string, GitSection>;
  readonly durablePending: Record<string, GitSection>;
  readonly pending: Record<string, GitSection>;
  readonly repoAbsent: Record<string, true>;
  readonly removedMemory: Record<string, string>;
  readonly needsResolution: Record<string, string>;
  readonly out: Record<string, GitSection> = {};
  readonly captured: string[] = [];
  carried: string[] = [];
  readonly authoredCfgHashByRepo: Record<string, string> = {};
  readonly publisherAckBindings: NonNullable<GitPushPlan["publisherAckBindings"]> = {};
  readonly absentBranchProofs: NonNullable<GitPushPlan["absentBranchProofs"]> = {};
  readonly packedRefsIdentity: NonNullable<GitPushPlan["packedRefsIdentity"]> = {};
  readonly removed: string[] = [];
  readonly deferred: GitPlanDeferred[] = [];
  readonly captureObserved = new Set<string>();
  /** #828: observed repos whose standing deferrals retire because the path is
   * now under the effective ignore rules. Subset of `captureObserved`. */
  readonly ignoreRetired = new Set<string>();
  readonly configObserved = new Set<string>();
  readonly skipped: Array<{ relPath: string; reason: string }> = [];
  readonly pendingSupersessionCandidates = new Set<string>();
  readonly supersededPending = new Set<string>();
  readonly supersessionIdentityKeys: NonNullable<GitPushPlan["supersessionIdentityKeys"]> = {};
  readonly resolutionCandidates = new Set<string>();
  readonly resolvedPending = new Set<string>();
  readonly stableCarryHygiene = new Set<string>();
  resolutionDisposition: GitPushPlan["resolution"];
  finalizedOutgoing: Record<string, GitSection> | undefined;

  private readonly configLaneDefers = new Set<GitPlanDeferred>();
  private readonly configLaneItems = new Set<GitPlanDeferred>();
  private readonly repoByteAbs = new Map<string, number>();
  private readonly glog: (line: string) => void;
  private captureDone = 0;
  private captureTotal = 0;
  private gitBytesDone = 0;

  constructor(
    readonly root: string,
    state: SyncState,
    private readonly options: GitPlanOptions,
    private readonly onProgress?: TransferProgress,
    now: () => number = () => performance.now(),
  ) {
    this.state = state;
    this.now = now;
    this.startedAt = now();
    this.base = sanitizeSections(state.lastSyncedManifest.gitRepos);
    this.durablePending = sanitizeSections(state.gitPendingRemote);
    this.pending = { ...this.durablePending };
    this.repoAbsent = Object.fromEntries(
      Object.entries(repoRecordsForState(state))
        .filter(([, record]) => record.repoAbsent === true)
        .map(([relPath]) => [relPath, true as const]),
    );
    this.removedMemory = { ...(state.gitReposRemoved ?? {}) };
    this.needsResolution = { ...(state.gitNeedsResolution ?? {}) };
    this.glog = options.onGitLog ?? ((line: string) => console.error(line));
  }

  state: SyncState;
  private readonly now: () => number;

  async measure<T>(bucket: GitPlanTimingBucket, effect: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await effect();
    } finally {
      this.timings[bucket] += this.now() - startedAt;
    }
  }

  log(line: string): void {
    this.glog(line);
  }

  logOnce(seen: Set<string>, rel: string, line: string): void {
    const key = `${this.root}\0${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    this.glog(line);
  }

  carry(rel: string, section: GitSection): void {
    this.out[rel] = section;
    if (!this.carried.includes(rel)) this.carried.push(rel);
  }

  capture(rel: string, section: GitSection): void {
    this.out[rel] = section;
    delete this.repoAbsent[rel];
    this.captured.push(rel);
  }

  defer(rel: string, reason: string, typedReason?: GitDeferralReason): void {
    const item: GitPlanDeferred = { relPath: rel, reason };
    if (typedReason !== undefined) item.typedReason = typedReason;
    this.deferred.push(item);
  }

  deferConfig(rel: string, reason: string, transient = false): void {
    const item = { relPath: rel, reason } satisfies GitPlanDeferred;
    this.deferred.push(item);
    this.configLaneItems.add(item);
    if (transient) this.configLaneDefers.add(item);
  }

  deferRepo(rel: string, reason: string, forced: boolean, typedReason?: GitDeferralReason): void {
    const protectedSection = this.pending[rel];
    if (protectedSection) {
      this.carry(rel, protectedSection);
      this.defer(rel, reason, typedReason);
      delete this.authoredCfgHashByRepo[rel];
      return;
    }
    if (forced && typedReason !== "ref-read-unreadable") {
      this.defer(rel, `${reason} — section dropped from this commit (its blobs are missing server-side)`, typedReason);
      return;
    }
    const base = this.base[rel];
    if (base) this.carry(rel, base);
    this.defer(rel, reason, typedReason);
  }

  revertCapture(rel: string, fallback: GitSection, reason: string, typedReason?: GitDeferralReason): void {
    delete this.absentBranchProofs[rel];
    this.out[rel] = fallback;
    if (this.finalizedOutgoing) this.finalizedOutgoing[rel] = fallback;
    delete this.authoredCfgHashByRepo[rel];
    delete this.repoAbsent[rel];
    const capturedIndex = this.captured.indexOf(rel);
    if (capturedIndex >= 0) this.captured.splice(capturedIndex, 1);
    if (!this.carried.includes(rel)) this.carried.push(rel);
    this.defer(rel, reason, typedReason);
  }

  skipLinkedPointer(rel: string, parentRel: string): void {
    delete this.authoredCfgHashByRepo[rel];
    for (let index = this.deferred.length - 1; index >= 0; index--) {
      const item = this.deferred[index];
      if (item?.relPath === rel && this.configLaneItems.has(item)) this.deferred.splice(index, 1);
    }
    const base = this.base[rel];
    if (base) this.out[rel] = base;
    else delete this.out[rel];
    this.skipped.push({
      relPath: rel,
      reason: `linked worktree of in-tree repo ${parentRel} — history travels with the main clone`,
    });
  }

  normalizeOutgoing(): Record<string, GitSection> {
    const records = repoRecordsForState(this.state);
    const advertised = Object.fromEntries(Object.entries(records).map(([relPath, record]) => [
      relPath,
      record.advertised === undefined ? undefined : sanitizeGitSectionForPersistence(record.advertised),
    ]));
    const normalized = normalizeOutgoingGitSections(
      this.out,
      this.pending,
      advertised,
      (this.options.now?.() ?? new Date()).toISOString(),
      this.absentBranchProofs,
    );
    for (const { relPath, finding } of normalized.findings) this.glog(tombstoneFindingLine(relPath, finding));
    return normalized.sections;
  }

  finalizeOutgoing(): Record<string, GitSection> {
    this.finalizedOutgoing = this.normalizeOutgoing();
    return this.finalizedOutgoing;
  }

  beginCaptureProgress(total: number): void {
    this.captureDone = 0;
    this.captureTotal = total;
    this.gitBytesDone = 0;
    this.repoByteAbs.clear();
  }

  noteRepoBytes(rel: string, absoluteBytes: number): void {
    const previous = this.repoByteAbs.get(rel) ?? 0;
    if (absoluteBytes < previous) {
      this.repoByteAbs.set(rel, absoluteBytes);
      return;
    }
    this.gitBytesDone += absoluteBytes - previous;
    this.repoByteAbs.set(rel, absoluteBytes);
    this.onProgress?.(this.captureDone, this.captureTotal, "gitcap", this.progressLabel(rel), { bytesDone: this.gitBytesDone });
  }

  settleCapture(rel: string): void {
    this.captureDone++;
    const bytes = this.gitBytesDone > 0 ? { bytesDone: this.gitBytesDone } : undefined;
    this.onProgress?.(this.captureDone, this.captureTotal, "gitcap", this.progressLabel(rel), bytes);
  }

  removeConfigLaneResult(rel: string): void {
    delete this.authoredCfgHashByRepo[rel];
    for (let index = this.deferred.length - 1; index >= 0; index--) {
      const item = this.deferred[index];
      if (item?.relPath === rel && this.configLaneItems.has(item)) this.deferred.splice(index, 1);
    }
  }

  /** Pre-MDE fallback for {@link wireBaseGitSections}: approximate the remote's git
   *  layer from local records when no admissible manifest meta exists (older or
   *  foreign state, pre-first-commit, MDE master kill). BASE lags for a pending repo
   *  (see gitBaseAfterCommit) and advertised is only this host's own last ACK, so the
   *  approximation drifts on any section adopted from a peer — issue #793. Delete this
   *  path once a valid meta is an invariant of loaded state. */
  private reconstructedWireBase(records: ReturnType<typeof repoRecordsForState>) {
    const previous = { ...this.base } satisfies Record<string, GitSection>;
    for (const [relPath, record] of Object.entries(records)) {
      if (!record.advertised) continue;
      const expected = sanitizeGitSectionForPersistence(record.advertised);
      // A cfgSynced baseline over config-absent BASE is the pull lane's durable witness
      // that an invalid-present field was sanitized: comparing a safe carry against this
      // publisher's older config-present ACK would author the corrective echo it suppresses.
      if (this.base[relPath]?.config === undefined && record.cfgSynced !== undefined && expected.config !== undefined) {
        const withoutConfig = { ...expected };
        delete withoutConfig.config;
        previous[relPath] = withoutConfig;
      } else {
        previous[relPath] = expected;
      }
    }
    Object.assign(previous, this.durablePending); // PENDING has final precedence (design 178 §D).
    return previous;
  }

  plan(): GitPushPlan {
    const records = repoRecordsForState(this.state);
    const outgoing = this.finalizedOutgoing ?? this.normalizeOutgoing();
    const previous = wireBaseGitSections(this.state) ?? this.reconstructedWireBase(records);
    const authoredCount = Object.keys(this.authoredCfgHashByRepo).length;
    const flagArmed = this.supersededPending.size > 0 || this.resolvedPending.size > 0 || authoredCount > 0;
    const sectionsDiffer = gitSectionsDiffer(outgoing, previous);
    if (flagArmed && !sectionsDiffer) {
      this.glog(`git-sync plan: no section change; armed by superseded=${this.supersededPending.size} resolved=${this.resolvedPending.size} authoredCfg=${authoredCount}`);
    }
    const captureDeferrals: Record<string, GitDeferralReason> = {};
    const configDeferrals: Record<string, GitDeferralReason> = {};
    for (const item of this.deferred) {
      if (this.configLaneDefers.has(item)) configDeferrals[item.relPath] = "config";
      else if (!this.configLaneItems.has(item)) captureDeferrals[item.relPath] = item.typedReason ?? captureReason(item.reason);
    }
    const totalMs = this.now() - this.startedAt;
    const otherMs = Math.max(0, totalMs - Object.values(this.timings).reduce((sum, value) => sum + value, 0));
    const gitPlanStats: GitPlanStats = {
      ...this.stats,
      ...this.timings,
      carried: this.carried.length,
      captured: this.captured.length,
      totalMs,
      otherMs,
    };
    const plan: GitPushPlan = {
      gitRepos: emptyToUndef(outgoing),
      changed: flagArmed || sectionsDiffer,
      repoAbsent: emptyToUndef(this.repoAbsent),
      gitReposRemoved: emptyToUndef(this.removedMemory),
      gitNeedsResolution: emptyToUndef(this.needsResolution),
      gitPendingRemote: emptyToUndef(this.pending),
      authoredCfgHashByRepo: this.authoredCfgHashByRepo,
      captured: this.captured,
      carried: this.carried,
      supersededPending: [...this.supersededPending].sort(),
      resolvedPending: [...this.resolvedPending].sort(),
      protectedPending: Object.keys(this.pending).sort(),
      deferred: this.deferred,
      captureDeferrals,
      configDeferrals,
      captureObserved: [...this.captureObserved].sort(),
      ignoreRetired: [...this.ignoreRetired].sort(),
      configObserved: [...this.configObserved].sort(),
      skipped: this.skipped,
      removed: this.removed,
      gitPlanStats,
    };
    if (Object.keys(this.publisherAckBindings).length > 0) plan.publisherAckBindings = this.publisherAckBindings;
    if (Object.keys(this.absentBranchProofs).length > 0) plan.absentBranchProofs = this.absentBranchProofs;
    if (Object.keys(this.packedRefsIdentity).length > 0) plan.packedRefsIdentity = this.packedRefsIdentity;
    if (Object.keys(this.supersessionIdentityKeys).length > 0) plan.supersessionIdentityKeys = this.supersessionIdentityKeys;
    if (this.resolutionDisposition) plan.resolution = this.resolutionDisposition;
    return plan;
  }

  private progressLabel(rel: string): string {
    return rel === "." ? path.basename(this.root) : rel;
  }
}
