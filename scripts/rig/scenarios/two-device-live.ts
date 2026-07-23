/**
 * `two-device-live` (design 56 §9) — the watcher/propagation/conflict net. Daemons up
 * on BOTH devices, then:
 *   1. A writes a new file → assert it lands on B (convergence waiter).
 *   2. B writes a new file → assert it lands on A.
 *   3. A creates a case-only duplicate pair + safe sibling → safe sibling lands,
 *      neither ambiguous member lands; remove one → survivor lands automatically.
 *   4. CONCURRENT same-path edit on A and B (~1s apart) → wait for settle, then assert
 *      design-55 semantics: exactly one winner, at most one `.conflict` sibling, no
 *      conflict blast (conflict-file count ≤ 2), daemons still healthy (no halt).
 *
 * Propagation — not a mechanism — is what's asserted: the daemon pushes on a watched
 * write and pulls on the WS "committed" broadcast, with a 60s safety-scan floor
 * underneath, so a 60s waiter is generous whether the guest watcher is native or
 * degraded to polling (the mode is logged, not asserted).
 */
import { GUEST } from "../lib/config.js";
import { createRecorder, errMsg } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import { divergenceDetail, waitForPath } from "../lib/waiters.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Per-direction propagation budget. Safety scan floor is 60s (design 49). */
const PROPAGATE_TIMEOUT_MS = 60_000;
/** Conflict settle budget after the concurrent edit. */
const SETTLE_TIMEOUT_MS = 60_000;

/** Count files whose name carries a design-55 `.conflict` marker under `dir`
 *  (excluding `.rbox`). Returns the count + the sample paths for the assertion detail. */
async function conflictFiles(ctx: RigCtx, dir: string): Promise<{ count: number; paths: string[] }> {
  const script = `find '${dir}' -path '${dir}/.rbox' -prune -o -name '*.conflict*' -type f -print 2>/dev/null | LC_ALL=C sort`;
  const r = await ctx.a.exec(["sh", "-c", script], { allowFail: true });
  const paths = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { count: paths.length, paths };
}

export const twoDeviceLive: Scenario = {
  name: "two-device-live",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      // Empty workspace + full handshake, then daemons on both sides.
      await provisionPair(ctx, rec, {});
      const modes = await startDaemons(ctx, rec);

      // 1. A writes → lands on B.
      const aPath = `${GUEST.workDir}/live-a.txt`;
      const aBody = "from-A-1";
      await rec.step("[A→B] A writes new file", async () => {
        await ctx.a.writeFile(aPath, aBody);
        const out = await waitForPath(ctx.b, aPath, (c) => c === aBody, PROPAGATE_TIMEOUT_MS);
        rec.assert("A's file landed on B", out.ok, out.ok ? `${out.elapsedMs}ms` : `timeout after ${out.elapsedMs}ms (got ${JSON.stringify(out.value)?.slice(0, 40)})`);
        if (!out.ok) throw new Error("A→B propagation timed out");
      });

      // 2. B writes → lands on A.
      const bPath = `${GUEST.workDir}/live-b.txt`;
      const bBody = "from-B-1";
      await rec.step("[B→A] B writes new file", async () => {
        await ctx.b.writeFile(bPath, bBody);
        const out = await waitForPath(ctx.a, bPath, (c) => c === bBody, PROPAGATE_TIMEOUT_MS);
        rec.assert("B's file landed on A", out.ok, out.ok ? `${out.elapsedMs}ms` : `timeout after ${out.elapsedMs}ms`);
        if (!out.ok) throw new Error("B→A propagation timed out");
      });

      // 3. A case-only duplicate must not block unrelated passive sync. Both
      // ambiguous members stay local until the user resolves the group; deleting
      // one is itself a watcher event and must publish the survivor automatically.
      const caseUpper = `${GUEST.workDir}/Lucky Meat.md`;
      const caseLower = `${GUEST.workDir}/Lucky meat.md`;
      const caseSafe = `${GUEST.workDir}/collision-safe.txt`;
      await rec.step("[A→B] case collision skips only the ambiguous group", async () => {
        await Promise.all([
          ctx.a.writeFile(caseUpper, "upper-case-member"),
          ctx.a.writeFile(caseLower, "lower-case-member"),
          ctx.a.writeFile(caseSafe, "safe-beside-collision"),
        ]);
        const safe = await waitForPath(ctx.b, caseSafe, (c) => c === "safe-beside-collision", PROPAGATE_TIMEOUT_MS);
        rec.assert("safe sibling landed while collision was active", safe.ok, safe.ok ? `${safe.elapsedMs}ms` : "safe sibling timed out");
        rec.assert("neither ambiguous member was published",
          await ctx.b.readFileIfExists(caseUpper) === undefined && await ctx.b.readFileIfExists(caseLower) === undefined,
          "receiver contains neither case variant");
        const status = await ctx.a.rbox(["status", "--json"], { cwd: GUEST.workDir });
        const warning = JSON.parse(status.stdout) as { pathWarnings?: { groupCount?: number; pathCount?: number } | null };
        rec.assert("source status exposes advisory collision", warning.pathWarnings?.groupCount === 1 && warning.pathWarnings.pathCount === 2, status.stdout.trim().slice(0, 300));
      });

      await rec.step("[A→B] resolving collision publishes survivor passively", async () => {
        await ctx.a.exec(["rm", caseLower]);
        const survivor = await waitForPath(ctx.b, caseUpper, (c) => c === "upper-case-member", PROPAGATE_TIMEOUT_MS);
        rec.assert("surviving member landed without manual sync", survivor.ok, survivor.ok ? `${survivor.elapsedMs}ms` : "survivor timed out");
      });

      // 4. Concurrent same-path edit → settle → design-55 conflict assertions.
      const clash = `${GUEST.workDir}/clash.txt`;
      const clashA = "clash-content-from-A";
      const clashB = "clash-content-from-B";
      await rec.step("[A×B] concurrent same-path edit", async () => {
        // Write both within ~1s — issued in parallel so neither daemon has settled
        // the other's version first (the design-55 storm trigger).
        await Promise.all([ctx.a.writeFile(clash, clashA), ctx.b.writeFile(clash, clashB)]);
      });

      await rec.step("wait for conflict settle", async () => {
        const out = await ctx.waitForConvergence(ctx.a, ctx.b, GUEST.workDir, SETTLE_TIMEOUT_MS);
        rec.assert("trees reconverged after conflict", out.ok, divergenceDetail(out.value));
      });

      // exactly one winner: clash.txt holds one of the two contents (converged, so A==B).
      const winner = await ctx.a.readFileIfExists(clash);
      const oneWinner = winner === clashA || winner === clashB;
      rec.assert("exactly one winner at the live path", oneWinner, winner === clashA ? "A won" : winner === clashB ? "B won" : `unexpected: ${JSON.stringify(winner)?.slice(0, 40)}`);

      // no conflict blast: at most one .conflict sibling; total conflict files ≤ 2.
      const conflicts = await conflictFiles(ctx, GUEST.workDir);
      rec.assert("conflict-file count ≤ 2 (no blast)", conflicts.count <= 2, `${conflicts.count} conflict file(s): ${conflicts.paths.map((p) => p.replace(GUEST.workDir + "/", "")).join(", ") || "none"}`);

      // daemons still healthy: no halt recorded on either side.
      const [actA, actB] = await Promise.all([ctx.a.readActivity(GUEST.workDir), ctx.b.readActivity(GUEST.workDir)]);
      const haltA = actA?.halt;
      const haltB = actB?.halt;
      rec.assert("daemon A not halted", haltA === undefined, haltA ? `${haltA.op}: ${haltA.reason}` : "healthy");
      rec.assert("daemon B not halted", haltB === undefined, haltB ? `${haltB.op}: ${haltB.reason}` : "healthy");

      ctx.log(`  (watcher modes — A: ${modes.a}, B: ${modes.b})`);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      // Stop daemons before account teardown (order matters: a live daemon mid-op
      // races the DELETE). Best-effort — never masks the scenario verdict.
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
      await teardownAccount(ctx, rec).catch((e) => ctx.log(`teardown error: ${errMsg(e)}`));
    }

    return finalizeReport({ scenario: twoDeviceLive.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
