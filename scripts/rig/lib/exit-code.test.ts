import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { reportExit } from "./exit-code.js";
import type { ScenarioReport } from "../scenarios/types.js";

function report(verdict: ScenarioReport["verdict"]): ScenarioReport {
  return { scenario: "synthetic", verdict, startedAt: "2026-07-17T00:00:00.000Z", finishedAt: "2026-07-17T00:00:00.000Z", durationMs: 0, steps: [], assertions: [] };
}

describe("rig exit propagation", () => {
  test("maps a FAIL report to exit 1", () => {
    expect(reportExit(report("FAIL"))).toBe(1);
    expect(reportExit(report("PASS"))).toBe(0);
    expect(reportExit(report("SKIP"))).toBe(0);
  });

  test("awaited main seam makes a subprocess exit 1", () => {
    const modulePath = fileURLToPath(new URL("./exit-code.ts", import.meta.url));
    const script = `import { assignMainExit } from ${JSON.stringify(modulePath)}; await assignMainExit(async () => 1, () => {});`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(1);
  });
});
