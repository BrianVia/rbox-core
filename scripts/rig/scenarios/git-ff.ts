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

async function cycle(ctx: RigCtx): Promise<void> {
  await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
  await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
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
        const reflog = (await git(ctx.b, ["reflog", "--format=%H"])).stdout;
        rec.assert("B reflog contains old SHA (advance, not re-clone)", reflog.includes(sha1), reflog.split("\n").slice(0, 4).join(","));
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

      await rec.step("[A→B] switch back to main follows; branch survives", async () => {
        await git(ctx.a, ["switch", "-q", "main"]);
        let cycles = 0;
        for (; cycles < 5; cycles++) {
          await cycle(ctx);
          if ((await branchOf(ctx.b)) === "main") break;
        }
        rec.assert(`B back on main (after ${cycles + 1} cycle(s))`, (await branchOf(ctx.b)) === "main", await branchOf(ctx.b));
        rec.assert("B main at expected SHA", (await head(ctx.b)) === sha2, `B=${await head(ctx.b)} expected=${sha2}`);
        const bBranch = (await git(ctx.b, ["rev-parse", BRANCH])).stdout.trim();
        const aBranch = (await git(ctx.a, ["rev-parse", BRANCH])).stdout.trim();
        rec.assert("branch survives on both at same SHA", bBranch === shaBranch && aBranch === shaBranch, `A=${aBranch} B=${bBranch}`);
        rec.assert("B tree clean at end", await clean(ctx.b));
        const state = JSON.parse(await ctx.b.readFile(`${GUEST.workDir}/.rbox/state.json`)) as {
          repoRecords?: Record<string, unknown>;
        } & Record<string, unknown>;
        const record = (state.repoRecords ?? (state as Record<string, Record<string, unknown>>).syncState?.repoRecords ?? {}) as Record<string, unknown>;
        ctx.log(`B repo record: ${JSON.stringify(record[REPO] ?? state).slice(0, 2000)}`);
        const status = (await ctx.b.exec(["git", "-C", repoPath, "status", "-sb"], { allowFail: true })).stdout.trim();
        ctx.log(`B git status -sb: ${status}`);
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
