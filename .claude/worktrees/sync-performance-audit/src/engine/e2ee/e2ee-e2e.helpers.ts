/** In-memory convergent blob encryption mirroring the V4-5 derivation used by the
 *  streaming file path (src/engine/crypto.ts): HKDF(KEK,"rbox/blob/v1",sha)→
 *  key||nonce, constant AAD. Used by the e2e test to encrypt a file blob without
 *  touching disk. */
import { aesGcmEncrypt, hkdf, sha256Hex, utf8 } from "./primitives.js";

export async function encryptFileNameProbe(kek: Uint8Array, plaintext: Uint8Array): Promise<{ plaintextSha: string; encSha: string; ciphertext: Uint8Array }> {
  const plaintextSha = await sha256Hex(plaintext);
  const kn = await hkdf(kek, utf8("rbox/blob/v1"), hexToBytes(plaintextSha), 44);
  const ciphertext = await aesGcmEncrypt(kn.subarray(0, 32), kn.subarray(32, 44), plaintext, utf8("rbox/blob/v1"));
  return { plaintextSha, encSha: await sha256Hex(ciphertext), ciphertext };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
