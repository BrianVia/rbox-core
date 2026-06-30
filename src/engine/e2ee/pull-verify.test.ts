import { describe, expect, test } from "bun:test";
import { assertMkWrapAuthorized, bootstrapAccount, buildCommit, createWorkspaceKey, openCommit, verifyAccount, verifyCommitChain, type DeviceSecrets, type VerifiedAccount } from "./session.js";
import { GENESIS_PARENT_HASH, type SignedCommit } from "./commit.js";
import { aesGcmWrap, generateMasterKey } from "./keys.js";
import { utf8 } from "./primitives.js";

const NOW = 1_900_000_000_000;

async function fixture() {
  const boot = await bootstrapAccount("acct_pv", "devA", NOW);
  const { kek } = await createWorkspaceKey(boot.secrets, "ws1");
  const account = await verifyAccount([boot.upload.genesisRoster], [boot.upload.genesisKeyState]);
  return { boot, kek, account };
}

async function commitAt(secrets: DeviceSecrets, kek: Uint8Array, seq: number, parentSeq: number, parentCommitHash: string, accountEpoch = 0): Promise<SignedCommit> {
  const b = await buildCommit({
    secrets,
    workspaceId: "ws1",
    kek,
    keyEpoch: 0,
    accountEpoch,
    rosterVersion: 0,
    seq,
    parentSeq,
    parentCommitHash,
    manifestJson: utf8(JSON.stringify({ files: [{ path: `f${seq}.ts` }] })),
    blobRefs: [],
  });
  return b.commit;
}

describe("verifyCommitChain (C1 — chain descent / anti-rollback)", () => {
  test("verifies a hash-linked chain from genesis and from a pin", async () => {
    const { boot, kek, account } = await fixture();
    const c1 = await commitAt(boot.secrets, kek, 1, 0, GENESIS_PARENT_HASH);
    const c2 = await commitAt(boot.secrets, kek, 2, 1, c1.commitHash);
    const head = await verifyCommitChain([c1, c2], null, account);
    expect(head!.commitHash).toBe(c2.commitHash);
    // from a pin at seq1 → only c2 is sent
    const headFromPin = await verifyCommitChain([c2], { commitSeq: 1, commitHash: c1.commitHash }, account);
    expect(headFromPin!.commitHash).toBe(c2.commitHash);
  });

  test("rejects a broken parent link (splice/rollback evident)", async () => {
    const { boot, kek, account } = await fixture();
    const c1 = await commitAt(boot.secrets, kek, 1, 0, GENESIS_PARENT_HASH);
    const forged = await commitAt(boot.secrets, kek, 2, 1, "ff".repeat(32)); // wrong parent hash
    await expect(verifyCommitChain([c1, forged], null, account)).rejects.toThrow(/chain break/);
  });

  test("rejects a chain that doesn't descend from the pin", async () => {
    const { boot, kek, account } = await fixture();
    const c2 = await commitAt(boot.secrets, kek, 2, 1, "aa".repeat(32));
    await expect(verifyCommitChain([c2], { commitSeq: 1, commitHash: "bb".repeat(32) }, account)).rejects.toThrow(/chain break/);
  });
});

describe("openCommit (C4 — disjunctive reject)", () => {
  test("rejects a commit at a stale/unknown accountEpoch even from an active signer", async () => {
    const { boot, kek, account } = await fixture(); // currentEpoch = 0
    const future = await commitAt(boot.secrets, kek, 1, 0, GENESIS_PARENT_HASH, 1); // epoch 1 != 0
    await expect(
      openCommit({ secrets: boot.secrets, kek, account, commit: future, encManifest: new Uint8Array(40), workspaceId: "ws1" })
    ).rejects.toThrow(/accountEpoch|not active/);
  });

  test("accepts a current-epoch commit from an active signer", async () => {
    const { boot, kek, account } = await fixture();
    const b = await buildCommit({
      secrets: boot.secrets,
      workspaceId: "ws1",
      kek,
      keyEpoch: 0,
      accountEpoch: 0,
      rosterVersion: 0,
      seq: 1,
      parentSeq: 0,
      parentCommitHash: GENESIS_PARENT_HASH,
      manifestJson: utf8(JSON.stringify({ files: [] })),
      blobRefs: [],
    });
    const opened = await openCommit({ secrets: boot.secrets, kek, account, commit: b.commit, encManifest: b.encManifest, workspaceId: "ws1" });
    expect(JSON.parse(Buffer.from(opened).toString("utf8"))).toEqual({ files: [] });
  });
});

describe("assertMkWrapAuthorized (C7 — wrap-hash binding)", () => {
  test("accepts the genesis device wrap, rejects an unsigned substitute", async () => {
    const { boot, account } = await fixture();
    await assertMkWrapAuthorized(boot.upload.device.mkWrap, account); // in mkWrapHashes → ok
    // a wrap the server could try to substitute — never signed into roster/key-state
    const rogue = await aesGcmWrap(generateMasterKey(), generateMasterKey(), { accountId: "acct_pv", accountEpoch: 0, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/device/v1" });
    await expect(assertMkWrapAuthorized(rogue, account)).rejects.toThrow(/not authorized/);
  });
});
