import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RboxApi, BlobShaMismatchError } from "./remote.js";
import type { JsonValue } from "../json.js";

// A live-folder edit between encrypt-time and the streamed PUT makes the ciphertext no
// longer hash to the declared encSha; the server rejects it. It signals that SAME error
// with two statuses — 400 on the single-PUT path, 412 on the multipart-complete publish
// (apps/api/src/blobs.ts). The client must map BOTH to BlobShaMismatchError so pushManifest
// can self-heal (re-scan + retry) instead of aborting the whole push. This fixes the HTTP
// mapping that the sync.ts FakeRemote (which sits above the transport) can't exercise.

const origFetch = globalThis.fetch;
const SHA = "a".repeat(64);
const BIG = 100 * 1024 * 1024; // > SINGLE_PUT_MAX (90 MiB) → forces the multipart path

const resp = (status: number, body: JsonValue): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  }) as Response;

const api = () => new RboxApi("https://api.test", "durable-token", "ws_1", "proj_1");

let tmpDir: string;
let file: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-remote-test-"));
  file = path.join(tmpDir, "ct.bin");
  await fs.writeFile(file, "ciphertext-bytes"); // body stream is never consumed by the stub
});
afterEach(async () => {
  globalThis.fetch = origFetch;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("blob PUT sha_mismatch → typed BlobShaMismatchError", () => {
  test("single-PUT 400 {error:sha_mismatch} → BlobShaMismatchError (not a generic abort)", async () => {
    globalThis.fetch = (async () => resp(400, { error: "sha_mismatch" })) as typeof fetch;
    await expect(api().putBlobFile(SHA, file, 16)).rejects.toBeInstanceOf(BlobShaMismatchError);
  });

  test("multipart-complete 412 {error:sha_mismatch} → BlobShaMismatchError", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/multipart") && method === "POST") return resp(200, { uploadId: "up1", partSize: BIG }); // 1 part
      if (u.includes("/part/")) return resp(200, {});
      if (u.endsWith("/complete")) return resp(412, { error: "sha_mismatch" });
      if (u.endsWith("/blobs/check")) return resp(200, { missing: [SHA] }); // still missing → not a concurrent finisher
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }) as typeof fetch;
    await expect(api().putBlobFile(SHA, file, BIG)).rejects.toBeInstanceOf(BlobShaMismatchError);
  });

  test("a non-sha_mismatch 400 stays a generic error (discriminator required)", async () => {
    globalThis.fetch = (async () => resp(400, { error: "bad_request", message: "nope" })) as typeof fetch;
    const err = await api()
      .putBlobFile(SHA, file, 16)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlobShaMismatchError);
  });
});
