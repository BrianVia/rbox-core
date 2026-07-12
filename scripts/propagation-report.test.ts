import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, parseArgs, parseReceiver, renderReport } from "./propagation-report.js";

const line = (at: string, message: string) => `${at} ${message}`;

describe("propagation report", () => {
  test("prefers bounded sequence joins, falls back with batching, and reports staleness", () => {
    const origin = [
      "garbled",
      line("2026-07-12T10:00:00.000Z", "push: published sequence 1 (1 files)"),
      line("2026-07-12T10:00:01.000Z", "push: published sequence 2 (1 files)"),
      line("2026-07-12T10:00:02.000Z", "push: published sequence 3 (1 files)"),
      line("2026-07-12T11:00:00.000Z", "push: published sequence 4 (1 files)"),
    ].join("\n");
    const receiver = [
      line("2026-07-12T09:59:59.000Z", "remote: seq 1 · live via daemon"),
      line("2026-07-12T10:00:05.000Z", "pull applied: 1 write"),
      // The seq 1 observation was consumed; this apply must not inherit it.
      line("2026-07-12T10:00:06.000Z", "pull applied: 1 write"),
      line("2026-07-12T10:00:07.000Z", "status remote: seq 4"),
      line("2026-07-12T11:11:00.001Z", "pull applied: 1 write"),
      "2026-not-a-dateZ pull applied: garbled",
    ].join("\n");

    const report = buildReport(origin, receiver);
    expect(report).toMatchObject({
      publishes: 4,
      matched: 3,
      unmatched: 1,
      p50Ms: 4_000,
      p95Ms: 5_000,
      maxMs: 5_000,
      batched: true,
    });
    expect(report.hours).toEqual([
      { hour: Date.parse("2026-07-12T10:00:00.000Z"), publishes: 3, matched: 3, unmatched: 0 },
      { hour: Date.parse("2026-07-12T11:00:00.000Z"), publishes: 1, matched: 0, unmatched: 1 },
    ]);
    expect(renderReport(report)).toContain("hour 2026-07-12T11:00:00.000Z publishes=1 matched=0 unmatched=1\n");
  });

  test("uses the newest pending observation and inline sequence, then clears it", () => {
    const applies = parseReceiver([
      line("2026-07-12T10:00:00.000Z", "remote: sequence 8"),
      line("2026-07-12T09:59:00.000Z", "pull status seq=9"),
      line("2026-07-12T10:00:01.000Z", "pull applied: sequence 10, 1 write"),
      line("2026-07-12T10:00:02.000Z", "pull applied: 1 write"),
    ].join("\n"));
    expect(applies.map(({ sequence }) => sequence)).toEqual([10, undefined]);
  });

  test("filters publish events at the sinceHours boundary", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const origin = [
      line("2026-07-12T10:00:00.000Z", "push: published sequence 1 (1 files)"),
      line("2026-07-12T09:59:59.999Z", "push: published sequence 2 (1 files)"),
    ].join("\n");
    expect(buildReport(origin, "", { sinceHours: 2, now }).publishes).toBe(1);
  });

  test("counts stale batching and runs the CLI against synthetic log files", async () => {
    const origin = [
      line("2026-07-12T10:00:00.000Z", "push: published sequence 1 (1 files)"),
      line("2026-07-12T10:00:01.000Z", "push: published sequence 2 (1 files)"),
    ].join("\n");
    const receiver = line("2026-07-12T10:11:00.001Z", "pull applied: 2 writes");
    expect(buildReport(origin, receiver)).toMatchObject({ matched: 0, unmatched: 2, batched: true });

    const dir = await mkdtemp(join(tmpdir(), "rbox-propagation-"));
    try {
      const originPath = join(dir, "origin.log");
      const receiverPath = join(dir, "receiver.log");
      await Promise.all([writeFile(originPath, origin), writeFile(receiverPath, receiver)]);
      const process = Bun.spawn(["bun", import.meta.dir + "/propagation-report.ts", originPath, receiverPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(0);
      const output = await new Response(process.stdout).text();
      expect(output).toContain("publishes 2\n");
      expect(output).toContain("unmatched 2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validates CLI arguments", () => {
    expect(parseArgs(["origin", "receiver", "--sinceHours", "1.5"])).toEqual({
      originPath: "origin",
      receiverPath: "receiver",
      sinceHours: 1.5,
    });
    expect(() => parseArgs(["origin"])).toThrow("usage:");
    expect(() => parseArgs(["origin", "receiver", "--sinceHours", "nope"])).toThrow("usage:");
  });
});
