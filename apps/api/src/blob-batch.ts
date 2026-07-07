import type { Env } from "./env.js";
import { isEntitled } from "./authz.js";
import { readBodyCapped } from "./commit-envelope.js";
import { startOp, type Op } from "./metrics.js";
import { blobKey, json, SHA256_HEX_RE } from "./util.js";

// Wire twin: src/cli/remote/blob-batch.ts — the framing constants and codec are
// duplicated per build target (house pattern, like UPLOAD_RECEIPTS_V1). Change
// them in lockstep; nothing fails to compile if they drift.

export const BATCH_BLOB_CONTENT_TYPE = "application/x-rbox-blobs";
export const BATCH_FRAME_HEADER_BYTES = 36;
export const BATCH_STATUS_BIT = 0x80000000;
export const MAX_BATCH_RECORD_BYTES = 256 * 1024;
const BATCH_STATUS_MAX_BYTES = 4 * 1024;
const MAX_BATCH_RECORDS = 32;
const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_REQUEST_BYTES = 4 * 1024;

type BatchStatus = "missing" | "too_large" | "error";
type BatchResult =
  | { sha: string; kind: "object"; object: R2ObjectBody }
  | { sha: string; kind: "status"; status: BatchStatus; code?: string; size?: number };

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
  if (shas.length > MAX_BATCH_RECORDS) return { ok: false, response: json({ error: "bad_request", message: "too many shas", max: MAX_BATCH_RECORDS }, 400) };
  return { ok: true, shas };
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
            if (result.object.size > MAX_BATCH_RECORD_BYTES || dataBytes + result.object.size > MAX_BATCH_BODY_BYTES) {
              payloadBytes += enqueueStatus(controller, result.sha, "too_large", { size: result.object.size });
              continue;
            }
            controller.enqueue(encodeBatchFrameHeader(result.sha, result.object.size, false));
            dataBytes += result.object.size;
            payloadBytes += await enqueueObjectBody(controller, result.object);
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
      const obj = await op.span.r2(() => op.env.rbox_dev_blobs.get(blobKey(sha)));
      return obj ? { sha, kind: "object", object: obj } : { sha, kind: "status", status: "missing" };
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

async function enqueueObjectBody(controller: ReadableStreamDefaultController<Uint8Array>, obj: R2ObjectBody): Promise<number> {
  const reader = obj.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        total += value.byteLength;
        controller.enqueue(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort only; preserve the original stream outcome.
    }
  }
  return total;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
