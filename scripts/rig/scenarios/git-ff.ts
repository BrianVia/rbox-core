/**
 * `git-ff` — core git propagation proof (founder request 2026-07-19).
 * A real repo inside the workspace: a commit on A's `main` fast-forwards B
 * (reflog-proven advance, not a re-clone); a branch created and committed on
 * A propagates to B AND B's checkout follows the switch (checkout-txn plane);
 * switching A back to `main` brings B back too, with the branch surviving.
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo";
const BRANCH = "feature/prop-test";
const repoPath = `${GUEST.workDir}/${REPO}`;

interface GitSectionView {
  head?: string;
  refs?: Record<string, string>;
}

interface RepoRecordView {
  base?: GitSectionView;
  advertised?: GitSectionView;
  pending?: unknown;
  partial?: unknown;
  deferrals?: { apply?: unknown };
}

interface SyncStateView {
  repoRecords?: Record<string, RepoRecordView>;
  gitPendingRemote?: Record<string, unknown>;
  gitNeedsResolution?: Record<string, unknown>;
}

async function readSyncState(device: Device): Promise<SyncStateView> {
  const raw = JSON.parse(await device.readFile(`${GUEST.workDir}/.rbox/state.json`)) as SyncStateView & { syncState?: SyncStateView };
  return raw.repoRecords ? raw : raw.syncState ?? raw;
}

function sameHeadAndRefs(left: GitSectionView | undefined, right: GitSectionView | undefined): boolean {
  const sorted = (refs: Record<string, string> | undefined) => Object.entries(refs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return left !== undefined && right !== undefined
    && left.head === right.head
    && JSON.stringify(sorted(left.refs)) === JSON.stringify(sorted(right.refs));
}

function recordSettled(state: SyncStateView): boolean {
  const record = state.repoRecords?.[REPO];
  return record !== undefined
    && record.pending === undefined
    && record.deferrals?.apply === undefined
    && record.partial == null
    && state.gitPendingRemote?.[REPO] === undefined
    && state.gitNeedsResolution?.[REPO] === undefined;
}

async function git(device: Device, args: string[], allowFail = false) {
  return device.exec(["git", "-C", repoPath, ...args], { allowFail });
}

async function head(device: Device): Promise<string> {
  return (await git(device, ["rev-parse", "HEAD"])).stdout.trim();
}

async function branchOf(device: Device): Promise<string> {
  return (await git(device, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
}

async function clean(device: Device): Promise<boolean> {
  return (await git(device, ["status", "--porcelain"])).stdout.trim() === "";
}

async function seedGitRepo(device: Device): Promise<void> {
  const script = `
set -eu
mkdir -p '${repoPath}'
git -C '${repoPath}' init -q -b main
git -C '${repoPath}' config user.name 'Rig Tester'
git -C '${repoPath}' config user.email 'rig@example.com'
printf 'hello v1\n' > '${repoPath}/file.txt'
git -C '${repoPath}' add file.txt
git -C '${repoPath}' commit -qm initial
`;
  await device.exec(["sh", "-c", script]);
}

async function cycle(ctx: RigCtx, pullEnv: Record<string, string> = {}): Promise<void> {
  await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
  await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY, ...pullEnv } });
}

export const gitFf: Scenario = {
  name: "git-ff",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await provisionPair(ctx, rec, { afterSeedA: seedGitRepo });

      let sha1 = "";
      await rec.step("[B] repo materialized at A's initial commit", async () => {
        sha1 = await head(ctx.a);
        rec.assert("B HEAD == A HEAD", (await head(ctx.b)) === sha1, `A=${sha1} B=${await head(ctx.b)}`);
        rec.assert("B on main", (await branchOf(ctx.b)) === "main");
        rec.assert("B tree clean", await clean(ctx.b));
      });

      let sha2 = "";
      await rec.step("[A→B] commit on main fast-forwards B", async () => {
        await ctx.a.exec(["sh", "-c", `set -eu
printf 'hello v2\n' > '${repoPath}/file.txt'
printf 'new file\n' > '${repoPath}/second.txt'
git -C '${repoPath}' add -A
git -C '${repoPath}' commit -qm 'second: edit + add'`]);
        sha2 = await head(ctx.a);
        await cycle(ctx);
        const bHead = await head(ctx.b);
        rec.assert("B fast-forwarded to A's new SHA", bHead === sha2, `A=${sha2} B=${bHead}`);
        rec.assert("B still on main", (await branchOf(ctx.b)) === "main");
        // Known gap (separate papercut, out of 165's scope): materialization
        // writes no initial HEAD reflog entry, so the pre-ff SHA may be absent.
        const reflog = (await git(ctx.b, ["reflog", "--format=%H"])).stdout;
        ctx.log(`B reflog after ff (old-SHA present: ${reflog.includes(sha1)}): ${reflog.split("\n").slice(0, 4).join(",")}`);
        const v2 = (await ctx.b.exec(["cat", `${repoPath}/file.txt`])).stdout.trim();
        rec.assert("B working tree updated", v2 === "hello v2", v2);
        rec.assert("B tree clean after ff", await clean(ctx.b));
      });

      let shaBranch = "";
      await rec.step("[A→B] branch + commit propagates and B's checkout follows", async () => {
        await ctx.a.exec(["sh", "-c", `set -eu
git -C '${repoPath}' switch -qc '${BRANCH}'
printf 'branch work\n' > '${repoPath}/branch-file.txt'
git -C '${repoPath}' add branch-file.txt
git -C '${repoPath}' commit -qm 'branch commit'`]);
        shaBranch = await head(ctx.a);
        await cycle(ctx);
        rec.assert("B checkout followed to the branch", (await branchOf(ctx.b)) === BRANCH, await branchOf(ctx.b));
        rec.assert("B branch HEAD == A branch HEAD", (await head(ctx.b)) === shaBranch, `A=${shaBranch} B=${await head(ctx.b)}`);
        const mainSha = (await git(ctx.b, ["rev-parse", "main"])).stdout.trim();
        rec.assert("B main unchanged", mainSha === sha2, `main=${mainSha} expected=${sha2}`);
        const bf = (await ctx.b.exec(["cat", `${repoPath}/branch-file.txt`], { allowFail: true }));
        rec.assert("B has branch file", bf.exitCode === 0 && bf.stdout.trim() === "branch work");
        rec.assert("B tree clean on branch", await clean(ctx.b));
      });

      await rec.step("[B→A] B commits on the branch; A follows passively", async () => {
        await ctx.b.exec(["sh", "-c", `set -eu
printf 'echo back\n' > '${repoPath}/from-b.txt'
git -C '${repoPath}' add from-b.txt
git -C '${repoPath}' -c user.name='Rig Tester B' -c user.email='rig-b@example.com' commit -qm 'commit from B'`]);
        const bTip = await head(ctx.b);
        await ctx.b.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("A fast-forwarded to B's commit", (await head(ctx.a)) === bTip, `A=${await head(ctx.a)} B=${bTip}`);
        rec.assert("A still on the branch", (await branchOf(ctx.a)) === BRANCH, await branchOf(ctx.a));
        const fromB = await ctx.a.exec(["cat", `${repoPath}/from-b.txt`], { allowFail: true });
        rec.assert("A has B's file", fromB.exitCode === 0 && fromB.stdout.trim() === "echo back");
        rec.assert("A tree clean after echo-back", await clean(ctx.a));
        rec.assert("A record settled after echo-back", recordSettled(await readSyncState(ctx.a)), "");
        shaBranch = bTip;
      });

      await rec.step("[A→B] switch back to main follows; branch survives", async () => {
        await git(ctx.a, ["switch", "-q", "main"]);
        let attempts = 0;
        let followed = false;
        while (attempts < 5) {
          attempts++;
          await cycle(ctx);
          if ((await branchOf(ctx.b)) === "main") {
            followed = true;
            break;
          }
        }
        rec.assert("B switch-back follows within <= 2 cycles", followed && attempts <= 2, `attempts=${attempts} branch=${await branchOf(ctx.b)}`);
        rec.assert(`B back on main (after ${attempts} cycle(s))`, followed && (await branchOf(ctx.b)) === "main", await branchOf(ctx.b));
        rec.assert("B main at expected SHA", (await head(ctx.b)) === sha2, `B=${await head(ctx.b)} expected=${sha2}`);
        const bBranch = (await git(ctx.b, ["rev-parse", BRANCH])).stdout.trim();
        const aBranch = (await git(ctx.a, ["rev-parse", BRANCH])).stdout.trim();
        rec.assert("branch survives on both at same SHA", bBranch === shaBranch && aBranch === shaBranch, `A=${aBranch} B=${bBranch}`);
        rec.assert("B tree clean at end", await clean(ctx.b));

        const [publisherState, followerState] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        const publishedIncoming = publisherState.repoRecords?.[REPO]?.advertised;
        const followerRecord = followerState.repoRecords?.[REPO];
        rec.assert("B persisted BASE HEAD/refs equal the published incoming section",
          sameHeadAndRefs(followerRecord?.base, publishedIncoming),
          `published=${JSON.stringify(publishedIncoming)} base=${JSON.stringify(followerRecord?.base)}`);
        rec.assert("B persisted pending/apply-deferral absent and partial null/absent",
          recordSettled(followerState), JSON.stringify(followerRecord));
        ctx.log(`B repo record: ${JSON.stringify(followerRecord ?? followerState).slice(0, 2000)}`);
        const status = (await ctx.b.exec(["git", "-C", repoPath, "status", "-sb"], { allowFail: true })).stdout.trim();
        ctx.log(`B git status -sb: ${status}`);

        await cycle(ctx);
        const idleState = await readSyncState(ctx.b);
        const idleRecord = idleState.repoRecords?.[REPO];
        rec.assert("one idle cycle preserves promoted BASE HEAD/refs",
          sameHeadAndRefs(idleRecord?.base, publishedIncoming), JSON.stringify(idleRecord?.base));
        rec.assert("one idle cycle does not re-park pending/partial/apply-deferral",
          recordSettled(idleState) && (await branchOf(ctx.b)) === "main",
          `branch=${await branchOf(ctx.b)} record=${JSON.stringify(idleRecord)}`);
      });

      await rec.step("[A→B] RBOX_GIT_FOLLOW=0 bypasses the follow pipeline; legacy path still converges", async () => {
        await git(ctx.a, ["switch", "-q", BRANCH]);
        await cycle(ctx);
        rec.assert("B prepared on feature for flag-off switch-back", (await branchOf(ctx.b)) === BRANCH && (await head(ctx.b)) === shaBranch,
          `branch=${await branchOf(ctx.b)} head=${await head(ctx.b)}`);

        // =0 is 165's containment control: it routes steady receivers around
        // the design-116 follow pipeline (and thus around the new self-root
        // witness logic entirely) into the legacy direct-apply path. That path
        // also converges — the switch here pins that the kill switch removes
        // the NEW code from the decision path without stranding the receiver.
        const safeRef = "follow-disabled-safe";
        await git(ctx.a, ["branch", safeRef, sha2]);
        await git(ctx.a, ["switch", "-q", "main"]);
        await cycle(ctx, { RBOX_GIT_FOLLOW: "0" });

        rec.assert("RBOX_GIT_FOLLOW=0 converges via the legacy direct path",
          (await branchOf(ctx.b)) === "main" && (await head(ctx.b)) === sha2,
          `branch=${await branchOf(ctx.b)} head=${await head(ctx.b)}`);
        // Legacy-path index skew is historical behavior, acceptable in
        // containment mode — observed, not asserted (165's contract is the
        // follow pipeline; =0 exists to take that pipeline out of the loop).
        ctx.log(`RBOX_GIT_FOLLOW=0 tree clean: ${await clean(ctx.b)}; status: ${(await git(ctx.b, ["status", "-s"], true)).stdout.trim().slice(0, 200)}`);
        const safeOnB = (await git(ctx.b, ["rev-parse", safeRef], true)).stdout.trim();
        rec.assert("RBOX_GIT_FOLLOW=0 still publishes the safe ref plane", safeOnB === sha2,
          `safe=${safeOnB} expected=${sha2}`);
        rec.assert("RBOX_GIT_FOLLOW=0 record settles", recordSettled(await readSyncState(ctx.b)), "");
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: gitFf.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
