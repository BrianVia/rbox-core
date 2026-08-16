/** Released 1.11.4 → candidate one-way state-authority compatibility proof. */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, fingerprintTree } from "../lib/convergence.js";
import { readDeviceStateAuthority } from "../lib/state-view.js";
import type { Device } from "../lib/device.js";
import { createRecorder, errMsg } from "./harness.js";
import { bootstrapRigAccount, connectRigDeviceB, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** The released binary this scenario proves the candidate against. Exported so
 * the compatibility gate can assert the pin structurally instead of grepping
 * this file's source text for a version-shaped string. */
export const PINNED_RELEASED_VERSION = "1.11.4";
/** The negative probes: released commands that must refuse a Q workspace. */
export const RELEASED_NEGATIVE_PROBES = ["status", "sync", "doctor"] as const;
const releasedVersionPattern = new RegExp(`(?:^|\\s)v?${PINNED_RELEASED_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`);

const LEGACY_ROOT = "/work/legacy-json";
const MIXED_JSON_ROOT = "/work/mixed-legacy-json";
const Q_ROOT = "/work/candidate-q";
const TAKEOVER_HOME = "/root/rbox-takeover-home";
const TAKEOVER_RBOX_HOME = `${TAKEOVER_HOME}/.rbox`;
const TAKEOVER_ENV = { RBOX_HOME: TAKEOVER_HOME };

async function copyTree(source: Device, sourceRoot: string, target: Device, targetRoot: string): Promise<void> {
  const archive = (await source.exec([
    "sh", "-c", `tar -C '${sourceRoot}' -czf - . | base64`,
  ])).stdout;
  await target.exec(["mkdir", "-p", targetRoot]);
  await target.exec([
    "sh", "-c", `base64 -d | tar -C '${targetRoot}' -xzf -`,
  ], { stdin: archive });
}

async function rboxTreeDigest(device: Device, root: string): Promise<string> {
  const result = await device.exec([
    "sh", "-c",
    `find '${root}/.rbox' -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`,
  ]);
  return result.stdout;
}

function workspaceId(config: string): string {
  const id = (JSON.parse(config) as { remoteWorkspaceId?: string }).remoteWorkspaceId;
  if (!id) throw new Error("workspace fixture has no remoteWorkspaceId");
  return id;
}

export const dualBinaryState: Scenario = {
  name: "dual-binary-state",
  supportsDualBinary: true,
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      await rec.step("reset isolated dual-binary roots", async () => {
        const negatives = RELEASED_NEGATIVE_PROBES.map((command) => `/work/old-negative-${command}`);
        const roots = [LEGACY_ROOT, MIXED_JSON_ROOT, Q_ROOT, ...negatives];
        await Promise.all([
          ctx.a.exec(["rm", "-rf", ...roots]),
          ctx.b.exec(["rm", "-rf", TAKEOVER_HOME, ...roots]),
        ]);
      });
      await rec.step("pin released 1.11.4 on A and candidate on B", async () => {
        const [oldVersion, candidateVersion] = await Promise.all([
          ctx.a.rbox(["--version"]),
          ctx.b.rbox(["--version"]),
        ]);
        rec.assert(`A is released ${PINNED_RELEASED_VERSION}`, releasedVersionPattern.test(oldVersion.stdout.trim()), oldVersion.stdout.trim());
        rec.assert(`candidate version differs from ${PINNED_RELEASED_VERSION}`, !releasedVersionPattern.test(candidateVersion.stdout.trim()), candidateVersion.stdout.trim());
      });

      await bootstrapRigAccount(ctx, rec);
      await rec.step("[A/1.11.4] create, sync, start, and stop JSON root", async () => {
        await ctx.a.mkdirp(LEGACY_ROOT);
        await ctx.a.writeFile(`${LEGACY_ROOT}/from-old.txt`, "released 1.11.4 JSON authority\n");
        await ctx.a.rbox([
          "track", LEGACY_ROOT, "--no-interactive", "--remote", ctx.apiUrl, "--git", "false",
        ], { cwd: LEGACY_ROOT });
        await ctx.a.rbox(["sync"], { cwd: LEGACY_ROOT });
        await ctx.a.rbox(["start"], { cwd: LEGACY_ROOT });
        await ctx.a.rbox(["stop"], { cwd: LEGACY_ROOT });
        const authority = await readDeviceStateAuthority(ctx.a, LEGACY_ROOT);
        rec.assert("released root is JSON", authority.format === "json", JSON.stringify(authority));
      });
      const remoteId = workspaceId(await ctx.a.readFile(`${LEGACY_ROOT}/.rbox/workspace.json`));

      await rec.step("candidate reads exact released JSON bytes before explicit migration", async () => {
        const oldBytes = await ctx.a.readFile(`${LEGACY_ROOT}/.rbox/state.json`);
        await copyTree(ctx.a, GUEST.rboxHome, ctx.b, TAKEOVER_RBOX_HOME);
        await copyTree(ctx.a, LEGACY_ROOT, ctx.b, LEGACY_ROOT);
        const status = await ctx.b.rbox(["status"], { cwd: LEGACY_ROOT, env: TAKEOVER_ENV, allowFail: true });
        if (status.exitCode !== 0) throw new Error(`candidate status over released JSON exited ${status.exitCode}`);
        const candidateBytes = await ctx.b.readFile(`${LEGACY_ROOT}/.rbox/state.json`);
        rec.assert("candidate preserves released JSON bytes", candidateBytes === oldBytes, `old=${oldBytes.length} candidate=${candidateBytes.length}`);
        await ctx.b.rbox([
          "track", LEGACY_ROOT, "--workspace", remoteId, "--remote", ctx.apiUrl,
          "--git", "false",
        ], { cwd: LEGACY_ROOT, env: TAKEOVER_ENV });
        const trackedBytes = await ctx.b.readFile(`${LEGACY_ROOT}/.rbox/state.json`);
        rec.assert("candidate bind takeover preserves released JSON bytes", trackedBytes === oldBytes, `old=${oldBytes.length} tracked=${trackedBytes.length}`);
        await ctx.b.rbox(["sync"], { cwd: LEGACY_ROOT, env: TAKEOVER_ENV });
        const authority = await readDeviceStateAuthority(ctx.b, LEGACY_ROOT, TAKEOVER_ENV);
        rec.assert("candidate ordinary sync retains JSON authority", authority.format === "json", JSON.stringify(authority));
      });

      await rec.step("candidate explicitly migrates the stopped released root", async () => {
        await ctx.b.rbox(["migrate", LEGACY_ROOT], { cwd: LEGACY_ROOT, env: TAKEOVER_ENV });
        const authority = await readDeviceStateAuthority(ctx.b, LEGACY_ROOT, TAKEOVER_ENV);
        rec.assert("takeover publishes migration Q", authority.format === "authority-marker" && authority.originKind === "migration", JSON.stringify(authority));
      });

      await rec.step("isolated 1.11.4 Q probes refuse without mutation", async () => {
        for (const command of RELEASED_NEGATIVE_PROBES) {
          const snapshot = `/work/old-negative-${command}`;
          await copyTree(ctx.b, LEGACY_ROOT, ctx.a, snapshot);
          const before = await rboxTreeDigest(ctx.a, snapshot);
          const result = await ctx.a.rbox([command], { cwd: snapshot, allowFail: true });
          const after = await rboxTreeDigest(ctx.a, snapshot);
          const output = `${result.stdout}\n${result.stderr}`;
          rec.assert(`1.11.4 ${command} refuses Q`, result.exitCode !== 0 && /newer version|format.{0,12}new|too new/i.test(output), `exit=${result.exitCode} ${output.trim().slice(-300)}`);
          rec.assert(`1.11.4 ${command} leaves Q snapshot byte-identical`, before === after, `before=${before.length} after=${after.length}`);
        }
      });

      const mixedRemoteId = await rec.step("[A/1.11.4] create separate JSON interoperability root", async () => {
        await ctx.a.mkdirp(MIXED_JSON_ROOT);
        await ctx.a.writeFile(`${MIXED_JSON_ROOT}/from-old.txt`, "released JSON peer\n");
        await ctx.a.rbox([
          "track", MIXED_JSON_ROOT, "--no-interactive", "--remote", ctx.apiUrl, "--git", "false",
        ], { cwd: MIXED_JSON_ROOT });
        await ctx.a.rbox(["sync"], { cwd: MIXED_JSON_ROOT });
        return workspaceId(await ctx.a.readFile(`${MIXED_JSON_ROOT}/.rbox/workspace.json`));
      });

      await connectRigDeviceB(ctx, rec);
      await rec.step("released JSON and candidate Q roots converge through one remote", async () => {
        await ctx.b.mkdirp(Q_ROOT);
        await ctx.b.rbox([
          "track", Q_ROOT, "--workspace", mixedRemoteId, "--remote", ctx.apiUrl, "--git", "false",
        ], { cwd: Q_ROOT });
        const q = await readDeviceStateAuthority(ctx.b, Q_ROOT);
        rec.assert("candidate peer is genesis Q", q.format === "authority-marker" && q.originKind === "genesis", JSON.stringify(q));
        await ctx.b.rbox(["sync"], { cwd: Q_ROOT });
        const [oldTree, candidateTree] = await Promise.all([
          fingerprintTree(ctx.a, MIXED_JSON_ROOT),
          fingerprintTree(ctx.b, Q_ROOT),
        ]);
        const diff = compareFingerprints(oldTree, candidateTree);
        rec.assert("1.11.4 JSON and candidate Q converge", diff.identical, diff.identical
          ? `${candidateTree.fileCount} files`
          : `onlyOld=${diff.onlyInA.length} onlyCandidate=${diff.onlyInB.length} differing=${diff.differing.length}`);
      });

      await teardownAccount(ctx, rec);
    } catch (error) {
      ctx.log(`✗ scenario aborted: ${errMsg(error)}`);
    }

    return finalizeReport({
      scenario: dualBinaryState.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: rec.steps,
      assertions: rec.assertions,
    });
  },
};
