import { describe, expect, test } from "bun:test";
import {
  generateSignKeyPair,
  generateWrapKeyPair,
  rsaUnwrap,
  rsaWrap,
  sign,
  signKeyPairFromSeed,
  signPrivateFromPkcs8,
  signPrivateToPkcs8,
  verify,
} from "./asym.js";
import { randomBytes, utf8 } from "./primitives.js";

describe("ed25519 signing", () => {
  test("sign/verify round-trip; rejects tampered message and wrong key", () => {
    const kp = generateSignKeyPair();
    const msg = utf8("commitHash bytes");
    const sig = sign(kp.privateKey, msg);
    expect(sig.length).toBe(64);
    expect(verify(kp.publicKey, msg, sig)).toBe(true);
    expect(verify(kp.publicKey, utf8("other"), sig)).toBe(false);
    expect(verify(generateSignKeyPair().publicKey, msg, sig)).toBe(false);
  });

  test("from-seed is deterministic (same seed → same pubkey + same signature)", () => {
    const seed = randomBytes(32);
    const a = signKeyPairFromSeed(seed);
    const b = signKeyPairFromSeed(seed);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
    const msg = utf8("admission delta");
    // Ed25519 signatures are deterministic per RFC 8032
    expect(Buffer.from(sign(a.privateKey, msg)).equals(Buffer.from(sign(b.privateKey, msg)))).toBe(true);
    expect(verify(a.publicKey, msg, sign(b.privateKey, msg))).toBe(true);
  });

  test("different seeds → different keys", () => {
    const a = signKeyPairFromSeed(randomBytes(32));
    const b = signKeyPairFromSeed(randomBytes(32));
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false);
  });

  test("private key survives a pkcs8 keystore round-trip", () => {
    const kp = generateSignKeyPair();
    const reimported = signPrivateFromPkcs8(signPrivateToPkcs8(kp.privateKey));
    const msg = utf8("x");
    expect(verify(kp.publicKey, msg, sign(reimported, msg))).toBe(true);
  });

  test("verify is total on malformed inputs (no throw)", () => {
    expect(verify(randomBytes(10), utf8("x"), randomBytes(64))).toBe(false);
    expect(verify(randomBytes(32), utf8("x"), randomBytes(10))).toBe(false);
  });
});

describe("rsa-oaep-3072 device wrap", () => {
  test("wrap/unwrap MK round-trip with a matching label", () => {
    const kp = generateWrapKeyPair();
    const mk = randomBytes(32);
    const label = randomBytes(32); // SHA256(JCS(context)) in real use
    const ct = rsaWrap(kp.publicKeySpki, label, mk);
    const back = rsaUnwrap(kp.privateKey, label, ct);
    expect(Buffer.from(back).equals(Buffer.from(mk))).toBe(true);
  });

  test("a different label fails to unwrap (context binding)", () => {
    const kp = generateWrapKeyPair();
    const mk = randomBytes(32);
    const ct = rsaWrap(kp.publicKeySpki, randomBytes(32), mk);
    expect(() => rsaUnwrap(kp.privateKey, randomBytes(32), ct)).toThrow();
  });

  test("a different keypair cannot unwrap", () => {
    const kp = generateWrapKeyPair();
    const other = generateWrapKeyPair();
    const label = randomBytes(32);
    const ct = rsaWrap(kp.publicKeySpki, label, randomBytes(32));
    expect(() => rsaUnwrap(other.privateKey, label, ct)).toThrow();
  });
});
