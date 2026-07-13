import { describe, expect, test } from "bun:test";
import { aesGcmDecrypt, aesGcmEncrypt, ctEqual, fromB64url, fromHex, hkdf, randomBytes, sha256Hex, toB64url, toHex, utf8 } from "./primitives.js";

describe("encodings", () => {
  test("b64url round-trips arbitrary bytes (no padding, url-safe)", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 100]) {
      const b = randomBytes(n);
      const s = toB64url(b);
      expect(s).not.toContain("=");
      expect(s).not.toContain("+");
      expect(s).not.toContain("/");
      expect(Buffer.from(fromB64url(s)).equals(Buffer.from(b))).toBe(true);
    }
  });

  test("hex round-trips and matches known vector", () => {
    expect(toHex(new Uint8Array([0, 255, 16]))).toBe("00ff10");
    expect(Buffer.from(fromHex("00ff10")).equals(Buffer.from([0, 255, 16]))).toBe(true);
  });

  test("sha256Hex matches the known empty-string digest", async () => {
    expect(await sha256Hex(utf8(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("hkdf", () => {
  test("is deterministic and domain-separated by info", async () => {
    const ikm = randomBytes(32);
    const salt = utf8("salt");
    const a1 = await hkdf(ikm, salt, utf8("rbox/blob/v1"), 32);
    const a2 = await hkdf(ikm, salt, utf8("rbox/blob/v1"), 32);
    const b = await hkdf(ikm, salt, utf8("rbox/manifest/v1"), 32);
    expect(toHex(a1)).toBe(toHex(a2)); // deterministic
    expect(toHex(a1)).not.toBe(toHex(b)); // different info → different key
  });

  test("RFC 5869 test vector 1 (SHA-256)", async () => {
    const ikm = fromHex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
    const salt = fromHex("000102030405060708090a0b0c");
    const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
    const okm = await hkdf(ikm, salt, info, 42);
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
  });
});

describe("aes-256-gcm", () => {
  test("round-trips with matching key/nonce/aad", async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = utf8("rbox/blob/v1");
    const pt = utf8("the manifest contents nobody should see");
    const ct = await aesGcmEncrypt(key, nonce, pt, aad);
    expect(Buffer.from(ct).equals(Buffer.from(pt))).toBe(false); // actually encrypted
    const back = await aesGcmDecrypt(key, nonce, ct, aad);
    expect(Buffer.from(back).equals(Buffer.from(pt))).toBe(true);
  });

  test("fails on wrong key, wrong aad, or tampered ciphertext", async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = utf8("rbox/manifest/v1");
    const ct = await aesGcmEncrypt(key, nonce, utf8("secret"), aad);
    await expect(aesGcmDecrypt(randomBytes(32), nonce, ct, aad)).rejects.toThrow();
    await expect(aesGcmDecrypt(key, nonce, ct, utf8("other-aad"))).rejects.toThrow();
    const tampered = new Uint8Array(ct);
    tampered[0] ^= 0xff;
    await expect(aesGcmDecrypt(key, nonce, tampered, aad)).rejects.toThrow();
  });

  test("convergent: identical key+nonce+plaintext+aad → identical ciphertext", async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = utf8("rbox/blob/v1");
    const pt = utf8("dedup me");
    const a = await aesGcmEncrypt(key, nonce, pt, aad);
    const b = await aesGcmEncrypt(key, nonce, pt, aad);
    expect(toHex(a)).toBe(toHex(b));
  });

  test("rejects a non-32-byte key", async () => {
    await expect(aesGcmEncrypt(randomBytes(16), randomBytes(12), utf8("x"), utf8(""))).rejects.toThrow();
  });
});

describe("ctEqual", () => {
  test("true for equal, false for different or different length", () => {
    expect(ctEqual(fromHex("aabb"), fromHex("aabb"))).toBe(true);
    expect(ctEqual(fromHex("aabb"), fromHex("aabc"))).toBe(false);
    expect(ctEqual(fromHex("aabb"), fromHex("aa"))).toBe(false);
  });
});
