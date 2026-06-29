/**
 * Account key-state / epoch transition (design 12, V4-2). One signed, hash-
 * chained object binds — atomically — the roster, the key epoch, the set of
 * valid MK-wrap blobs, the recovery wrap, and the revoked devices for an account
 * epoch. It is the genesis trust root (E=0 binds roster v0's hash under the
 * MK-authenticated bootstrap key) and the revocation mechanism (E→E+1 rotates
 * MK/KEK so a revoked device gets no future key material).
 *
 * Clients reject any new-epoch key material unless a valid accountKeyState for
 * that epoch exists, signed by an admin active in epoch E−1 (genesis: the
 * bootstrap device, which must be in roster v0).
 */
import { sign, verify, type SignKeyPair } from "./asym.js";
import { canonicalString, verifyRoundTrip } from "./jcs.js";
import { fromB64url, fromHex, sha256Hex, toB64url, utf8 } from "./primitives.js";
import { activeSigners, type RosterBody } from "./roster.js";

const GENESIS_PREV_STATE = "0".repeat(64);

export interface AccountKeyState {
  type: "rbox/account-key-state/v1";
  accountId: string;
  accountEpoch: number;
  prevStateHash: string; // genesis: 64 zeros
  rosterVersion: number;
  rosterHash: string; // pins the roster valid at this epoch
  keyEpoch: number;
  mkWrapHashes: string[]; // sorted hashes of the MK-wrap blobs valid this epoch
  recoveryWrapId: string;
  revokedDeviceIds: string[]; // sorted
}

export interface SignedKeyState {
  body: string; // canonical JSON of AccountKeyState
  stateHash: string; // hex
  signerDeviceId: string;
  stateSig: string; // b64url over stateHash
}

function sortUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export async function buildKeyState(args: {
  accountId: string;
  accountEpoch: number;
  prevStateHash: string;
  rosterVersion: number;
  rosterHash: string;
  keyEpoch: number;
  mkWrapHashes: string[];
  recoveryWrapId: string;
  revokedDeviceIds?: string[];
  signerDeviceId: string;
  signKey: SignKeyPair;
}): Promise<SignedKeyState> {
  const body: AccountKeyState = {
    type: "rbox/account-key-state/v1",
    accountId: args.accountId,
    accountEpoch: args.accountEpoch,
    prevStateHash: args.prevStateHash,
    rosterVersion: args.rosterVersion,
    rosterHash: args.rosterHash,
    keyEpoch: args.keyEpoch,
    mkWrapHashes: sortUnique(args.mkWrapHashes),
    recoveryWrapId: args.recoveryWrapId,
    revokedDeviceIds: sortUnique(args.revokedDeviceIds ?? []),
  };
  const bodyStr = canonicalString(body);
  const stateHash = await sha256Hex(utf8(bodyStr));
  const stateSig = toB64url(sign(args.signKey.privateKey, fromHex(stateHash)));
  return { body: bodyStr, stateHash, signerDeviceId: args.signerDeviceId, stateSig };
}

export const GENESIS_PREV_STATE_HASH = GENESIS_PREV_STATE;

function parseKeyState(s: SignedKeyState): AccountKeyState {
  const body = verifyRoundTrip(s.body) as AccountKeyState; // parse + assert canonical form
  if (body.type !== "rbox/account-key-state/v1") throw new Error("not an account-key-state/v1");
  return body;
}

/**
 * Verify the epoch chain against the verified roster bodies (index = version).
 * Each accountKeyState_v{E} must: link to prev (prevStateHash), pin a rosterHash
 * that matches the verified roster at its rosterVersion, and be signed by a device
 * active in the roster of epoch E−1 (genesis E=0: signed by a device active in
 * roster v0 = the bootstrap device). Returns the verified states (index = epoch).
 */
export async function verifyKeyStateChain(chain: SignedKeyState[], rosters: RosterBody[], rosterHashByVersion: Map<number, string>): Promise<AccountKeyState[]> {
  if (chain.length === 0) throw new Error("empty key-state chain");
  const states: AccountKeyState[] = [];
  for (let e = 0; e < chain.length; e++) {
    const sk = chain[e]!;
    const body = parseKeyState(sk);
    if (body.accountEpoch !== e) throw new Error(`key-state epoch gap: expected ${e}, got ${body.accountEpoch}`);
    if ((await sha256Hex(utf8(sk.body))) !== sk.stateHash) throw new Error(`key-state ${e}: hash mismatch`);
    if (e === 0) {
      if (body.prevStateHash !== GENESIS_PREV_STATE) throw new Error("genesis key-state must have zero prevStateHash");
    } else if (body.prevStateHash !== chain[e - 1]!.stateHash) {
      throw new Error(`key-state ${e}: broken prev link`);
    }
    // rosterHash must match the verified roster at the named version.
    const expectRosterHash = rosterHashByVersion.get(body.rosterVersion);
    if (!expectRosterHash || expectRosterHash !== body.rosterHash) throw new Error(`key-state ${e}: rosterHash does not match verified roster v${body.rosterVersion}`);

    // Signer must be active in the roster of epoch e-1 (genesis: roster v0).
    const signerRoster = signerRosterFor(e, body, rosters);
    const signers = activeSigners(signerRoster);
    const pub = signers.get(sk.signerDeviceId);
    if (!pub) throw new Error(`key-state ${e}: signer ${sk.signerDeviceId} not active in the authorizing roster`);
    if (!verify(pub, fromHex(sk.stateHash), fromB64url(sk.stateSig))) throw new Error(`key-state ${e}: signature invalid`);
    states.push(body);
  }
  return states;
}

/** The roster that authorizes epoch e's key-state: for genesis, roster v0; for a
 *  rotation, the roster from the PREVIOUS epoch's key-state. */
function signerRosterFor(e: number, body: AccountKeyState, rosters: RosterBody[]): RosterBody {
  if (e === 0) {
    const v0 = rosters.find((r) => r.version === 0);
    if (!v0) throw new Error("genesis key-state: roster v0 missing");
    return v0;
  }
  // The authorizing roster is the one pinned by epoch e (rotation is signed by an
  // admin already active before the rotation took effect).
  const r = rosters.find((x) => x.version === body.rosterVersion);
  if (!r) throw new Error(`key-state ${e}: authorizing roster v${body.rosterVersion} missing`);
  return r;
}
