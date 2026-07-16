/**
 * `daemon-idle-cpu` (design 49 net) — after convergence with daemons on both devices,
 * a 3-minute idle soak (zero file activity) must keep each daemon quiet: mean CPU%,
 * peak CPU%, and peak RSS below the PROVISIONAL budgets in scenarios/budgets.ts.
 *
 * The P1 stats sampler already runs at 2s and appends `stats-<x>.jsonl` LIVE to the
 * run dir — this scenario reads those files back, keeps only the samples inside the
 * soak window it timed, and asserts against the budgets. No new sampling: the soak is
 * the assertion. Catches the design-49 idle-backoff / safety-scan-storm regressions
 * (the 81s-startup class).
 */
import fs from "node:fs";
import path from "node:path";
import { GUEST } from "../lib/config.js";
import { createRecorder, errMsg } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import { assessIdle, IDLE_BUDGETS, type IdleAssessment } from "./budgets.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Idle soak length (design 56 §9 P2 spec — 3 minutes). */
const SOAK_MS = 180_000;
/** A 3-min window at the 2s sampler yields ~90 samples; require a floor so a broken
 *  capture channel can't pass the budget by having zero samples to violate it. */
const MIN_SOAK_SAMPLES = 20;

function readSamples(runDir: string, label: "a" | "b"): Array<Record<string, unknown> & { ts?: unknown }> {
  const file = path.join(runDir, `stats-${label}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown> & { ts?: unknown }> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export const daemonIdleCpu: Scenario = {
  name: "daemon-idle-cpu",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await provisionPair(ctx, rec, { seedShape: "tiny", seedNum: 1 });
      await startDaemons(ctx, rec);

      // Idle soak: no file activity for SOAK_MS; the P1 sampler keeps writing stats.
      const soakStart = Date.now();
      await rec.step(`idle soak (${SOAK_MS / 1000}s)`, async () => {
        ctx.log(`  soaking ${SOAK_MS / 1000}s (no activity) — sampler running at 2s…`);
        await new Promise((r) => setTimeout(r, SOAK_MS));
      });
      const soakEnd = Date.now();

      // Assess each device over the soak window from the live stats files.
      const assess = (label: "a" | "b"): IdleAssessment => assessIdle(readSamples(ctx.runDir, label), soakStart, soakEnd);
      const a = assess("a");
      const b = assess("b");
      // Daemon-process peak RSS (VmHWM) — read BEFORE daemonStop (the pid must be live).
      // This, not guest-wide memoryUsageBytes, is the memory budget: the guest number
      // carries page cache from any earlier workload in the same VM (ballooning note).
      const [rssA, rssB] = await Promise.all([ctx.a.daemonPeakRssMb(), ctx.b.daemonPeakRssMb()]);
      ctx.log(
        `  BUDGETS (provisional): mean<${IDLE_BUDGETS.meanCpuPctMax}% peak<${IDLE_BUDGETS.peakCpuPctMax}% daemon-rss<${IDLE_BUDGETS.daemonPeakRssMbMax}MB`
      );
      const line = (label: string, x: IdleAssessment, rss: number | undefined) =>
        `${label}: mean ${x.meanCpuPct.toFixed(2)}% · peak gate ${x.peakCpuStatistic} ${x.peakCpuPct.toFixed(2)}% (raw max ${x.rawMaxCpuPct.toFixed(2)}%) · daemon rss ${rss?.toFixed(1) ?? "?"}MB (guest mem ${x.peakMemMB.toFixed(1)}MB, context) · ${x.samples} samples/${x.spanSeconds.toFixed(0)}s`;
      ctx.log(`  ${line("rig-dev-a", a, rssA)}`);
      ctx.log(`  ${line("rig-dev-b", b, rssB)}`);

      for (const [label, x, rss] of [["A", a, rssA], ["B", b, rssB]] as const) {
        rec.assert(`[${label}] sufficient idle samples`, x.samples >= MIN_SOAK_SAMPLES, `${x.samples} samples`);
        rec.assert(`[${label}] mean CPU% < ${IDLE_BUDGETS.meanCpuPctMax}`, x.meanCpuPct < IDLE_BUDGETS.meanCpuPctMax, `${x.meanCpuPct.toFixed(2)}%`);
        rec.assert(
          `[${label}] peak CPU% < ${IDLE_BUDGETS.peakCpuPctMax}`,
          x.peakCpuPct < IDLE_BUDGETS.peakCpuPctMax,
          `gate ${x.peakCpuStatistic} ${x.peakCpuPct.toFixed(2)}% (raw max ${x.rawMaxCpuPct.toFixed(2)}%)`
        );
        rec.assert(
          `[${label}] daemon peak RSS < ${IDLE_BUDGETS.daemonPeakRssMbMax}MB`,
          rss !== undefined && rss < IDLE_BUDGETS.daemonPeakRssMbMax,
          rss !== undefined ? `${rss.toFixed(1)}MB (guest-wide ${x.peakMemMB.toFixed(1)}MB is context)` : "daemon pid/VmHWM unreadable"
        );
      }

      // A quiet daemon must not have halted during the soak.
      const [actA, actB] = await Promise.all([ctx.a.readActivity(GUEST.workDir), ctx.b.readActivity(GUEST.workDir)]);
      rec.assert("daemon A not halted", actA?.halt === undefined, actA?.halt ? `${actA.halt.op}: ${actA.halt.reason}` : "healthy");
      rec.assert("daemon B not halted", actB?.halt === undefined, actB?.halt ? `${actB.halt.op}: ${actB.halt.reason}` : "healthy");
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
      await teardownAccount(ctx, rec).catch((e) => ctx.log(`teardown error: ${errMsg(e)}`));
    }

    return finalizeReport({ scenario: daemonIdleCpu.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
