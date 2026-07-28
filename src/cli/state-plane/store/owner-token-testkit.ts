/**
 * TEST-ONLY mint seam for CAS ownership tokens.
 *
 * `casOwnerTokenFromLock` (owner-token.ts) is the sole PRODUCTION mint site: it
 * needs a real held `OwnedLock`. Tests that drive the CAS without a lock — to
 * exercise rejection, retry, and hostile-callback paths — mint their token here
 * instead, through the one clearly-named seam. Production code must never import
 * this module; `owner-token.test.ts` enforces that.
 */
import type { OwnedLockCasToken } from "./owner-token.js";

/** Mint a branded CAS token backed by an arbitrary predicate, for tests only. */
export function casOwnerTokenForTest(isOwner: () => boolean): OwnedLockCasToken {
  return { isOwner } as OwnedLockCasToken;
}
