import type { Env } from "./env.js";
import { isEntitled } from "./authz.js";
import { emit, emitBlobBatchGetSummary, startOp, type BlobBatchGetSummary, type Op } from "./metrics.js";
import { uploadGrantsEnabled } from "./grants.js";
import { directWriteVerified, mintFenceCheckedReceipts, ReceiptFenceError, usesReceipts } from "./blobs.js";
import { blobKey, json, logErr, packKey, readBodyCapped, readBytesCapped, SHA256_HEX_RE, sha256Hex, toHex } from "./util.js";
import { dbFor } from "./db.js";
import { packedLocations, readPackedExtent, type PackedLocation } from "./blob-pack.js";

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

export interface PackReadExtent extends PackedLocation {
  sha: string;
}

export interface PackReadPlan {
  packId: string;
  offset: number;
  length: number;
  extents: PackReadExtent[];
  coalesced: boolean;
}

/** Pure global fetch-budget planner. Exact extents are always safe because the
 * request admits at most 32 × 256 KiB of logical payload; only gap bytes need
 * the separate budget decision. */
export function planPackReads(
  extents: PackReadExtent[],
  budgets: { fetchBytes: number; maxFetchBytes: number },
): PackReadPlan[] {
  const groups = new Map<string, PackReadExtent[]>();
  for (const extent of extents) {
    const group = groups.get(extent.pack_id);
    if (group) group.push(extent);
    else groups.set(extent.pack_id, [extent]);
  }
  const plans: PackReadPlan[] = [];
  // Reserve every exact member before spending budget on gap bytes. Without
  // this baseline, an early coalesced pack can consume space required by a
  // later pack's unavoidable exact reads.
  let used = budgets.fetchBytes + extents.reduce((sum, extent) => sum + extent.length, 0);
  for (const [packId, members] of groups) {
    members.sort((a, b) => a.offset - b.offset || a.sha.localeCompare(b.sha));
    const start = members[0]!.offset;
    const end = Math.max(...members.map((member) => member.offset + member.length));
    const coveringBytes = end - start;
    const exactBytes = members.reduce((sum, member) => sum + member.length, 0);
    const gapBytes = coveringBytes - exactBytes;
    if (used + gapBytes <= budgets.maxFetchBytes) {
      plans.push({ packId, offset: start, length: coveringBytes, extents: members, coalesced: true });
      used += gapBytes;
    } else {
      for (const member of members) {
        plans.push({ packId, offset: member.offset, length: member.length, extents: [member], coalesced: false });
      }
    }
  }
  return plans;
}
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
  if (!parsed.ok) {
    emitBlobBatchGetSummary(env, "bad_request", { canonicalCount: 0, packedCount: 0, r2RangeCount: 0, requestedBytes: 0, fetchedBytes: 0 });
    return parsed.response;
  }
  const op = startOp(env, "blob.batchGet");
  const summary: BlobBatchGetSummary = { canonicalCount: 0, packedCount: 0, r2RangeCount: 0, requestedBytes: 0, fetchedBytes: 0 };
  return new Response(streamBatch(op, parsed.shas, opts, summary), { headers: { "content-type": BATCH_BLOB_CONTENT_TYPE } });
}

export type BatchPutAuthOutcome = "fast_path" | "fallback_missing" | "fallback_invalid" | "fallback_expired";
/** The bearer-path subset of §109 auth outcomes, computed pre-auth in worker.ts. */
export type BatchPutAuthFallback = Exclude<BatchPutAuthOutcome, "fast_path">;

export async function blobBatchPutWithVerifiedGrant(req: Request, env: Env, accountId: string): Promise<Response> {
  return blobBatchPut(req, env, accountId, "fast_path");
}

export async function blobBatchPut(req: Request, env: Env, accountId: string, authOutcome?: BatchPutAuthOutcome): Promise<Response> {
  const op = startOp(env, "blob.batchPut");
  const auth = authOutcome ?? (uploadGrantsEnabled(env) ? "fallback_missing" : undefined);
  // Requests rejected by authenticate()/token-kind gates (401/403) never reach
  // this handler, so they have no auth event or echo; the request op covers them
  // (docs/observability-server-metrics.md). A post-verification handler throw
  // becomes a top-level 500 without the echo, but this entry event still records
  // the true path and the client safely over-reports that unclassified 500 as authn.
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

function streamBatch(
  op: Op,
  shas: string[],
  opts: { accountId: string; grantPreauth?: boolean },
  summary: BlobBatchGetSummary,
): ReadableStream<Uint8Array> {
  let payloadBytes = 0;
  const outcome = opts.grantPreauth ? "ok_grant_preauth" : "ok";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const results = await authenticatedResults(op, shas, opts.accountId, opts.grantPreauth === true, summary);
        const pending = [...results];
        let dataBytes = 0;
        let packError = false;
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
            if (result.code === "pack") packError = true;
            payloadBytes += enqueueStatus(controller, result.sha, result.status, { code: result.code, size: result.size });
          }
        }
        const finalOutcome = packError ? "pack_extent_error" : outcome;
        op.done(finalOutcome, { count: shas.length, bytes: payloadBytes });
        emitBlobBatchGetSummary(op.env, finalOutcome, summary);
        controller.close();
      } catch (e) {
        op.done("error", { count: shas.length, bytes: payloadBytes });
        emitBlobBatchGetSummary(op.env, "error", summary);
        controller.error(e);
      }
    },
  });
}

async function authenticatedResults(
  op: Op,
  shas: string[],
  accountId: string,
  grantPreauth: boolean,
  summary: BlobBatchGetSummary,
): Promise<Array<Promise<BatchResult>>> {
  const authorized = grantPreauth
    ? shas.map((sha) => ({ sha, ok: true }))
    : await Promise.all(shas.map((sha) => isEntitled(op.env, accountId, sha).then((ok) => ({ sha, ok }))));
  const authorizedShas = authorized.filter(({ ok }) => ok).map(({ sha }) => sha);
  // Authorization is deliberately complete before this placement read.
  const locations = await packedLocations(dbFor(op.env, accountId), authorizedShas);
  const packed = authorizedShas.flatMap((sha) => {
    const loc = locations.get(sha);
    return loc ? [{ sha, ...loc }] : [];
  });
  const canonicalCount = authorizedShas.length - packed.length;
  summary.canonicalCount = canonicalCount;
  summary.packedCount = packed.length;
  summary.requestedBytes += packed.reduce((sum, extent) => sum + extent.length, 0);
  // Canonical object sizes are only known after R2 responds. Reserve their
  // maximum admitted size when deciding whether gap-byte coalescing is safe;
  // this is conservative and leaves the existing canonical fan-out unchanged.
  const plans = planPackReads(packed, {
    fetchBytes: canonicalCount * MAX_BATCH_RECORD_BYTES,
    maxFetchBytes: MAX_BATCH_BODY_BYTES,
  });
  summary.r2RangeCount = plans.length;
  const packedResults = new Map<string, Promise<BatchResult>>();
  for (const plan of plans) {
    const read = fetchPackPlan(op, plan, summary);
    for (const extent of plan.extents) {
      packedResults.set(extent.sha, read.then((results) => results.get(extent.sha)!));
    }
  }
  return authorized.map(({ sha, ok }) => {
    if (!ok) return Promise.resolve({ sha, kind: "status", status: "missing" });
    return packedResults.get(sha) ?? fetchObject(op, sha, summary);
  });
}

async function fetchPackPlan(op: Op, plan: PackReadPlan, summary: BlobBatchGetSummary): Promise<Map<string, BatchResult>> {
  const out = new Map<string, BatchResult>();
  if (!plan.coalesced) {
    const extent = plan.extents[0]!;
    const bytes = await readPackedExtent(op, op.env, extent.sha, extent);
    if (bytes) summary.fetchedBytes += bytes.byteLength;
    out.set(extent.sha, bytes
      ? { sha: extent.sha, kind: "object", size: bytes.byteLength, bytes: bytes.buffer as ArrayBuffer }
      : { sha: extent.sha, kind: "status", status: "error", code: "pack" });
    return out;
  }
  try {
    const object = await op.span.r2(() =>
      op.env.rbox_dev_blobs.get(packKey(plan.packId), { range: { offset: plan.offset, length: plan.length } }),
    );
    if (!object) throw new Error("missing pack range");
    const covering = new Uint8Array(await object.arrayBuffer());
    if (covering.byteLength !== plan.length) throw new Error("short pack range");
    summary.fetchedBytes += covering.byteLength;
    let invalid = false;
    await Promise.all(plan.extents.map(async (extent) => {
      const start = extent.offset - plan.offset;
      const bytes = covering.slice(start, start + extent.length);
      if (bytes.byteLength !== extent.length || (await sha256Hex(bytes)) !== extent.sha) {
        invalid = true;
        out.set(extent.sha, { sha: extent.sha, kind: "status", status: "error", code: "pack" });
      } else {
        out.set(extent.sha, { sha: extent.sha, kind: "object", size: bytes.byteLength, bytes: bytes.buffer as ArrayBuffer });
      }
    }));
    if (invalid) logErr("pack_extent_error", new Error("invalid pack extent"));
  } catch (e) {
    logErr("pack_extent_error", e);
    for (const extent of plan.extents) out.set(extent.sha, { sha: extent.sha, kind: "status", status: "error", code: "pack" });
  }
  return out;
}

async function fetchObject(op: Op, sha: string, summary: BlobBatchGetSummary): Promise<BatchResult> {
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
      summary.requestedBytes += got.size;
      if (got.bytes === undefined) return { sha, kind: "status", status: "too_large", size: got.size };
      summary.fetchedBytes += got.bytes.byteLength;
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
