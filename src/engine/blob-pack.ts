/**
 * Design 114 — locked rbox-pack-v1 structural codec.
 *
 * DEPENDENCY-FREE (pure byte operations, no hashing) so it bundles into both
 * the Bun client and the workerd Worker. The caller verifies the returned
 * directory hash and each member's content address in its own runtime.
 */

export const PACK_HEADER_MAGIC = "RBOXPK01";
export const PACK_FOOTER_MAGIC = "RBOXEND1";
export const PACK_HEADER_BYTES = 16;
export const PACK_FOOTER_BYTES = 72;
export const PACK_DIR_ENTRY_BYTES = 48;
export const PACK_MAX_MEMBERS = 2048;
export const PACK_MAX_MEMBER_BYTES = 256 * 1024;
export const PACK_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PACK_TARGET_PAYLOAD_BYTES = 7_864_320;
export const PACK_MIN_ACTIVATION_COUNT = 16;
export const PACK_MIN_ACTIVATION_BYTES = 1024 * 1024;
export const PACK_CONTENT_TYPE = "application/x-rbox-pack";
export const PACK_ID_RE = /^[0-9a-f]{32}$/;

const SHA256_RE = /^[0-9a-f]{64}$/;
const HEADER_MAGIC_BYTES = asciiBytes(PACK_HEADER_MAGIC);
const FOOTER_MAGIC_BYTES = asciiBytes(PACK_FOOTER_MAGIC);

export interface PackDirEntry {
  sha256: string;
  offset: number;
  length: number;
}

export type PackParseError =
  | "truncated"
  | "bad_magic"
  | "bad_header_bytes"
  | "bad_version"
  | "bad_flags"
  | "bad_reserved"
  | "bad_count"
  | "bad_entry_bytes"
  | "integer_overflow"
  | "bad_directory_size"
  | "bad_directory_bounds"
  | "duplicate_sha"
  | "bad_order"
  | "bad_length"
  | "not_contiguous";

export type PackParseResult =
  | {
      ok: true;
      entries: PackDirEntry[];
      /** Exact directory slice whose SHA-256 the caller must verify. */
      directory: Uint8Array;
      /** SHA-256 claimed by the footer; the codec deliberately does not hash. */
      directorySha256: Uint8Array;
    }
  | { ok: false; error: PackParseError };

function asciiBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
  return out;
}

function matches(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  for (let i = 0; i < expected.length; i++) if (bytes[offset + i] !== expected[i]) return false;
  return true;
}

function hexToBytes32(hex: string, out: Uint8Array, offset: number): void {
  for (let i = 0; i < 32; i++) out[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
}

function bytes32ToHex(bytes: Uint8Array, offset: number): string {
  let result = "";
  for (let i = 0; i < 32; i++) result += bytes[offset + i]!.toString(16).padStart(2, "0");
  return result;
}

function safeU64(dv: DataView, offset: number): number | undefined {
  const value = dv.getBigUint64(offset, false);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function requireSafeUint(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`blob-pack: bad ${label}`);
}

export function encodePackHeader(): Uint8Array {
  const out = new Uint8Array(PACK_HEADER_BYTES);
  out.set(HEADER_MAGIC_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, PACK_HEADER_BYTES, false);
  dv.setUint32(12, 0, false);
  return out;
}

export function encodePackDirectory(entries: PackDirEntry[]): Uint8Array {
  if (entries.length < 1 || entries.length > PACK_MAX_MEMBERS) throw new Error("blob-pack: bad count");
  const out = new Uint8Array(entries.length * PACK_DIR_ENTRY_BYTES);
  const dv = new DataView(out.buffer);
  const seen = new Set<string>();
  let expectedOffset = PACK_HEADER_BYTES;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!SHA256_RE.test(entry.sha256)) throw new Error("blob-pack: malformed sha256");
    if (seen.has(entry.sha256)) throw new Error("blob-pack: duplicate sha256");
    requireSafeUint(entry.offset, "offset");
    requireSafeUint(entry.length, "length");
    if (entry.length < 1 || entry.length > PACK_MAX_MEMBER_BYTES) throw new Error("blob-pack: bad length");
    if (entry.offset !== expectedOffset) throw new Error("blob-pack: entries not contiguous");
    if (!Number.isSafeInteger(entry.offset + entry.length)) throw new Error("blob-pack: extent overflow");
    seen.add(entry.sha256);
    const offset = i * PACK_DIR_ENTRY_BYTES;
    hexToBytes32(entry.sha256, out, offset);
    dv.setBigUint64(offset + 32, BigInt(entry.offset), false);
    dv.setBigUint64(offset + 40, BigInt(entry.length), false);
    expectedOffset += entry.length;
  }
  return out;
}

export function encodePackFooter(f: {
  count: number;
  directoryOffset: number;
  directoryBytes: number;
  directorySha256: Uint8Array;
}): Uint8Array {
  if (!Number.isInteger(f.count) || f.count < 1 || f.count > PACK_MAX_MEMBERS) throw new Error("blob-pack: bad count");
  requireSafeUint(f.directoryOffset, "directory offset");
  requireSafeUint(f.directoryBytes, "directory bytes");
  if (f.directoryBytes !== f.count * PACK_DIR_ENTRY_BYTES) throw new Error("blob-pack: bad directory size");
  if (f.directorySha256.byteLength !== 32) throw new Error("blob-pack: directory sha256 must be 32 bytes");
  const out = new Uint8Array(PACK_FOOTER_BYTES);
  out.set(FOOTER_MAGIC_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 1, false);
  dv.setUint32(12, PACK_DIR_ENTRY_BYTES, false);
  dv.setUint32(16, f.count, false);
  dv.setUint32(20, 0, false);
  dv.setBigUint64(24, BigInt(f.directoryOffset), false);
  dv.setBigUint64(32, BigInt(f.directoryBytes), false);
  out.set(f.directorySha256, 40);
  return out;
}

export function packOverheadBytes(count: number): number {
  if (!Number.isInteger(count) || count < 0 || count > PACK_MAX_MEMBERS) throw new Error("blob-pack: bad count");
  return PACK_HEADER_BYTES + count * PACK_DIR_ENTRY_BYTES + PACK_FOOTER_BYTES;
}

/** Strict structural parser. Body and cryptographic caps are enforced by callers. */
export function parsePack(bytes: Uint8Array): PackParseResult {
  if (bytes.byteLength < PACK_HEADER_BYTES + PACK_FOOTER_BYTES) return { ok: false, error: "truncated" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!matches(bytes, 0, HEADER_MAGIC_BYTES)) return { ok: false, error: "bad_magic" };
  if (dv.getUint32(8, false) !== PACK_HEADER_BYTES) return { ok: false, error: "bad_header_bytes" };
  if (dv.getUint32(12, false) !== 0) return { ok: false, error: "bad_flags" };

  const footerOffset = bytes.byteLength - PACK_FOOTER_BYTES;
  if (!matches(bytes, footerOffset, FOOTER_MAGIC_BYTES)) return { ok: false, error: "bad_magic" };
  if (dv.getUint32(footerOffset + 8, false) !== 1) return { ok: false, error: "bad_version" };
  if (dv.getUint32(footerOffset + 12, false) !== PACK_DIR_ENTRY_BYTES) return { ok: false, error: "bad_entry_bytes" };
  const count = dv.getUint32(footerOffset + 16, false);
  if (count < 1 || count > PACK_MAX_MEMBERS) return { ok: false, error: "bad_count" };
  if (dv.getUint32(footerOffset + 20, false) !== 0) return { ok: false, error: "bad_reserved" };

  const directoryOffset = safeU64(dv, footerOffset + 24);
  const directoryBytes = safeU64(dv, footerOffset + 32);
  if (directoryOffset === undefined || directoryBytes === undefined) return { ok: false, error: "integer_overflow" };
  if (directoryBytes !== count * PACK_DIR_ENTRY_BYTES) return { ok: false, error: "bad_directory_size" };
  if (
    directoryOffset < PACK_HEADER_BYTES ||
    directoryOffset > footerOffset ||
    directoryBytes > footerOffset - directoryOffset ||
    directoryOffset + directoryBytes !== footerOffset
  ) {
    return { ok: false, error: "bad_directory_bounds" };
  }

  const entries = new Array<PackDirEntry>(count);
  const seen = new Set<string>();
  let expectedOffset = PACK_HEADER_BYTES;
  let previousOffset = -1;
  for (let i = 0; i < count; i++) {
    const entryOffset = directoryOffset + i * PACK_DIR_ENTRY_BYTES;
    const sha256 = bytes32ToHex(bytes, entryOffset);
    if (seen.has(sha256)) return { ok: false, error: "duplicate_sha" };
    const offset = safeU64(dv, entryOffset + 32);
    const length = safeU64(dv, entryOffset + 40);
    if (offset === undefined || length === undefined) return { ok: false, error: "integer_overflow" };
    if (i > 0 && offset <= previousOffset) return { ok: false, error: "bad_order" };
    if (length < 1 || length > PACK_MAX_MEMBER_BYTES) return { ok: false, error: "bad_length" };
    if (offset !== expectedOffset || !Number.isSafeInteger(offset + length)) return { ok: false, error: "not_contiguous" };
    entries[i] = { sha256, offset, length };
    seen.add(sha256);
    previousOffset = offset;
    expectedOffset = offset + length;
  }
  if (expectedOffset !== directoryOffset) return { ok: false, error: "not_contiguous" };

  return {
    ok: true,
    entries,
    directory: bytes.subarray(directoryOffset, directoryOffset + directoryBytes),
    directorySha256: bytes.slice(footerOffset + 40, footerOffset + 72),
  };
}
