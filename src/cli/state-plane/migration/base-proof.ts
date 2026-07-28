/**
 * Blanket BASE authority, confined to legacy-import territory.
 *
 * `migration` is the one authority kind that composes any candidate refs without
 * a per-branch witness, which is why the store seam admits it only from the
 * tagged migration importer. It lives here, not beside the composer, so no
 * ordinary write path can reach for it as a default when its own purpose-bound
 * proof is missing — the failure mode this module exists to make unavailable.
 *
 * The importer set is pinned by the contract test in
 * `src/cli/sync-git/base-proof-authority.test.ts`.
 */
import type { GitSection } from "../../../engine/index.js";
import { composeRepoBase, type RepoBaseProof, type RepoBaseValue } from "../../sync-git/base-composer.js";

export function migrationRepoBaseProof(lineageHash = "legacy-untrusted"): RepoBaseProof {
  return {
    authority: { kind: "migration", lineageHash },
    lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
  };
}

/**
 * Adopt a pre-record sync state's manifest Git section as this repository's
 * first BASE record. There is no predecessor to witness against, so the import
 * is exactly the case blanket authority is for.
 */
export function adoptLegacyManifestRepoBase(candidate: GitSection | undefined): RepoBaseValue {
  const proof = migrationRepoBaseProof();
  const composed = composeRepoBase({}, candidate === undefined ? {} : { base: candidate },
    proof.authority, proof.lockedProof);
  return {
    ...(composed.base === undefined ? {} : { base: composed.base }),
    ...(composed.branchBaseOrigins === undefined ? {} : { branchBaseOrigins: composed.branchBaseOrigins }),
  };
}
