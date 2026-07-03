/**
 * `onboard-smoke` — the PR gate (design 56 §9). Zero → bootstrap → init → pair →
 * join → push(A) → pull(B), then assert byte-identical convergence and a clean
 * teardown. Generalizes `scripts/bench/savvy-two-host.sh`'s two-`$HOME` trick into
 * two real container-isolated devices against the deployed dev worker.
 *
 * Secrets (bootstrap secret, pairing token) are injected by ENV and expanded in a
 * guest shell, never assembled into an argv the rig logs.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, EMPTY_SHA256, fingerprintTree } from "../lib/convergence.js";
import { deleteAccount, readCredentials } from "../lib/account.js";
import type { AssertionResult, RigCtx, Scenario, ScenarioReport, StepResult } from "./types.js";
import { finalizeReport, parsePairToken } from "./types.js";

const CONCURRENCY = "16"; // design-34 WAF rail — stay below the 64-wide fan-out.
const SYMLINK = "rig-link";
const SYMLINK_TARGET = "rig-target.txt";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const onboardSmoke: Scenario = {
  name: "onboard-smoke",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const steps: StepResult[] = [];
    const assertions: AssertionResult[] = [];

    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      ctx.log(`▶ ${name}`);
      try {
        const out = await fn();
        steps.push({ name, ok: true, ms: Date.now() - t0 });
        return out;
      } catch (e) {
        steps.push({ name, ok: false, ms: Date.now() - t0, detail: errMsg(e) });
        throw e;
      }
    };
    const assert = (name: string, ok: boolean, detail?: string): void => {
      assertions.push({ name, ok, detail });
      ctx.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    };

    try {
      // 1. A: bootstrap login (secret via env expansion, never argv).
      await step("[A] login --bootstrap", async () => {
        await ctx.a.rboxShell(
          `bun ${GUEST.cliEntry} login --bootstrap "$RIG_BOOT" --remote "$RBOX_API" --no-interactive`,
          { env: { RIG_BOOT: ctx.bootstrapSecret }, redact: [ctx.bootstrapSecret] }
        );
      });

      // 2. A: seed ~100-file corpus + a deterministic symlink (historic shapes).
      await step("[A] seed corpus", async () => {
        await ctx.a.seedCorpus(GUEST.workDir, "tiny", 1);
        await ctx.a.exec(["sh", "-c", `cd '${GUEST.workDir}' && printf 'rig' > ${SYMLINK_TARGET} && ln -s ${SYMLINK_TARGET} ${SYMLINK}`]);
      });

      // 3. A: create the workspace, read its id from the on-disk binding.
      const workspaceId = await step("[A] init --new", async () => {
        await ctx.a.rbox(["init", "--new", "--no-interactive", "--remote", ctx.apiUrl], { cwd: GUEST.workDir });
        const cfg = JSON.parse(await ctx.a.readFile(`${GUEST.workDir}/.rbox/workspace.json`)) as { remoteWorkspaceId?: string };
        if (!cfg.remoteWorkspaceId) throw new Error("workspace.json missing remoteWorkspaceId");
        ctx.log(`  workspace ${cfg.remoteWorkspaceId}`);
        return cfg.remoteWorkspaceId;
      });

      // 4. A: push (throttled).
      await step("[A] push", async () => {
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
      });

      // 5. A: mint a pairing token.
      const pairToken = await step("[A] pair", async () => {
        const res = await ctx.a.rbox(["pair"]);
        return parsePairToken(res.stdout);
      });

      // 6. B: redeem the pairing token (token via env, never argv).
      await step("[B] login (redeem pair)", async () => {
        await ctx.b.rboxShell(`bun ${GUEST.cliEntry} login --remote "$RBOX_API" --no-interactive`, {
          env: { RBOX_PAIR_TOKEN: pairToken },
          redact: [pairToken],
        });
      });

      // 7. B: join the workspace + pull (throttled).
      await step("[B] init --workspace + pull", async () => {
        await ctx.b.mkdirp(GUEST.workDir);
        await ctx.b.rbox(["init", "--workspace", workspaceId, "--no-interactive", "--remote", ctx.apiUrl], { cwd: GUEST.workDir });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
      });

      // 8. Convergence assertions.
      const [fpA, fpB] = await step("fingerprint A + B", async () => Promise.all([fingerprintTree(ctx.a, GUEST.workDir), fingerprintTree(ctx.b, GUEST.workDir)]));
      const div = compareFingerprints(fpA, fpB);
      const divDetail = div.identical
        ? `${fpB.fileCount} files`
        : `onlyA=${div.onlyInA.length} onlyB=${div.onlyInB.length} diff=${div.differing.length} (${[...div.onlyInA, ...div.onlyInB, ...div.differing].slice(0, 5).join(", ")})`;
      assert("trees byte-identical (excl .rbox)", div.identical, divDetail);
      assert("file count > 90", fpB.fileCount > 90, `${fpB.fileCount}`);
      assert("empty file survived", fpB.entries.some((e) => e.kind === "file" && e.digest === EMPTY_SHA256));
      const link = fpB.entries.find((e) => e.kind === "symlink" && e.path === `./${SYMLINK}`);
      assert("symlink survived", link !== undefined && link.digest === `symlink:${SYMLINK_TARGET}`, link?.digest);

      // 9. Teardown (default-on): host-side DELETE /v1/account with A's own creds.
      if (ctx.keepAccount) {
        ctx.log("  (--keep-account) skipping teardown");
      } else {
        await step("teardown DELETE /v1/account", async () => {
          const creds = readCredentials(await ctx.a.readFile(`${GUEST.rboxHome}/credentials.json`));
          if (!creds.accountId) throw new Error("A credentials.json missing accountId");
          const del = await deleteAccount(ctx.apiUrl, creds.token, creds.accountId);
          assert("account delete 2xx", del.ok, `${del.status}`);
          if (!del.ok) throw new Error(`account delete ${del.status}: ${del.body.slice(0, 200)}`);
        });
      }
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: onboardSmoke.name, startedAt, finishedAt: new Date().toISOString(), steps, assertions });
  },
};
