/**
 * Idle-CPU budgets + the soak-window assessor for `daemon-idle-cpu` (design 49 net).
 *
 * The numbers below are PROVISIONAL — design 56 §15 Q5 defers the real ceilings to
 * the first weeks of baseline data. They live in ONE const block so tightening them
 * once data accrues is a one-line edit, and the assessor is PURE (unit-tested) so the
 * "is the idle daemon quiet?" verdict never depends on a live container.
 */
import { summarizeStats } from "../lib/capture.js";

/**
 * Provisional idle ceilings (design 56 §15 Q5 — replace with measured baselines).
 * A daemon that has converged and sits on a quiet tree should barely register:
 * mean CPU under 5% of one core, no spike past 25%, daemon peak RSS under 512 MB.
 *
 * The memory budget is the DAEMON PROCESS's VmHWM, not the guest-wide
 * `memoryUsageBytes`: the guest number includes page cache from any earlier
 * workload in the same VM (and Apple container never returns freed guest memory —
 * the design 56 §12 ballooning note), so it reads ~800MB after a conductor run
 * while the daemon itself sits at ~150MB. Guest-wide mem stays in the report as
 * context, never as a budget.
 */
export const IDLE_BUDGETS = {
  meanCpuPctMax: 5,
  peakCpuPctMax: 25,
  daemonPeakRssMbMax: 512,
} as const;

export interface IdleAssessment {
  meanCpuPct: number;
  peakCpuPct: number;
  peakMemMB: number;
  /** Samples that fell inside the soak window. */
  samples: number;
  /** Span of the windowed samples, seconds (first→last ts). */
  spanSeconds: number;
  withinBudget: boolean;
}

type Sample = Record<string, unknown> & { ts?: unknown };

/**
 * Assess a device's idle soak: keep only samples whose `ts` falls in
 * [`windowStartMs`, `windowEndMs`], then derive peak CPU%/mem from
 * {@link summarizeStats} and MEAN CPU% as (core-seconds / window-span) × 100. A
 * window with <2 samples yields zero CPU (no interval to measure) and is within
 * budget — the caller decides whether too-few-samples is itself a failure. PURE.
 */
export function assessIdle(samples: Sample[], windowStartMs: number, windowEndMs: number): IdleAssessment {
  const inWindow = samples.filter((s) => {
    const t = Date.parse(String(s.ts));
    return Number.isFinite(t) && t >= windowStartMs && t <= windowEndMs;
  });
  const stat = summarizeStats(inWindow);
  const times = inWindow.map((s) => Date.parse(String(s.ts))).filter((t) => Number.isFinite(t));
  const spanSeconds = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;
  const meanCpuPct = spanSeconds > 0 ? (stat.cpuCoreSecondsTotal / spanSeconds) * 100 : 0;
  // CPU-only: guest-wide peakMemMB is context (see IDLE_BUDGETS doc), the daemon-RSS
  // budget is asserted separately by the scenario from an in-guest VmHWM read.
  const withinBudget = meanCpuPct < IDLE_BUDGETS.meanCpuPctMax && stat.peakCpuPct < IDLE_BUDGETS.peakCpuPctMax;
  return { meanCpuPct, peakCpuPct: stat.peakCpuPct, peakMemMB: stat.peakMemMB, samples: inWindow.length, spanSeconds, withinBudget };
}
