import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  BATCH_BLOB_CONTENT_TYPE,
  BATCH_FRAME_HEADER_BYTES,
  BATCH_STATUS_BIT,
  MAX_BATCH_RECORD_BYTES,
  blobBatchPut,
  blobBatchGetWithVerifiedGrant,
  encodeBatchFrameHeader,
  encodeBatchStatusFrame,
} from "../src/blob-batch.js";
import { mintGrant, GRANT_TTL_MS } from "../src/grants.js";
import { blobKey } from "../src/util.js";
import type { Env } from "../src/env.js";
import { verifyReceipt } from "../src/receipts.js";

const BASE = "https://example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra });

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ token: string; accountId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string };
}

async function putBlob(token: string, content: string): Promise<string> {
  const s = sha(content);
  const res = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(token, { "content-length": String(content.length) }), body: content });
  expect(res.status).toBe(200);
  return s;
}

interface DecodedFrame {
  sha: string;
  status: boolean;
  payload: Uint8Array;
}

async function decodeFrames(res: Response): Promise<DecodedFrame[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const out: DecodedFrame[] = [];
  for (let off = 0; off < bytes.byteLength;) {
    expect(bytes.byteLength - off).toBeGreaterThanOrEqual(BATCH_FRAME_HEADER_BYTES);
    const head = bytes.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const s = [...head.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const word = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
    const status = (word & BATCH_STATUS_BIT) !== 0;
    const len = word & 0x7fffffff;
    expect(bytes.byteLength - off).toBeGreaterThanOrEqual(len);
    out.push({ sha: s, status, payload: bytes.subarray(off, off + len) });
    off += len;
  }
  return out;
}

function statusText(f: DecodedFrame): string {
  return new TextDecoder().decode(f.payload);
}

function r2Object(bytes: Uint8Array): R2ObjectBody {
  return {
    size: bytes.byteLength,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as R2ObjectBody;
}

function fakePutEnv(opts: { throwSha?: string; metrics?: Array<{ blobs: string[]; doubles: number[] }> } = {}): Env & { putKeys: string[] } {
  const putKeys: string[] = [];
  return {
    RBOX_RECEIPT_KEY: "r".repeat(40),
    rbox_dev_db: {},
    rbox_metrics: opts.metrics
      ? { writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => opts.metrics!.push(point) }
      : undefined,
    rbox_dev_blobs: {
      put: (key: string, body: Uint8Array) => {
        const s = key.slice(-64);
        putKeys.push(s);
        if (s === opts.throwSha) throw new Error("r2 down");
        return Promise.resolve({ size: body.byteLength });
      },
    },
    putKeys,
  } as unknown as Env & { putKeys: string[] };
}

function batchPutBody(records: Array<{ sha: string; payload: Uint8Array }>): Uint8Array {
  const frames = records.map(({ sha, payload }) => {
    const frame = new Uint8Array(BATCH_FRAME_HEADER_BYTES + payload.byteLength);
    frame.set(encodeBatchFrameHeader(sha, payload.byteLength, false), 0);
    frame.set(payload, BATCH_FRAME_HEADER_BYTES);
    return frame;
  });
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
  let off = 0;
  for (const frame of frames) {
    out.set(frame, off);
    off += frame.byteLength;
  }
  return out;
}

async function batchPutDirect(body: Uint8Array, envOverride = fakePutEnv(), headers: Record<string, string> = { "x-rbox-protocol": "upload-receipts-v1" }): Promise<Response> {
  return blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST", headers, body }), envOverride, "acct_batch_put");
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("batch blob frame encoding", () => {
  test("encodes raw sha, big-endian length, and high-bit status records", () => {
    const s = "ab".repeat(32);
    const dataHeader = encodeBatchFrameHeader(s, 0x010203, false);
    expect(dataHeader.byteLength).toBe(36);
    expect([...dataHeader.subarray(0, 4)]).toEqual([0xab, 0xab, 0xab, 0xab]);
    expect(new DataView(dataHeader.buffer, dataHeader.byteOffset + 32, 4).getUint32(0, false)).toBe(0x010203);

    const [statusHeader, payload] = encodeBatchStatusFrame(s, "missing");
    expect(new DataView(statusHeader.buffer, statusHeader.byteOffset + 32, 4).getUint32(0, false)).toBe((BATCH_STATUS_BIT | payload.byteLength) >>> 0);
    expect(new TextDecoder().decode(payload)).toBe('{"status":"missing"}');
  });
});

describe("POST /v1/blob-batch/get", () => {
  test("valid grant pre-auth serves frames without a bearer", async () => {
    const a = await bootstrap("batch-grant-ok");
    const s1 = await putBlob(a.token, "batch grant one");
    const s2 = await putBlob(a.token, "batch grant two");
    const grant = await mintGrant(env, { accountId: a.accountId, workspaceId: "ws_batch", nowMs: Date.now() });
    const res = await SELF.fetch(`${BASE}/v1/blob-batch/get`, {
      method: "POST",
      headers: { "x-rbox-download-grant": grant!, "content-type": "application/json" },
      body: JSON.stringify([s1, s2]),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(BATCH_BLOB_CONTENT_TYPE);
    const frames = await decodeFrames(res);
    expect(new Set(frames.map((f) => f.sha))).toEqual(new Set([s1, s2]));
    expect(frames.every((f) => !f.status)).toBe(true);
  });

  test("bad or expired grant plus valid bearer falls back to authenticated entitlement", async () => {
    const a = await bootstrap("batch-bad-grant-fallback");
    const s = await putBlob(a.token, "batch fallback bytes");
    const expired = await mintGrant(env, { accountId: a.accountId, workspaceId: "ws_batch", nowMs: Date.now() - GRANT_TTL_MS - 10_000 });
    const res = await SELF.fetch(`${BASE}/v1/blob-batch/get`, {
      method: "POST",
      headers: authed(a.token, { "x-rbox-download-grant": expired! }),
      body: JSON.stringify([s]),
    });
    expect(res.status).toBe(200);
    const [frame] = await decodeFrames(res);
    expect(frame?.status).toBe(false);
    expect(new TextDecoder().decode(frame!.payload)).toBe("batch fallback bytes");
  });

  test("unentitled and absent shas are byte-identical missing status frames", async () => {
    const a = await bootstrap("batch-no-oracle-a");
    const b = await bootstrap("batch-no-oracle-b");
    const presentButUnentitled = await putBlob(a.token, "batch unentitled bytes");
    const absent = sha("batch absent sha");
    const res = await SELF.fetch(`${BASE}/v1/blob-batch/get`, {
      method: "POST",
      headers: authed(b.token),
      body: JSON.stringify([presentButUnentitled, absent]),
    });
    expect(res.status).toBe(200);
    const frames = await decodeFrames(res);
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.status)).toBe(true);
    expect(statusText(frames[0]!)).toBe('{"status":"missing"}');
    expect(statusText(frames[1]!)).toBe(statusText(frames[0]!));
  });

  test("requires a grant or bearer, and validates JSON with an actual-byte cap", async () => {
    const a = await bootstrap("batch-validation");
    const s = sha("batch-validation");
    expect((await SELF.fetch(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([s]) })).status).toBe(401);
    const cases: unknown[] = [
      "",
      "{}",
      "[]",
      JSON.stringify(["not-a-sha"]),
      JSON.stringify(Array.from({ length: 33 }, (_, i) => sha(`too-many-${i}`))),
      JSON.stringify([s, "x".repeat(5000)]),
    ];
    for (const body of cases) {
      const res = await SELF.fetch(`${BASE}/v1/blob-batch/get`, { method: "POST", headers: authed(a.token), body: String(body) });
      expect(res.status).toBe(400);
    }
    const deduped = await SELF.fetch(`${BASE}/v1/blob-batch/get`, { method: "POST", headers: authed(a.token), body: JSON.stringify(Array.from({ length: 33 }, () => s)) });
    expect(deduped.status).toBe(200);
  });

  test("starts all R2 gets before completion and streams frames in completion order", async () => {
    const shas = [sha("p1"), sha("p2"), sha("p3")];
    const waits = new Map(shas.map((s) => [s, deferred<R2ObjectBody | null>()]));
    const started: string[] = [];
    const fakeEnv = {
      rbox_dev_db: {},
      rbox_dev_blobs: {
        get: (key: string) => {
          const s = key.slice(-64);
          started.push(s);
          return waits.get(s)!.promise;
        },
      },
    } as unknown as Env;
    const res = await blobBatchGetWithVerifiedGrant(
      new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify(shas) }),
      fakeEnv,
      "acct_parallel",
    );
    const body = decodeFrames(res);
    await Promise.resolve();
    expect(started).toEqual(shas);
    // Yield between resolutions: once several results are settled at race time
    // the drain legitimately proceeds in array order, so completion order is
    // only observable when completions are actually spaced out.
    const settle = () => new Promise((r) => setTimeout(r, 0));
    waits.get(shas[1]!)!.resolve(r2Object(new TextEncoder().encode("two")));
    await settle();
    waits.get(shas[2]!)!.resolve(null);
    await settle();
    waits.get(shas[0]!)!.resolve(r2Object(new TextEncoder().encode("one")));
    const frames = await body;
    expect(frames.map((f) => f.sha)).toEqual([shas[1], shas[2], shas[0]]);
    expect(statusText(frames[1]!)).toBe('{"status":"missing"}');
  });

  test("retries a rejected R2 get once, then emits an error status", async () => {
    const s = sha("r2-error");
    let calls = 0;
    const fakeEnv = {
      rbox_dev_db: {},
      rbox_dev_blobs: {
        get: () => {
          calls++;
          throw new Error("r2 down");
        },
      },
    } as unknown as Env;
    const res = await blobBatchGetWithVerifiedGrant(new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([s]) }), fakeEnv, "acct_r2");
    const [frame] = await decodeFrames(res);
    expect(calls).toBe(2);
    expect(statusText(frame!)).toBe('{"status":"error","code":"r2"}');
  });

  test("oversized objects emit too_large without reading the object body", async () => {
    const s = sha("too-large");
    const fakeEnv = {
      rbox_dev_db: {},
      rbox_dev_blobs: {
        get: () =>
          ({
            size: MAX_BATCH_RECORD_BYTES + 1,
            get body(): ReadableStream<Uint8Array> {
              throw new Error("body should not be read");
            },
          }) as R2ObjectBody,
      },
    } as unknown as Env;
    const res = await blobBatchGetWithVerifiedGrant(new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([s]) }), fakeEnv, "acct_big");
    const [frame] = await decodeFrames(res);
    expect(statusText(frame!)).toBe(`{"status":"too_large","size":${MAX_BATCH_RECORD_BYTES + 1}}`);
  });
});

describe("POST /v1/blob-batch/put", () => {
  test("is routed on the authenticated path and requires upload receipts", async () => {
    const a = await bootstrap("batch-put-route");
    const payload = new TextEncoder().encode("route bytes");
    const s = sha("route bytes");
    const noReceipts = await SELF.fetch(`${BASE}/v1/blob-batch/put`, {
      method: "POST",
      headers: authed(a.token, { "content-type": BATCH_BLOB_CONTENT_TYPE }),
      body: batchPutBody([{ sha: s, payload }]),
    });
    expect(noReceipts.status).toBe(400);
    expect(await noReceipts.json()).toEqual({ error: "receipts_required" });

    const ok = await SELF.fetch(`${BASE}/v1/blob-batch/put`, {
      method: "POST",
      headers: authed(a.token, { "content-type": BATCH_BLOB_CONTENT_TYPE, "x-rbox-protocol": "upload-receipts-v1" }),
      body: batchPutBody([{ sha: s, payload }]),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { results: Array<{ ok: boolean; sha256: string; receipt?: string; sizeBytes?: number }> };
    expect(body.results[0]?.ok).toBe(true);
    expect(await env.rbox_dev_blobs.get(blobKey(s))).not.toBeNull();
    expect((await verifyReceipt(env, body.results[0]!.receipt!, { accountId: a.accountId, encSha: s, size: payload.byteLength, nowMs: Date.now() })).ok).toBe(true);
  });

  test("rejects malformed frames, empty batches, and lying content-length over the actual byte cap", async () => {
    const good = new TextEncoder().encode("x");
    const s = sha("x");
    const truncatedHeader = new Uint8Array(BATCH_FRAME_HEADER_BYTES - 1);
    const truncatedPayload = batchPutBody([{ sha: s, payload: good }]).subarray(0, BATCH_FRAME_HEADER_BYTES);
    const empty = new Uint8Array(0);
    for (const body of [truncatedHeader, truncatedPayload, empty]) {
      const res = await batchPutDirect(body);
      expect(res.status).toBe(400);
    }

    const tooBig = new Uint8Array(8 * 1024 * 1024 + 1);
    const res = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, {
      method: "POST",
      headers: { "x-rbox-protocol": "upload-receipts-v1", "content-length": "1" },
      body: tooBig,
    }), fakePutEnv(), "acct_batch_put");
    expect(res.status).toBe(400);
  });

  test("deduplicates duplicate shas and returns too_large per record while siblings succeed", async () => {
    const env2 = fakePutEnv();
    const okPayload = new TextEncoder().encode("dedupe payload");
    const okSha = sha("dedupe payload");
    const largePayload = new Uint8Array(MAX_BATCH_RECORD_BYTES + 1);
    const largeSha = createHash("sha256").update(largePayload).digest("hex");
    const res = await batchPutDirect(batchPutBody([
      { sha: okSha, payload: okPayload },
      { sha: largeSha, payload: largePayload },
      { sha: okSha, payload: okPayload },
    ]), env2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toEqual(body.results[2]);
    expect(body.results[1]).toEqual({ sha256: largeSha, ok: false, error: "too_large" });
    expect(env2.putKeys).toEqual([okSha]);
  });

  test("settles sha_mismatch and r2_error per record without discarding fulfilled receipts", async () => {
    const okPayload = new TextEncoder().encode("allsettled ok");
    const okSha = sha("allsettled ok");
    const mismatchPayload = new TextEncoder().encode("actual");
    const mismatchSha = sha("claimed");
    const throwPayload = new TextEncoder().encode("r2 boom");
    const throwSha = sha("r2 boom");
    const env2 = fakePutEnv({ throwSha });
    const res = await batchPutDirect(batchPutBody([
      { sha: okSha, payload: okPayload },
      { sha: mismatchSha, payload: mismatchPayload },
      { sha: throwSha, payload: throwPayload },
    ]), env2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ sha256: string; ok: boolean; error?: string; receipt?: string; sizeBytes?: number }> };
    expect(body.results[0]?.ok).toBe(true);
    expect(typeof body.results[0]?.receipt).toBe("string");
    expect(body.results[1]).toEqual({ sha256: mismatchSha, ok: false, error: "sha_mismatch" });
    expect(body.results[2]).toEqual({ sha256: throwSha, ok: false, error: "r2_error" });
    expect((await verifyReceipt(env2, body.results[0]!.receipt!, { accountId: "acct_batch_put", encSha: okSha, size: okPayload.byteLength, nowMs: Date.now() })).ok).toBe(true);
  });

  test("emits blob.batchPut metrics with ok, partial, and bad_request outcomes", async () => {
    const metrics: Array<{ blobs: string[]; doubles: number[] }> = [];
    const okPayload = new TextEncoder().encode("metric ok");
    const okSha = sha("metric ok");
    await batchPutDirect(batchPutBody([{ sha: okSha, payload: okPayload }]), fakePutEnv({ metrics }));

    const badSha = sha("not metric payload");
    await batchPutDirect(batchPutBody([{ sha: badSha, payload: okPayload }]), fakePutEnv({ metrics }));
    await batchPutDirect(new Uint8Array(0), fakePutEnv({ metrics }));

    expect(metrics.map((m) => m.blobs[2])).toEqual(["ok", "partial", "bad_request"]);
    expect(metrics[0]?.doubles[4]).toBe(okPayload.byteLength);
    expect(metrics[0]?.doubles[5]).toBe(1);
  });
});
