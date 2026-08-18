/** Public follow surface and receive/check-out orchestration.
 *
 * Never: ref mutation mechanics, transaction/journal ownership, ORIG_HEAD/D4a recovery mechanics,
 * or state persistence.
 */
import { validateGitSection } from "../../engine/index.js";
import { checkoutTransactionSupported } from "./checkout-txn.js";
import { incomingOwnershipRoots, ownershipProofContext } from "./reachability.js";
import { indexIdentityV2 } from "./index-identity.js";
import { addClassifyTimedMs, addTimedMs } from "./chain-timings.js";
import { readAllRefsStrict } from "./refs.js";
import { headBranchOf } from "./git-state.js";
import { git } from "../../engine/git-spawn.js";
import { pruneOrigHeadRecoveryRefs } from "./orig-head.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { checkoutJournalBinding } from "./follow-journal.js";
import { candidateIndexCollision, deriveBaseIndexProjection, indexArtifact, stageIncoming } from "./follow-staging.js";
import { readLive } from "./follow-live.js";
import { classifyCheckout } from "./follow-classify.js";
import { appliedTerminalOid, effectiveRefs, selectCheckoutSelfRootWitness } from "./follow-ref-witness.js";
import { RefPlaneTransaction, type CheckoutCommitInput } from "./ref-plane-transaction.js";
import {
  deferResult,
  progressWithBlocker,
  WorktreeOwnershipUnreadableError,
  type FollowOptions,
  type FollowProgress,
  type FollowResult,
  type StagedIncoming,
} from "./follow-types.js";

export {
  FollowCrashInjectedError,
  opStateRootOf,
  type FollowCrashPoint,
  type FollowIntended,
  type FollowProgress,
  type FollowResult,
} from "./follow-types.js";
export {
  checkoutJournalBinding,
  clearFollowJournal,
  quarantineUnboundFollowJournal,
  recoverAndLandFollowJournal,
  recoverFollowJournal,
} from "./follow-journal.js";
export { deriveBaseIndexProjection, indexArtifact, stageIncoming } from "./follow-staging.js";
export {
  classifyCheckoutOwnership,
  firstReason,
  type CheckoutOwnershipClassification,
} from "./follow-classify.js";
export { selectCheckoutSelfRootWitness, type CheckoutSelfRootWitness } from "./follow-ref-witness.js";


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
    const strictLiveRefs = await readAllRefsStrict(opts.ctx.repoDir);
    if (strictLiveRefs.status === "unreadable") {
      return deferResult(emptyProgress, "ref-read-unreadable", `ref-read-unreadable: ${strictLiveRefs.marker}`);
    }
    const liveBefore = await readLive(opts.ctx, opts.chainTimings, strictLiveRefs.refs);
    if (!liveBefore) return deferResult(emptyProgress, "unreadable", "git metadata could not be read");
    const baseProjection = opts.record?.idxProj ?? await addTimedMs(opts.chainTimings, "indexOpStateMs", () =>
      deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined));
    const initialOwnershipContext = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
      ownershipProofContext(opts.ctx));
    const effectiveBaseIndexProjection = indexArtifact(opts.base) ? baseProjection : null;
    const effective = effectiveRefs(opts.ctx, opts.incoming);
    const incomingHeadRef = headBranchOf(opts.incoming.head);
    const ownershipSection = { ...opts.incoming, refs: effective.refs };
    const roots = incomingOwnershipRoots(ownershipSection, { prefix: staged.incomingNs, opState: staged.opBytes });
    // R2-3 adjudication: safe-ref publication intentionally precedes the state
    // save. A crash/republication reaches the same design-LWW outcome; the
    // displaced value is incoming-owned, remains reachable, and the design's
    // idempotency clause covers the retry. Do not move this behind the checkout
    // journal absent a new normative design change.
    const refTransaction = new RefPlaneTransaction(
      opts,
      liveBefore,
      roots,
      initialOwnershipContext,
      effective,
      incomingHeadRef,
    );
    let refProgress: Awaited<ReturnType<RefPlaneTransaction["publishIndependentRefs"]>>;
    try {
      refProgress = await refTransaction.publishIndependentRefs(staged, baseProjection);
    } catch (error) {
      if (!(error instanceof WorktreeOwnershipUnreadableError)) throw error;
      return deferResult(
        emptyProgress,
        "unreadable",
        error.message,
      );
    }
    const progress: FollowProgress = refProgress;
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
    const durableIncomingRefs = Object.fromEntries(Object.entries(progress.appliedRefs).flatMap(([ref, value]) => {
      const terminal = appliedTerminalOid(value);
      return terminal ? [[ref, terminal] as const] : [];
    }));
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

    const first = await addClassifyTimedMs(opts.chainTimings, () => classifyCheckout({
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
      ownershipContext: initialOwnershipContext,
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

    const checkoutInput: CheckoutCommitInput = { staged, first, checkoutRoots };
    if (selfRootWitness) checkoutInput.selfRootWitness = selfRootWitness;
    if (baseProjection !== undefined) checkoutInput.baseProjection = baseProjection;
    const checkout = await refTransaction.commitCheckout(checkoutInput);
    if (checkout.status === "defer") {
      // Design 278 M1: ONLY the connectivity proof's typed code stores an
      // attempt here. Every other checkout defer — above all a boundary race,
      // whose `local-commits`/`worktree-ownership` reasons the held allowlist
      // already admits on reason alone — must stay attempt-less so the next pull
      // re-attempts it immediately instead of stalling to the hourly floor.
      // The proof runs pre-commit and publishes nothing, so the repository still
      // stands at `trustedFingerprint`; `observeHeldInputs` re-reads and refuses
      // the store if anything moved, exactly like the two existing sites.
      if (checkout.code === "connectivity-unproven") await opts.afterHeldClassification?.({
        phase: "defer",
        trustedFingerprint,
        effectiveBaseIndexProjection,
        effectiveIncomingIndexProjection,
        blockers: checkout.result.blockers,
        reflogPaths: checkout.result.consultedReflogPaths ?? [],
        progress: checkout.result,
      });
      return checkout.result;
    }
    const { progress: postProgress, origHeadPreservation } = checkout;
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
      await opts.beforeFinalLive?.();
      const finalOwnershipContext = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        ownershipProofContext(opts.ctx));
      const finalLive = await readLive(opts.ctx, opts.chainTimings);
      if (finalLive) {
        const finalRef = await RefPlaneTransaction.classifyExistingRefs(opts, finalLive, roots, finalOwnershipContext);
        const finalCheckout = await addClassifyTimedMs(opts.chainTimings, () => classifyCheckout({
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
          ownershipContext: finalOwnershipContext,
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
