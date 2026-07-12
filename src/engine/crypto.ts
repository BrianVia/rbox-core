import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { hashBytes, hashFile } from "./hash.js";
import type { InMemoryEncryptedBlob } from "./crypto-worker-protocol.js";

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
const ZSTD_LEVEL = 3;
const COMPRESS_MIN_BYTES = 128;
const COMPRESS_RATIO = 0.95;
const BUFFERED_COMPRESS_MAX_BYTES = 4 * 1024 * 1024;

type ZstdZlib = typeof zlib & {
  createZstdCompress?: (options?: { level?: number }) => Transform;
  createZstdDecompress?: () => Transform;
};
const zstd = zlib as ZstdZlib;

function createZstdCompressLevel3(): Transform {
  if (!zstd.createZstdCompress) throw new Error("zstd compression is not available in this runtime");
  return zstd.createZstdCompress({ level: ZSTD_LEVEL });
}

function createZstdDecompress(): Transform {
  if (!zstd.createZstdDecompress) throw new Error("zstd decompression is not available in this runtime");
  return zstd.createZstdDecompress();
}

async function collectZstd(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    source,
    createZstdCompressLevel3(),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk); // zstd emits fresh, unshared buffers — no defensive copy
        callback();
      },
    })
  );
  return Buffer.concat(chunks);
}

/** Compress an in-memory protocol payload with the shared level-3 zstd codec. */
export async function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
  return collectZstd(Readable.from([Buffer.from(bytes)]));
}

/**
 * Decompress an in-memory protocol payload while enforcing the limit in the
 * stream. The transform aborts as soon as byte maxBytes + 1 is observed, so a
 * forged size declaration cannot cause an unbounded allocation.
 */
export async function zstdDecompressCapped(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid decompression byte limit");
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([Buffer.from(bytes)]),
    createZstdDecompress(),
    maxPlaintextBytesTransform(maxBytes),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    })
  );
  return Buffer.concat(chunks);
}

const zstdCompressFileToBuffer = (srcPath: string): Promise<Buffer> => collectZstd(fsSync.createReadStream(srcPath));
const zstdCompressBufferToBuffer = (src: Buffer): Promise<Buffer> => collectZstd(Readable.from([src]));

async function encryptBufferToFile(payload: Buffer, ctPath: string, dek: Buffer, nonce: Buffer): Promise<void> {
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(AAD);
  const body = cipher.update(payload);
  cipher.final(); // GCM emits no final bytes; required before getAuthTag()
  const fh = await fs.open(ctPath, "w");
  try {
    await fh.writev([body, cipher.getAuthTag()]); // single write, no full-payload concat copy
  } finally {
    await fh.close();
  }
}

function maxPlaintextBytesTransform(maxPlaintextBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += Buffer.byteLength(chunk);
      if (seen > maxPlaintextBytes) {
        callback(new Error(`decompressed plaintext exceeds declared size (${seen} > ${maxPlaintextBytes})`));
        return;
      }
      callback(null, chunk);
    },
  });
}

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
 *  one shared label for this scheme (constant AAD + domain-separated derivation).
 *  The info is the sha256 of the exact payload bytes fed to AES-GCM: plaintext for
 *  raw blobs, compressed payload for zstd blobs. */
function deriveKeyNonce(kek: Buffer, payloadSha: string): { dek: Buffer; nonce: Buffer } {
  const out = Buffer.from(hkdfSync("sha256", kek, AAD, Buffer.from(payloadSha, "hex"), 44));
  return { dek: out.subarray(0, 32), nonce: out.subarray(32, 44) };
}

export interface EncryptedBlob {
  plaintextSha: string;
  encSha: string;
  ciphertextPath: string; // temp file; caller uploads then removes
  cipherSize: number;
  comp?: "zstd";
  payloadSha?: string;
}

export type EncryptFileOptions = {
  compress?: boolean;
  bufferedCompressionMaxBytes?: number;
  expected?: { sha256: string; size: number };
};
export type DecryptFileOptions = { comp?: "zstd"; payloadSha?: string; maxPlaintextBytes?: number };

const SOURCE_CHANGED_ERROR_CODE = "RBOX_SOURCE_CHANGED";
type SourceChangedError = Error & { readonly code: typeof SOURCE_CHANGED_ERROR_CODE };

function sourceChangedError(srcPath: string): SourceChangedError {
  const tag: { readonly code: typeof SOURCE_CHANGED_ERROR_CODE } = { code: SOURCE_CHANGED_ERROR_CODE };
  return Object.assign(new Error(`source changed while encrypting: ${srcPath}`), tag);
}

/** Source-change classification must survive crypto-worker serialization. */
export function isSourceChangedError(error: unknown): error is { readonly code: typeof SOURCE_CHANGED_ERROR_CODE } {
  return typeof error === "object" && error !== null && "code" in error && error.code === SOURCE_CHANGED_ERROR_CODE;
}

/** Separate fused-job helper. The file-backed oracle below intentionally remains untouched. */
export async function encryptBytesInMemory(src: Buffer, kek: Buffer, opts: EncryptFileOptions): Promise<InMemoryEncryptedBlob> {
  const plaintextSha = hashBytes(src);
  if (!opts.expected || plaintextSha !== opts.expected.sha256 || src.length !== opts.expected.size) {
    throw sourceChangedError("<fused-source>");
  }
  let payload = src;
  let payloadSha = plaintextSha;
  let comp: "zstd" | undefined;
  if (opts.compress && src.length >= COMPRESS_MIN_BYTES) {
    const compressed = await zstdCompressBufferToBuffer(src);
    if (compressed.length < src.length * COMPRESS_RATIO) {
      payload = compressed;
      payloadSha = hashBytes(compressed);
      comp = "zstd";
    }
  }
  const { dek, nonce } = deriveKeyNonce(kek, payloadSha);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(AAD);
  const body = cipher.update(payload);
  cipher.final();
  const ct = Buffer.concat([body, cipher.getAuthTag()]);
  const ciphertext = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
  const base = { plaintextSha, encSha: hashBytes(ct), cipherSize: ct.length, ciphertext };
  return comp ? { ...base, comp, payloadSha } : base;
}

type CryptoPoolSelection = {
  encrypt(srcPath: string, tmpDir?: string, opts?: EncryptFileOptions): Promise<EncryptedBlob>;
  decrypt(ctPath: string, plaintextSha: string, destPath: string, opts?: DecryptFileOptions): Promise<void>;
};

let cryptoPoolSelector: ((kek: Buffer) => CryptoPoolSelection | undefined) | undefined;

export function setCryptoPoolSelectorForProcess(selector: (kek: Buffer) => CryptoPoolSelection | undefined): void {
  cryptoPoolSelector = selector;
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
export async function encryptFileToTempInline(srcPath: string, kek: Buffer, tmpDir?: string, opts: EncryptFileOptions = {}): Promise<EncryptedBlob> {
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
  let compressedPath: string | undefined;
  let ctPath: string | undefined;
  try {
    if (opts.expected) {
      await pipeline(
        fsSync.createReadStream(srcPath, { end: opts.expected.size }),
        fsSync.createWriteStream(snapPath, { flags: "wx", mode: 0o600 }),
      );
    } else {
      await fs.copyFile(srcPath, snapPath); // single read of the live file → immutable copy
    }
    const plaintextSha = await hashFile(snapPath); // fresh hash of the snapshot bytes
    const plaintextSize = (await fs.stat(snapPath)).size;
    if (opts.expected && (plaintextSha !== opts.expected.sha256 || plaintextSize !== opts.expected.size)) {
      throw sourceChangedError(srcPath);
    }
    let payloadPath = snapPath;
    let payloadBuffer: Buffer | undefined;
    let payloadSha = plaintextSha;
    let comp: "zstd" | undefined;

    if (opts.compress && plaintextSize >= COMPRESS_MIN_BYTES) {
      const bufferedCompressionMaxBytes = opts.bufferedCompressionMaxBytes ?? BUFFERED_COMPRESS_MAX_BYTES;
      if (plaintextSize <= bufferedCompressionMaxBytes) {
        const compressed = await zstdCompressFileToBuffer(snapPath);
        const compressedSize = compressed.byteLength;
        if (compressedSize < plaintextSize * COMPRESS_RATIO) {
          payloadBuffer = compressed;
          payloadSha = hashBytes(compressed);
          comp = "zstd";
        }
      } else {
        compressedPath = path.join(dir, `${plaintextSha}.${randomBytes(8).toString("hex")}.zst`);
        await pipeline(fsSync.createReadStream(snapPath), createZstdCompressLevel3(), fsSync.createWriteStream(compressedPath));
        const compressedSize = (await fs.stat(compressedPath)).size;
        if (compressedSize < plaintextSize * COMPRESS_RATIO) {
          payloadPath = compressedPath;
          payloadSha = await hashFile(compressedPath, compressedSize);
          comp = "zstd";
        } else {
          await fs.rm(compressedPath, { force: true }).catch(() => {});
          compressedPath = undefined;
        }
      }
    }

    const { dek, nonce } = deriveKeyNonce(kek, payloadSha);
    // Unique per CALL, not per content: concurrent encryption of two identical-
    // content files (same plaintextSha — common: empty files, boilerplate) must not
    // write the same temp path, or the interleaved writes corrupt it (sha mismatch).
    ctPath = path.join(dir, `${plaintextSha}.${randomBytes(8).toString("hex")}.ct`);

    if (payloadBuffer) {
      await encryptBufferToFile(payloadBuffer, ctPath, dek, nonce);
    } else {
      const cipher = createCipheriv("aes-256-gcm", dek, nonce);
      cipher.setAAD(AAD);
      await pipeline(fsSync.createReadStream(payloadPath), cipher, fsSync.createWriteStream(ctPath));
      await fs.appendFile(ctPath, cipher.getAuthTag()); // tag at EOF
    }
    // Snapshot/compressed temps are consumed — delete them NOW (before hashing/stat'ing
    // the ciphertext) to bound peak disk to the final ciphertext after encryption.
    await fs.rm(snapPath, { force: true }).catch(() => {});
    if (compressedPath) {
      await fs.rm(compressedPath, { force: true }).catch(() => {});
      compressedPath = undefined;
    }
    snapDone = true;

    const encSha = await hashFile(ctPath);
    const cipherSize = (await fs.stat(ctPath)).size;
    return comp ? { plaintextSha, encSha, ciphertextPath: ctPath, cipherSize, comp, payloadSha } : { plaintextSha, encSha, ciphertextPath: ctPath, cipherSize };
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
    if (compressedPath) await fs.rm(compressedPath, { force: true }).catch(() => {});
  }
}

export async function encryptFileToTemp(srcPath: string, kek: Buffer, tmpDir?: string, opts: EncryptFileOptions = {}): Promise<EncryptedBlob> {
  const pool = cryptoPoolSelector?.(kek);
  return pool ? pool.encrypt(srcPath, tmpDir, opts) : encryptFileToTempInline(srcPath, kek, tmpDir, opts);
}

/**
 * Decrypt a ciphertext file to `destPath`, verifying the GCM tag and then that the
 * recovered plaintext hashes to `plaintextSha`. Throws (and removes any partial
 * output) on tamper / wrong key / mismatch.
 */
export async function decryptFileToPathInline(
  ctPath: string,
  kek: Buffer,
  plaintextSha: string,
  destPath: string,
  opts: DecryptFileOptions = {}
): Promise<void> {
  if (opts.comp && !opts.payloadSha) throw new Error("compressed blob missing payloadSha");
  const derivationSha = opts.comp ? opts.payloadSha! : plaintextSha;
  const { dek, nonce } = deriveKeyNonce(kek, derivationSha);
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
      if (opts.comp) throw new Error("compressed ciphertext body is empty");
      // Empty plaintext (e.g. .gitkeep, __init__.py): the ciphertext is tag-only,
      // so there's no body to stream — the range [0, -1] is invalid. Verify the
      // GCM tag over zero bytes and write the empty file.
      const out = Buffer.concat([decipher.update(Buffer.alloc(0)), decipher.final()]); // final() throws on a bad tag
      await fs.writeFile(destPath, out);
    } else if (opts.comp) {
      if (opts.maxPlaintextBytes !== undefined) {
        await pipeline(
          fsSync.createReadStream(ctPath, { start: 0, end: contentLen - 1 }),
          decipher,
          createZstdDecompress(),
          maxPlaintextBytesTransform(opts.maxPlaintextBytes),
          fsSync.createWriteStream(destPath)
        );
      } else {
        await pipeline(fsSync.createReadStream(ctPath, { start: 0, end: contentLen - 1 }), decipher, createZstdDecompress(), fsSync.createWriteStream(destPath));
      }
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

export async function decryptFileToPath(
  ctPath: string,
  kek: Buffer,
  plaintextSha: string,
  destPath: string,
  opts: { comp?: "zstd"; payloadSha?: string; maxPlaintextBytes?: number } = {}
): Promise<void> {
  const pool = cryptoPoolSelector?.(kek);
  if (pool) return pool.decrypt(ctPath, plaintextSha, destPath, opts);
  return decryptFileToPathInline(ctPath, kek, plaintextSha, destPath, opts);
}
