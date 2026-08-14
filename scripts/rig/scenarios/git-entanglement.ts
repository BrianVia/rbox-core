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
 * - The captured `.git/index` is A's index verbatim (src/cli/sync-git/capture.ts:57) and is
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
import type { SyncState } from "../../../src/cli/sync-state-model.js";

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

interface RigRepoRecord {
  pending?: unknown;
  partial?: {
    checkoutPending?: boolean;
    heldRefs?: Record<string, string>;
  };
  deferrals?: Record<string, { lane?: string; reason?: string; deferredSince?: string; reasonSince?: string }>;
}

interface RigSyncState {
  lastSyncedSequence?: number;
  gitPendingRemote?: SyncState["gitPendingRemote"];
  gitNeedsResolution?: SyncState["gitNeedsResolution"];
  repoRecords?: Record<string, RigRepoRecord>;
}

async function readSyncState(dev: Device): Promise<RigSyncState> {
  return JSON.parse(await dev.readFile(`${GUEST.workDir}/.rbox/state.json`)) as RigSyncState;
}

function assertRepoSettled(rec: Recorder, label: string, state: RigSyncState): void {
  const record = state.repoRecords?.[TOP];
  const settled = state.gitPendingRemote?.[TOP] === undefined
    && state.gitNeedsResolution?.[TOP] === undefined
    && record?.pending === undefined
    && record?.partial === undefined
    && record?.deferrals?.apply === undefined;
  rec.assert(`[${label}] pending/partial/apply-deferral absent`, settled, settled ? "settled" : JSON.stringify({
    legacyPending: state.gitPendingRemote?.[TOP] !== undefined,
    pending: record?.pending !== undefined,
    partial: record?.partial,
    deferral: record?.deferrals?.apply,
  }));
}

async function assertTrackedFollow(rec: Recorder, label: string, a: Device, b: Device, repoA: string, repoB: string): Promise<void> {
  const opShape = (dev: Device, repo: string) => dev.exec(["sh", "-c", `for n in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do p="$(git -C '${repo}' rev-parse --git-path "$n")"; test ! -e "$p" || printf '%s\\n' "$n"; done`]);
  const configShape = (dev: Device, repo: string) => gitExec(dev, repo, ["config", "--local", "--get-regexp", "^(branch\\.|remote\\.)"]);
  const [aState, bState, aIndex, bIndex, aBytes, bBytes, aOp, bOp, aConfig, bConfig] = await Promise.all([
    readRepoState(a, repoA),
    readRepoState(b, repoB),
    gitExec(a, repoA, ["write-tree"]),
    gitExec(b, repoB, ["write-tree"]),
    a.readFile(`${repoA}/a.txt`),
    b.readFile(`${repoB}/a.txt`),
    opShape(a, repoA),
    opShape(b, repoB),
    configShape(a, repoA),
    configShape(b, repoB),
  ]);
  rec.assert(`[${label}] B fsck --strict clean`, bState.fsckCode === 0, `exit ${bState.fsckCode}`);
  rec.assert(`[${label}] HEAD form exact`, aState.headSymbolic === bState.headSymbolic, `A=${aState.headSymbolic || "(detached)"} B=${bState.headSymbolic || "(detached)"}`);
  rec.assert(`[${label}] HEAD oid exact`, aState.headSha === bState.headSha, `A=${aState.headSha.slice(0, 12)} B=${bState.headSha.slice(0, 12)}`);
  rec.assert(`[${label}] semantic index tree exact`, aIndex.code === 0 && bIndex.code === 0 && aIndex.out.trim() === bIndex.out.trim(), `A=${aIndex.out.trim().slice(0, 12)} B=${bIndex.out.trim().slice(0, 12)}`);
  rec.assert(`[${label}] tracked file bytes exact`, aBytes === bBytes, `A=${aBytes.length}B B=${bBytes.length}B`);
  rec.assert(`[${label}] op-state exact`, aOp.stdout === bOp.stdout, `A=${aOp.stdout.trim() || "none"} B=${bOp.stdout.trim() || "none"}`);
  rec.assert(`[${label}] safe config/upstream exact`, aConfig.out === bConfig.out, aConfig.out.trim() || "no branch/remote config");
  // Design 130 §artifact refs: refs/rbox-local/* BASE artifacts and other
  // refs/rbox-* namespaces are machine-local and excluded from ref identity.
  const isRboxInternalRef = (refname: string) => refname.startsWith("refs/rbox-local/") || refname.startsWith("refs/rbox-");
  const aSafeRefs = parseForEachRef(aState.refs).filter((ref) => !isRboxInternalRef(ref.refname));
  const bSafeRefs = parseForEachRef(bState.refs).filter((ref) => !isRboxInternalRef(ref.refname));
  const refs = diffRefLines(aSafeRefs, bSafeRefs);
  rec.assert(`[${label}] safe refs exact`, refs.identical, refs.identical ? `${bSafeRefs.length} refs` : refDiffDetail(refs));
  assertRepoSettled(rec, label, await readSyncState(b));
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

      // ── Design 116 field gate: tracked bytes land before checkout metadata ───────
      const trackedRound = async (kind: "ff" | "switch" | "detached", date: string): Promise<void> => {
        await rec.step(`[A→B] tracked-file ${kind} follow`, async () => {
          const move = kind === "switch"
            ? `git ${IDENT} checkout -q main`
            : kind === "detached"
              ? `git ${IDENT} checkout -q --detach HEAD`
              : ":";
          const commit = kind === "detached"
            ? `git ${IDENT} commit --allow-empty -q -m 'tracked detached head move'`
            : `printf '${kind}\\n' > 'head-${kind}.txt'; git ${IDENT} add 'head-${kind}.txt'; git ${IDENT} commit -q -m 'tracked ${kind} head move'`;
          const script = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='${date}T00:00:00 +0000' GIT_COMMITTER_DATE='${date}T00:00:00 +0000'
cd '${topA}'
${move}
${commit}
printf 'sync-dirt-${kind}\\n' >> a.txt
`;
          await ctx.a.exec(["sh", "-c", script]);
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
          await assertTrackedFollow(rec, `tracked-${kind}`, ctx.a, ctx.b, topA, topB);
          const expectedHead = kind === "detached" ? "" : kind === "switch" ? "refs/heads/main" : "refs/heads/feature";
          const bHead = (await gitExec(ctx.b, topB, ["symbolic-ref", "-q", "HEAD"])).out.trim();
          rec.assert(`[tracked-${kind}] exact checkout form`, bHead === expectedHead, `B=${bHead || "(detached)"}`);
        });
      };
      await trackedRound("ff", "2026-03-02");
      await trackedRound("switch", "2026-03-03");
      await trackedRound("detached", "2026-03-04");

      await rec.step("tracked follow permits one ACK sequence then settles", async () => {
        const [beforeA, beforeB] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        const baseline = Math.max(beforeA.lastSyncedSequence ?? -1, beforeB.lastSyncedSequence ?? -1);
        for (let cycle = 0; cycle < 2; cycle++) {
          await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        }
        const [afterA, afterB] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        const after = Math.max(afterA.lastSyncedSequence ?? -1, afterB.lastSyncedSequence ?? -1);
        rec.assert("two tracked-follow idle cycles produced at most one sequence", after >= baseline && after <= baseline + 1, `before=${baseline} after=${after}`);
        assertRepoSettled(rec, "tracked-idle", afterB);

        await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
        await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        const [settledA, settledB] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        const settled = Math.max(settledA.lastSyncedSequence ?? -1, settledB.lastSyncedSequence ?? -1);
        rec.assert("third tracked-follow idle cycle produced zero sequences", settled === after, `before=${after} after=${settled}`);
      });

      // ── Linked-worktree regression: OID equality is a no-op, divergence holds ────
      const siblingB = "/tmp/rbox-rig-git-entanglement-side";
      try {
        await rec.step("[A→B] normalize main and create synced side branch", async () => {
          const script = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
export GIT_AUTHOR_DATE='2026-03-05T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-05T00:00:00 +0000'
cd '${topA}'
git ${IDENT} branch -f detached-gate HEAD
git ${IDENT} checkout -q main
printf 'normalize-main\n' > normalize-main.txt
git ${IDENT} add normalize-main.txt && git ${IDENT} commit -q -m 'normalize main for worktree gate'
git ${IDENT} branch -f side HEAD
`;
          await ctx.a.exec(["sh", "-c", script]);
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          await ctx.b.exec(["rm", "-rf", siblingB], { allowFail: true });
          await ctx.b.exec(["git", "-C", topB, "worktree", "prune"]);
          await ctx.b.exec(["git", "-C", topB, "worktree", "add", "-q", siblingB, "side"]);
        });

        await rec.step("linked worktree identical OID does not hold checkout", async () => {
          await ctx.a.exec(["sh", "-c", `set -e; cd '${topA}'; printf 'equal\n' > wt-equal.txt; git ${IDENT} add wt-equal.txt; GIT_AUTHOR_DATE='2026-03-06T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-06T00:00:00 +0000' git ${IDENT} commit -q -m 'worktree equal oid row'`]);
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          await assertTrackedFollow(rec, "worktree-identical", ctx.a, ctx.b, topA, topB);
          const [side, sibling] = await Promise.all([
            gitExec(ctx.b, topB, ["rev-parse", "refs/heads/side"]),
            gitExec(ctx.b, siblingB, ["rev-parse", "HEAD"]),
          ]);
          rec.assert("identical-OID sibling branch remains exact", side.out.trim() === sibling.out.trim(), `ref=${side.out.trim().slice(0, 12)} wt=${sibling.out.trim().slice(0, 12)}`);
        });

        await rec.step("linked worktree diverged OID holds side while checkout follows", async () => {
          const beforeSide = (await gitExec(ctx.b, topB, ["rev-parse", "refs/heads/side"])).out.trim();
          const script = `
set -e
export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'
export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'
cd '${topA}'
git ${IDENT} checkout -q side
printf 'diverged\n' > wt-side-diverged.txt
git ${IDENT} add wt-side-diverged.txt
GIT_AUTHOR_DATE='2026-03-07T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-07T00:00:00 +0000' git ${IDENT} commit -q -m 'diverge sibling side'
git ${IDENT} checkout -q main
printf 'main-continues\n' > wt-main-continues.txt
git ${IDENT} add wt-main-continues.txt
GIT_AUTHOR_DATE='2026-03-08T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-08T00:00:00 +0000' git ${IDENT} commit -q -m 'main follows despite side hold'
`;
          await ctx.a.exec(["sh", "-c", script]);
          const incomingMain = (await gitExec(ctx.a, topA, ["rev-parse", "refs/heads/main"])).out.trim();
          const incomingSide = (await gitExec(ctx.a, topA, ["rev-parse", "refs/heads/side"])).out.trim();
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          const [bMain, bSide, sibling] = await Promise.all([
            gitExec(ctx.b, topB, ["rev-parse", "HEAD"]),
            gitExec(ctx.b, topB, ["rev-parse", "refs/heads/side"]),
            gitExec(ctx.b, siblingB, ["rev-parse", "HEAD"]),
          ]);
          rec.assert("diverged sibling does not block checkout follow", bMain.out.trim() === incomingMain, `B=${bMain.out.trim().slice(0, 12)} A=${incomingMain.slice(0, 12)}`);
          rec.assert("diverged sibling ref is held", bSide.out.trim() === beforeSide && sibling.out.trim() === beforeSide && incomingSide !== beforeSide, `held=${beforeSide.slice(0, 12)} incoming=${incomingSide.slice(0, 12)}`);
          const state = await readSyncState(ctx.b);
          const record = state.repoRecords?.[TOP];
          // Design 200 P2 / #462: a non-HEAD ownership hold is durable per ref,
          // but must not escalate into a repository-level apply deferral.
          rec.assert("diverged sibling records a non-checkout ownership hold", record?.pending !== undefined && record.partial?.checkoutPending === false && record.partial.heldRefs?.["refs/heads/side"] === "ownership" && record.deferrals?.apply === undefined, JSON.stringify(record));
        });

        await rec.step("removing sibling lets held side retry without another push", async () => {
          const incomingSide = (await gitExec(ctx.a, topA, ["rev-parse", "refs/heads/side"])).out.trim();
          await ctx.b.exec(["git", "-C", topB, "worktree", "remove", "--force", siblingB]);
          await ctx.b.exec(["git", "-C", topB, "worktree", "prune"]);
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          const bSide = (await gitExec(ctx.b, topB, ["rev-parse", "refs/heads/side"])).out.trim();
          rec.assert("held side advanced on pending retry", bSide === incomingSide, `B=${bSide.slice(0, 12)} A=${incomingSide.slice(0, 12)}`);
          assertRepoSettled(rec, "worktree-retry", await readSyncState(ctx.b));
        });
      } finally {
        await ctx.b.exec(["git", "-C", topB, "worktree", "remove", "--force", siblingB], { allowFail: true });
        await ctx.b.exec(["git", "-C", topB, "worktree", "prune"], { allowFail: true });
        await ctx.b.exec(["rm", "-rf", siblingB], { allowFail: true });
      }

      // ── Local blocker rows: checkout stays safe, unrelated refs still advance ──
      for (const blocker of ["edit", "commit", "index", "stash"] as const) {
        await rec.step(`[A→B] local ${blocker} blocks checkout with aged visibility`, async () => {
          const preHead = (await gitExec(ctx.b, topB, ["rev-parse", "HEAD"])).out.trim();
          const aBytesBefore = await ctx.a.readFile(`${topA}/a.txt`);
          let protectedValue = "";
          if (blocker === "edit") {
            await ctx.b.exec(["sh", "-c", `printf 'receiver-local-edit\\n' >> '${topB}/a.txt'`]);
            protectedValue = await ctx.b.readFile(`${topB}/a.txt`);
          } else if (blocker === "commit") {
            await ctx.b.exec(["git", "-C", topB, "-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com", "commit", "--allow-empty", "-q", "-m", "receiver-only blocker"]);
            protectedValue = (await gitExec(ctx.b, topB, ["rev-parse", "HEAD"])).out.trim();
          } else if (blocker === "index") {
            await ctx.b.writeFile(`${topB}/receiver-index-only.txt`, "staged only\n");
            await ctx.b.exec(["git", "-C", topB, "add", "receiver-index-only.txt"]);
            await ctx.b.exec(["rm", "-f", `${topB}/receiver-index-only.txt`]);
            protectedValue = (await gitExec(ctx.b, topB, ["write-tree"])).out.trim();
          } else {
            await ctx.b.writeFile(`${topB}/receiver-stash-only.txt`, "stash only\n");
            await ctx.b.exec(["git", "-C", topB, "add", "receiver-stash-only.txt"]);
            await ctx.b.exec(["git", "-C", topB, "-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com", "stash", "push", "-q", "-m", "receiver-only blocker stash"]);
            await ctx.b.writeFile(`${topB}/a.txt`, aBytesBefore);
            protectedValue = (await gitExec(ctx.b, topB, ["rev-parse", "refs/stash"])).out.trim();
          }

          const dateDay = blocker === "edit" ? "09" : blocker === "commit" ? "10" : blocker === "index" ? "11" : "12";
          await ctx.a.exec(["sh", "-c", `set -e; cd '${topA}'; printf '${blocker}\\n' > 'advance-${blocker}.txt'; git ${IDENT} add 'advance-${blocker}.txt'; GIT_AUTHOR_DATE='2026-03-${dateDay}T00:00:00 +0000' GIT_COMMITTER_DATE='2026-03-${dateDay}T00:00:00 +0000' git ${IDENT} commit -q -m 'advance past ${blocker} blocker'; git ${IDENT} branch -f 'safe-${blocker}' HEAD`]);
          const incomingHead = (await gitExec(ctx.a, topA, ["rev-parse", "HEAD"])).out.trim();
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });

          // Design 200 P2 / #462: the durable record keeps the classifier's
          // selected reason; stash changes ORIG_HEAD, so local-operation wins
          // the product's reason precedence over the accompanying stash hold.
          const expectedReason = blocker === "edit" ? "local-edits" : blocker === "commit" ? "local-commits" : blocker === "index" ? "local-index" : "local-operation";
          const state = await readSyncState(ctx.b);
          const deferred = state.repoRecords?.[TOP]?.deferrals?.apply;
          rec.assert(`[${blocker}] exact durable reason`, deferred?.reason === expectedReason && state.repoRecords?.[TOP]?.pending !== undefined, JSON.stringify(deferred));
          const safe = (await gitExec(ctx.b, topB, ["rev-parse", `refs/heads/safe-${blocker}`])).out.trim();
          rec.assert(`[${blocker}] unrelated ref advanced`, safe === incomingHead, `safe=${safe.slice(0, 12)} incoming=${incomingHead.slice(0, 12)}`);
          const bHead = (await gitExec(ctx.b, topB, ["rev-parse", "HEAD"])).out.trim();
          rec.assert(`[${blocker}] checkout held`, bHead !== incomingHead, `B=${bHead.slice(0, 12)} incoming=${incomingHead.slice(0, 12)}`);
          if (blocker === "edit") rec.assert("local edit bytes preserved", await ctx.b.readFile(`${topB}/a.txt`) === protectedValue, "byte comparison");
          else if (blocker === "commit") rec.assert("local commit remains reachable", bHead === protectedValue && (await gitExec(ctx.b, topB, ["cat-file", "-e", `${protectedValue}^{commit}`])).code === 0, protectedValue.slice(0, 12));
          else if (blocker === "index") rec.assert("staged-only index preserved", (await gitExec(ctx.b, topB, ["write-tree"])).out.trim() === protectedValue, protectedValue.slice(0, 12));
          else rec.assert("local stash remains reachable", (await gitExec(ctx.b, topB, ["rev-parse", "refs/stash"])).out.trim() === protectedValue && (await gitExec(ctx.b, topB, ["cat-file", "-e", `${protectedValue}^{commit}`])).code === 0, protectedValue.slice(0, 12));

          const human = await ctx.b.rbox(["status", "--git"], { cwd: GUEST.workDir, allowFail: true, env: { NO_COLOR: "1" } });
          const humanLine = human.stdout.trim().split("\n").find((line) => line.includes("git deferred") && line.includes(TOP));
          const jsonStatus = await ctx.b.rbox(["status", "--json"], { cwd: GUEST.workDir, allowFail: true });
          let visible: { repo?: string; lane?: string; reason?: string; deferredSince?: string; reasonSince?: string; ageSeconds?: number | null; bytesChanged?: boolean; checkout?: { kind?: string; label?: string } } | undefined;
          try {
            const parsed = JSON.parse(jsonStatus.stdout) as { git?: { deferrals?: Array<{ repo?: string; lane?: string; reason?: string; deferredSince?: string; reasonSince?: string; ageSeconds?: number | null; bytesChanged?: boolean; checkout?: { kind?: string; label?: string } }> } };
            visible = parsed.git?.deferrals?.find((entry) => entry.repo === TOP && entry.lane === "apply");
          } catch {
            visible = undefined;
          }
          // Design 200 P2 / #462: transient holds stay out of status --git's
          // ten-minute quiet window, while JSON is the immediate user-visible
          // reason surface; no repo-level line is promised at this age.
          rec.assert(`[${blocker}] current status surfaces expose reason`, humanLine === undefined && visible?.lane === "apply" && visible.reason === expectedReason, JSON.stringify({ humanLine, visible }));
          // Design 200 P2 / #462: JSON exposes the durable lane timestamps plus
          // a derived age, rather than relying on the quieted human line.
          rec.assert(`[${blocker}] JSON status exposes stable age`, visible?.reason === expectedReason && typeof visible.deferredSince === "string" && visible.deferredSince === deferred?.deferredSince && typeof visible.reasonSince === "string" && visible.reasonSince === deferred?.reasonSince && typeof visible.ageSeconds === "number" && Number.isInteger(visible.ageSeconds) && visible.ageSeconds >= 0 && visible.bytesChanged === false && visible.checkout?.kind === "branch" && visible.checkout.label === "main", JSON.stringify(visible));

          let expectedDeferredSince = deferred?.deferredSince;
          if (blocker === "edit") {
            // Design 200 aged visibility: cross the transient quiet window and retain
            // design 176's frozen human `git deferred` grammar as a live rig consumer.
            await ctx.b.daemonStop(GUEST.workDir);
            const statePath = `${GUEST.workDir}/.rbox/state.json`;
            const rawState = await ctx.b.readFile(statePath);
            const applyDeferral = state.repoRecords?.[TOP]?.deferrals?.apply;
            if (typeof applyDeferral?.deferredSince !== "string" || typeof applyDeferral.reasonSince !== "string") {
              throw new Error(`missing ${TOP} apply-lane timestamps before aged visibility: ${JSON.stringify(applyDeferral)}`);
            }
            const agedAt = new Date(Date.now() - 11 * 60_000).toISOString();
            const replaceTimestampOnce = (source: string, field: "deferredSince" | "reasonSince", current: string): string => {
              const token = `${JSON.stringify(field)}: ${JSON.stringify(current)}`;
              if (source.split(token).length !== 2) {
                throw new Error(`expected exactly one ${field} token for ${TOP} apply deferral`);
              }
              return source.replace(token, `${JSON.stringify(field)}: ${JSON.stringify(agedAt)}`);
            };
            const agedState = replaceTimestampOnce(
              replaceTimestampOnce(rawState, "deferredSince", applyDeferral.deferredSince),
              "reasonSince",
              applyDeferral.reasonSince,
            );
            await ctx.b.writeFile(statePath, agedState);
            await ctx.b.daemonStart(GUEST.workDir);

            const agedHuman = await ctx.b.rbox(["status", "--git"], { cwd: GUEST.workDir, allowFail: true, env: { NO_COLOR: "1" } });
            const agedHumanLine = agedHuman.stdout.trim().split("\n").find((line) => line.includes(TOP) && /git deferred\s+\d+[smhd]:/.test(line));
            rec.assert("[edit] aged human status uses frozen grammar and rendered reason", agedHumanLine?.includes("local edits") === true, agedHumanLine ?? agedHuman.stdout.trim().slice(-800));
            await ctx.b.daemonStop(GUEST.workDir);
            expectedDeferredSince = agedAt;
          }

          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          const retried = await readSyncState(ctx.b);
          rec.assert(`[${blocker}] retry preserves deferredSince`, retried.repoRecords?.[TOP]?.deferrals?.apply?.deferredSince === expectedDeferredSince, retried.repoRecords?.[TOP]?.deferrals?.apply?.deferredSince ?? "missing");

          const aBytes = await ctx.a.readFile(`${topA}/a.txt`);
          if (blocker === "edit") await ctx.b.writeFile(`${topB}/a.txt`, aBytes);
          else if (blocker === "commit") {
            // The receiver-only commit is allow-empty: move only the protected
            // current ref back. A hard reset would delete remote files already
            // landed by the file plane before this pending Git retry.
            await ctx.b.exec(["git", "-C", topB, "update-ref", "refs/heads/main", preHead, protectedValue]);
            await ctx.b.writeFile(`${topB}/a.txt`, aBytes);
          } else if (blocker === "index") {
            await ctx.b.exec(["git", "-C", topB, "reset", "--mixed", "HEAD"]);
            await ctx.b.exec(["rm", "-f", `${topB}/receiver-index-only.txt`]);
          } else {
            await ctx.b.exec(["git", "-C", topB, "update-ref", "-d", "refs/stash"]);
            await ctx.b.exec(["sh", "-c", `rm -f "$(git -C '${topB}' rev-parse --git-path logs/refs/stash)"`]);
            await ctx.b.writeFile(`${topB}/a.txt`, aBytes);
          }
          await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
          const followed = (await gitExec(ctx.b, topB, ["rev-parse", "HEAD"])).out.trim();
          rec.assert(`[${blocker}] pending checkout follows without another push`, followed === incomingHead, `B=${followed.slice(0, 12)} incoming=${incomingHead.slice(0, 12)}`);
          assertRepoSettled(rec, `${blocker}-cleared`, await readSyncState(ctx.b));
        });
      }

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
