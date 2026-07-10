/**
 * `git-config-sync` (design 93 §11 / GATES Lane 1) — two-device config lane.
 * A real repository on A carries remote + tracking config through the encrypted
 * GitSection channel; B proves materialization, same-head deletion healing,
 * config-only wire publication, and the two-cycle zero-sequence echo gate.
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const REPO = "repo";
const URL_ONE = "https://example.test/rbox-rig-one.git";
const URL_TWO = "https://example.test/rbox-rig-two.git";

interface GuestSyncState {
  lastSyncedSequence?: number;
  lastSyncedManifest?: {
    gitRepos?: Record<string, { config?: Record<string, string[]> }>;
  };
}

const repoPath = `${GUEST.workDir}/${REPO}`;
const statePath = `${GUEST.workDir}/.rbox/state.json`;

async function git(device: Device, args: string[], allowFail = false) {
  return device.exec(["git", "-C", repoPath, ...args], { allowFail });
}

async function configValue(device: Device, key: string): Promise<string | undefined> {
  const result = await git(device, ["config", "--local", "--get", key], true);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function readSyncState(device: Device): Promise<GuestSyncState> {
  return JSON.parse(await device.readFile(statePath)) as GuestSyncState;
}

function wireUrl(state: GuestSyncState): string | undefined {
  return state.lastSyncedManifest?.gitRepos?.[REPO]?.config?.["remote.origin.url"]?.[0];
}

async function seedGitRepo(device: Device): Promise<void> {
  const script = `
set -eu
mkdir -p '${repoPath}'
git -C '${repoPath}' init -q -b main
git -C '${repoPath}' config user.name 'Rig Tester'
git -C '${repoPath}' config user.email 'rig@example.com'
printf 'git config sync rig\n' > '${repoPath}/tracked.txt'
git -C '${repoPath}' add tracked.txt
git -C '${repoPath}' commit -qm initial
git -C '${repoPath}' remote add origin '${URL_ONE}'
git -C '${repoPath}' config branch.main.remote origin
git -C '${repoPath}' config branch.main.merge refs/heads/main
`;
  await device.exec(["sh", "-c", script]);
}

export const gitConfigSync: Scenario = {
  name: "git-config-sync",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await provisionPair(ctx, rec, { afterSeedA: seedGitRepo });

      await rec.step("[B] assert remote + tracking materialized", async () => {
        const [remotes, status, url, fetch, branchRemote, branchMerge] = await Promise.all([
          git(ctx.b, ["remote", "-v"]),
          git(ctx.b, ["status", "-sb"]),
          configValue(ctx.b, "remote.origin.url"),
          configValue(ctx.b, "remote.origin.fetch"),
          configValue(ctx.b, "branch.main.remote"),
          configValue(ctx.b, "branch.main.merge"),
        ]);
        const remoteOutput = remotes.stdout.trim();
        if (!remoteOutput) {
          rec.assert("B remote -v has origin", false, "git remote -v returned empty output");
          throw new Error("B materialized repository has no git remotes");
        }
        rec.assert("B remote -v has origin", remoteOutput.includes(`origin\t${URL_ONE}`), remoteOutput);
        rec.assert("B status -sb has upstream tracking", status.stdout.includes("main...origin/main"), status.stdout.trim());
        rec.assert("B remote URL materialized", url === URL_ONE, url ?? "missing");
        rec.assert("B remote fetch materialized", fetch === "+refs/heads/*:refs/remotes/origin/*", fetch ?? "missing");
        rec.assert("B branch remote materialized", branchRemote === "origin", branchRemote ?? "missing");
        rec.assert("B branch merge materialized", branchMerge === "refs/heads/main", branchMerge ?? "missing");
      });

      await rec.step("[B] delete remote block, then same-head pull heals it", async () => {
        await git(ctx.b, ["config", "--local", "--unset-all", "remote.origin.url"]);
        await git(ctx.b, ["config", "--local", "--unset-all", "remote.origin.fetch"]);
        rec.assert("B remote URL deleted", (await configValue(ctx.b, "remote.origin.url")) === undefined);
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("B remote URL healed", (await configValue(ctx.b, "remote.origin.url")) === URL_ONE);
        rec.assert(
          "B remote fetch healed",
          (await configValue(ctx.b, "remote.origin.fetch")) === "+refs/heads/*:refs/remotes/origin/*"
        );
      });

      await rec.step("[A→B] config-only URL edit propagates on the wire", async () => {
        await git(ctx.a, ["remote", "set-url", "origin", URL_TWO]);
        const headBefore = (await git(ctx.a, ["rev-parse", "HEAD"])).stdout.trim();
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        const [stateA, stateB, headAfter] = await Promise.all([
          readSyncState(ctx.a),
          readSyncState(ctx.b),
          git(ctx.a, ["rev-parse", "HEAD"]),
        ]);
        rec.assert("A wire config carries edited URL", wireUrl(stateA) === URL_TWO, wireUrl(stateA) ?? "missing");
        rec.assert("B received edited wire config", wireUrl(stateB) === URL_TWO, wireUrl(stateB) ?? "missing");
        rec.assert("URL-only edit did not change Git HEAD", headAfter.stdout.trim() === headBefore, headAfter.stdout.trim());
      });

      await rec.step("two idle cycles emit zero new sequences", async () => {
        const beforeA = await readSyncState(ctx.a);
        const beforeB = await readSyncState(ctx.b);
        const baseline = Math.max(beforeA.lastSyncedSequence ?? -1, beforeB.lastSyncedSequence ?? -1);
        for (let cycle = 0; cycle < 2; cycle++) {
          await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
          await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        }
        const afterA = await readSyncState(ctx.a);
        const afterB = await readSyncState(ctx.b);
        const after = Math.max(afterA.lastSyncedSequence ?? -1, afterB.lastSyncedSequence ?? -1);
        rec.assert("two idle cycles produced zero sequences", after === baseline, `before=${baseline} after=${after}`);
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: gitConfigSync.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
