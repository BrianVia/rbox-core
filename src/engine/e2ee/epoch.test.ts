import { describe, expect, test } from "bun:test";
import { generateSignKeyPair, generateWrapKeyPair, signKeyPairFromSeed, type SignKeyPair } from "./asym.js";
import { buildKeyState, GENESIS_PREV_STATE_HASH, verifyKeyStateChain } from "./epoch.js";
import { hkdf, randomBytes, toB64url, utf8 } from "./primitives.js";
import { buildAdminRoster, buildGenesisRoster, verifyRosterChain, type RosterEntry } from "./roster.js";

const NOW = 1_900_000_000_000;

async function entry(deviceId: string, kind: "device" | "recovery", sig: SignKeyPair): Promise<RosterEntry> {
  const wrap = generateWrapKeyPair();
  return {
    deviceId,
    sigAlg: "Ed25519",
    encAlg: "RSA-OAEP-3072-SHA256",
    sigPubKey: toB64url(sig.publicKey),
    encPubKey: toB64url(wrap.publicKeySpki),
    role: "admin",
    kind,
    addedAt: NOW,
    status: "active",
  };
}

async function fixture() {
  const accountId = "acct_epoch";
  const aSig = generateSignKeyPair();
  const rk = randomBytes(32);
  const rsk = signKeyPairFromSeed(await hkdf(rk, utf8("rbox/recovery/v1"), utf8("recovery-sign"), 32));
  const genesis = await buildGenesisRoster({ accountId, bootstrap: await entry("devA", "device", aSig), recovery: await entry("recovery", "recovery", rsk), bootstrapSignKey: aSig });
  const rosters = await verifyRosterChain([genesis], { now: NOW });
  const rosterHashByVersion = new Map([[0, genesis.rosterHash]]);
  return { accountId, aSig, genesis, rosters, rosterHashByVersion };
}

describe("accountKeyState genesis + chain", () => {
  test("genesis key-state binds roster v0 and verifies under the bootstrap key", async () => {
    const { accountId, aSig, genesis, rosters, rosterHashByVersion } = await fixture();
    const s0 = await buildKeyState({
      accountId,
      accountEpoch: 0,
      prevStateHash: GENESIS_PREV_STATE_HASH,
      rosterVersion: 0,
      rosterHash: genesis.rosterHash,
      keyEpoch: 0,
      mkWrapHashes: ["aa".repeat(32)],
      recoveryWrapId: "rec_0",
      signerDeviceId: "devA",
      signKey: aSig,
    });
    const states = await verifyKeyStateChain([s0], rosters, rosterHashByVersion);
    expect(states[0]!.accountEpoch).toBe(0);
    expect(states[0]!.rosterHash).toBe(genesis.rosterHash);
  });

  test("rejects a key-state whose rosterHash doesn't match the verified roster", async () => {
    const { accountId, aSig, rosters, rosterHashByVersion } = await fixture();
    const s0 = await buildKeyState({
      accountId,
      accountEpoch: 0,
      prevStateHash: GENESIS_PREV_STATE_HASH,
      rosterVersion: 0,
      rosterHash: "ff".repeat(32), // wrong
      keyEpoch: 0,
      mkWrapHashes: [],
      recoveryWrapId: "rec_0",
      signerDeviceId: "devA",
      signKey: aSig,
    });
    await expect(verifyKeyStateChain([s0], rosters, rosterHashByVersion)).rejects.toThrow(/rosterHash does not match/);
  });

  test("rejects a key-state signed by a non-member", async () => {
    const { accountId, genesis, rosters, rosterHashByVersion } = await fixture();
    const s0 = await buildKeyState({
      accountId,
      accountEpoch: 0,
      prevStateHash: GENESIS_PREV_STATE_HASH,
      rosterVersion: 0,
      rosterHash: genesis.rosterHash,
      keyEpoch: 0,
      mkWrapHashes: [],
      recoveryWrapId: "rec_0",
      signerDeviceId: "devGhost",
      signKey: generateSignKeyPair(),
    });
    await expect(verifyKeyStateChain([s0], rosters, rosterHashByVersion)).rejects.toThrow(/not active/);
  });

  test("§31 MAJOR1: epoch-1 signer must be active in epoch-0's roster, not the roster epoch 1 pins", async () => {
    const { accountId, aSig, genesis, rosters: r0, rosterHashByVersion: _r } = await fixture();
    // v1 admits devB (admin devA signs). devB is active in v1 but NOT in v0 (= epoch-0's roster).
    const bSig = generateSignKeyPair();
    const v0body = r0[0]!;
    const devB = await entry("devB", "device", bSig);
    const v1 = await buildAdminRoster(v0body, [...v0body.devices, devB], "devA", aSig);
    const rosters = await verifyRosterChain([genesis, v1], { now: NOW });
    const rhbv = new Map([
      [0, genesis.rosterHash],
      [1, v1.rosterHash],
    ]);
    const s0 = await buildKeyState({
      accountId, accountEpoch: 0, prevStateHash: GENESIS_PREV_STATE_HASH, rosterVersion: 0,
      rosterHash: genesis.rosterHash, keyEpoch: 0, mkWrapHashes: [], recoveryWrapId: "rec_0",
      signerDeviceId: "devA", signKey: aSig,
    });
    const s1Args = {
      accountId, accountEpoch: 1, prevStateHash: s0.stateHash, rosterVersion: 1,
      rosterHash: v1.rosterHash, keyEpoch: 1, mkWrapHashes: [], recoveryWrapId: "rec_1",
    };
    // Signed by devB (only active in v1, the roster epoch 1 pins) → REJECT under the fix.
    const s1Bad = await buildKeyState({ ...s1Args, signerDeviceId: "devB", signKey: bSig });
    await expect(verifyKeyStateChain([s0, s1Bad], rosters, rhbv)).rejects.toThrow(/not active/);
    // Signed by devA (active in epoch-0's roster v0) → ACCEPT.
    const s1Good = await buildKeyState({ ...s1Args, signerDeviceId: "devA", signKey: aSig });
    const states = await verifyKeyStateChain([s0, s1Good], rosters, rhbv);
    expect(states[1]!.accountEpoch).toBe(1);
  });
});
