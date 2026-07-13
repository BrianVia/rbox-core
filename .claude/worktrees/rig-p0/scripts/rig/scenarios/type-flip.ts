/**
 * `type-flip` (design 50 net) — EXPECTED-FAIL-TOLERANT, "known-state" assertion.
 *
 *   provision (empty, converged) → A: `flip` is a symlink → push → B: pull (gets it)
 *   → A: replace `flip` with a real DIRECTORY containing a file → push → B: pull.
 *
 * design 50 §3: B's incoming `flip/` directory is obstructed by the local `flip`
 * symlink (an ancestor file/symlink obstruction). The heal moves the obstruction
 * ASIDE — for a file/symlink ancestor to a VISIBLE `.conflict` copy (a squatting
 * directory would instead go to `.rbox/trash/`; see src/engine/apply.ts) — and
 * COMPLETES the pull. The DOCUMENTED healed state therefore leaves B with `flip/`
 * materialized AND exactly one recoverable `.conflict` sibling A doesn't have — so
 * convergence is asserted MODULO that moved-aside copy (requiring byte-identity would
 * flag the heal's own artifact as a failure). The scenario PASSES when B heals; any
 * other outcome (refused / aborted / diverged beyond the copy) FAILS and the report
 * carries the pull's exit + stderr VERBATIM — the case design 56 §9 wants green-when-fixed.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, fingerprintTree } from "../lib/convergence.js";
import { createRecorder, errMsg } from "./harness.js";
import { provisionPair, teardownAccount } from "./preamble.js";
import { divergenceDetail } from "../lib/waiters.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const FLIP = "flip";
const INNER = "inner.txt";
const INNER_BODY = "inner-after-flip";

/** Classify where B moved its obstructing symlink aside to (design 50 evidence). */
async function obstructionEvidence(ctx: RigCtx): Promise<string> {
  const conflictScript = `find '${GUEST.workDir}' -path '${GUEST.workDir}/.rbox' -prune -o -name '${FLIP}.*conflict*' -print 2>/dev/null | LC_ALL=C sort`;
  const trashScript = `find '${GUEST.workDir}/.rbox/trash' -name '*${FLIP}*' -print 2>/dev/null | LC_ALL=C sort`;
  const [conf, trash] = await Promise.all([
    ctx.b.exec(["sh", "-c", conflictScript], { allowFail: true }),
    ctx.b.exec(["sh", "-c", trashScript], { allowFail: true }),
  ]);
  const confPaths = conf.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const trashPaths = trash.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const rel = (p: string) => p.replace(GUEST.workDir + "/", "");
  if (confPaths.length) return `conflict-copy: ${confPaths.map(rel).join(", ")}`;
  if (trashPaths.length) return `.rbox/trash: ${trashPaths.map(rel).join(", ")}`;
  return "none found (symlink may have been deleted, not moved aside)";
}

export const typeFlip: Scenario = {
  name: "type-flip",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await provisionPair(ctx, rec, {});

      // A: `flip` as a symlink → push. B: pull (gets the symlink).
      await rec.step("[A] flip = symlink → push", async () => {
        await ctx.a.exec(["sh", "-c", `cd '${GUEST.workDir}' && ln -s ${FLIP}-target ${FLIP}`]);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
      });
      await rec.step("[B] pull (gets symlink)", async () => {
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
        const isLink = await ctx.b.exec(["sh", "-c", `test -L '${GUEST.workDir}/${FLIP}' && echo yes || echo no`]);
        rec.assert("B has flip as a symlink", isLink.stdout.trim() === "yes", isLink.stdout.trim());
      });

      // A: replace the symlink with a real directory containing a file → push.
      await rec.step("[A] flip → directory/file → push", async () => {
        await ctx.a.exec(["sh", "-c", `cd '${GUEST.workDir}' && rm ${FLIP} && mkdir ${FLIP} && printf '%s' '${INNER_BODY}' > ${FLIP}/${INNER}`]);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
      });

      // B: pull — the type flip. Observe + classify (heal / refuse / abort).
      const pull = await rec.step("[B] pull (the type flip)", async () => ctx.b.rbox(["pull"], { cwd: GUEST.workDir, allowFail: true }));
      const pullTail = (pull.stderr || pull.stdout).trim().split("\n").slice(-4).join(" ⏎ ").slice(0, 300);

      const isDir = (await ctx.b.exec(["sh", "-c", `test -d '${GUEST.workDir}/${FLIP}' && echo yes || echo no`])).stdout.trim() === "yes";
      const innerBody = await ctx.b.readFileIfExists(`${GUEST.workDir}/${FLIP}/${INNER}`);
      const [fpA, fpB] = await Promise.all([fingerprintTree(ctx.a, GUEST.workDir), fingerprintTree(ctx.b, GUEST.workDir)]);
      const div = compareFingerprints(fpA, fpB);

      const completed = pull.exitCode === 0;
      const materialized = isDir && innerBody === INNER_BODY;
      // Convergence MODULO the moved-aside obstruction: A and B agree on everything
      // (flip/ included), and B's ONLY extra entries are `.conflict` copies (the healed
      // obstruction). No missing-on-B, no differing content.
      const residualIsObstruction = div.onlyInA.length === 0 && div.differing.length === 0 && div.onlyInB.length >= 1 && div.onlyInB.every((p) => /\.conflict/.test(p));
      const convergedExceptCopy = div.identical || residualIsObstruction;
      const healed = completed && materialized && convergedExceptCopy;
      const verdict = healed ? "HEALED" : completed ? "COMPLETED-BUT-DIVERGED" : /mass-delete guard/i.test(pullTail) ? "REFUSED" : "ABORTED";

      const evidence = await obstructionEvidence(ctx);
      ctx.log(`  type-flip verdict: ${verdict} — pull exit ${pull.exitCode}; obstruction → ${evidence}`);
      if (!healed) ctx.log(`  pull output (verbatim tail): ${pullTail}`);

      // PASS iff the documented heal held. Each signal is its own assertion so the
      // report pinpoints exactly where a divergence occurred.
      rec.assert("pull completed (exit 0 — healed, not aborted)", completed, `exit ${pull.exitCode}${completed ? "" : ` — ${pullTail}`}`);
      rec.assert("flip materialized as directory with its file", materialized, `isDir=${isDir} inner=${JSON.stringify(innerBody)?.slice(0, 40)}`);
      rec.assert("obstruction moved aside (design 50 heal)", evidence.startsWith("conflict-copy") || evidence.startsWith(".rbox/trash"), evidence);
      rec.assert("B converged to A modulo the moved-aside copy", convergedExceptCopy, convergedExceptCopy ? `${fpB.fileCount} files (+${div.onlyInB.length} recoverable .conflict)` : divergenceDetail(div));
      rec.assert("documented heal held", healed, `verdict=${verdict}`);

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: typeFlip.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
