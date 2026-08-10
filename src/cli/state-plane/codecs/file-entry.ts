import type { FileEntry } from "../../../engine/index.js";
import { isSafeRelPath } from "../../../engine/index.js";
import { createHash, randomBytes } from "node:crypto";
import { FileEntryOversizeError } from "../errors.js";
import { canonicalJson, extrasOf, retainedEstimate, spreadExtras, utf16beOrderKey } from "../digest/codecs.js";

export const FILE_ENTRY_KEYS = [
  "path", "sha256", "size", "mode", "mtimeMs", "type", "symlinkTarget",
  "encSha", "comp", "payloadSha", "cipherSize",
] as const satisfies readonly (keyof FileEntry)[];

export const MAX_CANONICAL_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_VALUE_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export interface EncodedFileEntry {
  entryId: string;
  exactFingerprint: string;
  path: string;
  pathOrder: Buffer;
  sha256: Buffer;
  size: number;
  mode: number;
  mtimeMs: number;
  kind: "file" | "symlink";
  symlinkTarget: string | null;
  encSha: Buffer | null;
  comp: "zstd" | null;
  payloadSha: Buffer | null;
  cipherSize: number | null;
  extrasCjson: string | null;
  canonicalBytes: number;
  retainedEstimate: number;
  canonical: string;
}

function assertPath(path: unknown): asserts path is string {
  if (!isSafeRelPath(path)) throw new TypeError("FileEntry.path must be a safe POSIX-relative manifest path");
}

function hex(value: unknown, field: string, optional = false): Buffer | null {
  if (value === undefined && optional) return null;
  if (typeof value !== "string" || !HEX64.test(value)) throw new TypeError(`${field} must be lowercase hex64`);
  return Buffer.from(value, "hex");
}

function nonnegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative integer`);
}

export function encodeFileEntry(input: FileEntry): EncodedFileEntry {
  const value = input;
  assertPath(value.path);
  nonnegativeInteger(value.size, "size");
  if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777) throw new TypeError("mode out of range");
  if (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs)) throw new TypeError("mtimeMs must be finite");
  if (value.type !== "file" && value.type !== "symlink") throw new TypeError("type must be file or symlink");
  if (value.symlinkTarget !== undefined && (typeof value.symlinkTarget !== "string" || value.symlinkTarget.length === 0)) {
    throw new TypeError("symlinkTarget must be nonempty text");
  }
  if (value.type === "symlink" && value.symlinkTarget === undefined) throw new TypeError("symlink requires symlinkTarget");
  if (value.comp !== undefined && value.comp !== "zstd") throw new TypeError("unsupported compression");
  const compressed = value.comp !== undefined;
  if (compressed !== (value.payloadSha !== undefined) || compressed !== (value.cipherSize !== undefined)) {
    throw new TypeError("comp, payloadSha, and cipherSize must be jointly present");
  }
  if (value.cipherSize !== undefined) nonnegativeInteger(value.cipherSize, "cipherSize");
  const canonical = canonicalJson(value);
  const canonicalBytes = Buffer.byteLength(canonical);
  const retained = retainedEstimate(value);
  if (canonicalBytes > MAX_CANONICAL_VALUE_BYTES || retained > MAX_RETAINED_VALUE_BYTES) {
    throw new FileEntryOversizeError(value.path, canonicalBytes, retained);
  }
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  // entry_id is an independent, domain-separated identity. A collision in the
  // non-unique exact_fingerprint lookup must still reach exact row comparison.
  const entryId = randomBytes(16).toString("hex");
  return {
    entryId,
    exactFingerprint: fingerprint,
    path: value.path,
    pathOrder: utf16beOrderKey(value.path),
    sha256: hex(value.sha256, "sha256")!,
    size: value.size,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    kind: value.type,
    symlinkTarget: value.symlinkTarget ?? null,
    encSha: hex(value.encSha, "encSha", true),
    comp: value.comp ?? null,
    payloadSha: hex(value.payloadSha, "payloadSha", true),
    cipherSize: value.cipherSize ?? null,
    extrasCjson: extrasOf(value, FILE_ENTRY_KEYS),
    canonicalBytes,
    retainedEstimate: retained,
    canonical,
  };
}

export interface FileEntryRow {
  path: string; sha256: Uint8Array; size: number; mode: number; mtime_ms: number;
  kind: "file" | "symlink"; symlink_target: string | null; enc_sha: Uint8Array | null;
  comp: "zstd" | null; payload_sha: Uint8Array | null; cipher_size: number | null;
  extras_cjson: string | null; canonical_bytes: number; retained_estimate: number;
}

export function decodeFileEntry(row: FileEntryRow): FileEntry {
  const entry = {
    ...spreadExtras(row.extras_cjson),
    path: row.path,
    sha256: Buffer.from(row.sha256).toString("hex"),
    size: row.size,
    mode: row.mode,
    mtimeMs: row.mtime_ms,
    type: row.kind,
    ...(row.symlink_target === null ? {} : { symlinkTarget: row.symlink_target }),
    ...(row.enc_sha === null ? {} : { encSha: Buffer.from(row.enc_sha).toString("hex") }),
    ...(row.comp === null ? {} : { comp: row.comp }),
    ...(row.payload_sha === null ? {} : { payloadSha: Buffer.from(row.payload_sha).toString("hex") }),
    ...(row.cipher_size === null ? {} : { cipherSize: row.cipher_size }),
  } as unknown as FileEntry;
  const encoded = encodeFileEntry(entry);
  if (encoded.canonicalBytes !== row.canonical_bytes || encoded.retainedEstimate !== row.retained_estimate) {
    throw new Error(`structural corruption in FileEntry ${row.path}`);
  }
  return entry;
}
