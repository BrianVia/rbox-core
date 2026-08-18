/**
 * The migration-confinement contract, checked by the compiler rather than by a
 * grep over import specifiers.
 *
 * `MigrationBaseAuthority` carries a non-exported `unique symbol` brand, so a
 * structural `{ kind: "migration", lineageHash }` written anywhere — with any
 * import specifier, or none at all — is not assignable to the authority union.
 * The only way to obtain one is the deliberate cast inside
 * `state-plane/base-proof.ts`. Deleting a brand fails `bun run
 * typecheck` here, before any test runs.
 */
import type { ComposeRepoBaseAuthority, MigrationBaseAuthority } from "./base-composer.js";

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

export type MigrationAuthoritySurfacePins = [
  _BlanketAuthorityIsUnforgeable,
  _MintedAuthorityIsStillAnAuthority,
];
