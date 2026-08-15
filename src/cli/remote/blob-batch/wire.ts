import type { JsonValue } from "../../../json.js";
import { toHex } from "../../../engine/e2ee/index.js";
import { DEFAULT_BATCH_RECORD_BYTES } from "./config.js";

// Wire twin: apps/api/src/blob-batch.ts — the framing constants and codec are
// duplicated per build target (house pattern, like UPLOAD_RECEIPTS_V1). Change
// them in lockstep; the server emits {error:"too_many_records", max} on an
// over-cap PUT 400. Nothing fails to compile if the twins drift.

export const BATCH_BLOB_CONTENT_TYPE = "application/x-rbox-blobs";
export const BATCH_FRAME_HEADER_BYTES = 36;
export const BATCH_STATUS_BIT = 0x80000000;
const BATCH_STATUS_MAX_BYTES = 4 * 1024;

export interface BatchFrame {
  sha: string;
  status: boolean;
  payload: Uint8Array;
}

export type BatchPutResponseRecord =
  | { sha256: string; ok: true; sizeBytes: number; receipt: string }
  | { sha256: string; ok: false; error: "sha_mismatch" | "too_large" | "r2_error" };

export async function* parseBatchFrames(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<BatchFrame> {
  const reader = body.getReader();
  // Chunk list instead of a grow-and-recopy buffer: every payload byte is copied
  // at most once (and headers are usually zero-copy subarray views). The naive
  // concat form re-copies the accumulating prefix per read — tens of GB of
  // memcpy across a ~95k-blob join.
  const chunks: Uint8Array[] = [];
  let available = 0;
  let eof = false;
  const fill = async (n: number): Promise<boolean> => {
    while (available < n && !eof) {
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
        break;
      }
      if (value?.byteLength) {
        onChunk?.();
        chunks.push(value);
        available += value.byteLength;
      }
    }
    return available >= n;
  };
  const take = (n: number): Uint8Array => {
    if (n === 0) return new Uint8Array(0);
    const head = chunks[0]!;
    if (head.byteLength >= n) {
      const out = head.subarray(0, n);
      if (head.byteLength === n) chunks.shift();
      else chunks[0] = head.subarray(n);
      available -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = chunks[0]!;
      const want = Math.min(n - off, c.byteLength);
      out.set(c.subarray(0, want), off);
      if (want === c.byteLength) chunks.shift();
      else chunks[0] = c.subarray(want);
      off += want;
    }
    available -= n;
    return out;
  };
  try {
    for (;;) {
      const hasHeader = await fill(BATCH_FRAME_HEADER_BYTES);
      if (!hasHeader) {
        if (available === 0) return;
        throw new Error("truncated batch blob frame header");
      }
      const header = take(BATCH_FRAME_HEADER_BYTES);
      const sha = toHex(header.subarray(0, 32));
      const word = new DataView(header.buffer, header.byteOffset + 32, 4).getUint32(0, false);
      const isStatus = (word & BATCH_STATUS_BIT) !== 0;
      const length = word & 0x7fffffff;
      if (isStatus && length > BATCH_STATUS_MAX_BYTES) throw new Error("batch blob status frame too large");
      if (!isStatus && length > DEFAULT_BATCH_RECORD_BYTES) throw new Error("batch blob data frame too large");
      const hasPayload = await fill(length);
      if (!hasPayload) throw new Error("truncated batch blob frame payload");
      yield { sha, status: isStatus, payload: take(length) };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort only; preserve the original parse failure.
    }
  }
}

export function framedBytes(payloadBytes: number): number {
  return BATCH_FRAME_HEADER_BYTES + payloadBytes;
}

/** Read a batch-endpoint JSON body at its I/O boundary. `Response.json()` is typed
 *  `Promise<unknown>`, so the bytes are decoded here instead, where `JSON.parse`
 *  yields a `JsonValue` by construction. An unreadable or malformed body is `null`,
 *  exactly as the former `res.json().catch(() => null)` rendered it. */
export async function readBatchResponseJson(res: Response): Promise<JsonValue | null> {
  try {
    const parsed: JsonValue = JSON.parse(await res.text());
    return parsed;
  } catch {
    return null;
  }
}

/** Decode the batch-PUT response body into the records the uploader acts on. */
export function parseBatchPutResponse(body: JsonValue | null): BatchPutResponseRecord[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.results)) return null;
  const out: BatchPutResponseRecord[] = [];
  for (const raw of body.results) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) return null;
    if (raw.ok === true) {
      if (typeof raw.sizeBytes !== "number" || typeof raw.receipt !== "string") return null;
      out.push({ sha256: raw.sha256, ok: true, sizeBytes: raw.sizeBytes, receipt: raw.receipt });
    } else if (raw.ok === false && (raw.error === "sha_mismatch" || raw.error === "too_large" || raw.error === "r2_error")) {
      out.push({ sha256: raw.sha256, ok: false, error: raw.error });
    } else {
      return null;
    }
  }
  return out;
}

/** The server's advertised record cap from an over-cap 400 body. */
export function parseBatchPutErrorMax(body: JsonValue | null): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return body.error === "too_many_records"
      && typeof body.max === "number"
      && Number.isSafeInteger(body.max)
      && body.max > 0
    ? body.max
    : undefined;
}

const textDecoder = new TextDecoder();

export function parseStatus(payload: Uint8Array): { status: "missing" | "too_large" | "error" } | null {
  try {
    const body = JSON.parse(textDecoder.decode(payload)) as { status?: unknown };
    return body.status === "missing" || body.status === "too_large" || body.status === "error" ? { status: body.status } : null;
  } catch {
    return null;
  }
}
