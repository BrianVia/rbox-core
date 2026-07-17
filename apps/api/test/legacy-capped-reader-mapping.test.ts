import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { blobBatchGet, blobBatchPut } from "../src/blob-batch.js";
import { blobPackPut } from "../src/blob-pack.js";
import type { Env } from "../src/env.js";
import { PACK_CONTENT_TYPE, PACK_MAX_BODY_BYTES } from "../../../src/engine/blob-pack.js";

const BASE = "https://api.rbox.to";
const RECEIPTS = { "x-rbox-protocol": "upload-receipts-v1" };

function brokenRequest(path: string, headers: Record<string, string>, error: Error): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: new ReadableStream({ pull(controller) { controller.error(error); } }),
  });
}

describe("legacy byte-reader consumer mappings", () => {
  test("blob-batch maps overflow to its legacy 400 and rethrows reader errors", async () => {
    const overflow = new Request(`${BASE}/v1/blobs/batch`, {
      method: "POST",
      headers: { ...RECEIPTS, "content-length": String(8 * 1024 * 1024 + 1) },
      body: new ArrayBuffer(0),
    });
    const response = await blobBatchPut(overflow, env as Env, "acct_test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request", message: "request body too large" });

    const failure = new Error("batch reader failed");
    await expect(blobBatchPut(brokenRequest("/v1/blobs/batch", RECEIPTS, failure), env as Env, "acct_test")).rejects.toBe(failure);
    await expect(blobBatchGet(brokenRequest("/v1/blobs/batch", {}, failure), env as Env, { accountId: "acct_test" })).rejects.toBe(failure);
  });

  test("blob-pack maps overflow to its legacy 400 and rethrows reader errors", async () => {
    const headers = {
      ...RECEIPTS,
      "content-type": PACK_CONTENT_TYPE,
      "x-rbox-pack-id": "a".repeat(32),
      "x-rbox-pack-sha256": "b".repeat(64),
    };
    const handlerEnv = { ...env, RBOX_BLOB_PACK_ACCEPT: "1" } as Env;
    const overflow = new Request(`${BASE}/v1/blob-pack/put`, {
      method: "POST",
      headers: { ...headers, "content-length": String(PACK_MAX_BODY_BYTES + 1) },
      body: new ArrayBuffer(0),
    });
    const response = await blobPackPut(overflow, handlerEnv, "acct_test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });

    const failure = new Error("pack reader failed");
    await expect(blobPackPut(brokenRequest("/v1/blob-pack/put", headers, failure), handlerEnv, "acct_test")).rejects.toBe(failure);
  });
});
