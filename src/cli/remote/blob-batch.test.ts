import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RboxApi } from "../remote.js";
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
const origDateNow = Date.now;
const ENV_KEYS = ["RBOX_BATCH_BLOBS", "RBOX_BATCH_RECORDS", "RBOX_BATCH_RECORD_BYTES", "RBOX_BATCH_BODY_BYTES", "RBOX_BATCH_SLOTS", "RBOX_LANE_TIMING"] as const;
const savedEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

const shaBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
const api = () => new RboxApi("https://api.test", "durable-token", "ws_1", "proj_1");

let tmpDir = "";
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
let singles = new Map<string, Uint8Array>();
let batchHandler: (shas: string[], headers: Record<string, string>) => Response | Promise<Response>;

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
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (init?.body && typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ url: u, method, headers, body });
    if (u.endsWith("/latest")) return new Response(JSON.stringify({ sequence: 0, commit: null, grant: "fresh-grant" }), { status: 200 });
    if (u.endsWith("/v1/blob-batch/get")) return batchHandler((body ?? []) as string[], headers);
    const m = u.match(/\/v1\/blobs\/([0-9a-f]{64})$/);
    if (m) {
      const b = singles.get(m[1]!);
      return b ? new Response(b, { status: 200 }) : new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
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
