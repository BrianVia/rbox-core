/**
 * The concrete `OwnedLock` → `CasOwnerToken` bridge (thermo sweep #4, T1.1
 * step 3; design 163 §U3).
 *
 * The JSON authority checks its publication lease asynchronously
 * (`OwnedLock.isOwner`), but the SQLite CAS checks ownership synchronously both
 * before its writes and immediately before commit. This factory adapts the held
 * lock's synchronous, no-follow observation into the synchronous
 * `CasOwnerToken` the store consumes — and it is the ONLY mint site, so a token
 * always carries the provenance of an exact held lock rather than a bare
 * `{ isOwner }` literal. The CLI owns the factory so the engine never imports a
 * CLI type: the engine exposes `isOwnerSync`, and state-plane brands the token.
 */
import type { OwnedLock } from "../../../engine/git/lockfile.js";
import type { CasOwnerToken } from "../ports.js";

declare const casOwnerTokenBrand: unique symbol;

/** A `CasOwnerToken` provably minted from a held `OwnedLock`. The brand is
 * private to this module, so it cannot be forged elsewhere. */
export type OwnedLockCasToken = CasOwnerToken & { readonly [casOwnerTokenBrand]: "owned-lock" };

/** Mint the CAS ownership token for the exact lock the caller holds. Each
 * `isOwner()` call re-observes the marker with no path following, so a stolen or
 * released lease is seen synchronously by the CAS. */
export function casOwnerTokenFromLock(lock: OwnedLock): OwnedLockCasToken {
  return { isOwner: () => lock.isOwnerSync() } as OwnedLockCasToken;
}
