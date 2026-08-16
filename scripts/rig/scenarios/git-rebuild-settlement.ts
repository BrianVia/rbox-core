/**
 * `git-rebuild-settlement` — the two-device-rebuild reproduction behind GH #752
 * defect B: the deterministic `P settlement BASE disappeared` loop a fresh-join
 * re-baseline leaves behind. Parked 2026-08-15 as "needs a rig scenario BEFORE any
 * p-settlement change"; #647 (resolve boundary self-invalidation) and design 236
 * §3.2c (presence-vs-value hole) hang off the same fixture.
 *
 * **BUG-PINNED — this scenario PASSES while the product is BROKEN.** Its
 * assertions describe the CURRENT defective behavior so that the fix makes them
 * go RED and forces the flip. Every pinned assertion is prefixed `[BUG #752-B]`
 * and {@link FIX_FLIPS} names what each must become. That posture is the inverse
 * of `worktree-squash-lifecycle` (red-by-construction against the desired
 * behavior); it is used here because the deliverable the park asked for is a
 * REPRODUCTION, and a reproduction that already fails proves nothing.
 *
 * The defect (`src/cli/sync-git/p-settlement.ts`): the entry pre-check tolerates a
 * missing serialized BASE — `currentBase = record?.base?.refs[ref] ?? null` equals a
 * `priorOid: null` payload, so settlement proceeds (:73-75) — while the transaction
 * throws on the same state (`if (!record?.base) throw new Error("P settlement BASE
 * disappeared")`, :100-102). The throw becomes a `hold`, the hold becomes an
 * `artifact` apply-deferral (`apply.ts:886-889`), and the repository needs a
 * serialized BASE to settle its standing P but cannot earn one until that P settles.
 *
 * Fixture — the 2026-08-15 desktop/Mac rebuild shape, end to end:
 *   1. A seeds a real git repo, both devices converge normally (BASE serialized on B).
 *   2. A publishes a NEW branch; B pulls. This is the ordinary P lifecycle — a
 *      present artifact is written and retired inside the same follow, so B is
 *      left with zero standing P. It is the negative control for step 4.
 *   3. **The rebuild.** B renames `.rbox` aside and re-tracks the SAME non-empty
 *      directory with `rbox track --workspace <id>` — no state, no BASE, all the
 *      git repositories still on disk. (`track` deliberately runs no first sync.)
 *   4. A publishes a second NEW branch, so B's next pull must follow a ref that has
 *      no prior BASE value into a record that has no BASE at all. P is written,
 *      settlement holds, and every later cycle repeats it verbatim.
 *
 * Two observable shapes follow, and the scenario pins both because they are
 * different code paths:
 *   · cycle 1 — the POST-CAS settlement throw aborts the pull outright
 *     (`received-git-transition-commit.ts:388`, `rbox pull` exits 1) and writes no
 *     `artifact` deferral; the record is left carrying `local-commits`.
 *   · cycles 2..n — the PRE-commit standing proof holds, the repo is deferred
 *     `artifact` (`apply.ts:888`) and `git-sync deferred <rel>: P settlement BASE
 *     disappeared` repeats verbatim while `deferredSince` never moves. Note the
 *     prose lives ONLY in the log line: state persists the enum, not the reason,
 *     and a plain `rbox pull` (no `--verbose`) prints nothing at all.
 *
 * Two findings the run recorded that differ from the 2026-08-15 field notes:
 *   · take-theirs surfaces the REAL reason here (`repo: P settlement BASE
 *     disappeared`, the `artifact` refusal at `resolve-command.ts:640`), not the
 *     `resolve-command.ts:1085-1095` catch-all the Mac saw ×4. The catch-all is a
 *     different path — it only swallows throws from the mutex body, which this
 *     wedge never reaches because the artifact preflight refuses first.
 *   · #647's boundary self-invalidation is NOT reachable from this fixture, for
 *     the same reason: `preflightManualPresentArtifacts` must return `ready`
 *     before resolve ever reaches its locked boundary, and a standing P is
 *     precisely what makes it not ready. #647 needs its own fixture (dirty
 *     worktree, oracle `mismatch`, NO standing P) and its own signature
 *     (`current.snapshot` equal to the `--confirm` token just passed). The
 *     repeated-resolve probe below records that this wedge instead refuses
 *     identically forever.
 *
 * Explicit-only: NOT in FAST_SUITE, not reachable from `e2e.yml`'s `all`. A
 * scenario that goes green on a defect must never gate a PR.
 *
 *   bun run rig run git-rebuild-settlement
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { readDeviceSyncState } from "../lib/state-view.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";
import type { GitDeferral, RepoRecord } from "../../../src/cli/sync-state-model.js";
import { repoRecordsForState } from "../../../src/cli/sync-state-model.js";

const REPO = "repo-752";
const repoDir = `${GUEST.workDir}/${REPO}`;
/** Standing present-artifact (P) namespace — `base-artifacts.ts:14`. */
const BASE_PRESENT_PREFIX = "refs/rbox-local/base-present/v2";
/** The exact product throw the loop is made of — `p-settlement.ts:100-102`. */
const HOLD_REASON = "P settlement BASE disappeared";
/** The `resolve-command.ts` catch-all that swallowed it on the founder's Mac. */
const RESOLVE_CATCH_ALL = "could not complete safely";
/** Cycle 1's shape: the POST-CAS settlement throw aborts the pull itself
 *  (`received-git-transition-commit.ts:388`) — no deferral is written. */
const PULL_ABORT_LINE = `P settlement refused for ${REPO}:`;
/** Every later cycle's shape: the pre-commit standing proof holds and the repo
 *  is deferred (`apply.ts:563`). This verbatim line IS the loop. */
const LOOP_LINE = `git-sync deferred ${REPO}: ${HOLD_REASON}`;
/** Post-rebuild pulls. Three is the smallest run that shows a REPEAT of a repeat. */
const CYCLES = 3;

/** What the p-settlement fix must turn each pinned assertion into. */
export const FIX_FLIPS = Object.freeze([
  "a record with no serialized BASE must not produce a settlement hold",
  "no apply deferral may survive two consecutive pull cycles unchanged",
  "`rbox git resolve <repo> take-theirs` must settle the repository, not refuse it",
] as const);

const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;
const det = (body: string): string => `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
${body}`.replace(/git /g, `git ${IDENT} `);

/** One post-rebuild observation: everything the loop is judged on. */
interface CycleObservation {
  baseSerialized: boolean;
  standingP: number;
  deferral: GitDeferral | undefined;
  verbose: string;
}

async function repoRecord(device: Device): Promise<RepoRecord | undefined> {
  return repoRecordsForState(await readDeviceSyncState(device, GUEST.workDir))[REPO];
}

/** Standing P artifacts currently living in B's repository. */
async function standingPresentArtifacts(device: Device): Promise<string[]> {
  const out = await device.exec(["git", "-C", repoDir, "for-each-ref", "--format=%(refname)", BASE_PRESENT_PREFIX], { allowFail: true });
  return out.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function seedRepoA(a: Device): Promise<void> {
  await a.exec(["sh", "-c", det(`
mkdir -p '${repoDir}'
git -C '${repoDir}' init -q -b main
printf 'base\\n' > '${repoDir}/file.txt'
git -C '${repoDir}' add file.txt
git -C '${repoDir}' commit -qm initial`)]);
}

/** A publishes a brand-new branch — the shape whose P payload carries
 *  `priorOid: null`, i.e. no prior serialized BASE value for that ref. */
async function publishNewBranchOnA(ctx: RigCtx, rec: Recorder, branch: string): Promise<void> {
  const file = `${branch.replace(/\//g, "-")}.txt`;
  await rec.step(`[A] publish new branch ${branch}`, async () => {
    await ctx.a.exec(["sh", "-c", det(`
git -C '${repoDir}' switch -q -c '${branch}' main
printf '${branch}\\n' > '${repoDir}/${file}'
git -C '${repoDir}' add -A
git -C '${repoDir}' commit -qm '${branch}'
git -C '${repoDir}' switch -q main`)]);
    await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
  });
}

/** One post-rebuild pull plus the full observation of what it left behind. */
async function observeCycle(ctx: RigCtx, cycle: number): Promise<CycleObservation> {
  const pull = await ctx.b.rbox(["pull", "--verbose"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
  const record = await repoRecord(ctx.b);
  const standing = await standingPresentArtifacts(ctx.b);
  const verbose = `${pull.stdout}\n${pull.stderr}`.split("\n").filter((l) => l.includes(REPO)).join(" | ");
  const observation: CycleObservation = {
    baseSerialized: record?.base?.refs !== undefined,
    standingP: standing.length,
    deferral: record?.deferrals?.apply,
    verbose,
  };
  ctx.log(`  cycle ${cycle}: pull exit=${pull.exitCode} · BASE=${observation.baseSerialized ? "serialized" : "ABSENT"} · standing P=${observation.standingP} · deferral=${JSON.stringify(observation.deferral ?? null)}`);
  if (verbose) ctx.log(`  cycle ${cycle} pull lines: ${verbose.slice(0, 400)}`);
  return observation;
}

/** True when two adjacent cycles are the SAME unchanged `artifact` deferral —
 *  the loop signature, as opposed to a deferral that is making progress. */
function repeatsIdentically(a: CycleObservation | undefined, b: CycleObservation | undefined): boolean {
  if (!a?.deferral || !b?.deferral) return false;
  return a.deferral.lane === "apply" && b.deferral.lane === "apply"
    && a.deferral.reason === "artifact" && b.deferral.reason === "artifact"
    && a.deferral.deferredSince === b.deferral.deferredSince
    && !a.baseSerialized && !b.baseSerialized
    && a.standingP > 0 && b.standingP > 0;
}

export const gitRebuildSettlement: Scenario = {
  name: "git-rebuild-settlement",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const cycles: CycleObservation[] = [];

    try {
      const { workspaceId } = await provisionPair(ctx, rec, { afterSeedA: seedRepoA });

      await rec.step("[B] converged join serializes a BASE", async () => {
        const record = await repoRecord(ctx.b);
        rec.assert("B's pre-rebuild record has a serialized BASE",
          record?.base?.refs !== undefined, JSON.stringify(record?.base?.refs ?? null));
      });

      // Negative control: the ordinary P lifecycle retires its artifact in-flight.
      await publishNewBranchOnA(ctx, rec, "feature/one");
      await rec.step("[B] ordinary branch follow retires its P", async () => {
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        const standing = await standingPresentArtifacts(ctx.b);
        const record = await repoRecord(ctx.b);
        rec.assert("a healthy follow leaves no standing P", standing.length === 0, standing.join(", ") || "none");
        rec.assert("a healthy follow leaves no apply deferral", record?.deferrals?.apply === undefined, JSON.stringify(record?.deferrals?.apply ?? null));
      });

      await rec.step("[B] rebuild — rename .rbox aside, re-track the same directory", async () => {
        await ctx.b.exec(["sh", "-c", `set -e
rm -rf '${GUEST.workDir}/.rbox.pre-rebuild'
mv '${GUEST.workDir}/.rbox' '${GUEST.workDir}/.rbox.pre-rebuild'`]);
        const tracked = await ctx.b.rbox(["track", GUEST.workDir, "--workspace", workspaceId, "--no-interactive", "--remote", ctx.apiUrl], { cwd: GUEST.workDir, allowFail: true });
        if (tracked.exitCode !== 0) throw new Error(`rebuild track refused: ${`${tracked.stdout}\n${tracked.stderr}`.slice(0, 300)}`);
      });

      await publishNewBranchOnA(ctx, rec, "feature/two");

      await rec.step(`[B] ${CYCLES} post-rebuild pull cycles`, async () => {
        for (let cycle = 1; cycle <= CYCLES; cycle++) cycles.push(await observeCycle(ctx, cycle));
      });

      const last = cycles.at(-1);
      rec.assert("[BUG #752-B] the rebuilt record carries NO serialized BASE",
        last?.baseSerialized === false, `BASE=${last?.baseSerialized ? "serialized" : "absent"}`);
      rec.assert("[BUG #752-B] a standing P artifact survives every cycle",
        cycles.every((c) => c.standingP > 0), cycles.map((c) => c.standingP).join(","));
      const consecutive = cycles.some((_, i) => repeatsIdentically(cycles[i], cycles[i + 1]));
      rec.assert("[BUG #752-B] the same `artifact` apply deferral repeats on ≥2 consecutive cycles",
        consecutive, cycles.map((c) => `${c.deferral?.reason ?? "none"}@${c.deferral?.deferredSince ?? "-"}`).join(" → "));
      const loopLine = cycles.some((_, i) => cycles[i]?.verbose.includes(LOOP_LINE) && cycles[i + 1]?.verbose.includes(LOOP_LINE));
      rec.assert(`[BUG #752-B] \`${LOOP_LINE}\` on ≥2 consecutive pulls`,
        loopLine, cycles.map((c, i) => `${i + 1}:${c.verbose.includes(LOOP_LINE)}`).join(" "));
      rec.assert("[BUG #752-B] the first post-rebuild pull ABORTS on the post-CAS settlement throw",
        cycles[0]?.verbose.includes(PULL_ABORT_LINE) === true, cycles[0]?.verbose.slice(0, 300) ?? "no cycle");

      await rec.step("[B] git resolve take-theirs (twice — #647 boundary probe)", async () => {
        const first = await ctx.b.rbox(["git", "resolve", REPO, "take-theirs"], { cwd: GUEST.workDir, allowFail: true });
        const firstOut = `${first.stdout}\n${first.stderr}`.trim();
        ctx.log(`  resolve #1 exit=${first.exitCode}: ${firstOut.slice(0, 500)}`);
        rec.assert("[BUG #752-B] take-theirs cannot clear the P-settlement wedge",
          first.exitCode !== 0, `exit=${first.exitCode}`);
        // Which message reaches the user is the #752 sub-question: the founder's Mac
        // saw the catch-all ×4, so the rig records the classification either way.
        const real = firstOut.includes(HOLD_REASON);
        rec.assert("[BUG #752-B] take-theirs refuses naming the P-settlement hold (real reason, not the catch-all)",
          real, real ? firstOut.split("\n").filter((l) => l.includes(HOLD_REASON)).join(" | ") : `catch-all=${firstOut.includes(RESOLVE_CATCH_ALL)}: ${firstOut.slice(0, 300)}`);

        // #647: a second, identical invocation must not degrade — a boundary that
        // self-invalidates would answer differently the second time.
        const second = await ctx.b.rbox(["git", "resolve", REPO, "take-theirs"], { cwd: GUEST.workDir, allowFail: true });
        const secondOut = `${second.stdout}\n${second.stderr}`.trim();
        ctx.log(`  resolve #2 exit=${second.exitCode}: ${secondOut.slice(0, 500)}`);
        rec.assert("[BUG #752-B] a repeated take-theirs refuses identically (no #647 boundary drift here)",
          second.exitCode === first.exitCode && secondOut.includes(HOLD_REASON) === real,
          `#1 exit=${first.exitCode} · #2 exit=${second.exitCode} · #2: ${secondOut.slice(0, 300)}`);

        const after = await repoRecord(ctx.b);
        const standing = await standingPresentArtifacts(ctx.b);
        rec.assert("[BUG #752-B] both resolve attempts leave the wedge exactly as they found it",
          after?.base?.refs === undefined && standing.length > 0,
          `BASE=${after?.base?.refs ? "serialized" : "absent"} standingP=${standing.length}`);
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: gitRebuildSettlement.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
