import { test, expect } from "bun:test";
import { renderReportMd } from "./report.js";
import type { CaptureSummary } from "./capture.js";
import { finalizeReport } from "../scenarios/types.js";

const report = finalizeReport({
  scenario: "onboard-smoke",
  startedAt: "2026-07-02T00:00:00.000Z",
  finishedAt: "2026-07-02T00:00:42.000Z",
  steps: [
    { name: "[A] login --bootstrap", ok: true, ms: 900 },
    { name: "[A] push", ok: true, ms: 3200 },
  ],
  assertions: [{ name: "trees byte-identical (excl .rbox)", ok: true, detail: "101 files" }],
});

const fullCapture: CaptureSummary = {
  runner: "docker",
  statsA: { peakMemMB: 210.5, cpuCoreSecondsTotal: 4.2, peakCpuPct: 180.4, samples: 12 },
  statsB: { peakMemMB: 190.1, cpuCoreSecondsTotal: 3.1, peakCpuPct: 95.0, samples: 12 },
  tail: { total: 40, errors: 0, waf403s: 0 },
  ae: { totalOps: 83, errorOps: 5, topOps: [{ op: "request", outcome: "ok", n: 50, avgMs: 12 }] },
  artifacts: ["report.json", "report.md", "run.log", "stats-a.jsonl", "stats-b.jsonl"],
};

const skippedCapture: CaptureSummary = {
  runner: "apple-container",
  statsA: { skipped: "no stats samples captured" },
  statsB: { skipped: "no stats samples captured" },
  tail: { skipped: "wrangler tail exited early (code 1)" },
  ae: { skipped: "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN absent" },
  artifacts: ["report.json", "run.log"],
};

test("renderReportMd renders a full run with verdict, steps, resources, and AE", () => {
  const md = renderReportMd(report, fullCapture);
  expect(md).toContain("# onboard-smoke — ✅ PASS");
  expect(md).toContain("[A] login --bootstrap");
  expect(md).toContain("[A] push");
  expect(md).toContain("trees byte-identical (excl .rbox)");
  expect(md).toContain("peak mem 210.5 MB");
  expect(md).toContain("wrangler tail");
  expect(md).toContain("Analytics Engine");
  expect(md).toContain("`stats-a.jsonl`");
});

test("renderReportMd renders an all-skipped capture without throwing", () => {
  const failing = finalizeReport({
    scenario: "onboard-smoke",
    startedAt: "2026-07-02T00:00:00.000Z",
    finishedAt: "2026-07-02T00:00:01.000Z",
    steps: [{ name: "[A] login --bootstrap", ok: false, ms: 12, detail: "exit 1" }],
    assertions: [],
  });
  const md = renderReportMd(failing, skippedCapture);
  expect(md).toContain("# onboard-smoke — ❌ FAIL");
  expect(md).toContain("[A] login --bootstrap");
  expect(md).toContain("_skipped:");
  expect(md).toContain("wrangler tail exited early");
});
