import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PACK_CONTENT_TYPE,
  PACK_MAX_BODY_BYTES,
  PACK_MAX_MEMBER_BYTES,
  PACK_MAX_MEMBERS,
  PACK_TARGET_PAYLOAD_BYTES,
  parsePack,
} from "../../../engine/blob-pack.js";
import { RemoteContext } from "../context.js";
import { BlobRetryLaterError } from "../errors.js";
import { getPackUploadTiming, resetPackUploadTimingForTests } from "../../upload-lane-timing.js";
import { packUploadConfig } from "./config.js";
import { UploadSlotArbiter, onPackUploadDisabled, packUploadDisabled, resetBatchBlobStateForTests, uploadDisabled } from "./gate.js";
import { BlobPackUploader } from "./pack-uploader.js";
import { buildPack } from "./packer.js";
import { BlobBatchUploader, setUploaderClockForTests } from "./uploader.js";
import { withPushLaneAccumulator } from "../../telemetry/lane-accumulator.js";

const ENV_KEYS = [
  "RBOX_BLOB_PACK", "RBOX_PACK_STREAMS", "RBOX_PACK_CUTOFF_BYTES",
  "RBOX_PACK_TARGET_BYTES", "RBOX_PACK_MIN_BLOBS", "RBOX_PACK_MIN_BYTES",
  "RBOX_BATCH_BLOBS", "RBOX_BATCH_RECORDS", "RBOX_BATCH_BODY_BYTES",
  "RBOX_BATCH_FILL", "RBOX_UPLOAD_SLOTS",
] as const;
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
let tmpDir = "";
let uploaders: BlobBatchUploader[] = [];
let packCalls: CapturedCall[] = [];
let batchCalls = 0;
let singleCalls = 0;
let handler: (url: string, init: RequestInit, body: Uint8Array) => Response | Promise<Response>;

interface CapturedCall {
  headers: Headers;
  body: Uint8Array;
  parsed: Extract<ReturnType<typeof parsePack>, { ok: true }>;
}

async function beforeDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetBatchBlobStateForTests();
  resetPackUploadTimingForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pack-upload-"));
  uploaders = [];
  packCalls = [];
  batchCalls = 0;
  singleCalls = 0;
  handler = defaultHandler;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = await readBody(init.body);
    return handler(String(input), init, body);
  }) as typeof fetch;
});

afterEach(async () => {
  await Promise.all(uploaders.map((uploader) => uploader.close(new Error("test teardown"))));
  setUploaderClockForTests();
  globalThis.fetch = originalFetch;
  resetBatchBlobStateForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("client pack writer", () => {
  test("telemetry counts a successful pack HTTP settlement once", async () => {
    enablePacks();
    process.env.RBOX_PACK_TARGET_BYTES = String(64 * 1024);
    const uploader = makeUploader();
    const members = await makeFiles(16, 4096, "telemetry-pack");
    let samples: unknown[] = [];
    await withPushLaneAccumulator(
      async () => { await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir))); },
      (value) => { samples = value; },
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ kind: "upload_lane", transport: "pack", opCount: 1 });
  });

  test("is default-off and preserves ordinary batch dispatch", async () => {
    process.env.RBOX_BATCH_RECORDS = "1";
    const uploader = makeUploader();
    const member = await makeFile("off", 1024);
    await uploader.putFile(member.sha, member.path, member.size, tmpDir);
    expect(packCalls).toHaveLength(0);
    expect(batchCalls).toBe(1);
  });

  test("quiet-falls back below activation so a 15-member publish cannot hang", async () => {
    enablePacks();
    process.env.RBOX_BATCH_RECORDS = "32";
    const uploader = makeUploader();
    const members = await makeFiles(15, 512, "under");
    await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(packCalls).toHaveLength(0);
    expect(batchCalls).toBe(1);
  });

  test("activates at 16 members and sends bearer-only validated pack wire", async () => {
    enablePacks();
    process.env.RBOX_PACK_TARGET_BYTES = String(64 * 1024);
    const uploader = makeUploader("secret-token");
    const members = await makeFiles(16, 4096, "activate");
    await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(packCalls).toHaveLength(1);
    const call = packCalls[0]!;
    expect(call.headers.get("authorization")).toBe("Bearer secret-token");
    expect(call.headers.get("x-rbox-protocol")).toBe("upload-receipts-v1");
    expect(call.headers.has("x-rbox-upload-grant")).toBe(false);
    expect(call.headers.get("content-type")).toBe(PACK_CONTENT_TYPE);
    expect(call.headers.get("x-rbox-pack-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(call.headers.get("x-rbox-pack-sha256")).toBe(sha(call.body));
    expect(call.parsed.entries.map((entry) => entry.sha256)).toEqual(members.map((member) => member.sha));
  });

  test("activates by bytes, captures every receipt, reports bytes, and removes temp files", async () => {
    enablePacks();
    const uploader = makeUploader();
    const members = await makeFiles(4, PACK_MAX_MEMBER_BYTES, "byte-activation");
    const progress: number[] = [];
    await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir, (n) => progress.push(n))));
    expect(packCalls).toHaveLength(1);
    expect(progress).toEqual(members.map((m) => m.size));
    const ctx = contextOf(uploader);
    expect([...ctx.receipts.keys()].sort()).toEqual(members.map((m) => m.sha).sort());
    await waitFor(async () => (await fs.readdir(tmpDir)).every((name) => !name.startsWith("pack-")));
  });

  test("carves a full pack plus a tail under the hard body cap", async () => {
    enablePacks();
    const uploader = makeUploader();
    const members = await makeFiles(31, PACK_MAX_MEMBER_BYTES, "carve");
    await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(packCalls.length).toBeGreaterThanOrEqual(2);
    expect(packCalls.every((call) => call.body.byteLength <= PACK_MAX_BODY_BYTES)).toBe(true);
    expect(packCalls.flatMap((call) => call.parsed.entries).map((e) => e.sha256).sort()).toEqual(members.map((m) => m.sha).sort());
  });

  test("a member above the compiled 256 KiB limit never enters the pack lane", async () => {
    enableImmediatePacks();
    const uploader = makeUploader();
    const member = await makeFile("too-large-for-pack", PACK_MAX_MEMBER_BYTES + 1);
    await uploader.putFile(member.sha, member.path, member.size, tmpDir);
    expect(packCalls).toHaveLength(0);
    expect(singleCalls).toBe(1);
  });

  test("corpus complexion: all-small packs everything", async () => {
    configureCorpus();
    const allSmall = makeUploader();
    const small = await makeFiles(3, 64 * 1024, "all-small");
    await Promise.all(small.map((m) => allSmall.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(packCalls).toHaveLength(3);
    expect(batchCalls).toBe(0);
  });

  test("corpus complexion: all-large never engages the pack lane", async () => {
    configureCorpus();
    const allLarge = makeUploader();
    const large = await makeFiles(3, 64 * 1024 + 1, "all-large");
    await Promise.all(large.map((m) => allLarge.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(packCalls).toHaveLength(0);
    expect(batchCalls).toBe(3);
  });

  test("corpus complexion: mixed interleaves pack and batch lanes", async () => {
    configureCorpus();
    const mixed = makeUploader();
    const small = await makeFiles(3, 64 * 1024, "mixed-small");
    const large = await makeFiles(3, 64 * 1024 + 1, "mixed-large");
    await Promise.all([
      ...small.map((m) => mixed.putFile(m.sha, m.path, m.size, tmpDir)),
      ...large.map((m) => mixed.putFile(m.sha, m.path, m.size, tmpDir)),
    ]);
    expect(packCalls).toHaveLength(3);
    expect(batchCalls).toBe(3);
  });

  test("one arbiter caps mixed pack+batch requests and streams caps only packs", async () => {
    enablePacks();
    process.env.RBOX_PACK_MIN_BLOBS = "1";
    process.env.RBOX_PACK_MIN_BYTES = "1";
    process.env.RBOX_PACK_TARGET_BYTES = String(64 * 1024);
    process.env.RBOX_PACK_CUTOFF_BYTES = String(64 * 1024);
    process.env.RBOX_PACK_STREAMS = "2";
    process.env.RBOX_BATCH_RECORDS = "1";
    const arbiter = new UploadSlotArbiter(4);
    const uploader = makeUploader("token", arbiter);
    let active = 0;
    let maxCombined = 0;
    let maxPacks = 0;
    let activePacks = 0;
    let stall = true;
    const releases: Array<() => void> = [];
    handler = async (url, init, body) => {
      const isPack = url.endsWith("/v1/blob-pack/put");
      if (!isPack && !url.endsWith("/v1/blob-batch/put")) return defaultHandler(url, init, body);
      active++;
      if (isPack) activePacks++;
      maxCombined = Math.max(maxCombined, active);
      maxPacks = Math.max(maxPacks, activePacks);
      if (stall) await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      if (isPack) activePacks--;
      return defaultHandler(url, init, body);
    };
    const small = await makeFiles(6, 64 * 1024, "slots-small");
    const large = await makeFiles(6, 64 * 1024 + 1, "slots-large");
    const pending = [...small, ...large].map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir));
    await waitFor(() => active === 4);
    expect(maxCombined).toBe(4);
    expect(maxPacks).toBe(2);
    stall = false;
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
    expect(maxCombined).toBeLessThanOrEqual(4);
    expect(maxPacks).toBeLessThanOrEqual(2);
    await waitFor(() => arbiter.inFlight === 0);
  });

  test("a pack release wakes a saturated fill-v1 partial batch", async () => {
    enableImmediatePacks();
    process.env.RBOX_BATCH_FILL = "v1";
    process.env.RBOX_PACK_CUTOFF_BYTES = String(64 * 1024);
    const arbiter = new UploadSlotArbiter(1);
    const uploader = makeUploader("token", arbiter);
    let batchTimer: (() => void) | undefined;
    setUploaderClockForTests({
      now: () => 0,
      setTimeout: (fn) => {
        batchTimer = fn;
        return fn as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => {
        if (handle === batchTimer as unknown as ReturnType<typeof setTimeout>) batchTimer = undefined;
      },
    });
    let releasePack!: () => void;
    const packGate = new Promise<void>((resolve) => { releasePack = resolve; });
    let markPackStarted!: () => void;
    const packStarted = new Promise<void>((resolve) => { markPackStarted = resolve; });
    let markBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => { markBatchStarted = resolve; });
    handler = async (url, init, body) => {
      if (url.endsWith("/v1/blob-pack/put")) {
        markPackStarted();
        await packGate;
      }
      if (url.endsWith("/v1/blob-batch/put")) markBatchStarted();
      return defaultHandler(url, init, body);
    };
    const packed = await makeFile("wake-pack", 64 * 1024);
    const batched = await makeFile("wake-batch", 64 * 1024 + 1);
    const packPromise = uploader.putFile(packed.sha, packed.path, packed.size, tmpDir);
    let batchPromise: Promise<void> | undefined;
    try {
      await beforeDeadline(packStarted, "pack upload dispatch entry");
      batchPromise = uploader.putFile(batched.sha, batched.path, batched.size, tmpDir);
      expect(arbiter.inFlight).toBe(1);
      expect(batchTimer).toBeDefined();
      const fireBatchTimer = batchTimer!;
      batchTimer = undefined;
      fireBatchTimer();
      expect(batchCalls).toBe(0);
      releasePack();
      await beforeDeadline(batchStarted, "batch upload dispatch after pack release");
      await Promise.all([packPromise, batchPromise]);
      expect(batchCalls).toBe(1);
      await waitFor(() => arbiter.inFlight === 0);
    } finally {
      releasePack();
      await uploader.close(new Error("test cleanup")).catch(() => {});
      await Promise.allSettled([packPromise, ...(batchPromise ? [batchPromise] : [])]);
    }
  });

  test.each(["batch", "pack"] as const)("limit-1 arbiter interleaves dual backlogs from a %s-first owner", async (initialLane) => {
    enableImmediatePacks();
    process.env.RBOX_PACK_STREAMS = "8";
    process.env.RBOX_PACK_CUTOFF_BYTES = String(64 * 1024);
    process.env.RBOX_BATCH_RECORDS = "1";
    const arbiter = new UploadSlotArbiter(1);
    const uploader = makeUploader("token", arbiter);
    const packed = await makeFiles(5, 64 * 1024, `fair-${initialLane}-pack`);
    const batched = await makeFiles(5, 64 * 1024 + 1, `fair-${initialLane}-batch`);
    const starts: Array<"batch" | "pack"> = [];
    const completions: Array<"batch" | "pack"> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    handler = async (url, init, body) => {
      const lane = url.endsWith("/v1/blob-pack/put") ? "pack" : "batch";
      starts.push(lane);
      if (first) {
        first = false;
        await firstGate;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      completions.push(lane);
      return defaultHandler(url, init, body);
    };

    const initial = initialLane === "pack" ? packed.shift()! : batched.shift()!;
    const pending = [uploader.putFile(initial.sha, initial.path, initial.size, tmpDir)];
    await waitFor(() => starts.length === 1);
    pending.push(
      ...batched.map((member) => uploader.putFile(member.sha, member.path, member.size, tmpDir)),
      ...packed.map((member) => uploader.putFile(member.sha, member.path, member.size, tmpDir)),
    );
    releaseFirst();
    await Promise.all(pending);

    expect(starts[0]).toBe(initialLane);
    expect(new Set(starts.slice(0, 3))).toEqual(new Set(["batch", "pack"]));
    expect(completions).toEqual(starts);
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < starts.length; i++) {
      run = starts[i] === starts[i - 1] ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThanOrEqual(2);
    await waitFor(() => arbiter.inFlight === 0);
  });

  test("RBOX_PACK_STREAMS=2 caps packs with 24 shared permits", async () => {
    enableImmediatePacks();
    process.env.RBOX_PACK_STREAMS = "2";
    const arbiter = new UploadSlotArbiter(24);
    const uploader = makeUploader("token", arbiter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let activePacks = 0;
    let maxPacks = 0;
    handler = async (url, init, body) => {
      if (!url.endsWith("/v1/blob-pack/put")) return defaultHandler(url, init, body);
      activePacks++;
      maxPacks = Math.max(maxPacks, activePacks);
      await gate;
      activePacks--;
      return defaultHandler(url, init, body);
    };
    const members = await makeFiles(8, 64 * 1024, "streams-24");
    const pending = members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir));
    await waitFor(() => activePacks === 2);
    release();
    await Promise.all(pending);
    expect(maxPacks).toBe(2);
    await waitFor(() => arbiter.inFlight === 0);
  });

  test("404 latches only packing, drains current and pending exactly once", async () => {
    enablePacks();
    process.env.RBOX_PACK_MIN_BLOBS = "1";
    process.env.RBOX_PACK_MIN_BYTES = "1";
    process.env.RBOX_PACK_TARGET_BYTES = String(64 * 1024);
    const uploader = makeUploader();
    let bytes = 0;
    handler = (url, init, body) => url.endsWith("/v1/blob-pack/put")
      ? new Response(JSON.stringify({ error: "pack_disabled" }), { status: 404 })
      : defaultHandler(url, init, body);
    const full = await makeFile("latch-full", 64 * 1024);
    const pending = await makeFile("latch-pending", 1024);
    await Promise.all([
      uploader.putFile(full.sha, full.path, full.size, tmpDir, (n) => { bytes += n; }),
      uploader.putFile(pending.sha, pending.path, pending.size, tmpDir, (n) => { bytes += n; }),
    ]);
    expect(packUploadDisabled()).toBe(true);
    expect(uploadDisabled()).toBe(false);
    expect(bytes).toBe(full.size + pending.size);
    expect(batchCalls).toBeGreaterThan(0);
  });

  test("the first capability response aborts and requeues every in-flight pack", async () => {
    enableImmediatePacks();
    process.env.RBOX_PACK_STREAMS = "2";
    const uploader = makeUploader();
    let requests = 0;
    let secondAborted = false;
    handler = async (url, init, body) => {
      if (!url.endsWith("/v1/blob-pack/put")) return defaultHandler(url, init, body);
      const index = ++requests;
      if (index === 1) {
        await waitFor(() => requests === 2);
        return new Response(JSON.stringify({ error: "pack_disabled" }), { status: 404 });
      }
      await new Promise<void>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          secondAborted = true;
          reject(init.signal!.reason);
        }, { once: true });
      });
      throw new Error("unreachable");
    };
    const members = await makeFiles(3, 64 * 1024, "multi-latch");
    await Promise.all(members.map((m) => uploader.putFile(m.sha, m.path, m.size, tmpDir)));
    expect(requests).toBe(2);
    expect(secondAborted).toBe(true);
    expect(batchCalls).toBeGreaterThan(0);
  });

  test("a process latch transfers pending work across uploader instances", async () => {
    enableImmediatePacks();
    const arbiter = new UploadSlotArbiter(1);
    const firstUploader = makeUploader("first", arbiter);
    const secondUploader = makeUploader("second", arbiter);
    let packRequests = 0;
    let release404!: () => void;
    const responseGate = new Promise<void>((resolve) => { release404 = resolve; });
    let latchNotifications = 0;
    const unsubscribe = onPackUploadDisabled(() => { latchNotifications++; });
    handler = async (url, init, body) => {
      if (!url.endsWith("/v1/blob-pack/put")) return defaultHandler(url, init, body);
      packRequests++;
      if (new Headers(init.headers).get("authorization") !== "Bearer first") {
        throw new Error("second uploader issued a pack PUT after the process latch");
      }
      await responseGate;
      return json(404, { error: "pack_disabled" });
    };
    const first = await makeFile("cross-instance-first", 64 * 1024);
    const second = await makeFile("cross-instance-second", 64 * 1024);
    const firstPending = firstUploader.putFile(first.sha, first.path, first.size, tmpDir);
    await waitFor(() => packRequests === 1);
    const secondPending = secondUploader.putFile(second.sha, second.path, second.size, tmpDir);
    release404();
    await Promise.all([firstPending, secondPending]);
    unsubscribe();

    expect(packRequests).toBe(1);
    expect(latchNotifications).toBe(1);
    expect(packUploadDisabled()).toBe(true);
    expect(batchCalls).toBe(2);
  });

  test("duplicate SHAs coalesce in the pack lane without double-settling", async () => {
    enableImmediatePacks();
    const uploader = makeUploader();
    const member = await makeFile("duplicate", 64 * 1024);
    let progress = 0;
    await Promise.all([
      uploader.putFile(member.sha, member.path, member.size, tmpDir, () => { progress++; }),
      uploader.putFile(member.sha, member.path, member.size, tmpDir, () => { progress++; }),
    ]);
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0]!.parsed.entries).toHaveLength(1);
    expect(progress).toBe(2);
  });

  test("throwing progress callbacks cannot strand pack settlement or cleanup", async () => {
    enableImmediatePacks();
    const arbiter = new UploadSlotArbiter(1);
    const uploader = makeUploader("token", arbiter);
    const member = await makeFile("throwing-progress", 64 * 1024);
    let laterProgress = 0;
    await Promise.all([
      uploader.putFile(member.sha, member.path, member.size, tmpDir, () => { throw new Error("progress failed"); }),
      uploader.putFile(member.sha, member.path, member.size, tmpDir, () => { laterProgress++; }),
    ]);
    await uploader.close(new Error("done"));

    expect(laterProgress).toBe(1);
    expect(arbiter.inFlight).toBe(0);
    expect((await fs.readdir(tmpDir)).filter((name) => name.startsWith("pack-"))).toHaveLength(0);
  });

  test("records numeric pack telemetry after a stubbed publish", async () => {
    enableImmediatePacks();
    const uploader = makeUploader();
    const members = await makeFiles(2, 32 * 1024, "telemetry");
    await Promise.all(members.map((member) => uploader.putFile(member.sha, member.path, member.size, tmpDir)));
    const timing = getPackUploadTiming();

    expect(timing.packsBuilt).toBe(1);
    expect(timing.packsSent).toBe(1);
    expect(timing.members).toBe(2);
    expect(timing.payloadBytes).toBe(64 * 1024);
    expect(timing.overheadBytes).toBe(packCalls[0]!.body.byteLength - 64 * 1024);
    expect(timing.overheadBytes).toBeGreaterThan(0);
    expect(timing.buildMs).toBeGreaterThanOrEqual(0);
    expect(timing.uploadMs).toBeGreaterThanOrEqual(0);
    expect(Object.values(timing.fallbacks).every((count) => count === 0)).toBe(true);
  });

  test("a malformed successful response falls back canonically without latching", async () => {
    enableImmediatePacks();
    const uploader = makeUploader();
    handler = (url, init, body) => url.endsWith("/v1/blob-pack/put")
      ? json(200, { results: [] })
      : defaultHandler(url, init, body);
    const member = await makeFile("missing-result", 64 * 1024);
    await uploader.putFile(member.sha, member.path, member.size, tmpDir);
    expect(packUploadDisabled()).toBe(false);
    expect(batchCalls).toBeGreaterThan(0);
  });

  test.each([405, 415])("%i capability response uses the pack-only latch", async (status) => {
    enableImmediatePacks();
    const uploader = makeUploader();
    handler = (url, init, body) => url.endsWith("/v1/blob-pack/put")
      ? new Response("unsupported", { status })
      : defaultHandler(url, init, body);
    const member = await makeFile(`cap-${status}`, 64 * 1024);
    await uploader.putFile(member.sha, member.path, member.size, tmpDir);
    expect(packUploadDisabled()).toBe(true);
    expect(uploadDisabled()).toBe(false);
  });

  test("503 retry_later rejects without canonical fallback; 500 falls back without latch", async () => {
    enableImmediatePacks();
    const retryUploader = makeUploader();
    handler = (url, init, body) => url.endsWith("/v1/blob-pack/put")
      ? new Response(JSON.stringify({ error: "retry_later" }), { status: 503 })
      : defaultHandler(url, init, body);
    const retry = await makeFile("retry", 64 * 1024);
    await expect(retryUploader.putFile(retry.sha, retry.path, retry.size, tmpDir)).rejects.toBeInstanceOf(BlobRetryLaterError);
    await retryUploader.close(new Error("retry done"));
    expect(batchCalls + singleCalls).toBe(0);

    const fallbackUploader = makeUploader();
    handler = (url, init, body) => url.endsWith("/v1/blob-pack/put")
      ? new Response("server error", { status: 500 })
      : defaultHandler(url, init, body);
    const fallback = await makeFile("fallback", 64 * 1024);
    await fallbackUploader.putFile(fallback.sha, fallback.path, fallback.size, tmpDir);
    expect(packUploadDisabled()).toBe(false);
    expect(batchCalls).toBeGreaterThan(0);
  });

  test("acceptance rolling off mid-publish settles the first pack and requeues the rest", async () => {
    enableImmediatePacks();
    process.env.RBOX_PACK_STREAMS = "1";
    const arbiter = new UploadSlotArbiter(1);
    const uploader = makeUploader("token", arbiter);
    const members = await makeFiles(3, 64 * 1024, "rolloff");
    let packRequests = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let latchNotifications = 0;
    const unsubscribe = onPackUploadDisabled(() => { latchNotifications++; });
    handler = async (url, init, body) => {
      if (!url.endsWith("/v1/blob-pack/put")) return defaultHandler(url, init, body);
      packRequests++;
      if (packRequests === 1) {
        await firstGate;
        return defaultHandler(url, init, body);
      }
      return json(404, { error: "pack_disabled" });
    };
    const progress = [0, 0, 0];
    const pending = members.map((member, i) => uploader.putFile(
      member.sha, member.path, member.size, tmpDir, () => { progress[i]++; },
    ));
    await waitFor(() => packRequests === 1);
    releaseFirst();
    await Promise.all(pending);
    unsubscribe();

    expect(packRequests).toBe(2);
    expect(progress).toEqual([1, 1, 1]);
    expect(contextOf(uploader).receipts.get(members[0]!.sha)).toBe(`pack:${members[0]!.sha}`);
    expect(batchCalls).toBeGreaterThan(0);
    expect(packUploadDisabled()).toBe(true);
    expect(uploadDisabled()).toBe(false);
    expect(latchNotifications).toBe(1);
  });

  test("close aborts and awaits an in-flight pack, rejects once, and cleans temp files", async () => {
    enableImmediatePacks();
    const arbiter = new UploadSlotArbiter(1);
    const uploader = makeUploader("token", arbiter);
    let requestStarted = false;
    handler = async (url, init) => {
      if (!url.endsWith("/v1/blob-pack/put")) return new Response("not found", { status: 404 });
      requestStarted = true;
      await new Promise<void>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      throw new Error("unreachable");
    };
    const member = await makeFile("close", 64 * 1024);
    const pending = uploader.putFile(member.sha, member.path, member.size, tmpDir);
    pending.catch(() => {});
    await waitFor(() => requestStarted);
    const closeError = new Error("killed");
    await uploader.close(closeError);
    await expect(pending).rejects.toBe(closeError);
    expect(arbiter.inFlight).toBe(0);
    expect((await fs.readdir(tmpDir)).filter((name) => name.startsWith("pack-"))).toHaveLength(0);
  });

  test("close during pack construction rejects waiters, removes temp state, and never fetches", async () => {
    enableImmediatePacks();
    const arbiter = new UploadSlotArbiter(1);
    const ctx = new RemoteContext("https://example.test", "token", "ws", "project");
    const pausedPath = path.join(tmpDir, "pack-paused.tmp");
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const builder: typeof buildPack = async () => {
      await fs.writeFile(pausedPath, "partial pack");
      buildStarted();
      await buildGate;
      return { path: pausedPath, packSha256: "0".repeat(64), entries: [], totalBytes: 12 };
    };
    const packUploader = new BlobPackUploader(ctx, arbiter, () => {
      throw new Error("closed work must not fall back");
    }, builder);
    let packFetches = 0;
    handler = (url, init, body) => {
      if (url.endsWith("/v1/blob-pack/put")) packFetches++;
      return defaultHandler(url, init, body);
    };
    const member = await makeFile("close-during-build", 64 * 1024);
    const pending = packUploader.putFile(member.sha, member.path, member.size, tmpDir);
    pending.catch(() => {});
    await started;
    const closeError = new Error("closed while building");
    const closing = packUploader.close(closeError);
    await expect(pending).rejects.toBe(closeError);
    releaseBuild();
    await closing;

    expect(packFetches).toBe(0);
    expect(arbiter.inFlight).toBe(0);
    expect(await fs.stat(pausedPath).then(() => true, () => false)).toBe(false);
  });
});

describe("pack builder and knobs", () => {
  test("builder emits a parseable temp-file pack and verifies source byte counts", async () => {
    const members = await makeFiles(3, 1024, "builder");
    const built = await buildPack(members.map((m) => ({ sha: m.sha, size: m.size, srcPath: m.path, uploadsDir: tmpDir })));
    const bytes = new Uint8Array(await fs.readFile(built.path));
    expect(built.packSha256).toBe(sha(bytes));
    const parsed = parsePack(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entries.map((entry) => entry.sha256)).toEqual(members.map((member) => member.sha));
    await fs.rm(built.path);

    const changed = await makeFile("changed", 10);
    await expect(buildPack([{ sha: changed.sha, size: 11, srcPath: changed.path, uploadsDir: tmpDir }])).rejects.toThrow("member size changed");
  });

  test("founder knobs clamp to compiled hard limits", () => {
    process.env.RBOX_BLOB_PACK = "1";
    process.env.RBOX_PACK_STREAMS = "999";
    process.env.RBOX_PACK_CUTOFF_BYTES = "999999999";
    process.env.RBOX_PACK_TARGET_BYTES = "1";
    process.env.RBOX_PACK_MIN_BLOBS = "999999";
    process.env.RBOX_PACK_MIN_BYTES = "999999999";
    expect(packUploadConfig()).toEqual({
      enabled: true,
      streams: 64,
      cutoffBytes: PACK_MAX_MEMBER_BYTES,
      targetPayloadBytes: 64 * 1024,
      minActivationCount: PACK_MAX_MEMBERS,
      minActivationBytes: PACK_MAX_BODY_BYTES,
    });
    process.env.RBOX_PACK_TARGET_BYTES = "999999999";
    expect(packUploadConfig().targetPayloadBytes).toBe(PACK_TARGET_PAYLOAD_BYTES);
  });
});

function enablePacks(): void {
  process.env.RBOX_BLOB_PACK = "1";
  process.env.RBOX_UPLOAD_SLOTS = "24";
}

function enableImmediatePacks(): void {
  enablePacks();
  process.env.RBOX_PACK_MIN_BLOBS = "1";
  process.env.RBOX_PACK_MIN_BYTES = "1";
  process.env.RBOX_PACK_TARGET_BYTES = String(64 * 1024);
}

function configureCorpus(): void {
  enableImmediatePacks();
  process.env.RBOX_PACK_CUTOFF_BYTES = String(64 * 1024);
  process.env.RBOX_BATCH_RECORDS = "1";
}

function makeUploader(token = "token", arbiter?: UploadSlotArbiter): BlobBatchUploader {
  const uploader = new BlobBatchUploader(new RemoteContext("https://example.test", token, "ws", "project"), arbiter);
  uploaders.push(uploader);
  return uploader;
}

function contextOf(uploader: BlobBatchUploader): RemoteContext {
  return (uploader as unknown as { ctx: RemoteContext }).ctx;
}

async function defaultHandler(url: string, init: RequestInit, body: Uint8Array): Promise<Response> {
  if (url.endsWith("/v1/blob-pack/put")) {
    const parsed = parsePack(body);
    if (!parsed.ok) return new Response("bad pack", { status: 400 });
    packCalls.push({ headers: new Headers(init.headers), body, parsed });
    return json(200, { results: parsed.entries.map((entry) => ({ sha256: entry.sha256, ok: true, sizeBytes: entry.length, receipt: `pack:${entry.sha256}` })) });
  }
  if (url.endsWith("/v1/blob-batch/put")) {
    batchCalls++;
    const records = decodeBatch(body);
    return json(200, { results: records.map((record) => ({ sha256: record.sha, ok: true, sizeBytes: record.size, receipt: `batch:${record.sha}` })) });
  }
  if (/\/v1\/blobs\/[0-9a-f]{64}$/.test(url) && init.method === "PUT") {
    singleCalls++;
    const memberSha = url.slice(-64);
    return json(200, { ok: true, sha256: memberSha, sizeBytes: body.byteLength, receipt: `single:${memberSha}` });
  }
  return new Response("not found", { status: 404 });
}

function decodeBatch(body: Uint8Array): Array<{ sha: string; size: number }> {
  const records: Array<{ sha: string; size: number }> = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const memberSha = Buffer.from(body.subarray(offset, offset + 32)).toString("hex");
    const size = new DataView(body.buffer, body.byteOffset + offset + 32, 4).getUint32(0, false);
    records.push({ sha: memberSha, size });
    offset += 36 + size;
  }
  return records;
}

async function readBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function makeFiles(count: number, size: number, prefix: string): Promise<Array<{ sha: string; path: string; size: number }>> {
  return Promise.all(Array.from({ length: count }, (_, i) => makeFile(`${prefix}-${i}`, size)));
}

async function makeFile(name: string, size: number): Promise<{ sha: string; path: string; size: number }> {
  const seed = createHash("sha256").update(name).digest();
  const bytes = Buffer.alloc(size, seed[0]);
  for (let offset = 0; offset < Math.min(size, seed.byteLength); offset++) bytes[offset] = seed[offset]!;
  const filePath = path.join(tmpDir, `${name}.blob`);
  await fs.writeFile(filePath, bytes);
  return { sha: sha(bytes), path: filePath, size };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
