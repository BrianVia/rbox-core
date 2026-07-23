/**
 * Scenario contract + pure report shaping. A scenario receives a {@link RigCtx}
 * (two device handles, the run dir, a timestamped logger, the resolved dev URL)
 * and returns a {@link ScenarioReport}. The report builders and the pair-token
 * parser are PURE (unit-tested) so the verdict logic never depends on a container.
 */
import type { Device } from "../lib/device.js";
import type { Divergence } from "../lib/convergence.js";
import type { PollOutcome } from "../lib/waiters.js";

export interface RigCtx {
  a: Device;
  b: Device;
  apiUrl: string;
  bootstrapSecret: string;
  /** Dev worker platform secret used only for provisioning throwaway account plans. */
  platformSecret: string;
  runDir: string;
  /** Stable scenario slug used in deterministic ephemeral-device labels. */
  scenarioName: string;
  /** Whether the per-run account teardown is skipped (`--keep-account`). */
  keepAccount: boolean;
  /** CLI flags for this run (e.g. `--workload-tar`); scenario-specific reads. */
  flags: Record<string, string>;
  /** Timestamped line → run.log AND stdout. */
  log: (line: string) => void;
  /** Full-transcript block → run.log ONLY (console stays compact). Wired into the
   *  Device handles so every rbox invocation's stdout/stderr is recorded (P1). */
  transcript: (text: string) => void;
  /**
   * Poll `device`'s file at `path` until `predicate(contents|undefined)` holds or
   * `timeoutMs` elapses (design 56 §9 convergence waiter, single-path form). Resolves
   * with the outcome (`ok` = predicate held before timeout). Never throws.
   */
  waitForPath(
    device: Device,
    path: string,
    predicate: (contents: string | undefined) => boolean,
    timeoutMs: number
  ): Promise<PollOutcome<string | undefined>>;
  /**
   * Poll BOTH devices' fingerprints of `dir` until byte-identical (excl. `.rbox`) or
   * `timeoutMs` elapses. Resolves with the outcome carrying the final {@link Divergence}.
   */
  waitForConvergence(a: Device, b: Device, dir: string, timeoutMs: number): Promise<PollOutcome<Divergence>>;
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
  /** SKIP = the scenario declined to run (missing workload/precondition); it does
   *  NOT fail a suite and exits 0. PASS/FAIL come from steps+assertions. */
  verdict: "PASS" | "FAIL" | "SKIP";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  assertions: AssertionResult[];
  /** Present only when `verdict === "SKIP"` — the human reason (e.g. absent tarball). */
  skipReason?: string;
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

/**
 * A SKIP report — the scenario ran but declined (precondition absent). Carries the
 * reason as a single skipped "step" so the run.log/report.md read cleanly, and
 * verdict SKIP so neither the exit code nor a suite treats it as a failure. PURE.
 */
export function skipReport(scenario: string, reason: string): ScenarioReport {
  const now = new Date().toISOString();
  return {
    scenario,
    verdict: "SKIP",
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    steps: [{ name: "skipped", ok: true, ms: 0, detail: reason }],
    assertions: [],
    skipReason: reason,
  };
}

/** Compact PASS/FAIL/SKIP table for the terminal + run.log. PURE. */
export function renderReportTable(report: ScenarioReport): string {
  const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
  const lines: string[] = [`── ${report.scenario} :: ${report.verdict} (${report.durationMs}ms) ──`];
  if (report.verdict === "SKIP") {
    lines.push(`  skipped: ${report.skipReason ?? "(no reason)"}`);
    return lines.join("\n");
  }
  lines.push("steps:");
  for (const s of report.steps) lines.push(`  [${mark(s.ok)}] ${s.name} (${s.ms}ms)${s.detail ? ` — ${s.detail}` : ""}`);
  lines.push("assertions:");
  for (const a of report.assertions) lines.push(`  [${mark(a.ok)}] ${a.name}${a.detail ? ` — ${a.detail}` : ""}`);
  return lines.join("\n");
}

/**
 * Parse the pairing token only from the executable command printed by
 * `rbox pair`. Requiring the `rbox connect` prefix makes the rig prove the exact
 * design-184 handoff rather than merely finding token-shaped output. PURE. */
export function parsePairToken(stdout: string): string {
  const match = stdout.match(/^\s*rbox connect (rbox-pair_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43})\s*$/m);
  if (match?.[1]) return match[1];
  throw new Error("rig: could not parse a pairing token from `rbox pair` output");
}
