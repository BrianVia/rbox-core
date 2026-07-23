import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checkoutTransactionSupported,
  clearCheckoutJournal,
  commitCheckout,
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  indexIdentityV2,
  markCheckoutJournalPublished,
  noDropProof,
  ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY,
  probeReceiverEquivalence,
  receiverEquivalentCollisionNames,
  receiverEquivalentPath,
  recoverJournal,
  tipOwnedByIncoming,
  validateGitSection,
  updateCheckoutJournal,
  writeCheckoutJournal,
  type AppliedManifestOracle,
  type BlobStore,
  type CheckoutCapabilityProbe,
  type CheckoutJournal,
  type CheckoutJournalBinding,
  type CheckoutRefUpdate,
  type GitChainTimings,
  type GitSection,
  basePresentKeepRef,
} from "../../engine/index.js";
import { captureCommonDirIdentity } from "../../engine/git/lockfile.js";
import { branchesCheckedOutElsewhere } from "../../engine/git/apply.js";
import {
  humanDisplacementOrigin,
  prepareDisplacementPins,
  prepareTombstonePrunePins,
  readRefReflogFingerprint,
  runUpdateRefTransaction,
} from "../../engine/git/keep-pins.js";
import { hashFile } from "../../engine/hash.js";
import type { MutationBoundary } from "../../engine/mutation-gate.js";
import { pruneStaleScratchRefs } from "../../engine/git/pins.js";
import { listRefs, readAllRefs, readOpState, readOpStateSnapshot } from "../../engine/git/refs.js";
import { OP_STATE_CLASSIFICATION, OP_STATE_DIRS, OP_STATE_FILES, type OpStateRoot } from "../../engine/manifest-validate.js";
import {
  clearIndexResolveUndo,
  addTimedMs,
  getGitArtifact,
  git,
  gitWithIndexFile,
  headBranchOf,
  importGitPackChain,
  readHead,
  repoCtx,
  exists,
  warnOnce,
  type RepoCtx,
} from "../../engine/git/shared.js";
import type {
  GitDeferralReason,
  GitPartialApply,
  RepoRecord,
  RepoRecordInput,
  TypedBlocker,
} from "../config.js";
import { intentSettled, savePublishedRepoIntent, type PublishedRepoIntentDisposition } from "../sync-state.js";
import {
  origHeadPreservationFailureLine,
  preserveOrigHead,
  pruneOrigHeadRecoveryRefs,
  type OrigHeadPreservation,
} from "./orig-head.js";
import { gitIncomingKey, sectionOpState } from "./shared.js";
import { checkTombstoneAttestation } from "./tombstone-attestation.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import { commitPlannedBranchTransition, planBranchTransition, planManualBranchTransition, type PlannedBranchTransition } from "./branch-transition.js";
import type { BranchTransitionWitness, LockedBranchProof, RepoBaseProof, SafeRefWitness } from "./base-composer.js";
import {
  breadcrumbGateForReason,
  highestBreadcrumbVetoGate,
  logVetoOnce,
  type BreadcrumbVetoGate,
} from "./breadcrumb-veto.js";
import { gitFingerprint, gitFingerprintRun, type GitFingerprint } from "./fingerprint.js";

const refEquivalenceWarnings = new Set<string>();
const receiverEquivalenceByWorkspace = new Map<string, ReturnType<typeof probeReceiverEquivalence>>();

function boundedRefFailure(error: unknown): string {
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

interface FollowOptions {
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
  crashAt?: (point: FollowCrashPoint) => void;
  /** Loud receiver-ambiguity diagnostics supplied by pull orchestration. */
  log?: (line: string) => void;
  /** A D2 applied-ref marker failed exact revalidation; human movement wins. */
  forcedHeldRefs?: GitPartialApply["heldRefs"];
  /** Deterministic preservation-boundary race injection for §130 tests. */
  afterBranchPinsPrepared?: (ref: string) => void | Promise<void>;
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

async function candidateIndexCollision(workspaceRoot: string, repoDir: string, indexPath: string): Promise<string | undefined> {
  let pending = receiverEquivalenceByWorkspace.get(workspaceRoot);
  if (!pending) {
    pending = probeReceiverEquivalence(workspaceRoot);
    receiverEquivalenceByWorkspace.set(workspaceRoot, pending);
  }
  const equivalence = await pending;
  if (!equivalence.caseAliases && !equivalence.unicodeAliases) return undefined;
  const raw = await gitWithIndexFile(repoDir, indexPath, ["ls-files", "-z", "--stage"]);
  const names = new Set(raw.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("candidate index ls-files record lacks pathname");
    return record.slice(tab + 1);
  }));
  const collisions = receiverEquivalentCollisionNames(names, (name) => receiverEquivalentPath(name, equivalence));
  return collisions.size > 0 ? [...collisions].sort().join(", ") : undefined;
}

interface StagedIncoming {
  tmpDir: string;
  incomingNs: string;
  candidateIndex?: string;
  incomingIndexProjection?: string;
  opState: Array<{ rel: string; tmp: string }>;
  opBytes: Record<string, Uint8Array>;
  cleanupRefs(): Promise<void>;
  cleanup(): Promise<void>;
}

type StageIncomingOptions = Pick<FollowOptions, "ctx" | "incoming" | "store" | "kek" | "chainTimings">;

interface LiveMetadata {
  headContent: string;
  currentRef?: string;
  currentTip?: string;
  refs: Record<string, string>;
  indexPresent: boolean;
  indexProjection?: string;
  opState: Record<string, string>;
  opStateRootsPresent: readonly OpStateRoot[];
}

interface BreadcrumbMismatch {
  rel: OpStateRoot;
  live: string | null;
  base: string | null;
  incoming: string | null;
}

export function opStateRootOf(rel: string): OpStateRoot {
  return rel.split("/")[0] as OpStateRoot;
}

interface CheckoutClassification {
  safe: boolean;
  reason?: GitDeferralReason;
  detail?: string;
  breadcrumbMismatches: BreadcrumbMismatch[];
  breadcrumbWaived: boolean;
  breadcrumbVetoGate?: BreadcrumbVetoGate;
  blockers: TypedBlocker[];
}

function blockerForReason(
  reason: GitDeferralReason,
  provenance: "checkout" | "boundary",
  detail?: string,
): TypedBlocker {
  return { provenance, reason, ...(detail ? { detail } : {}) };
}

function progressWithBlocker(
  progress: FollowProgress,
  reason: GitDeferralReason,
  detail: string,
  provenance: "checkout" | "boundary" = "checkout",
): FollowProgress {
  return { ...progress, blockers: [...progress.blockers, blockerForReason(reason, provenance, detail)] };
}

function deferResult(
  progress: FollowProgress,
  reason: GitDeferralReason,
  detail: string,
  provenance: "checkout" | "boundary" = "checkout",
): FollowResult {
  return { status: "defer", reason, detail, ...progressWithBlocker(progress, reason, detail, provenance) };
}

export async function checkoutJournalBinding(stream: string, stateNonce: string, ctx: RepoCtx): Promise<CheckoutJournalBinding> {
  const commonDirReal = await fs.realpath(ctx.commonDir);
  return {
    stream,
    stateNonce,
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal,
    commonDirIdentity: await captureCommonDirIdentity(commonDirReal),
    worktreeId: await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir)),
  };
}

export async function recoverFollowJournal(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
) {
  return recoverJournal<FollowIntended>(workspaceRoot, relPath, binding);
}

type RecoverAndLandFollowJournalResult = {
  recovery: Awaited<ReturnType<typeof recoverFollowJournal>>;
  state: import("../config.js").SyncState;
  disposition?: PublishedRepoIntentDisposition;
};

/** Recover a checkout journal and, when permitted, land and retire its published intent. */
export async function recoverAndLandFollowJournal(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
  state: import("../config.js").SyncState,
  opts: { land?: boolean; crashAt?: FollowOptions["crashAt"] } = {},
): Promise<RecoverAndLandFollowJournalResult> {
  const recovery = await recoverFollowJournal(workspaceRoot, relPath, binding);
  if (recovery.status !== "keep" || opts.land === false) return { recovery, state };
  const published = await savePublishedRepoIntent(workspaceRoot, state, relPath, recovery.intended);
  if (intentSettled(published.disposition)) await clearFollowJournal(workspaceRoot, relPath, opts.crashAt);
  return { recovery, state: published.state, disposition: published.disposition };
}

/** No usable repo context means recovery must never touch Git. Supplying an
 * impossible path binding makes a valid journal retire through the engine's
 * ordinary binding-mismatch path; corrupt journals remain visible/deferred. */
export async function quarantineUnboundFollowJournal(workspaceRoot: string, relPath: string, stream: string, stateNonce: string) {
  return recoverJournal<FollowIntended>(workspaceRoot, relPath, {
    stream,
    stateNonce,
    gitDirReal: "",
    commonDirReal: "",
    commonDirIdentity: { path: "", realpath: "", dev: "", ino: "", birthtimeNs: "" },
    worktreeId: "",
  });
}

export async function clearFollowJournal(workspaceRoot: string, relPath: string, crashAt?: FollowOptions["crashAt"]): Promise<void> {
  crashAt?.("before-journal-clear");
  await clearCheckoutJournal(workspaceRoot, relPath);
}

export function indexArtifact(section: GitSection | undefined, options: { strict?: boolean } = {}) {
  if (!section) return undefined;
  const fields = [section.indexSha, section.indexEncSha, section.indexCipherSize] as const;
  if (fields.every((field) => field === undefined)) return undefined;
  if (!section.indexSha || !section.indexEncSha || section.indexCipherSize === undefined) {
    if (options.strict) throw new Error("incomplete index lane");
    return undefined;
  }
  return {
    sha: section.indexSha,
    encSha: section.indexEncSha,
    cipherSize: section.indexCipherSize,
    ...(section.indexComp ? { comp: section.indexComp } : {}),
    ...(section.indexPayloadSha ? { payloadSha: section.indexPayloadSha } : {}),
  };
}

async function normalizedIndexProjection(repoDir: string, source: string, dest: string): Promise<string | undefined> {
  await fs.copyFile(source, dest);
  try {
    await clearIndexResolveUndo(repoDir, dest);
  } catch {
    return undefined;
  }
  return indexIdentityV2(repoDir, dest);
}

export async function stageIncoming(opts: StageIncomingOptions): Promise<StagedIncoming> {
  const { ctx, incoming, store, kek } = opts;
  await fs.mkdir(path.join(ctx.repoDir, ".rbox"), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(ctx.repoDir, ".rbox", "git-follow-"));
  const incomingNs = `refs/rbox-incoming/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const cleanupRefs = async () => {
    for (const ref of await listRefs(ctx.repoDir, incomingNs).catch(() => [])) await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
  };
  const cleanup = async () => {
    await cleanupRefs();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    let candidateIndex: string | undefined;
    let incomingIndexProjection: string | undefined;
    const artifact = indexArtifact(incoming);
    if (artifact) {
      const raw = path.join(tmpDir, "incoming-index.raw");
      candidateIndex = path.join(tmpDir, "incoming-index");
      await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
        await getGitArtifact(store, kek, artifact, raw, tmpDir);
        incomingIndexProjection = await normalizedIndexProjection(ctx.repoDir, raw, candidateIndex!);
      });
    }
    const opState: Array<{ rel: string; tmp: string }> = [];
    const opBytes: Record<string, Uint8Array> = {};
    for (const [rel, artifactRef] of Object.entries(incoming.opState ?? {})) {
      const tmp = path.join(tmpDir, "op", rel);
      await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
        await getGitArtifact(store, kek, artifactRef, tmp, tmpDir);
        opState.push({ rel, tmp });
        opBytes[rel] = await fs.readFile(tmp);
      });
    }
    await pruneStaleScratchRefs(ctx.repoDir, "refs/rbox-incoming");
    await importGitPackChain(ctx.repoDir, incoming, store, kek, tmpDir, incomingNs, opts.chainTimings);
    return { tmpDir, incomingNs, candidateIndex, incomingIndexProjection, opState, opBytes, cleanupRefs, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function readLive(ctx: RepoCtx, chainTimings?: GitChainTimings): Promise<LiveMetadata | undefined> {
  try {
    const { headContent, currentRef, refs, currentTip } = await addTimedMs(chainTimings, "ownershipMs", async () => {
      const headContent = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
      const currentRef = /^ref:\s*(refs\/\S+)\s*$/.exec(headContent)?.[1];
      const refs = await readAllRefs(ctx.repoDir);
      const currentTip = currentRef
        ? refs[currentRef] ?? await git(ctx.repoDir, ["rev-parse", "--verify", currentRef]).catch(() => undefined)
        : await git(ctx.repoDir, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
      return { headContent, currentRef, refs, currentTip };
    });
    const { indexPresent, indexProjection, opState, opStateRootsPresent } = await addTimedMs(chainTimings, "indexOpStateMs", async () => {
      const indexPath = path.join(ctx.gitDir, "index");
      const indexPresent = await fs.lstat(indexPath).then((stat) => stat.isFile(), (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      const indexProjection = indexPresent ? await indexIdentityV2(ctx.repoDir, indexPath) : undefined;
      const snapshot = await readOpStateSnapshot(ctx.gitDir, hashFile);
      const opState = snapshot.files;
      const opStateRootsPresent = snapshot.rootsPresent;
      return { indexPresent, indexProjection, opState, opStateRootsPresent };
    });
    return { headContent, currentRef, currentTip, refs, indexPresent, indexProjection, opState, opStateRootsPresent };
  } catch {
    return undefined;
  }
}

function firstReason(reasons: Set<GitDeferralReason>): GitDeferralReason | undefined {
  const precedence: GitDeferralReason[] = [
    "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
    "worktree-ownership", "git-busy", "unreadable", "artifact", "containment", "unsupported", "other",
  ];
  return precedence.find((reason) => reasons.has(reason));
}

async function classifyCheckout(args: {
  opts: FollowOptions;
  live: LiveMetadata | undefined;
  incomingProjection?: string;
  baseProjection?: string;
  roots: readonly string[];
  boundary: boolean;
  boundaryChanged?: boolean;
  tombstonePrunedThisCycle?: boolean;
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  heldRefs: GitPartialApply["heldRefs"];
}): Promise<CheckoutClassification> {
  const reasons = new Set<GitDeferralReason>();
  const details: string[] = [];
  const breadcrumbMismatches: BreadcrumbMismatch[] = [];
  const oracle = args.boundary ? await args.opts.oracle.reproveRepo(args.opts.relPath) : await args.opts.oracle.proveRepo(args.opts.relPath);
  if (oracle.kind === "mismatch") { reasons.add("local-edits"); details.push("working tree differs from applied manifest"); }
  else if (oracle.kind === "indeterminate") { reasons.add("unreadable"); details.push(oracle.why); }

  const live = args.live;
  if (!live) {
    reasons.add("unreadable");
    details.push("git metadata could not be read");
  } else {
    const baseHasIndex = indexArtifact(args.opts.base) !== undefined;
    const incomingHasIndex = indexArtifact(args.opts.incoming) !== undefined;
    const projectionFailed = (live.indexPresent && live.indexProjection === undefined)
      || (baseHasIndex && args.baseProjection === undefined)
      || (incomingHasIndex && args.incomingProjection === undefined);
    if (projectionFailed) {
      reasons.add("unreadable");
      details.push("semantic index projection indeterminate");
    } else {
      const liveValue = live.indexPresent ? live.indexProjection : null;
      const baseValue = baseHasIndex ? args.baseProjection : null;
      const incomingValue = incomingHasIndex ? args.incomingProjection : null;
      if (liveValue !== baseValue && liveValue !== incomingValue) {
        reasons.add("local-index");
        details.push("index differs from both base and incoming");
      }
    }

    const baseOp = sectionOpState(args.opts.base);
    const incomingOp = sectionOpState(args.opts.incoming);
    for (const rel of new Set([...Object.keys(live.opState), ...Object.keys(baseOp), ...Object.keys(incomingOp)])) {
      const value = live.opState[rel] ?? null;
      if (value !== (baseOp[rel] ?? null) && value !== (incomingOp[rel] ?? null)) {
        const root = opStateRootOf(rel);
        if (OP_STATE_CLASSIFICATION[root] === "breadcrumb") {
          breadcrumbMismatches.push({ rel: root, live: value, base: baseOp[rel] ?? null, incoming: incomingOp[rel] ?? null });
        } else {
          reasons.add("local-operation");
          details.push(`operation state differs at ${rel}`);
        }
      }
    }

    if (!live.currentTip) {
      reasons.add("unreadable");
      details.push("current checkout tip is unreadable");
    } else {
      const proof = await addTimedMs(args.opts.chainTimings, "ownershipMs", () =>
        tipOwnedByIncoming(args.opts.ctx.repoDir, live.currentTip!, args.roots));
      if (proof.status === "unowned") { reasons.add("local-commits"); details.push("current tip has receiver-only commits"); }
      else if (proof.status === "indeterminate") {
        reasons.add(proof.marker === "shallow-store" ? "unsupported" : "unreadable");
        details.push(`current-tip reachability ${proof.marker}`);
      }
    }

    if (args.opts.ctx.kind === "dir") {
      try {
        const stashOids = await addTimedMs(args.opts.chainTimings, "reflogMs", () =>
          enumerateStashReflogOids(args.opts.ctx.repoDir));
        for (const oid of stashOids) {
          const proof = await addTimedMs(args.opts.chainTimings, "ownershipMs", () =>
            tipOwnedByIncoming(args.opts.ctx.repoDir, oid, args.roots));
          if (proof.status === "unowned") { reasons.add("local-stash"); details.push("stash reflog contains receiver-only work"); }
          else if (proof.status === "indeterminate") { reasons.add("unreadable"); details.push(`stash reachability ${proof.marker}`); }
        }
      } catch {
        reasons.add("unreadable");
        details.push("stash reflog could not be read");
      }
    }
  }
  if (args.checkoutRefReason) {
    reasons.add(args.checkoutRefReason);
    details.push(args.checkoutRefDetail ?? "incoming checkout ref could not be published safely");
  }
  const liveInProgress = live !== undefined && (
    Object.keys(live.opState).some((rel) => OP_STATE_CLASSIFICATION[opStateRootOf(rel)] === "in-progress")
    || live.opStateRootsPresent.some((rel) => OP_STATE_CLASSIFICATION[rel] === "in-progress")
  );
  const vetoes: BreadcrumbVetoGate[] = [];
  if (Object.keys(args.heldRefs).length > 0) vetoes.push("held-refs");
  if (args.tombstonePrunedThisCycle) vetoes.push("tombstone-pruned-this-cycle");
  if (liveInProgress) vetoes.push("in-progress-present");
  for (const reason of reasons) vetoes.push(breadcrumbGateForReason(reason));
  if (args.boundaryChanged) vetoes.push("boundary");
  const breadcrumbVetoGate = highestBreadcrumbVetoGate(vetoes);
  const breadcrumbWaived = !args.opts.manualResolution
    && breadcrumbMismatches.length > 0
    && breadcrumbVetoGate === undefined;
  // Convert once before manual reason deletion so take-theirs can explicitly
  // waive local-operation. Presence gates only the automatic waiver.
  if (breadcrumbMismatches.length > 0 && !breadcrumbWaived) {
    logVetoOnce(args.opts.workspaceRoot, args.opts.relPath, breadcrumbVetoGate ?? "indeterminate", args.opts.log);
    reasons.add("local-operation");
    for (const mismatch of breadcrumbMismatches) details.push(`operation state differs at ${mismatch.rel}`);
  }
  for (const reason of args.opts.manualResolution?.waivedReasons ?? []) reasons.delete(reason);
  const reason = firstReason(reasons);
  const provenance = args.boundary ? "boundary" as const : "checkout" as const;
  const blockers = [...reasons].map((item) => blockerForReason(item, provenance, details.join("; ")));
  return reason
    ? { safe: false, reason, detail: details.join("; "), blockers, breadcrumbMismatches, breadcrumbWaived: false, ...(breadcrumbVetoGate ? { breadcrumbVetoGate } : {}) }
    : { safe: true, blockers, breadcrumbMismatches, breadcrumbWaived, ...(breadcrumbVetoGate ? { breadcrumbVetoGate } : {}) };
}

async function ensureStashReflog(repoDir: string, oid: string): Promise<void> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while creating stash reflog");
  const logPath = path.join(ctx.commonDir, "logs", "refs", "stash");
  const stat = await fs.stat(logPath).catch(() => undefined);
  if (stat && stat.size > 0) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const subject = (await git(repoDir, ["log", "-1", "--format=%s", oid]).catch(() => "rbox: synced stash"))
    .replace(/[\r\n\t]+/g, " ") || "rbox: synced stash";
  const ident = (await git(repoDir, ["var", "GIT_COMMITTER_IDENT"])).replace(/[\r\n]+/g, " ");
  const handle = await fs.open(logPath, "a");
  try {
    await handle.write(`${oid} ${oid} ${ident}\t${subject}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function effectiveRefs(ctx: RepoCtx, incoming: GitSection): { refs: Record<string, string>; deleteAbsent: boolean } {
  if (ctx.kind === "dir") return { refs: { ...incoming.refs }, deleteAbsent: incoming.refScope === "all" };
  const refs: Record<string, string> = {};
  for (const [ref, oid] of Object.entries(incoming.refs)) {
    if (ref.startsWith("refs/heads/")) refs[ref] = oid;
  }
  return { refs, deleteAbsent: false };
}

export interface CheckoutSelfRootWitness {
  ref: string;
  oid: string;
}

/** Selects the exact branch ref that makes the live tip a durable self-root.
 * The caller supplies ref-plane exclusions because the current ref is skipped
 * by publication and therefore is not necessarily represented in heldRefs. */
export function selectCheckoutSelfRootWitness(args: {
  currentTip?: string;
  effectiveIncomingRefs: Readonly<Record<string, string>>;
  receiverRefs: Readonly<Record<string, string>>;
  heldRefs?: ReadonlySet<string>;
  forcedRefs?: ReadonlySet<string>;
  ambiguousRefs?: ReadonlySet<string>;
  /** Boundary proofs must revalidate the same initially selected ref. */
  requiredRef?: string;
}): CheckoutSelfRootWitness | undefined {
  if (!args.currentTip) return undefined;
  const refs = args.requiredRef ? [args.requiredRef] : Object.keys(args.effectiveIncomingRefs).sort();
  for (const ref of refs) {
    if (!ref.startsWith("refs/heads/")
      || args.heldRefs?.has(ref)
      || args.forcedRefs?.has(ref)
      || args.ambiguousRefs?.has(ref)) continue;
    const incomingOid = args.effectiveIncomingRefs[ref];
    if (incomingOid === args.currentTip && args.receiverRefs[ref] === incomingOid) {
      return { ref, oid: incomingOid };
    }
  }
  return undefined;
}

function appliedTerminalOid(value: GitPartialApply["appliedRefs"][string]): string | null | undefined {
  if (value.kind === "direct" || value.kind === "present") return value.oid;
  if (value.kind === "absent") return null;
  if (value.kind === "safe-ref") return value.afterOid;
  return undefined;
}

async function publishRefPlane(
  opts: FollowOptions,
  live: LiveMetadata,
  roots: readonly string[],
  classifyOnly = false,
): Promise<FollowProgress & {
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  checkoutWitnessDisposition: {
    heldRefs: ReadonlySet<string>;
    forcedRefs: ReadonlySet<string>;
    ambiguousRefs: ReadonlySet<string>;
  };
  authoredRefChanges: Array<{ ref: string; before?: string; after?: string }>;
}> {
  const effective = effectiveRefs(opts.ctx, opts.incoming);
  const owned = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
  const appliedRefs: GitPartialApply["appliedRefs"] = {};
  const heldRefs: GitPartialApply["heldRefs"] = {};
  const blockers: TypedBlocker[] = [];
  const consultedReflogPaths = new Set<string>();
  const branchWitnesses: Record<string, BranchTransitionWitness> = {};
  const branchLockedProofs: Record<string, LockedBranchProof> = {};
  const safeRefWitnesses: Record<string, SafeRefWitness> = {};
  const manualBranchTerminals: NonNullable<FollowProgress["manualBranchTerminals"]> = {};
  // A committed prune may have crashed before the state CAS. A/Z overlaid on
  // stale serialized presence reconstructs the §126 veto exactly until this
  // cycle materializes the absence in BASE.
  let tombstonePrunedThisCycle = (opts.branchProtocol?.unmaterializedAbsenceRefs.size ?? 0) > 0;
  const plannedRoots = [...new Set(Object.values(effective.refs))];
  let checkoutRefReason: GitDeferralReason | undefined;
  let checkoutRefDetail: string | undefined;
  let checkoutRefReasonFromIndeterminate = false;
  const authoredRefChanges: Array<{ ref: string; before?: string; after?: string }> = [];
  const manualProtected = new Set(opts.manualResolution?.protectedOids ?? []);
  const incomingHeadRef = headBranchOf(opts.incoming.head);
  const ambiguousRefs = receiverEquivalentCollisionNames([
    ...Object.keys(effective.refs),
    ...Object.keys(live.refs),
    ...owned.keys(),
  ]);
  if (ambiguousRefs.size > 0) warnOnce(
    refEquivalenceWarnings,
    opts.workspaceRoot,
    `git-sync WARNING: receiver-equivalent Git refnames held in ${opts.relPath}: ${[...ambiguousRefs].sort().join(", ")}`,
    opts.log ?? (() => {}),
  );
  if ((live.currentRef && ambiguousRefs.has(live.currentRef)) || (incomingHeadRef && ambiguousRefs.has(incomingHeadRef))) {
    checkoutRefReason = "unreadable";
    checkoutRefDetail = "checkout ref belongs to an ambiguous receiver-equivalence group";
  }
  if (incomingHeadRef && owned.has(incomingHeadRef)) {
    checkoutRefReason = "worktree-ownership";
    checkoutRefDetail = `branch ${incomingHeadRef.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(incomingHeadRef)}`;
  }
  const candidates = new Set(Object.keys(effective.refs));
  if (effective.deleteAbsent) {
    for (const ref of Object.keys(live.refs)) candidates.add(ref);
    for (const ref of Object.keys(opts.base?.refs ?? {})) candidates.add(ref);
  }

  const classifiedHolds = new Map<string, "local-commits" | "local-stash" | "worktree-ownership">();
  const indeterminateRefs = new Set<string>();
  const forcedRefs = new Set(Object.keys(opts.forcedHeldRefs ?? {}));
  for (const ref of candidates) if (ambiguousRefs.has(ref)) classifiedHolds.set(ref, "worktree-ownership");
  for (const [ref, reason] of Object.entries(opts.forcedHeldRefs ?? {})) {
    const classified = reason === "ownership" ? "worktree-ownership" : reason;
    classifiedHolds.set(ref, classified);
    if (ref === live.currentRef) checkoutRefReason ??= classified;
  }
  const protectedByRef = new Map<string, string[]>();
  for (const ref of candidates) {
    if (ref === live.currentRef) continue;
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    if (oldOid === newOid) continue;
    let hold = classifiedHolds.get(ref);
    if (!hold && owned.has(ref)) {
      hold = "worktree-ownership";
      if (opts.manualResolution) checkoutRefReason ??= "worktree-ownership";
      checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(ref)}`;
    }
    if (oldOid) {
      const protectedOids = ref === "refs/stash" && opts.ctx.kind === "dir"
        ? [...new Set([oldOid, ...await addTimedMs(opts.chainTimings, "reflogMs", () => enumerateStashReflogOids(opts.ctx.repoDir))])]
        : [oldOid];
      protectedByRef.set(ref, protectedOids);
      if (!hold) for (const oid of protectedOids) {
        const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () => tipOwnedByIncoming(opts.ctx.repoDir, oid, roots));
        if (proof.status === "unowned") {
          if (opts.manualResolution && manualProtected.has(oid)) continue;
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          break;
        }
        if (proof.status === "indeterminate") {
          indeterminateRefs.add(ref);
          blockers.push({
            provenance: "indeterminate",
            reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
            detail: `${ref} preservation proof ${proof.marker}`,
          });
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (!checkoutRefReason) {
            checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
            checkoutRefReasonFromIndeterminate = true;
          }
          break;
        }
      }
    }
    if (hold) classifiedHolds.set(ref, hold);
  }

  // Tombstones may waive only a determinate local-commits conclusion. Every
  // ambiguity/forced/sibling/current/indeterminate/artifact gate has already
  // run and remains binding.
  const tombstoneAuthorized = new Set<string>();
  for (const [ref, hold] of [...classifiedHolds]) {
    const oldOid = live.refs[ref];
    if (hold !== "local-commits" || !oldOid || !ref.startsWith("refs/heads/")
      || ref === live.currentRef || owned.has(ref) || ambiguousRefs.has(ref)
      || forcedRefs.has(ref) || indeterminateRefs.has(ref) || !opts.branchProtocol) continue;
    const check = checkTombstoneAttestation(opts.branchProtocol.attestations, {
      incomingKey: gitIncomingKey(opts.incoming), ref, oid: oldOid, liveOid: oldOid,
      logicalBaseOid: opts.branchProtocol.logicalBaseRefs[ref] ?? null,
    });
    if (check.status === "authorized") {
      classifiedHolds.delete(ref);
      tombstoneAuthorized.add(ref);
    }
  }

  // Recompute until stable: a ref may be called safe only from roots that will
  // actually remain durable after every already-classified hold. The current
  // checkout ref is deliberately a held root here because checkout may defer.
  let plannedRefs: Record<string, string> = {};
  let heldDurable: Record<string, string> = {};
  for (;;) {
    plannedRefs = {};
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const oid = effective.refs[ref];
      if (oid) plannedRefs[ref] = oid;
    }
    if (live.currentRef && effective.refs[live.currentRef]) plannedRefs[live.currentRef] = effective.refs[live.currentRef]!;
    heldDurable = {};
    for (const [ref, oid] of Object.entries(live.refs)) {
      if (ref === live.currentRef || classifiedHolds.has(ref) || !candidates.has(ref)) heldDurable[ref] = oid;
    }
    let changed = false;
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const protectedOids = protectedByRef.get(ref);
      if (!protectedOids?.length) continue;
      if (tombstoneAuthorized.has(ref)) continue;
      if (opts.manualResolution && protectedOids.every((oid) => manualProtected.has(oid))) continue;
      const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        noDropProof(opts.ctx.repoDir, plannedRefs, heldDurable, {}, protectedOids));
      if (proof.status === "proven") continue;
      classifiedHolds.set(ref, ref === "refs/stash" ? "local-stash" : "local-commits");
      if (proof.status === "indeterminate") {
        indeterminateRefs.add(ref);
        if (!checkoutRefReason) {
          checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
          checkoutRefReasonFromIndeterminate = true;
        }
        blockers.push({
          provenance: "indeterminate",
          reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
          detail: `${ref} no-drop proof ${proof.marker}`,
        });
      }
      changed = true;
    }
    if (!changed) break;
  }

  for (const ref of [...candidates].sort()) {
    if (ref === live.currentRef) continue; // current branch belongs to checkout txn.
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    let hold = classifiedHolds.get(ref);
    if (!hold && ref.startsWith("refs/heads/") && oldOid !== newOid && !opts.branchProtocol) hold = "local-commits";
    if (hold) {
      heldRefs[ref] = hold === "worktree-ownership" ? "ownership" : hold;
      if (opts.manualResolution) checkoutRefReason ??= hold;
      if (ref === incomingHeadRef && !indeterminateRefs.has(ref)) checkoutRefReason = ambiguousRefs.has(ref)
        ? "unreadable"
        : hold;
      continue;
    }
    if (oldOid === newOid) {
      const baseOid = opts.base?.refs[ref] ?? null;
      if (ref.startsWith("refs/heads/")) {
        const logicalBaseOid = opts.branchProtocol?.logicalBaseRefs[ref] ?? null;
        const disposition = opts.branchProtocol?.artifacts[ref];
        const reconstructedAbsence = opts.branchProtocol?.absenceWitnesses[ref];
        const artifactsClear = disposition === undefined || (disposition.absence === "absent"
          && disposition.present === "absent" && disposition.keeps === "clear" && disposition.settledAbsence === "absent");
        if (!newOid && oldOid === undefined && baseOid !== null
          && reconstructedAbsence?.priorOid === baseOid
          && disposition?.absence === "valid-owning") {
          appliedRefs[ref] = { kind: "absent", artifactOid: reconstructedAbsence.artifactOid };
          branchWitnesses[ref] = reconstructedAbsence;
          branchLockedProofs[ref] = {
            liveOid: null,
            witness: reconstructedAbsence,
            artifactsClear: true,
            ownershipStable: true,
            reflogStable: true,
            currentRef: false,
            siblingOwned: false,
          };
        } else if (logicalBaseOid === (newOid ?? null) && newOid) {
          appliedRefs[ref] = { kind: "direct", oid: newOid };
        } else if (opts.manualResolution && newOid && logicalBaseOid !== null && artifactsClear) {
          manualBranchTerminals[ref] = { beforeBaseOid: logicalBaseOid, afterOid: newOid };
          appliedRefs[ref] = { kind: "direct", oid: newOid };
        } else if (opts.manualResolution && !newOid && logicalBaseOid !== null && opts.branchProtocol) {
          try {
            const plan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref,
              physicalBeforeOid: null, afterOid: null, logicalBaseOid,
            }));
            const committed = await commitPlannedBranchTransition(plan, async () => {
              const lockedRefs = await readAllRefs(opts.ctx.repoDir);
              const lockedOwned = await branchesCheckedOutElsewhere(opts.ctx);
              if (lockedRefs[ref] !== undefined || lockedOwned.has(ref)) throw new Error("manual absent branch changed at locked proof");
            }, opts.chainTimings);
            branchWitnesses[ref] = committed.witness;
            branchLockedProofs[ref] = committed.lockedProof;
            appliedRefs[ref] = plan.partial;
          } catch (error) {
            heldRefs[ref] = "local-commits";
            checkoutRefReason ??= "other";
            checkoutRefDetail ??= `manual absent branch proof failed for ${ref}: ${boundedRefFailure(error)}`;
          }
        } else if (baseOid !== (newOid ?? null)) {
          heldRefs[ref] = "local-commits"; // equality cannot invent branch P/A authority.
        }
      } else if (baseOid !== (newOid ?? null)) {
        const persisted = opts.record?.partial?.incomingKey === gitIncomingKey(opts.incoming)
          ? opts.record.partial.appliedRefs[ref]
          : undefined;
        const witness: SafeRefWitness = persisted?.kind === "safe-ref" && persisted.afterOid === (newOid ?? null)
          ? persisted
          : { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: newOid ?? null };
        appliedRefs[ref] = witness;
        safeRefWitnesses[ref] = witness;
      } else if (newOid) {
        appliedRefs[ref] = { kind: "direct", oid: newOid };
      }
      if (!opts.manualResolution && ref === "refs/stash" && newOid) {
        if (!classifyOnly) await addTimedMs(opts.chainTimings, "reflogMs", () => ensureStashReflog(opts.ctx.repoDir, newOid));
      }
      continue;
    }
    if (classifyOnly) continue;
    try {
      const ownedNow = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
      const liveNow = await addTimedMs(opts.chainTimings, "ownershipMs", () => readAllRefs(opts.ctx.repoDir));
      const ambiguousNow = receiverEquivalentCollisionNames([
        ...Object.keys(effective.refs),
        ...Object.keys(liveNow),
        ...ownedNow.keys(),
      ]);
      if (ambiguousNow.has(ref)) {
        heldRefs[ref] = "ownership";
        checkoutRefDetail ??= "ref belongs to an ambiguous receiver-equivalence group";
        if (opts.manualResolution || ref === incomingHeadRef) checkoutRefReason = "unreadable";
        continue;
      }
      if (ownedNow.has(ref)) {
        heldRefs[ref] = "ownership";
        const sibling = ownedNow.get(ref);
        checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${sibling}`;
        if (opts.manualResolution || ref === incomingHeadRef) checkoutRefReason = "worktree-ownership";
        continue;
      }
      if (!oldOid && !newOid) continue;

      const lines: string[] = [];
      let tombstoneFingerprint: string | undefined;
      let branchEpisode: string | undefined;
      if (oldOid && (!newOid || (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid]))).status !== "owned")) {
        consultedReflogPaths.add(`logs/${ref}`);
        const durableNow = { ...liveNow };
        delete durableNow[ref];
        branchEpisode = crypto.randomBytes(16).toString("hex");
        const pins = tombstoneAuthorized.has(ref)
          ? await addTimedMs(opts.chainTimings, "reflogMs", () =>
              prepareTombstonePrunePins(opts.ctx.repoDir, ref, oldOid, branchEpisode!, new Date().toISOString()))
          : await addTimedMs(opts.chainTimings, "reflogMs", () => prepareDisplacementPins(
              opts.ctx.repoDir,
              ref,
              oldOid,
              [...Object.values(durableNow), ...(newOid ? [newOid] : [])],
              humanDisplacementOrigin(ref, opts.incoming),
            ));
        if (!("transactionLines" in pins)) {
          heldRefs[ref] = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (ref === incomingHeadRef) checkoutRefReason = ref === "refs/stash" ? "local-stash" : "local-commits";
          continue;
        }
        lines.push(...pins.transactionLines);
        if ("reflogFingerprint" in pins) tombstoneFingerprint = pins.reflogFingerprint;
        await opts.afterBranchPinsPrepared?.(ref);
      }
      if (ref.startsWith("refs/heads/")) {
        // Artifact/HEAD preparation is exclusive ref-transaction setup: no
        // ownership/reflog leaf runs inside these planners.
        const plan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => opts.manualResolution
          ? planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref,
              physicalBeforeOid: oldOid ?? null, afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
              extraTransactionLines: lines,
              ...(branchEpisode ? { episode: branchEpisode } : {}),
              ...(tombstoneFingerprint ? { expectedReflogFingerprint: tombstoneFingerprint } : {}),
            })
          : planBranchTransition({
              repoDir: opts.ctx.repoDir,
              binding: opts.branchProtocol!.binding,
              ref,
              beforeOid: oldOid ?? null,
              afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
              extraTransactionLines: lines,
              ...(branchEpisode ? { episode: branchEpisode } : {}),
              ...(tombstoneFingerprint ? { expectedReflogFingerprint: tombstoneFingerprint } : {}),
            }));
        const committed = await commitPlannedBranchTransition(plan, async () => {
          const lockedRefs = await readAllRefs(opts.ctx.repoDir);
          const lockedOwned = await branchesCheckedOutElsewhere(opts.ctx);
          if ((lockedRefs[ref] ?? null) !== (oldOid ?? null) || lockedOwned.has(ref)) throw new Error("branch changed at locked second proof");
          if (tombstoneAuthorized.has(ref) && oldOid) {
            const checked = checkTombstoneAttestation(opts.branchProtocol!.attestations, {
              incomingKey: gitIncomingKey(opts.incoming), ref, oid: oldOid,
              liveOid: oldOid, logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
            });
            if (checked.status !== "authorized") throw new Error(checked.reason);
          }
        }, opts.chainTimings);
        branchWitnesses[ref] = committed.witness;
        branchLockedProofs[ref] = committed.lockedProof;
        appliedRefs[ref] = plan.partial;
        if (tombstoneAuthorized.has(ref) && !newOid) {
          tombstonePrunedThisCycle = true;
          opts.log?.(`git-sync: pruned tombstoned branch ${ref} (was ${oldOid!.slice(0, 12)})`);
        }
      } else {
        if (oldOid && newOid) lines.push(`update ${ref} ${newOid} ${oldOid}`);
        else if (newOid) lines.push(`create ${ref} ${newOid}`);
        else lines.push(`delete ${ref} ${oldOid}`);
        await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => runUpdateRefTransaction(opts.ctx.repoDir, lines));
        const witness: SafeRefWitness = { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: oldOid ?? null, afterOid: newOid ?? null };
        safeRefWitnesses[ref] = witness;
        appliedRefs[ref] = witness;
      }
      if (opts.manualResolution) authoredRefChanges.push({ ref, ...(oldOid ? { before: oldOid } : {}), ...(newOid ? { after: newOid } : {}) });
      if (!opts.manualResolution && ref === "refs/stash" && newOid) {
        await addTimedMs(opts.chainTimings, "reflogMs", () => ensureStashReflog(opts.ctx.repoDir, newOid));
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      checkoutRefReason ??= /lock|busy|transaction/i.test(message) ? "git-busy" : "other";
    }
  }

  const configApplied = classifyOnly ? true : await opts.runConfig?.().catch(() => false) ?? true;
  for (const [ref, held] of Object.entries(heldRefs)) {
    if (indeterminateRefs.has(ref)) continue;
    blockers.push({
      provenance: "ref-plane",
      reason: held === "ownership" ? "worktree-ownership" : held,
      ref,
    });
  }
  if (checkoutRefReason && !checkoutRefReasonFromIndeterminate) blockers.push(blockerForReason(checkoutRefReason, "checkout", checkoutRefDetail));
  const checkoutWitnessDisposition = {
    heldRefs: new Set(Object.keys(heldRefs)),
    forcedRefs,
    ambiguousRefs,
  };
  return {
    appliedRefs,
    heldRefs,
    blockers,
    consultedReflogPaths: [...consultedReflogPaths].sort(),
    ...(Object.keys(branchWitnesses).length ? { branchWitnesses } : {}),
    ...(Object.keys(branchLockedProofs).length ? { branchLockedProofs } : {}),
    ...(Object.keys(safeRefWitnesses).length ? { safeRefWitnesses } : {}),
    ...(Object.keys(manualBranchTerminals).length ? { manualBranchTerminals } : {}),
    ...(tombstonePrunedThisCycle ? { tombstonePrunedThisCycle: true } : {}),
    configApplied,
    checkoutRefReason,
    checkoutRefDetail,
    checkoutWitnessDisposition,
    authoredRefChanges,
  };
}

export async function deriveBaseIndexProjection(
  opts: Pick<FollowOptions, "ctx" | "base" | "store" | "kek" | "record">,
  tmpDir: string,
  ignoreCache = false,
): Promise<string | undefined> {
  if (!indexArtifact(opts.base)) return undefined;
  if (!ignoreCache && opts.record?.idxProj) return opts.record.idxProj;
  const artifact = indexArtifact(opts.base);
  if (!artifact) return undefined;
  const raw = path.join(opts.ctx.gitDir, `.rbox-base-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await getGitArtifact(opts.store, opts.kek, artifact, raw, tmpDir);
    await clearIndexResolveUndo(opts.ctx.repoDir, raw);
    // `return await`, not `return`: the finally's rm would otherwise race the
    // projection's own read of `raw` (observed as a flaky false-indeterminate).
    return await indexIdentityV2(opts.ctx.repoDir, raw);
  } finally {
    await fs.rm(raw, { force: true });
  }
}

function expectedHead(section: GitSection): string {
  return section.head.endsWith("\n") ? section.head : `${section.head}\n`;
}

export async function followDivergedRepo(opts: FollowOptions): Promise<FollowResult> {
  const valid = validateGitSection(opts.incoming);
  const emptyProgress: FollowProgress = { appliedRefs: {}, heldRefs: {}, blockers: [], configApplied: true };
  if (!valid.ok) return deferResult(emptyProgress, "unsupported", `invalid git section: ${valid.reason}`);

  let staged: StagedIncoming;
  try {
    staged = await stageIncoming(opts);
  } catch (error) {
    const detail = `git artifact fetch/decrypt/import failed: ${String((error as Error)?.message ?? error)}`;
    return deferResult(emptyProgress, "artifact", detail);
  }

  try {
    // Imported scratch refs are transport scaffolding, never ownership roots.
    // Remove them before the trusted held-classification edge so cleanup cannot
    // make an otherwise stable attempt fingerprint self-invalidate.
    await staged.cleanupRefs();
    if (staged.candidateIndex) {
      try {
        const collision = await candidateIndexCollision(opts.workspaceRoot, opts.ctx.repoDir, staged.candidateIndex);
        if (collision) {
          opts.log?.(`git-sync WARNING ${opts.relPath}: incoming index has receiver-equivalent paths (${collision})`);
          return deferResult(emptyProgress, "unreadable", "incoming index has receiver path-equivalence collision");
        }
      } catch {
        return deferResult(emptyProgress, "unreadable", "incoming index receiver-equivalence check failed");
      }
    }
    const trustedFingerprint = await gitFingerprint(
      gitFingerprintRun("per-decision"), opts.workspaceRoot, opts.relPath, { includeIndexDependencies: true },
    ).catch(() => undefined);
    const effectiveIncomingIndexProjection = indexArtifact(opts.incoming)
      ? staged.candidateIndex
        ? await indexIdentityV2(opts.ctx.repoDir, staged.candidateIndex)
        : undefined
      : null;
    const liveBefore = await readLive(opts.ctx, opts.chainTimings);
    if (!liveBefore) return deferResult(emptyProgress, "unreadable", "git metadata could not be read");
    const baseProjection = opts.record?.idxProj ?? await addTimedMs(opts.chainTimings, "indexOpStateMs", () =>
      deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined));
    const effectiveBaseIndexProjection = indexArtifact(opts.base) ? baseProjection : null;
    const effective = effectiveRefs(opts.ctx, opts.incoming);
    const ownershipSection = { ...opts.incoming, refs: effective.refs };
    const roots = incomingOwnershipRoots(ownershipSection, { prefix: staged.incomingNs, opState: staged.opBytes });
    // R2-3 adjudication: safe-ref publication intentionally precedes the state
    // save. A crash/republication reaches the same design-LWW outcome; the
    // displaced value is incoming-owned, remains reachable, and the design's
    // idempotency clause covers the retry. Do not move this behind the checkout
    // journal absent a new normative design change.
    const refProgress = await publishRefPlane(opts, liveBefore, roots);
    const progress: FollowProgress = {
      appliedRefs: refProgress.appliedRefs,
      heldRefs: refProgress.heldRefs,
      blockers: refProgress.blockers,
      consultedReflogPaths: [
        ...(opts.ctx.kind === "dir" ? ["logs/refs/stash"] : []),
        ...(refProgress.consultedReflogPaths ?? []),
      ],
      ...(refProgress.branchWitnesses ? { branchWitnesses: refProgress.branchWitnesses } : {}),
      ...(refProgress.branchLockedProofs ? { branchLockedProofs: refProgress.branchLockedProofs } : {}),
      ...(refProgress.safeRefWitnesses ? { safeRefWitnesses: refProgress.safeRefWitnesses } : {}),
      ...(refProgress.manualBranchTerminals ? { manualBranchTerminals: refProgress.manualBranchTerminals } : {}),
      ...(refProgress.tombstonePrunedThisCycle ? { tombstonePrunedThisCycle: true } : {}),
      configApplied: refProgress.configApplied,
      ...(staged.incomingIndexProjection === undefined ? {} : { incomingIndexProjection: staged.incomingIndexProjection }),
      ...(opts.record?.idxProj || baseProjection === undefined ? {} : { derivedBaseIndexProjection: baseProjection }),
    };
    opts.crashAt?.("after-safe-refs");

    // The design kill switch disables oracle-authorized checkout only. Safe
    // refs/config and their partial markers remain active in both flag arms.
    // R2-7 adjudication preserves design 43 [v2,M2] here: exact =0 keeps the
    // legacy conflict-checkpoint disposition; only capability unsupported is
    // converted to a typed retryable defer below.
    if (!opts.followEnabled && !opts.manualResolution) return { status: "legacy", reason: "conflict", detail: "automatic checkout follow disabled", ...progressWithBlocker(progress, "conflict", "automatic checkout follow disabled") };
    const capabilitySupported = opts.capabilityProbe
      ? await opts.capabilityProbe(await git(opts.ctx.repoDir, ["--version"]))
      : await checkoutTransactionSupported(opts.ctx.repoDir);
    if (!capabilitySupported) return deferResult(progress, "unsupported", "git lacks prepared transactional symref-update");

    // Scratch refs and held incoming values are not durable roots. Authorize
    // checkout only from incoming refs that are already published (plus the
    // current ref value that this checkout transaction itself will publish).
    const incomingHeadRef = headBranchOf(opts.incoming.head);
    const durableIncomingRefs = Object.fromEntries(Object.entries(progress.appliedRefs)
      .map(([ref, value]) => [ref, appliedTerminalOid(value)] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"));
    if (incomingHeadRef && effective.refs[incomingHeadRef]) {
      durableIncomingRefs[incomingHeadRef] = effective.refs[incomingHeadRef]!;
    }
    const selfRootWitness = selectCheckoutSelfRootWitness({
      currentTip: liveBefore.currentTip,
      effectiveIncomingRefs: effective.refs,
      receiverRefs: liveBefore.refs,
      ...refProgress.checkoutWitnessDisposition,
    });
    if (selfRootWitness) durableIncomingRefs[selfRootWitness.ref] = selfRootWitness.oid;
    const checkoutRoots = incomingOwnershipRoots(
      { ...opts.incoming, refs: durableIncomingRefs },
      { prefix: staged.incomingNs, opState: staged.opBytes },
    );

    const first = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
      opts,
      live: liveBefore,
      incomingProjection: effectiveIncomingIndexProjection ?? undefined,
      baseProjection,
      roots: checkoutRoots,
      boundary: false,
      tombstonePrunedThisCycle: progress.tombstonePrunedThisCycle === true,
      checkoutRefReason: refProgress.checkoutRefReason,
      checkoutRefDetail: refProgress.checkoutRefDetail,
      heldRefs: progress.heldRefs,
    }));
    if (!first.safe) {
      const blockers = [...progress.blockers, ...first.blockers];
      await opts.afterHeldClassification?.({
        phase: "defer",
        trustedFingerprint,
        effectiveBaseIndexProjection,
        effectiveIncomingIndexProjection,
        blockers,
        reflogPaths: progress.consultedReflogPaths ?? [],
        progress: { ...progress, blockers },
      });
      return { status: "defer", reason: first.reason!, detail: first.detail ?? "checkout follow proof failed", ...progress, blockers };
    }

    let origHeadPreservation: OrigHeadPreservation | undefined;
    if (first.breadcrumbWaived) {
      try {
        const mismatch = first.breadcrumbMismatches.length === 1 ? first.breadcrumbMismatches[0] : undefined;
        const origHeadMismatch = mismatch?.rel === "ORIG_HEAD" ? { ...mismatch, rel: "ORIG_HEAD" as const } : undefined;
        if (!origHeadMismatch) throw new Error("unexpected breadcrumb waiver shape");
        origHeadPreservation = await preserveOrigHead(opts, origHeadMismatch);
      } catch (error) {
        opts.log?.(origHeadPreservationFailureLine(opts.relPath, error));
        return deferResult(progress, "local-operation", "operation state differs at ORIG_HEAD");
      }
    }

    const refUpdates: CheckoutRefUpdate[] = [];
    const postHeadRefUpdates: CheckoutRefUpdate[] = [];
    const postHeadExtraTransactionLines: string[] = [];
    const refReservations: Array<{ ref: string; expectedOid: string | null }> = [];
    const reserveRef = (ref: string, expectedOid: string | null): void => {
      const existing = refReservations.find((reservation) => reservation.ref === ref);
      if (existing && existing.expectedOid !== expectedOid) throw new Error(`contradictory ref reservation for ${ref}`);
      if (!existing) refReservations.push({ ref, expectedOid });
    };
    if (selfRootWitness) reserveRef(selfRootWitness.ref, selfRootWitness.oid);
    const extraTransactionLines: string[] = [];
    const expectedRefs: Record<string, string> = {};
    let checkoutBranchPlan: PlannedBranchTransition | undefined;
    let checkoutBranchPlanIsPostHead = false;
    let checkoutBranchReflogFingerprint: string | undefined;
    let checkoutBranchLockedProof: LockedBranchProof | undefined;
    if (origHeadPreservation?.transactionLine) extraTransactionLines.push(origHeadPreservation.transactionLine);
    if (liveBefore.currentRef) {
      const currentRef = liveBefore.currentRef;
      const oldOid = liveBefore.currentTip;
      const newOid = effective.refs[currentRef];
      let pinLines: string[] = [];
      if (oldOid && (!newOid || (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid]))).status !== "owned")) {
        progress.consultedReflogPaths = [...new Set([
          ...(progress.consultedReflogPaths ?? []),
          `logs/${currentRef}`,
        ])].sort();
        const durableNow = { ...liveBefore.refs };
        delete durableNow[currentRef];
        const pins = await addTimedMs(opts.chainTimings, "reflogMs", () => prepareDisplacementPins(
          opts.ctx.repoDir,
          currentRef,
          oldOid,
          [...Object.values(durableNow), ...(newOid ? [newOid] : [])],
          humanDisplacementOrigin(currentRef, opts.incoming),
        ));
        if (pins.status === "indeterminate") {
          return deferResult(progress, "unreadable", `current-ref reflog reachability ${pins.marker}`);
        }
        pinLines = pins.transactionLines;
        checkoutBranchReflogFingerprint = pins.reflogFingerprint;
      }
      if (oldOid && ((newOid && oldOid !== newOid) || (!newOid && effective.deleteAbsent))) {
        if (!opts.branchProtocol) return deferResult(progress, "artifact", "checked-out branch transition lacks lineage authority");
        checkoutBranchPlan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => opts.manualResolution
          ? planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref: currentRef,
              physicalBeforeOid: oldOid, afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
              extraTransactionLines: pinLines,
              ...(checkoutBranchReflogFingerprint ? { expectedReflogFingerprint: checkoutBranchReflogFingerprint } : {}),
              reserveHead: false,
            })
          : planBranchTransition({
              repoDir: opts.ctx.repoDir,
              binding: opts.branchProtocol!.binding,
              ref: currentRef,
              beforeOid: oldOid,
              afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
              extraTransactionLines: pinLines,
              ...(checkoutBranchReflogFingerprint ? { expectedReflogFingerprint: checkoutBranchReflogFingerprint } : {}),
              reserveHead: false,
            }));
        checkoutBranchPlanIsPostHead = incomingHeadRef !== liveBefore.currentRef;
        if (checkoutBranchPlanIsPostHead) postHeadExtraTransactionLines.push(...checkoutBranchPlan.lines);
        else extraTransactionLines.push(...checkoutBranchPlan.lines);
        if (newOid) expectedRefs[liveBefore.currentRef] = newOid;
      }
    }
    const head = incomingHeadRef
      ? { kind: "symbolic" as const, newTarget: incomingHeadRef, ...(liveBefore.currentRef ? { oldTarget: liveBefore.currentRef } : { oldOid: liveBefore.currentTip }) }
      : { kind: "detached" as const, newOid: opts.incoming.head.trim(), oldOid: liveBefore.currentTip! };
    if (incomingHeadRef && incomingHeadRef !== liveBefore.currentRef) {
      const targetOid = effective.refs[incomingHeadRef];
      if (!targetOid) return deferResult(progress, "unsupported", "incoming HEAD branch is filtered or absent");
      reserveRef(incomingHeadRef, targetOid);
    }

    const postProgress: FollowProgress = {
      ...progress,
      appliedRefs: { ...progress.appliedRefs },
      branchWitnesses: { ...(progress.branchWitnesses ?? {}) },
      branchLockedProofs: { ...(progress.branchLockedProofs ?? {}) },
      manualBranchTerminals: { ...(progress.manualBranchTerminals ?? {}) },
    };
    if (checkoutBranchPlan) {
      postProgress.appliedRefs[checkoutBranchPlan.ref] = checkoutBranchPlan.partial;
      postProgress.branchWitnesses![checkoutBranchPlan.ref] = checkoutBranchPlan.witness;
    }
    // §126/§130 second-proof reservations cover every ref-plane commit that is
    // not already held by the checkout transaction itself. Absence is an exact
    // locked fact, accompanied by its A/Z target; present branch progress also
    // reserves P and every mandatory K until the state composer consumes it.
    for (const [ref, witness] of Object.entries(postProgress.safeRefWitnesses ?? {})) {
      reserveRef(ref, witness.afterOid);
    }
    for (const [ref, witness] of Object.entries(postProgress.branchWitnesses ?? {})) {
      if (ref === checkoutBranchPlan?.ref) continue;
      reserveRef(ref, witness.kind === "present" ? witness.nextOid : null);
      reserveRef(witness.artifactRef, witness.artifactOid);
      if (witness.kind === "present") {
        if (witness.priorOid) reserveRef(
          basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "prior"),
          witness.priorOid,
        );
        reserveRef(
          basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "next"),
          witness.nextOid,
        );
      }
    }
    if (incomingHeadRef && effective.refs[incomingHeadRef] && incomingHeadRef !== checkoutBranchPlan?.ref) {
      postProgress.appliedRefs[incomingHeadRef] = { kind: "direct", oid: effective.refs[incomingHeadRef]! };
    }
    if (liveBefore.currentRef && incomingHeadRef === liveBefore.currentRef && effective.refs[liveBefore.currentRef]
      && liveBefore.currentRef !== checkoutBranchPlan?.ref) {
      postProgress.appliedRefs[liveBefore.currentRef] = { kind: "direct", oid: effective.refs[liveBefore.currentRef]! };
      const logicalBefore = opts.branchProtocol?.logicalBaseRefs[liveBefore.currentRef] ?? null;
      if (opts.manualResolution && logicalBefore !== null && logicalBefore !== effective.refs[liveBefore.currentRef]) {
        postProgress.manualBranchTerminals![liveBefore.currentRef] = {
          beforeBaseOid: logicalBefore,
          afterOid: effective.refs[liveBefore.currentRef]!,
        };
      }
    }

    const oldOp = Object.fromEntries(Object.keys(liveBefore.opState).map((rel) => [rel, true as const]));
    const newOp = sectionOpState(opts.incoming);
    const intended = await opts.makeIntended(postProgress);
    const journalId = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const journal: CheckoutJournal<FollowIntended> = {
      journalId,
      phase: "intent",
      incomingKey: gitIncomingKey(opts.incoming),
      incomingSection: opts.incoming,
      old: {
        ...(liveBefore.currentRef ? { currentRefName: liveBefore.currentRef, currentRefOid: liveBefore.currentTip } : {}),
        headContent: liveBefore.headContent,
        indexPresent: liveBefore.indexPresent,
        opState: oldOp,
      },
      expectedNew: {
        opState: newOp,
        refs: expectedRefs,
        head: expectedHead(opts.incoming),
        ...(checkoutBranchPlan ? { branchInverses: [{
          ref: checkoutBranchPlan.ref,
          beforeOid: checkoutBranchPlan.beforeOid,
          afterOid: checkoutBranchPlan.afterOid,
          lines: checkoutBranchPlan.inverseLines,
        }] } : {}),
        ...(refReservations.length ? { reservedRefs: Object.fromEntries(refReservations.map(({ ref, expectedOid }) => [ref, expectedOid])) } : {}),
      },
      binding: opts.binding,
      createdFresh: false,
      intended,
      ...(opts.manualResolution ? { episode: { verb: "take-theirs" as const, snapshotId: opts.manualResolution.snapshotId } } : {}),
    };
    await addTimedMs(opts.chainTimings, "indexOpStateMs", () => writeCheckoutJournal(opts.workspaceRoot, opts.relPath, journal, {
      indexPath: path.join(opts.ctx.gitDir, "index"),
      gitDir: opts.ctx.gitDir,
    }));
    opts.crashAt?.("after-journal-write");

    let boundaryFailure: Pick<CheckoutClassification, "safe" | "reason" | "detail" | "blockers"> | undefined;
    const noteBoundaryFailure = (reason: GitDeferralReason, detail: string): void => {
      const chosen = firstReason(new Set([...(boundaryFailure?.reason ? [boundaryFailure.reason] : []), reason]));
      if (!boundaryFailure || chosen === reason) boundaryFailure = {
        safe: false,
        reason,
        detail,
        blockers: [blockerForReason(reason, "boundary", detail)],
      };
    };
    const result = await commitCheckout(opts.ctx, {
      ...(staged.candidateIndex ? { candidateIndexPath: staged.candidateIndex } : { removeIndex: true }),
      refUpdates,
      postHeadRefUpdates,
      postHeadExtraTransactionLines,
      ...(checkoutBranchPlanIsPostHead && checkoutBranchPlan?.reflogMessage
        ? { postHeadReflogMessage: checkoutBranchPlan.reflogMessage } : {}),
      refReservations,
      head,
      extraTransactionLines,
      ...(!checkoutBranchPlanIsPostHead && checkoutBranchPlan?.reflogMessage
        ? { reflogMessage: checkoutBranchPlan.reflogMessage } : {}),
      plannedGraphRoots: [...roots, ...(origHeadPreservation?.recoveryOid ? [origHeadPreservation.recoveryOid] : [])],
      opState: staged.opState,
      ...(origHeadPreservation ? { origHeadLock: { journalId, expectedOldBytes: origHeadPreservation.expectedOldBytes } } : {}),
      ...(origHeadPreservation?.malformedRawBytes ? { malformedOrigHeadPreserved: true as const } : {}),
    }, {
      capabilityProbe: opts.capabilityProbe,
      capabilitySupported: true,
      journal: { workspaceRoot: opts.workspaceRoot, relPath: opts.relPath, value: journal },
      mutationBoundary: opts.mutationBoundary,
      secondProof: async () => {
        const freshCtx = await repoCtx(opts.ctx.repoDir);
        const freshBinding = freshCtx ? await checkoutJournalBinding(opts.binding.stream, opts.binding.stateNonce, freshCtx) : undefined;
        const sameIncarnation = freshCtx !== undefined && freshBinding !== undefined
          && freshBinding.gitDirReal === opts.binding.gitDirReal
          && freshBinding.commonDirReal === opts.binding.commonDirReal
          && freshBinding.worktreeId === opts.binding.worktreeId
          && freshCtx.kind === opts.ctx.kind;
        const live = sameIncarnation ? await readLive(freshCtx, opts.chainTimings) : undefined;
        if (opts.manualResolution) {
          try {
            if (!(await opts.manualResolution.secondProof(refProgress.authoredRefChanges))) {
              noteBoundaryFailure("other", "confirmed snapshot changed at checkout boundary");
              return false;
            }
          } catch {
            noteBoundaryFailure("unreadable", "confirmed snapshot could not be revalidated at checkout boundary");
            return false;
          }
        }
        const proof = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
          opts,
          live,
          incomingProjection: staged.incomingIndexProjection,
          baseProjection,
          roots: checkoutRoots,
          boundary: true,
          boundaryChanged: !sameIncarnation,
          tombstonePrunedThisCycle: progress.tombstonePrunedThisCycle === true,
          checkoutRefReason: refProgress.checkoutRefReason,
          checkoutRefDetail: refProgress.checkoutRefDetail,
          heldRefs: progress.heldRefs,
        }));
        if (!proof.safe) boundaryFailure = proof;
        if (!opts.manualResolution && proof.breadcrumbMismatches.length > 0 && !origHeadPreservation) {
          noteBoundaryFailure("local-operation", "operation state differs at ORIG_HEAD");
          return false;
        }
        if (origHeadPreservation && (!proof.breadcrumbWaived || proof.breadcrumbMismatches.length !== 1 || proof.breadcrumbMismatches[0]?.rel !== "ORIG_HEAD")) {
          noteBoundaryFailure("local-operation", "operation state differs at ORIG_HEAD");
          return false;
        }
        if (!sameIncarnation) { noteBoundaryFailure("unreadable", "repository incarnation changed at checkout boundary"); return false; }
        if (!live) { noteBoundaryFailure("unreadable", "git metadata became unreadable"); return false; }
        const boundaryOwned = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
        if (selfRootWitness) {
          const boundaryAmbiguousRefs = new Set([
            ...refProgress.checkoutWitnessDisposition.ambiguousRefs,
            ...receiverEquivalentCollisionNames([
              ...Object.keys(effective.refs),
              ...Object.keys(live.refs),
              ...boundaryOwned.keys(),
            ]),
          ]);
          const boundaryWitness = selectCheckoutSelfRootWitness({
            currentTip: live.currentTip,
            effectiveIncomingRefs: effective.refs,
            receiverRefs: live.refs,
            heldRefs: refProgress.checkoutWitnessDisposition.heldRefs,
            forcedRefs: refProgress.checkoutWitnessDisposition.forcedRefs,
            ambiguousRefs: boundaryAmbiguousRefs,
            requiredRef: selfRootWitness.ref,
          });
          if (!boundaryWitness || boundaryWitness.oid !== selfRootWitness.oid) {
            noteBoundaryFailure("local-commits", `checkout self-root witness changed at ${selfRootWitness.ref}`);
            return false;
          }
        }
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          const terminal = appliedTerminalOid(expected);
          if (boundaryOwned.has(ref) && (liveBefore.refs[ref] ?? null) !== (terminal ?? null)) {
            noteBoundaryFailure("worktree-ownership", `worktree ownership changed for ${ref}`);
            return false;
          }
        }
        if (incomingHeadRef && boundaryOwned.has(incomingHeadRef)) {
          noteBoundaryFailure("worktree-ownership", "incoming checkout branch became sibling-owned");
          return false;
        }
        for (const bad of opts.ctx.kind === "dir" ? ["modules", "objects/info/alternates"] : ["objects/info/alternates"]) {
          const root = opts.ctx.kind === "dir" ? opts.ctx.gitDir : opts.ctx.commonDir;
          if (await exists(path.join(root, bad))) {
            noteBoundaryFailure("unsupported", `repository structure changed at ${bad}`);
            return false;
          }
        }
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          const terminal = appliedTerminalOid(expected);
          if (terminal !== undefined && (live.refs[ref] ?? null) !== terminal) {
            noteBoundaryFailure("local-commits", `published ref changed at ${ref}`);
            return false;
          }
        }
        for (const ref of Object.keys(progress.heldRefs)) if (live.refs[ref] !== liveBefore.refs[ref]) {
          noteBoundaryFailure("local-commits", `held ref changed at ${ref}`);
          return false;
        }
        if (checkoutBranchPlan && !checkoutBranchPlanIsPostHead) {
          if (checkoutBranchReflogFingerprint) {
            const fingerprint = await addTimedMs(opts.chainTimings, "reflogMs", () =>
              readRefReflogFingerprint(opts.ctx.repoDir, checkoutBranchPlan!.ref));
            if (fingerprint.sha256 !== checkoutBranchReflogFingerprint) {
              noteBoundaryFailure("local-commits", `branch reflog changed at ${checkoutBranchPlan.ref}`);
              return false;
            }
          }
          checkoutBranchLockedProof = {
            liveOid: checkoutBranchPlan.afterOid,
            witness: checkoutBranchPlan.witness,
            ...(checkoutBranchPlan.witness.kind === "present" ? { reflogEpisode: checkoutBranchPlan.witness.episode } : {}),
            artifactsClear: true,
            ownershipStable: true,
            reflogStable: true,
            currentRef: incomingHeadRef === checkoutBranchPlan.ref,
            siblingOwned: false,
          };
        }
        return proof.safe;
      },
      ...(checkoutBranchPlanIsPostHead && checkoutBranchPlan ? { postHeadSecondProof: async () => {
        const [refs, owned, headContent] = await Promise.all([
          readAllRefs(opts.ctx.repoDir),
          addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx)),
          readHead(opts.ctx),
        ]);
        if ((refs[checkoutBranchPlan!.ref] ?? null) !== checkoutBranchPlan!.beforeOid
          || owned.has(checkoutBranchPlan!.ref)
          || headBranchOf(headContent) === checkoutBranchPlan!.ref) return false;
        if (checkoutBranchReflogFingerprint) {
          const fingerprint = await addTimedMs(opts.chainTimings, "reflogMs", () =>
            readRefReflogFingerprint(opts.ctx.repoDir, checkoutBranchPlan!.ref));
          if (fingerprint.sha256 !== checkoutBranchReflogFingerprint) return false;
        }
        checkoutBranchLockedProof = {
          liveOid: checkoutBranchPlan!.afterOid,
          witness: checkoutBranchPlan!.witness,
          ...(checkoutBranchPlan!.witness.kind === "present" ? { reflogEpisode: checkoutBranchPlan!.witness.episode } : {}),
          artifactsClear: true,
          ownershipStable: true,
          reflogStable: true,
          currentRef: false,
          siblingOwned: false,
        };
        return true;
      } } : {}),
      crashAt: (point) => opts.crashAt?.(point),
      chainTimings: opts.chainTimings,
    });
    if (result.status !== "committed") {
      // A dead prepared child or post-symref HEAD arbitration can leave locks
      // and/or committed checkout fields that only intent recovery may touch.
      if (result.status !== "defer" || !result.journalIntact) await clearCheckoutJournal(opts.workspaceRoot, opts.relPath);
      const reason: GitDeferralReason = result.status === "unsupported" ? "unsupported"
        : /became busy/.test(result.reason) ? "git-busy"
        : /connectivity/.test(result.reason) ? "artifact"
        : result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY ? "local-operation"
        : boundaryFailure?.reason ?? "other";
      return {
        status: "defer",
        reason,
        detail: result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY ? "operation state differs at ORIG_HEAD" : boundaryFailure?.detail ?? result.reason,
        ...progress,
        blockers: [
          ...progress.blockers,
          ...(boundaryFailure?.blockers ?? [blockerForReason(reason, "boundary", result.reason)]),
        ],
      };
    }
    if (checkoutBranchPlan) {
      if (!checkoutBranchLockedProof) throw new Error("checkout branch committed without locked proof receipt");
      postProgress.branchLockedProofs![checkoutBranchPlan.ref] = checkoutBranchLockedProof;
      journal.intended = await opts.makeIntended(postProgress);
      await updateCheckoutJournal(opts.workspaceRoot, opts.relPath, journal);
    }
    await markCheckoutJournalPublished(opts.workspaceRoot, opts.relPath);
    if (opts.manualResolution && effective.refs["refs/stash"]) await ensureStashReflog(opts.ctx.repoDir, effective.refs["refs/stash"]!);
    opts.crashAt?.("after-published-flip");
    if (origHeadPreservation) {
      if (origHeadPreservation.recoveryRef && origHeadPreservation.discriminator) {
        await pruneOrigHeadRecoveryRefs(opts.ctx.repoDir, origHeadPreservation.discriminator, origHeadPreservation.recoveryRef).catch(() => {});
      }
      opts.log?.(`git-sync: adopted stale ORIG_HEAD breadcrumb for ${opts.relPath} (old value preserved at ${origHeadPreservation.recoveryLocation})`);
    }
    if (opts.afterHeldClassification && !opts.manualResolution) {
      const finalTrusted = await gitFingerprint(
        gitFingerprintRun("per-decision"), opts.workspaceRoot, opts.relPath, { includeIndexDependencies: true },
      ).catch(() => undefined);
      const finalIncomingProjection = indexArtifact(opts.incoming)
        ? staged.candidateIndex
          ? await indexIdentityV2(opts.ctx.repoDir, staged.candidateIndex)
          : undefined
        : null;
      const finalBaseProjection = indexArtifact(opts.base)
        ? opts.record?.idxProj ?? await addTimedMs(opts.chainTimings, "indexOpStateMs", () =>
          deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined))
        : null;
      const finalLive = await readLive(opts.ctx, opts.chainTimings);
      if (finalLive) {
        const finalRef = await publishRefPlane(opts, finalLive, roots, true);
        const finalCheckout = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
          opts,
          live: finalLive,
          incomingProjection: finalIncomingProjection ?? undefined,
          baseProjection: finalBaseProjection ?? undefined,
          roots: checkoutRoots,
          boundary: false,
          tombstonePrunedThisCycle: postProgress.tombstonePrunedThisCycle === true,
          checkoutRefReason: finalRef.checkoutRefReason,
          checkoutRefDetail: finalRef.checkoutRefDetail,
          heldRefs: finalRef.heldRefs,
        }));
        const blockers = [...finalRef.blockers, ...finalCheckout.blockers];
        const finalReflogPaths = [...new Set([
          ...(opts.ctx.kind === "dir" ? ["logs/refs/stash"] : []),
          ...(finalRef.consultedReflogPaths ?? []),
        ])].sort();
        const finalProgress: FollowProgress = {
          ...postProgress,
          heldRefs: finalRef.heldRefs,
          blockers,
          consultedReflogPaths: finalReflogPaths,
        };
        await opts.afterHeldClassification({
          phase: "followed",
          trustedFingerprint: finalTrusted,
          effectiveBaseIndexProjection: finalBaseProjection,
          effectiveIncomingIndexProjection: finalIncomingProjection,
          blockers,
          reflogPaths: finalReflogPaths,
          progress: finalProgress,
        });
      }
    }
    return { status: "followed", ...postProgress };
  } finally {
    await staged.cleanup();
  }
}
