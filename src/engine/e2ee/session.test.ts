import { describe, expect, test } from "bun:test";
import {
  bootstrapAccount,
  buildCommit,
  createWorkspaceKey,
  openCommit,
  openOwnMasterKey,
  openWorkspaceKey,
  recoverMasterKey,
  verifyAccount,
} from "./session.js";
import { GENESIS_PARENT_HASH } from "./commit.js";
import { phraseToRk, toB64url, utf8 } from "./index.js";

const NOW = 1_900_000_000_000;

async function bootedAccount() {
  const boot = await bootstrapAccount("acct_s", "devA", NOW);
  return boot;
}

describe("session — account bootstrap", () => {
  test("emits a 24-word recovery phrase and a verifiable genesis roster+keystate", async () => {
    const boot = await bootedAccount();
    expect(boot.recoveryPhrase.split(" ")).toHaveLength(24);
    const account = await verifyAccount([boot.upload.genesisRoster], [boot.upload.genesisKeyState], NOW + 1000);
    expect(account.rosters).toHaveLength(1);
    expect([...account.rosters[0]!.devices.map((d) => d.deviceId)].sort()).toEqual(["devA", "recovery"]);
  });
});

describe("session — workspace key round-trip", () => {
  test("createWorkspaceKey then openWorkspaceKey returns the same KEK", async () => {
    const boot = await bootedAccount();
    const { kek, kekWrap } = await createWorkspaceKey(boot.secrets, "ws1");
    expect(toB64url(await openWorkspaceKey(boot.secrets, kekWrap))).toBe(toB64url(kek));
  });

  test("a wrong key epoch refuses to open the KEK", async () => {
    const boot = await bootedAccount();
    const { kekWrap } = await createWorkspaceKey(boot.secrets, "ws1", 0);
    await expect(openWorkspaceKey(boot.secrets, kekWrap, 1)).rejects.toThrow();
  });
});

describe("session — single-machine commit round-trip", () => {
  test("buildCommit → openCommit decrypts the manifest", async () => {
    const boot = await bootedAccount();
    const { kek } = await createWorkspaceKey(boot.secrets, "ws1");
    const account = await verifyAccount([boot.upload.genesisRoster], [boot.upload.genesisKeyState], NOW + 1000);
    const manifest = utf8(JSON.stringify({ files: [{ path: "a.ts" }] }));
    const built = await buildCommit({
      secrets: boot.secrets,
      workspaceId: "ws1",
      kek,
      keyEpoch: 0,
      accountEpoch: 0,
      rosterVersion: 0,
      seq: 1,
      parentSeq: 0,
      parentCommitHash: GENESIS_PARENT_HASH,
      manifestJson: manifest,
      blobRefs: [],
    });
    const opened = await openCommit({ secrets: boot.secrets, kek, account, commit: built.commit, encManifest: built.encManifest, workspaceId: "ws1" });
    expect(Buffer.from(opened).equals(Buffer.from(manifest))).toBe(true);
  });
});

describe("session — recovery + own-device MK unwrap", () => {
  test("recovery phrase re-derives MK from the recovery wrap", async () => {
    const boot = await bootedAccount();
    const rk = await phraseToRk(boot.recoveryPhrase);
    const mk = await recoverMasterKey("acct_s", 0, rk, boot.upload.recoveryWrap);
    expect(toB64url(mk)).toBe(toB64url(boot.secrets.mk));
  });

  test("a device opens its own RSA MK wrap (keystore reload on same device)", async () => {
    const boot = await bootedAccount();
    const { encPubSpki, encPrivPkcs8, sigPubKey, sigPrivPkcs8, accountId, deviceId } = boot.secrets;
    const mk = await openOwnMasterKey({ accountId, deviceId, encPubSpki, encPrivPkcs8, sigPubKey, sigPrivPkcs8 }, 0, boot.upload.device.mkWrap);
    expect(toB64url(mk)).toBe(toB64url(boot.secrets.mk));
  });

  test("a wrong recovery phrase fails to unwrap MK", async () => {
    const boot = await bootedAccount();
    const wrong = await phraseToRk((await bootstrapAccount("x", "y", NOW)).recoveryPhrase);
    await expect(recoverMasterKey("acct_s", 0, wrong, boot.upload.recoveryWrap)).rejects.toThrow();
  });
});
