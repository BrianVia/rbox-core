import { canonicalString } from "../../engine/e2ee/index.js";
import type { TypedBlocker } from "../config.js";
import type { ComposeRepoBaseResult, RepoBaseLockedProof } from "./base-composer.js";

/**
 * The blocker plane of design 174/176/270.
 *
 * One owner for what a held follow's typed blockers MEAN: how a pending BASE
 * composer disposition becomes durable typed evidence, and which of those
 * blockers license a later pull to skip the repository entirely. Every rollout
 * flag that scopes that license lives here too, so the eligibility line is
 * readable in one place. `held-skip.ts` observes and matches inputs; it asks
 * this module the eligibility question and never re-derives it.
 */

export const gitOwnershipHeldSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_OWNERSHIP_HELD_SKIP !== "0";

export const gitOwnershipNoEscalateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_OWNERSHIP_NO_ESCALATE !== "0";

/** Design 270: gates the composer disjunct below AND the artifact-plane digest
 * that licenses it, so the flag's blast radius equals the change's. */
export const gitHeldSkipComposerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.RBOX_GIT_HELD_SKIP_COMPOSER !== "0";

export function sortedTypedBlockers(blockers: readonly TypedBlocker[]): TypedBlocker[] {
  const byKey = new Map<string, TypedBlocker>();
  for (const blocker of blockers) byKey.set(canonicalString(blocker), blocker);
  return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, blocker]) => ({ ...blocker }));
}

export function sameHeldOutcome(a: readonly TypedBlocker[], b: readonly TypedBlocker[]): boolean {
  return canonicalString(sortedTypedBlockers(a)) === canonicalString(sortedTypedBlockers(b));
}

/**
 * "The follow minted no proof for this ref" — causally the same shape as a
 * ref-plane hold: the ref did not advance, and re-running the follow reproduces
 * the same nothing. Every other RepoBaseHoldCode either contradicts an existing
 * proof or structurally refuses the request, which is an independent veto.
 *
 * The exclusion is by CODE, never by the presence of `ref`. The vacuous pending
 * mint carries no code and `checkout-incomplete` carries a code outside the
 * pair, so both are refused on that basis alone — reflessness is incidental to
 * how they are minted today and is NOT a safety property to rely on.
 */
export function composerHoldAllowsSkip(blocker: TypedBlocker): boolean {
  return blocker.provenance === "composer"
    && blocker.reason === "artifact"
    && (blocker.code === "missing-branch-proof" || blocker.code === "missing-safe-ref-proof");
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
      || (blocker.reason === "worktree-ownership" && gitOwnershipHeldSkipEnabled(env))
      || (composerHoldAllowsSkip(blocker) && gitHeldSkipComposerEnabled(env)));
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
