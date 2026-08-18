/**
 * Compile-fixture (thermo sweep #4, T1.1 step 3): the CAS admission boundary
 * only accepts a branded `OwnedLockCasToken`. A bare structural `{ isOwner }`
 * must NOT authorize a commit — that is the whole point of the OwnedLock →
 * CasOwnerToken bridge, and it is enforced here by the type checker.
 *
 * Never: runtime behavior.
 */
import type { CasPacket } from "./write-packet.js";
import { casOwnerTokenForTest } from "./owner-token-testkit.js";

// @ts-expect-error a bare { isOwner } is not a branded OwnedLockCasToken, so it
// cannot be assigned where a CAS commit authorization is required.
const _rejected: CasPacket["ownerToken"] = { isOwner: () => true };

// The branded token minted through the seam is accepted at the same boundary.
const _accepted: CasPacket["ownerToken"] = casOwnerTokenForTest(() => true);

void _rejected;
void _accepted;
export {};
