/**
 * Low-level crypto primitives for E2EE on WebCrypto — the same RFC-standard
 * algorithms run identically in Bun (client) and Workers. We reach WebCrypto via
 * `node:crypto`'s `webcrypto` so it's fully typed by @types/node without pulling
 * the DOM lib into the client tsconfig. All RFC-standard: HKDF-SHA256 (RFC 5869),
 * AES-256-GCM, SHA-256.
 *
 * Encoding conventions on the wire: binary is base64url (no padding); hashes are
 * lowercase hex. Keep these two straight — addresses/ids are hex, key/ciphertext
 * blobs are b64url.
 *
 * Never: node:-only APIs.
 */
import { webcrypto } from "node:crypto";
export { fromB64url, toB64url } from "../encoding.js";

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

// ---- encodings ------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("fromHex: odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---- hashing --------------------------------------------------------------

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

// ---- HKDF-SHA256 (RFC 5869) ----------------------------------------------

/** Derive `length` bytes from input keying material. salt/info are domain
 *  separators — every call site in rbox uses a distinct, versioned `info`. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---- AES-256-GCM ----------------------------------------------------------

/** Encrypt with AES-256-GCM. Returns ciphertext WITH the 16-byte tag appended
 *  (WebCrypto's default layout). `nonce` MUST be 12 bytes and unique per (key) —
 *  except the deliberate convergent-blob case (design 12 V4-5). */
export async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(key);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, plaintext);
  return new Uint8Array(ct);
}

/** Decrypt AES-256-GCM (ciphertext+tag). Throws on tag mismatch (tamper / wrong
 *  key / wrong AAD). */
export async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(key);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, ciphertext);
  return new Uint8Array(pt);
}

function importAesKey(key: Uint8Array) {
  if (key.length !== 32) throw new Error(`aes-256-gcm: key must be 32 bytes (got ${key.length})`);
  return subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// ---- constant-time compare ------------------------------------------------

/** Length-independent-time byte compare (lengths still leak, contents don't). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i]! ^ b[i]!;
  return r === 0;
}
