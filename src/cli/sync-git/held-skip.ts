import { hashBytes, type GitSection } from "../../engine/index.js";
import { readRepoIdentityV1, repositoryIdentityHash } from "./repo-lineage.js";
import { canonicalString } from "../../engine/e2ee/index.js";
import { readRefReflogFingerprint } from "./keep-pins.js";
import { listWorktrees } from "./git-state.js";
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
import { readArtifactPlaneDigest } from "./base-artifact-scan.js";
import { carryRepoBaseProof, recordOriginLineage } from "./base-composer.js";
import { gitHeldSkipComposerEnabled, sortedTypedBlockers } from "./held-blockers.js";
import {
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  GIT_FINGERPRINT_VERSION,
  gitFingerprint,
  gitFingerprintRun,
  type GitFingerprint,
} from "./fingerprint.js";
import { gitIncomingKey } from "./shared.js";

const HELD_SKIP_SAFETY_FLOOR_MS = 60 * 60 * 1000;

export const gitHeldSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_HELD_SKIP !== "0";

export interface HeldInputObservation {
  incomingKey: string;
  classifierInputKey: string;
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
  /** Present only while RBOX_GIT_HELD_SKIP_COMPOSER is on (design 270). */
  artifactPlaneDigest?: string;
}

export interface ObserveHeldInputsOptions {
  root: string;
  relPath: string;
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

/** Classifier-input identity, deliberately independent of bundle recapture.
 * gitIncomingKey already excludes ciphertext locators/metadata; blanking its
 * plaintext bundle/chain inputs leaves exactly the section semantics consumed
 * by held classification. Index transport remains bound separately by
 * incomingIndexArtifactDescriptor. */
export function heldClassifierInputKey(incoming: GitSection): string {
  return gitIncomingKey({ ...incoming, bundleSha: "", packChain: undefined });
}

/** The one canonicalization of a repo's partial apply, shared by the observation
 * bracket and the early gate so both compare identical bytes. */
export function heldPartialDisposition(incoming: GitSection, partial: GitPartialApply | undefined): string {
  return canonicalString(partial ? { ...partial, incomingKey: heldClassifierInputKey(incoming) } : null);
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
    const incomingKey = heldClassifierInputKey(opts.incoming);
    const partialDisposition = heldPartialDisposition(opts.incoming, opts.partial);
    const artifactPlaneDigest = gitHeldSkipComposerEnabled()
      ? await readArtifactPlaneDigest(ctx.repoDir)
      : undefined;
    const after = await gitFingerprint(gitFingerprintRun("per-decision"), opts.root, opts.relPath, { includeIndexDependencies: true });
    const worktreeRegistryDigest = await readWorktreeRegistryDigest(ctx.repoDir);
    if (!after.dependenciesComplete || before.hash !== after.hash || before.diskCtx?.kind !== after.diskCtx?.kind
      || before.diskCtx?.gitDir !== after.diskCtx?.gitDir
      || before.diskCtx?.commonDir !== after.diskCtx?.commonDir
      || !worktreeRegistryDigest
      || worktreeRegistryBefore !== worktreeRegistryDigest) return undefined;
    const observation: HeldInputObservation = {
      incomingKey,
      classifierInputKey: incomingKey,
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
    if (artifactPlaneDigest !== undefined) observation.artifactPlaneDigest = artifactPlaneDigest;
    return observation;
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
  return heldAttemptMismatchField(attempt, observation, nowMs) === undefined;
}

/** Temporary RBOX_TRACE_HELD diagnostic: preserve matcher semantics while
 * naming the first gate/input that rejects a stored attempt. */
export function heldAttemptMismatchField(
  attempt: GitHeldAttempt,
  observation: HeldInputObservation,
  nowMs = Date.now(),
): string | undefined {
  if (attempt.fingerprintVersion !== GIT_FINGERPRINT_VERSION) return "fingerprintVersion";
  if (typeof attempt.worktreeRegistryDigest !== "string") return "worktreeRegistryDigest";
  const writtenAt = Date.parse(attempt.at);
  if (!Number.isFinite(writtenAt) || writtenAt > nowMs) return "at";
  if (observation.maxFingerprintTimestampMs >= nowMs - GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS) return "maxFingerprintTimestampMs";
  const { maxFingerprintTimestampMs: _max, ...observedInputs } = observation;
  // Attempts written before the cheap pre-fetch gate have no explicit format
  // marker. The authoritative late matcher remains their compatibility path;
  // a successful match upgrades the durable attempt for the next pull.
  const comparableObserved = typeof attempt.classifierInputKey === "string"
    ? observedInputs
    : (({ classifierInputKey: _classifierInputKey, ...legacyInputs }) => legacyInputs)(observedInputs);
  const storedInputs = attemptInputs(attempt);
  return Object.keys(comparableObserved).sort().find((field) =>
    canonicalString(Reflect.get(storedInputs, field)) !== canonicalString(Reflect.get(comparableObserved, field)));
}

export function heldAttemptFloorElapsed(attempt: GitHeldAttempt, nowMs = Date.now()): boolean {
  const at = Date.parse(attempt.at);
  return !Number.isFinite(at) || nowMs - at > HELD_SKIP_SAFETY_FLOOR_MS;
}

/** Cheap receiver admission check for a completed held episode. This deliberately
 * knows nothing about bundles, indexes, classifier projections, or follow
 * protocol state. Two independent fingerprints bracket the decision so an
 * incomplete, changing, or racy repository always falls through to the full
 * path and its authoritative late check. */
/** Every gate the early check can refuse on, plus the two the caller supplies
 * when it never runs. Naming them keeps the RBOX_TRACE_HELD vocabulary closed. */
export type EarlyHeldAttemptReason =
  | "none"
  | "no-attempt"
  | "disabled"
  | "fingerprint-version"
  | "worktree-registry"
  | "attempt-time"
  | "safety-floor"
  | "legacy-classifier-key"
  | "classifier-key"
  | "partial-disposition"
  | "artifact-plane"
  | "artifact-plane-unavailable"
  | "artifact-plane-race"
  | "dependencies-incomplete"
  | "fingerprint-race"
  | "local-fingerprint"
  | "racy-clean"
  | "observation-error";

export interface EarlyHeldAttemptDecision {
  matches: boolean;
  reason: EarlyHeldAttemptReason;
}

export async function earlyHeldAttemptDecision(input: {
  root: string;
  relPath: string;
  incoming: GitSection;
  attempt: GitHeldAttempt;
  /** The durable partial as it stood before this pull's frame. */
  partial?: GitPartialApply;
  nowMs?: number;
  /** Test seam for an artifact-plane mutation between the bracket reads. */
  afterFirstArtifactPlaneRead?: () => void | Promise<void>;
}): Promise<EarlyHeldAttemptDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const writtenAt = Date.parse(input.attempt.at);
  if (input.attempt.fingerprintVersion !== GIT_FINGERPRINT_VERSION) return { matches: false, reason: "fingerprint-version" };
  if (typeof input.attempt.worktreeRegistryDigest !== "string") return { matches: false, reason: "worktree-registry" };
  if (!Number.isFinite(writtenAt) || writtenAt > nowMs) return { matches: false, reason: "attempt-time" };
  if (heldAttemptFloorElapsed(input.attempt, nowMs)) return { matches: false, reason: "safety-floor" };
  if (typeof input.attempt.classifierInputKey !== "string") return { matches: false, reason: "legacy-classifier-key" };
  if (heldClassifierInputKey(input.incoming) !== input.attempt.classifierInputKey) {
    return { matches: false, reason: "classifier-key" };
  }
  // Unflagged: the early gate runs before the attempt shredder, so a pRepaired
  // or checkout-progress write is otherwise invisible to it (design 270 §2.4).
  if (heldPartialDisposition(input.incoming, input.partial) !== input.attempt.partialDisposition) {
    return { matches: false, reason: "partial-disposition" };
  }
  try {
    const before = await gitFingerprint(
      gitFingerprintRun("per-decision"), input.root, input.relPath, { includeIndexDependencies: true },
    );
    const stored = input.attempt.artifactPlaneDigest;
    const composer = gitHeldSkipComposerEnabled();
    // An attempt with no stored digest can never match one; refuse it without
    // spending a git spawn, and likewise when the fingerprint already refuses.
    if (composer && stored === undefined) return { matches: false, reason: "artifact-plane" };
    let repoDir: string | undefined;
    let digestBefore: string | undefined;
    if (composer && before.dependenciesComplete) {
      repoDir = before.diskCtx?.repoDir;
      if (!repoDir) return { matches: false, reason: "artifact-plane-unavailable" };
      digestBefore = await readArtifactPlaneDigest(repoDir);
      if (digestBefore !== stored) return { matches: false, reason: "artifact-plane" };
      await input.afterFirstArtifactPlaneRead?.();
    }
    const after = await gitFingerprint(
      gitFingerprintRun("per-decision"), input.root, input.relPath, { includeIndexDependencies: true },
    );
    if (!before.dependenciesComplete || !after.dependenciesComplete) return { matches: false, reason: "dependencies-incomplete" };
    if (before.hash !== after.hash) return { matches: false, reason: "fingerprint-race" };
    // Bracket the plane the way the fingerprints bracket the repo: a resolve or
    // reset landing inside this window must fall through, not skip one cycle stale.
    if (repoDir !== undefined && await readArtifactPlaneDigest(repoDir) !== digestBefore) {
      return { matches: false, reason: "artifact-plane-race" };
    }
    if (after.hash !== input.attempt.localFingerprint) return { matches: false, reason: "local-fingerprint" };
    if (Math.max(before.maxTsMs, after.maxTsMs) >= nowMs - GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS) {
      return { matches: false, reason: "racy-clean" };
    }
    return { matches: true, reason: "none" };
  } catch {
    return { matches: false, reason: "observation-error" };
  }
}

export function createHeldAttempt(
  observation: HeldInputObservation,
  blockers: readonly TypedBlocker[],
  at = new Date().toISOString(),
): GitHeldAttempt {
  const { maxFingerprintTimestampMs: _max, ...inputs } = observation;
  return { ...inputs, blockers: sortedTypedBlockers(blockers), at };
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
