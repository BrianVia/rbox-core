import { hashBytes, readRepoIdentityV1, repositoryIdentityHash, type GitSection } from "../../engine/index.js";
import { canonicalString } from "../../engine/e2ee/index.js";
import { readRefReflogFingerprint } from "../../engine/git/keep-pins.js";
import { listWorktrees } from "../../engine/git/shared.js";
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadRawState,
  repoRecordsForState,
  type GitHeldAttempt,
  type GitPartialApply,
  type RepoRecord,
  type RepoRecordInput,
  type SyncState,
  type TypedBlocker,
} from "../config.js";
import { carryRepoBaseProof, recordOriginLineage } from "./base-composer.js";
import type { ComposeRepoBaseResult, RepoBaseLockedProof } from "./base-composer.js";
import {
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  GIT_FINGERPRINT_VERSION,
  gitFingerprint,
  gitFingerprintRun,
  type GitFingerprint,
} from "./fingerprint.js";

const HELD_SKIP_SAFETY_FLOOR_MS = 60 * 60 * 1000;

export const gitHeldSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_HELD_SKIP !== "0";

export const gitOwnershipHeldSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_OWNERSHIP_HELD_SKIP !== "0";

export const gitOwnershipNoEscalateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_OWNERSHIP_NO_ESCALATE !== "0";

export function sortedTypedBlockers(blockers: readonly TypedBlocker[]): TypedBlocker[] {
  const byKey = new Map<string, TypedBlocker>();
  for (const blocker of blockers) byKey.set(canonicalString(blocker), blocker);
  return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, blocker]) => ({ ...blocker }));
}

export function heldBlockersAllowSkip(
  blockers: readonly TypedBlocker[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return blockers.length > 0 && blockers.every((blocker) =>
    blocker.reason === "local-commits"
      || blocker.reason === "local-stash"
      || blocker.reason === "local-index"
      || blocker.reason === "local-operation"
      || blocker.reason === "deletion-pending"
      || (blocker.reason === "worktree-ownership" && gitOwnershipHeldSkipEnabled(env)));
}

export function ownershipBlockersArePerRefOnly(blockers: readonly TypedBlocker[]): boolean {
  return blockers.length > 0 && blockers.every((blocker) =>
    blocker.provenance === "ref-plane" && blocker.reason === "worktree-ownership");
}

/**
 * Convert a pending BASE-composer disposition into durable typed blockers while
 * dropping only the synthetic blockers caused by the same allowlisted ref holds.
 * The mapping is deliberately provenance/ref based: human text is never authority.
 */
export function blockersAfterComposer(input: {
  classification: readonly TypedBlocker[];
  disposition: ComposeRepoBaseResult["disposition"];
  holds: readonly ComposeRepoBaseResult["holds"][number][];
  checkoutComplete: RepoBaseLockedProof["checkoutComplete"];
}): TypedBlocker[] {
  const classification = sortedTypedBlockers(input.classification);
  if (input.disposition !== "pending") return classification;

  // Causal normalization is independent of rollout eligibility. In particular,
  // disabling ownership held-skip must not reintroduce whole-repo escalation.
  const causallyClassifiable = classification.length > 0 && classification.every((blocker) =>
    blocker.reason === "local-commits"
      || blocker.reason === "local-stash"
      || blocker.reason === "local-index"
      || blocker.reason === "deletion-pending"
      || blocker.reason === "worktree-ownership");
  const causallyMapped = (hold: ComposeRepoBaseResult["holds"][number]): boolean =>
    classification.some((blocker) => blocker.provenance === "ref-plane"
      && blocker.ref === hold.ref
      && ((blocker.reason === "local-commits" && hold.code === "missing-branch-proof")
        || (blocker.reason === "deletion-pending" && hold.code === "missing-branch-proof")
        || (blocker.reason === "local-stash" && hold.code === "missing-safe-ref-proof")
        || (blocker.reason === "worktree-ownership" && hold.code === "missing-branch-proof")));
  const unmatchedHolds = causallyClassifiable && input.checkoutComplete
    ? input.holds.filter((hold) => !causallyMapped(hold))
    : [...input.holds];
  const composer: TypedBlocker[] = unmatchedHolds.map((hold) => ({
    provenance: "composer",
    reason: "artifact",
    ref: hold.ref,
    code: hold.code,
    detail: `BASE composer hold ${hold.code} at ${hold.ref}`,
  }));
  if (!input.checkoutComplete) {
    composer.push({
      provenance: "composer",
      reason: "artifact",
      code: "checkout-incomplete",
      detail: "BASE composer checkout proof is incomplete",
    });
  }
  // A pending disposition with no concrete hold and no incomplete-checkout
  // evidence must remain non-vacuously blocking rather than gaining eligibility.
  if (composer.length === 0 && classification.length === 0) {
    composer.push({
      provenance: "composer",
      reason: "artifact",
      detail: "BASE composer retained an unexplained pending disposition",
    });
  }
  return sortedTypedBlockers([...classification, ...composer]);
}

export interface HeldInputObservation {
  incomingKey: string;
  effectiveBaseIndexProjection: string | null;
  effectiveIncomingIndexProjection: string | null;
  incomingIndexArtifactDescriptor: string;
  localFingerprint: string;
  fingerprintVersion: string;
  worktreeRegistryDigest: string;
  maxFingerprintTimestampMs: number;
  reflogs: Array<{ path: string; digest: string }>;
  repoIdentity: string;
  stateNonce: string;
  baseOriginsHash: string;
  partialDisposition: string;
}

export interface ObserveHeldInputsOptions {
  root: string;
  relPath: string;
  incomingKey: string;
  incoming: GitSection;
  record?: RepoRecord;
  /** Explicit post-composer values used when the completed outcome is not saved yet. */
  boundBase?: GitSection;
  boundOrigins?: RepoRecord["branchBaseOrigins"];
  partial?: GitPartialApply;
  stateNonce: string;
  /** The exact projections consumed by the classifier. Undefined is
   * indeterminate; absence must be represented explicitly as null. */
  effectiveBaseIndexProjection: string | null | undefined;
  effectiveIncomingIndexProjection: string | null | undefined;
  /** When supplied, this is the trusted edge immediately before classification. */
  trustedFingerprint?: GitFingerprint;
  /** Exact paths consulted by the completed follow, or by the stored attempt on recheck. */
  reflogPaths: readonly string[];
  /** When recording a completed classification, bind it to the registry observed
   * before the follow began. A change anywhere in the follow refuses the attempt. */
  expectedWorktreeRegistryDigest?: string;
  /** Test seam for a registry mutation between the bracket reads. */
  afterWorktreeRegistryRead?: () => void | Promise<void>;
}

export function incomingIndexArtifactDescriptor(incoming: GitSection): string {
  return canonicalString(incoming.indexSha === undefined ? null : {
    indexSha: incoming.indexSha,
    indexEncSha: incoming.indexEncSha ?? null,
    indexCipherSize: incoming.indexCipherSize ?? null,
    indexComp: incoming.indexComp ?? null,
    indexPayloadSha: incoming.indexPayloadSha ?? null,
  });
}

export async function readWorktreeRegistryDigest(repoDir: string): Promise<string | undefined> {
  const worktrees = await listWorktrees(repoDir);
  if (worktrees.length === 0) return undefined;
  return hashBytes(Buffer.from(canonicalString(
    worktrees
      .map((entry) => [entry.path, entry.branch ?? null, entry.prunable] as const)
      .sort(([aPath, aBranch, aPrunable], [bPath, bBranch, bPrunable]) =>
        canonicalString([aPath, aBranch, aPrunable]).localeCompare(canonicalString([bPath, bBranch, bPrunable]))),
  )));
}

/** Stable before/after bracket over every held-skip input. Any read/race fails open. */
export async function observeHeldInputs(opts: ObserveHeldInputsOptions): Promise<HeldInputObservation | undefined> {
  try {
    if (opts.effectiveBaseIndexProjection === undefined || opts.effectiveIncomingIndexProjection === undefined) return undefined;
    const before = opts.trustedFingerprint
      ?? await gitFingerprint(gitFingerprintRun("per-decision"), opts.root, opts.relPath, { includeIndexDependencies: true });
    if (!before.dependenciesComplete) return undefined;
    const ctx = before.diskCtx;
    if (!ctx) return undefined;
    const worktreeRegistryBefore = await readWorktreeRegistryDigest(ctx.repoDir);
    if (!worktreeRegistryBefore
      || (opts.expectedWorktreeRegistryDigest !== undefined
        && worktreeRegistryBefore !== opts.expectedWorktreeRegistryDigest)) return undefined;
    await opts.afterWorktreeRegistryRead?.();
    const reflogs: Array<{ path: string; digest: string }> = [];
    for (const reflogPath of [...new Set(opts.reflogPaths)].sort()) {
      if (!reflogPath.startsWith("logs/refs/") || reflogPath.includes("..") || reflogPath.includes("\0")) return undefined;
      const ref = reflogPath.slice("logs/".length);
      const read = await readRefReflogFingerprint(ctx.repoDir, ref);
      reflogs.push({ path: reflogPath, digest: read.sha256 });
    }
    const identity = await readRepoIdentityV1(opts.relPath, ctx.kind, {
      worktreeId: ctx.repoDir,
      gitDirReal: ctx.gitDir,
      commonDirReal: ctx.commonDir,
    });
    const baseOriginsHash = hashBytes(Buffer.from(canonicalString([
      opts.boundBase ?? opts.record?.base ?? null,
      opts.boundOrigins ?? opts.record?.branchBaseOrigins ?? null,
    ])));
    const partialDisposition = canonicalString(opts.partial ?? null);
    const after = await gitFingerprint(gitFingerprintRun("per-decision"), opts.root, opts.relPath, { includeIndexDependencies: true });
    const worktreeRegistryDigest = await readWorktreeRegistryDigest(ctx.repoDir);
    if (!after.dependenciesComplete || before.hash !== after.hash || before.diskCtx?.kind !== after.diskCtx?.kind
      || before.diskCtx?.gitDir !== after.diskCtx?.gitDir
      || before.diskCtx?.commonDir !== after.diskCtx?.commonDir
      || !worktreeRegistryDigest
      || worktreeRegistryBefore !== worktreeRegistryDigest) return undefined;
    return {
      incomingKey: opts.incomingKey,
      effectiveBaseIndexProjection: opts.effectiveBaseIndexProjection,
      effectiveIncomingIndexProjection: opts.effectiveIncomingIndexProjection,
      incomingIndexArtifactDescriptor: incomingIndexArtifactDescriptor(opts.incoming),
      localFingerprint: after.hash,
      fingerprintVersion: GIT_FINGERPRINT_VERSION,
      worktreeRegistryDigest,
      maxFingerprintTimestampMs: Math.max(before.maxTsMs, after.maxTsMs),
      reflogs,
      repoIdentity: repositoryIdentityHash(identity),
      stateNonce: opts.stateNonce,
      baseOriginsHash,
      partialDisposition,
    };
  } catch {
    return undefined;
  }
}

function attemptInputs(attempt: GitHeldAttempt) {
  const { blockers: _blockers, at: _at, ...inputs } = attempt;
  return inputs;
}

export function heldAttemptMatches(
  attempt: GitHeldAttempt,
  observation: HeldInputObservation,
  nowMs = Date.now(),
): boolean {
  if (attempt.fingerprintVersion !== GIT_FINGERPRINT_VERSION) return false;
  if (typeof attempt.worktreeRegistryDigest !== "string") return false;
  const writtenAt = Date.parse(attempt.at);
  if (!Number.isFinite(writtenAt) || writtenAt > nowMs) return false;
  if (observation.maxFingerprintTimestampMs >= nowMs - GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS) return false;
  const { maxFingerprintTimestampMs: _max, ...observedInputs } = observation;
  return canonicalString(attemptInputs(attempt)) === canonicalString(observedInputs);
}

export function heldAttemptFloorElapsed(attempt: GitHeldAttempt, nowMs = Date.now()): boolean {
  const at = Date.parse(attempt.at);
  return !Number.isFinite(at) || nowMs - at > HELD_SKIP_SAFETY_FLOOR_MS;
}

export function createHeldAttempt(
  observation: HeldInputObservation,
  blockers: readonly TypedBlocker[],
  at = new Date().toISOString(),
): GitHeldAttempt {
  const { maxFingerprintTimestampMs: _max, ...inputs } = observation;
  return { ...inputs, blockers: sortedTypedBlockers(blockers), at };
}

export function sameHeldOutcome(a: readonly TypedBlocker[], b: readonly TypedBlocker[]): boolean {
  return canonicalString(sortedTypedBlockers(a)) === canonicalString(sortedTypedBlockers(b));
}

/** Rebind completed held attempts after all correctness-required P/K settlements.
 * One generation-CAS packet updates every independent repo entry, then reloads once. */
export async function rebindHeldAttemptsAfterSettlement(input: {
  root: string;
  state: SyncState;
  attempts: ReadonlyArray<{ relPath: string; attempt: GitHeldAttempt }>;
}): Promise<SyncState> {
  const records = repoRecordsForState(input.state);
  const repos = [] as Array<{
    relPath: string;
    expectedRepoGen: number;
    newRecord: RepoRecordInput;
    baseProof: ReturnType<typeof carryRepoBaseProof>;
  }>;
  for (const { relPath, attempt } of input.attempts) {
    const record = records[relPath];
    const incoming = record?.pending;
    if (!record || !incoming) continue;
    const observed = attempt.worktreeRegistryDigest
      ? await observeHeldInputs({
          root: input.root,
          relPath,
          incomingKey: attempt.incomingKey,
          incoming,
          record,
          partial: record.partial,
          stateNonce: expectedStateNonce(input.state),
          effectiveBaseIndexProjection: record.idxProj
            ?? (record.base?.indexSha === undefined ? null : undefined),
          effectiveIncomingIndexProjection: incomingIndexArtifactDescriptor(incoming) === attempt.incomingIndexArtifactDescriptor
            ? attempt.effectiveIncomingIndexProjection
            : undefined,
          reflogPaths: attempt.reflogs.map((entry) => entry.path),
          expectedWorktreeRegistryDigest: attempt.worktreeRegistryDigest,
        })
      : undefined;
    const { repoGen, attempt: _attempt, ...recordWithoutAttempt } = record;
    const newRecord: RepoRecordInput = observed
      ? { ...recordWithoutAttempt, attempt: createHeldAttempt(observed, attempt.blockers, attempt.at) }
      : recordWithoutAttempt;
    const lineage = recordOriginLineage(record.branchBaseOrigins) ?? "legacy-untrusted";
    repos.push({
      relPath,
      expectedRepoGen: repoGen,
      newRecord,
      baseProof: carryRepoBaseProof(lineage),
    });
  }
  if (repos.length === 0) return input.state;
  const saved = await applyStateSavePacket(input.root, {
    expectedStream: input.state.stream,
    expectedNonce: expectedStateNonce(input.state),
    sourceGlobalSeq: input.state.lastSyncedSequence,
    repos,
  });
  if (saved.status !== "accepted") throw new Error("held attempt post-settlement CAS rejected");
  return await loadRawState(input.root) ?? input.state;
}
