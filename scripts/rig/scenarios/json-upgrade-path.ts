/**
 * Upgrade compatibility: an already-bound legacy JSON workspace continues to
 * sync on the candidate build without being silently converted. Its fresh peer
 * uses genesis SQLite, proving the same executable can converge both authorities.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, fingerprintTree } from "../lib/convergence.js";
import {
  installLegacyJsonWorkspaceFixture,
  readDeviceStateAuthority,
  readDeviceSyncState,
} from "../lib/state-view.js";
import { createRecorder, errMsg } from "./harness.js";
import { bootstrapRigAccount, connectRigDeviceB, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

export const jsonUpgradePath: Scenario = {
  name: "json-upgrade-path",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await bootstrapRigAccount(ctx, rec);
      await rec.step("[A] seed existing workspace", async () => {
        await ctx.a.mkdirp(GUEST.workDir);
        await ctx.a.writeFile(`${GUEST.workDir}/legacy.txt`, "existing JSON workspace\n");
      });
      const workspaceId = await rec.step("[A] construct pre-candidate JSON authority fixture", async () => {
        const id = await installLegacyJsonWorkspaceFixture(ctx.a, GUEST.workDir, ctx.apiUrl);
        const authority = await readDeviceStateAuthority(ctx.a, GUEST.workDir);
        rec.assert("A starts with JSON authority", authority.format === "json", JSON.stringify(authority));
        return id;
      });

      await rec.step("[A] existing JSON workspace first sync", async () => {
        await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
        const authority = await readDeviceStateAuthority(ctx.a, GUEST.workDir);
        const state = await readDeviceSyncState(ctx.a, GUEST.workDir);
        rec.assert("A remains JSON after sync", authority.format === "json", JSON.stringify(authority));
        rec.assert("JSON authority advanced normally", state.lastSyncedSequence > 0, `sequence ${state.lastSyncedSequence}`);
      });

      await connectRigDeviceB(ctx, rec);
      await rec.step("[B] fresh SQLite peer joins", async () => {
        await ctx.b.mkdirp(GUEST.workDir);
        await ctx.b.rbox([
          "track", GUEST.workDir, "--workspace", workspaceId, "--remote", ctx.apiUrl,
          "--git", "false",
        ], { cwd: GUEST.workDir });
        await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        const authority = await readDeviceStateAuthority(ctx.b, GUEST.workDir);
        rec.assert("B uses genesis SQLite authority", authority.originKind === "genesis", JSON.stringify(authority));
      });

      await rec.step("[B→A] mixed authorities keep syncing", async () => {
        await ctx.b.writeFile(`${GUEST.workDir}/from-b.txt`, "mixed authority round trip\n");
        await ctx.b.rbox(["sync"], { cwd: GUEST.workDir });
        await ctx.a.rbox(["sync"], { cwd: GUEST.workDir });
        const [a, b, authorityA] = await Promise.all([
          fingerprintTree(ctx.a, GUEST.workDir),
          fingerprintTree(ctx.b, GUEST.workDir),
          readDeviceStateAuthority(ctx.a, GUEST.workDir),
        ]);
        const diff = compareFingerprints(a, b);
        rec.assert("JSON and SQLite peers converge", diff.identical, diff.identical
          ? `${b.fileCount} files`
          : `onlyA=${diff.onlyInA.length} onlyB=${diff.onlyInB.length} differing=${diff.differing.length}`);
        rec.assert("A remains JSON after peer round trip", authorityA.format === "json", JSON.stringify(authorityA));
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: jsonUpgradePath.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
