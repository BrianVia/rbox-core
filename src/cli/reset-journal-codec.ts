import crypto from "node:crypto";
import fs from "node:fs/promises";
import { canonicalize } from "../engine/e2ee/jcs.js";
import type { JsonValue } from "../json.js";
import { assertResetParseAdmission, ResetMemoryAdmissionError } from "./reset-io.js";
import {
  constructResetJournal,
  ResetJournalSchemaError,
  type ResetJournal,
  type ResetJournalV1,
  type ResetJournalV2,
  type SQLiteResetJournalV2,
  type ResetJournalAuthorization,
  type ResetNextState,
  type ResetPhase,
  type ResetConsentKind,
} from "./reset-journal-schema.js";
import {
  resetJournalByteOffset,
  ResetJournalTokenError,
  tokenizeResetJournalJson,
} from "./reset-journal-tokenizer.js";

export {
  type ResetJournal, type ResetJournalV1, type ResetJournalV2,
  type SQLiteResetJournalV2, type ResetJournalAuthorization,
  type ResetNextState, type ResetPhase, type ResetConsentKind,
};

export const RESET_JOURNAL_BYTE_LIMIT = 524_288;
export const RESET_JOURNAL_READ_CHUNK = 65_536;
export const RESET_JOURNAL_NON_B64_STRING_UTF8_LIMIT = 524_288;

export interface ResetJournalByteSource {
  readonly declaredLength: number | null;
  readInto(destination: Uint8Array): Promise<{ bytesRead: number; done: boolean }>;
}

export type ResetJournalDecodeErrorCode =
  | "SOURCE_PROTOCOL" | "SOURCE_IO" | "DECLARED_LENGTH_INVALID"
  | "DECLARED_LENGTH_OVER_LIMIT" | "DECLARED_LENGTH_MISMATCH" | "RAW_OVERFLOW"
  | "MEMORY_ADMISSION" | "UTF8_INVALID" | "BOM_FORBIDDEN" | "JSON_SYNTAX"
  | "DEPTH_LIMIT" | "TOKEN_LIMIT" | "MEMBER_LIMIT" | "MEMBER_NAME_LIMIT"
  | "STRING_LIMIT" | "Z_LIMIT" | "UNKNOWN_MEMBER" | "DUPLICATE_MEMBER"
  | "MISSING_MEMBER" | "TYPE_MISMATCH" | "NUMBER_NONCANONICAL"
  | "NUMBER_RANGE" | "STRING_INVALID" | "BASE64_FORMAT" | "BASE64_LENGTH"
  | "BASE64_NONCANONICAL" | "EMBEDDED_HASH_MISMATCH"
  | "SCHEMA_DISCRIMINATOR" | "AUTHORIZATION_MISMATCH"
  | "APPLICATION_ID_MISMATCH" | "SCHEMA_ID_MISMATCH";

export interface ResetJournalDecodeError {
  code: ResetJournalDecodeErrorCode;
  byteOffset: number | null;
  jsonPath: string | null;
  limit: number | null;
}
export type DecodeResetJournalResult =
  | { ok: true; journal: ResetJournal; rawLength: number; rawSha256: string }
  | { ok: false; error: ResetJournalDecodeError };

const error = (
  code: ResetJournalDecodeErrorCode,
  byteOffset: number | null = null,
  jsonPath: string | null = null,
  limit: number | null = null,
): DecodeResetJournalResult => ({ ok: false, error: { code, byteOffset, jsonPath, limit } });

export function resetJournalBytesSource(bytes: Uint8Array, declaredLength: number | null = bytes.byteLength): ResetJournalByteSource {
  let offset = 0;
  let ended = false;
  return {
    declaredLength,
    async readInto(destination) {
      if (ended) return { bytesRead: 0, done: true };
      const count = Math.min(destination.byteLength, bytes.byteLength - offset);
      destination.set(bytes.subarray(offset, offset + count));
      offset += count;
      ended = offset === bytes.byteLength;
      return { bytesRead: count, done: ended };
    },
  };
}

/**
 * Opens one no-follow handle and authenticates its path identity at EOF.
 * Callers receive no handle and therefore cannot accidentally bypass the cap.
 */
export async function resetJournalFileSource(file: string): Promise<ResetJournalByteSource> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe non-regular reset file");
  let handle: fs.FileHandle | undefined;
  let position = 0;
  let closed = false;
  const closeAndAuthenticate = async (): Promise<void> => {
    if (closed || handle === undefined) return;
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(file);
    await handle.close();
    closed = true;
    if (afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size
      || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size) {
      throw new Error("reset journal identity changed during read");
    }
  };
  return {
    declaredLength: Number(before.size),
    async readInto(destination) {
      if (closed) return { bytesRead: 0, done: true };
      try {
        if (handle === undefined) {
          handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
            throw new Error("reset journal identity changed before read");
          }
        }
        const result = await handle.read(destination, 0, destination.byteLength, position);
        position += result.bytesRead;
        const done = result.bytesRead === 0 || position === before.size;
        if (done) await closeAndAuthenticate();
        return { bytesRead: result.bytesRead, done };
      } catch (cause) {
        if (!closed && handle !== undefined) {
          await handle.close().catch(() => undefined);
          closed = true;
        }
        throw cause;
      }
    },
  };
}

function validReadResult(value: unknown, capacity: number): value is { bytesRead: number; done: boolean } {
  if (value === null || typeof value !== "object") return false;
  const result = value as { bytesRead?: unknown; done?: unknown };
  return Number.isInteger(result.bytesRead) && (result.bytesRead as number) >= 0
    && (result.bytesRead as number) <= capacity && typeof result.done === "boolean";
}

async function pullBytes(source: ResetJournalByteSource): Promise<Uint8Array | DecodeResetJournalResult> {
  let declared: number | null;
  try { declared = source.declaredLength; }
  catch { return error("SOURCE_PROTOCOL"); }
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) return error("DECLARED_LENGTH_INVALID");
  if (declared !== null && declared > RESET_JOURNAL_BYTE_LIMIT) {
    return error("DECLARED_LENGTH_OVER_LIMIT", null, null, RESET_JOURNAL_BYTE_LIMIT);
  }
  try {
    assertResetParseAdmission(declared ?? RESET_JOURNAL_BYTE_LIMIT);
  } catch (cause) {
    if (cause instanceof ResetMemoryAdmissionError) return error("MEMORY_ADMISSION", null, null, cause.requiredBytes);
    throw cause;
  }
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(RESET_JOURNAL_READ_CHUNK);
  let total = 0;
  let done = false;
  for (;;) {
    if (done) break;
    const remaining = (declared ?? RESET_JOURNAL_BYTE_LIMIT) - total;
    if (remaining === 0) break;
    const destination = buffer.subarray(0, Math.min(buffer.byteLength, remaining));
    destination.fill(0xa5);
    let result: unknown;
    try { result = await source.readInto(destination); }
    catch { return error("SOURCE_IO"); }
    if (!validReadResult(result, destination.byteLength) || (result.bytesRead === 0 && !result.done)) return error("SOURCE_PROTOCOL");
    for (let index = result.bytesRead; index < destination.byteLength; index++) {
      if (destination[index] !== 0xa5) return error("SOURCE_PROTOCOL");
    }
    if (result.bytesRead > 0) chunks.push(destination.slice(0, result.bytesRead));
    total += result.bytesRead;
    done = result.done;
    if (declared !== null && done && total !== declared) return error("DECLARED_LENGTH_MISMATCH");
  }
  if (declared !== null && total !== declared) return error("DECLARED_LENGTH_MISMATCH");
  if (!done) {
    const sentinel = buffer.subarray(0, 1);
    sentinel[0] = 0xa5;
    let result: unknown;
    try { result = await source.readInto(sentinel); }
    catch { return error("SOURCE_IO"); }
    if (!validReadResult(result, 1) || (result.bytesRead === 0 && !result.done)) return error("SOURCE_PROTOCOL");
    if (result.bytesRead !== 0) return error(declared === null ? "RAW_OVERFLOW" : "DECLARED_LENGTH_MISMATCH");
    done = result.done;
  }
  if (!done) return error("SOURCE_PROTOCOL");
  // Authenticate the source's permanent-EOF promise. A producer that returns
  // bytes after done=true violates the pull contract even when the first
  // prefix happened to form a valid journal.
  let afterDone: unknown;
  try { afterDone = await source.readInto(buffer.subarray(0, 1)); }
  catch { return error("SOURCE_IO"); }
  if (!validReadResult(afterDone, 1) || afterDone.bytesRead !== 0 || !afterDone.done) {
    return error("SOURCE_PROTOCOL");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function decodeResetJournal(source: ResetJournalByteSource): Promise<DecodeResetJournalResult> {
  const pulled = await pullBytes(source);
  if (!(pulled instanceof Uint8Array)) return pulled;
  if (pulled[0] === 0xef && pulled[1] === 0xbb && pulled[2] === 0xbf) {
    return error("BOM_FORBIDDEN", 0);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(pulled); }
  catch { return error("UTF8_INVALID"); }
  let value: JsonValue;
  try {
    value = tokenizeResetJournalJson(text);
  } catch (cause) {
    if (!(cause instanceof ResetJournalTokenError)) throw cause;
    return error(cause.code, resetJournalByteOffset(text, cause.charOffset), cause.jsonPath, cause.limit);
  }
  try {
    const journal = constructResetJournal(value);
    return {
      ok: true,
      journal,
      rawLength: pulled.byteLength,
      rawSha256: crypto.createHash("sha256").update(pulled).digest("hex"),
    };
  } catch (cause) {
    if (!(cause instanceof ResetJournalSchemaError)) throw cause;
    return error(cause.code, null, cause.jsonPath, cause.limit);
  }
}

/**
 * Bounded duplicate-safe envelope inspection for legacy doctor compatibility.
 * This does not make an invalid journal actionable for recovery; it only
 * preserves the pre-U2 restore eligibility check for an already-quarantined
 * opaque record without reintroducing a caller-owned parser.
 */
export async function inspectResetJournalEnvelopeStreams(
  source: ResetJournalByteSource,
): Promise<{ oldStream: string; nextStream: string } | undefined> {
  const pulled = await pullBytes(source);
  if (!(pulled instanceof Uint8Array)) return undefined;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(pulled); } catch { return undefined; }
  let value: unknown;
  try { value = tokenizeResetJournalJson(text); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as { old?: unknown; next?: unknown };
  const old = root.old;
  const next = root.next;
  if (old === null || typeof old !== "object" || Array.isArray(old)
    || next === null || typeof next !== "object" || Array.isArray(next)) return undefined;
  const oldStream = (old as { stream?: unknown }).stream;
  const nextStream = (next as { stream?: unknown }).stream;
  return typeof oldStream === "string" && typeof nextStream === "string"
    ? { oldStream, nextStream }
    : undefined;
}

export function decodeResetJournalBytes(
  bytes: Uint8Array,
  declaredLength: number | null = bytes.byteLength,
): Promise<DecodeResetJournalResult> {
  return decodeResetJournal(resetJournalBytesSource(bytes, declaredLength));
}

function wireValue(journal: ResetJournal): unknown {
  if (!("stateFormat" in journal)) return journal;
  const { dbBytes: _decoded, ...next } = journal.next;
  return { ...journal, next };
}

export async function encodeResetJournal(journal: ResetJournal): Promise<Uint8Array> {
  const bytes = Buffer.concat([Buffer.from(canonicalize(wireValue(journal))), Buffer.from("\n")]);
  const decoded = await decodeResetJournalBytes(bytes);
  if (!decoded.ok) {
    const cause = new Error(`reset journal encoding rejected: ${decoded.error.code}`);
    Object.assign(cause, { decodeError: decoded.error });
    throw cause;
  }
  return bytes;
}
