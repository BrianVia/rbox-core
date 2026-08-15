import { afterEach, describe, expect, test } from "bun:test";
import { reportGenesisLockUnsupported, TelemetryQueue, type TelemetryTransport } from "./queue.js";
import type { GitCaptureSample, TelemetryEnvelope, WsHealthSample } from "./contract.js";

afterEach(() => { delete process.env.RBOX_TELEMETRY; });

const wsHealth = (overrides: Partial<WsHealthSample> = {}): WsHealthSample => ({
  kind: "ws_health",
  windowMs: 120_000,
  wsConnectedMs: 100_000,
  wsReconnects: 0,
  wsHalfOpenDetected: 0,
  backstopAttempts: 0,
  backstopAppliedPulls: 0,
  cursorAppliedPulls: 0,
  notifyAppliedPulls: 0,
  notifyLatencyCount: 0,
  notifyLatencySumMs: 0,
  notifyLatencyMaxMs: 0,
  ...overrides,
});

const wsSample = (body: TelemetryEnvelope): WsHealthSample =>
  body.samples.find((sample): sample is WsHealthSample => sample.kind === "ws_health")!;

const gitCapture = (overrides: Partial<GitCaptureSample> = {}): GitCaptureSample => ({
  kind: "git_capture",
  signalPushes: 0,
  candidatePushes: 0,
  scanPushes: 0,
  ...overrides,
});

const gitCaptureSample = (body: TelemetryEnvelope): GitCaptureSample =>
  body.samples.find((sample): sample is GitCaptureSample => sample.kind === "git_capture")!;

describe("TelemetryQueue", () => {
  test("fresh-genesis safety telemetry is one proven-unsupported occurrence only", async () => {
    const bodies: TelemetryEnvelope[] = [];
    const options: Array<{ retries?: number }> = [];
    const transport = { postJson: async (_path: string, body: Parameters<TelemetryTransport["postJson"]>[1], opts?: { retries?: number }) => {
      bodies.push(body as TelemetryEnvelope);
      options.push(opts ?? {});
      return new Response("{}", { status: 202 });
    } };

    for (const reason of ["lock-indeterminate", "lock-identity-unavailable", "lock-io"] as const) {
      await reportGenesisLockUnsupported({ reason, layer: "workspace" }, transport);
    }
    expect(bodies).toEqual([]);

    await reportGenesisLockUnsupported({ reason: "lock-unsupported", layer: "state" }, transport);
    expect(bodies).toEqual([{ v: 1, samples: [{
      kind: "safety_event",
      eventType: "genesis_lock_unsupported",
      count: 1,
    }] }]);
    expect(options[0]?.retries).toBe(0);
  });

  test("fresh-genesis telemetry opt-out and transport failure never escape", async () => {
    let calls = 0;
    const failing = { postJson: async () => { calls++; throw new Error("offline"); } };
    await expect(reportGenesisLockUnsupported(
      { reason: "lock-unsupported", layer: "workspace" },
      failing,
    )).resolves.toBeUndefined();
    expect(calls).toBe(1);

    process.env.RBOX_TELEMETRY = "0";
    await reportGenesisLockUnsupported({ reason: "lock-unsupported", layer: "workspace" }, failing);
    expect(calls).toBe(1);
  });

  test("retains and flushes sync_phase samples through the existing envelope", async () => {
    const bodies: TelemetryEnvelope[] = [];
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      return new Response("{}", { status: 202 });
    } });
    queue.record({ kind: "sync_phase", op: "pull", wallMs: 23, phases: { latest: 2 } });
    expect(queue.empty).toBe(false);
    await queue.flush();
    expect(bodies[0]?.samples).toEqual([{ kind: "sync_phase", op: "pull", wallMs: 23, phases: { latest: 2 } }]);
    expect(queue.empty).toBe(true);
  });

  test("retains per family, drains in priority order, and removes only on 202", async () => {
    const bodies: TelemetryEnvelope[] = [];
    let status = 500;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      return new Response("{}", { status });
    }});
    for (let i = 0; i < 70; i++) queue.record({ kind: "propagation", deliveryToApplyMs: i });
    queue.record({ kind: "capability", workerExecutions: 1 });
    queue.record({ kind: "capability", workerExecutions: 2 });
    queue.record({ kind: "safety_event", eventType: "scan_fault", count: 1 });
    queue.record({ kind: "safety_event", eventType: "scan_fault", count: 2 });
    queue.record({ kind: "first_publish", timeToFilesSyncedMs: 1, pushWallMs: 2, fileCount: 3, uniqueBlobs: 4 });
    await queue.flush();
    expect(queue.empty).toBe(false);
    expect(bodies[0]!.samples.map((sample) => sample.kind).slice(0, 3)).toEqual(["safety_event", "capability", "first_publish"]);
    expect(bodies[0]!.samples).toHaveLength(64);
    expect(bodies[0]!.samples[0]).toEqual({ kind: "safety_event", eventType: "scan_fault", count: 3 });
    status = 202;
    await queue.flush();
    expect(queue.empty).toBe(false); // six propagation samples remain beyond the cap
    await queue.flush();
    expect(queue.empty).toBe(true);
  });

  test("kill switch blocks record and flush network, and 429 backs off 240 seconds", async () => {
    let now = 0;
    let calls = 0;
    let status = 429;
    const queue = new TelemetryQueue({ postJson: async () => { calls++; return new Response("{}", { status }); } }, () => {}, () => now);
    queue.record({ kind: "capability", workerExecutions: 1 });
    await queue.flush();
    now = 120_000;
    await queue.flush();
    expect(calls).toBe(1);
    now = 240_000;
    status = 202;
    await queue.flush();
    expect(calls).toBe(2);
    process.env.RBOX_TELEMETRY = "0";
    queue.record({ kind: "capability", workerExecutions: 2 });
    await queue.flush();
    expect(calls).toBe(2);
  });

  test("discards samples rejected with a permanent 4xx response", async () => {
    const logs: string[] = [];
    const queue = new TelemetryQueue(
      { postJson: async () => new Response("{}", { status: 400 }) },
      (line) => logs.push(line),
    );
    queue.record({ kind: "capability", workerExecutions: 1 });

    await queue.flush();

    expect(queue.empty).toBe(true);
    expect(logs).toEqual(["telemetry discarded 1 sample(s) rejected with HTTP 400"]);
  });

  test("retains samples after a server error", async () => {
    const queue = new TelemetryQueue({ postJson: async () => new Response("{}", { status: 500 }) });
    queue.record({ kind: "capability", workerExecutions: 1 });

    await queue.flush();

    expect(queue.empty).toBe(false);
  });

  test("snapshots git capture additively and retains concurrent records across failures", async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: TelemetryEnvelope[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      calls++;
      if (calls === 1) return firstResponse;
      return new Response("{}", { status: 202 });
    } });
    queue.record(gitCapture({ signalPushes: 1 }));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.record(gitCapture({ candidatePushes: 1 }));
    release(new Response("{}", { status: 500 }));
    await flushing;
    await queue.flush();
    expect(gitCaptureSample(bodies[0]!)).toEqual(gitCapture({ signalPushes: 1 }));
    expect(gitCaptureSample(bodies[1]!)).toEqual(gitCapture({ signalPushes: 1, candidatePushes: 1 }));
    expect(queue.empty).toBe(true);
  });

  test("removes only a git capture snapshot accepted while another record arrives", async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: TelemetryEnvelope[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      calls++;
      return calls === 1 ? firstResponse : new Response("{}", { status: 202 });
    } });
    queue.record(gitCapture({ scanPushes: 1 }));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.record(gitCapture({ candidatePushes: 1 }));
    release(new Response("{}", { status: 202 }));
    await flushing;
    expect(queue.empty).toBe(false);
    await queue.flush();
    expect(gitCaptureSample(bodies[1]!)).toEqual(gitCapture({ candidatePushes: 1 }));
    expect(queue.empty).toBe(true);
  });

  test("adds deltas without double-counting across throw, 5xx, and 429 failures", async () => {
    let now = 0;
    let call = 0;
    const bodies: TelemetryEnvelope[] = [];
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      call++;
      if (call === 1) throw new Error("offline");
      if (call === 2) return new Response("{}", { status: 500 });
      if (call === 3) return new Response("{}", { status: 429 });
      return new Response("{}", { status: 202 });
    } }, () => {}, () => now);
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 5 }));
    await queue.flush();
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 3 }));
    await queue.flush();
    await queue.flush();
    now = 240_000;
    await queue.flush();
    expect(bodies.map((body) => wsSample(body).backstopAttempts)).toEqual([5, 8, 8, 8]);
    expect(queue.empty).toBe(true);
  });

  test("retains count, sum, and live max recorded while a 202 flush is in flight", async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: TelemetryEnvelope[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      calls++;
      return calls === 1 ? firstResponse : new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ notifyLatencyCount: 1, notifyLatencySumMs: 100, notifyLatencyMaxMs: 100 }));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.record(wsHealth({ notifyLatencyCount: 1, notifyLatencySumMs: 50, notifyLatencyMaxMs: 50 }));
    release(new Response("{}", { status: 202 }));
    await flushing;
    await queue.flush();
    expect(wsSample(bodies[0]!)).toMatchObject({ notifyLatencyCount: 1, notifyLatencySumMs: 100, notifyLatencyMaxMs: 100 });
    expect(wsSample(bodies[1]!)).toMatchObject({ notifyLatencyCount: 1, notifyLatencySumMs: 50, notifyLatencyMaxMs: 50 });
  });

  test("merges a frozen max back after failure without adding maxima", async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: TelemetryEnvelope[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      calls++;
      return calls === 1 ? firstResponse : new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ notifyLatencyCount: 1, notifyLatencySumMs: 100, notifyLatencyMaxMs: 100 }));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.record(wsHealth({ notifyLatencyCount: 1, notifyLatencySumMs: 50, notifyLatencyMaxMs: 50 }));
    release(new Response("{}", { status: 500 }));
    await flushing;
    await queue.flush();
    expect(wsSample(bodies[1]!)).toMatchObject({ notifyLatencyCount: 2, notifyLatencySumMs: 150, notifyLatencyMaxMs: 100 });
  });

  test("documents accepted-response-lost delivery as over-counting, never under-counting", async () => {
    const accepted: WsHealthSample[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      const sample = wsSample(body as TelemetryEnvelope);
      accepted.push(sample);
      calls++;
      if (calls === 1) throw new Error("response lost after acceptance");
      return new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 5 }));
    await queue.flush();
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 3 }));
    await queue.flush();
    expect(accepted.map((sample) => sample.backstopAttempts)).toEqual([5, 8]);
    expect(accepted.reduce((sum, sample) => sum + sample.backstopAttempts, 0)).toBe(13);
  });

  test("pins ws health above the 64-sample batch cap", async () => {
    let body!: TelemetryEnvelope;
    const queue = new TelemetryQueue({ postJson: async (_path, value) => {
      body = value as TelemetryEnvelope;
      return new Response("{}", { status: 202 });
    } });
    queue.record({ kind: "safety_event", eventType: "scan_fault", count: 1 });
    queue.record({ kind: "capability", workerExecutions: 1 });
    queue.record({ kind: "first_publish", timeToFilesSyncedMs: 1, pushWallMs: 1, fileCount: 1, uniqueBlobs: 1 });
    queue.record({ kind: "upload_lane", transport: "single", bytes: 1, uploadMs: 1, opCount: 1, fillVersion: "v1" });
    for (let i = 0; i < 64; i++) queue.record({ kind: "propagation", deliveryToApplyMs: i });
    queue.record(wsHealth());
    await queue.flush();
    expect(body.samples).toHaveLength(64);
    expect(body.samples[0]?.kind).toBe("ws_health");
    expect(body.samples.filter((sample) => sample.kind === "ws_health")).toHaveLength(1);
  });

  test("drains additive overflow across capped wire snapshots", async () => {
    const bodies: TelemetryEnvelope[] = [];
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      return new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 600_000_000 }));
    queue.record(wsHealth({ windowMs: 1, wsConnectedMs: 0, backstopAttempts: 600_000_000 }));
    await queue.flush();
    expect(queue.empty).toBe(false);
    await queue.flush();
    expect(bodies.map((body) => wsSample(body).backstopAttempts)).toEqual([1_000_000_000, 200_000_000]);
    expect(queue.empty).toBe(true);
  });

  test("retains an all-zero record added while an earlier zero snapshot is in flight", async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: TelemetryEnvelope[] = [];
    let calls = 0;
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      calls++;
      return calls === 1 ? firstResponse : new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ windowMs: 0, wsConnectedMs: 0 }));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.record(wsHealth({ windowMs: 0, wsConnectedMs: 0 }));
    release(new Response("{}", { status: 202 }));
    await flushing;
    expect(queue.empty).toBe(false);
    await queue.flush();
    expect(bodies).toHaveLength(2);
    expect(wsSample(bodies[1]!)).toEqual(wsHealth({ windowMs: 0, wsConnectedMs: 0 }));
  });

  test("flushes an all-zero ws health window and honors the telemetry opt-out", async () => {
    const bodies: TelemetryEnvelope[] = [];
    const queue = new TelemetryQueue({ postJson: async (_path, body) => {
      bodies.push(body as TelemetryEnvelope);
      return new Response("{}", { status: 202 });
    } });
    queue.record(wsHealth({ windowMs: 0, wsConnectedMs: 0 }));
    await queue.flush();
    expect(wsSample(bodies[0]!)).toEqual(wsHealth({ windowMs: 0, wsConnectedMs: 0 }));
    process.env.RBOX_TELEMETRY = "0";
    queue.record(wsHealth({ backstopAttempts: 1 }));
    await queue.flush();
    expect(bodies).toHaveLength(1);
  });
});
