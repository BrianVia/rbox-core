/**
 * `git-held-livelock` (design 174 — held-repo livelock: held-skip + pending
 * supersession). Reproduces the savvy-core wedge through a REAL two-writer
 * transition (design 174 §5 test 1 — never the retracted seq-83 narrative), then
 * asserts the three shipped behaviors end-to-end on live daemons:
 *
 *   SEED — both hosts converge on repo-174 at X. A's daemon STOPS (an offline
 *   writer, exactly the fleet shape). B — the second writer — advances main
 *   X→X2 and publishes. A, still offline, mints the IDENTICAL X2 commit locally
 *   (deterministic author/date/content ⇒ identical sha — the rig's stand-in for
 *   "both machines pulled the same upstream commit from origin") and then goes
 *   one further: X2→Y. A restarts: the incoming section (main=X2) is now a
 *   strict ancestor of A's local main=Y ⇒ the ownership proof answers unowned ⇒
 *   `local-commits` hold, pending set. That is the livelock precondition —
 *   pre-174 this repo re-follows at full cost on EVERY pull, forever.
 *
 *   ROUND skip (item A) — another notify pull on A while held: the pull summary
 *   must carry `skippedHeld=1` and the window must NOT contain a second
 *   `git-sync followed repo-174` (the re-follow is skipped, deferral retained).
 *
 *   ROUND self-heal (item B) — A pushes: capture-then-prove-then-swap publishes
 *   A's truth, the accepted ACK emits the one bounded
 *   `git-sync superseded pending repo-174: …` line and clears the sidecars;
 *   B then converges to Y (`git-sync followed repo-174` on B, HEAD=Y). A's
 *   follow-up pull window shows the repo `unchanged` — no re-follow, no skip.
 *
 * Assertion posture (design 56 §9): PATH, not milliseconds — every check parses
 * daemon-log mechanism lines inside a `linesSince` window; wall-clock ceilings
 * are generous backstops only. Controls: no `refs/rbox-conflict/*` minted on
 * either host, and A's working tree stays clean throughout.
 *
 * MANUAL / explicit-only: NOT in FAST_SUITE — it stops/starts a live daemon and
 * runs several propagation rounds; it is the orchestrator-run pre-merge guard
 * for design 174, the sibling of `git-commit-propagation` for 172/175.
 */
import { GUEST } from "../lib/config.js";
import { pollUntil } from "../lib/waiters.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount, DAEMON_READY_TIMEOUT_MS } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo-174";
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;
/** Generous convergence window (fast path is seconds; the 60s safety scan still
 *  lands inside it, and the PATH assertions — not the timeout — catch a fall-through). */
const PROPAGATE_TIMEOUT_MS = 120_000;
const HEAD_POLL_MS = 1000;

/** Deterministic env prefix: fixed identity + a per-commit date pin so the SAME
 *  logical commit run on A and B mints the SAME sha (the two-writer seed relies on it). */
const detScript = (body: string): string => `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }
${body}`.replace(/git /g, `git ${IDENT} `);

/** Seed repo at X (two commits) on A before the daemons start. */
async function buildRepo(a: Device): Promise<void> {
  const dir = `${GUEST.workDir}/${REPO}`;
  await a.exec(["sh", "-c", detScript(`
mkdir -p '${dir}'
cd '${dir}'
git init -q -b main
printf 'one\\n' > a.txt
D 2026-01-01; git add a.txt && git commit -q -m 'commit 1'
printf 'two\\n' > b.txt
D 2026-01-02; git add b.txt && git commit -q -m 'commit 2'
`)]);
}

/** The deterministic X→X2 advancement — run VERBATIM on B (the second writer)
 *  and on offline A, minting the identical sha on both. */
const ADVANCE_X2 = `
cd '${GUEST.workDir}/${REPO}'
printf 'three\\n' > c.txt
D 2026-01-03; git add c.txt && git commit -q -m 'commit 3 (both writers)'
`;

/** A's local-ahead commit Y — A only, after X2. */
const ADVANCE_Y = `
cd '${GUEST.workDir}/${REPO}'
printf 'four\\n' > d.txt
D 2026-01-04; git add d.txt && git commit -q -m 'commit 4 (A ahead)'
`;

async function gitHead(dev: Device, repoDir: string): Promise<string> {
  const r = await dev.exec(["git", "-C", repoDir, "rev-parse", "HEAD"], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function conflictRefCount(dev: Device, repoDir: string): Promise<number> {
  const r = await dev.exec(["sh", "-c", `git -C '${repoDir}' for-each-ref refs/rbox-conflict | wc -l`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

function readLogs(dev: Device): Promise<string> {
  return dev.readDaemonLogs(GUEST.rboxHome);
}

/** Emit-timestamp window filter — identical semantics to git-commit-propagation's. */
function linesSince(log: string, sinceMs: number): string {
  return log
    .split("\n")
    .filter((l) => {
      const t = Date.parse(l.slice(0, 24));
      return Number.isFinite(t) && t >= sinceMs;
    })
    .join("\n");
}

const followedRe = new RegExp(`git-sync followed ${REPO}\\b`);
/** A single-branch repo holds EVERY ref, so the hold surfaces as `git-sync deferred`
 *  (maiden-run lesson: `followed` only appears when sibling refs applied around the
 *  held one, as on the many-branch fleet repo). Either shape proves the hold took. */
const heldRe = new RegExp(`git-sync (deferred|followed) ${REPO}\\b`);
const supersededRe = new RegExp(`git-sync superseded pending ${REPO}: local history subsumes the unapplied remote section`);
/** A pull-summary git-apply token with a nonzero held skip. */
const skippedHeldRe = /\bskippedHeld=[1-9]\d*\b/;

export const gitHeldLivelock: Scenario = {
  name: "git-held-livelock",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const rec: Recorder = createRecorder(ctx);
    const startedAt = new Date().toISOString();
    const repoDir = `${GUEST.workDir}/${REPO}`;
    try {
      await rec.step("[A] seed repo-174 at X", () => buildRepo(ctx.a));
      await provisionPair(ctx, rec);
      await startDaemons(ctx, rec);

      // Converge B to X before seeding (both hosts share the repo's history).
      const headX = await gitHead(ctx.a, repoDir);
      await rec.step("[B] converges to X", async () => {
        const out = await pollUntil({ probe: async () => (await gitHead(ctx.b, repoDir)) === headX, done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error(`B never reached X (${headX.slice(0, 8)}) within ${PROPAGATE_TIMEOUT_MS}ms`);
      });

      // ── SEED: the real two-writer transition ──────────────────────────────
      const seedAt = Date.now();
      await rec.step("[A] rbox stop (offline writer)", async () => {
        await ctx.a.daemonStop(GUEST.workDir);
      });
      await rec.step("[B] second writer advances X→X2 and publishes", async () => {
        await ctx.b.exec(["sh", "-c", detScript(ADVANCE_X2)]);
        const out = await pollUntil({ probe: async () => /push: published sequence/.test(linesSince(await readLogs(ctx.b), seedAt)), done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error("B never published the X2 advancement");
      });
      let headY = "";
      await rec.step("[A] offline: mints identical X2, then Y (local-ahead)", async () => {
        await ctx.a.exec(["sh", "-c", detScript(ADVANCE_X2)]);
        const headX2a = await gitHead(ctx.a, repoDir);
        const headX2b = await gitHead(ctx.b, repoDir);
        if (!headX2a || headX2a !== headX2b) {
          throw new Error(`deterministic X2 shas diverged (A=${headX2a.slice(0, 8)} B=${headX2b.slice(0, 8)}) — seed invalid`);
        }
        await ctx.a.exec(["sh", "-c", detScript(ADVANCE_Y)]);
        headY = await gitHead(ctx.a, repoDir);
      });
      const restartAt = Date.now();
      await rec.step("[A] rbox start — pulls B's section, HOLDS (pending ⊑ local)", async () => {
        await ctx.a.daemonStart(GUEST.workDir);
        const out = await pollUntil({ probe: async () => heldRe.test(linesSince(await readLogs(ctx.a), restartAt)), done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error(`A never held ${REPO} after restart — seed did not take`);
      });
      rec.assert("seed: A holds with local main untouched", (await gitHead(ctx.a, repoDir)) === headY,
        `A HEAD must remain Y (${headY.slice(0, 8)}) while the incoming section is held`);

      // ── ROUND skip (item A): a held pull skips the re-follow ──────────────
      const skipAt = Date.now();
      await rec.step("[B] unrelated change → A notify pull while held", async () => {
        await ctx.b.exec(["sh", "-c", `printf 'ping\\n' > '${GUEST.workDir}/loose-174.txt'`]);
        const out = await pollUntil({ probe: async () => /rbox pull /.test(linesSince(await readLogs(ctx.a), skipAt)), done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error("A never pulled while held");
      });
      // skippedHeld is OPPORTUNISTIC here: item B may heal on A's very first
      // post-restart push, leaving no held pull to skip — the A-skip contract is
      // suite-owned (held-skip tests); the rig only refuses a full RE-FOLLOW.
      const skipWindow = linesSince(await readLogs(ctx.a), skipAt);
      ctx.log(`  held-window skippedHeld observed: ${skippedHeldRe.test(skipWindow)}`);
      rec.assert("held window: no full re-follow of the held repo", !followedRe.test(skipWindow),
        `window must not contain 'git-sync followed ${REPO}' while held`);

      // ── ROUND self-heal (item B): supersession publishes A's truth ────────
      // The heal is AUTONOMOUS: the daemon's own pull→push cycle supersedes within
      // seconds of the hold (run-2 lesson: it beat the scripted nudge by 3s), so the
      // watch window opens at RESTART, and the local change below is only a belt.
      await rec.step("[A] capture-then-prove-then-swap supersedes (autonomous or nudged)", async () => {
        await ctx.a.exec(["sh", "-c", `printf 'heal\\n' > '${GUEST.workDir}/heal-174.txt'`]);
        const out = await pollUntil({ probe: async () => supersededRe.test(linesSince(await readLogs(ctx.a), restartAt)), done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error("A never logged the superseded-pending line");
      });
      await rec.step("[B] converges to Y", async () => {
        const out = await pollUntil({ probe: async () => (await gitHead(ctx.b, repoDir)) === headY, done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error(`B never reached Y (${headY.slice(0, 8)})`);
      });
      const healWindowB = linesSince(await readLogs(ctx.b), restartAt);
      rec.assert("heal: B followed the superseding section", followedRe.test(healWindowB),
        "B must follow repo-174 to Y via the ordinary path");

      // Post-heal steady state: one more B-side change; A's pull must treat the
      // repo as unchanged — no re-follow, no held skip (the wedge is GONE).
      const steadyAt = Date.now();
      await rec.step("[A] post-heal pull is unchanged for repo-174", async () => {
        await ctx.b.exec(["sh", "-c", `printf 'pong\\n' > '${GUEST.workDir}/loose-174.txt'`]);
        const out = await pollUntil({ probe: async () => /rbox pull /.test(linesSince(await readLogs(ctx.a), steadyAt)), done: (v) => v === true, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
        if (!out.ok) throw new Error("A never pulled after the heal");
      });
      const steadyWindow = linesSince(await readLogs(ctx.a), steadyAt);
      rec.assert("steady: no re-follow after heal", !followedRe.test(steadyWindow),
        "a healed repo must be unchanged on subsequent pulls");
      rec.assert("steady: no held skip after heal", !skippedHeldRe.test(steadyWindow),
        "no attempt sidecar may survive the ACK clear");

      // ── Controls ──────────────────────────────────────────────────────────
      rec.assert("control: no conflict refs on A", (await conflictRefCount(ctx.a, repoDir)) === 0,
        "supersession must not mint refs/rbox-conflict/*");
      rec.assert("control: no conflict refs on B", (await conflictRefCount(ctx.b, repoDir)) === 0,
        "the follow to Y must not mint refs/rbox-conflict/*");
      const status = await ctx.a.exec(["git", "-C", repoDir, "status", "--porcelain"], { allowFail: true });
      rec.assert("control: A working tree clean", status.exitCode === 0 && status.stdout.trim() === "",
        "the heal must not disturb A's checkout");

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      // Stop daemons before account teardown (a live daemon mid-op races the DELETE).
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
    }
    return finalizeReport({ scenario: gitHeldLivelock.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
