import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  BATCH_BLOB_CONTENT_TYPE,
  BATCH_FRAME_HEADER_BYTES,
  BATCH_STATUS_BIT,
  MAX_BATCH_RECORD_BYTES,
  blobBatchGetWithVerifiedGrant,
  encodeBatchFrameHeader,
  encodeBatchStatusFrame,
} from "../src/blob-batch.js";
import { mintGrant, GRANT_TTL_MS } from "../src/grants.js";
import { blobKey } from "../src/util.js";
import type { Env } from "../src/env.js";

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
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
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
