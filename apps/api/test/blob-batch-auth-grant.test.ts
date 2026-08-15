import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import type { JsonValue } from "../../../src/json.js";
import { BATCH_BLOB_CONTENT_TYPE, BATCH_FRAME_HEADER_BYTES, blobBatchPut, encodeBatchFrameHeader } from "../src/blob-batch.js";
import { blobsCheck } from "../src/blobs.js";
import type { Env } from "../src/env.js";
import {
  GRANT_TTL_MS,
  UPLOAD_GRANT_TTL_MS,
  mintGrant,
  mintUploadGrant,
  verifyUploadGrantCredential,
} from "../src/grants.js";
import { verifyReceipt } from "../src/receipts.js";
import { blobKey, toHex } from "../src/util.js";

const BASE = "https://example.com";
const KEY = "u".repeat(40);
const PREV = "p".repeat(40);
const NOW = 1_700_000_000_000;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Request header maps: an open, string-valued dictionary owned by the HTTP boundary. */
type HeaderMap = Record<string, string>;

const bearer = (token: string, extra: HeaderMap = {}): HeaderMap => ({ authorization: `Bearer ${token}`, ...extra });
const receipts = { "x-rbox-protocol": "upload-receipts-v1" };

beforeAll(async () => applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS));

async function bootstrap(name: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string; accountId: string; deviceId: string }>;
}

interface BatchPutFrame {
  body: Uint8Array;
  sha256: string;
}

function batchPutBody(content: string): BatchPutFrame {
  const payload = new TextEncoder().encode(content);
  const sha256 = sha(content);
  const body = new Uint8Array(BATCH_FRAME_HEADER_BYTES + payload.byteLength);
  body.set(encodeBatchFrameHeader(sha256, payload.byteLength, false));
  body.set(payload, BATCH_FRAME_HEADER_BYTES);
  return { body, sha256 };
}

async function batchPut(headers: HeaderMap, content: string): Promise<Response> {
  const { body } = batchPutBody(content);
  return SELF.fetch(`${BASE}/v1/blob-batch/put`, {
    method: "POST",
    headers: { "content-type": BATCH_BLOB_CONTENT_TYPE, ...headers },
    body,
  });
}

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function signedUploadPayload(key: string, payload: JsonValue): Promise<string> {
  const enc = new TextEncoder();
  const kid = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(key)))).slice(0, 8);
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const body = `${kid}.${payloadB64}`;
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = toHex(new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(`rbox.upload-grant.v1|${body}`))));
  return `${body}.${b64url(enc.encode(mac))}`;
}

/** The one fence read `blobBatchPut` performs, widened so the real D1 types stay
 *  assignable to the double. */
interface FenceStatement {
  bind(...values: unknown[]): FenceStatement;
  first(): Promise<{ sha256: string } | null>;
}

interface FenceDb {
  prepare(query: string): FenceStatement;
}

function fenceDb(fenced: boolean): D1Database {
  const statement: FenceStatement = {
    bind: () => statement,
    first: async () => fenced ? { sha256: "fenced" } : null,
  };
  const db: FenceDb = { prepare: () => statement };
  return db as D1Database;
}

function metricEnv(points: Array<{ indexes?: string[]; blobs?: string[] }>, opts: { fence?: boolean; flag?: string } = {}): Env {
  // Only the bindings this path reads; `Pick` keeps each one's real type, so the
  // single assertion below stays a plain downcast.
  const bindings: Pick<Env, "RBOX_AUTH_GRANT" | "RBOX_RECEIPT_KEY" | "RBOX_GRANT_KEY" | "rbox_metrics" | "rbox_dev_db" | "rbox_dev_blobs"> = {
    RBOX_AUTH_GRANT: opts.flag,
    RBOX_RECEIPT_KEY: "r".repeat(40),
    RBOX_GRANT_KEY: KEY,
    rbox_metrics: { writeDataPoint: (point: { indexes?: string[]; blobs?: string[] }) => points.push(point) } as AnalyticsEngineDataset,
    rbox_dev_db: fenceDb(opts.fence === true),
    rbox_dev_blobs: {
      put: async (_key: string, body: Uint8Array): Promise<R2Object> => ({ size: body.byteLength }) as R2Object,
    } as R2Bucket,
  };
  return bindings as Env;
}

describe("§109 upload grants (default on when RBOX_AUTH_GRANT is unset)", () => {
  test("mints only on receipts checks, including the empty refresh transport", async () => {
    const a = await bootstrap("auth-grant-check");
    const legacy = await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST", headers: bearer(a.token, { "content-type": "application/json" }), body: JSON.stringify({ shas: [] }),
    });
    expect(await legacy.json()).toEqual({ missing: [] });

    const refresh = await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST", headers: bearer(a.token, { "content-type": "application/json", ...receipts }), body: JSON.stringify({ shas: [] }),
    });
    expect(refresh.status).toBe(200);
    const body = await refresh.json() as { missing: string[]; uploadGrant?: unknown };
    expect(body.missing).toEqual([]);
    expect(typeof body.uploadGrant).toBe("string");
  });

  test("valid grant remains accepted within TTL after device revocation, and binds receipts to the signed account", async () => {
    const a = await bootstrap("auth-grant-fast");
    const grant = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() });
    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(a.deviceId).run();
    expect((await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST", headers: bearer(a.token, { "content-type": "application/json" }), body: JSON.stringify({ shas: [] }),
    })).status).toBe(401);
    // The revoked durable bearer still rides this request, pinning the documented
    // within-TTL revocation lag. A syntactically garbage bearer is separately accepted
    // by the fast-path test contract; bearer presence on every dispatch is client-owned.
    const content = "upload grant fast path";
    const { sha256, body } = batchPutBody(content);
    const res = await SELF.fetch(`${BASE}/v1/blob-batch/put`, {
      method: "POST",
      headers: bearer(a.token, { "content-type": BATCH_BLOB_CONTENT_TYPE, ...receipts, "x-rbox-upload-grant": grant! }),
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-rbox-auth-path")).toBe("grant");
    expect(await env.rbox_dev_blobs.get(blobKey(sha256))).not.toBeNull();
    const result = (await res.json() as { results: Array<{ receipt: string; sizeBytes: number }> }).results[0]!;
    expect(await verifyReceipt(env, result.receipt, { accountId: a.accountId, encSha: sha256, size: result.sizeBytes, nowMs: Date.now() })).toEqual({ ok: true, size: result.sizeBytes });
  });

  test("a pre-tombstone grant remains usable only within TTL after account tombstoning", async () => {
    const a = await bootstrap("auth-grant-account-tombstone");
    const grant = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() });
    const expired = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() - UPLOAD_GRANT_TTL_MS - 1 });
    await env.rbox_dev_db.prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(Date.now(), a.accountId).run();

    expect((await SELF.fetch(`${BASE}/v1/blobs/check`, {
      method: "POST", headers: bearer(a.token, { "content-type": "application/json" }), body: JSON.stringify({ shas: [] }),
    })).status).toBe(401);

    const withinTtl = await batchPut(bearer(a.token, { ...receipts, "x-rbox-upload-grant": grant! }), "account tombstone within ttl");
    expect(withinTtl.status).toBe(200);
    expect(withinTtl.headers.get("x-rbox-auth-path")).toBe("grant");

    const afterTtl = await batchPut(bearer(a.token, { ...receipts, "x-rbox-upload-grant": expired! }), "account tombstone expired");
    expect(afterTtl.status).toBe(401);
  });

  test("missing, malformed, wrong-domain, expired, and wrong-key grants use the bearer path", async () => {
    const a = await bootstrap("auth-grant-fallbacks");
    const download = await mintGrant(env, { accountId: a.accountId, workspaceId: "ws", nowMs: Date.now() });
    const expired = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() - UPLOAD_GRANT_TTL_MS - 10_000 });
    const wrongKey = await mintUploadGrant({ ...env, RBOX_GRANT_KEY: "x".repeat(40) } as Env, { accountId: a.accountId, nowMs: Date.now() });
    const cases: Array<string | undefined> = [undefined, "malformed", download!, expired!, wrongKey!];
    for (const [i, grant] of cases.entries()) {
      const headers: HeaderMap = { ...receipts };
      if (grant) headers["x-rbox-upload-grant"] = grant;
      const res = await batchPut(bearer(a.token, headers), `fallback-${i}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rbox-auth-path")).toBe("bearer");
    }
  });

  test("upload grants are domain- and route-narrow; expiry closes the revocation-lag window", async () => {
    const a = await bootstrap("auth-grant-narrow");
    const grant = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() });
    const expired = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() - UPLOAD_GRANT_TTL_MS - 10_000 });
    const garbage = { authorization: "garbage", "content-type": "application/json", "x-rbox-upload-grant": grant!, ...receipts };
    const routes: Array<[string, string, BodyInit | undefined]> = [
      ["POST", "/v1/blob-batch/get", JSON.stringify([sha("absent")])],
      ["POST", "/v1/blobs/check", JSON.stringify({ shas: [] })],
      ["PUT", `/v1/blobs/${sha("single")}`, "single"],
      ["POST", "/v1/ws/ws/proj/root/manifests", "{}"],
      ["POST", "/v1/ws/ws/proj/root/receipts/redeem", "{}"],
    ];
    for (const [method, path, body] of routes) {
      expect((await SELF.fetch(`${BASE}${path}`, { method, headers: garbage, body })).status).toBe(401);
    }
    expect((await SELF.fetch(`${BASE}/v1/blobs/${sha("absent")}`, { headers: { authorization: "garbage", "x-rbox-download-grant": grant! } })).status).toBe(401);
    expect((await batchPut({ authorization: "garbage", ...receipts, "x-rbox-upload-grant": expired! }, "expired-denied")).status).toBe(401);
    expect((await batchPut({ authorization: "garbage", "x-rbox-upload-grant": grant! }, "protocol-denied")).status).toBe(401);
  });

  test("auth event and echo are exactly once on success and error; flag off is byte-identical", async () => {
    const successPoints: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const { body } = batchPutBody("metric success");
    const success = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST", headers: receipts, body }), metricEnv(successPoints), "acct", "fast_path");
    expect(success.headers.get("x-rbox-auth-path")).toBe("grant");
    expect(successPoints.filter((p) => p.indexes?.[0] === "blob.batchPut.auth").map((p) => p.blobs?.[2])).toEqual(["fast_path"]);
    expect(successPoints.filter((p) => p.indexes?.[0] === "blob.batchPut")).toHaveLength(1);

    const defaultPoints: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const defaultFallback = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST", headers: receipts, body: new Uint8Array() }), metricEnv(defaultPoints), "acct");
    expect(defaultFallback.status).toBe(400); // malformed/empty frame exit
    expect(defaultFallback.headers.get("x-rbox-auth-path")).toBe("bearer");
    expect(defaultPoints.filter((p) => p.indexes?.[0] === "blob.batchPut.auth").map((p) => p.blobs?.[2])).toEqual(["fallback_missing"]);

    for (const outcome of ["fallback_missing", "fallback_invalid", "fallback_expired"] as const) {
      const points: Array<{ indexes?: string[]; blobs?: string[] }> = [];
      const res = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST" }), metricEnv(points), "acct", outcome);
      expect(res.status).toBe(400);
      expect(res.headers.get("x-rbox-auth-path")).toBe("bearer");
      expect(points.filter((p) => p.indexes?.[0] === "blob.batchPut.auth").map((p) => p.blobs?.[2])).toEqual([outcome]);
    }

    const fencePoints: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const fencedBody = batchPutBody("metric fence").body;
    const fenced = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST", headers: receipts, body: fencedBody }), metricEnv(fencePoints, { fence: true }), "acct", "fast_path");
    expect(fenced.status).toBe(503);
    expect(fenced.headers.get("x-rbox-auth-path")).toBe("grant");
    expect(fencePoints.filter((p) => p.indexes?.[0] === "blob.batchPut.auth").map((p) => p.blobs?.[2])).toEqual(["fast_path"]);

    const offPoints: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const off = await blobBatchPut(new Request(`${BASE}/v1/blob-batch/put`, { method: "POST" }), metricEnv(offPoints, { flag: "0" }), "acct");
    expect(off.status).toBe(400);
    expect(await off.json()).toEqual({ error: "receipts_required" });
    expect(off.headers.get("x-rbox-auth-path")).toBeNull();
    expect(offPoints.some((p) => p.indexes?.[0] === "blob.batchPut.auth")).toBe(false);

    const offSuccessPoints: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const offSuccessBody = batchPutBody("flag off success").body;
    const offSuccess = await blobBatchPut(
      new Request(`${BASE}/v1/blob-batch/put`, { method: "POST", headers: { ...receipts, "content-type": BATCH_BLOB_CONTENT_TYPE }, body: offSuccessBody }),
      metricEnv(offSuccessPoints, { flag: "0" }),
      "acct",
    );
    expect(offSuccess.status).toBe(200);
    expect(offSuccess.headers.get("x-rbox-auth-path")).toBeNull();
    const offResults = (await offSuccess.json() as { results: Array<{ ok: boolean; receipt?: string }> }).results;
    expect(offResults).toHaveLength(1);
    expect(offResults[0]!.ok).toBe(true);
    expect(typeof offResults[0]!.receipt).toBe("string");
    expect(offSuccessPoints.filter((p) => p.indexes?.[0] === "blob.batchPut").map((p) => p.blobs?.[2])).toEqual(["ok"]);
    expect(offSuccessPoints.some((p) => p.indexes?.[0] === "blob.batchPut.auth")).toBe(false);

    const check = await blobsCheck(new Request(`${BASE}/v1/blobs/check`, { method: "POST", headers: { "content-type": "application/json", ...receipts }, body: JSON.stringify({ shas: [] }) }), { ...env, RBOX_AUTH_GRANT: "0" } as Env, "acct");
    expect(await check.json()).toEqual({ missing: [] });
  });

  test("credential verifier fails closed and supports previous-key rotation", async () => {
    const e = { RBOX_GRANT_KEY: KEY } as Env;
    const valid = await mintUploadGrant(e, { accountId: "acct", nowMs: NOW });
    expect(await verifyUploadGrantCredential(e, valid!, { nowMs: NOW })).toEqual({ ok: true, accountId: "acct" });
    const reason = async (grant: string): Promise<string | undefined> => {
      const result = await verifyUploadGrantCredential(e, grant, { nowMs: NOW });
      return result.ok ? undefined : result.reason;
    };
    expect(await reason("bad")).toBe("malformed");
    expect(await reason(`${valid!.split(".")[0]}.${valid!.split(".")[1]}.bm9wZQ`)).toBe("bad_mac");
    expect(await reason((await mintUploadGrant({ RBOX_GRANT_KEY: "z".repeat(40) } as Env, { accountId: "acct", nowMs: NOW }))!)).toBe("bad_kid");

    const claims: Array<[JsonValue, string]> = [
      [{ v: 2, a: "acct", t: NOW, e: NOW + 1 }, "bad_version"],
      [{ v: 1, a: "acct", t: NOW + 120_000, e: NOW + 120_001 }, "future"],
      [{ v: 1, a: "acct", t: NOW + 59_000, e: NOW + 59_000 + UPLOAD_GRANT_TTL_MS }, "future"],
      [{ v: 1, a: "acct", t: NOW, e: NOW + UPLOAD_GRANT_TTL_MS + 1 }, "bad_ttl"],
      [{ v: 1, t: NOW, e: NOW + 1 }, "malformed"],
    ];
    for (const [claim, expectedReason] of claims) {
      expect(await reason(await signedUploadPayload(KEY, claim))).toBe(expectedReason);
    }
    expect(await verifyUploadGrantCredential(e, await signedUploadPayload(KEY, {
      v: 1, a: "acct", t: NOW, e: NOW + UPLOAD_GRANT_TTL_MS,
    }), { nowMs: NOW })).toEqual({ ok: true, accountId: "acct" });
    const old = await mintUploadGrant({ RBOX_GRANT_KEY: PREV } as Env, { accountId: "acct", nowMs: NOW });
    expect(await verifyUploadGrantCredential({ RBOX_GRANT_KEY: KEY, RBOX_GRANT_KEY_PREV: PREV } as Env, old!, { nowMs: NOW })).toEqual({ ok: true, accountId: "acct" });
    expect(await reason(await signedUploadPayload(KEY, { v: 1, a: "acct", t: NOW - GRANT_TTL_MS, e: NOW }))).toBe("expired");
  });
});
