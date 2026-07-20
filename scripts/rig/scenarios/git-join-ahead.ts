/**
 * `git-join-ahead` — non-empty join with an AHEAD repo (founder question,
 * 2026-07-19). Machine A creates a workspace containing a repo; machine B
 * joins with the SAME repo already present but two commits AHEAD plus an
 * extra untracked file. Contract: B loses nothing and never rewinds; after
 * B's first push the fleet converges to B's newer state (A fast-forwards).
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo";
const repoPath = `${GUEST.workDir}/${REPO}`;

interface RepoRecordView { pending?: unknown; partial?: unknown; deferrals?: { apply?: unknown } }
interface SyncStateView {
  repoRecords?: Record<string, RepoRecordView>;
  gitPendingRemote?: Record<string, unknown>;
  gitNeedsResolution?: Record<string, unknown>;
}

async function readSyncState(device: Device): Promise<SyncStateView> {
  const raw = JSON.parse(await device.readFile(`${GUEST.workDir}/.rbox/state.json`)) as SyncStateView & { syncState?: SyncStateView };
  return raw.repoRecords ? raw : raw.syncState ?? raw;
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

async function seedGitRepo(device: Device): Promise<void> {
  await device.exec(["sh", "-c", `set -eu
mkdir -p '${repoPath}'
git -C '${repoPath}' init -q -b main
git -C '${repoPath}' config user.name 'Rig Tester'
git -C '${repoPath}' config user.email 'rig@example.com'
printf 'base v1\n' > '${repoPath}/file.txt'
git -C '${repoPath}' add file.txt
git -C '${repoPath}' commit -qm initial`]);
}

export const gitJoinAhead: Scenario = {
  name: "git-join-ahead",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    let aheadTip = "";
    let baseTip = "";

    try {
      await provisionPair(ctx, rec, {
        afterSeedA: seedGitRepo,
        beforeJoinB: async () => {
          baseTip = await head(ctx.a);
          // Same-history copy A→B (base64 keeps the tar binary-safe through
          // the exec capture layer), then advance B two commits + one
          // untracked extra file — the founder's literal desktop shape.
          const tarB64 = (await ctx.a.exec(["sh", "-c", `tar -C '${GUEST.workDir}' -czf - ${REPO} | base64`])).stdout;
          await ctx.b.mkdirp(GUEST.workDir);
          await ctx.b.exec(["sh", "-c", `base64 -d | tar -C '${GUEST.workDir}' -xzf -`], { stdin: tarB64 });
          await ctx.b.exec(["sh", "-c", `set -eu
printf 'edited on B\n' > '${repoPath}/file.txt'
git -C '${repoPath}' -c user.name=B -c user.email=b@example.com commit -qam 'B: edit file'
printf 'new on B\n' > '${repoPath}/b-only.txt'
git -C '${repoPath}' add b-only.txt
git -C '${repoPath}' -c user.name=B -c user.email=b@example.com commit -qm 'B: add b-only'
printf 'untracked scratch\n' > '${GUEST.workDir}/scratch.txt'`]);
          aheadTip = await head(ctx.b);
        },
      });

      await rec.step("[B] nothing lost, nothing rewound after join+pull", async () => {
        rec.assert("B HEAD still at its ahead tip", (await head(ctx.b)) === aheadTip, `B=${await head(ctx.b)} ahead=${aheadTip}`);
        const fileB = (await ctx.b.exec(["cat", `${repoPath}/file.txt`])).stdout.trim();
        rec.assert("B keeps its newer file content", fileB === "edited on B", fileB);
        const bOnly = await ctx.b.exec(["cat", `${repoPath}/b-only.txt`], { allowFail: true });
        rec.assert("B keeps its committed extra file", bOnly.exitCode === 0);
        const scratch = await ctx.b.exec(["cat", `${GUEST.workDir}/scratch.txt`], { allowFail: true });
        rec.assert("B keeps its untracked scratch file", scratch.exitCode === 0);
        const mainSha = (await git(ctx.b, ["rev-parse", "main"])).stdout.trim();
        rec.assert("B main not rewound", mainSha === aheadTip, `main=${mainSha}`);
      });

      await rec.step("[B→A] first push converges the fleet to B's newer state", async () => {
        await ctx.b.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("A fast-forwarded to B's ahead tip", (await head(ctx.a)) === aheadTip, `A=${await head(ctx.a)} ahead=${aheadTip}`);
        const reflog = (await git(ctx.a, ["reflog", "--format=%H"])).stdout;
        rec.assert("A reflog shows advance from base (not re-clone)", reflog.includes(baseTip) || baseTip === aheadTip, reflog.split("\n").slice(0, 3).join(","));
        const fileA = (await ctx.a.exec(["cat", `${repoPath}/file.txt`])).stdout.trim();
        rec.assert("A has B's newer file content", fileA === "edited on B", fileA);
        const bOnlyA = await ctx.a.exec(["cat", `${repoPath}/b-only.txt`], { allowFail: true });
        rec.assert("A received B's extra committed file", bOnlyA.exitCode === 0);
        const scratchA = await ctx.a.exec(["cat", `${GUEST.workDir}/scratch.txt`], { allowFail: true });
        rec.assert("A received B's scratch file", scratchA.exitCode === 0);
        const statusA = (await git(ctx.a, ["status", "--porcelain"])).stdout.trim();
        rec.assert("A tree clean after fast-forward", statusA === "", statusA);
      });

      await rec.step("both sides settle (no pending, no deferrals)", async () => {
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("A and B at same HEAD", (await head(ctx.a)) === (await head(ctx.b)));
        const [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        rec.assert("A record settled", recordSettled(sa), JSON.stringify(sa.repoRecords?.[REPO] ?? {}).slice(0, 400));
        rec.assert("B record settled", recordSettled(sb), JSON.stringify(sb.repoRecords?.[REPO] ?? {}).slice(0, 400));
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: gitJoinAhead.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
