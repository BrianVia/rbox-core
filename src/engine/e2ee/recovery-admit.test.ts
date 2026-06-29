import { describe, expect, test } from "bun:test";
import { assertMkWrapAuthorized, bootstrapAccount, buildRecoveryAdmission, verifyAccount } from "./session.js";
import { phraseToRk } from "./recovery.js";
import { activeSigners } from "./roster.js";

const NOW = 1_900_000_000_000;

describe("recovery admission (D5 / §14.7)", () => {
  test("a recovery device admits itself via the phrase; its wrap is C7-authorized", async () => {
    const boot = await bootstrapAccount("acct_rec", "devA", NOW);
    // Simulate total device loss: a brand-new device holds only the phrase.
    const rk = await phraseToRk(boot.recoveryPhrase);
    const rec = await buildRecoveryAdmission({
      accountId: "acct_rec",
      accountEpoch: 0,
      deviceId: "devRecovered",
      recoveryKey: rk,
      recoveryWrap: boot.upload.recoveryWrap,
      prevRoster: boot.upload.genesisRoster,
      now: NOW + 1000,
    });

    // The recovery-signed roster verifies, and the recovered device is active.
    const account = await verifyAccount([boot.upload.genesisRoster, rec.admissionRoster], [boot.upload.genesisKeyState], NOW + 2000);
    expect(account.rosters).toHaveLength(2);
    expect([...activeSigners(account.currentRoster).keys()].sort()).toEqual(["devA", "devRecovered", "recovery"]);

    // Its MK self-wrap is authorized by the signed roster entry (D5).
    await assertMkWrapAuthorized(rec.device.mkWrap, account);
    // The recovered MK equals the original (same account master key).
    expect(Buffer.from(rec.secrets.mk).equals(Buffer.from(boot.secrets.mk))).toBe(true);
  });

  test("admitting a deviceId already in the roster is rejected (CLI must use a fresh id)", async () => {
    const boot = await bootstrapAccount("acct_rec3", "devA", NOW);
    const rk = await phraseToRk(boot.recoveryPhrase);
    // Reusing an existing roster deviceId (e.g. "devA") produces a duplicate → reject.
    const rec = await buildRecoveryAdmission({
      accountId: "acct_rec3",
      accountEpoch: 0,
      deviceId: "devA", // collides with the genesis device
      recoveryKey: rk,
      recoveryWrap: boot.upload.recoveryWrap,
      prevRoster: boot.upload.genesisRoster,
      now: NOW + 1000,
    });
    await expect(verifyAccount([boot.upload.genesisRoster, rec.admissionRoster], [boot.upload.genesisKeyState], NOW + 2000)).rejects.toThrow(/duplicate deviceId/);
  });

  test("a wrong recovery phrase cannot unwrap MK", async () => {
    const boot = await bootstrapAccount("acct_rec2", "devA", NOW);
    const wrongRk = await phraseToRk((await bootstrapAccount("x", "y", NOW)).recoveryPhrase);
    await expect(
      buildRecoveryAdmission({ accountId: "acct_rec2", accountEpoch: 0, deviceId: "devR", recoveryKey: wrongRk, recoveryWrap: boot.upload.recoveryWrap, prevRoster: boot.upload.genesisRoster, now: NOW + 1000 })
    ).rejects.toThrow();
  });
});
