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
export const BLOB_CIPHERTEXT_TAG_BYTES = 16;

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
 *
 * Snapshot-first (concurrent-write safety): the source is copied to an IMMUTABLE
 * snapshot temp ONCE, and `plaintextSha`, the ciphertext, and `encSha` all derive
 * from that single image. Without this, a live-edited file (agents / builds writing
 * constantly in a dev workspace) could change BETWEEN the key-deriving hash and the
 * encrypting read, so the ciphertext would encrypt bytes that don't match the
 * recorded `plaintextSha` — the blob uploads + commits fine but fails its download
 * integrity check (`decryptFileToPath` asserts the recovered plaintext hashes to
 * `plaintextSha`), leaving the file permanently un-pullable. With the snapshot,
 * `plaintextSha` recorded in the manifest ALWAYS matches the plaintext that decrypts
 * from the blob. `copyFile` is not an atomic filesystem snapshot, so a file changed
 * DURING the copy can land a torn image — but that image is self-consistent (hashing
 * and encrypting both read the completed copy), so it still round-trips cleanly; the
 * daemon's churn detection re-queues the file and a later sync commits the settled
 * bytes. No integrity error either way.
 *
 * `tmpDir` MUST be a private (owner-only) directory: the snapshot is a transient
 * plaintext copy of the source. All callers pass an `fs.mkdtemp` dir (mode 0700),
 * and the default below is likewise `mkdtemp` — same protection as the ciphertext
 * temps that already lived here, and no plaintext beyond what the source file itself
 * already exposes on this disk. The snapshot is deleted the moment encryption
 * finishes (below), bounding that transient copy.
 */
export async function encryptFileToTemp(srcPath: string, kek: Buffer, tmpDir?: string): Promise<EncryptedBlob> {
  // Track whether WE created the dir: on the default path an early error must not
  // leak an empty `rbox-enc-*` temp dir (the caller can't clean a dir it never saw).
  const ownDir = tmpDir === undefined;
  const dir = tmpDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "rbox-enc-")));
  // Immutable snapshot: read `srcPath` ONCE into a per-call temp so hashing and
  // encrypting see identical bytes even if the live file keeps changing. Named by
  // random bytes (not content — the plaintext sha isn't known until after hashing)
  // so concurrent calls never share a path.
  const snapPath = path.join(dir, `${randomBytes(8).toString("hex")}.snap`);
  let snapDone = false;
  let ctPath: string | undefined;
  try {
    await fs.copyFile(srcPath, snapPath); // single read of the live file → immutable copy
    const plaintextSha = await hashFile(snapPath); // fresh hash of the snapshot bytes
    const { dek, nonce } = deriveKeyNonce(kek, plaintextSha);
    // Unique per CALL, not per content: concurrent encryption of two identical-
    // content files (same plaintextSha — common: empty files, boilerplate) must not
    // write the same temp path, or the interleaved writes corrupt it (sha mismatch).
    ctPath = path.join(dir, `${plaintextSha}.${randomBytes(8).toString("hex")}.ct`);

    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(AAD);
    await pipeline(fsSync.createReadStream(snapPath), cipher, fsSync.createWriteStream(ctPath));
    await fs.appendFile(ctPath, cipher.getAuthTag()); // tag at EOF
    // Snapshot is consumed — delete it NOW (before hashing/stat'ing the ciphertext)
    // to bound peak disk to a single extra copy rather than snapshot + ciphertext.
    await fs.rm(snapPath, { force: true }).catch(() => {});
    snapDone = true;

    const encSha = await hashFile(ctPath);
    const cipherSize = (await fs.stat(ctPath)).size;
    return { plaintextSha, encSha, ciphertextPath: ctPath, cipherSize };
  } catch (e) {
    // On any failure, don't leak the ciphertext temp either (the snapshot is cleaned
    // in `finally`); the caller only removes the ciphertext on success. If we created
    // the temp dir, remove it too so the default path leaves nothing behind.
    if (ctPath) await fs.rm(ctPath, { force: true }).catch(() => {});
    if (ownDir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    // Safety net: no-op if already deleted after the pipeline; guarantees the
    // plaintext snapshot never outlives this call even on the error path.
    if (!snapDone) await fs.rm(snapPath, { force: true }).catch(() => {});
  }
}

/**
 * Decrypt a ciphertext file to `destPath`, verifying the GCM tag and then that the
 * recovered plaintext hashes to `plaintextSha`. Throws (and removes any partial
 * output) on tamper / wrong key / mismatch.
 */
export async function decryptFileToPath(ctPath: string, kek: Buffer, plaintextSha: string, destPath: string): Promise<void> {
  const { dek, nonce } = deriveKeyNonce(kek, plaintextSha);
  const total = (await fs.stat(ctPath)).size;
  if (total < BLOB_CIPHERTEXT_TAG_BYTES) throw new Error("ciphertext too short");
  const tag = Buffer.alloc(BLOB_CIPHERTEXT_TAG_BYTES);
  const fh = await fs.open(ctPath, "r");
  try {
    await fh.read(tag, 0, BLOB_CIPHERTEXT_TAG_BYTES, total - BLOB_CIPHERTEXT_TAG_BYTES);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    const contentLen = total - BLOB_CIPHERTEXT_TAG_BYTES;
    if (contentLen === 0) {
      // Empty plaintext (e.g. .gitkeep, __init__.py): the ciphertext is tag-only,
      // so there's no body to stream — the range [0, -1] is invalid. Verify the
      // GCM tag over zero bytes and write the empty file.
      const out = Buffer.concat([decipher.update(Buffer.alloc(0)), decipher.final()]); // final() throws on a bad tag
      await fs.writeFile(destPath, out);
    } else {
      await pipeline(fsSync.createReadStream(ctPath, { start: 0, end: contentLen - 1 }), decipher, fsSync.createWriteStream(destPath));
    }
    const actual = await hashFile(destPath);
    if (actual !== plaintextSha) throw new Error(`decrypt integrity mismatch: ${actual} != ${plaintextSha}`);
  } catch (e) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw e;
  }
}
