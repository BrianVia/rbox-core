/**
 * `git-commit-propagation` (design 172 — event-driven git-commit detection).
 *
 * The guard: a git COMMIT on host A must reach host B via the FAST path — A's
 * daemon captures+pushes the commit as soon as it happens (a watch event, NOT the
 * 60s safety scan / 5-min WS backstop), and B applies it on a notify-carried pull.
 *
 * Two rounds, both on the SAME synced repo (`repo-172`), daemons live on both hosts:
 *
 *   1. WORKING-TREE COMMIT — A adds a new tracked file and commits it. The new file
 *      is an ordinary plain-file change, so the watcher fires regardless of design
 *      172; this round proves the rig + the fast-path LOG ASSERTIONS themselves are
 *      correct against real daemon output (it passes with or without 172).
 *   2. EMPTY COMMIT (`git commit --allow-empty`) — changes ONLY `.git/`, no working
 *      tree file. `.git` is hard-pruned from the watcher (see watcher.ts: "ignored
 *      dirs … .git … emit zero events"), so PRE-172 this commit is invisible to the
 *      event stream and only the 60s safety scan captures it. This is the design-172
 *      case: with 172, the watcher detects the HEAD/ref move and captures promptly;
 *      without it, this round's A-side "event-driven" assertion + the coarse <30s
 *      ceiling FAIL (the commit crawled in via the safety scan). That failure is the
 *      guard doing its job — it goes green once 172 lands.
 *
 * Assertion posture (design 56 §9 + the flake registry): PATH, not milliseconds. CI
 * runners inflate wall-clock 30-60x, so the primary checks parse the daemon logs for
 * the mechanism (`git-sync: captured` on A without a preceding `safety scan:`;
 * `notify_latency_ms=` + `git-sync followed/applied <repo>` on B, carried by a notify
 * pull and NOT a `ws backstop pull`). The wall-clock ceiling is only a GENEROUS coarse
 * backstop (end-to-end < 30s), never a tight bound; the convergence waiter itself is
 * patient (90s) so a slow-path fall-through still CONVERGES and is caught by the path
 * check rather than an ambiguous timeout.
 *
 * NIGHTLY / explicit-only: NOT in FAST_SUITE. It builds a repo, runs two live
 * propagation rounds, and (pre-172) deliberately waits out the 60s safety scan — too
 * slow and, until 172 merges, red-by-design for the every-PR gate.
 */
import { GUEST } from "../lib/config.js";
import { pollUntil } from "../lib/waiters.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Repo relPath under the workspace (its `gitRepos` manifest key). */
const REPO = "repo-172";

/** Deterministic git identity + dates so reruns mint stable shas. */
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;

/**
 * How long to wait for B's HEAD to reach A's new commit. GENEROUS on purpose: the
 * fast path resolves in seconds; if propagation degrades to the 60s safety scan the
 * tree STILL converges within this window, so the log-based path assertions — not an
 * ambiguous timeout — are what flag the regression.
 */
const PROPAGATE_TIMEOUT_MS = 90_000;

/** Coarse wall-clock ceiling (SECONDARY): end-to-end above this = regression. Never a
 *  tight bound — it sits well under the 60s safety-scan floor so a scan-driven
 *  fall-through trips it, but far above any real fast-path latency even on a slow CI box. */
const FAST_CEILING_MS = 30_000;

const HEAD_POLL_MS = 1000;

/** `git init` a small deterministic repo on A before the first sync captures it. */
async function buildRepo(a: Device): Promise<void> {
  const dir = `${GUEST.workDir}/${REPO}`;
  const script = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }
mkdir -p '${dir}'
cd '${dir}'
git init -q -b main
printf 'one\\n' > a.txt
D 2026-01-01; git add a.txt && git commit -q -m 'commit 1'
printf 'two\\n' > b.txt
D 2026-01-02; git add b.txt && git commit -q -m 'commit 2'
`;
  await a.exec(["sh", "-c", script.replace(/git /g, `git ${IDENT} `)]);
}

/** `git -C <repo> rev-parse HEAD` on a device (trimmed; empty on error). */
async function gitHead(dev: Device, repoDir: string): Promise<string> {
  const r = await dev.exec(["git", "-C", repoDir, "rev-parse", "HEAD"], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

/** Full daemon-log text on a device. */
function readLogs(dev: Device): Promise<string> {
  return dev.readDaemonLogs(GUEST.rboxHome);
}

/**
 * Keep only the daemon-log lines a host emitted AT/AFTER `sinceMs`. Each daemon line
 * is prefixed with its own ISO-8601 emit time (`2026-07-21T02:11:17.846Z …`, 24 chars);
 * we parse that and keep lines >= `sinceMs`. Non-timestamped lines (the harvest's
 * `── path ──` headers) drop out. Filtering by emit time — not a text prefix — isolates
 * THIS commit's window exactly, even if the harvest output isn't a clean append-only
 * prefix (a prefix-slice's silent full-text fallback would smear an earlier round's
 * fast-path lines into a later slow round and mask the regression). Host and guest share
 * the Docker kernel clock, so the times are directly comparable. PURE.
 */
function linesSince(log: string, sinceMs: number): string {
  return log
    .split("\n")
    .filter((l) => {
      const t = Date.parse(l.slice(0, 24));
      return Number.isFinite(t) && t >= sinceMs;
    })
    .join("\n");
}

/** Last index in `lines` matching `re` (−1 if none). */
function lastIdx(lines: string[], re: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]!)) return i;
  return -1;
}

/**
 * The design-172 FAST-PATH assertions, parsed from each host's NEW daemon-log lines.
 *
 * A side (sender): `git-sync: captured N (…repo…)` proves A captured the commit into a
 * push; that no `safety scan:` line precedes it in the delta proves the capture was
 * EVENT-DRIVEN, not the 60s floor. B side (receiver): a `notify_latency_ms=` token
 * proves a committed-notify-driven pull ran, and `git-sync followed|applied <repo>`
 * proves that pull applied the incoming git section — with the nearest preceding
 * trigger being the notify, NOT a `ws backstop pull`. Plus the coarse wall-clock ceiling.
 */
function assertFastPath(rec: Recorder, round: string, aDelta: string, bDelta: string, elapsedMs: number): void {
  const capturedRe = new RegExp(`git-sync: captured [1-9]\\d* \\([^)]*${REPO}[^)]*\\)`);
  const applyRe = new RegExp(`git-sync (followed|applied) ${REPO}`);
  const notifyRe = /notify_latency_ms=\d+/;
  const backstopRe = /ws backstop pull/;
  const scanRe = /safety scan:/;

  // ── A: captured event-driven (not scan-driven) ─────────────────────────────
  const aLines = aDelta.split("\n");
  const capIdx = aLines.findIndex((l) => capturedRe.test(l));
  rec.assert(`[${round}] A captured the commit into a push`, capIdx >= 0,
    capIdx >= 0 ? aLines[capIdx]!.trim() : `no \`git-sync: captured … (${REPO})\` in A's new log`);
  const scanBeforeCapture = aLines.slice(0, capIdx >= 0 ? capIdx : aLines.length).some((l) => scanRe.test(l));
  rec.assert(`[${round}] A capture was event-driven (no safety scan before it)`, capIdx >= 0 && !scanBeforeCapture,
    capIdx < 0 ? "no capture" : scanBeforeCapture ? "a `safety scan:` preceded the capture — slow path" : "no scan before capture");

  // ── B: notify-carried pull applied the git section ─────────────────────────
  const bLines = bDelta.split("\n");
  const applyIdx = bLines.findIndex((l) => applyRe.test(l));
  rec.assert(`[${round}] B applied the incoming git section`, applyIdx >= 0,
    applyIdx >= 0 ? bLines[applyIdx]!.trim() : `no \`git-sync followed/applied ${REPO}\` in B's new log`);
  rec.assert(`[${round}] B pull was notify-carried`, notifyRe.test(bDelta),
    notifyRe.test(bDelta) ? "notify_latency_ms token present" : "no notify_latency_ms token — pull was not committed-notify-driven");
  const prior = bLines.slice(0, applyIdx >= 0 ? applyIdx : bLines.length);
  const notifyPos = lastIdx(prior, notifyRe);
  const backstopPos = lastIdx(prior, backstopRe);
  rec.assert(`[${round}] apply carried by notify, not \`ws backstop pull\``, applyIdx >= 0 && notifyPos > backstopPos,
    `notify@${notifyPos} backstop@${backstopPos} apply@${applyIdx}`);

  // ── SECONDARY: coarse wall-clock ceiling (never a tight bound) ─────────────
  rec.assert(`[${round}] end-to-end under ${FAST_CEILING_MS / 1000}s (coarse backstop)`, elapsedMs < FAST_CEILING_MS,
    `${elapsedMs}ms (ceiling ${FAST_CEILING_MS}ms)`);
}

/** Commit on A, wait for B's HEAD to catch up, then run the fast-path assertions on the
 *  per-host log deltas captured across the commit. Returns nothing — records into `rec`. */
async function commitRound(
  ctx: RigCtx,
  rec: Recorder,
  round: string,
  repoDir: string,
  makeCommit: string,
): Promise<void> {
  // Wall-clock fence: everything the daemons log at/after this instant belongs to THIS
  // commit's propagation (per-host lines are isolated by emit time, see linesSince).
  const commitAt = Date.now();
  await ctx.a.exec(["sh", "-c", makeCommit]);
  const newHead = await gitHead(ctx.a, repoDir);
  if (!newHead) throw new Error(`${round}: A HEAD unreadable after commit`);

  const out = await pollUntil(
    { probe: () => gitHead(ctx.b, repoDir), done: (h) => h === newHead, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS },
  );
  const elapsedMs = Date.now() - commitAt;
  rec.assert(`[${round}] B HEAD reached A's new commit`, out.ok,
    out.ok ? `${elapsedMs}ms → ${newHead.slice(0, 12)}` : `timeout ${elapsedMs}ms — B HEAD ${out.value.slice(0, 12) || "(none)"} ≠ A ${newHead.slice(0, 12)}`);

  const [afterA, afterB] = await Promise.all([readLogs(ctx.a), readLogs(ctx.b)]);
  assertFastPath(rec, round, linesSince(afterA, commitAt), linesSince(afterB, commitAt), elapsedMs);

  // Correctness anchor: B's git object store is clean after applying the commit.
  const fsck = await ctx.b.exec(["git", "-C", repoDir, "fsck", "--strict", "--no-progress"], { allowFail: true });
  rec.assert(`[${round}] B repo fsck --strict clean`, fsck.exitCode === 0, `exit ${fsck.exitCode}`);
}

export const gitCommitPropagation: Scenario = {
  name: "git-commit-propagation",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const repoDir = `${GUEST.workDir}/${REPO}`;

    try {
      // git-sync ON (the default). `afterSeedA` builds the repo before `init --new`,
      // so the first-sync push captures it; B's join pull materializes it on B.
      await provisionPair(ctx, rec, { afterSeedA: buildRepo });

      await rec.step("baseline: repo present + converged on both hosts", async () => {
        const [ha, hb] = await Promise.all([gitHead(ctx.a, repoDir), gitHead(ctx.b, repoDir)]);
        rec.assert("A repo HEAD readable", ha !== "", ha.slice(0, 12) || "(unreadable)");
        rec.assert("B has the repo at A's HEAD (first sync landed)", ha !== "" && ha === hb, `A=${ha.slice(0, 12)} B=${hb.slice(0, 12) || "(none)"}`);
      });

      // Daemons up on BOTH hosts — the live watch/notify propagation loop under test.
      const modes = await startDaemons(ctx, rec);
      ctx.log(`  (watcher modes — A: ${modes.a}, B: ${modes.b})`);

      // ── Round 1: working-tree commit (fast path fires with or without 172) ──
      await rec.step("[A→B] working-tree commit propagates fast", async () => {
        const cmd = `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
cd '${repoDir}'
printf 'r1\\n' > tracked-r1.txt
GIT_AUTHOR_DATE='2026-04-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-04-01T00:00:00 +0000' git ${IDENT} add tracked-r1.txt && GIT_AUTHOR_DATE='2026-04-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-04-01T00:00:00 +0000' git ${IDENT} commit -q -m 'working-tree commit'`;
        await commitRound(ctx, rec, "working-tree", repoDir, cmd);
      });

      // ── Round 2: EMPTY commit — the design-172 event-driven case (.git only) ──
      await rec.step("[A→B] empty commit propagates fast (design 172)", async () => {
        const cmd = `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
cd '${repoDir}'
GIT_AUTHOR_DATE='2026-04-02T00:00:00 +0000' GIT_COMMITTER_DATE='2026-04-02T00:00:00 +0000' git ${IDENT} commit --allow-empty -q -m 'design-172 empty commit'`;
        await commitRound(ctx, rec, "empty-commit", repoDir, cmd);
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      // Stop daemons before account teardown (a live daemon mid-op races the DELETE).
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
    }

    return finalizeReport({ scenario: gitCommitPropagation.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
