import {
  assertGitTargetWithinRoot,
  type ApplyBranchTransitionAdapter,
  type ApplyBranchTransitionInput,
  type ApplyGitResult,
  type GitChainTimings,
  type GitSection,
  type RepoCtx,
} from "../../engine/index.js";
import { runUpdateRefTransaction } from "../../engine/git/keep-pins.js";
import type { GitDeferralReason, GitPartialApply } from "../config.js";
import { composeRepoBase, type BranchBaseOrigin, type RepoBaseProof, type RepoBaseValue } from "./base-composer.js";
import { commitPlannedBranchTransition, planBranchTransition } from "./branch-transition.js";
import type { FollowerBranchProtocol } from "./follower-protocol.js";
import { errMsg } from "./shared.js";

/**
 * The exact repository and wire input a clean materialization is bound to. The
 * incoming key is part of the identity because every witness, partial, and
 * locked proof this transition mints is stamped with it: a receipt can only
 * ever describe the section its plan was prepared from.
 */
export interface CleanMaterializationIdentity {
  readonly root: string;
  readonly relPath: string;
  readonly repoDir: string;
  readonly incomingKey: string;
}

/** The applyGitState options this transition is allowed to author. */
export interface CleanApplyStateOptions {
  legacyWholeSectionOwnership?: true;
  branchTransitions?: ApplyBranchTransitionAdapter;
  beforeMutateWipesRefs?: true;
  cleanWipeRefs?: true;
  chainTimings?: GitChainTimings;
  warningSink?: (message: string) => void;
}

/** Config never precedes the Git disposition: either it is already settled, or
 * the lane runs after the materialization commits. */
export type CleanMaterializationConfigPhase =
  | { readonly phase: "not-due"; readonly applied: boolean }
  | { readonly phase: "apply-after-materialization" };

/**
 * Everything the planner may observe. All of it is already-read evidence except
 * {@link CleanMaterializationInput.localRefs}, which stays a callback so the
 * incapable-lineage branch keeps reading live refs exactly when it did before —
 * an unconditional read here would add a Git read to every clean apply.
 */
export interface CleanMaterializationInput {
  readonly identity: CleanMaterializationIdentity;
  readonly incoming: GitSection;
  /** Already-evaluated ignore predicate for the receiver path. */
  readonly ignoredTarget: boolean;
  /** Pre-mutation containment failure message, or undefined when contained. */
  readonly containmentRefusal: string | undefined;
  /** Removal-memory leftover whose identity still equals the memory (§9 [v5]). */
  readonly cleanMaterialize: boolean;
  /** Shape of the on-disk `.git`, or undefined for a genuinely fresh target. */
  readonly dotGit: { readonly isDirectory: boolean } | undefined;
  readonly stateNonce: string | undefined;
  localRefs: () => Promise<Record<string, string>>;
  readonly degradedMutex: boolean;
  readonly chainTimings: GitChainTimings | undefined;
  readonly warningSink: ((message: string) => void) | undefined;
  /** Design 93 §6/§9 window, already decided by the repository-bound config
   * receiver. This transition never re-derives due/ownership/target eligibility;
   * the receiver lends it only the after-materialization operation. */
  readonly config: CleanMaterializationConfigPhase;
  /** Config baseline an unapplied partial must carry forward. */
  readonly inheritedConfigBase: GitPartialApply["configBase"];
  /** Composer inputs for the intended BASE transition. The suppressed manifest
   * projection is deliberately NOT the prior here: §130 retains the protected
   * BASE anchor in the repo record. */
  readonly baseComposition: { readonly prior: RepoBaseValue; readonly candidate: RepoBaseValue };
}

export interface BoundCleanMaterializationPlan {
  readonly status: "bound";
  readonly identity: CleanMaterializationIdentity;
  readonly incoming: GitSection;
  /** Quarantine-then-wipe authority. Capture-grade quarantine runs inside
   * applyGitState AFTER artifact verification, so a missing artifact can never
   * strand a wiped repo; this flag only authorizes it. */
  readonly wipeLeftover: boolean;
  /** A durable capable state lineage is the precondition for authoring typed
   * A/P/K branch transitions at all. */
  readonly capableLineage: boolean;
  readonly stateOptions: Omit<CleanApplyStateOptions, "branchTransitions">;
  readonly config: CleanMaterializationConfigPhase;
  readonly inheritedConfigBase: GitPartialApply["configBase"];
  readonly baseComposition: { readonly prior: RepoBaseValue; readonly candidate: RepoBaseValue };
}

export interface RefusedCleanMaterializationPlan {
  readonly status: "refused";
  readonly identity: CleanMaterializationIdentity;
  readonly reason: string;
  readonly deferralReason: GitDeferralReason;
}

export type CleanMaterializationPlan = BoundCleanMaterializationPlan | RefusedCleanMaterializationPlan;

/**
 * The complete sidecar transition a successful materialization produces. Every
 * field is a final value, not a delta. `"retain"` is the third state the
 * held-ref path needs: a partial apply publishes no BASE at all, and writing or
 * deleting the applied slot would both be wrong.
 */
export interface CleanMaterializationTransition {
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

/** The physical Git facts the same receipt is composed from. */
export interface CleanMaterializationPhysicalReceipt {
  readonly heldRefs: ReadonlyArray<readonly [string, string]>;
  readonly filteredRefs: readonly string[];
  readonly branchTransitions: NonNullable<ApplyGitResult["branchTransitions"]>;
  readonly safeRefTransitions: NonNullable<ApplyGitResult["safeRefTransitions"]>;
  readonly configApplied: boolean;
  readonly refsWiped: boolean;
}

export type CleanMaterializationReceipt =
  | {
      readonly identity: CleanMaterializationIdentity;
      readonly status: "materialized";
      readonly physical: CleanMaterializationPhysicalReceipt;
      readonly transition: CleanMaterializationTransition;
      readonly announcement: string;
    }
  | {
      readonly identity: CleanMaterializationIdentity;
      readonly status: "deferred";
      readonly reason: string;
      readonly deferralReason: GitDeferralReason;
      readonly configLaneDeferred: boolean;
    };

/**
 * The effect vocabulary of this transition. Authority discovery — follower
 * protocol preparation, repository context, the config lane, the mutation-gate
 * lease — is supplied by the caller; the executor only sequences it.
 */
export interface CleanMaterializationEffects {
  readonly identity: CleanMaterializationIdentity;
  runMutation<T>(fn: () => Promise<T>): Promise<T>;
  applyState(options: CleanApplyStateOptions): Promise<ApplyGitResult>;
  /** Memoized follower-branch protocol; a hold throws with its exact reason. */
  branchProtocol(ctx: RepoCtx): Promise<FollowerBranchProtocol>;
  repoContext(): Promise<RepoCtx>;
  applyConfig(): Promise<boolean>;
  log(message: string): void;
}

export class CleanMaterializationIdentityMismatch extends Error {
  constructor(plan: CleanMaterializationIdentity, port: CleanMaterializationIdentity) {
    super(`clean materialization plan for ${plan.root}/${plan.relPath} (${plan.incomingKey}) cannot execute against ${port.root}/${port.relPath} (${port.incomingKey})`);
    this.name = "CleanMaterializationIdentityMismatch";
  }
}

function sameMaterializationIdentity(
  left: CleanMaterializationIdentity,
  right: CleanMaterializationIdentity,
): boolean {
  return left.root === right.root
    && left.relPath === right.relPath
    && left.repoDir === right.repoDir
    && left.incomingKey === right.incomingKey;
}

/** Engine refusal wording is the only classification input, and its precedence
 * is load-bearing: a busy repo whose message also names an artifact stays
 * git-busy, and a quarantine failure is never an artifact fault. */
export function classifyCleanApplyDeferral(reason: string): GitDeferralReason {
  return /worktree-ownership|ownership-deferred/.test(reason) ? "worktree-ownership"
    : reason.includes("busy") ? "git-busy"
    : /\bconfig\b/i.test(reason) ? "config"
    : /quarantine/i.test(reason) ? "other"
    : /artifact|bundle|decrypt|import/i.test(reason) ? "artifact"
    : /unsupported|invalid git section/i.test(reason) ? "unsupported"
    : "other";
}

/**
 * Design 43 §7/§9 [v2, B5; v5]. Every refusal is decided here, before any
 * effect: an ignored or escaping target never reaches a mutation, and branch
 * materialization without a durable capable lineage never authors an
 * unprovable BASE.
 */
export async function planCleanMaterialization(
  input: CleanMaterializationInput,
): Promise<CleanMaterializationPlan> {
  const refuse = (reason: string, deferralReason: GitDeferralReason): RefusedCleanMaterializationPlan =>
    ({ status: "refused", identity: input.identity, reason, deferralReason });

  if (input.ignoredTarget) {
    return refuse("target is inside an ignored subtree — refusing to materialize", "ignored-target");
  }
  if (input.containmentRefusal !== undefined) return refuse(input.containmentRefusal, "containment");

  // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
  // update-only apply is the whole treatment; the memory clears on success.
  const wipeLeftover = input.cleanMaterialize && input.dotGit !== undefined && input.dotGit.isDirectory;
  const capableLineage = /^[0-9a-f]{32}$/.test(input.stateNonce ?? "");
  if (!capableLineage) {
    const remoteBranches = Object.keys(input.incoming.refs).some((ref) => ref.startsWith("refs/heads/"));
    const localBranches = input.dotGit
      ? Object.keys(await input.localRefs().catch(() => ({}))).some((ref) => ref.startsWith("refs/heads/"))
      : false;
    if (remoteBranches || (wipeLeftover && localBranches)) {
      return refuse("branch materialization requires a durable capable state lineage", "artifact");
    }
  }

  return {
    status: "bound",
    identity: input.identity,
    incoming: input.incoming,
    wipeLeftover,
    capableLineage,
    stateOptions: {
      ...(input.degradedMutex ? { legacyWholeSectionOwnership: true } : {}),
      ...(wipeLeftover ? { beforeMutateWipesRefs: true, cleanWipeRefs: true } : {}),
      ...(input.chainTimings ? { chainTimings: input.chainTimings } : {}),
      ...(input.warningSink ? { warningSink: input.warningSink } : {}),
    },
    config: input.config,
    inheritedConfigBase: input.inheritedConfigBase,
    baseComposition: input.baseComposition,
  };
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
  effects: CleanMaterializationEffects,
): ApplyBranchTransitionAdapter {
  return {
    commit: async (input: ApplyBranchTransitionInput) => {
      const protocol = await effects.branchProtocol(input.ctx);
      const logicalBaseOid = protocol.logicalBaseRefs[input.ref] ?? null;
      if (input.afterOid === null && logicalBaseOid === null && input.beforeOid !== null) {
        await runUpdateRefTransaction(repoDir, [
          ...input.extraTransactionLines,
          `delete ${input.ref} ${input.beforeOid}`,
        ]);
        return {
          ref: input.ref,
          beforeOid: input.beforeOid,
          afterOid: null,
          inverseLines: [`create ${input.ref} ${input.beforeOid}`],
        };
      }
      const plan = await planBranchTransition({
        repoDir,
        binding: protocol.binding,
        ref: input.ref,
        beforeOid: input.beforeOid,
        afterOid: input.afterOid,
        logicalBaseOid,
        extraTransactionLines: input.extraTransactionLines,
        ...(input.expectedReflogFingerprint ? { expectedReflogFingerprint: input.expectedReflogFingerprint } : {}),
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
  identity: CleanMaterializationIdentity,
  progress: Pick<GitPartialApply, "appliedRefs" | "heldRefs" | "configApplied">,
  inheritedConfigBase: GitPartialApply["configBase"],
): GitPartialApply {
  return {
    incomingKey: identity.incomingKey,
    checkoutPending: false,
    appliedRefs: progress.appliedRefs,
    heldRefs: progress.heldRefs,
    configApplied: progress.configApplied,
    ...(!progress.configApplied && inheritedConfigBase !== undefined ? { configBase: inheritedConfigBase } : {}),
  };
}

/**
 * Consumes an already-bound plan: no refusal, authority discovery, or protocol
 * preparation happens here. The receipt carries the physical Git facts and the
 * one logical transition composed from them, so a caller can never commit a
 * BASE that its own execution did not witness.
 */
export async function executeCleanMaterialization(
  plan: BoundCleanMaterializationPlan,
  effects: CleanMaterializationEffects,
): Promise<CleanMaterializationReceipt> {
  if (!sameMaterializationIdentity(plan.identity, effects.identity)) {
    throw new CleanMaterializationIdentityMismatch(plan.identity, effects.identity);
  }
  const { identity, incoming } = plan;
  const res = await effects.runMutation(() => effects.applyState({
    ...plan.stateOptions,
    ...(plan.capableLineage ? { branchTransitions: cleanBranchTransitions(identity.repoDir, effects) } : {}),
  }));

  if (!res.applied) {
    const reason = res.reason ?? "apply deferred";
    return {
      identity,
      status: "deferred",
      reason,
      deferralReason: classifyCleanApplyDeferral(reason),
      configLaneDeferred: /\bconfig\b/i.test(reason),
    };
  }

  // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
  try {
    await assertGitTargetWithinRoot(identity.root, identity.relPath);
  } catch (e) {
    effects.log(`git-sync WARNING ${identity.relPath}: post-apply containment check failed: ${errMsg(e)}`);
  }

  const held = Object.entries(res.heldRefs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const configApplied = plan.config.phase === "not-due" ? plan.config.applied : await effects.applyConfig();

  const physical: CleanMaterializationPhysicalReceipt = {
    heldRefs: held,
    filteredRefs: res.filteredRefs ?? [],
    branchTransitions: res.branchTransitions ?? {},
    safeRefTransitions: res.safeRefTransitions ?? {},
    configApplied,
    refsWiped: plan.wipeLeftover,
  };
  const announcement =
    `git-sync applied ${identity.relPath}${held.length
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
    for (const [ref, oid] of Object.entries(incoming.refs)) {
      if (!heldSet.has(ref) && !filtered.has(ref) && transitionPartials[ref] === undefined) {
        transitionPartials[ref] = { kind: "direct", oid };
      }
    }
    return {
      identity,
      status: "materialized",
      physical,
      announcement,
      transition: {
        appliedSection: "retain",
        pending: incoming,
        partial: partialFor(identity, {
          appliedRefs: transitionPartials,
          heldRefs: Object.fromEntries(held.map(([ref]) => [ref, "ownership" as const])),
          configApplied,
        }, plan.inheritedConfigBase),
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
    : partialFor(identity, { appliedRefs: {}, heldRefs: {}, configApplied: false }, plan.inheritedConfigBase);

  if (res.branchTransitions || res.safeRefTransitions) {
    const protocol = await effects.branchProtocol(await effects.repoContext());
    const branchWitnesses = Object.fromEntries(Object.entries(res.branchTransitions ?? {})
      .flatMap(([ref, transition]) => transition.witness ? [[ref, transition.witness] as const] : []));
    const safeRefWitnesses = res.safeRefTransitions ?? {};
    const proof: RepoBaseProof = {
      authority: {
        kind: "pull-ref-transaction",
        lineageHash: protocol.lineageHash,
        repositoryIdentityHash: protocol.repositoryIdentityHash,
        incomingKey: identity.incomingKey,
        branchWitnesses,
        safeRefWitnesses,
      },
      lockedProof: {
        repoKind: (await effects.repoContext()).kind,
        effectiveRefScope: plan.wipeLeftover ? "all" : incoming.refScope,
        checkoutComplete: true,
        incomingKey: identity.incomingKey,
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
    const composed = composeRepoBase(plan.baseComposition.prior, plan.baseComposition.candidate, proof.authority, proof.lockedProof);
    const pends = composed.disposition === "pending";
    return {
      identity,
      status: "materialized",
      physical,
      announcement,
      transition: {
        appliedSection: composed.base ?? null,
        pending: pends ? incoming : null,
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
    identity,
    status: "materialized",
    physical,
    announcement,
    transition: {
      appliedSection: incoming,
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
