/** Repository BASE proof for live legacy-manifest adoption and SQLite composition. */
import type { GitSection } from "../../engine/index.js";
import {
  composeRepoBase,
  type MigrationBaseAuthority,
  type RepoBaseProof,
  type RepoBaseValue,
} from "../sync-git/base-composer.js";

/**
 * The single mint. `MigrationBaseAuthority` carries a non-exported brand, so
 * this cast is the only way a value of that type comes into existence — an
 * inline `{ kind: "migration", … }` elsewhere no longer type-checks as one.
 */
export function migrationRepoBaseProof(lineageHash = "legacy-untrusted"): RepoBaseProof {
  const authority = Object.freeze({ kind: "migration", lineageHash }) as unknown as MigrationBaseAuthority;
  return {
    authority,
    lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
  };
}

/**
 * Adopt a legacy manifest Git section as this repository's first BASE record.
 * There is no predecessor to witness against, so blanket authority is required.
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
