/**
 * The migration-confinement contract, checked by the compiler rather than by a
 * grep over import specifiers.
 *
 * `MigrationBaseAuthority` carries a non-exported `unique symbol` brand, so a
 * structural `{ kind: "migration", lineageHash }` written anywhere — with any
 * import specifier, or none at all — is not assignable to the authority union.
 * The only way to obtain one is the deliberate cast inside
 * `state-plane/migration/base-proof.ts`. Deleting a brand fails `bun run
 * typecheck` here, before any test runs.
 *
 * The same shape pins the SQLite side. A persisted proof loses its brand to the
 * canonical-JSON round trip, so what has to be unforgeable there is the STAGE'S
 * IMPORTER TAG, which survives sealing and is what re-admission trusts. That tag
 * is gated on `MigrationImporterCapability`, branded the same way.
 */
import type { ComposeRepoBaseAuthority, MigrationBaseAuthority } from "./base-composer.js";
import type { MigrationImporterCapability } from "../state-plane/store/transition-admission.js";

type Assert<T extends true> = T;

/** What the old union allowed anyone to write inline. */
interface StructuralMigrationAuthority {
  kind: "migration";
  lineageHash: string;
}

type _BlanketAuthorityIsUnforgeable = Assert<
  StructuralMigrationAuthority extends ComposeRepoBaseAuthority ? false : true
>;

/** The branded variant remains a member of the union the composer switches on. */
type _MintedAuthorityIsStillAnAuthority = Assert<
  MigrationBaseAuthority extends ComposeRepoBaseAuthority ? true : false
>;

/** What a forger would write to claim the reserved importer lane. */
interface StructuralImporterCapability {
  kind: "state-plane-migration-importer/v1";
}

type _ImporterCapabilityIsUnforgeable = Assert<
  StructuralImporterCapability extends MigrationImporterCapability ? false : true
>;

/** An empty object cannot stand in for it either. */
type _EmptyObjectIsNotTheCapability = Assert<
  Record<string, never> extends MigrationImporterCapability ? false : true
>;

export type MigrationAuthoritySurfacePins = [
  _BlanketAuthorityIsUnforgeable,
  _MintedAuthorityIsStillAnAuthority,
  _ImporterCapabilityIsUnforgeable,
  _EmptyObjectIsNotTheCapability,
];
