/**
 * Scenario recorder — the tiny step/assert bookkeeping every scenario repeats.
 * P0's onboard-smoke inlined its own `step`/`assert` closures; P2 has six
 * scenarios, so the accumulator + its console shape live here ONCE. A
 * {@link Recorder} owns the `steps`/`assertions` arrays a scenario hands to
 * {@link finalizeReport}; `step` times + records a phase (re-raising on failure so
 * the scenario's try/catch still aborts), `assert` records a boolean check.
 *
 * Pure-ish: the only side effect is `ctx.log` (already tee'd to run.log + stdout).
 * No container access — scenarios do the I/O and feed results here.
 */
import type { AssertionResult, RigCtx, StepResult } from "./types.js";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface Recorder {
  readonly steps: StepResult[];
  readonly assertions: AssertionResult[];
  /** Time + record a phase. Re-raises on failure (the scenario's catch aborts). */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Record a boolean assertion (never throws — the verdict aggregates them). */
  assert(name: string, ok: boolean, detail?: string): void;
}

/** Build a fresh recorder bound to a scenario's logger. */
export function createRecorder(ctx: RigCtx): Recorder {
  const steps: StepResult[] = [];
  const assertions: AssertionResult[] = [];
  return {
    steps,
    assertions,
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      ctx.log(`▶ ${name}`);
      try {
        const out = await fn();
        steps.push({ name, ok: true, ms: Date.now() - t0 });
        return out;
      } catch (e) {
        steps.push({ name, ok: false, ms: Date.now() - t0, detail: errMsg(e) });
        throw e;
      }
    },
    assert(name: string, ok: boolean, detail?: string): void {
      assertions.push({ name, ok, detail });
      ctx.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    },
  };
}
