/**
 * `pull-only-conflict-copies` (design 272 §7) — the receiver-side fixture the design
 * says does not exist today, plus the pull-only plumbing it needs.
 *
 *   provision → A publishes `pkg/clash.txt` → B pulls it → both edit it apart while
 *   the daemons are down → daemons up with **B pull-only** → B's pull reconciles the
 *   divergence, keeps its own version aside as a design-55 conflict copy, and settles.
 *
 * Two things are asserted that no other scenario can reach:
 *
 * 1. The copy B minted inside a synced subtree does NOT wedge the repo — B keeps
 *    pulling A's later writes instead of parking on "working tree differs".
 * 2. §4's non-negotiable: with a pull-only daemon LIVE and never having pushed,
 *    `rbox status --json` still reports `conflictCopies`. `strandedIgnored` rides the
 *    push lane and is absent on this device; the new count must not have inherited
 *    that dependency, and only a pull-only daemon can show the difference.
 *
 * Explicit-only, never in FAST_SUITE: it has not yet run against a live container
 * fleet, and an unmeasured scenario does not belong in the every-PR gate.
 * Run it with `bun run rig run pull-only-conflict-copies`.
 */
import { GUEST } from "../lib/config.js";
import { createRecorder, errMsg } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import { pollUntil, waitForPath } from "../lib/waiters.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Safety-scan floor is 60s (design 49), so every propagation waiter clears it. */
const PROPAGATE_TIMEOUT_MS = 60_000;
const STATUS_POLL_MS = 2_000;

const CLASH = `${GUEST.workDir}/pkg/clash.txt`;
const LATER = `${GUEST.workDir}/pkg/later.txt`;

interface BriefStatusJson {
  conflictCopies?: number;
  /** Emitted only for a live-daemon snapshot — its presence is the proof the
   *  count came from the daemon rather than this invocation's own scan. */
  local?: { source?: string };
}

async function statusJson(ctx: RigCtx): Promise<BriefStatusJson> {
  const out = await ctx.b.rbox(["status", "--json"], { cwd: GUEST.workDir, allowFail: true });
  try {
    return JSON.parse(out.stdout) as BriefStatusJson;
  } catch {
    return {};
  }
}

export const pullOnlyConflictCopies: Scenario = {
  name: "pull-only-conflict-copies",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await provisionPair(ctx, rec, {});

      await rec.step("[A→B] publish the shared file", async () => {
        await ctx.a.exec(["mkdir", "-p", `${GUEST.workDir}/pkg`]);
        await ctx.a.writeFile(CLASH, "base");
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
        const landed = await ctx.b.readFileIfExists(CLASH);
        rec.assert("B has the shared file", landed === "base", JSON.stringify(landed)?.slice(0, 40) ?? "absent");
      });

      // Both sides move the same path apart with no daemon running, so the
      // divergence is real by the time B's pull-only daemon first reconciles.
      await rec.step("[A×B] diverge the shared file with the daemons down", async () => {
        await ctx.b.writeFile(CLASH, "kept-by-B");
        await ctx.a.writeFile(CLASH, "published-by-A");
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
      });

      await startDaemons(ctx, rec, undefined, { b: true });

      await rec.step("[B] pull-only daemon reconciles and keeps B's version aside", async () => {
        const out = await waitForPath(ctx.b, CLASH, (c) => c === "published-by-A", PROPAGATE_TIMEOUT_MS);
        rec.assert("A's version won at the live path", out.ok, out.ok ? `${out.elapsedMs}ms` : `timeout after ${out.elapsedMs}ms`);
        const find = `find '${GUEST.workDir}/pkg' -name '*.conflict*' -print 2>/dev/null | LC_ALL=C sort`;
        const minted = (await ctx.b.exec(["sh", "-c", find], { allowFail: true })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        rec.assert("B kept its own version as a conflict copy", minted.length >= 1, minted.join(", ") || "none found");
      });

      // §4's non-negotiable. This daemon has NEVER pushed, so `strandedIgnored`
      // (a push-lane value) is absent — `conflictCopies` must still be present.
      await rec.step("[B] a never-pushed pull-only daemon still reports conflictCopies", async () => {
        const out = await pollUntil({
          probe: () => statusJson(ctx),
          done: (s) => (s.conflictCopies ?? 0) >= 1,
          timeoutMs: PROPAGATE_TIMEOUT_MS,
          intervalMs: STATUS_POLL_MS,
        });
        rec.assert("status --json reports the minted copies", out.ok, JSON.stringify(out.value).slice(0, 200));
        rec.assert("the count came from the live daemon, not a local scan", out.value.local?.source === "daemon", String(out.value.local?.source));
      });

      // The copy must not park the subtree: A's next write still lands on B.
      await rec.step("[A→B] the minted copy does not wedge the subtree", async () => {
        await ctx.a.writeFile(LATER, "after-the-conflict");
        const out = await waitForPath(ctx.b, LATER, (c) => c === "after-the-conflict", PROPAGATE_TIMEOUT_MS);
        rec.assert("B kept pulling after minting a conflict copy", out.ok, out.ok ? `${out.elapsedMs}ms` : `timeout after ${out.elapsedMs}ms`);
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: pullOnlyConflictCopies.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
