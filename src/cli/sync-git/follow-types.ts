/** Follow-pipeline vocabulary: the option/progress/result contracts every other
 * follow module is written against, plus the blocker constructors that turn a
 * classification into a typed deferral. Moved verbatim out of follow.ts. */
import type { MutationBoundary } from "../../engine/mutation-gate.js";
import type { AppliedManifestOracle, BlobStore, GitSection } from "../../engine/index.js";
import type { CheckoutCapabilityProbe, CheckoutDeferCode, CommitCheckoutOptions } from "./checkout-txn.js";
import type { CheckoutJournalBinding } from "./journal.js";
import type { GitChainTimings } from "./chain-timings.js";
import type { RepoCtx } from "./git-state.js";
import type { OpStateRoot } from "../../engine/manifest-validate.js";
import type {
  GitDeferralReason,
  GitPartialApply,
  RepoRecord,
  RepoRecordInput,
  TypedBlocker,
} from "../config.js";
import type { BranchTransitionWitness, LockedBranchProof, RepoBaseProof, SafeRefWitness } from "./base-composer.js";
import type { BreadcrumbVetoGate } from "./breadcrumb-veto.js";
import type { GitFingerprint } from "./fingerprint.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";

export class WorktreeOwnershipUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`worktree ownership evidence could not be read: ${String((cause as Error)?.message ?? cause)}`);
  }
}

export function boundedRefFailure(error: unknown): string {
  const clean = String((error as Error)?.message ?? error)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...clean].length <= 512 ? clean : `${[...clean].slice(0, 511).join("")}…`;
}

export type FollowCrashPoint =
  | "after-safe-refs"
  | "after-journal-write"
  | "after-connectivity-proof"
  | "after-prepare"
  | "after-index-lock"
  | "after-head-commit"
  | "after-ref-commit"
  | "before-index-publish"
  | "after-index-publish"
  | "mid-op-state"
  | "after-published-flip"
  | "before-journal-clear";

/** Test-only process-death sentinel. Orchestration catches ordinary per-repo
 * errors, so this explicit type is the one exception allowed to escape. */
export class FollowCrashInjectedError extends Error {
  constructor(readonly point: FollowCrashPoint) { super(`injected follow crash at ${point}`); }
}

export interface FollowIntended {
  record: RepoRecordInput;
  expectedRepoGen: number;
  relPath: string;
  /** Pre-journal record used to merge a published recovery lane-by-lane. */
  previousRecord?: RepoRecordInput;
  baseProof?: RepoBaseProof;
}

export interface FollowProgress {
  appliedRefs: GitPartialApply["appliedRefs"];
  heldRefs: GitPartialApply["heldRefs"];
  /** Complete classification seam; orchestration appends protocol/composer blockers. */
  blockers: TypedBlocker[];
  /** Exact reflog files consulted while reaching this outcome. */
  consultedReflogPaths?: string[];
  configApplied: boolean;
  incomingIndexProjection?: string;
  derivedBaseIndexProjection?: string;
  branchWitnesses?: Record<string, BranchTransitionWitness>;
  branchLockedProofs?: Record<string, LockedBranchProof>;
  safeRefWitnesses?: Record<string, SafeRefWitness>;
  /** Positive branch already at the confirmed candidate, with no ref mutation/P. */
  manualBranchTerminals?: Record<string, { beforeBaseOid: string; afterOid: string }>;
  tombstonePrunedThisCycle?: boolean;
}

export type FollowResult =
  | ({ status: "followed" } & FollowProgress)
  | ({ status: "defer"; reason: GitDeferralReason; detail: string } & FollowProgress)
  | ({ status: "legacy"; reason: GitDeferralReason; detail: string } & FollowProgress);

export interface FollowOptions {
  workspaceRoot: string;
  relPath: string;
  ctx: RepoCtx;
  base?: GitSection;
  incoming: GitSection;
  store: BlobStore;
  kek: Buffer;
  oracle: AppliedManifestOracle;
  record?: RepoRecord;
  binding: CheckoutJournalBinding;
  /** Exact false preserves the pre-follow conflict disposition. */
  followEnabled: boolean;
  runConfig?: () => Promise<boolean>;
  makeIntended: (progress: FollowProgress) => FollowIntended | Promise<FollowIntended>;
  chainTimings?: GitChainTimings;
  capabilityProbe?: CheckoutCapabilityProbe;
  /** Test seam for the checkout transaction's graph-connectivity classifier,
   * plumbed exactly like `capabilityProbe`. Absent in production. */
  connectivityProof?: CommitCheckoutOptions["connectivityProof"];
  crashAt?: (point: FollowCrashPoint) => void;
  /** Loud receiver-ambiguity diagnostics supplied by pull orchestration. */
  log?: (line: string) => void;
  /** A D2 applied-ref marker failed exact revalidation; human movement wins. */
  forcedHeldRefs?: GitPartialApply["heldRefs"];
  /** Deterministic preservation-boundary race injection for §130 tests. */
  afterBranchPinsPrepared?: (ref: string) => void | Promise<void>;
  /** Structural P3 test seams; observations only, never policy inputs. */
  onContentEquivalentWaiver?: (ref: string) => void;
  onContentEquivalentDestructiveHold?: (ref: string) => void;
  beforePlanBranchTransition?: (ref: string, afterOid: string | null) => void;
  beforeManualAbsentTransition?: (ref: string) => void | Promise<void>;
  beforeWorktreeOwnershipRead?: () => void | Promise<void>;
  /** Tests only: fault injection at the two deliberately lossy readLive sites. */
  beforeCheckoutSecondProof?: () => void | Promise<void>;
  beforeFinalLive?: () => void | Promise<void>;
  mutationBoundary?: MutationBoundary;
  /** Runs after the exact initial classifier and before staged scratch refs are
   * cleaned. The callback may persist an attempt only if its trusted edge still
   * matches after all orchestration/composer inputs have been consumed. */
  afterHeldClassification?: (input: {
    phase: "defer" | "followed";
    trustedFingerprint: GitFingerprint | undefined;
    effectiveBaseIndexProjection: string | null | undefined;
    effectiveIncomingIndexProjection: string | null | undefined;
    blockers: readonly TypedBlocker[];
    reflogPaths: readonly string[];
    progress: FollowProgress;
  }) => void | Promise<void>;
  /** Prevalidated, incoming-key-bound §130 lineage/artifact authority. Without
   * it branch mutation is forbidden; tags/stash retain their distinct lane. */
  branchProtocol?: FollowerBranchProtocol;
  /** D6's explicit, snapshot-confirmed authorization. Automatic follow keeps
   * using the ordinary oracle gates; this narrow mode only waives the exact
   * human divergences enumerated by show-me. Exact ref-plane progress authored
   * by the normal pipeline is reported to the lock-bound snapshot verifier so
   * it can normalize only those known changes and reject every other delta. */
  manualResolution?: {
    snapshotId: string;
    waivedReasons: readonly Extract<GitDeferralReason,
      "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash">[];
    protectedOids: readonly string[];
    secondProof: (authoredRefChanges: readonly { ref: string; before?: string; after?: string }[]) => Promise<boolean>;
  };
}

export interface StagedIncoming {
  tmpDir: string;
  incomingNs: string;
  candidateIndex?: string;
  incomingIndexProjection?: string;
  opState: Array<{ rel: string; tmp: string }>;
  opBytes: Record<string, Uint8Array>;
  cleanupRefs(): Promise<void>;
  cleanup(): Promise<void>;
}

export type StageIncomingOptions = Pick<FollowOptions, "ctx" | "incoming" | "store" | "kek" | "chainTimings">;

export interface LiveMetadata {
  headContent: string;
  currentRef?: string;
  currentTip?: string;
  refs: Record<string, string>;
  indexPresent: boolean;
  indexProjection?: string;
  opState: Record<string, string>;
  opStateRootsPresent: readonly OpStateRoot[];
}

export interface BreadcrumbMismatch {
  rel: OpStateRoot;
  live: string | null;
  base: string | null;
  incoming: string | null;
}

export function opStateRootOf(rel: string): OpStateRoot {
  return rel.split("/")[0] as OpStateRoot;
}

export interface CheckoutClassification {
  safe: boolean;
  reason?: GitDeferralReason;
  detail?: string;
  breadcrumbMismatches: BreadcrumbMismatch[];
  breadcrumbWaived: boolean;
  breadcrumbVetoGate?: BreadcrumbVetoGate;
  blockers: TypedBlocker[];
}

export function blockerForReason(
  reason: GitDeferralReason,
  provenance: "checkout" | "boundary",
  detail?: string,
  code?: CheckoutDeferCode,
): TypedBlocker {
  const blocker: TypedBlocker = { provenance, reason };
  if (detail) blocker.detail = detail;
  if (code) blocker.code = code;
  return blocker;
}

export function progressWithBlocker(
  progress: FollowProgress,
  reason: GitDeferralReason,
  detail: string,
  provenance: "checkout" | "boundary" = "checkout",
): FollowProgress {
  return { ...progress, blockers: [...progress.blockers, blockerForReason(reason, provenance, detail)] };
}

export function deferResult(
  progress: FollowProgress,
  reason: GitDeferralReason,
  detail: string,
  provenance: "checkout" | "boundary" = "checkout",
): FollowResult {
  return { status: "defer", reason, detail, ...progressWithBlocker(progress, reason, detail, provenance) };
}
