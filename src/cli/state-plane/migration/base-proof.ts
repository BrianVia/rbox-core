/**
 * Blanket BASE authority, confined to legacy-import territory.
 *
 * `migration` is the one authority kind that composes any candidate refs without
 * a per-branch witness. It lives here, not beside the composer, so no ordinary
 * write path can reach for it as a default when its own purpose-bound proof is
 * missing — the failure mode this module exists to make unavailable.
 *
 * In memory that brand is the whole contract, and the JSON seams refuse the kind
 * outright. Persisting one is a separate problem with a separate token: a proof
 * loses its brand to the canonical-JSON round trip, so the SQLite plane keys off
 * the stage's importer TAG instead — see `./import-stage.ts`. This module stays
 * a leaf so the legacy adoption below can be reached from `sync-state-model.ts`
 * without dragging the store's import graph into a cycle.
 *
 * The set of modules that reach for either mint is pinned by
 * `src/cli/sync-git/base-proof-authority.test.ts`, and both brands by
 * `src/cli/sync-git/migration-authority-surface.typecheck.ts`.
 */
import type { GitSection } from "../../../engine/index.js";
import {
  composeRepoBase,
  type MigrationBaseAuthority,
  type RepoBaseProof,
  type RepoBaseValue,
} from "../../sync-git/base-composer.js";

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


/**
 * The right to adopt blanket `migration` BASE authority through the JSON state
 * store. A recovered v1.7.24 published-checkout journal carries no proof — it
 * predates the proof system — yet its checkout already completed on disk, so the
 * landing must INSTALL the intended base to match reality. That is legacy
 * adoption, exactly what blanket authority is for; the store refuses the kind
 * outright otherwise, so this capability is how the one legitimate JSON-store
 * adoption path says so.
 *
 * Same shape as the importer capability: a module-private object reachable only
 * inside `withLegacyBaseAdoption`'s callback and validated by `===`. Nothing
 * mints, returns, or registers it, so there is no forgeable surface — an
 * ordinary packet write cannot present it and stays refused.
 */
declare const legacyBaseAdoptionBrand: unique symbol;
export interface LegacyBaseAdoptionCapability {
  readonly [legacyBaseAdoptionBrand]: true;
}

const LEGACY_BASE_ADOPTION = Object.freeze({}) as unknown as LegacyBaseAdoptionCapability;

export function withLegacyBaseAdoption<T>(run: (capability: LegacyBaseAdoptionCapability) => T): T {
  return run(LEGACY_BASE_ADOPTION);
}

/** True only for the one module-private object, compared by identity. */
export function isLegacyBaseAdoption(value: unknown): value is LegacyBaseAdoptionCapability {
  return value === LEGACY_BASE_ADOPTION;
}
