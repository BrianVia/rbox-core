import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RboxApi } from "../../remote.js";
import { resetUploadDispatchStatsForTests, getUploadDispatchStats } from "../../upload-lane-timing.js";
import { FILL_ABSOLUTE_MS, FILL_QUIET_MS } from "./config.js";
import { resetBatchBlobStateForTests } from "./gate.js";
import { setUploaderClockForTests } from "./uploader.js";
import { BATCH_FRAME_HEADER_BYTES, BATCH_STATUS_BIT } from "./wire.js";

const ENV_KEYS = [
  "RBOX_BATCH_FILL", "RBOX_BATCH_RECORDS", "RBOX_UPLOAD_SLOTS",
  "RBOX_BATCH_BODY_BYTES", "RBOX_LANE_TIMING",
] as const;
const savedEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();
const originalFetch = globalThis.fetch;
let tmpDir = "";
let batchSizes: number[] = [];
let singlePuts = 0;
let batchPutHandler: (records: BatchRecord[]) => Response | Promise<Response>;

interface BatchRecord { sha: string; payload: Uint8Array }

class FakeClock {
  private value = 0;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  scheduledTimers = 0;

  now = (): number => this.value;
  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    this.scheduledTimers++;
    const id = this.nextId++;
    this.timers.push({ id, at: this.value + ms, fn });
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    const id = timer as unknown as number;
    this.timers = this.timers.filter((entry) => entry.id !== id);
  };
  hasTimerWithin(ms: number): boolean {
    return this.timers.some((entry) => entry.at <= this.value + ms);
  }
  async advance(ms: number): Promise<void> {
    const target = this.value + ms;
    for (;;) {
      const due = this.timers[0];
      if (!due || due.at > target) break;
      this.timers.shift();
      this.value = due.at;
      due.fn();
      await settleMicrotasks();
    }
    this.value = target;
    await settleMicrotasks();
  }
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetBatchBlobStateForTests();
  resetUploadDispatchStatsForTests();
  batchSizes = [];
  singlePuts = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-uploader-fill-"));
  batchPutHandler = (records) => okBatch(records);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = await readBody(init?.body);
    if (u.endsWith("/v1/blob-batch/put")) {
      const records = decodeFrames(body);
      batchSizes.push(records.length);
      return batchPutHandler(records);
    }
    if (/\/v1\/blobs\/[0-9a-f]{64}$/.test(u) && init?.method === "PUT") {
      singlePuts++;
      const sha = u.slice(-64);
      return json(200, { ok: true, sha256: sha, sizeBytes: body.byteLength, receipt: `single:${sha}` });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  setUploaderClockForTests();
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("BlobBatchUploader fill policy", () => {
  test("v1 classifies full, fixed-timer, idle-tail, and byte-full dispatches", async () => {
    process.env.RBOX_UPLOAD_SLOTS = "1";
    const clock = useClock();
    await uploadWave(api(), await files(32, "full"));
    expect(getUploadDispatchStats().full_records).toMatchObject({ count: 1, records: 32 });

    const timerUpload = uploadWave(api(), await files(2, "timer"));
    await clock.advance(10);
    await timerUpload;
    expect(getUploadDispatchStats().fixed_timer).toMatchObject({ count: 1, records: 2 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = true;
    batchPutHandler = async (records) => {
      if (gated) { gated = false; await gate; }
      return okBatch(records);
    };
    const a = api();
    const first = uploadWave(a, await files(32, "tail-head"));
    await waitFor(() => batchSizes.length >= 3);
    const tail = uploadWave(a, await files(3, "tail"));
    release();
    await Promise.all([first, tail]);
    expect(getUploadDispatchStats().idle_tail).toMatchObject({ count: 1, records: 3 });

    process.env.RBOX_BATCH_BODY_BYTES = "80";
    await uploadWave(api(), await files(2, "byte", 40));
    expect(getUploadDispatchStats().full_bytes).toMatchObject({ count: 1, records: 1 });
  });

  test("v2 dispatches a full 64-record batch immediately", async () => {
    v2();
    useClock();
    await uploadWave(api(), await files(64, "full64"));
    expect(batchSizes).toEqual([64]);
    expect(getUploadDispatchStats().full_records).toMatchObject({ count: 1, records: 64 });
  });

  test("v2 steady arrivals slide quiet time past first+10ms", async () => {
    v2();
    const clock = useClock();
    const a = api();
    const pending: Promise<void>[] = [];
    const step = FILL_QUIET_MS / 2;
    const almostQuiet = FILL_QUIET_MS - 1;
    for (let i = 0; i < 4; i++) {
      pending.push(a.putBlobFile(...await fileArgs(`steady-${i}`)));
      if (i < 3) await clock.advance(step);
    }
    expect(batchSizes).toHaveLength(0);
    await clock.advance(almostQuiet);
    expect(batchSizes).toHaveLength(0);
    await clock.advance(FILL_QUIET_MS - almostQuiet);
    await Promise.all(pending);
    expect(batchSizes).toEqual([4]);
    expect(getUploadDispatchStats().quiet).toMatchObject({ count: 1, records: 4 });
  });

  test("v2 absolute deadline dispatches a slow continuous trickle", async () => {
    v2();
    const clock = useClock();
    const a = api();
    const pending: Promise<void>[] = [];
    const step = FILL_QUIET_MS - 2;
    for (let i = 0; i < 7; i++) {
      pending.push(a.putBlobFile(...await fileArgs(`absolute-${i}`)));
      if (i < 6) await clock.advance(step);
    }
    expect(batchSizes).toHaveLength(0);
    await clock.advance(FILL_ABSOLUTE_MS - 6 * step);
    await Promise.all(pending);
    expect(batchSizes).toEqual([7]);
    expect(getUploadDispatchStats().absolute).toMatchObject({ count: 1, records: 7 });
    expect(getUploadDispatchStats().quiet.count).toBe(0);

    // A valid residual partial necessarily fits one carve: dispatchFull and carve
    // share the same record/body caps. Pin the reachable non-drain behavior by
    // proving arrivals after the absolute carve start a fresh coalescing window.
    const younger = [
      a.putBlobFile(...await fileArgs("absolute-younger-0")),
      a.putBlobFile(...await fileArgs("absolute-younger-1")),
    ];
    const almostQuiet = FILL_QUIET_MS - 1;
    await clock.advance(almostQuiet);
    expect(batchSizes).toEqual([7]);
    await clock.advance(FILL_QUIET_MS - almostQuiet);
    await Promise.all(younger);
    expect(batchSizes).toEqual([7, 2]);
    expect(getUploadDispatchStats().quiet).toMatchObject({ count: 1, records: 2 });
  });

  test("v2 documents that >10ms producer gaps flush a deep logical backlog", async () => {
    // Limitation-documenting, not a performance pass gate: the uploader cannot see upstream backlog.
    v2();
    const clock = useClock();
    const a = api();
    for (let i = 0; i < 3; i++) {
      const pending = a.putBlobFile(...await fileArgs(`gap-${i}`));
      await clock.advance(FILL_QUIET_MS + 1);
      await pending;
    }
    expect(batchSizes).toEqual([1, 1, 1]);
    expect(getUploadDispatchStats().quiet.count).toBe(3);
  });

  test("v2 idle-tail guard flushes queued work before its timer is due", async () => {
    v2();
    useClock();
    process.env.RBOX_UPLOAD_SLOTS = "1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    batchPutHandler = async (records) => {
      if (first) { first = false; await gate; }
      return okBatch(records);
    };
    const a = api();
    const head = uploadWave(a, await files(64, "guard-head"));
    await waitFor(() => batchSizes.length === 1);
    const tail = uploadWave(a, await files(3, "guard-tail"));
    release();
    await Promise.all([head, tail]);
    expect(batchSizes).toEqual([64, 3]);
    expect(getUploadDispatchStats().idle_tail).toMatchObject({ count: 1, records: 3 });
  });

  test("v2 saturation waits for settle before re-arming an overdue partial", async () => {
    v2();
    process.env.RBOX_UPLOAD_SLOTS = "2";
    const clock = useClock();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const a = api();
    const wave = await files(131, "saturated");
    const firstSha = wave[0]![0];
    batchPutHandler = async (records) => {
      if (records.some(({ sha }) => sha === firstSha)) await firstGate;
      else await secondGate;
      return okBatch(records);
    };
    const uploads = wave.map((args) => a.putBlobFile(...args));
    const pending = Promise.all(uploads);
    await waitFor(() => batchSizes.length === 2);
    expect(batchSizes).toEqual([64, 64]);

    await clock.advance(FILL_ABSOLUTE_MS * 10);
    expect(clock.scheduledTimers).toBeLessThanOrEqual(3);
    expect(batchSizes).toEqual([64, 64]);

    releaseFirst();
    await uploads[0];
    await waitFor(() => clock.hasTimerWithin(FILL_QUIET_MS));
    await clock.advance(FILL_QUIET_MS);
    await waitFor(() => batchSizes.length === 3);
    expect(batchSizes).toEqual([64, 64, 3]);
    expect(getUploadDispatchStats().quiet).toMatchObject({ count: 1, records: 3 });

    releaseSecond();
    await pending;
    expect(batchSizes).toEqual([64, 64, 3]);
  });

  test("duplicate shas coalesce into one dispatched record and settle both waiters", async () => {
    v2();
    const clock = useClock();
    const a = api();
    const args = await fileArgs("duplicate");
    const progress = [0, 0];
    const pending = progress.map((_, i) => a.putBlobFile(
      args[0], args[1], args[2], undefined, () => { progress[i]++; },
    ));
    await clock.advance(FILL_QUIET_MS);
    await Promise.all(pending);
    expect(batchSizes).toEqual([1]);
    expect(getUploadDispatchStats().quiet.records).toBe(1);
    expect(progress).toEqual([1, 1]);
  });
});

describe("BlobBatchUploader record-cap latch", () => {
  test("old-server 400 latches future batches to 32 and falls back once", async () => {
    v2();
    useClock();
    batchPutHandler = (records) => records.length > 32
      ? json(400, { error: "bad_request", message: "too many records" })
      : okBatch(records);
    const a = api();
    const firstProgress = await uploadWaveCounting(a, await files(64, "old-first"));
    expect(singlePuts).toBe(64);
    const nextProgress = await uploadWaveCounting(a, await files(64, "old-next"));
    expect(batchSizes).toEqual([64, 32, 32]);
    expect(singlePuts).toBe(64);
    expect(firstProgress.every((count) => count === 1)).toBe(true);
    expect(nextProgress.every((count) => count === 1)).toBe(true);
  });

  test("old-server 400 ceiling applies to a newly constructed uploader", async () => {
    v2();
    useClock();
    batchPutHandler = (records) => records.length > 32
      ? json(400, { error: "bad_request", message: "too many records" })
      : okBatch(records);
    await uploadWave(api(), await files(64, "process-first"));
    await uploadWave(api(), await files(64, "process-new"));
    expect(batchSizes).toEqual([64, 32, 32]);
    expect(singlePuts).toBe(64);
  });

  test("machine-readable shrinking max latches subsequent carves to 48", async () => {
    v2();
    useClock();
    let rejected = false;
    batchPutHandler = (records) => {
      if (!rejected) { rejected = true; return json(400, { error: "too_many_records", max: 48 }); }
      return okBatch(records);
    };
    const a = api();
    await uploadWave(a, await files(64, "max-first"));
    await uploadWave(a, await files(48, "max-next"));
    expect(batchSizes).toEqual([64, 48]);
  });

  for (const [name, body] of [
    ["absent", { error: "too_many_records" }],
    ["zero", { error: "too_many_records", max: 0 }],
    ["negative", { error: "too_many_records", max: -1 }],
    ["fractional", { error: "too_many_records", max: 31.5 }],
    ["non-shrinking", { error: "too_many_records", max: 64 }],
  ] as const) {
    test(`invalid ${name} max latches to the floor`, async () => {
      v2();
      useClock();
      let rejected = false;
      batchPutHandler = (records) => {
        if (!rejected) { rejected = true; return json(400, body); }
        return okBatch(records);
      };
      const a = api();
      await uploadWave(a, await files(64, `invalid-${name}-first`));
      await uploadWave(a, await files(64, `invalid-${name}-next`));
      expect(batchSizes).toEqual([64, 32, 32]);
    });
  }

  test("concurrent oversized requests settle once and queued groups re-carve at 32", async () => {
    v2();
    useClock();
    process.env.RBOX_UPLOAD_SLOTS = "2";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    batchPutHandler = async (records) => {
      if (records.length > 32) { await gate; return json(400, { error: "bad_request" }); }
      return okBatch(records);
    };
    const pending = uploadWaveCounting(api(), await files(160, "concurrent"));
    await waitFor(() => batchSizes.length === 2);
    expect(batchSizes).toEqual([64, 64]);
    release();
    const progress = await pending;
    expect(batchSizes).toEqual([64, 64, 32]);
    expect(singlePuts).toBe(128);
    expect(progress.every((count) => count === 1)).toBe(true);
  });

  test("400 at the 32 cap keeps existing single fallback behavior", async () => {
    useClock();
    batchPutHandler = () => json(400, { error: "bad_request" });
    const progress = await uploadWaveCounting(api(), await files(32, "floor400"));
    expect(batchSizes).toEqual([32]);
    expect(singlePuts).toBe(32);
    expect(progress.every((count) => count === 1)).toBe(true);
  });
});

function v2(): void {
  process.env.RBOX_BATCH_FILL = "v2";
  process.env.RBOX_BATCH_RECORDS = "64";
}

function useClock(): FakeClock {
  const clock = new FakeClock();
  setUploaderClockForTests(clock);
  return clock;
}

function api(): RboxApi {
  return new RboxApi("https://api.test", "token", "ws_1", "proj_1");
}

async function files(count: number, prefix: string, size = 4): Promise<Array<[string, string, number]>> {
  return Promise.all(Array.from({ length: count }, (_, i) => fileArgs(`${prefix}-${i}`, size)));
}

async function fileArgs(name: string, size = 4): Promise<[string, string, number]> {
  const payload = new TextEncoder().encode(name.padEnd(size, "x"));
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, payload);
  return [createHash("sha256").update(payload).digest("hex"), file, payload.byteLength];
}

async function uploadWave(a: RboxApi, wave: Array<[string, string, number]>): Promise<void> {
  await Promise.all(wave.map((args) => a.putBlobFile(...args)));
}

async function uploadWaveCounting(a: RboxApi, wave: Array<[string, string, number]>): Promise<number[]> {
  const progress = wave.map(() => 0);
  await Promise.all(wave.map((args, i) => a.putBlobFile(
    args[0], args[1], args[2], undefined, () => { progress[i]++; },
  )));
  return progress;
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await settleMicrotasks();
  if (!predicate()) throw new Error("timed out waiting for uploader state");
}

function okBatch(records: BatchRecord[]): Response {
  return json(200, { results: records.map(({ sha, payload }) => ({
    sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: `batch:${sha}`,
  })) });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function decodeFrames(body: Uint8Array): BatchRecord[] {
  const records: BatchRecord[] = [];
  for (let off = 0; off < body.byteLength;) {
    const header = body.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const word = new DataView(header.buffer, header.byteOffset + 32, 4).getUint32(0, false);
    if ((word & BATCH_STATUS_BIT) !== 0) throw new Error("unexpected status frame");
    const sha = [...header.subarray(0, 32)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    records.push({ sha, payload: body.subarray(off, off + word) });
    off += word;
  }
  return records;
}
