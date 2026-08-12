/**
 * `git-commit-propagation` (design 172 — event-driven git-commit detection) + the
 * surrounding change-shape matrix. Daemons live on BOTH hosts; each round makes one
 * kind of change on A and observes how it reaches B.
 *
 * GIT-COMMIT rounds (fast path = event-driven capture on A + notify-carried pull on B,
 * NOT the 60s safety scan / 5-min WS backstop):
 *   1. working-tree commit (existing repo) — a new tracked file rides the plain-file
 *      watch, so this fires WITH OR WITHOUT 172; it proves the rig + the log-line
 *      assertions match real daemon output.
 *   2. empty commit (existing repo, `--allow-empty`) — the core design-172 case: only
 *      `.git` changes. Pre-172 it crawls in via the 60s safety scan; with 172 the ref-watch
 *      makes it event-driven. Asserted event-driven.
 *   5. working-tree commit in a SMALL new repo (a few tiny files, git init'd after the
 *      daemon started) — event-driven (the plain files fire events).
 *   6. empty commit in that small new repo — design 175's post-daemon repository case:
 *      the Linux ref side-channel discovers, arms, and handshakes the new repo before this
 *      mutation. Asserted event-driven with a sub-30s ceiling.
 *   8. working-tree commit in the big NEW repo — event-driven.
 *   9. empty commit in the big NEW repo — design 175's atomic populated move-in case.
 *      Asserted event-driven with a sub-30s ceiling.
 *
 * FILE-PLANE rounds (regression guards that 172 didn't break the ordinary watch path;
 * these are NOT git-sync — HEAD must not move on B):
 *   3. tracked-file edit, NO commit — a dirty working-tree change; propagates as a plain
 *      file. We assert + REPORT B's real end state (working tree vs HEAD).
 *   4. loose file outside any repo — plain-file control.
 *
 * THROUGHPUT / new-repo-appearance round:
 *   7. a genuinely BIG repo appears in the workspace AFTER the daemons started — a real
 *      `git clone` of a public repo (anomalyco/opencode) staged outside the workspace and
 *      moved in as a unit (re-init'd non-shallow — rbox refuses shallow clones), with a
 *      synthesized fallback if the container has no egress. It exercises a real burst
 *      (~125MB working tree + a big `.git`) AND the "new dir appeared" detection question;
 *      we REPORT the source, the sizes, the wall time to converge on B, and whether A's
 *      capture was event-driven or scan-bound.
 *
 * Assertion posture (design 56 §9 + the flake registry): PATH, not milliseconds. CI
 * runners inflate wall-clock 30-60x, so the primary git checks parse the daemon logs for
 * the mechanism (`git-sync: captured` on A without a preceding `safety scan:`;
 * `notify_latency_ms=` + `git-sync followed/applied <repo>` on B, carried by a notify pull
 * and NOT a `ws backstop pull`). Wall-clock ceilings are only GENEROUS coarse backstops,
 * never tight bounds; propagation waiters are patient so a slow-path fall-through still
 * CONVERGES and is caught by the path check, not an ambiguous timeout. Per-round
 * daemon-log windows are isolated by emit timestamp (see linesSince).
 *
 * MANUAL / explicit-only: NOT in FAST_SUITE. It runs several live propagation rounds
 * and moves a ~200MB repo through the dev API, so it remains an orchestrator-run
 * pre-merge validation rather than an every-PR gate.
 */
import { GUEST } from "../lib/config.js";
import { pollUntil } from "../lib/waiters.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";
import { buildHopReport, renderHopReport, type HopReport, type PropagationClassification } from "../../propagation-report.js";

/** The seeded repo (present before the daemons start), a small repo created live, and the
 *  big repo that appears live. */
const REPO = "repo-172";
const SMALL_REPO = "smallrepo";
const BIG_REPO = "bigrepo";
/** Public, token-free — the container clones it directly. Fallback synthesizes offline. */
const BIG_REPO_URL = "https://github.com/anomalyco/opencode";
/** Staged OUTSIDE the workspace (same fs as workDir → the move-in is an atomic rename). */
const BIG_STAGING = "/work/bigrepo-staging";

/** Deterministic git identity + dates so reruns mint stable shas. */
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;

/**
 * How long to wait for B to reach A's new state (git rounds). GENEROUS on purpose: the
 * fast path resolves in seconds; if propagation degrades to the 60s safety scan the tree
 * STILL converges within this window, so the log-based path assertions — not an ambiguous
 * timeout — flag the regression.
 */
const PROPAGATE_TIMEOUT_MS = 90_000;
/** The ~200MB repo crosses the dev API twice (upload from A, download on B); give it room. */
const BIG_REPO_TIMEOUT_MS = 300_000;

/** Coarse wall-clock ceiling (SECONDARY): end-to-end above this = regression. Never a
 *  tight bound — it sits under the 60s safety-scan floor so a scan-driven fall-through
 *  trips it, but far above any real fast-path latency even on a slow CI box. */
const FAST_CEILING_MS = 30_000;
/** Stop observing before the scenario's coarse ceiling; a missing joined hop is only
 * INVALID after this bounded allowance for daemon-log writes to become readable. */
const HOP_OBSERVATION_DEADLINE_MS = FAST_CEILING_MS - 1_000;
/** Both guests are containers on one Docker host and therefore share its wall clock. */
const RIG_CLOCK_SKEW_BOUND_MS = 5;

const HEAD_POLL_MS = 1000;
const BIG_POLL_MS = 2000;

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

/** `git -C <repo> status --porcelain` on a device (trimmed; empty on error). */
async function gitStatus(dev: Device, repoDir: string): Promise<string> {
  const r = await dev.exec(["git", "-C", repoDir, "status", "--porcelain"], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

/** Sum of regular-file byte sizes under `dir`, EXCLUDING `.git` — the file-plane payload
 *  (dir-entry overhead excluded so A and B compare exactly). −1 on error. */
async function treeBytes(dev: Device, dir: string): Promise<number> {
  const r = await dev.exec(["sh", "-c", `find '${dir}' -type f -not -path '*/.git/*' -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

/** Byte size of a directory subtree via `du -sb` (−1 on error). */
async function duBytes(dev: Device, dir: string): Promise<number> {
  const r = await dev.exec(["sh", "-c", `du -sb '${dir}' 2>/dev/null | cut -f1`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

/** Count of regular files under `dir` excluding `.git` (−1 on error). */
async function fileCount(dev: Device, dir: string): Promise<number> {
  const r = await dev.exec(["sh", "-c", `find '${dir}' -type f -not -path '*/.git/*' | wc -l`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
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
 * THIS change's window exactly, even if the harvest output isn't a clean append-only
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

type HopObservation = {
  aDelta: string;
  bDelta: string;
  hops: HopReport;
  state: "present-at-initial-read" | "log-not-yet-flushed-at-initial-read" | "hop-truly-missing-after-deadline";
  waitedMs: number;
};

/** Poll both logs until the sequence-joined report is complete, not merely until B has
 * logged an apply for some sequence. Filesystem/HEAD witnesses can become visible before
 * the joined sender trace or receiver apply-complete write is readable. */
async function awaitHopObservation(
  a: Device,
  b: Device,
  changeAt: number,
  attempt: string,
  classification: PropagationClassification,
  witnessMatched: boolean,
): Promise<HopObservation> {
  type Snapshot = { aDelta: string; bDelta: string; hops: HopReport };
  const remainingMs = Math.max(0, HOP_OBSERVATION_DEADLINE_MS - (Date.now() - changeAt));
  const out = await pollUntil({
    probe: async (): Promise<Snapshot> => {
      const [aLog, bLog] = await Promise.all([readLogs(a), readLogs(b)]);
      const aDelta = linesSince(aLog, changeAt);
      const bDelta = linesSince(bLog, changeAt);
      return {
        aDelta,
        bDelta,
        hops: buildHopReport(aDelta, bDelta, {
          attempt,
          classification,
          writeAt: changeAt,
          clockSkewBoundMs: RIG_CLOCK_SKEW_BOUND_MS,
          witnessMatched,
        }),
      };
    },
    done: (snapshot) => snapshot.hops.verdict !== "INVALID",
    timeoutMs: remainingMs,
    intervalMs: 100,
  });
  return {
    ...out.value,
    state: out.ok
      ? out.attempts === 1 ? "present-at-initial-read" : "log-not-yet-flushed-at-initial-read"
      : "hop-truly-missing-after-deadline",
    waitedMs: out.elapsedMs,
  };
}

function hopObservationDetail(observation: HopObservation): string {
  return `correlation=${observation.hops.correlation} sequence=${observation.hops.sequence ?? "-"} verdict=${observation.hops.verdict} observation=${observation.state} waited=${observation.waitedMs}ms`;
}

function exactHopWithin(report: HopReport, ceilingMs: number): boolean {
  const { write, applyComplete } = report.stamps;
  return report.correlation === "exact" && write !== undefined && applyComplete !== undefined
    && applyComplete - write < ceilingMs;
}

/** True iff `aDelta` shows A capturing `repo` with NO `safety scan:` line before it
 *  (event-driven). Returns [captured, eventDriven]. */
function captureShape(aDelta: string, repo: string): { captured: boolean; eventDriven: boolean; line: string } {
  const capturedRe = new RegExp(`git-sync: captured [1-9]\\d* \\([^)]*${repo}[^)]*\\)`);
  const lines = aDelta.split("\n");
  const capIdx = lines.findIndex((l) => capturedRe.test(l));
  const scanBefore = lines.slice(0, capIdx >= 0 ? capIdx : lines.length).some((l) => /safety scan:/.test(l));
  return { captured: capIdx >= 0, eventDriven: capIdx >= 0 && !scanBefore, line: capIdx >= 0 ? lines[capIdx]!.trim() : "" };
}

/**
 * Assert a git commit in `repo` propagated, parsed from each host's NEW daemon-log lines.
 * A side (sender): `git-sync: captured N (…repo…)` proves A captured the commit into a push;
 * NO `safety scan:` line preceding it proves the capture was EVENT-DRIVEN, not the 60s floor.
 * B side (receiver): a `notify_latency_ms=` token proves a committed-notify-driven pull ran,
 * and `git-sync followed|applied <repo>` proves that pull applied the incoming git section —
 * with the nearest preceding trigger the notify, NOT a `ws backstop pull`. Every Git
 * commit round requires the event-driven path.
 */
function assertPropagation(rec: Recorder, round: string, repo: string, aDelta: string, bDelta: string, elapsedMs: number): void {
  const applyRe = new RegExp(`git-sync (followed|applied) ${repo}`);
  const notifyRe = /notify_latency_ms=\d+/;
  const backstopRe = /ws backstop pull/;

  // ── A: the commit was captured into a push ─────────────────────────────────
  const shape = captureShape(aDelta, repo);
  rec.assert(`[${round}] A captured the commit into a push`, shape.captured,
    shape.captured ? shape.line : `no \`git-sync: captured … (${repo})\` in A's new log`);

  // ── B: notify-carried pull applied the git section ─────────────────────────
  const bLines = bDelta.split("\n");
  const applyIdx = bLines.findIndex((l) => applyRe.test(l));
  rec.assert(`[${round}] B applied the incoming git section`, applyIdx >= 0,
    applyIdx >= 0 ? bLines[applyIdx]!.trim() : `no \`git-sync followed/applied ${repo}\` in B's new log`);
  rec.assert(`[${round}] B pull was notify-carried`, notifyRe.test(bDelta),
    notifyRe.test(bDelta) ? "notify_latency_ms token present" : "no notify_latency_ms token — pull was not committed-notify-driven");
  const prior = bLines.slice(0, applyIdx >= 0 ? applyIdx : bLines.length);
  const notifyPos = lastIdx(prior, notifyRe);
  const backstopPos = lastIdx(prior, backstopRe);
  rec.assert(`[${round}] apply carried by notify, not \`ws backstop pull\``, applyIdx >= 0 && notifyPos > backstopPos,
    `notify@${notifyPos} backstop@${backstopPos} apply@${applyIdx}`);

  // ── A-side timing guarantee ────────────────────────────────────────────────
  rec.assert(`[${round}] A capture was event-driven (no safety scan before it)`, shape.eventDriven,
    !shape.captured ? "no capture" : shape.eventDriven ? "no scan before capture — event-driven" : "a `safety scan:` preceded the capture — SCAN-BOUND (slow path)");
  rec.assert(`[${round}] end-to-end under ${FAST_CEILING_MS / 1000}s (coarse backstop)`, elapsedMs < FAST_CEILING_MS,
    `${elapsedMs}ms (ceiling ${FAST_CEILING_MS}ms)`);
}

/**
 * Run `makeChange` on A (which advances `repoDir`'s HEAD), wait for B's HEAD to catch up,
 * then assert event-driven propagation on the per-host log windows fenced at the change.
 */
async function commitRound(
  ctx: RigCtx,
  rec: Recorder,
  round: string,
  repo: string,
  repoDir: string,
  classification: PropagationClassification,
  makeChange: string,
): Promise<void> {
  // Wall-clock fence: everything the daemons log at/after this instant belongs to THIS
  // change's propagation (per-host lines are isolated by emit time, see linesSince).
  const changeAt = Date.now();
  await ctx.a.exec(["sh", "-c", makeChange]);
  const newHead = await gitHead(ctx.a, repoDir);
  if (!newHead) throw new Error(`${round}: A HEAD unreadable after change`);

  const out = await pollUntil({ probe: () => gitHead(ctx.b, repoDir), done: (h) => h === newHead, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
  const elapsedMs = Date.now() - changeAt;
  rec.assert(`[${round}] B HEAD reached A's new commit`, out.ok,
    out.ok ? `${elapsedMs}ms → ${newHead.slice(0, 12)}` : `timeout ${elapsedMs}ms — B HEAD ${out.value.slice(0, 12) || "(none)"} ≠ A ${newHead.slice(0, 12)}`);

  const observation = await awaitHopObservation(ctx.a, ctx.b, changeAt, round, classification, out.ok);
  assertPropagation(rec, round, repo, observation.aDelta, observation.bDelta, elapsedMs);
  ctx.log(`${renderHopReport(observation.hops).trimEnd()}\n10s verdict ${observation.hops.verdict} (report-only; n=1, authoritative at n>=30)\nobservation ${observation.state} waited_ms=${observation.waitedMs}`);
  rec.assert(`[${round}] exact sequence-joined propagation within ${FAST_CEILING_MS / 1000}s coarse ceiling`, exactHopWithin(observation.hops, FAST_CEILING_MS),
    hopObservationDetail(observation));

  const fsck = await ctx.b.exec(["git", "-C", repoDir, "fsck", "--strict", "--no-progress"], { allowFail: true });
  rec.assert(`[${round}] B repo fsck --strict clean`, fsck.exitCode === 0, `exit ${fsck.exitCode}`);
}

/**
 * A plain-file change (NOT a commit) written on A must reach B via the ordinary file
 * watch/notify path — HEAD stays put on B. `expectDirty` is the repo whose porcelain we
 * then REPORT (a tracked-but-uncommitted edit should leave B's working tree differing from
 * its HEAD); pass undefined for a loose file that lives outside any repo.
 */
async function filePlaneRound(
  ctx: RigCtx, rec: Recorder, round: string, path: string, body: string,
  expectDirty?: { repoDir: string; wantHead: string },
): Promise<void> {
  const changeAt = Date.now();
  await ctx.a.writeFile(path, body);
  const out = await pollUntil({ probe: () => ctx.b.readFileIfExists(path), done: (c) => c === body, timeoutMs: PROPAGATE_TIMEOUT_MS, intervalMs: HEAD_POLL_MS });
  const elapsedMs = Date.now() - changeAt;
  rec.assert(`[${round}] file landed on B`, out.ok,
    out.ok ? `${elapsedMs}ms` : `timeout ${elapsedMs}ms — B has ${JSON.stringify(out.value)?.slice(0, 40)}`);
  rec.assert(`[${round}] propagated under the fast ceiling`, out.ok && elapsedMs < FAST_CEILING_MS, `${elapsedMs}ms (ceiling ${FAST_CEILING_MS}ms)`);

  const observation = await awaitHopObservation(ctx.a, ctx.b, changeAt, round, "file", out.ok);
  rec.assert(`[${round}] B pull was notify-carried`, /notify_latency_ms=\d+/.test(observation.bDelta),
    /notify_latency_ms=\d+/.test(observation.bDelta) ? "notify_latency_ms token present" : "no notify_latency_ms token");
  ctx.log(`${renderHopReport(observation.hops).trimEnd()}\n10s verdict ${observation.hops.verdict} (report-only; n=1, authoritative at n>=30)\nobservation ${observation.state} waited_ms=${observation.waitedMs}`);
  rec.assert(`[${round}] exact sequence-joined propagation within ${FAST_CEILING_MS / 1000}s coarse ceiling`, exactHopWithin(observation.hops, FAST_CEILING_MS),
    hopObservationDetail(observation));

  if (expectDirty) {
    // File-plane change, not git: B's HEAD must NOT have moved (no phantom commit).
    const bHead = await gitHead(ctx.b, expectDirty.repoDir);
    rec.assert(`[${round}] B HEAD unchanged (file plane, not git-sync)`, bHead === expectDirty.wantHead,
      `B=${bHead.slice(0, 12)} want=${expectDirty.wantHead.slice(0, 12)}`);
    // REPORT the real end state: the tracked-but-uncommitted edit should show as a dirty
    // working tree on B (design 43 — working-tree files sync plain; B's index is unchanged).
    const [aStat, bStat] = await Promise.all([gitStatus(ctx.a, expectDirty.repoDir), gitStatus(ctx.b, expectDirty.repoDir)]);
    rec.assert(`[${round}] B working tree differs from HEAD (uncommitted edit)`, bStat !== "",
      bStat === "" ? "porcelain empty — edit did NOT surface as dirty on B" : `B porcelain: ${bStat.replace(/\n/g, " · ")}`);
    rec.assert(`[${round}] B porcelain matches A (same dirty state)`, aStat === bStat,
      `A: ${aStat.replace(/\n/g, " · ") || "(clean)"} | B: ${bStat.replace(/\n/g, " · ") || "(clean)"}`);
  }
}

/**
 * Stage the big repo OUTSIDE the workspace, ready to be moved in as a unit.
 *
 * We clone the real public repo's working tree (`--depth 1` — fast, ~125MB / 6243 real
 * files) then RE-INIT it as a self-contained single-commit repo. That re-init is
 * load-bearing: rbox's git-sync deliberately REFUSES a shallow clone ("shallow clone —
 * unsupported (git fetch --unshallow to sync history) — section not captured"), so a raw
 * `--depth 1` repo would land its working tree on B via the file plane but never capture a
 * git section (B ends up file-complete with no HEAD). A full clone is non-shallow but
 * ~560MB (441MB `.git`) — too heavy for the dev API. The re-init keeps the genuine big
 * working-tree burst while giving a normal non-shallow `.git` that captures + travels.
 * Offline (no egress), we synthesize an equivalently big non-shallow repo. Returns the
 * source label + measured sizes.
 */
async function stageBigRepo(a: Device): Promise<{ source: string; tree: number; git: number; files: number }> {
  await a.exec(["rm", "-rf", BIG_STAGING], { allowFail: true });
  const clone = await a.exec(["sh", "-c", `timeout 180 git clone --depth 1 ${BIG_REPO_URL} '${BIG_STAGING}'`], { allowFail: true });
  let source: string;
  if (clone.exitCode === 0 && (await gitHead(a, BIG_STAGING)) !== "") {
    // Re-init the cloned working tree as a non-shallow snapshot (rbox refuses shallow).
    source = `${BIG_REPO_URL} (depth-1 tree, re-init'd non-shallow snapshot)`;
    await a.exec(["sh", "-c", `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-06-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-06-01T00:00:00 +0000'
cd '${BIG_STAGING}'
rm -rf .git
git init -q -b main
git ${IDENT} add -A
git ${IDENT} commit -q -m 'opencode snapshot'`]);
  } else {
    // Offline fallback: a few hundred small files + two ~20MB binary blobs = a real burst.
    source = "synthesized (clone unavailable — offline)";
    await a.exec(["rm", "-rf", BIG_STAGING], { allowFail: true });
    await a.exec(["sh", "-c", `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-06-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-06-01T00:00:00 +0000'
mkdir -p '${BIG_STAGING}'/src; cd '${BIG_STAGING}'
git init -q -b main
i=1; while [ $i -le 400 ]; do printf 'file %s\\n' "$i" > "src/f$i.txt"; i=$((i+1)); done
head -c 20000000 /dev/urandom > blob1.bin
head -c 20000000 /dev/urandom > blob2.bin
git ${IDENT} add -A && git ${IDENT} commit -q -m 'synthesized big repo'`]);
  }
  const [tree, git, files] = await Promise.all([treeBytes(a, BIG_STAGING), duBytes(a, `${BIG_STAGING}/.git`), fileCount(a, BIG_STAGING)]);
  return { source, tree, git, files };
}

const mb = (n: number) => (n / 1e6).toFixed(1) + "MB";

export const gitCommitPropagation: Scenario = {
  name: "git-commit-propagation",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const repoDir = `${GUEST.workDir}/${REPO}`;
    const smallRepoDir = `${GUEST.workDir}/${SMALL_REPO}`;
    const bigRepoDir = `${GUEST.workDir}/${BIG_REPO}`;

    try {
      // git-sync ON (the default). `afterSeedA` builds the repo before `init --new`, so the
      // first-sync push captures it; B's join pull materializes it on B.
      await provisionPair(ctx, rec, { afterSeedA: buildRepo });

      await rec.step("baseline: repo present + converged on both hosts", async () => {
        const [ha, hb] = await Promise.all([gitHead(ctx.a, repoDir), gitHead(ctx.b, repoDir)]);
        rec.assert("A repo HEAD readable", ha !== "", ha.slice(0, 12) || "(unreadable)");
        rec.assert("B has the repo at A's HEAD (first sync landed)", ha !== "" && ha === hb, `A=${ha.slice(0, 12)} B=${hb.slice(0, 12) || "(none)"}`);
      });

      // Daemons up on BOTH hosts — the live watch/notify propagation loop under test.
      const modes = await startDaemons(ctx, rec, { RBOX_TRACE_PROPAGATION: "1" });
      ctx.log(`  (watcher modes — A: ${modes.a}, B: ${modes.b})`);
      ctx.log(`  clock-skew bound A↔B: ≤${RIG_CLOCK_SKEW_BOUND_MS}ms (shared Docker-host clock)`);

      // ── 1. working-tree commit (existing repo) — fast path fires with or without 172 ──
      await rec.step("[A→B] working-tree commit propagates fast", async () => {
        await commitRound(ctx, rec, "working-tree", REPO, repoDir, "file",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-04-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-04-01T00:00:00 +0000'
cd '${repoDir}'
printf 'r1\\n' > tracked-r1.txt
git ${IDENT} add tracked-r1.txt && git ${IDENT} commit -q -m 'working-tree commit'`);
      });

      // ── 2. empty commit (existing repo) — the design-172 event-driven case (.git only) ──
      await rec.step("[A→B] empty commit propagates fast (design 172)", async () => {
        await commitRound(ctx, rec, "empty-commit", REPO, repoDir, "git",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-04-02T00:00:00 +0000' GIT_COMMITTER_DATE='2026-04-02T00:00:00 +0000'
cd '${repoDir}'
git ${IDENT} commit --allow-empty -q -m 'design-172 empty commit'`);
      });

      // ── 3. tracked-file edit, NO commit — plain-file path (regression: 172 didn't break it) ──
      await rec.step("[A→B] tracked-file edit (no commit) propagates as a file", async () => {
        const head = await gitHead(ctx.a, repoDir); // HEAD before the edit — must match on B after
        await filePlaneRound(ctx, rec, "file-edit-no-commit", `${repoDir}/a.txt`, "one\nedit-no-commit\n", { repoDir, wantHead: head });
      });

      // ── 4. loose file outside any repo — plain-file control ──
      await rec.step("[A→B] loose file outside any repo propagates", async () => {
        await filePlaneRound(ctx, rec, "loose-file", `${GUEST.workDir}/loose-outside-repo.txt`, "not in any git repo\n");
      });

      // ── 5. SMALL new repo created AFTER daemon start + working-tree commit ──
      // Diagnostic setup: a handful of tiny files (NOT a big clone) so there is no inotify
      // burst. Its working-tree commit should be event-driven (the plain files fire events).
      await rec.step("[A→B] small new repo (post-daemon) working-tree commit propagates fast", async () => {
        await commitRound(ctx, rec, "small-repo-worktree", SMALL_REPO, smallRepoDir, "file",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-05-10T00:00:00 +0000' GIT_COMMITTER_DATE='2026-05-10T00:00:00 +0000'
mkdir -p '${smallRepoDir}'
cd '${smallRepoDir}'
git init -q -b main
printf 'x\\n' > one.txt; printf 'y\\n' > two.txt; printf 'z\\n' > three.txt
git ${IDENT} add -A && git ${IDENT} commit -q -m 'first commit in a small post-daemon repo'`);
      });

      // ── 6. EMPTY commit in the small new repo — design 175 side-channel gate ──
      await rec.step("[A→B] small new repo empty commit propagates event-driven", async () => {
        await commitRound(ctx, rec, "small-repo-empty", SMALL_REPO, smallRepoDir, "git",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-05-11T00:00:00 +0000' GIT_COMMITTER_DATE='2026-05-11T00:00:00 +0000'
cd '${smallRepoDir}'
git ${IDENT} commit --allow-empty -q -m 'empty commit in a small post-daemon repo'`);
      });

      // ── 7. a genuinely BIG repo appears AFTER the daemon started (throughput burst) ──
      let bigReady = false;
      await rec.step("[A→B] big repo appears in workspace (throughput/burst)", async () => {
        const info = await stageBigRepo(ctx.a);
        ctx.log(`  big repo — source: ${info.source} · tree ${mb(info.tree)} · .git ${mb(info.git)} · ${info.files} files`);
        // Fence + atomic move-in: the whole repo appears in the workspace as one unit.
        const changeAt = Date.now();
        await ctx.a.exec(["sh", "-c", `mv '${BIG_STAGING}' '${bigRepoDir}'`]);
        const aHead = await gitHead(ctx.a, bigRepoDir);
        if (!aHead) throw new Error("A big-repo HEAD unreadable after move-in");
        // Converge = B has A's HEAD (git plane) AND B's working-tree bytes match (file plane).
        const out = await pollUntil({
          probe: async () => ({ h: await gitHead(ctx.b, bigRepoDir), t: await treeBytes(ctx.b, bigRepoDir) }),
          done: (v) => v.h === aHead && v.t === info.tree,
          timeoutMs: BIG_REPO_TIMEOUT_MS,
          intervalMs: BIG_POLL_MS,
        });
        const elapsedMs = Date.now() - changeAt;
        bigReady = out.ok;
        rec.assert("[big-repo-appears] B converged (HEAD + working tree)", out.ok,
          out.ok ? `${(elapsedMs / 1000).toFixed(1)}s · ${mb(info.tree)} tree + ${mb(info.git)} .git · ${info.files} files` : `timeout ${(elapsedMs / 1000).toFixed(1)}s — B HEAD ${out.value.h.slice(0, 12) || "(none)"} tree ${mb(out.value.t)} want ${mb(info.tree)}`);
        // REPORT the appearance-detection nature (soft — a move-in may be scan-bound even with 172).
        const shape = captureShape(linesSince(await readLogs(ctx.a), changeAt), BIG_REPO);
        ctx.log(`  big-repo appearance detection: ${!shape.captured ? "no capture in window" : shape.eventDriven ? "event-driven (no safety scan before capture)" : "SCAN-BOUND (safety scan before capture)"}`);
        rec.assert("[big-repo-appears] A captured the new repo", shape.captured, shape.captured ? shape.line : "no capture seen in window");
      });

      // ── 8. working-tree commit in the big NEW repo — post-daemon-repo commit detection ──
      await rec.step("[A→B] big-repo working-tree commit propagates fast", async () => {
        if (!bigReady) { ctx.log("  (skip: big repo did not converge)"); return; }
        await commitRound(ctx, rec, "big-repo-worktree", BIG_REPO, bigRepoDir, "file",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-05-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-05-01T00:00:00 +0000'
cd '${bigRepoDir}'
printf 'rig note\\n' > rig-note.txt
git ${IDENT} add rig-note.txt && git ${IDENT} commit -q -m 'working-tree commit in the post-daemon repo'`);
      });

      // ── 9. empty commit in the big NEW repo — design 175 atomic move-in gate ──
      await rec.step("[A→B] big-repo empty commit propagates event-driven", async () => {
        if (!bigReady) { ctx.log("  (skip: big repo did not converge)"); return; }
        await commitRound(ctx, rec, "big-repo-empty", BIG_REPO, bigRepoDir, "git",
          `set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com' GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-05-02T00:00:00 +0000' GIT_COMMITTER_DATE='2026-05-02T00:00:00 +0000'
cd '${bigRepoDir}'
git ${IDENT} commit --allow-empty -q -m 'empty commit in the post-daemon repo'`);
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
