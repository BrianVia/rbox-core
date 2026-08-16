import type { FileEntry } from "../../../engine/index.js";
import { isSafeRelPath } from "../../../engine/index.js";
import { createHash, randomBytes } from "node:crypto";
import { FileEntryOversizeError } from "../errors.js";
import { jsonCounter, jsonObject, jsonText } from "../../../json.js";
import { canonicalJson, extrasOf, parseCanonicalJson, retainedEstimate, spreadExtras, utf16beOrderKey } from "../digest/codecs.js";

export const FILE_ENTRY_KEYS = [
  "path", "sha256", "size", "mode", "mtimeMs", "type", "symlinkTarget",
  "encSha", "comp", "payloadSha", "cipherSize",
] as const satisfies readonly (keyof FileEntry)[];

export const MAX_CANONICAL_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_VALUE_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMON_FILE_KEYS = new Set(["path", "sha256", "size", "mode", "mtimeMs", "type"]);

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

function assertPath(path: string): void {
  if (!isSafeRelPath(path)) throw new TypeError("FileEntry.path must be a safe POSIX-relative manifest path");
}

function hex(value: string | undefined, field: string, optional = false): Buffer | null {
  if (value === undefined && optional) return null;
  if (!jsonText(value) || !HEX64.test(value)) throw new TypeError(`${field} must be lowercase hex64`);
  return Buffer.from(value, "hex");
}

function nonnegativeInteger(value: number | undefined, field: string): asserts value is number {
  if (jsonCounter(value) === undefined) throw new TypeError(`${field} must be a nonnegative integer`);
}

/** Canonical stage/plane bytes as the entry they encode. The container test is
 * the only rule here; `admitFileEntry` downstream is the validator. */
export function fileEntryFromCanonical(text: string): FileEntry {
  const value = parseCanonicalJson(text);
  if (!jsonObject(value)) throw new TypeError("file entry is not a JSON object");
  return Object.assign(Object.create(null), value) as FileEntry;
}

/** Every column an interned value is identified by, minus the id itself. The
 * consume path resolves or mints ids in SQL, so it never pays the CSPRNG. */
export type ConsumedFileEntry = Omit<EncodedFileEntry, "entryId">;

export function encodeFileEntry(input: FileEntry): EncodedFileEntry {
  // entry_id is an independent, domain-separated identity. A collision in the
  // non-unique exact_fingerprint lookup must still reach exact row comparison.
  return { entryId: randomBytes(16).toString("hex"), ...encodeFileEntryForConsume(input) };
}

export function encodeFileEntryForConsume(input: FileEntry): ConsumedFileEntry {
  const value = input;
  const admitted = admitFileEntry(value);
  const fingerprint = createHash("sha256").update(admitted.canonical).digest("hex");
  return {
    exactFingerprint: fingerprint,
    path: value.path,
    pathOrder: utf16beOrderKey(value.path),
    sha256: admitted.sha256,
    size: value.size,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    kind: value.type,
    symlinkTarget: value.symlinkTarget ?? null,
    encSha: admitted.encSha,
    comp: value.comp ?? null,
    payloadSha: admitted.payloadSha,
    cipherSize: value.cipherSize ?? null,
    extrasCjson: admitted.extrasCjson,
    canonicalBytes: admitted.canonicalBytes,
    retainedEstimate: admitted.retainedEstimate,
    canonical: admitted.canonical,
  };
}

interface AdmittedFileEntry {
  sha256: Buffer;
  encSha: Buffer | null;
  payloadSha: Buffer | null;
  extrasCjson: string | null;
  canonicalBytes: number;
  retainedEstimate: number;
  canonical: string;
}

export function encodeFileEntryForStage(input: FileEntry): Pick<EncodedFileEntry,
  "path" | "pathOrder" | "canonical" | "retainedEstimate"> {
  const admitted = admitFileEntry(input);
  return {
    path: input.path,
    pathOrder: utf16beOrderKey(input.path),
    canonical: admitted.canonical,
    retainedEstimate: admitted.retainedEstimate,
  };
}

function admitFileEntry(value: FileEntry): AdmittedFileEntry {
  assertPath(value.path);
  nonnegativeInteger(value.size, "size");
  if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777) throw new TypeError("mode out of range");
  if (!Number.isFinite(value.mtimeMs)) throw new TypeError("mtimeMs must be finite");
  if (value.type !== "file" && value.type !== "symlink") throw new TypeError("type must be file or symlink");
  if (value.symlinkTarget !== undefined && !(jsonText(value.symlinkTarget) && value.symlinkTarget.length > 0)) {
    throw new TypeError("symlinkTarget must be nonempty text");
  }
  if (value.type === "symlink" && value.symlinkTarget === undefined) throw new TypeError("symlink requires symlinkTarget");
  if (value.comp !== undefined && value.comp !== "zstd") throw new TypeError("unsupported compression");
  const compressed = value.comp !== undefined;
  if (compressed !== (value.payloadSha !== undefined) || compressed !== (value.cipherSize !== undefined)) {
    throw new TypeError("comp, payloadSha, and cipherSize must be jointly present");
  }
  if (value.cipherSize !== undefined) nonnegativeInteger(value.cipherSize, "cipherSize");
  const commonFile = value.type === "file" && value.symlinkTarget === undefined && value.encSha === undefined
    && value.comp === undefined && value.payloadSha === undefined && value.cipherSize === undefined
    && Object.keys(value).every((key) => COMMON_FILE_KEYS.has(key));
  const canonical = commonFile
    ? JSON.stringify({
        mode: value.mode, mtimeMs: value.mtimeMs, path: value.path,
        sha256: value.sha256, size: value.size, type: "file",
      })
    : canonicalJson(value);
  const canonicalBytes = Buffer.byteLength(canonical);
  const retained = commonFile ? commonFileRetained(value.path, value.sha256) : retainedEstimate(value);
  if (canonicalBytes > MAX_CANONICAL_VALUE_BYTES || retained > MAX_RETAINED_VALUE_BYTES) {
    throw new FileEntryOversizeError(value.path, canonicalBytes, retained);
  }
  return {
    sha256: hex(value.sha256, "sha256")!,
    encSha: hex(value.encSha, "encSha", true),
    payloadSha: hex(value.payloadSha, "payloadSha", true),
    extrasCjson: commonFile ? null : extrasOf(value, FILE_ENTRY_KEYS),
    canonicalBytes,
    retainedEstimate: retained,
    canonical,
  };
}

function commonFileRetained(path: string, sha256: string): number {
  const keys = ["mode", "mtimeMs", "path", "sha256", "size", "type"];
  const keyBytes = keys.reduce((total, key) => total + 56 + key.length * 2, 0);
  const stringBytes = [path, sha256, "file"]
    .reduce((total, value) => total + 56 + value.length * 2, 0);
  return Math.ceil((64 + keys.length * 96 + keyBytes + 6 * 32 + stringBytes) / 4096) * 4096;
}

export interface FileEntryRow {
  path: string; sha256: Uint8Array; size: number; mode: number; mtime_ms: number;
  kind: "file" | "symlink"; symlink_target: string | null; enc_sha: Uint8Array | null;
  comp: "zstd" | null; payload_sha: Uint8Array | null; cipher_size: number | null;
  extras_cjson: string | null; canonical_bytes: number; retained_estimate: number;
}

/** A FileEntry under construction: optional members are installed after the
 * required ones, so an absent column stays an ABSENT key. */
type DecodedFileEntry = { -readonly [K in keyof FileEntry]: FileEntry[K] };

export function decodeFileEntry(row: FileEntryRow): FileEntry {
  // A NULL column means the member is ABSENT, never present-and-undefined: the
  // canonical encoder refuses undefined and the digest covers key presence.
  const entry: DecodedFileEntry = {
    ...spreadExtras(row.extras_cjson),
    path: row.path,
    sha256: Buffer.from(row.sha256).toString("hex"),
    size: row.size,
    mode: row.mode,
    mtimeMs: row.mtime_ms,
    type: row.kind,
  };
  if (row.symlink_target !== null) entry.symlinkTarget = row.symlink_target;
  if (row.enc_sha !== null) entry.encSha = Buffer.from(row.enc_sha).toString("hex");
  if (row.comp !== null) entry.comp = row.comp;
  if (row.payload_sha !== null) entry.payloadSha = Buffer.from(row.payload_sha).toString("hex");
  if (row.cipher_size !== null) entry.cipherSize = row.cipher_size;
  const commonFile = row.kind === "file" && row.symlink_target === null && row.enc_sha === null
    && row.comp === null && row.payload_sha === null && row.cipher_size === null && row.extras_cjson === null;
  let canonicalBytes: number;
  let retained: number;
  if (commonFile) {
    assertPath(row.path);
    if (row.sha256.byteLength !== 32) throw new TypeError("sha256 must be lowercase hex64");
    nonnegativeInteger(row.size, "size");
    if (!Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o7777) throw new TypeError("mode out of range");
    if (!Number.isFinite(row.mtime_ms)) throw new TypeError("mtimeMs must be finite");
    canonicalBytes = Buffer.byteLength(JSON.stringify({
      mode: row.mode, mtimeMs: row.mtime_ms, path: row.path,
      sha256: entry.sha256, size: row.size, type: "file",
    }));
    retained = commonFileRetained(row.path, entry.sha256);
  } else {
    const admitted = admitFileEntry(entry);
    canonicalBytes = admitted.canonicalBytes;
    retained = admitted.retainedEstimate;
  }
  if (canonicalBytes !== row.canonical_bytes || retained !== row.retained_estimate) {
    throw new Error(`structural corruption in FileEntry ${row.path}`);
  }
  return entry;
}
