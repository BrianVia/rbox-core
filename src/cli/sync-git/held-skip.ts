import { hashBytes, readRepoIdentityV1, repositoryIdentityHash, type GitSection } from "../../engine/index.js";
import { canonicalString } from "../../engine/e2ee/index.js";
import { readRefReflogFingerprint } from "../../engine/git/keep-pins.js";
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
import {
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  GIT_FINGERPRINT_VERSION,
  gitFingerprint,
  gitFingerprintRun,
} from "./fingerprint.js";

const HELD_SKIP_SAFETY_FLOOR_MS = 60 * 60 * 1000;

export const gitHeldSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_HELD_SKIP !== "0";

export function sortedTypedBlockers(blockers: readonly TypedBlocker[]): TypedBlocker[] {
  const byKey = new Map<string, TypedBlocker>();
  for (const blocker of blockers) byKey.set(canonicalString(blocker), blocker);
  return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, blocker]) => ({ ...blocker }));
}

export function heldBlockersAllowSkip(blockers: readonly TypedBlocker[]): boolean {
  return blockers.length > 0 && blockers.every((blocker) =>
    blocker.reason === "local-commits" || blocker.reason === "local-stash");
}

export interface HeldInputObservation {
  incomingKey: string;
  localFingerprint: string;
  fingerprintVersion: string;
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
  /** Exact paths consulted by the completed follow, or by the stored attempt on recheck. */
  reflogPaths: readonly string[];
}

/** Stable before/after bracket over every held-skip input. Any read/race fails open. */
export async function observeHeldInputs(opts: ObserveHeldInputsOptions): Promise<HeldInputObservation | undefined> {
  try {
    const before = await gitFingerprint(gitFingerprintRun("per-decision"), opts.root, opts.relPath);
    const ctx = before.diskCtx;
    if (!ctx) return undefined;
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
    const after = await gitFingerprint(gitFingerprintRun("per-decision"), opts.root, opts.relPath);
    if (before.hash !== after.hash || before.diskCtx?.kind !== after.diskCtx?.kind
      || before.diskCtx?.gitDir !== after.diskCtx?.gitDir
      || before.diskCtx?.commonDir !== after.diskCtx?.commonDir) return undefined;
    return {
      incomingKey: opts.incomingKey,
      localFingerprint: after.hash,
      fingerprintVersion: GIT_FINGERPRINT_VERSION,
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

function attemptInputs(attempt: GitHeldAttempt): Omit<HeldInputObservation, "maxFingerprintTimestampMs"> {
  const { blockers: _blockers, at: _at, ...inputs } = attempt;
  return inputs;
}

export function heldAttemptMatches(
  attempt: GitHeldAttempt,
  observation: HeldInputObservation,
  nowMs = Date.now(),
): boolean {
  if (attempt.fingerprintVersion !== GIT_FINGERPRINT_VERSION) return false;
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
    const observed = await observeHeldInputs({
      root: input.root,
      relPath,
      incomingKey: attempt.incomingKey,
      incoming,
      record,
      partial: record.partial,
      stateNonce: expectedStateNonce(input.state),
      reflogPaths: attempt.reflogs.map((entry) => entry.path),
    });
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
