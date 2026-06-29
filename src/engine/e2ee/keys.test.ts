import { describe, expect, test } from "bun:test";
import { generateSignKeyPair, generateWrapKeyPair } from "./asym.js";
import {
  aesGcmUnwrap,
  aesGcmWrap,
  generateMasterKey,
  generateWorkspaceKek,
  recipientKeyHash,
  rsaDeviceUnwrap,
  rsaDeviceWrap,
  wrapHash,
  type WrapContext,
} from "./keys.js";
import { decryptManifest, encryptManifest } from "./manifest-crypto.js";
import { toHex, utf8 } from "./primitives.js";

const mkCtx = (over: Partial<WrapContext> = {}): WrapContext => ({
  accountId: "acct_1",
  accountEpoch: 0,
  wrappedKeyKind: "MK",
  purpose: "rbox/mk-wrap/recovery/v1",
  ...over,
});

describe("aes-gcm wrap (KEK-under-MK, MK-under-RK)", () => {
  test("wrap/unwrap round-trip under matching context", async () => {
    const wrapping = generateMasterKey();
    const kek = generateWorkspaceKek();
    const ctx = mkCtx({ wrappedKeyKind: "KEK", purpose: "rbox/kek-wrap/v1", keyEpoch: 3 });
    const w = await aesGcmWrap(wrapping, kek, ctx);
    expect(toHex(await aesGcmUnwrap(wrapping, w, ctx))).toBe(toHex(kek));
  });

  test("rejects a context mismatch before decrypting (epoch/account/purpose)", async () => {
    const wrapping = generateMasterKey();
    const ctx = mkCtx({ wrappedKeyKind: "KEK", purpose: "rbox/kek-wrap/v1", keyEpoch: 3 });
    const w = await aesGcmWrap(wrapping, generateWorkspaceKek(), ctx);
    await expect(aesGcmUnwrap(wrapping, w, { ...ctx, accountEpoch: 1 })).rejects.toThrow(/context mismatch/);
    await expect(aesGcmUnwrap(wrapping, w, { ...ctx, keyEpoch: 4 })).rejects.toThrow(/context mismatch/);
  });

  test("wrong wrapping key fails the GCM tag", async () => {
    const ctx = mkCtx();
    const w = await aesGcmWrap(generateMasterKey(), generateMasterKey(), ctx);
    await expect(aesGcmUnwrap(generateMasterKey(), w, ctx)).rejects.toThrow();
  });
});

describe("rsa device wrap (MK-to-device)", () => {
  test("wrap MK to a device pubkey, unwrap with its private key", async () => {
    const dev = generateWrapKeyPair();
    const mk = generateMasterKey();
    const ctx = mkCtx({ purpose: "rbox/mk-wrap/device/v1", recipientKeyHash: await recipientKeyHash(dev.publicKeySpki) });
    const w = await rsaDeviceWrap(dev.publicKeySpki, mk, ctx);
    expect(w.recipientKeyHash).toBe(await recipientKeyHash(dev.publicKeySpki));
    expect(toHex(await rsaDeviceUnwrap(dev.privateKey, w, ctx))).toBe(toHex(mk));
  });

  test("another device cannot unwrap", async () => {
    const dev = generateWrapKeyPair();
    const other = generateWrapKeyPair();
    const ctx = mkCtx({ purpose: "rbox/mk-wrap/device/v1" });
    const w = await rsaDeviceWrap(dev.publicKeySpki, generateMasterKey(), ctx);
    await expect(rsaDeviceUnwrap(other.privateKey, w, ctx)).rejects.toThrow();
  });

  test("wrapHash is stable for equal wraps (deviceWrapHash binding)", async () => {
    const dev = generateWrapKeyPair();
    const mk = generateMasterKey();
    const ctx = mkCtx({ purpose: "rbox/mk-wrap/device/v1" });
    const w = await rsaDeviceWrap(dev.publicKeySpki, mk, ctx);
    const h = await wrapHash(w);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await wrapHash({ ...w })).toBe(h);
  });
});

describe("manifest crypto", () => {
  const manifest = utf8(JSON.stringify({ files: [{ path: "src/secret.ts", sha256: "ab".repeat(32), size: 10 }] }));

  test("encrypt → decrypt round-trips, ciphertext hides plaintext", async () => {
    const kek = generateWorkspaceKek();
    const enc = await encryptManifest(kek, "acct_1", "ws_1", 0, manifest);
    expect(enc.encManifestSha).toMatch(/^[0-9a-f]{64}$/);
    // the path string must not appear in the ciphertext
    expect(Buffer.from(enc.bytes).includes(Buffer.from("src/secret.ts"))).toBe(false);
    const back = await decryptManifest(kek, "acct_1", "ws_1", 0, enc.bytes);
    expect(Buffer.from(back).equals(Buffer.from(manifest))).toBe(true);
  });

  test("non-convergent: same manifest encrypts to different bytes each time", async () => {
    const kek = generateWorkspaceKek();
    const a = await encryptManifest(kek, "acct_1", "ws_1", 0, manifest);
    const b = await encryptManifest(kek, "acct_1", "ws_1", 0, manifest);
    expect(a.encManifestSha).not.toBe(b.encManifestSha);
  });

  test("wrong workspace/epoch/key fails to decrypt (AAD + key binding)", async () => {
    const kek = generateWorkspaceKek();
    const enc = await encryptManifest(kek, "acct_1", "ws_1", 0, manifest);
    await expect(decryptManifest(kek, "acct_1", "ws_2", 0, enc.bytes)).rejects.toThrow();
    await expect(decryptManifest(kek, "acct_1", "ws_1", 1, enc.bytes)).rejects.toThrow();
    await expect(decryptManifest(generateWorkspaceKek(), "acct_1", "ws_1", 0, enc.bytes)).rejects.toThrow();
  });
});
