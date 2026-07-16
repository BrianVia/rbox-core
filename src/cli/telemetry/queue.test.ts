import { afterEach, describe, expect, test } from "bun:test";
import { TelemetryQueue } from "./queue.js";
import type { TelemetryEnvelope } from "./contract.js";

afterEach(() => { delete process.env.RBOX_TELEMETRY; });

describe("TelemetryQueue", () => {
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
});
