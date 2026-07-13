import type { Env } from "./env.js";
import { isEntitled } from "./authz.js";
import { readBodyCapped, readBytesCapped } from "./commit-envelope.js";
import { emit, startOp, type Op } from "./metrics.js";
import { uploadGrantsEnabled } from "./grants.js";
import { directWriteVerified, mintFenceCheckedReceipts, ReceiptFenceError, usesReceipts } from "./blobs.js";
import { blobKey, json, SHA256_HEX_RE, sha256Hex, toHex } from "./util.js";

// Wire twin: src/cli/remote/blob-batch/wire.ts — the framing constants, codec,
// and over-cap { error: "too_many_records", max } response are duplicated per
// build target (house pattern, like UPLOAD_RECEIPTS_V1). Change them in lockstep;
// nothing fails to compile if they drift.

export const BATCH_BLOB_CONTENT_TYPE = "application/x-rbox-blobs";
export const BATCH_FRAME_HEADER_BYTES = 36;
export const BATCH_STATUS_BIT = 0x80000000;
export const MAX_BATCH_RECORD_BYTES = 256 * 1024;
const BATCH_STATUS_MAX_BYTES = 4 * 1024;
const MAX_BATCH_GET_SHAS = 32;
const BATCH_PUT_RECORDS_FLOOR = 32;
const BATCH_PUT_RECORDS_MAX = 64;
const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_REQUEST_BYTES = 4 * 1024;

type BatchStatus = "missing" | "too_large" | "error";
type BatchResult =
  | { sha: string; kind: "object"; size: number; bytes: ArrayBuffer }
  | { sha: string; kind: "status"; status: BatchStatus; code?: string; size?: number };
type BatchPutError = "sha_mismatch" | "too_large" | "r2_error";
type BatchPutResult =
  | { sha256: string; ok: true; sizeBytes: number; receipt: string }
  | { sha256: string; ok: false; error: BatchPutError };
interface BatchPutRecord {
  sha: string;
  payload: Uint8Array;
}
type WrittenBatchPutResult =
  | { sha256: string; ok: true; sizeBytes: number }
  | { sha256: string; ok: false; error: BatchPutError };

const textEncoder = new TextEncoder();

export function encodeBatchFrameHeader(sha: string, payloadBytes: number, status: boolean): Uint8Array {
  if (!SHA256_HEX_RE.test(sha)) throw new TypeError("invalid sha256");
  if (!Number.isInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > 0x7fffffff) throw new RangeError("invalid frame length");
  const header = new Uint8Array(BATCH_FRAME_HEADER_BYTES);
  header.set(hexToBytes(sha), 0);
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(32, status ? (payloadBytes | BATCH_STATUS_BIT) >>> 0 : payloadBytes, false);
  return header;
}

export function encodeBatchStatusFrame(sha: string, status: BatchStatus, extra: { code?: string; size?: number } = {}): [Uint8Array, Uint8Array] {
  const body = status === "too_large" ? { status, size: extra.size ?? 0 } : status === "error" ? { status, code: extra.code ?? "r2" } : { status };
  const payload = textEncoder.encode(JSON.stringify(body));
  if (payload.byteLength > BATCH_STATUS_MAX_BYTES) throw new RangeError("status frame too large");
  return [encodeBatchFrameHeader(sha, payload.byteLength, true), payload];
}

export async function blobBatchGetWithVerifiedGrant(req: Request, env: Env, accountId: string): Promise<Response> {
  return blobBatchGet(req, env, { accountId, grantPreauth: true });
}

export async function blobBatchGet(req: Request, env: Env, opts: { accountId: string; grantPreauth?: boolean }): Promise<Response> {
  const parsed = await readBatchRequest(req);
  if (!parsed.ok) return parsed.response;
  const op = startOp(env, "blob.batchGet");
  return new Response(streamBatch(op, parsed.shas, opts), { headers: { "content-type": BATCH_BLOB_CONTENT_TYPE } });
}

type BatchPutAuthOutcome = "fast_path" | "fallback_missing" | "fallback_invalid" | "fallback_expired";

export async function blobBatchPutWithVerifiedGrant(req: Request, env: Env, accountId: string): Promise<Response> {
  return blobBatchPut(req, env, accountId, "fast_path");
}

export async function blobBatchPut(req: Request, env: Env, accountId: string, authOutcome?: BatchPutAuthOutcome): Promise<Response> {
  const op = startOp(env, "blob.batchPut");
  const auth = authOutcome ?? (uploadGrantsEnabled(env) ? "fallback_missing" : undefined);
  if (auth) emit(env, { op: "blob.batchPut.auth", outcome: auth });
  const finish = (response: Response): Response => {
    if (auth) response.headers.set("x-rbox-auth-path", auth === "fast_path" ? "grant" : "bearer");
    return response;
  };
  if (!usesReceipts(req)) {
    op.done("bad_request", { count: 0, bytes: 0 });
    return finish(json({ error: "receipts_required" }, 400));
  }

  const maxRecords = batchPutMaxRecords(env);
  const parsed = await readBatchPutRequest(req, maxRecords);
  if (!parsed.ok) {
    if ("tooManyRecords" in parsed) {
      op.done("too_many_records", { count: parsed.tooManyRecords, bytes: 0 });
      return finish(json({ error: "too_many_records", max: maxRecords }, 400));
    }
    op.done("bad_request", { count: 0, bytes: 0 });
    return finish(parsed.response);
  }

  let results: BatchPutResult[];
  try {
    results = await writeBatchPutRecords(op, parsed.records, accountId);
  } catch (e) {
    if (!(e instanceof ReceiptFenceError)) throw e;
    op.done("retry_later", { count: parsed.records.length, bytes: parsed.acceptedPayloadBytes });
    return finish(json({ error: "retry_later" }, 503));
  }
  const resultOutcome = results.every((r) => r.ok) ? "ok" : "partial";
  op.done(resultOutcome, { count: parsed.records.length, bytes: parsed.acceptedPayloadBytes });
  return finish(json({ results }));
}

async function readBatchRequest(req: Request): Promise<{ ok: true; shas: string[] } | { ok: false; response: Response }> {
  const raw = await readBodyCapped(req, MAX_BATCH_REQUEST_BYTES);
  if (raw === null) return { ok: false, response: json({ error: "bad_request", message: "request body too large" }, 400) };
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return { ok: false, response: json({ error: "bad_request", message: "invalid JSON" }, 400) };
  }
  if (!Array.isArray(body)) return { ok: false, response: json({ error: "bad_request", message: "expected array" }, 400) };
  const seen = new Set<string>();
  const shas: string[] = [];
  for (const value of body) {
    if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) return { ok: false, response: json({ error: "bad_request", message: "invalid sha256" }, 400) };
    if (!seen.has(value)) {
      seen.add(value);
      shas.push(value);
    }
  }
  if (shas.length === 0) return { ok: false, response: json({ error: "bad_request", message: "empty batch" }, 400) };
  if (shas.length > MAX_BATCH_GET_SHAS) return { ok: false, response: json({ error: "bad_request", message: "too many shas", max: MAX_BATCH_GET_SHAS }, 400) };
  return { ok: true, shas };
}

function batchPutMaxRecords(env: Env): number {
  const n = Number(env.RBOX_BLOB_BATCH_MAX_RECORDS);
  if (!Number.isInteger(n) || n < 1) return BATCH_PUT_RECORDS_FLOOR;
  return Math.min(BATCH_PUT_RECORDS_MAX, Math.max(BATCH_PUT_RECORDS_FLOOR, n));
}

async function readBatchPutRequest(req: Request, maxRecords: number): Promise<
  | { ok: true; records: BatchPutRecord[]; acceptedPayloadBytes: number }
  | { ok: false; response: Response }
  | { ok: false; tooManyRecords: number }
> {
  const raw = await readBytesCapped(req, MAX_BATCH_BODY_BYTES);
  if (raw === null) return { ok: false, response: json({ error: "bad_request", message: "request body too large" }, 400) };
  const parsed = parseBatchPutFrames(raw, maxRecords);
  if (!parsed.ok) {
    if ("tooManyRecords" in parsed) return parsed;
    return { ok: false, response: json({ error: "bad_request", message: parsed.message }, 400) };
  }
  let acceptedPayloadBytes = 0;
  for (const r of parsed.records) if (r.payload.byteLength <= MAX_BATCH_RECORD_BYTES) acceptedPayloadBytes += r.payload.byteLength;
  return { ok: true, records: parsed.records, acceptedPayloadBytes };
}

function parseBatchPutFrames(raw: Uint8Array, maxRecords: number):
  | { ok: true; records: BatchPutRecord[] }
  | { ok: false; message: string }
  | { ok: false; tooManyRecords: number } {
  const records: BatchPutRecord[] = [];
  let count = 0;
  for (let off = 0; off < raw.byteLength;) {
    if (raw.byteLength - off < BATCH_FRAME_HEADER_BYTES) return { ok: false, message: "truncated frame header" };
    const head = raw.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const word = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
    if ((word & BATCH_STATUS_BIT) !== 0) return { ok: false, message: "invalid frame length" };
    const len = word;
    if (raw.byteLength - off < len) return { ok: false, message: "truncated frame payload" };
    count++;
    if (count <= maxRecords) {
      records.push({ sha: toHex(head.subarray(0, 32)), payload: raw.subarray(off, off + len) });
    }
    off += len;
  }
  if (count === 0) return { ok: false, message: "empty batch" };
  if (count > maxRecords) return { ok: false, tooManyRecords: count };
  return { ok: true, records };
}

async function writeBatchPutRecords(op: Op, records: BatchPutRecord[], accountId: string): Promise<BatchPutResult[]> {
  const unique: BatchPutRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.sha)) continue;
    seen.add(record.sha);
    unique.push(record);
  }

  const settled = await Promise.allSettled(unique.map((record) => putOneRecord(op, record, accountId)));
  const written: Array<{ sha: string; size: number }> = [];
  const preliminary = new Map<string, WrittenBatchPutResult>();
  for (let i = 0; i < settled.length; i++) {
    const record = unique[i]!;
    const result = settled[i]!;
    const value: WrittenBatchPutResult = result.status === "fulfilled" ? result.value : { sha256: record.sha, ok: false, error: "r2_error" };
    preliminary.set(record.sha, value);
    if (value.ok) written.push({ sha: value.sha256, size: value.sizeBytes });
  }
  // One amortized fence point-read for the whole upload batch. If it fails or
  // finds any open intent, no receipt in this request is minted.
  const receipts = await mintFenceCheckedReceipts(op.env, accountId, written);
  const bySha = new Map<string, BatchPutResult>();
  for (const [sha, value] of preliminary) {
    bySha.set(sha, value.ok ? { ...value, ...receipts.get(sha)! } : value);
  }
  return records.map((record) => bySha.get(record.sha)!);
}

async function putOneRecord(op: Op, record: BatchPutRecord, _accountId: string): Promise<WrittenBatchPutResult> {
  if (record.payload.byteLength > MAX_BATCH_RECORD_BYTES) return { sha256: record.sha, ok: false, error: "too_large" };
  if (await sha256Hex(record.payload) !== record.sha) return { sha256: record.sha, ok: false, error: "sha_mismatch" };
  const sizeBytes = await directWriteVerified(op.env, record.sha, record.payload, op.span.r2.bind(op.span));
  return { sha256: record.sha, ok: true, sizeBytes };
}

function streamBatch(op: Op, shas: string[], opts: { accountId: string; grantPreauth?: boolean }): ReadableStream<Uint8Array> {
  let payloadBytes = 0;
  const outcome = opts.grantPreauth ? "ok_grant_preauth" : "ok";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const results = opts.grantPreauth ? shas.map((sha) => fetchObject(op, sha)) : await authenticatedResults(op, shas, opts.accountId);
        const pending = [...results];
        let dataBytes = 0;
        while (pending.length) {
          const indexed = pending.map((promise, index) => promise.then((result) => ({ index, result })));
          const { index, result } = await Promise.race(indexed);
          pending.splice(index, 1);
          if (result.kind === "object") {
            if (dataBytes + result.size > MAX_BATCH_BODY_BYTES) {
              payloadBytes += enqueueStatus(controller, result.sha, "too_large", { size: result.size });
              continue;
            }
            controller.enqueue(encodeBatchFrameHeader(result.sha, result.size, false));
            controller.enqueue(new Uint8Array(result.bytes));
            dataBytes += result.size;
            payloadBytes += result.size;
          } else {
            payloadBytes += enqueueStatus(controller, result.sha, result.status, { code: result.code, size: result.size });
          }
        }
        op.done(outcome, { count: shas.length, bytes: payloadBytes });
        controller.close();
      } catch (e) {
        op.done("error", { count: shas.length, bytes: payloadBytes });
        controller.error(e);
      }
    },
  });
}

async function authenticatedResults(op: Op, shas: string[], accountId: string): Promise<Array<Promise<BatchResult>>> {
  const entitlements = await Promise.all(shas.map((sha) => isEntitled(op.env, accountId, sha).then((ok) => ({ sha, ok }))));
  return entitlements.map(({ sha, ok }) => (ok ? fetchObject(op, sha) : Promise.resolve({ sha, kind: "status", status: "missing" })));
}

async function fetchObject(op: Op, sha: string): Promise<BatchResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Body bytes are pre-read INSIDE the parallel fan-out (bounded: ≤256 KiB
      // each, ≤8 MiB per batch). Piping R2 bodies one at a time through the
      // response stream serializes ~30ms per object — the rejected-d76 failure
      // mode reappearing at the body layer. Over-cap objects skip the body read.
      const got = await op.span.r2(async () => {
        const obj = await op.env.rbox_dev_blobs.get(blobKey(sha));
        if (!obj) return null;
        if (obj.size > MAX_BATCH_RECORD_BYTES) return { size: obj.size };
        return { size: obj.size, bytes: await obj.arrayBuffer() };
      });
      if (!got) return { sha, kind: "status", status: "missing" };
      if (got.bytes === undefined) return { sha, kind: "status", status: "too_large", size: got.size };
      return { sha, kind: "object", size: got.size, bytes: got.bytes };
    } catch {
      if (attempt === 1) return { sha, kind: "status", status: "error", code: "r2" };
    }
  }
}

function enqueueStatus(controller: ReadableStreamDefaultController<Uint8Array>, sha: string, status: BatchStatus, extra: { code?: string; size?: number } = {}): number {
  const [header, payload] = encodeBatchStatusFrame(sha, status, extra);
  controller.enqueue(header);
  controller.enqueue(payload);
  return payload.byteLength;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
