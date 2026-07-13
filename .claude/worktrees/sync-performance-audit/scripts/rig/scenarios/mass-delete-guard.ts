/**
 * `mass-delete-guard` (design 44 net) — a delete wave that wipes ≥half the baseline
 * must fail CLOSED on the pulling device unless explicitly acknowledged.
 *
 *   provision (seed `tiny` = 100 files, push A, join+pull B → converged)
 *   → A deletes ALL seeded files + `push --allow-mass-delete` (publishes the wave)
 *   → B `pull` WITHOUT the flag  → assert REFUSES: nonzero exit, guard message,
 *     tree INTACT (fingerprint unchanged — the guard runs before any disk touch)
 *   → B `pull --allow-mass-delete` → assert APPLIES: tree converges to A.
 *
 * One-shot commands only (no daemon) — the guard lives in the sync path both share.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, fingerprintTree } from "../lib/convergence.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import { divergenceDetail } from "../lib/waiters.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

export const massDeleteGuard: Scenario = {
  name: "mass-delete-guard",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      // Converged baseline: 100-file `tiny` corpus on both devices.
      await provisionPair(ctx, rec, { seedShape: "tiny", seedNum: 1 });

      const baselineB = await rec.step("[B] fingerprint baseline", async () => fingerprintTree(ctx.b, GUEST.workDir));
      rec.assert("B baseline has the corpus", baselineB.fileCount >= 100, `${baselineB.fileCount} files`);

      // A deletes every seeded entry (keep .rbox) and publishes the wave. The push-side
      // guard would trip too — `--allow-mass-delete` is A's consent to publish it.
      await rec.step("[A] delete all + push --allow-mass-delete", async () => {
        await ctx.a.exec(["sh", "-c", `find '${GUEST.workDir}' -mindepth 1 -maxdepth 1 ! -name .rbox -exec rm -rf {} +`]);
        await ctx.a.rbox(["push", "--allow-mass-delete"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
      });

      // B pulls WITHOUT consent → must refuse, loudly, tree intact.
      await rec.step("[B] pull WITHOUT --allow-mass-delete (expect refuse)", async () => {
        const res = await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, allowFail: true });
        rec.assert("pull refused (nonzero exit)", res.exitCode !== 0, `exit ${res.exitCode}`);
        const said = /mass-delete guard/i.test(res.stderr + res.stdout);
        rec.assert("guard message present", said, said ? "matched 'mass-delete guard'" : (res.stderr || res.stdout).trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "");
        const after = await fingerprintTree(ctx.b, GUEST.workDir);
        const div = compareFingerprints(baselineB, after);
        rec.assert("B tree INTACT after refusal", div.identical, div.identical ? `${after.fileCount} files unchanged` : divergenceDetail(div));
      });

      // B pulls WITH consent → applies; converges to A (both near-empty).
      await rec.step("[B] pull --allow-mass-delete (expect apply)", async () => {
        await ctx.b.rbox(["pull", "--allow-mass-delete"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        const [fpA, fpB] = await Promise.all([fingerprintTree(ctx.a, GUEST.workDir), fingerprintTree(ctx.b, GUEST.workDir)]);
        const div = compareFingerprints(fpA, fpB);
        rec.assert("B converged to A after consented pull", div.identical, div.identical ? `${fpB.fileCount} files` : divergenceDetail(div));
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: massDeleteGuard.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
