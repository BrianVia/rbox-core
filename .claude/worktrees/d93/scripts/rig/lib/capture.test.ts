import { test, expect } from "bun:test";
import { buildAeSql, fmtAeTime, isSkipped, splitJsonObjects, summarizeServerMetrics, summarizeStats, summarizeTail } from "./capture.js";

// ── summarizeStats ─────────────────────────────────────────────────────────────

test("summarizeStats derives peak mem, core-seconds, and peak CPU% from cumulative usec", () => {
  // Two 2s intervals. cpuUsageUsec cumulative: 0 → 1_000_000 (0.5 core over 2s wall)
  // → 5_000_000 (2.0 core over 2s wall).
  const t0 = 1_000_000_000_000; // ms
  const samples = [
    { ts: new Date(t0).toISOString(), memoryUsageBytes: 100 * 1024 * 1024, cpuUsageUsec: 0 },
    { ts: new Date(t0 + 2000).toISOString(), memoryUsageBytes: 150 * 1024 * 1024, cpuUsageUsec: 1_000_000 },
    { ts: new Date(t0 + 4000).toISOString(), memoryUsageBytes: 120 * 1024 * 1024, cpuUsageUsec: 5_000_000 },
  ];
  const s = summarizeStats(samples);
  expect(s.samples).toBe(3);
  expect(s.peakMemMB).toBeCloseTo(150, 5);
  // total cpu delta = 5_000_000 usec = 5 core-seconds
  expect(s.cpuCoreSecondsTotal).toBeCloseTo(5, 5);
  // peak interval: Δcpu 4_000_000 usec / Δwall 2_000_000 usec = 200%
  expect(s.peakCpuPct).toBeCloseTo(200, 5);
});

test("summarizeStats skips a counter-reset interval (negative delta) but re-baselines", () => {
  const t0 = 1_000_000_000_000;
  const samples = [
    { ts: new Date(t0).toISOString(), cpuUsageUsec: 9_000_000, memoryUsageBytes: 1 },
    // reset: counter drops → this interval is NOT counted
    { ts: new Date(t0 + 2000).toISOString(), cpuUsageUsec: 1_000_000, memoryUsageBytes: 1 },
    // resumes from the new baseline: +1_000_000 usec over 2s = 50%
    { ts: new Date(t0 + 4000).toISOString(), cpuUsageUsec: 2_000_000, memoryUsageBytes: 1 },
  ];
  const s = summarizeStats(samples);
  expect(s.cpuCoreSecondsTotal).toBeCloseTo(1, 5); // only the post-reset +1_000_000
  expect(s.peakCpuPct).toBeCloseTo(50, 5);
});

test("summarizeStats on a single sample yields zero CPU (no interval to measure)", () => {
  const s = summarizeStats([{ ts: new Date().toISOString(), cpuUsageUsec: 42, memoryUsageBytes: 8 * 1024 * 1024 }]);
  expect(s.samples).toBe(1);
  expect(s.cpuCoreSecondsTotal).toBe(0);
  expect(s.peakCpuPct).toBe(0);
  expect(s.peakMemMB).toBeCloseTo(8, 5);
});

// ── summarizeTail ─────────────────────────────────────────────────────────────

test("summarizeTail classifies ok / exception / 5xx / 403 from real-shaped tail lines", () => {
  const lines = [
    JSON.stringify({ outcome: "ok", exceptions: [], event: { request: { method: "GET", url: "https://x/health" }, response: { status: 200 } } }),
    JSON.stringify({ outcome: "exception", exceptions: [{ message: "boom" }], event: { request: { method: "POST", url: "https://x/v1/commit" } } }),
    JSON.stringify({ outcome: "ok", exceptions: [], event: { request: { url: "https://x/v1/blob" }, response: { status: 500 } } }),
    JSON.stringify({ outcome: "ok", exceptions: [], event: { request: { url: "https://x/v1/push" }, response: { status: 403 } } }),
    "", // blank ignored
    "not json", // unparseable → counts toward total only
  ];
  const t = summarizeTail(lines);
  expect(t.total).toBe(4); // 4 valid objects; blank + "not json" contribute nothing
  expect(t.errors).toBe(2); // exception + 5xx (the 403 line has outcome "ok" and status < 500)
  expect(t.waf403s).toBe(1);
});

test("summarizeTail handles wrangler v4 pretty-printed, concatenated JSON events", () => {
  // Two events, each pretty-printed across multiple lines and concatenated — the
  // real `wrangler tail --format json` (v4) shape a per-line parser would miss.
  const pretty = [
    "{",
    '  "outcome": "ok",',
    '  "exceptions": [],',
    '  "event": {',
    '    "request": { "method": "GET", "url": "https://x/health" },',
    '    "response": { "status": 200 }',
    "  }",
    "}",
    "{",
    '  "outcome": "exception",',
    '  "exceptions": [ { "message": "boom" } ],',
    '  "event": { "request": { "method": "POST", "url": "https://x/v1/commit" } }',
    "}",
  ].join("\n");
  const t = summarizeTail(pretty);
  expect(t.total).toBe(2);
  expect(t.errors).toBe(1);
  expect(t.waf403s).toBe(0);
});

test("splitJsonObjects ignores braces inside strings", () => {
  const objs = splitJsonObjects('{"msg":"a } { b"}{"n":2}');
  expect(objs.length).toBe(2);
  expect((objs[1] as { n: number }).n).toBe(2);
});

test("summarizeTail on empty input is all zeros", () => {
  expect(summarizeTail([])).toEqual({ total: 0, errors: 0, waf403s: 0 });
});

// ── AE SQL builder ─────────────────────────────────────────────────────────────

test("fmtAeTime formats UTC as YYYY-MM-DD HH:MM:SS", () => {
  expect(fmtAeTime(new Date("2026-07-02T03:04:05.678Z"))).toBe("2026-07-02 03:04:05");
});

test("buildAeSql widens the window by -30s / +60s and targets the dev dataset", () => {
  const start = new Date("2026-07-02T12:00:00.000Z");
  const end = new Date("2026-07-02T12:01:00.000Z");
  const sql = buildAeSql(start, end);
  expect(sql).toContain("FROM rbox_dev_metrics");
  expect(sql).toContain("toDateTime('2026-07-02 11:59:30')"); // start - 30s
  expect(sql).toContain("toDateTime('2026-07-02 12:02:00')"); // end + 60s
  expect(sql).toContain("GROUP BY op, outcome ORDER BY n DESC");
});

// ── summarizeServerMetrics ──────────────────────────────────────────────────────

test("summarizeServerMetrics totals ops, counts real errors, and takes top 3 by n", () => {
  const rows = [
    { op: "request", outcome: "200", n: 50, avg_ms: 12 }, // HTTP 2xx → NOT an error
    { op: "request", outcome: "404", n: 3, avg_ms: 8 }, // HTTP 4xx → error
    { op: "commit", outcome: "ok", n: 20, avg_ms: 40 },
    { op: "commit", outcome: "conflict", n: 5, avg_ms: 30 }, // named non-ok → error
    { op: "blob.put", outcome: "ok", n: 8, avg_ms: 5 },
  ];
  const s = summarizeServerMetrics(rows);
  expect(s.totalOps).toBe(86);
  expect(s.errorOps).toBe(8); // 404 (3) + conflict (5); the 200s are NOT errors
  expect(s.topOps.map((o) => o.op)).toEqual(["request", "commit", "blob.put"]);
  expect(s.topOps[0]!.n).toBe(50);
});

// ── isSkipped guard ─────────────────────────────────────────────────────────────

test("isSkipped narrows skip markers vs data", () => {
  expect(isSkipped({ skipped: "no token" })).toBe(true);
  expect(isSkipped({ total: 0, errors: 0, waf403s: 0 })).toBe(false);
});
