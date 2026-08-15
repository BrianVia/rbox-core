/**
 * `git-join-ahead` — the design-166 v5 gate. B joins non-empty with one
 * fast-forwardable repo, one diverged repo, and one behind repo. The scenario
 * inspects B immediately after init's own finish sync, then proves publication,
 * A-only survival, record settlement, an idle cycle, and linked-source refusal.
 */
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import { readDeviceSyncState } from "../lib/state-view.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport, parsePairToken } from "./types.js";
import type { SyncState } from "../../../src/cli/sync-state-model.js";

const REPO = "repo";
const MIXED = "mixed";
const BEHIND = "behind";
const A_ONLY = `${REPO}/a-only-untracked.txt`;
/** A SECOND device identity inside guest B: `RBOX_HOME` relocates credentials,
 *  keystore and binding registry, so `connect` here enrolls a distinct device
 *  (design 231 §7.4: multiple devices may legitimately bind the same folder). */
const SECOND_DEVICE_HOME = "/work/second-device";
const SECOND_DEVICE_ENV = { RBOX_HOME: SECOND_DEVICE_HOME };

interface RepoRecordView { pending?: unknown; partial?: unknown; deferrals?: { apply?: unknown } }
interface SyncStateView {
  repoRecords?: Record<string, RepoRecordView>;
  gitPendingRemote?: SyncState["gitPendingRemote"];
  gitNeedsResolution?: SyncState["gitNeedsResolution"];
}

interface AdoptionStatus {
  phase?: string;
  fastForwarded?: string[];
  parked?: Array<{ repo?: string; ref?: string; reason?: string }>;
  retainedGit?: Array<{ repo?: string; refs?: string[]; location?: string }>;
  finishSync?: { attempted?: boolean; complete?: boolean; error?: string };
}

const repoPath = (rel: string) => `${GUEST.workDir}/${rel}`;

async function readSyncState(device: Device): Promise<SyncStateView> {
  return readDeviceSyncState(device, GUEST.workDir);
}

function recordSettled(state: SyncStateView, rel = REPO): boolean {
  const record = state.repoRecords?.[rel];
  return record !== undefined
    && record.pending === undefined
    && record.deferrals?.apply === undefined
    && record.partial == null
    && state.gitPendingRemote?.[rel] === undefined
    && state.gitNeedsResolution?.[rel] === undefined;
}

async function git(device: Device, rel: string, args: string[], allowFail = false) {
  return device.exec(["git", "-C", repoPath(rel), ...args], { allowFail });
}

async function head(device: Device, rel = REPO): Promise<string> {
  return (await git(device, rel, ["rev-parse", "HEAD"])).stdout.trim();
}

async function initRepo(device: Device, rel: string): Promise<void> {
  const dir = repoPath(rel);
  await device.exec(["sh", "-c", `set -eu
mkdir -p '${dir}'
git -C '${dir}' init -q -b main
git -C '${dir}' config user.name 'Rig Tester'
git -C '${dir}' config user.email 'rig@example.com'
printf 'base v1\n' > '${dir}/file.txt'
git -C '${dir}' add file.txt
git -C '${dir}' commit -qm initial`]);
}

async function seedGitRepos(device: Device): Promise<void> {
  for (const rel of [REPO, MIXED, BEHIND]) await initRepo(device, rel);
  // Git-untracked but rbox-tracked A state, deliberately removed from B's copy.
  await device.exec(["sh", "-c", `printf 'A only survives\n' > '${repoPath(A_ONLY)}'`]);
}

async function conflictSiblings(device: Device): Promise<string> {
  return (await device.exec(["sh", "-c", `find '${GUEST.workDir}' -path '${GUEST.workDir}/.rbox' -prune -o -name '*.conflict*' -print 2>/dev/null | LC_ALL=C sort`])).stdout.trim();
}

async function adoptionStatus(device: Device, root: string = GUEST.workDir, env?: Record<string, string>): Promise<AdoptionStatus> {
  const result = await device.rbox(["adopt", "status", root, "--json"], { cwd: root, env });
  return JSON.parse(result.stdout) as AdoptionStatus;
}

export const gitJoinAhead: Scenario = {
  name: "git-join-ahead",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    let aheadTip = "";
    let baseTip = "";
    let mixedATip = "";
    let mixedBTip = "";
    let behindATip = "";
    let workspaceId = "";

    try {
      const provisioned = await provisionPair(ctx, rec, {
        afterSeedA: seedGitRepos,
        pull: false, // init's own baseline + finish sync is the surface under test
        joinInitFlags: ["--adopt"],
        beforeJoinB: async () => {
          baseTip = await head(ctx.a);
          const tarB64 = (await ctx.a.exec(["sh", "-c", `tar -C '${GUEST.workDir}' -czf - ${REPO} ${MIXED} ${BEHIND} | base64`])).stdout;
          await ctx.b.mkdirp(GUEST.workDir);
          await ctx.b.exec(["sh", "-c", `base64 -d | tar -C '${GUEST.workDir}' -xzf -`], { stdin: tarB64 });
          await ctx.b.exec(["rm", "-f", repoPath(A_ONLY)]);

          // Eligible two-commit ahead branch plus untracked B content.
          await ctx.b.exec(["sh", "-c", `set -eu
printf 'edited on B\n' > '${repoPath(REPO)}/file.txt'
git -C '${repoPath(REPO)}' -c user.name=B -c user.email=b@example.com commit -qam 'B: edit file'
printf 'new on B\n' > '${repoPath(REPO)}/b-only.txt'
git -C '${repoPath(REPO)}' add b-only.txt
git -C '${repoPath(REPO)}' -c user.name=B -c user.email=b@example.com commit -qm 'B: add b-only'
printf 'untracked scratch\n' > '${GUEST.workDir}/scratch.txt'`]);
          aheadTip = await head(ctx.b);

          // Same old tip, then independent A/B commits: retained-only divergence.
          await ctx.b.exec(["sh", "-c", `printf 'mixed B\n' > '${repoPath(MIXED)}/file.txt' && git -C '${repoPath(MIXED)}' -c user.name=B -c user.email=b@example.com commit -qam 'mixed B'`]);
          mixedBTip = await head(ctx.b, MIXED);
          await ctx.a.exec(["sh", "-c", `printf 'mixed A\n' > '${repoPath(MIXED)}/file.txt' && git -C '${repoPath(MIXED)}' -c user.name=A -c user.email=a@example.com commit -qam 'mixed A'`]);
          mixedATip = await head(ctx.a, MIXED);

          // B keeps the copied old branch while A advances; B also has file-plane
          // additions and retained tag/stash state.
          await ctx.a.exec(["sh", "-c", `printf 'behind A\n' > '${repoPath(BEHIND)}/file.txt' && git -C '${repoPath(BEHIND)}' -c user.name=A -c user.email=a@example.com commit -qam 'behind A'`]);
          behindATip = await head(ctx.a, BEHIND);
          await ctx.b.exec(["sh", "-c", `set -eu
printf 'behind local addition\n' > '${repoPath(BEHIND)}/b-local.txt'
git -C '${repoPath(BEHIND)}' tag behind-retained-tag
printf 'stash bytes\n' > '${repoPath(BEHIND)}/stash.txt'
git -C '${repoPath(BEHIND)}' add stash.txt
git -C '${repoPath(BEHIND)}' stash push -qm 'behind retained stash'
printf 'behind local addition\n' > '${repoPath(BEHIND)}/b-local.txt'`]);

          // Publish A's divergent/advanced variants before B establishes phase 2.
          await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        },
      });
      workspaceId = provisioned.workspaceId;

      await rec.step("[B] init's own finish sync observes the complete v5 overlay", async () => {
        const status = await adoptionStatus(ctx.b);
        rec.assert("adoption locally complete", status.phase === "complete", JSON.stringify(status).slice(0, 800));
        rec.assert("init attempted and completed its ordinary finish sync", status.finishSync?.attempted === true && status.finishSync.complete === true, JSON.stringify(status.finishSync));
        rec.assert("journal reports exact main fast-forward", status.fastForwarded?.includes(`${REPO}:refs/heads/main`) === true, JSON.stringify(status.fastForwarded));
        rec.assert("B HEAD is exact journaled ahead tip", (await head(ctx.b)) === aheadTip, `B=${await head(ctx.b)} ahead=${aheadTip}`);
        rec.assert("B keeps newer tracked bytes", (await ctx.b.readFile(`${repoPath(REPO)}/file.txt`)).trim() === "edited on B");
        rec.assert("B keeps committed addition", (await ctx.b.readFile(`${repoPath(REPO)}/b-only.txt`)).trim() === "new on B");
        rec.assert("B keeps untracked scratch", (await ctx.b.readFile(`${GUEST.workDir}/scratch.txt`)).trim() === "untracked scratch");
        rec.assert("A-only-in-repo file materialized from baseline", (await ctx.b.readFile(repoPath(A_ONLY))).trim() === "A only survives");
        rec.assert("no conflict siblings after init", await conflictSiblings(ctx.b) === "", await conflictSiblings(ctx.b));
        rec.assert("eligible repo record settled immediately", recordSettled(await readSyncState(ctx.b)), JSON.stringify((await readSyncState(ctx.b)).repoRecords?.[REPO] ?? {}));

        rec.assert("diverged target stays on A", (await head(ctx.b, MIXED)) === mixedATip, `live=${await head(ctx.b, MIXED)} A=${mixedATip}`);
        const retainedMixed = `${GUEST.workDir}/.rbox/adopt/stash/${MIXED}`;
        const retainedMixedTip = (await ctx.b.exec(["git", "-C", retainedMixed, "rev-parse", "main"])).stdout.trim();
        rec.assert("diverged B tip remains in retained stash", retainedMixedTip === mixedBTip, `retained=${retainedMixedTip} B=${mixedBTip}`);
        const liveHasMixedB = await git(ctx.b, MIXED, ["cat-file", "-e", `${mixedBTip}^{commit}`], true);
        rec.assert("diverged B object was not fetched", liveHasMixedB.exitCode !== 0);

        rec.assert("behind target stays on A's advanced tip", (await head(ctx.b, BEHIND)) === behindATip, `live=${await head(ctx.b, BEHIND)} A=${behindATip}`);
        rec.assert("behind file-plane addition overlays", (await ctx.b.readFile(`${repoPath(BEHIND)}/b-local.txt`)).trim() === "behind local addition");
        const retainedBehind = status.retainedGit?.find((repo) => repo.repo === BEHIND);
        rec.assert("behind tag and stash are retained-only and reported", retainedBehind?.refs?.includes("refs/stash") === true && retainedBehind.refs.includes("refs/tags/behind-retained-tag"), JSON.stringify(retainedBehind));
      });

      await rec.step("[init B→A] init finish publication converges eligible repo without a healing B push", async () => {
        await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("A fast-forwarded to B's ahead tip", (await head(ctx.a)) === aheadTip, `A=${await head(ctx.a)} ahead=${aheadTip}`);
        const reflog = (await git(ctx.a, REPO, ["reflog", "--format=%H"])).stdout;
        rec.assert("A reflog retains the base lineage", reflog.includes(baseTip), reflog.split("\n").slice(0, 4).join(","));
        rec.assert("A received B tracked content", (await ctx.a.readFile(`${repoPath(REPO)}/file.txt`)).trim() === "edited on B");
        rec.assert("A received B committed addition", (await ctx.a.readFile(`${repoPath(REPO)}/b-only.txt`)).trim() === "new on B");
        rec.assert("A received B scratch", (await ctx.a.readFile(`${GUEST.workDir}/scratch.txt`)).trim() === "untracked scratch");
        rec.assert("A-only-in-repo file survived remotely", (await ctx.a.readFile(repoPath(A_ONLY))).trim() === "A only survives");
        rec.assert("no conflict siblings on A", await conflictSiblings(ctx.a) === "", await conflictSiblings(ctx.a));
      });

      await rec.step("[B next push] A-only path is never manufactured as a deletion", async () => {
        await ctx.b.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        rec.assert("A-only file remains on B after next push", (await ctx.b.readFile(repoPath(A_ONLY))).trim() === "A only survives");
        rec.assert("A-only file remains on A after next pull", (await ctx.a.readFile(repoPath(A_ONLY))).trim() === "A only survives");
        rec.assert("still no conflict siblings", await conflictSiblings(ctx.b) === "" && await conflictSiblings(ctx.a) === "");
      });

      await rec.step("eligible records settle on both sides and stay settled for an idle cycle", async () => {
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
        let [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        rec.assert("A eligible record settled", recordSettled(sa), JSON.stringify(sa.repoRecords?.[REPO] ?? {}).slice(0, 400));
        rec.assert("B eligible record settled", recordSettled(sb), JSON.stringify(sb.repoRecords?.[REPO] ?? {}).slice(0, 400));
        rec.assert("A and B eligible HEADs equal", (await head(ctx.a)) === (await head(ctx.b)));

        await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
        [sa, sb] = await Promise.all([readSyncState(ctx.a), readSyncState(ctx.b)]);
        rec.assert("idle cycle keeps both eligible records settled", recordSettled(sa) && recordSettled(sb));
        rec.assert("idle cycle creates no conflict siblings", await conflictSiblings(ctx.a) === "" && await conflictSiblings(ctx.b) === "");
      });

      await rec.step("linked-worktree source is refused; its ordinary main clone adopts separately", async () => {
        const ordinaryRoot = `${GUEST.workDir}-ordinary-source`;
        const linkedRoot = `${GUEST.workDir}-linked-source`;
        const sameDeviceRoot = `${GUEST.workDir}-same-device-source`;
        await ctx.b.exec(["sh", "-c", `set -eu
rm -rf '${ordinaryRoot}' '${linkedRoot}' '${sameDeviceRoot}' '${SECOND_DEVICE_HOME}'
mkdir -p '${ordinaryRoot}' '${linkedRoot}' '${sameDeviceRoot}' '${SECOND_DEVICE_HOME}'
git clone -q '${repoPath(REPO)}' '${ordinaryRoot}/${REPO}'
git clone -q '${repoPath(REPO)}' '${sameDeviceRoot}/${REPO}'
git -C '${ordinaryRoot}/${REPO}' worktree add -q -B linked-source '${linkedRoot}/${REPO}'`]);
        const linkedHead = (await ctx.b.exec(["git", "-C", `${linkedRoot}/${REPO}`, "rev-parse", "HEAD"])).stdout.trim();
        const refused = await ctx.b.rbox(["init", "--workspace", workspaceId, "--no-interactive", "--adopt", "--remote", ctx.apiUrl], { cwd: linkedRoot, allowFail: true });
        rec.assert("linked source invocation refused", refused.exitCode !== 0);
        rec.assert("linked refusal message is exact", `${refused.stdout}\n${refused.stderr}`.includes("linked worktree not adopted — its history travels with its main clone"), `${refused.stdout}\n${refused.stderr}`.slice(0, 600));
        rec.assert("linked source HEAD is unchanged", (await ctx.b.exec(["git", "-C", `${linkedRoot}/${REPO}`, "rev-parse", "HEAD"])).stdout.trim() === linkedHead);
        rec.assert("linked source published no journal", (await ctx.b.exec(["test", "-f", `${linkedRoot}/.rbox/adopt/journal.json`], { allowFail: true })).exitCode !== 0);

        // Design 231 §7.4: the SAME (workspace, device) pair at a second root is an
        // ambiguous copy, whatever the source shape — B is already bound at /work/ws.
        const duplicate = await ctx.b.rbox(["init", "--workspace", workspaceId, "--no-interactive", "--adopt", "--remote", ctx.apiUrl], { cwd: sameDeviceRoot, allowFail: true });
        rec.assert("same-device second-root invocation refused", duplicate.exitCode !== 0, `${duplicate.stdout}\n${duplicate.stderr}`.slice(0, 600));
        rec.assert("ambiguous-binding refusal message is exact", `${duplicate.stdout}\n${duplicate.stderr}`.includes(`the same workspace and device binding also exists at ${GUEST.workDir}`), `${duplicate.stdout}\n${duplicate.stderr}`.slice(0, 600));

        // A DIFFERENT device may bind the same remote workspace, so the ordinary
        // clone adopts under a second identity enrolled in the same guest.
        const pairToken = parsePairToken((await ctx.a.rbox(["pair"])).stdout);
        await ctx.b.rbox(["connect", pairToken, "--remote", ctx.apiUrl], { env: SECOND_DEVICE_ENV, redact: [pairToken] });
        const ordinary = await ctx.b.rbox(["init", "--workspace", workspaceId, "--no-interactive", "--adopt", "--remote", ctx.apiUrl], { cwd: ordinaryRoot, env: SECOND_DEVICE_ENV, allowFail: true });
        rec.assert("self-contained main-clone invocation adopts normally", ordinary.exitCode === 0, `${ordinary.stdout}\n${ordinary.stderr}`.slice(0, 600));
        if (ordinary.exitCode === 0) rec.assert("ordinary source adoption completes", (await adoptionStatus(ctx.b, ordinaryRoot, SECOND_DEVICE_ENV)).phase === "complete");
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
