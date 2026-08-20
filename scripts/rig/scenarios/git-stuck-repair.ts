/**
 * `git-stuck-repair` (design 280 §2 — the hard gate that FALSIFIED the resolve
 * offer, and now the regression pin for its absence).
 *
 * Design 280 proposed offering `rbox git resolve … take-theirs` to the
 * connectivity sub-class of the `artifact` pause, on the theory that re-staging
 * the incoming artifacts re-fetches the objects a broken repository cannot
 * reach. This scenario ran that theory on live devices on 2026-08-20 and it is
 * FALSE: `stageIncoming` re-fetches only the incoming section's bundle and
 * packChain window, so an object broken BELOW that window is never restored,
 * and the connectivity proof inside take-theirs' own transaction correctly
 * refuses with `{status: refused, code: operation-failed}`. The offer was
 * withdrawn. Both rounds now assert the SAME product truth: rbox has no remedy
 * for either `artifact` sub-class, so it offers none and refuses cleanly.
 *
 *   ROUND connectivity — B's object database loses one object that no incoming
 *   bundle re-supplies, so the checkout transaction's planned-graph proof RUNS
 *   and fails. The deferral carries reason `artifact` and the durable typed code
 *   `connectivity-unproven` (the honest classification, which no surface acts
 *   on). take-theirs must REFUSE cleanly and the pause must SURVIVE: nothing
 *   half-applied, no conflict ref, the workspace untouched.
 *
 *   ROUND fetch-failure — B cannot even stage the incoming artifacts: a regular
 *   file sits where `stageIncoming` must mkdir its staging directory, so the
 *   follow throws into follow.ts's fetch/decrypt/import catch. That is the OTHER
 *   producer of reason `artifact`, and it mints no typed code. Same outcome: no
 *   command offered, clean refusal, only the known quarantine-bundle litter,
 *   never a conflict ref.
 *
 * Both rounds assert GIT-plane cleanliness only. Ordinary working-tree files are
 * expected to keep arriving throughout: the plain-file channel is independent of
 * the git lane (designs 28/43), and each round pins that the sender's file DID
 * land while its git lane stayed paused. Treating those files as residue is what
 * made the first run report a false failure.
 *
 * Both rounds observe rows that are YOUNG — a rig cannot age a cause past the
 * 24h escalation floor. The escalation clock is pinned in unit tests
 * (git-stories.test.ts); what only a live fleet could answer is whether a remedy
 * does what it claims, and that is what this scenario asked and answered.
 *
 * MANUAL / explicit-only: NOT in FAST_SUITE. It mutates a device's object store,
 * runs two propagation rounds, and drives a real mutating resolve verb.
 */
import { GUEST } from "../lib/config.js";
import { pollUntil } from "../lib/waiters.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import type { Recorder } from "./harness.js";
import { provisionPair, startDaemons, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const CONNECTIVITY_REPO = "repo-280-connectivity";
const FETCH_REPO = "repo-280-fetch";
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;
const PROPAGATE_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;

const detScript = (body: string): string => `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }
${body}`.replace(/git /g, `git ${IDENT} `);

const repoDir = (repo: string): string => `${GUEST.workDir}/${repo}`;

/** main (2 commits) plus an unrelated `archive` branch with its own root. The
 *  archive root's TREE is what round 1 removes: the commit walk still succeeds,
 *  so classification is clean and only the connectivity fence can see the gap. */
async function seedConnectivityRepo(a: Device): Promise<void> {
  await a.exec(["sh", "-c", detScript(`
mkdir -p '${repoDir(CONNECTIVITY_REPO)}'
cd '${repoDir(CONNECTIVITY_REPO)}'
git init -q -b main
printf 'one\\n' > a.txt
D 2026-01-01; git add a.txt && git commit -q -m 'commit 1'
printf 'two\\n' > b.txt
D 2026-01-02; git add b.txt && git commit -q -m 'commit 2'
git checkout -q --orphan archive
git rm -q -rf . >/dev/null 2>&1 || true
printf 'archived one\\n' > archive.txt
D 2026-01-03; git add archive.txt && git commit -q -m 'archive root'
printf 'archived two\\n' > archive.txt
D 2026-01-04; git commit -qam 'archive tip'
git checkout -q main
`)]);
}

async function seedFetchRepo(a: Device): Promise<void> {
  await a.exec(["sh", "-c", detScript(`
mkdir -p '${repoDir(FETCH_REPO)}'
cd '${repoDir(FETCH_REPO)}'
git init -q -b main
printf 'one\\n' > a.txt
D 2026-02-01; git add a.txt && git commit -q -m 'commit 1'
`)]);
}

/** Rewrite packed objects as loose ones and delete the archive root's tree —
 *  the only way to reproduce an object database incomplete BELOW the ref plane. */
async function breakConnectivity(b: Device): Promise<void> {
  await b.exec(["sh", "-c", `
set -e
cd '${repoDir(CONNECTIVITY_REPO)}'
for pack in .git/objects/pack/*.pack; do
  [ -e "$pack" ] || continue
  mv "$pack" /tmp/$(basename "$pack")
  rm -f "\${pack%.pack}.idx"
  git unpack-objects < /tmp/$(basename "$pack") >/dev/null 2>&1
done
tree=$(git rev-parse 'refs/heads/archive~1^{tree}')
rm -f ".git/objects/\${tree%\${tree#??}}/\${tree#??}"
`]);
}

async function gitHead(dev: Device, repo: string): Promise<string> {
  const r = await dev.exec(["git", "-C", repoDir(repo), "rev-parse", "HEAD"], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function conflictRefCount(dev: Device, repo: string): Promise<number> {
  const r = await dev.exec(["sh", "-c", `git -C '${repoDir(repo)}' for-each-ref refs/rbox-conflict | wc -l`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

interface DeferralRow {
  repo: string;
  reason: string;
  story: string;
  needsYou: boolean;
  stuck: boolean;
}

/** The scriptable twin of the human listing: one JSON object on stdout. */
async function deferralRow(dev: Device, repo: string): Promise<DeferralRow | undefined> {
  const run = await dev.rbox(["git", "deferrals", "--json"], { cwd: GUEST.workDir, allowFail: true });
  const line = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  if (!line) return undefined;
  const parsed = JSON.parse(line) as { repos?: DeferralRow[] };
  return parsed.repos?.find((row) => row.repo === repo);
}

async function pullUntilDeferred(dev: Device, repo: string): Promise<DeferralRow | undefined> {
  let row: DeferralRow | undefined;
  const out = await pollUntil({
    probe: async () => {
      await dev.rbox(["pull"], { cwd: GUEST.workDir, allowFail: true });
      row = await deferralRow(dev, repo);
      return row?.reason;
    },
    done: (v) => v === "artifact",
    timeoutMs: PROPAGATE_TIMEOUT_MS,
    intervalMs: POLL_MS,
  });
  return out.ok ? row : row;
}

interface ResolveJson {
  status?: string;
  code?: string;
  message?: string;
  snapshot?: string;
}

async function resolve(dev: Device, repo: string, verb: string, extra: string[] = []): Promise<{ json: ResolveJson; raw: string }> {
  const run = await dev.rbox(["git", "resolve", repo, verb, "--json", ...extra], { cwd: GUEST.workDir, allowFail: true });
  const raw = `${run.stdout}\n${run.stderr}`;
  const line = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  let json: ResolveJson = {};
  try {
    if (line) json = JSON.parse(line) as ResolveJson;
  } catch {
    /* the raw streams carry the verdict for the assertion message */
  }
  return { json, raw };
}

async function porcelain(dev: Device, repo: string): Promise<string> {
  const r = await dev.exec(["sh", "-c",
    `cd '${repoDir(repo)}' && git status --porcelain=v1 --untracked-files=all | head -40`], { allowFail: true });
  return r.stdout.trim();
}

/**
 * GIT-plane residue only. Ordinary working-tree files are NOT residue here: the
 * plain-file channel keeps delivering while the git lane defers (designs 28/43's
 * two-channel split), so a repo paused on its git lane legitimately shows the
 * sender's files as untracked. The only thing rbox itself may leave behind in
 * this repo is its quarantine bundle under `.rbox/git-quarantine/`.
 */
async function gitPlaneResidue(dev: Device, repo: string): Promise<string[]> {
  return (await porcelain(dev, repo))
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry.startsWith(".rbox/") && !entry.startsWith(".rbox/git-quarantine/"));
}

/** Every ref and the oid it points at — the evidence that nothing half-applied. */
async function refSnapshot(dev: Device, repo: string): Promise<string> {
  const r = await dev.exec(["sh", "-c",
    `git -C '${repoDir(repo)}' for-each-ref --format='%(refname) %(objectname)' | sort`], { allowFail: true });
  return r.stdout.trim();
}

/** rbox's own scratch/conflict namespaces: any survivor is git-plane litter. */
async function rboxRefCount(dev: Device, repo: string): Promise<number> {
  const r = await dev.exec(["sh", "-c",
    `git -C '${repoDir(repo)}' for-each-ref 'refs/rbox-*' | wc -l`], { allowFail: true });
  const n = Number(r.stdout.trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : -1;
}

async function fileExists(dev: Device, repo: string, rel: string): Promise<boolean> {
  return (await dev.exec(["test", "-f", `${repoDir(repo)}/${rel}`], { allowFail: true })).exitCode === 0;
}

/**
 * What actually happened, recorded BEFORE anything is asserted. A round that
 * fails with `row=null` tells nobody why; this puts the raw deferral JSON, the
 * pull output and the repo's daemon-log lines in the report next to the verdict.
 */
async function diagnose(ctx: RigCtx, dev: Device, repo: string, label: string): Promise<void> {
  const json = await dev.rbox(["git", "deferrals", "--json"], { cwd: GUEST.workDir, allowFail: true });
  const pull = await dev.rbox(["pull", "--verbose"], { cwd: GUEST.workDir, allowFail: true });
  const log = await dev.readDaemonLogs(GUEST.rboxHome).catch(() => "");
  const repoLines = log.split("\n").filter((line) => line.includes(repo)).slice(-12).join("\n");
  ctx.log(`[diagnose ${label}] deferrals --json: ${json.stdout.trim().slice(-1200) || "(empty)"}`);
  ctx.log(`[diagnose ${label}] pull --verbose: ${(pull.stdout + pull.stderr).trim().slice(-1200) || "(empty)"}`);
  ctx.log(`[diagnose ${label}] daemon log for ${repo}: ${repoLines || "(no lines)"}`);
  ctx.log(`[diagnose ${label}] working tree: ${(await porcelain(dev, repo)) || "(clean)"}`);
}

export const gitStuckRepair: Scenario = {
  name: "git-stuck-repair",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const rec: Recorder = createRecorder(ctx);
    const startedAt = new Date().toISOString();
    try {
      await rec.step("[A] seed both repos", async () => {
        await seedConnectivityRepo(ctx.a);
        await seedFetchRepo(ctx.a);
      });
      await provisionPair(ctx, rec);
      await startDaemons(ctx, rec);

      const seededHead = await gitHead(ctx.a, CONNECTIVITY_REPO);
      await rec.step("[B] converges on both repos", async () => {
        const out = await pollUntil({
          probe: async () => (await gitHead(ctx.b, CONNECTIVITY_REPO)) === seededHead
            && (await gitHead(ctx.b, FETCH_REPO)) !== "",
          done: (v) => v === true,
          timeoutMs: PROPAGATE_TIMEOUT_MS,
          intervalMs: POLL_MS,
        });
        if (!out.ok) throw new Error("B never converged on the seeded repos");
      });

      // ── ROUND connectivity ────────────────────────────────────────────────
      await rec.step("[B] stop daemon and break the object database", async () => {
        await ctx.b.daemonStop(GUEST.workDir);
        await breakConnectivity(ctx.b);
      });
      let advancedHead = "";
      await rec.step("[A] advances main and publishes", async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir(CONNECTIVITY_REPO)}'
printf 'three\\n' > c.txt
D 2026-01-05; git add c.txt && git commit -q -m 'commit 3'
`)]);
        advancedHead = await gitHead(ctx.a, CONNECTIVITY_REPO);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, allowFail: true });
      });

      const broken = await rec.step("[B] pull defers on the connectivity proof",
        () => pullUntilDeferred(ctx.b, CONNECTIVITY_REPO));
      rec.assert("connectivity: the pause tells the self-healing story",
        broken?.reason === "artifact" && broken?.story === "sync-download-failed",
        `row=${JSON.stringify(broken ?? null)}`);
      rec.assert("connectivity: a young pause is not escalated",
        broken?.stuck === false && broken?.needsYou === false,
        `row=${JSON.stringify(broken ?? null)}`);

      const brokenListing = await rec.step("[B] the human listing offers no command", async () => {
        const run = await ctx.b.rbox(["status", "--git", "--all"], { cwd: GUEST.workDir, allowFail: true });
        return `${run.stdout}\n${run.stderr}`;
      });
      rec.assert("connectivity: no resolve command is offered for a repo rbox cannot repair",
        !brokenListing.includes("rbox git resolve"),
        `listing tail: ${brokenListing.trim().slice(-600)}`);

      const evidence = await rec.step("[B] show-me reads the broken repo", () => resolve(ctx.b, CONNECTIVITY_REPO, "show-me"));
      const snapshot = evidence.json.snapshot;
      rec.assert("connectivity: show-me still reads the repo without changing it",
        (snapshot ?? "").length > 0,
        `status=${evidence.json.status} ${evidence.raw.trim().slice(-400)}`);

      const headBeforeResolve = await gitHead(ctx.b, CONNECTIVITY_REPO);
      const refsBeforeResolve = await refSnapshot(ctx.b, CONNECTIVITY_REPO);
      // 2026-08-20: this is the round that falsified design 280's resolve offer.
      // `stageIncoming` re-fetches only the incoming section's bundle/packChain
      // window; an object broken BELOW that window is never restored, so the
      // proof inside take-theirs' own transaction refuses. Forced here anyway,
      // because "refuses cleanly" is now the product promise this pins.
      const forcedRepair = await rec.step("[B] a forced take-theirs cannot repair below-window damage",
        () => resolve(ctx.b, CONNECTIVITY_REPO, "take-theirs", ["--confirm", snapshot ?? "missing"]));
      rec.assert("connectivity: take-theirs refuses instead of half-applying",
        forcedRepair.json.status === "refused" && forcedRepair.json.code === "operation-failed",
        `status=${forcedRepair.json.status} code=${forcedRepair.json.code ?? "-"} ${forcedRepair.raw.trim().slice(-400)}`);

      const survivingRow = await rec.step("[B] the pause survives the refusal", async () => {
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, allowFail: true });
        return deferralRow(ctx.b, CONNECTIVITY_REPO);
      });
      rec.assert("connectivity: the repo stays paused on the same cause",
        survivingRow?.reason === "artifact",
        `row=${JSON.stringify(survivingRow ?? null)}`);
      rec.assert("connectivity: the refusal moved nothing — head stays behind",
        (await gitHead(ctx.b, CONNECTIVITY_REPO)) === headBeforeResolve
          && headBeforeResolve !== advancedHead,
        `head=${(await gitHead(ctx.b, CONNECTIVITY_REPO)).slice(0, 8)} before=${headBeforeResolve.slice(0, 8)} A=${advancedHead.slice(0, 8)}`);
      rec.assert("connectivity control: no conflict refs minted",
        (await conflictRefCount(ctx.b, CONNECTIVITY_REPO)) === 0,
        "a refused take-theirs must not mint refs/rbox-conflict/*");
      rec.assert("connectivity control: no half-applied ref moves",
        (await refSnapshot(ctx.b, CONNECTIVITY_REPO)) === refsBeforeResolve,
        "every ref must point where it did before the refusal");
      rec.assert("connectivity control: no rbox scratch refs survive",
        (await rboxRefCount(ctx.b, CONNECTIVITY_REPO)) === 0,
        "refs/rbox-* is transport scaffolding and must not outlive a refused resolve");
      const brokenResidue = await gitPlaneResidue(ctx.b, CONNECTIVITY_REPO);
      rec.assert("connectivity control: no git-plane litter outside the quarantine",
        brokenResidue.length === 0,
        `unexpected rbox residue: ${brokenResidue.join(", ")} (full status: ${await porcelain(ctx.b, CONNECTIVITY_REPO)})`);
      // The two-channel split (designs 28/43) is a FEATURE here, not residue:
      // the plain-file channel keeps delivering while the git lane is paused, so
      // A's c.txt must be on disk even though B's git lane never applied the
      // commit that introduced it. Asserting its presence proves the split held
      // through the refusal instead of quietly stalling both channels.
      rec.assert("connectivity control: file sync kept delivering during the git-lane pause",
        await fileExists(ctx.b, CONNECTIVITY_REPO, "c.txt"),
        "c.txt is delivered by the plain-file channel and must arrive even while the git lane defers");

      // ── ROUND fetch-failure ───────────────────────────────────────────────
      // `stageIncoming` mkdirs `<repo>/.rbox` and mkdtemps its staging dir there
      // BEFORE fetching or importing anything (follow-staging.ts:66-67). Parking
      // a regular FILE on that path makes the mkdir fail, so the follow throws
      // out of stageIncoming and lands in follow.ts's catch — the exact
      // fetch/decrypt/import arm, reason `artifact`, no typed code.
      //
      // Deliberately NOT a chmod: the guest may run as root, and root ignores
      // DAC write bits (the same reason checkout-txn.test.ts skips its
      // permission cases under uid 0). A path-type conflict is refused for every
      // uid. It also leaves .git untouched, so no other reason can win the race
      // and mislabel this round.
      await rec.step("[B] make the staging directory impossible to create", async () => {
        await ctx.b.exec(["sh", "-c",
          `rm -rf '${repoDir(FETCH_REPO)}/.rbox' && printf 'not-a-directory' > '${repoDir(FETCH_REPO)}/.rbox'`]);
      });
      await rec.step("[A] advances the fetch-failure repo and publishes", async () => {
        await ctx.a.exec(["sh", "-c", detScript(`
cd '${repoDir(FETCH_REPO)}'
printf 'two\\n' > b.txt
D 2026-02-02; git add b.txt && git commit -q -m 'commit 2'
`)]);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, allowFail: true });
      });

      const unimportable = await rec.step("[B] pull cannot stage the incoming artifacts",
        () => pullUntilDeferred(ctx.b, FETCH_REPO));
      // Evidence BEFORE the verdict: if the injection missed, the report says
      // what the pull actually produced instead of an unexplained `row=null`.
      await rec.step("[B] record what the failed import actually produced",
        () => diagnose(ctx, ctx.b, FETCH_REPO, "fetch-failure"));
      rec.assert("fetch-failure: the same artifact pause, no repair claim",
        unimportable?.reason === "artifact",
        `expected an artifact-class defer for ${FETCH_REPO}; row=${JSON.stringify(unimportable ?? null)} — see the [diagnose fetch-failure] lines above for the deferrals JSON, the pull output and the daemon log`);

      const listing = await rec.step("[B] the human listing withholds the command", async () => {
        const run = await ctx.b.rbox(["status", "--git", "--all"], { cwd: GUEST.workDir, allowFail: true });
        return `${run.stdout}\n${run.stderr}`;
      });
      // The gate reads the durable typed code, which this sub-class never mints.
      rec.assert("fetch-failure: no resolve command is offered",
        !listing.includes("rbox git resolve"),
        `listing tail: ${listing.trim().slice(-600)}`);

      const forced = await rec.step("[B] a forced take-theirs refuses cleanly", async () => {
        const shown = await resolve(ctx.b, FETCH_REPO, "show-me");
        return resolve(ctx.b, FETCH_REPO, "take-theirs", ["--confirm", shown.json.snapshot ?? "missing"]);
      });
      rec.assert("fetch-failure: take-theirs dead-ends instead of half-applying",
        forced.json.status !== "published" && forced.json.status !== "applied",
        `status=${forced.json.status} code=${forced.json.code ?? "-"} ${forced.raw.trim().slice(-400)}`);

      rec.assert("fetch-failure control: no conflict refs minted",
        (await conflictRefCount(ctx.b, FETCH_REPO)) === 0,
        "a refused take-theirs must not mint refs/rbox-conflict/*");
      rec.assert("fetch-failure control: no rbox scratch refs survive",
        (await rboxRefCount(ctx.b, FETCH_REPO)) === 0,
        "refs/rbox-* is transport scaffolding and must not outlive a refused resolve");

      // Inspected with the blocker still in place, so this reads the real
      // post-refusal state rather than a tidied one. The injected `.rbox` FILE is
      // the blocker, not residue — `gitPlaneResidue` looks under `.rbox/`, which
      // a regular file at that path cannot have.
      const fetchResidue = await gitPlaneResidue(ctx.b, FETCH_REPO);
      rec.assert("fetch-failure control: no git-plane litter outside the quarantine",
        fetchResidue.length === 0,
        `unexpected rbox residue: ${fetchResidue.join(", ")} (full status: ${await porcelain(ctx.b, FETCH_REPO)})`);
      // Same two-channel expectation as round one: b.txt rides the plain-file
      // channel and must arrive even though the git lane never imported it.
      rec.assert("fetch-failure control: file sync kept delivering during the git-lane pause",
        await fileExists(ctx.b, FETCH_REPO, "b.txt"),
        "b.txt is delivered by the plain-file channel and must arrive even while the git lane defers");

      await rec.step("[B] remove the staging blocker", async () => {
        await ctx.b.exec(["sh", "-c", `rm -f '${repoDir(FETCH_REPO)}/.rbox'`], { allowFail: true });
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await ctx.b.daemonStop(GUEST.workDir).catch(() => {});
    }
    return finalizeReport({ scenario: gitStuckRepair.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
