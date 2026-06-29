import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { hashFile } from "./hash.js";

/**
 * Convergent blob-content encryption (design 12, V4-5). AES-256-GCM with a
 * per-blob key+nonce derived in ONE HKDF from (workspace KEK, plaintext sha) —
 * deterministic, so identical plaintext encrypts identically and content-
 * addressed dedup survives. The KEK never leaves the device; the server stores
 * only ciphertext.
 *
 * The KEK passed here is the per-(workspace, keyEpoch) KEK — a keyEpoch bump
 * means a FRESH KEK, so a convergent (key,nonce) pair never recurs across epochs.
 * The AAD is the CONSTANT `rbox/blob/v1` (V4-5): putting path/seq/epoch in blob
 * AAD would turn the intended convergence into real GCM nonce-reuse. Keys derive
 * from a FRESHLY re-hashed plaintext sha (never a cached hash). Same plaintext →
 * identical (key,nonce,ciphertext) is the intended dedup, not reuse: the pair
 * repeats only for identical plaintext (identical output, no new leakage).
 */

const AAD = Buffer.from("rbox/blob/v1");
const TAG_BYTES = 16;

export function generateKek(): Buffer {
  return randomBytes(32);
}
/** Recovery phrase: base64url of the 32-byte KEK. Lose it → data unrecoverable. */
export function kekToPhrase(kek: Buffer): string {
  return kek.toString("base64url");
}
export function kekFromPhrase(phrase: string): Buffer {
  const b = Buffer.from(phrase.trim(), "base64url");
  if (b.length !== 32) throw new Error("invalid recovery phrase (expected a 32-byte key)");
  return b;
}

/** Single HKDF → 44 bytes split into the 32-byte key and 12-byte nonce (V4-5).
 *  `AAD` doubles as the HKDF salt: the blob-domain string `rbox/blob/v1` is the
 *  one shared label for this scheme (constant AAD + domain-separated derivation). */
function deriveKeyNonce(kek: Buffer, plaintextSha: string): { dek: Buffer; nonce: Buffer } {
  const out = Buffer.from(hkdfSync("sha256", kek, AAD, Buffer.from(plaintextSha, "hex"), 44));
  return { dek: out.subarray(0, 32), nonce: out.subarray(32, 44) };
}

export interface EncryptedBlob {
  plaintextSha: string;
  encSha: string;
  ciphertextPath: string; // temp file; caller uploads then removes
  cipherSize: number;
}

/**
 * Encrypt `srcPath` to a temp ciphertext file. Re-hashes the actual bytes for key
 * derivation (review finding #1) and returns the ciphertext content-address
 * (`encSha = sha256(ciphertext||tag)`), known only after encryption (finding #3).
 */
export async function encryptFileToTemp(srcPath: string, kek: Buffer, tmpDir?: string): Promise<EncryptedBlob> {
  const plaintextSha = await hashFile(srcPath); // fresh hash of the real bytes
  const { dek, nonce } = deriveKeyNonce(kek, plaintextSha);
  const dir = tmpDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "rbox-enc-")));
  const ctPath = path.join(dir, `${plaintextSha}.ct`);

  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(AAD);
  await pipeline(fsSync.createReadStream(srcPath), cipher, fsSync.createWriteStream(ctPath));
  await fs.appendFile(ctPath, cipher.getAuthTag()); // tag at EOF

  const encSha = await hashFile(ctPath);
  const cipherSize = (await fs.stat(ctPath)).size;
  return { plaintextSha, encSha, ciphertextPath: ctPath, cipherSize };
}

/**
 * Decrypt a ciphertext file to `destPath`, verifying the GCM tag and then that the
 * recovered plaintext hashes to `plaintextSha`. Throws (and removes any partial
 * output) on tamper / wrong key / mismatch.
 */
export async function decryptFileToPath(ctPath: string, kek: Buffer, plaintextSha: string, destPath: string): Promise<void> {
  const { dek, nonce } = deriveKeyNonce(kek, plaintextSha);
  const total = (await fs.stat(ctPath)).size;
  if (total < TAG_BYTES) throw new Error("ciphertext too short");
  const tag = Buffer.alloc(TAG_BYTES);
  const fh = await fs.open(ctPath, "r");
  try {
    await fh.read(tag, 0, TAG_BYTES, total - TAG_BYTES);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fsSync.createReadStream(ctPath, { start: 0, end: total - TAG_BYTES - 1 }), decipher, fsSync.createWriteStream(destPath));
    const actual = await hashFile(destPath);
    if (actual !== plaintextSha) throw new Error(`decrypt integrity mismatch: ${actual} != ${plaintextSha}`);
  } catch (e) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw e;
  }
}
