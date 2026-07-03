/**
 * `git-entanglement` (design 56 §9) — the design-43 regression net. Sync must NEVER
 * corrupt or entangle real git state across devices. We build TWO real git repos on A
 * (a top-level dir-repo with branches/tags/dirty-worktree, and a nested dir-repo), sync
 * A→B with git-sync ON (the default — §28), and assert git-LEVEL integrity on B: fsck
 * clean, HEAD + every ref + the commit log byte-identical to A, and the two repos stay
 * INDEPENDENT (the nested repo's refs/HEAD converge too — no cross-repo bleed). Then a
 * branch-switch churn round (A → feature + 1 commit → push; B pull) re-asserts.
 *
 * How git state transfers (design 28 + 43): `.git/` is HARD-EXCLUDED from plain-file
 * sync (src/engine/ignore.ts ALWAYS_NATIVE_PRUNE) — it can never ride the file manifest.
 * Instead each repo's history/refs/HEAD/index/op-state travel as E2EE-encrypted `git
 * bundle` artifacts referenced from the manifest's `gitRepos` map (`manifestSchema: 2`,
 * one GitSection per repo). So the manifest convergence check at the end covers the
 * PLAIN files; the git assertions cover the GIT state — two disjoint transfer channels.
 *
 * Dirty/untracked-file semantics (PINNED from the design docs):
 * - A tracked file MODIFIED-but-uncommitted and an UNTRACKED file are ordinary working-
 *   tree files → they sync through the PLAIN-FILE path like any other file (design 43
 *   §1/§7: "its files are already synced as plain files; its git state is its own").
 * - The captured `.git/index` is A's index verbatim (src/engine/git/capture.ts:57) and is
 *   restored on B (apply.ts:286). A's uncommitted modification is NOT staged, so A's index
 *   still holds the committed blob for that path; B restores that same index. B's working
 *   file carries A's modified content (plain-file sync). So on B the file reads as
 *   modified-not-staged and the untracked file as untracked — i.e. `git status --porcelain`
 *   is IDENTICAL across A and B. This is exactly design 43 §12's e2e contract
 *   ("git fsck clean, git log/status/stash list match"). We assert that identity.
 */
import { GUEST } from "../lib/config.js";
import { fingerprintTree } from "../lib/convergence.js";
import { diffRefLines, parseForEachRef, refDiffDetail } from "../lib/git-refs.js";
import {
  canonicalManifest,
  compareManifests,
  diskCheckDetail,
  findUnsyncedExtras,
  manifestDiffDetail,
  parseManifestState,
  verifyManifestOnDisk,
} from "../lib/manifest-check.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { Recorder } from "./harness.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Repo relPaths under the workspace (the `gitRepos` manifest keys they become). */
const TOP = "repo-top";
const INNER = "nested/deeper/repo-inner";

/** Deterministic git identity so every rerun mints byte-identical commit/tag shas. */
const IDENT = `-c user.name='Rig Tester' -c user.email='rig@example.com'`;

/**
 * Build the two real git repos on A, fully deterministically (fixed author+committer
 * identity AND dates via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE), so reruns produce stable
 * shas. `repo-top`: 3 commits on main, a `feature` branch (+1 commit), an annotated tag
 * `v1`, a tracked file modified-but-uncommitted (dirty worktree) + an untracked file.
 * `nested/deeper/repo-inner`: 2 commits, single branch.
 */
async function buildGitRepos(a: Device): Promise<void> {
  const ws = GUEST.workDir;
  // One commit = set the two date envs then commit. `git tag -a` taggers use
  // GIT_COMMITTER_DATE + the -c identity, so the annotated tag is deterministic too.
  const script = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
D() { export GIT_AUTHOR_DATE="$1T00:00:00 +0000" GIT_COMMITTER_DATE="$1T00:00:00 +0000"; }

# ---- repo-top (dir-repo: branches + annotated tag + dirty worktree) ----
mkdir -p '${ws}/${TOP}'
cd '${ws}/${TOP}'
git init -q -b main
printf 'one\\n' > a.txt
D 2026-01-01; git add a.txt && git commit -q -m 'commit 1'
printf 'two\\n' > b.txt
D 2026-01-02; git add b.txt && git commit -q -m 'commit 2'
printf 'three\\n' >> a.txt
D 2026-01-03; git add a.txt && git commit -q -m 'commit 3'
git checkout -q -b feature
printf 'feat\\n' > feature.txt
D 2026-01-04; git add feature.txt && git commit -q -m 'feature commit'
git checkout -q main
D 2026-01-05; git tag -a v1 -m 'release v1'
# dirty worktree: modify a tracked file WITHOUT committing (uncommitted change) ...
printf 'dirty-uncommitted\\n' >> a.txt
# ... plus an untracked file (both are plain-file-sync territory)
printf 'untracked-content\\n' > untracked.txt

# ---- nested/deeper/repo-inner (independent dir-repo, single branch) ----
mkdir -p '${ws}/${INNER}'
cd '${ws}/${INNER}'
git init -q -b main
printf 'x\\n' > x.txt
D 2026-02-01; git add x.txt && git commit -q -m 'inner 1'
printf 'y\\n' > y.txt
D 2026-02-02; git add y.txt && git commit -q -m 'inner 2'
`;
  await a.exec([`sh`, `-c`, script.replace(/git /g, `git ${IDENT} `)]);
}

/** Run `git -C repoDir <args>` in the guest, tolerating nonzero exit (caller inspects). */
async function gitExec(dev: Device, repoDir: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await dev.exec(["git", "-C", repoDir, ...args], { allowFail: true });
  return { code: r.exitCode, out: r.stdout, err: r.stderr };
}

/** The identity fields of a repo, gathered from ONE device for A-vs-B comparison. */
interface RepoState {
  fsckCode: number;
  headSymbolic: string; // `git symbolic-ref -q HEAD` (empty = detached)
  headSha: string;
  refs: string; // raw `for-each-ref` output (objectname refname)
  logMain: string; // `git log --format=%H refs/heads/main` (empty if main absent)
  status: string; // `git status --porcelain`
}

async function readRepoState(dev: Device, repoDir: string): Promise<RepoState> {
  const [fsck, sym, head, refs, log, status] = await Promise.all([
    gitExec(dev, repoDir, ["fsck", "--strict", "--no-progress"]),
    gitExec(dev, repoDir, ["symbolic-ref", "-q", "HEAD"]),
    gitExec(dev, repoDir, ["rev-parse", "HEAD"]),
    gitExec(dev, repoDir, ["for-each-ref", "--format=%(objectname) %(refname)"]),
    gitExec(dev, repoDir, ["log", "--format=%H", "refs/heads/main"]),
    gitExec(dev, repoDir, ["status", "--porcelain"]),
  ]);
  return {
    fsckCode: fsck.code,
    headSymbolic: sym.out.trim(),
    headSha: head.out.trim(),
    refs: refs.out,
    logMain: log.code === 0 ? log.out.trim() : "",
    status: status.out,
  };
}

/**
 * Assert B's git state matches A's for one repo: fsck clean, HEAD (symbolic + sha)
 * equal, ref set (branches + tags) equal, main log equal. `label` prefixes each
 * assertion so a per-repo failure is unambiguous. Does NOT assert status (that's
 * repo-top-only, done separately).
 */
function assertRepoConverged(rec: Recorder, label: string, a: RepoState, b: RepoState): void {
  rec.assert(`[${label}] B fsck --strict clean`, b.fsckCode === 0, b.fsckCode === 0 ? "exit 0" : `fsck exit ${b.fsckCode}`);
  rec.assert(`[${label}] HEAD symbolic-ref equal A/B`, a.headSymbolic === b.headSymbolic && a.headSymbolic !== "", `A=${a.headSymbolic || "(detached)"} B=${b.headSymbolic || "(detached)"}`);
  rec.assert(`[${label}] HEAD sha equal A/B`, a.headSha === b.headSha && a.headSha !== "", `A=${a.headSha.slice(0, 12)} B=${b.headSha.slice(0, 12)}`);
  const rd = diffRefLines(parseForEachRef(a.refs), parseForEachRef(b.refs));
  rec.assert(`[${label}] for-each-ref byte-identical A/B`, rd.identical, rd.identical ? `${parseForEachRef(b.refs).length} refs match` : refDiffDetail(rd));
  rec.assert(`[${label}] main log (%H) identical A/B`, a.logMain === b.logMain && a.logMain !== "", a.logMain === b.logMain ? `${a.logMain.split("\n").length} commits` : "main log diverged");
}

export const gitEntanglement: Scenario = {
  name: "git-entanglement",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const topA = `${GUEST.workDir}/${TOP}`;
    const innerA = `${GUEST.workDir}/${INNER}`;
    const topB = topA; // same guest-relative path on B
    const innerB = innerA;

    try {
      // Provision with git-sync ON (the DEFAULT — no `--git false`). `afterSeedA` builds
      // both repos after `mkdir workspace` but BEFORE `init --new`, so the first-sync push
      // captures their git state into the manifest's `gitRepos` map.
      await provisionPair(ctx, rec, { afterSeedA: buildGitRepos });

      // Sanity: A's own repos are fsck-clean (a broken build would invalidate the test).
      await rec.step("[A] source repos fsck-clean (build sanity)", async () => {
        const [ft, fi] = await Promise.all([gitExec(ctx.a, topA, ["fsck", "--strict", "--no-progress"]), gitExec(ctx.a, innerA, ["fsck", "--strict", "--no-progress"])]);
        rec.assert("A repo-top fsck clean", ft.code === 0, `exit ${ft.code}`);
        rec.assert("A repo-inner fsck clean", fi.code === 0, `exit ${fi.code}`);
      });

      // ── Assertions on B: git-level integrity per repo (design 43) ──────────────────
      await rec.step("git integrity A vs B (both repos)", async () => {
        const [aTop, bTop, aInner, bInner] = await Promise.all([
          readRepoState(ctx.a, topA),
          readRepoState(ctx.b, topB),
          readRepoState(ctx.a, innerA),
          readRepoState(ctx.b, innerB),
        ]);

        // repo-top: full convergence (branches main+feature, annotated tag v1).
        assertRepoConverged(rec, TOP, aTop, bTop);

        // Dirty/untracked semantics: status IDENTICAL across A/B (see file header +
        // design 43 §12/§5). The modified tracked file + untracked file rode plain-file
        // sync; B restored A's index, so both read the same porcelain status.
        const statusMatch = aTop.status === bTop.status;
        rec.assert(`[${TOP}] git status --porcelain identical A/B (dirty+untracked)`, statusMatch, statusMatch ? `${aTop.status.trim().split("\n").filter(Boolean).length} porcelain lines match` : `A=${JSON.stringify(aTop.status).slice(0, 80)} B=${JSON.stringify(bTop.status).slice(0, 80)}`);
        // And it genuinely carries the dirty mod (` M a.txt`) + untracked (`?? untracked.txt`).
        const hasDirty = /(^|\n)\s?M\s+a\.txt/.test(bTop.status);
        const hasUntracked = /\?\?\s+untracked\.txt/.test(bTop.status);
        rec.assert(`[${TOP}] B carries the uncommitted mod + untracked file`, hasDirty && hasUntracked, `dirty=${hasDirty} untracked=${hasUntracked} · porcelain=${JSON.stringify(bTop.status.trim()).slice(0, 80)}`);

        // repo-inner: INDEPENDENT — its own refs/HEAD/log converge, no cross-repo bleed.
        assertRepoConverged(rec, INNER, aInner, bInner);
      });

      // ── Churn round: A switches repo-top to feature + 1 commit → push; B pull ───────
      await rec.step("[A] churn: checkout feature + commit + push", async () => {
        const churn = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-03-01T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-01T00:00:00 +0000'
cd '${topA}'
git ${IDENT} checkout -q feature
printf 'churn\\n' > churn.txt
git ${IDENT} add churn.txt && git ${IDENT} commit -q -m 'churn commit on feature'
`;
        await ctx.a.exec(["sh", "-c", churn]);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
      });

      await rec.step("[B] pull churn", async () => {
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
      });

      await rec.step("git integrity A vs B after churn (repo-top)", async () => {
        const [aTop, bTop] = await Promise.all([readRepoState(ctx.a, topA), readRepoState(ctx.b, topB)]);
        assertRepoConverged(rec, `${TOP}@churn`, aTop, bTop);
        // HEAD must now be on feature on BOTH sides (the branch switch propagated).
        rec.assert(`[${TOP}@churn] HEAD moved to feature`, bTop.headSymbolic === "refs/heads/feature", `B HEAD=${bTop.headSymbolic || "(detached)"}`);
      });

      // ── Manifest convergence (plain files) — the git channel is asserted above; this
      //    covers the PLAIN-file half (`.git` is fingerprint-pruned, never plain-synced). ──
      await rec.step("synced-set convergence A vs B (manifest ∩ disk)", async () => {
        const statePath = `${GUEST.workDir}/.rbox/state.json`;
        const [stateA, stateB, fpB] = await Promise.all([ctx.a.readFile(statePath), ctx.b.readFile(statePath), fingerprintTree(ctx.b, GUEST.workDir)]);
        const manA = canonicalManifest(parseManifestState(stateA));
        const manB = canonicalManifest(parseManifestState(stateB));

        const diff = compareManifests(manA, manB);
        rec.assert("synced set converged (A manifest == B manifest)", diff.identical, diff.identical ? `${manB.length} entries synced` : manifestDiffDetail(diff));

        const disk = verifyManifestOnDisk(manB, fpB);
        rec.assert("B disk materializes B manifest", disk.ok, disk.ok ? `${manB.length - disk.exemptCount} on-disk, ${disk.exemptCount} pruned-exempt` : diskCheckDetail(disk));

        const extras = findUnsyncedExtras(fpB, manB);
        rec.assert("B has no unsynced extras", extras.length === 0, extras.length === 0 ? `${fpB.fileCount} fingerprinted, all in manifest` : `${extras.length} extras (${extras.slice(0, 5).join(", ")})`);
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: gitEntanglement.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
