/**
 * How a BASE-writing seam names the authority it composes under.
 *
 * Three composition sites used to answer that question with an implicit
 * `migrationRepoBaseProof()` — blanket authority the store seam reserves for the
 * tagged migration importer — so an ordinary write was either laundered as a
 * migration or would be rejected outright once the store became the authority.
 * Neither answer is available here any more. What replaces it depends on whether
 * the seam is looking at the real predecessor:
 *
 *   - `provisionalRepoBaseProof` composes a CANDIDATE packet against a snapshot
 *     that may already be stale, so it never refuses on the SHAPE of a delta: a
 *     stale-looking change is indistinguishable from a real one until the
 *     generation CAS settles it. Absent a supplied proof it falls back to carry
 *     authority, which HOLDS every unwitnessed ref move instead of installing
 *     it, so the worst case is a held candidate the CAS rejects on generation.
 *
 *   - `requireRepoBaseProof` admits a transition at the seam that holds the
 *     state lock and the true predecessor. There a proofless BASE move is a
 *     fact, not a race, so it is refused with `ProoflessBaseError`.
 *
 * "Unchanged" is measured on exactly what an authority decides — the branch and
 * safe refs — because every other GitSection field is copied from whichever
 * family wins, identically under any kind. When the governed refs agree (or the
 * candidate proposes no section at all), `composeRepoBase` returns byte-
 * identical output under carry and migration authority alike: both retain every
 * predecessor ref and hold on every would-be change. So the derived carry proof
 * records the truth that this write minted no new authority, while the
 * section's non-governed fields advance as they always have.
 */
import { isDeepStrictEqual } from "node:util";
import { ProoflessBaseError } from "../state-plane/errors.js";
import {
  authorityGovernedRefs,
  carryRepoBaseProof,
  recordOriginLineage,
  type RepoBaseProof,
  type RepoBaseValue,
} from "./base-composer.js";

/** An omitted candidate lane retains the predecessor; a deep-equal one moves nothing. */
const laneUnchanged = <T>(candidate: T | undefined, previous: T | undefined): boolean =>
  candidate === undefined || isDeepStrictEqual(candidate, previous);

const governedRefsUnchanged = (previous: RepoBaseValue, candidate: RepoBaseValue): boolean =>
  candidate.base === undefined
  || isDeepStrictEqual(authorityGovernedRefs(candidate.base), authorityGovernedRefs(previous.base));

export function baseSemanticallyUnchanged(previous: RepoBaseValue, candidate: RepoBaseValue): boolean {
  return governedRefsUnchanged(previous, candidate)
    && laneUnchanged(candidate.branchBaseOrigins, previous.branchBaseOrigins);
}

/** Carry authority bound to the lineage the retained record already records. */
const carriedFrom = (previous: RepoBaseValue): RepoBaseProof =>
  carryRepoBaseProof(recordOriginLineage(previous.branchBaseOrigins) ?? "legacy-untrusted");

/**
 * No ordinary state write carries blanket authority — not a forged structural
 * `{ kind: "migration" }`, and not even a genuinely minted one. Legacy adoption
 * happens in `state-plane/migration/base-proof.ts` and never reaches a packet,
 * so refusing the kind outright is both simpler and stricter than checking a
 * token: it needs no identity that a canonical-JSON round trip would destroy,
 * and it holds against a caller that reconstructed the shape by hand.
 *
 * Unlike a proofless BASE move, this is never a staleness artifact — the
 * authority a caller names does not depend on how old its snapshot is — so both
 * seams refuse it. Blanket authority never reaches these seams: it is confined
 * to the SQLite migration importer, and the legacy published-checkout recovery
 * installs from an observed-landing proof, not from blanket authority.
 */
function refuseBlanketAuthority(relPath: string, supplied: RepoBaseProof): void {
  if (supplied.authority?.kind === "migration") {
    throw new ProoflessBaseError(
      relPath,
      "blanket migration authority is reserved for legacy import and may not authorize a state write",
    );
  }
}

export function provisionalRepoBaseProof(
  relPath: string,
  supplied: RepoBaseProof | undefined,
  previous: RepoBaseValue,
): RepoBaseProof {
  if (supplied === undefined) return carriedFrom(previous);
  refuseBlanketAuthority(relPath, supplied);
  return supplied;
}

export function requireRepoBaseProof(
  relPath: string,
  supplied: RepoBaseProof | undefined,
  previous: RepoBaseValue,
  candidate: RepoBaseValue,
): RepoBaseProof {
  if (supplied !== undefined) {
    refuseBlanketAuthority(relPath, supplied);
    return supplied;
  }
  if (!baseSemanticallyUnchanged(previous, candidate)) {
    throw new ProoflessBaseError(relPath, governedRefsUnchanged(previous, candidate)
      ? "the write moves branch base origins but supplied no repoProofs entry"
      : "the write introduces or changes BASE branch/safe refs but supplied no repoProofs entry");
  }
  return carriedFrom(previous);
}
