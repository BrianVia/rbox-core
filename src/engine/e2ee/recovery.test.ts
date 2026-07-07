import { describe, expect, test } from "bun:test";
import { generateRecoveryKey, phraseToRk, recoverySignKeyPair, rkToPhrase, rkWrapKey } from "./recovery.js";
import { fromHex, toHex } from "./primitives.js";
import { sign, verify } from "./asym.js";

describe("bip39 recovery phrase", () => {
  test("rk → phrase → rk round-trips, 24 words", async () => {
    const rk = generateRecoveryKey();
    const phrase = await rkToPhrase(rk);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(toHex(await phraseToRk(phrase))).toBe(toHex(rk));
  });

  test("matches the canonical BIP39 all-zeros test vector", async () => {
    // entropy of 32 zero bytes → the well-known "abandon ... art" mnemonic
    const rk = fromHex("00".repeat(32));
    const phrase = await rkToPhrase(rk);
    expect(phrase).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
    );
    expect(toHex(await phraseToRk(phrase))).toBe("00".repeat(32));
  });

  test("matches the canonical all-0x7f test vector", async () => {
    const phrase = await rkToPhrase(fromHex("7f".repeat(32)));
    expect(phrase).toBe(
      "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
    );
  });

  test("rejects a one-word typo via checksum", async () => {
    // FIXED vector, not a random key: a one-word swap passes the 8-bit BIP39
    // checksum ~1/256 of the time, so the randomized form flaked in CI
    // (2026-07-07). This phrase+swap is verified to fail checksum, always.
    const phrase =
      "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
    const words = phrase.split(" ");
    words[0] = "zoo";
    await expect(phraseToRk(words.join(" "))).rejects.toThrow(/checksum|word/);
  });

  test("rejects unknown words and wrong length", async () => {
    await expect(phraseToRk("notabip39word ".repeat(24).trim())).rejects.toThrow(/valid recovery word/);
    await expect(phraseToRk("abandon abandon")).rejects.toThrow(/24 words/);
  });

  test("normalizes case and extra whitespace", async () => {
    const rk = fromHex("00".repeat(32));
    const phrase = await rkToPhrase(rk);
    const messy = "  " + phrase.toUpperCase().replace(/ /g, "   ") + "  ";
    expect(toHex(await phraseToRk(messy))).toBe("00".repeat(32));
  });
});

describe("recovery key derivations", () => {
  test("rkWrapKey is deterministic, 32 bytes", async () => {
    const rk = generateRecoveryKey();
    const a = await rkWrapKey(rk);
    const b = await rkWrapKey(rk);
    expect(a.length).toBe(32);
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(await rkWrapKey(generateRecoveryKey()))).not.toBe(toHex(a));
  });

  test("recoverySignKeyPair is deterministic and usable", async () => {
    const rk = generateRecoveryKey();
    const kp1 = await recoverySignKeyPair(rk);
    const kp2 = await recoverySignKeyPair(rk);
    expect(toHex(kp1.publicKey)).toBe(toHex(kp2.publicKey));
    const msg = new TextEncoder().encode("recovery admits a device");
    expect(verify(kp1.publicKey, msg, sign(kp2.privateKey, msg))).toBe(true);
  });
});
