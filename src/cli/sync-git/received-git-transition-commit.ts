import path from "node:path";
import { readBaseAbsentArtifact, readBasePresentArtifact, repoCtxFromDisk, settleBaseAbsentArtifact } from "../../engine/index.js";
import { readAllRefs, readAllRefsStrict } from "../../engine/git/refs.js";
import { git } from "../../engine/git/shared.js";
import type { LockfileHooks } from "../../engine/git/lockfile.js";
import { MutationGateClosedError, type MutationBoundary } from "../../engine/mutation-gate.js";
import { expectedStateNonce, repoRecordsForState, type GitHeldAttempt, type GitPartialApply, type RepoRecord, type SyncState } from "../config.js";
import type { GitPullOutcome } from "./apply.js";
import { carryRepoBaseProof, recordOriginLineage, type RepoBaseProof } from "./base-composer.js";
import { clearFollowJournal } from "./follow.js";
import { rebindHeldAttemptsAfterSettlement } from "./held-skip.js";
import { settleExactPresentArtifact } from "./p-settlement.js";
import { chainLock, gitApplyMutationKey, gitIncomingKey, nextDeferral, repoDirOf } from "./shared.js";
import { acquirePreparedStateCasLocks, markStateCasCommitted, prepareStateCasLocks, releaseStateCasLocks, type HeldStateCasLock, type StateCasLockRequest } from "./state-cas-locks.js";

/**
 * The received Git transition's commit half: everything between a completed
 * per-repository execution receipt and the durable state that makes it real.
 *
 * The commit is deliberately NOT atomic, and this module owns both halves of
 * that reality. {@link withRevalidatedGitPartialApplies} re-proves every
 * exact-ref claim under per-common-dir locks and commits the BASE CAS;
 * {@link settleCommittedBranchArtifacts} then retires the A/P artifacts and
 * rebinds held attempts, and may legitimately be interrupted after the CAS has
 * already succeeded. The seam between the two is therefore a resumable
 * boundary, not a rollback point: nothing after the CAS may falsify the BASE it
 * committed.
 */

/** Re-prove one repository's applied-ref claims against its live ref database. */
export async function partialRefsStillMatch(repoDir: string, partial: GitPartialApply): Promise<boolean> {
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

/** The partial marker this pull would persist for a repository: its own
 * transition when it authored one, otherwise the recorded marker it inherits. */
function effectivePartial(
  rel: string,
  records: Record<string, RepoRecord>,
  outcome: GitPullOutcome,
): GitPartialApply | undefined {
  const transition = outcome.partial?.[rel];
  return transition === null ? undefined : transition ?? records[rel]?.partial;
}

function dropPartial(rel: string, outcome: GitPullOutcome): void {
  outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
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
    const effective = effectivePartial(rel, records, outcome);
    if (!effective) return;
    const key = await gitApplyMutationKey(root, rel);
    await chainLock(locks, key, async () => {
      if (await partialRefsStillMatch(repoDirOf(root, rel), effective)) return;
      dropPartial(rel, outcome);
    });
  }));
}

interface StateCasLockPlan {
  /** One entry per `.lock` path, carrying every repository that needs it. */
  readonly requested: Map<string, { commonDir: string; rels: Set<string>; proofs: StateCasLockRequest["proofs"] }>;
  readonly mutationRepos: string[];
}

/** Derive the exact per-common-dir lock set this commit must hold: one lock per
 * applied partial ref plus one per branch-proof artifact ref. A repository whose
 * context or lock path cannot be trusted loses its partial marker here, before
 * any lock is requested — an unprovable marker must never survive the CAS. */
async function planStateCasLocks(
  root: string,
  state: SyncState,
  outcome: GitPullOutcome,
): Promise<StateCasLockPlan> {
  const records = repoRecordsForState(state);
  const partials = [...new Set([
    ...Object.keys(records),
    ...Object.keys(outcome.partial ?? {}),
  ])].flatMap((rel) => {
    const partial = effectivePartial(rel, records, outcome);
    return partial ? [{ rel, partial }] : [];
  });
  const requested: StateCasLockPlan["requested"] = new Map();
  for (const { rel, partial } of partials) {
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel)).catch(() => undefined);
    if (!ctx) {
      dropPartial(rel, outcome);
      continue;
    }
    const commonDir = path.resolve(ctx.commonDir);
    for (const [ref, expected] of Object.entries(partial.appliedRefs)) {
      const lockPath = path.resolve(ctx.commonDir, `${ref}.lock`);
      if (!lockPath.startsWith(`${commonDir}${path.sep}`)) {
        dropPartial(rel, outcome);
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
  return {
    requested,
    mutationRepos: [...new Set([
      ...partials.map(({ rel }) => rel),
      ...Object.keys(outcome.repoProofs ?? {}),
    ])].sort(),
  };
}

/** A ref database that has become unreadable is evidence about the reader, not
 * about the transition: the composed BASE is withdrawn in favour of the prior
 * durable one, the incoming section returns to pending, and the proof is kept
 * only so its artifacts still settle. This never fails the pull. */
function carryUnreadableRefDatabase(
  rel: string,
  proof: RepoBaseProof,
  prior: RepoRecord | undefined,
  outcome: GitPullOutcome,
): void {
  const candidate = outcome.gitRepos?.[rel];
  if (candidate) {
    outcome.gitPendingRemote = { ...(outcome.gitPendingRemote ?? {}), [rel]: candidate };
  }
  if (prior?.base) outcome.gitRepos = { ...(outcome.gitRepos ?? {}), [rel]: prior.base };
  else if (outcome.gitRepos) delete outcome.gitRepos[rel];
  if (prior?.branchBaseOrigins) {
    outcome.branchBaseOrigins = { ...(outcome.branchBaseOrigins ?? {}), [rel]: prior.branchBaseOrigins };
  } else if (outcome.branchBaseOrigins) {
    delete outcome.branchBaseOrigins[rel];
  }
  dropPartial(rel, outcome);
  outcome.artifactSettlementProofs = {
    ...(outcome.artifactSettlementProofs ?? {}),
    [rel]: proof,
  };
  const retainedLineage = recordOriginLineage(prior?.branchBaseOrigins) ?? "legacy-untrusted";
  outcome.repoProofs = {
    ...(outcome.repoProofs ?? {}),
    [rel]: carryRepoBaseProof(retainedLineage),
  };
  const existingTransition = outcome.deferrals?.[rel];
  const existing = existingTransition === null
    ? undefined
    : existingTransition?.apply ?? prior?.deferrals?.apply;
  const now = new Date().toISOString();
  outcome.deferrals = {
    ...(outcome.deferrals ?? {}),
    [rel]: {
      ...(existingTransition && existingTransition !== null ? existingTransition : {}),
      apply: nextDeferral(
        "apply",
        existing,
        "ref-read-unreadable",
        now,
        candidate ? gitIncomingKey(candidate) : undefined,
      ),
    },
  };
}

/** Under the held locks, re-read every branch proof's terminal and A artifact.
 * A terminal that moved is a hard failure: the composed BASE would otherwise
 * claim a state the repository no longer has. */
async function revalidateCommittedBranchProofs(
  root: string,
  records: Record<string, RepoRecord>,
  outcome: GitPullOutcome,
): Promise<void> {
  for (const [rel, proof] of Object.entries(outcome.repoProofs ?? {})) {
    if (proof.authority.kind !== "pull-ref-transaction" && proof.authority.kind !== "journal-recovery") continue;
    const ctx = await repoCtxFromDisk(repoDirOf(root, rel));
    if (!ctx) throw new Error(`branch proof repository disappeared for ${rel}`);
    const strict = await readAllRefsStrict(ctx.repoDir);
    if (strict.status === "unreadable") {
      carryUnreadableRefDatabase(rel, proof, records[rel], outcome);
      continue;
    }
    const live = strict.refs;
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
    /** Observation only: wall ms per CAS step, for the pull phase report. */
    observeStep?: (step: "plan" | "prepare" | "acquire" | "revalidate-partials" | "revalidate-proofs" | "settle", ms: number) => void;
  } = {},
): Promise<T> {
  const timed = async <R>(step: Parameters<NonNullable<typeof options.observeStep>>[0], fn: () => Promise<R>): Promise<R> => {
    if (!options.observeStep) return fn();
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      try { options.observeStep(step, Date.now() - t0); } catch { /* observation must never fail the CAS */ }
    }
  };
  const records = repoRecordsForState(state);
  const { requested, mutationRepos } = await timed("plan", () => planStateCasLocks(root, state, outcome));
  const lease = options.mutationBoundary?.enter({
    phase: "state-cas",
    ...(mutationRepos.length > 0 ? { repository: mutationRepos.join(",") } : {}),
  });
  let prepared: Awaited<ReturnType<typeof prepareStateCasLocks>>;
  let held: HeldStateCasLock[] = [];
  try {
    prepared = await timed("prepare", () => prepareStateCasLocks(
      root,
      { stream: state.stream, stateNonce: expectedStateNonce(state) },
      [...requested.entries()].map(([lockPath, request]) => ({ lockPath, commonDir: request.commonDir, proofs: request.proofs })),
    ));
    await options.afterStateCasJournalPrepared?.();
    if (lease?.abortRequested) throw new MutationGateClosedError();
    if (prepared) {
      const preparedLocks = prepared;
      const acquired = await timed("acquire", () => acquirePreparedStateCasLocks(preparedLocks, {
        beforeLockPublish: () => {
          if (lease?.abortRequested) throw new MutationGateClosedError();
        },
        onFirstAcquired: async () => {
          if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
          await options.afterFirstStateCasLockAcquired?.();
        },
        afterAcquisitionPersisted: options.afterStateCasLockPersisted,
        hooks: options.stateCasLockHooks,
      }));
      held = acquired.held;
      await options.afterStateCasLocksAcquired?.();
      for (const lockPath of acquired.blocked) {
        for (const rel of requested.get(lockPath)?.rels ?? []) dropPartial(rel, outcome);
      }
    }
    await timed("revalidate-partials", () => revalidateGitPartialApplies(root, state, outcome));
    await timed("revalidate-proofs", () => revalidateCommittedBranchProofs(root, records, outcome));
    if (lease && !lease.beginCommit()) throw new MutationGateClosedError();
    const saved = await save();
    await timed("settle", async () => {
      await markStateCasCommitted(prepared);
      await options.afterStateCasCommitted?.();
      for (const rel of outcome.publishedJournals ?? []) await clearFollowJournal(root, rel, outcome.journalCrashAt);
    });
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
  const settlementProofs = {
    ...(outcome.repoProofs ?? {}),
    ...(outcome.artifactSettlementProofs ?? {}),
  };
  const settlementRepos = Object.entries(settlementProofs)
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
    for (const [rel, proof] of Object.entries(settlementProofs).sort(([a], [b]) => a.localeCompare(b))) {
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
