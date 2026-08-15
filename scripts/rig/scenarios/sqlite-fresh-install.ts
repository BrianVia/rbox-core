/**
 * Fresh 2.0 install: bind-only track publishes genesis before the first sync,
 * pair a second device, and prove both genesis authorities converge.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, fingerprintTree } from "../lib/convergence.js";
import { readDeviceSyncState, readDeviceStateAuthority } from "../lib/state-view.js";
import { createRecorder, errMsg } from "./harness.js";
import {
  assertGenesisAuthorityPair,
  bootstrapRigAccount,
  connectRigDeviceB,
  teardownAccount,
} from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

async function trackNew(ctx: RigCtx): Promise<string> {
  await ctx.a.rbox([
    "track", GUEST.workDir, "--no-interactive", "--remote", ctx.apiUrl, "--git", "false",
  ], { cwd: GUEST.workDir });
  const config = JSON.parse(await ctx.a.readFile(`${GUEST.workDir}/.rbox/workspace.json`)) as {
    remoteWorkspaceId?: string;
  };
  if (!config.remoteWorkspaceId) throw new Error("workspace.json missing remoteWorkspaceId");
  return config.remoteWorkspaceId;
}

export const sqliteFreshInstall: Scenario = {
  name: "sqlite-fresh-install",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await bootstrapRigAccount(ctx, rec);
      await rec.step("[A] seed fresh workspace", async () => {
        await ctx.a.mkdirp(GUEST.workDir);
        await ctx.a.writeFile(`${GUEST.workDir}/from-a.txt`, "fresh SQLite authority\n");
      });

      const workspaceId = await rec.step("[A] track (bind only)", async () => {
        const id = await trackNew(ctx);
        ctx.log(`  workspace ${id}`);
        return id;
      });

      await rec.step("[A] track publishes genesis before first sync", async () => {
        const authority = await readDeviceStateAuthority(ctx.a, GUEST.workDir);
        const state = await readDeviceSyncState(ctx.a, GUEST.workDir);
        rec.assert("A genesis precedes first sync", authority.originKind === "genesis"
          && state.lastSyncedSequence === 0, JSON.stringify({ authority, sequence: state.lastSyncedSequence }));
      });

      await rec.step("[A] first sync", async () => {
        await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
      });

      await connectRigDeviceB(ctx, rec);
      await rec.step("[B] track existing workspace", async () => {
        await ctx.b.mkdirp(GUEST.workDir);
        await ctx.b.rbox([
          "track", GUEST.workDir, "--workspace", workspaceId, "--remote", ctx.apiUrl,
          "--git", "false",
        ], { cwd: GUEST.workDir });
      });
      await rec.step("[B] track publishes genesis + first sync", async () => {
        const authority = await readDeviceStateAuthority(ctx.b, GUEST.workDir);
        rec.assert("B genesis precedes first sync", authority.originKind === "genesis", JSON.stringify(authority));
        await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
      });

      await assertGenesisAuthorityPair(ctx, rec);
      await rec.step("fresh devices converge", async () => {
        const [a, b] = await Promise.all([
          fingerprintTree(ctx.a, GUEST.workDir),
          fingerprintTree(ctx.b, GUEST.workDir),
        ]);
        const diff = compareFingerprints(a, b);
        rec.assert("fresh SQLite devices converge", diff.identical, diff.identical
          ? `${b.fileCount} files`
          : `onlyA=${diff.onlyInA.length} onlyB=${diff.onlyInB.length} differing=${diff.differing.length}`);
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: sqliteFreshInstall.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
