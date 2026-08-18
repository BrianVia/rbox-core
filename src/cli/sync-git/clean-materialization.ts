/** Never: the received-config due predicate, follower-protocol discovery, sync-state reads, caller-visible plan/receipt protocols, or durable persistence. */
import { type GitSection } from "../../engine/index.js";
import { assertGitTargetWithinRoot } from "./containment.js";
import { type ApplyBranchTransitionAdapter, type ApplyBranchTransitionInput, type ApplyGitResult } from "./git-state-apply.js";
import { type GitChainTimings } from "./chain-timings.js";
import { type RepoCtx } from "./git-state.js";
import { runUpdateRefTransaction } from "./keep-pins.js";
import type { GitDeferralReason, GitPartialApply } from "../config.js";
import { composeRepoBase, type BranchBaseOrigin, type RepoBaseProof, type RepoBaseValue } from "./base-composer.js";
import { commitPlannedBranchTransition, planBranchTransition } from "./branch-transition.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import { errMsg } from "./shared.js";

interface CleanMaterializationInput {
  readonly root: string;
  readonly relPath: string;
  readonly repoDir: string;
  readonly incomingKey: string;
  readonly incoming: GitSection;
  /** Already-evaluated ignore predicate for the receiver path. */
  readonly ignoredTarget: boolean;
  /** Removal-memory leftover whose identity still equals the memory (§9 [v5]). */
  readonly cleanMaterialize: boolean;
  /** Shape of the on-disk `.git`, or undefined for a genuinely fresh target. */
  readonly dotGit: { readonly isDirectory: boolean } | undefined;
  readonly stateNonce: string | undefined;
  localRefs: () => Promise<Record<string, string>>;
  readonly degradedMutex: boolean;
  readonly chainTimings: GitChainTimings | undefined;
  readonly warningSink: ((message: string) => void) | undefined;
  /** Present exactly when the repository-bound receiver says config is due. */
  readonly applyConfig: (() => Promise<boolean>) | undefined;
  /** Config baseline an unapplied partial must carry forward. */
  readonly inheritedConfigBase: GitPartialApply["configBase"];
  /** Composer inputs for the intended BASE transition. The suppressed manifest
   * projection is deliberately NOT the prior here: §130 retains the protected
   * BASE anchor in the repo record. */
  readonly baseComposition: { readonly prior: RepoBaseValue; readonly candidate: RepoBaseValue };
  runMutation<T>(fn: () => Promise<T>): Promise<T>;
  applyState(options: CleanApplyStateOptions): Promise<ApplyGitResult>;
  /** Memoized follower-branch protocol; a hold throws with its exact reason. */
  branchProtocol(ctx: RepoCtx): Promise<FollowerBranchProtocol>;
  repoContext(): Promise<RepoCtx>;
  log(message: string): void;
}

interface CleanApplyStateOptions {
  legacyWholeSectionOwnership?: true;
  branchTransitions?: ApplyBranchTransitionAdapter;
  beforeMutateWipesRefs?: true;
  cleanWipeRefs?: true;
  chainTimings?: GitChainTimings;
  warningSink?: (message: string) => void;
}

interface CleanMaterializationTransition {
  readonly appliedSection: GitSection | null | "retain";
  readonly pending: GitSection | null;
  readonly partial: GitPartialApply | null;
  readonly attempt: "clear" | "retain";
  readonly deferral: GitDeferralReason | "clear";
  /** A materialization always discharges the removal memory. */
  readonly removedMemory: null;
  /** A cached projection belongs to the prior base; the next follow re-derives it. */
  readonly indexProjection: null;
  readonly proof: RepoBaseProof | undefined;
  readonly branchOrigins: Record<string, BranchBaseOrigin> | undefined;
}

type CleanMaterializationOutcome =
  | {
      readonly status: "materialized";
      readonly transition: CleanMaterializationTransition;
      readonly announcement: string;
    }
  | {
      readonly status: "deferred";
      readonly reason: string;
      readonly deferralReason: GitDeferralReason;
      readonly configLaneDeferred: boolean;
    };

/** Engine refusal wording is the only classification input, and its precedence
 * is load-bearing: a busy repo whose message also names an artifact stays
 * git-busy, and a quarantine failure is never an artifact fault. */
function classifyCleanApplyDeferral(reason: string): GitDeferralReason {
  return /worktree-ownership|ownership-deferred/.test(reason) ? "worktree-ownership"
    : reason.includes("busy") ? "git-busy"
    : /\bconfig\b/i.test(reason) ? "config"
    : /quarantine/i.test(reason) ? "other"
    : /artifact|bundle|decrypt|import/i.test(reason) ? "artifact"
    : /unsupported|invalid git section/i.test(reason) ? "unsupported"
    : "other";
}

/**
 * Routes every branch create/update/delete through §130's typed A/P/K
 * transition adapter, so each one carries an exact expected-old value and an
 * exact inverse. A clean wipe may encounter a quarantined local-only branch:
 * its logical BASE is already absent, so no A is authored and the typed
 * physical-only plan still has an exact expected-old inverse.
 */
function cleanBranchTransitions(
  repoDir: string,
  input: CleanMaterializationInput,
): ApplyBranchTransitionAdapter {
  return {
    commit: async (transition: ApplyBranchTransitionInput) => {
      const protocol = await input.branchProtocol(transition.ctx);
      const logicalBaseOid = protocol.logicalBaseRefs[transition.ref] ?? null;
      if (transition.afterOid === null && logicalBaseOid === null && transition.beforeOid !== null) {
        await runUpdateRefTransaction(repoDir, [
          ...transition.extraTransactionLines,
          `delete ${transition.ref} ${transition.beforeOid}`,
        ]);
        return {
          ref: transition.ref,
          beforeOid: transition.beforeOid,
          afterOid: null,
          inverseLines: [`create ${transition.ref} ${transition.beforeOid}`],
        };
      }
      const plan = await planBranchTransition({
        repoDir,
        binding: protocol.binding,
        ref: transition.ref,
        beforeOid: transition.beforeOid,
        afterOid: transition.afterOid,
        logicalBaseOid,
        extraTransactionLines: transition.extraTransactionLines,
        ...(transition.expectedReflogFingerprint ? { expectedReflogFingerprint: transition.expectedReflogFingerprint } : {}),
      });
      const committed = await commitPlannedBranchTransition(plan);
      return {
        ref: plan.ref,
        beforeOid: plan.beforeOid,
        afterOid: plan.afterOid,
        inverseLines: plan.inverseLines,
        witness: committed.witness,
        lockedProof: committed.lockedProof,
      };
    },
    rollback: async (_ctx, transition) => {
      await runUpdateRefTransaction(repoDir, transition.inverseLines);
    },
  };
}

function partialFor(
  incomingKey: string,
  progress: Pick<GitPartialApply, "appliedRefs" | "heldRefs" | "configApplied">,
  inheritedConfigBase: GitPartialApply["configBase"],
): GitPartialApply {
  return {
    incomingKey,
    checkoutPending: false,
    appliedRefs: progress.appliedRefs,
    heldRefs: progress.heldRefs,
    configApplied: progress.configApplied,
    ...(!progress.configApplied && inheritedConfigBase !== undefined ? { configBase: inheritedConfigBase } : {}),
  };
}

/**
 * The complete clean/fresh Git operation. It admits one repository-bound input,
 * refuses before mutation, commits Git, then derives the only logical transition
 * the witnessed effects authorize. No plan, executor, receipt identity echo, or
 * physical-fact relay escapes this Module.
 */
export async function materializeCleanGit(
  input: CleanMaterializationInput,
): Promise<CleanMaterializationOutcome> {
  const defer = (reason: string, deferralReason: GitDeferralReason, configLaneDeferred = false) => ({
    status: "deferred" as const,
    reason,
    deferralReason,
    configLaneDeferred,
  });

  // Ignore must short-circuit containment: an ignored target never pays for a
  // realpath walk it cannot use.
  if (input.ignoredTarget) {
    return defer("target is inside an ignored subtree — refusing to materialize", "ignored-target");
  }
  try {
    await assertGitTargetWithinRoot(input.root, input.relPath);
  } catch (error) {
    return defer(errMsg(error), "containment");
  }

  // Pointer leftovers share their main clone's store and are never ref-wiped.
  // The local-ref read remains lazy and occurs only for an incapable lineage
  // with an on-disk Git entry, preserving the no-extra-Git-read fast path.
  const wipeLeftover = input.cleanMaterialize && input.dotGit !== undefined && input.dotGit.isDirectory;
  const capableLineage = /^[0-9a-f]{32}$/.test(input.stateNonce ?? "");
  if (!capableLineage) {
    const remoteBranches = Object.keys(input.incoming.refs).some((ref) => ref.startsWith("refs/heads/"));
    const localBranches = input.dotGit
      ? Object.keys(await input.localRefs().catch(() => ({}))).some((ref) => ref.startsWith("refs/heads/"))
      : false;
    if (remoteBranches || (wipeLeftover && localBranches)) {
      return defer("branch materialization requires a durable capable state lineage", "artifact");
    }
  }

  const res = await input.runMutation(() => input.applyState({
    ...(input.degradedMutex ? { legacyWholeSectionOwnership: true } : {}),
    ...(wipeLeftover ? { beforeMutateWipesRefs: true, cleanWipeRefs: true } : {}),
    ...(input.chainTimings ? { chainTimings: input.chainTimings } : {}),
    ...(input.warningSink ? { warningSink: input.warningSink } : {}),
    ...(capableLineage ? { branchTransitions: cleanBranchTransitions(input.repoDir, input) } : {}),
  }));

  if (!res.applied) {
    const reason = res.reason ?? "apply deferred";
    return defer(reason, classifyCleanApplyDeferral(reason), /\bconfig\b/i.test(reason));
  }

  // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
  try {
    await assertGitTargetWithinRoot(input.root, input.relPath);
  } catch (e) {
    input.log(`git-sync WARNING ${input.relPath}: post-apply containment check failed: ${errMsg(e)}`);
  }

  const held = Object.entries(res.heldRefs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const configApplied = input.applyConfig === undefined ? true : await input.applyConfig();
  const announcement =
    `git-sync applied ${input.relPath}${held.length
      ? ` (held refs: ${held.map(([ref, worktree]) => `${ref}=${worktree}`).join(" ")})`
      : res.filteredRefs?.length
        ? ` (filtered refs: ${res.filteredRefs.join(" ")})`
        : ""}`;
  const settled = { removedMemory: null, indexProjection: null } as const;

  if (held.length > 0) {
    const filtered = new Set(res.filteredRefs ?? []);
    const heldSet = new Set(held.map(([ref]) => ref));
    const transitionPartials: GitPartialApply["appliedRefs"] = {};
    for (const [ref, transition] of Object.entries(res.branchTransitions ?? {})) {
      if (!transition.witness) continue;
      transitionPartials[ref] = transition.witness.kind === "present"
        ? { kind: "present", oid: transition.witness.nextOid, artifactOid: transition.witness.artifactOid, episode: transition.witness.episode }
        : { kind: "absent", artifactOid: transition.witness.artifactOid };
    }
    Object.assign(transitionPartials, res.safeRefTransitions ?? {});
    for (const [ref, oid] of Object.entries(input.incoming.refs)) {
      if (!heldSet.has(ref) && !filtered.has(ref) && transitionPartials[ref] === undefined) {
        transitionPartials[ref] = { kind: "direct", oid };
      }
    }
    return {
      status: "materialized",
      announcement,
      transition: {
        appliedSection: "retain",
        pending: input.incoming,
        partial: partialFor(input.incomingKey, {
          appliedRefs: transitionPartials,
          heldRefs: Object.fromEntries(held.map(([ref]) => [ref, "ownership" as const])),
          configApplied,
        }, input.inheritedConfigBase),
        attempt: "retain",
        deferral: "worktree-ownership",
        proof: undefined,
        branchOrigins: undefined,
        ...settled,
      },
    };
  }

  const unappliedConfigPartial = configApplied
    ? null
    : partialFor(input.incomingKey, { appliedRefs: {}, heldRefs: {}, configApplied: false }, input.inheritedConfigBase);

  if (res.branchTransitions || res.safeRefTransitions) {
    const protocol = await input.branchProtocol(await input.repoContext());
    const branchWitnesses = Object.fromEntries(Object.entries(res.branchTransitions ?? {})
      .flatMap(([ref, transition]) => transition.witness ? [[ref, transition.witness] as const] : []));
    const safeRefWitnesses = res.safeRefTransitions ?? {};
    const proof: RepoBaseProof = {
      authority: {
        kind: "pull-ref-transaction",
        lineageHash: protocol.lineageHash,
        repositoryIdentityHash: protocol.repositoryIdentityHash,
        incomingKey: input.incomingKey,
        branchWitnesses,
        safeRefWitnesses,
      },
      lockedProof: {
        repoKind: (await input.repoContext()).kind,
        effectiveRefScope: wipeLeftover ? "all" : input.incoming.refScope,
        checkoutComplete: true,
        incomingKey: input.incomingKey,
        branches: Object.fromEntries(Object.entries(res.branchTransitions ?? {})
          .flatMap(([ref, transition]) => transition.witness && transition.lockedProof
            ? [[ref, transition.lockedProof] as const]
            : [])),
        safeRefs: Object.fromEntries(Object.entries(safeRefWitnesses).map(([ref, witness]) => [ref, {
          liveOid: witness.afterOid,
          witness,
          ...(ref === "refs/stash" && witness.afterOid !== null ? { stashReflogReady: true } : {}),
        }])),
      },
    };
    const composed = composeRepoBase(input.baseComposition.prior, input.baseComposition.candidate, proof.authority, proof.lockedProof);
    const pends = composed.disposition === "pending";
    return {
      status: "materialized",
      announcement,
      transition: {
        appliedSection: composed.base ?? null,
        pending: pends ? input.incoming : null,
        partial: unappliedConfigPartial,
        attempt: pends ? "retain" : "clear",
        deferral: pends ? "artifact" : "clear",
        proof,
        branchOrigins: composed.branchBaseOrigins,
        ...settled,
      },
    };
  }

  return {
    status: "materialized",
    announcement,
    transition: {
      appliedSection: input.incoming,
      pending: null,
      partial: unappliedConfigPartial,
      attempt: "clear",
      deferral: "clear",
      proof: undefined,
      branchOrigins: undefined,
      ...settled,
    },
  };
}
