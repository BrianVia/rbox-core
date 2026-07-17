import { expect, test } from "bun:test";
import {
  RESET_JSON_FLOOD_FAMILIES,
  maximumResetParseAdmissionBytes,
  type ResetJsonFloodFamily,
  type ResetMemoryMeasurement,
} from "./reset-memory-benchmark.js";
import {
  RESET_MATERIALIZED_BYTE_LIMIT,
  RESET_PARSE_EXPANSION_MULTIPLIER,
  RESET_PARSE_MEASURED_MULTIPLIER,
} from "./reset-io.js";

const MiB = 1024 * 1024;

async function measure(family: ResetJsonFloodFamily, bytes: number): Promise<ResetMemoryMeasurement> {
  const child = Bun.spawn([
    process.execPath,
    new URL("./reset-memory-benchmark.ts", import.meta.url).pathname,
    "--child",
    family,
    String(bytes),
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`reset memory benchmark child failed (${exit}): ${stderr}`);
  return JSON.parse(stdout) as ResetMemoryMeasurement;
}

test("design 138 CI remeasurement sweeps every JSON-grammar flood family below pinned measured M", async () => {
  // CI uses a bounded but allocator-representative corpus. The opt-in
  // constrained run below repeats this exact family sweep at the effective
  // maximum admitted size under its enforced process budget.
  const measurements = await Promise.all(RESET_JSON_FLOOD_FAMILIES.map((family) => measure(family, 2 * MiB)));
  expect(measurements.map((entry) => entry.family)).toEqual([...RESET_JSON_FLOOD_FAMILIES]);
  expect(Math.max(...measurements.map((entry) => entry.multiplier))).toBeLessThanOrEqual(RESET_PARSE_MEASURED_MULTIPLIER);
  expect(RESET_PARSE_EXPANSION_MULTIPLIER).toBe(RESET_PARSE_MEASURED_MULTIPLIER * 2);
});

const constrained = process.env.RBOX_RUN_CONSTRAINED_RESET_MEMORY === "1" ? test : test.skip;

constrained("design 138 constrained sweep runs each family at the dynamic maximum-admitted size", async () => {
  const budget = Number(process.env.RBOX_RESET_CONSTRAINED_BUDGET_BYTES ?? 4 * 1024 * MiB);
  const current = process.memoryUsage.rss();
  const admitted = maximumResetParseAdmissionBytes(budget, current);
  expect(admitted).toBeGreaterThanOrEqual(65 * MiB);
  expect(admitted).toBeLessThanOrEqual(RESET_MATERIALIZED_BYTE_LIMIT);
  for (const family of RESET_JSON_FLOOD_FAMILIES) {
    const result = await measure(family, admitted);
    expect(result.multiplier).toBeLessThanOrEqual(RESET_PARSE_MEASURED_MULTIPLIER);
  }
}, 20 * 60_000);
