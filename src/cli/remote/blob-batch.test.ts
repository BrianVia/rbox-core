import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlobShaMismatchError, RboxApi } from "../remote.js";
import { BlobDownloadIntegrityError } from "./blobs.js";
import { FakeServer } from "../e2ee-fake-server.js";
import { encryptFileToTemp, generateKek } from "../../engine/crypto.js";
import type { FileEntry } from "../../engine/types.js";
import {
  BATCH_FRAME_HEADER_BYTES,
  BATCH_STATUS_BIT,
  DEFAULT_BATCH_RECORD_BYTES,
  resetBatchBlobStateForTests,
} from "./blob-batch.js";

const origFetch = globalThis.fetch;
// per-sha: serve this many CORRUPT (bit-flipped, same-length) single-GET responses first.
const corruptNextGets = new Map<string, number>();
const origDateNow = Date.now;
const ENV_KEYS = [
  "RBOX_BATCH_BLOBS",
  "RBOX_BATCH_RECORDS",
  "RBOX_BATCH_RECORD_BYTES",
  "RBOX_BATCH_BODY_BYTES",
  "RBOX_BATCH_SLOTS",
  "RBOX_BATCH_PUT_SLOTS",
  "RBOX_UPLOAD_CONCURRENCY",
  "RBOX_LANE_TIMING",
  "RBOX_PULL_JOIN_WATCHDOG_MS",
  "RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS",
  "RBOX_NET_BLOB_MIN_TIMEOUT_MS",
  "RBOX_NET_BLOB_MAX_TIMEOUT_MS",
] as const;
const savedEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

const shaBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
const api = () => new RboxApi("https://api.test", "durable-token", "ws_1", "proj_1");

let tmpDir = "";
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
let singles = new Map<string, Uint8Array>();
let batchHandler: (shas: string[], headers: Record<string, string>) => Response | Promise<Response>;
let batchPutHandler: (body: Uint8Array, headers: Record<string, string>) => Response | Promise<Response>;

beforeEach(async () => {
  resetBatchBlobStateForTests();
  calls = [];
  singles = new Map();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-batch-test-"));
  for (const k of ENV_KEYS) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  batchHandler = (shas) => framesResponse(shas.map((s) => frameData(s, singles.get(s)!)));
  batchPutHandler = (body) => {
    const records = decodeBatchPutFrames(body);
    if (!records) return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
    return jsonResponse(200, { results: records.map(({ sha, payload }) => {
      if (shaBytes(payload) !== sha) return { sha256: sha, ok: false, error: "sha_mismatch" };
      singles.set(sha, new Uint8Array(payload));
      return { sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `receipt:${sha}` };
    }) });
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = await readFetchBody(init?.body);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : rawBody;
    calls.push({ url: u, method, headers, body });
    if (u.endsWith("/latest")) return new Response(JSON.stringify({ sequence: 0, commit: null, grant: "fresh-grant" }), { status: 200 });
    if (u.endsWith("/v1/blob-batch/get")) return batchHandler((body ?? []) as string[], headers);
    if (u.endsWith("/v1/blob-batch/put")) return batchPutHandler(rawBody, headers);
    const m = u.match(/\/v1\/blobs\/([0-9a-f]{64})$/);
    if (m) {
      if (method === "PUT") {
        const s = m[1]!;
        if (shaBytes(rawBody) !== s) return jsonResponse(400, { error: "sha_mismatch" });
        singles.set(s, new Uint8Array(rawBody));
        return jsonResponse(200, { ok: true, sha256: s, sizeBytes: rawBody.byteLength, receipt: `single:${s}` });
      }
      const b = singles.get(m[1]!);
      if (b && (corruptNextGets.get(m[1]!) ?? 0) > 0) {
        corruptNextGets.set(m[1]!, corruptNextGets.get(m[1]!)! - 1);
        const bad = new Uint8Array(b); // same length, flipped first byte → wrong hash, not truncation
        bad[0] = bad[0]! ^ 0xff;
        return new Response(bad, { status: 200 });
      }
      return b ? new Response(b, { status: 200 }) : new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  corruptNextGets.clear();
  globalThis.fetch = origFetch;
  Date.now = origDateNow;
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("BlobBatchDownloader queueing", () => {
  test("flushes immediately at 32 records", async () => {
    const a = api();
    const shas = seedMany(32);
    await Promise.all(shas.map((s, i) => a.getBlobToFile(s, dest(`f${i}`), singles.get(s)!.byteLength)));
    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.body).toEqual(shas);
    expect(singleCalls()).toHaveLength(0);
  });

  test("flushes when queued bytes reach the body cap", async () => {
    process.env.RBOX_BATCH_BODY_BYTES = "20";
    const a = api();
    const shas = seedMany(2, "1234567890");
    await Promise.all(shas.map((s, i) => a.getBlobToFile(s, dest(`cap${i}`), 10)));
    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.body).toEqual(shas);
  });

  test("flushes on the micro timer", async () => {
    const a = api();
    const [s] = seedMany(1);
    await a.getBlobToFile(s!, dest("timer"), singles.get(s!)!.byteLength);
    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.body).toEqual([s]);
  });

  test("large blobs and RBOX_BATCH_BLOBS=0 bypass to single GET", async () => {
    const large = bytes("large single");
    const largeSha = seed(large);
    await api().getBlobToFile(largeSha, dest("large"), DEFAULT_BATCH_RECORD_BYTES + 1);
    expect(batchCalls()).toHaveLength(0);
    expect(singleCalls()).toHaveLength(1);

    resetBatchBlobStateForTests();
    calls = [];
    process.env.RBOX_BATCH_BLOBS = "0";
    const disabled = bytes("disabled single");
    const disabledSha = seed(disabled);
    await api().getBlobToFile(disabledSha, dest("disabled"), disabled.byteLength);
    expect(batchCalls()).toHaveLength(0);
    expect(singleCalls()).toHaveLength(1);
  });
});

describe("BlobBatchDownloader fallback behavior", () => {
  test("a first 404 permanently disables batching for future requests", async () => {
    const first = seed(bytes("old server fallback"));
    let batchCount = 0;
    batchHandler = () => {
      batchCount++;
      return new Response("old server", { status: 404 });
    };
    const a = api();
    await a.getBlobToFile(first, dest("first"), singles.get(first)!.byteLength);
    expect(batchCount).toBe(1);
    expect(singleCalls()).toHaveLength(1);

    const second = seed(bytes("future single"));
    await a.getBlobToFile(second, dest("second"), singles.get(second)!.byteLength);
    expect(batchCount).toBe(1);
    expect(singleCalls()).toHaveLength(2);
  });

  test("401 and truncation fall back to singles but do not disable batching", async () => {
    const s1 = seed(bytes("auth fallback"));
    const s2 = seed(bytes("batch still enabled"));
    let mode: "401" | "ok" = "401";
    batchHandler = (shas) => {
      if (mode === "401") return new Response("no", { status: 401 });
      return framesResponse(shas.map((s) => frameData(s, singles.get(s)!)));
    };
    const a = api();
    await a.getBlobToFile(s1, dest("401"), singles.get(s1)!.byteLength);
    mode = "ok";
    await a.getBlobToFile(s2, dest("after-401"), singles.get(s2)!.byteLength);
    expect(batchCalls()).toHaveLength(2);
    expect(singleCalls()).toHaveLength(1);

    resetBatchBlobStateForTests();
    calls = [];
    const t1 = seed(bytes("truncated fallback"));
    const t2 = seed(bytes("after truncation"));
    let truncated = true;
    batchHandler = (shas) => {
      if (truncated) {
        truncated = false;
        const good = frameData(shas[0]!, singles.get(shas[0]!)!);
        return new Response(good.subarray(0, good.byteLength - 2), { status: 200 });
      }
      return framesResponse(shas.map((s) => frameData(s, singles.get(s)!)));
    };
    await a.getBlobToFile(t1, dest("trunc"), singles.get(t1)!.byteLength);
    await a.getBlobToFile(t2, dest("after-trunc"), singles.get(t2)!.byteLength);
    expect(batchCalls()).toHaveLength(2);
    expect(singleCalls()).toHaveLength(1);
  });

  test("clean EOF with missing requested frames retries those shas singly", async () => {
    const shas = seedMany(32);
    batchHandler = (requested) => framesResponse(requested.slice(0, 20).map((s) => frameData(s, singles.get(s)!)));
    const a = api();
    await Promise.all(shas.map((s, i) => a.getBlobToFile(s, dest(`reconcile-${i}`), singles.get(s)!.byteLength)));
    expect(batchCalls()).toHaveLength(1);
    expect(singleCalls()).toHaveLength(12);
  });

  test("pull liveness watchdog retries a dropped batch completion", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MS = "10";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS = "3";
    process.env.RBOX_NET_BLOB_MIN_TIMEOUT_MS = "1000";
    const payload = bytes("eventually single");
    const s = seed(payload);
    batchHandler = () => stallingBodyResponse(50);

    const out = dest("watchdog-retry");
    await api().getBlobToFile(s, out, payload.byteLength);

    expect(await fs.readFile(out, "utf8")).toBe("eventually single");
    expect(batchCalls()).toHaveLength(1);
    expect(singleCalls()).toHaveLength(1);
  });

  test("watchdog duplicate failure does not settle while the primary batch later completes", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MS = "10";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS = "5";
    process.env.RBOX_NET_BLOB_MIN_TIMEOUT_MS = "1000";
    const payload = bytes("primary eventually wins");
    const s = shaBytes(payload);
    batchHandler = () => delayedFramesResponse([frameData(s, payload)], 25);

    const out = dest("watchdog-duplicate-fail-silent");
    await api().getBlobToFile(s, out, payload.byteLength);

    expect(await fs.readFile(out, "utf8")).toBe("primary eventually wins");
    expect(batchCalls()).toHaveLength(1);
    expect(singleCalls().length).toBeGreaterThanOrEqual(1);
  });

  test("stream progress keeps the pull liveness watchdog from retrying moving batches", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MS = "10";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS = "2";
    process.env.RBOX_NET_BLOB_MIN_TIMEOUT_MS = "1000";
    const payload = bytes("slow moving batch");
    const s = seed(payload);
    batchHandler = () => chunkedFramesResponse([frameData(s, payload)], 6);

    const out = dest("watchdog-stream-progress");
    await api().getBlobToFile(s, out, payload.byteLength);

    expect(await fs.readFile(out, "utf8")).toBe("slow moving batch");
    expect(batchCalls()).toHaveLength(1);
    expect(singleCalls()).toHaveLength(0);
  });

  test("pull liveness watchdog fails loudly after repeated zero-progress checks", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MS = "10";
    process.env.RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS = "1";
    process.env.RBOX_NET_BLOB_MIN_TIMEOUT_MS = "1000";
    const s = seed(bytes("never completed"));
    batchHandler = () => stallingBodyResponse(50);

    await expect(api().getBlobToFile(s, dest("watchdog-fail"), singles.get(s)!.byteLength)).rejects.toThrow(
      new RegExp(`pull download stalled:.*${s}`)
    );
    expect(batchCalls()).toHaveLength(1);
    expect(singleCalls()).toHaveLength(0);
  });

  test("corrupted payload falls back to single GET without leaving bad ciphertext", async () => {
    const good = bytes("correct ciphertext");
    const s = seed(good);
    batchHandler = () => framesResponse([frameData(s, bytes("corrupt"))]);
    const out = dest("hash");
    await api().getBlobToFile(s, out, good.byteLength);
    expect(await fs.readFile(out, "utf8")).toBe("correct ciphertext");
    expect(singleCalls()).toHaveLength(1);
  });

  test("missing status maps to the same user-facing not-found error as single GET", async () => {
    const s = shaBytes("missing");
    batchHandler = () => framesResponse([frameStatus(s, { status: "missing" })]);
    await expect(api().getBlobToFile(s, dest("missing"), 1)).rejects.toThrow("remote blob not found — run rbox sync again");
    expect(singleCalls()).toHaveLength(0);
  });
});

describe("BlobBatchUploader queueing", () => {
  test("coalesces concurrent same-sha uploads into one batch record and settles all waiters", async () => {
    const f = await uploadFile("same-sha", "shared ciphertext");
    const a = api();
    await Promise.all([
      a.putBlobFile(f.sha, f.file, f.size),
      a.putBlobFile(f.sha, f.file, f.size),
    ]);
    expect(batchPutCalls()).toHaveLength(1);
    expect(batchPutCalls()[0]!.headers["x-rbox-protocol"]).toBe("upload-receipts-v1");
    expect(decodeBatchPutFrames(batchPutCalls()[0]!.body as Uint8Array)).toHaveLength(1);
    expect(singlePutCalls()).toHaveLength(0);
    expect(singles.get(f.sha)).toEqual(f.payload);
  });

  test("fake batch PUT requires the receipts protocol header", async () => {
    const server = new FakeServer();
    const payload = bytes("fake strict");
    const body = frameData(shaBytes(payload), payload);

    const missing = await server.blobBatchPut(body);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "receipts_required" });

    const ok = await server.blobBatchPut(body, { "x-rbox-protocol": "upload-receipts-v1" });
    expect(ok.status).toBe(200);
  });

  test("pull-first dispatch keeps queued supply for full batches and the tail guard flushes the remainder", async () => {
    process.env.RBOX_BATCH_RECORDS = "2";
    process.env.RBOX_BATCH_PUT_SLOTS = "1";
    const files = await Promise.all([uploadFile("q0", "zero"), uploadFile("q1", "one"), uploadFile("q2", "two")]);
    const a = api();
    let releaseFirst!: () => void;
    batchPutHandler = async (body) => {
      const records = decodeBatchPutFrames(body)!;
      if (batchPutCalls().length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return jsonResponse(200, { results: records.map(({ sha, payload }) => {
        singles.set(sha, new Uint8Array(payload));
        return { sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `receipt:${sha}` };
      }) });
    };
    const pending = Promise.all(files.map((f) => a.putBlobFile(f.sha, f.file, f.size)));
    await new Promise((r) => setTimeout(r, 30));
    expect(batchPutCalls()).toHaveLength(1);
    expect(decodeBatchPutFrames(batchPutCalls()[0]!.body as Uint8Array)).toHaveLength(2);
    releaseFirst();
    await pending;
    expect(batchPutCalls()).toHaveLength(2);
    expect(decodeBatchPutFrames(batchPutCalls()[1]!.body as Uint8Array)).toHaveLength(1);
  });

  test("RBOX_BATCH_BLOBS=0 bypasses batch PUT", async () => {
    process.env.RBOX_BATCH_BLOBS = "0";
    const f = await uploadFile("disabled-put", "disabled");
    await api().putBlobFile(f.sha, f.file, f.size);
    expect(batchPutCalls()).toHaveLength(0);
    expect(singlePutCalls()).toHaveLength(1);
  });

  test("upload supply default is 512 with batching, 64 when disabled, and explicit env wins", async () => {
    const { uploadConcurrencyForTests } = await import("../sync-recovery.js");
    delete process.env.RBOX_UPLOAD_CONCURRENCY;
    delete process.env.RBOX_BATCH_BLOBS;
    expect(uploadConcurrencyForTests()).toBe(512);
    process.env.RBOX_BATCH_BLOBS = "0";
    expect(uploadConcurrencyForTests()).toBe(64);
    process.env.RBOX_UPLOAD_CONCURRENCY = "7";
    expect(uploadConcurrencyForTests()).toBe(7);
  });
});

describe("BlobBatchUploader fallback behavior", () => {
  test("per-record sha_mismatch rejects that file while r2_error and too_large fall back singly", async () => {
    process.env.RBOX_BATCH_RECORDS = "4";
    const ok = await uploadFile("u-ok", "ok");
    const mismatch = await uploadFile("u-mismatch", "mismatch");
    const r2 = await uploadFile("u-r2", "r2");
    const tooLarge = await uploadFile("u-large-status", "large-status");
    const a = api();
    batchPutHandler = (body) => {
      const records = decodeBatchPutFrames(body)!;
      return jsonResponse(200, { results: records.map(({ sha, payload }) => {
        if (sha === mismatch.sha) return { sha256: sha, ok: false, error: "sha_mismatch" };
        if (sha === r2.sha) return { sha256: sha, ok: false, error: "r2_error" };
        if (sha === tooLarge.sha) return { sha256: sha, ok: false, error: "too_large" };
        singles.set(sha, new Uint8Array(payload));
        return { sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `receipt:${sha}` };
      }) });
    };

    const settled = await Promise.allSettled([ok, mismatch, r2, tooLarge].map((f) => a.putBlobFile(f.sha, f.file, f.size)));
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(BlobShaMismatchError);
    expect(settled[2]?.status).toBe("fulfilled");
    expect(settled[3]?.status).toBe("fulfilled");
    expect(singlePutCalls().map((c) => c.url)).toEqual(expect.arrayContaining([
      expect.stringContaining(r2.sha),
      expect.stringContaining(tooLarge.sha),
    ]));
  });

  test("whole-batch 500 falls back all records without disabling future batches", async () => {
    const first = await Promise.all([uploadFile("batch-500-a", "a"), uploadFile("batch-500-b", "b")]);
    const a = api();
    batchPutHandler = () => new Response("no", { status: 500 });
    await Promise.all(first.map((f) => a.putBlobFile(f.sha, f.file, f.size)));
    expect(singlePutCalls()).toHaveLength(2);

    const second = await uploadFile("batch-after-500", "after");
    batchPutHandler = (body) => {
      const records = decodeBatchPutFrames(body)!;
      return jsonResponse(200, { results: records.map(({ sha, payload }) => {
        singles.set(sha, new Uint8Array(payload));
        return { sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `receipt:${sha}` };
      }) });
    };
    await a.putBlobFile(second.sha, second.file, second.size);
    expect(batchPutCalls()).toHaveLength(2);
  });

  test("a first 405 permanently disables upload batching for future records", async () => {
    const first = await uploadFile("old-put", "old");
    const a = api();
    batchPutHandler = () => new Response("old server", { status: 405 });
    await a.putBlobFile(first.sha, first.file, first.size);
    expect(batchPutCalls()).toHaveLength(1);
    expect(singlePutCalls()).toHaveLength(1);

    const second = await uploadFile("old-put-future", "future");
    await a.putBlobFile(second.sha, second.file, second.size);
    expect(batchPutCalls()).toHaveLength(1);
    expect(singlePutCalls()).toHaveLength(2);
  });
});

describe("BlobBatchDownloader grant freshness", () => {
  test("stale grants refresh once before concurrent batch dispatch", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    process.env.RBOX_BATCH_SLOTS = "2";
    let now = 1_000_000;
    Date.now = () => now;
    let latestCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      let body: unknown;
      if (init?.body && typeof init.body === "string") body = JSON.parse(init.body);
      calls.push({ url: u, method, headers, body });
      if (u.endsWith("/latest")) {
        latestCalls++;
        return new Response(JSON.stringify({ sequence: 0, commit: null, grant: latestCalls === 1 ? "old-grant" : "fresh-grant" }), { status: 200 });
      }
      if (u.endsWith("/v1/blob-batch/get")) return batchHandler((body ?? []) as string[], headers);
      const m = u.match(/\/v1\/blobs\/([0-9a-f]{64})$/);
      return new Response(singles.get(m?.[1] ?? "") ?? new Uint8Array(), { status: m ? 200 : 404 });
    }) as unknown as typeof fetch;

    const a = api();
    await a.latestCommit();
    now += 4 * 60 * 1000 + 1;
    const shas = seedMany(2);
    await Promise.all(shas.map((s, i) => a.getBlobToFile(s, dest(`grant-${i}`), singles.get(s)!.byteLength)));
    expect(latestCalls).toBe(2);
    const batchHeaders = batchCalls().map((c) => c.headers["x-rbox-download-grant"]);
    expect(batchHeaders).toEqual(["fresh-grant", "fresh-grant"]);
  });
});

describe("apply integration", () => {
  test("pulling small encrypted files with batching on matches batching off and preserves lane blob count", async () => {
    process.env.RBOX_LANE_TIMING = "1";
    const applyMod = await import(`../../engine/apply.ts?batch-e2e=${Date.now()}-${Math.random()}`) as typeof import("../../engine/apply.js");
    const kek = generateKek();
    const server = new FakeServer();
    const entries: FileEntry[] = [];
    for (let i = 0; i < 40; i++) {
      const plain = path.join(tmpDir, `src-${i}.txt`);
      const content = `secret-${i}\n`;
      await fs.writeFile(plain, content);
      const enc = await encryptFileToTemp(plain, kek, tmpDir);
      const ct = await fs.readFile(enc.ciphertextPath);
      singles.set(enc.encSha, new Uint8Array(ct));
      server.store.blobs.set(enc.encSha, new Uint8Array(ct));
      entries.push({ path: `dir/file-${i}.txt`, type: "file", sha256: enc.plaintextSha, encSha: enc.encSha, size: Buffer.byteLength(content), mode: 0o644, mtimeMs: 1 });
    }
    batchHandler = (shas) => server.blobBatchGet(shas);
    const actions = entries.map((entry) => ({ kind: "write" as const, entry }));
    const run = async (label: string, batching: boolean) => {
      process.env.RBOX_BATCH_BLOBS = batching ? "1" : "0";
      calls = [];
      applyMod.laneTiming.fetchMs = 0;
      applyMod.laneTiming.decryptWriteMs = 0;
      applyMod.laneTiming.blobs = 0;
      const root = path.join(tmpDir, label);
      await fs.mkdir(root, { recursive: true });
      await applyMod.applyActions(root, actions, api().blobStore(), { kek, concurrency: 16 });
      const tree = await Promise.all(entries.map((e) => fs.readFile(path.join(root, e.path), "utf8")));
      return { tree, blobs: applyMod.laneTiming.blobs, batchCalls: batchCalls().length, singleCalls: singleCalls().length };
    };

    const on = await run("on", true);
    const off = await run("off", false);

    expect(on.tree).toEqual(off.tree);
    expect(on.blobs).toBe(40);
    expect(off.blobs).toBe(40);
    expect(on.batchCalls).toBeGreaterThan(0);
    expect(server.batchGetCalls).toBeGreaterThan(0);
    expect(on.singleCalls).toBe(0);
    expect(off.batchCalls).toBe(0);
    expect(off.singleCalls).toBe(40);
  });
});

function seedMany(n: number, content = "payload"): string[] {
  return Array.from({ length: n }, (_, i) => seed(bytes(`${content}-${i}`)));
}

function seed(payload: Uint8Array): string {
  const s = shaBytes(payload);
  singles.set(s, payload);
  return s;
}

function dest(name: string): string {
  return path.join(tmpDir, `${name}.bin`);
}

function batchCalls() {
  return calls.filter((c) => c.url.endsWith("/v1/blob-batch/get"));
}

function singleCalls() {
  return calls.filter((c) => /\/v1\/blobs\/[0-9a-f]{64}$/.test(c.url));
}

function batchPutCalls() {
  return calls.filter((c) => c.url.endsWith("/v1/blob-batch/put"));
}

function singlePutCalls() {
  return singleCalls().filter((c) => c.method === "PUT");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readFetchBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return bytes(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    return out;
  }
  return new Uint8Array(0);
}

function decodeBatchPutFrames(body: Uint8Array): Array<{ sha: string; payload: Uint8Array }> | null {
  const out: Array<{ sha: string; payload: Uint8Array }> = [];
  for (let off = 0; off < body.byteLength;) {
    if (body.byteLength - off < BATCH_FRAME_HEADER_BYTES) return null;
    const head = body.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const s = [...head.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const word = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
    if ((word & BATCH_STATUS_BIT) !== 0 || body.byteLength - off < word) return null;
    out.push({ sha: s, payload: body.subarray(off, off + word) });
    off += word;
  }
  return out.length ? out : null;
}

async function uploadFile(name: string, content: string): Promise<{ sha: string; file: string; size: number; payload: Uint8Array }> {
  const payload = bytes(content);
  const file = dest(name);
  await fs.writeFile(file, payload);
  return { sha: shaBytes(payload), file, size: payload.byteLength, payload };
}

function framesResponse(frames: Uint8Array[], status = 200): Response {
  const total = frames.reduce((n, f) => n + f.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const frame of frames) {
    body.set(frame, off);
    off += frame.byteLength;
  }
  return new Response(body, { status, headers: { "content-type": "application/x-rbox-blobs" } });
}

function stallingBodyResponse(errorAfterMs: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const t = setTimeout(() => controller.error(new DOMException("test batch stalled", "TimeoutError")), errorAfterMs);
      t.unref?.();
    },
  }), { status: 200, headers: { "content-type": "application/x-rbox-blobs" } });
}

function delayedFramesResponse(frames: Uint8Array[], delayMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const t = setTimeout(() => {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      }, delayMs);
      t.unref?.();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-rbox-blobs" } });
}

function chunkedFramesResponse(frames: Uint8Array[], delayMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = frames.flatMap((frame) => {
        const size = Math.max(1, Math.ceil(frame.byteLength / 4));
        const parts: Uint8Array[] = [];
        for (let off = 0; off < frame.byteLength; off += size) parts.push(frame.subarray(off, Math.min(frame.byteLength, off + size)));
        return parts;
      });
      const write = (i: number) => {
        const chunk = chunks[i];
        if (!chunk) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        const t = setTimeout(() => write(i + 1), delayMs);
        t.unref?.();
      };
      write(0);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-rbox-blobs" } });
}

function frameData(sha: string, payload: Uint8Array): Uint8Array {
  return frame(sha, payload, false);
}

function frameStatus(sha: string, body: unknown): Uint8Array {
  return frame(sha, new TextEncoder().encode(JSON.stringify(body)), true);
}

function frame(sha: string, payload: Uint8Array, status: boolean): Uint8Array {
  const out = new Uint8Array(BATCH_FRAME_HEADER_BYTES + payload.byteLength);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(sha.slice(i * 2, i * 2 + 2), 16);
  new DataView(out.buffer).setUint32(32, status ? (BATCH_STATUS_BIT | payload.byteLength) >>> 0 : payload.byteLength, false);
  out.set(payload, BATCH_FRAME_HEADER_BYTES);
  return out;
}

describe("download integrity self-healing (codex-Sol reviewed)", () => {
  test("a corrupt-then-clean large single-GET heals via bounded integrity retries", async () => {
    const bytes = new Uint8Array(2048).fill(7);
    const sha = shaBytes(bytes);
    singles.set(sha, bytes);
    corruptNextGets.set(sha, 2); // two corrupt deliveries, then correct
    const p = dest("heal");
    await api().getBlobToFile(sha, p, DEFAULT_BATCH_RECORD_BYTES + 1); // force the streaming single path
    expect(shaBytes(new Uint8Array(await fs.readFile(p)))).toBe(sha);
  });

  test("persistent corruption exhausts retries into a typed error carrying the byte count", async () => {
    const bytes = new Uint8Array(1024).fill(9);
    const sha = shaBytes(bytes);
    singles.set(sha, bytes);
    corruptNextGets.set(sha, 99); // never clean
    const p = dest("exhaust");
    const err = await api().getBlobToFile(sha, p, DEFAULT_BATCH_RECORD_BYTES + 1).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(BlobDownloadIntegrityError);
    expect((err as BlobDownloadIntegrityError).bytesReceived).toBe(1024); // same-length corruption, not truncation
    await expect(fs.stat(p)).rejects.toThrow(); // no corrupt file left behind
    // 5 attempts × jittered backoff can exceed bun's 5s default timeout (worst case ~5.6s).
  }, 30_000);
});
