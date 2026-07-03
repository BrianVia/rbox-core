/**
 * Scenario contract + pure report shaping. A scenario receives a {@link RigCtx}
 * (two device handles, the run dir, a timestamped logger, the resolved dev URL)
 * and returns a {@link ScenarioReport}. The report builders and the pair-token
 * parser are PURE (unit-tested) so the verdict logic never depends on a container.
 */
import type { Device } from "../lib/device.js";

export interface RigCtx {
  a: Device;
  b: Device;
  apiUrl: string;
  bootstrapSecret: string;
  runDir: string;
  /** Whether the per-run account teardown is skipped (`--keep-account`). */
  keepAccount: boolean;
  /** Timestamped line → run.log AND stdout. */
  log: (line: string) => void;
}

export interface Scenario {
  name: string;
  run(ctx: RigCtx): Promise<ScenarioReport>;
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface AssertionResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioReport {
  scenario: string;
  verdict: "PASS" | "FAIL";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  assertions: AssertionResult[];
}

/**
 * Assemble the final report + compute the verdict: PASS iff every step and every
 * assertion passed. PURE — the scenario collects steps/assertions, this stamps the
 * envelope. `startedAt`/`finishedAt` are ISO strings; `durationMs` is derived.
 */
export function finalizeReport(input: {
  scenario: string;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  assertions: AssertionResult[];
}): ScenarioReport {
  const allOk = input.steps.every((s) => s.ok) && input.assertions.every((a) => a.ok);
  return {
    scenario: input.scenario,
    verdict: allOk ? "PASS" : "FAIL",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
    steps: input.steps,
    assertions: input.assertions,
  };
}

/** Compact PASS/FAIL table for the terminal + run.log. PURE. */
export function renderReportTable(report: ScenarioReport): string {
  const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
  const lines: string[] = [`── ${report.scenario} :: ${report.verdict} (${report.durationMs}ms) ──`];
  lines.push("steps:");
  for (const s of report.steps) lines.push(`  [${mark(s.ok)}] ${s.name} (${s.ms}ms)${s.detail ? ` — ${s.detail}` : ""}`);
  lines.push("assertions:");
  for (const a of report.assertions) lines.push(`  [${mark(a.ok)}] ${a.name}${a.detail ? ` — ${a.detail}` : ""}`);
  return lines.join("\n");
}

/**
 * Parse the pairing token from `rbox pair` stdout. `pairCreate` prints a header
 * line ("Pairing token …"), a blank line, then the token indented on its own line
 * (`<redeemToken>.<tokenSecret>`). We take the first non-empty line after the
 * header. PURE. Throws if no token line is found. */
export function parsePairToken(stdout: string): string {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.includes("Pairing token"));
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i]!.trim();
    // The token carries the split secret as `<redeemToken>.<tokenSecret>` — a dot
    // and no spaces distinguish it from the surrounding prose lines.
    if (t && t.includes(".") && !t.includes(" ")) return t;
  }
  throw new Error("rig: could not parse a pairing token from `rbox pair` output");
}
