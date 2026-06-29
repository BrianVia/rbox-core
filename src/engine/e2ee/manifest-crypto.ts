/**
 * Manifest encryption (design 12, §4 + V4-5/V4-6). The manifest — every path,
 * size, mode, sha, symlink target, git ref — is the metadata we must hide. The
 * client encrypts the serialized manifest under a per-workspace MANIFEST key
 * (distinct from blob keys) with a FRESH RANDOM nonce per commit (non-convergent:
 * manifests change every commit and must not be dedup-correlatable). The server
 * stores the result as an opaque blob addressed by `encManifestSha`.
 *
 * Wire layout of an encrypted manifest blob: `nonce(12) || aesgcm(ct||tag)`.
 */
import { canonicalString } from "./jcs.js";
import { aesGcmDecrypt, aesGcmEncrypt, hkdf, randomBytes, sha256Hex, utf8 } from "./primitives.js";

const MANIFEST_SALT = utf8("rbox/manifest/v1");

/** Per-workspace manifest key, distinct from blob keys (different HKDF domain). */
export function deriveManifestKey(kek: Uint8Array): Promise<Uint8Array> {
  return hkdf(kek, MANIFEST_SALT, utf8("manifest"), 32);
}

function manifestAad(accountId: string, workspaceId: string, keyEpoch: number): Uint8Array {
  return utf8(canonicalString({ accountId, keyEpoch, purpose: "rbox/manifest/v1", workspaceId }));
}

export interface EncryptedManifest {
  /** `nonce || ciphertext` bytes to upload as an opaque blob. */
  bytes: Uint8Array;
  /** Content address = sha256(bytes); the envelope/commit references this. */
  encManifestSha: string;
}

/** Encrypt the serialized manifest JSON. `manifestJson` is the exact bytes the
 *  peer will re-parse after decrypt (callers serialize deterministically). */
export async function encryptManifest(
  kek: Uint8Array,
  accountId: string,
  workspaceId: string,
  keyEpoch: number,
  manifestJson: Uint8Array
): Promise<EncryptedManifest> {
  const key = await deriveManifestKey(kek);
  const nonce = randomBytes(12);
  const ct = await aesGcmEncrypt(key, nonce, manifestJson, manifestAad(accountId, workspaceId, keyEpoch));
  const bytes = new Uint8Array(nonce.length + ct.length);
  bytes.set(nonce, 0);
  bytes.set(ct, nonce.length);
  return { bytes, encManifestSha: await sha256Hex(bytes) };
}

/** Decrypt an encrypted-manifest blob back to the serialized manifest JSON.
 *  Throws on tag/AAD mismatch (wrong key, tamper, or wrong workspace/epoch). */
export async function decryptManifest(
  kek: Uint8Array,
  accountId: string,
  workspaceId: string,
  keyEpoch: number,
  blob: Uint8Array
): Promise<Uint8Array> {
  if (blob.length < 12 + 16) throw new Error("encrypted manifest too short");
  const key = await deriveManifestKey(kek);
  const nonce = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  return aesGcmDecrypt(key, nonce, ct, manifestAad(accountId, workspaceId, keyEpoch));
}
