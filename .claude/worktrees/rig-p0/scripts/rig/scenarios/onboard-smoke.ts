/**
 * `onboard-smoke` — the PR gate (design 56 §9). Zero → bootstrap → init → pair →
 * join → push(A) → pull(B), then assert byte-identical convergence and a clean
 * teardown. Generalizes `scripts/bench/savvy-two-host.sh`'s two-`$HOME` trick into
 * two real container-isolated devices against the deployed dev worker.
 *
 * The provisioning handshake is the shared {@link provisionPair} preamble (P2); this
 * scenario keeps its own convergence assertions + host-side account teardown. Secrets
 * (bootstrap secret, pairing token) are injected by ENV and expanded in a guest shell,
 * never assembled into an argv the rig logs.
 */
import { GUEST } from "../lib/config.js";
import { compareFingerprints, EMPTY_SHA256, fingerprintTree } from "../lib/convergence.js";
import { createRecorder, errMsg } from "./harness.js";
import { provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

const SYMLINK = "rig-link";
const SYMLINK_TARGET = "rig-target.txt";

export const onboardSmoke: Scenario = {
  name: "onboard-smoke",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      // Provision: seed the ~100-file corpus + a deterministic symlink (historic
      // shapes), then the full bootstrap→push→pair→join→pull handshake.
      await provisionPair(ctx, rec, {
        seedShape: "tiny",
        seedNum: 1,
        afterSeedA: async (a) => {
          await a.exec(["sh", "-c", `cd '${GUEST.workDir}' && printf 'rig' > ${SYMLINK_TARGET} && ln -s ${SYMLINK_TARGET} ${SYMLINK}`]);
        },
      });

      // Convergence assertions.
      const [fpA, fpB] = await rec.step("fingerprint A + B", async () =>
        Promise.all([fingerprintTree(ctx.a, GUEST.workDir), fingerprintTree(ctx.b, GUEST.workDir)])
      );
      const div = compareFingerprints(fpA, fpB);
      const divDetail = div.identical
        ? `${fpB.fileCount} files`
        : `onlyA=${div.onlyInA.length} onlyB=${div.onlyInB.length} diff=${div.differing.length} (${[...div.onlyInA, ...div.onlyInB, ...div.differing].slice(0, 5).join(", ")})`;
      rec.assert("trees byte-identical (excl .rbox)", div.identical, divDetail);
      rec.assert("file count > 90", fpB.fileCount > 90, `${fpB.fileCount}`);
      rec.assert("empty file survived", fpB.entries.some((e) => e.kind === "file" && e.digest === EMPTY_SHA256));
      const link = fpB.entries.find((e) => e.kind === "symlink" && e.path === `./${SYMLINK}`);
      rec.assert("symlink survived", link !== undefined && link.digest === `symlink:${SYMLINK_TARGET}`, link?.digest);

      // Teardown (default-on): host-side DELETE /v1/account with A's own creds.
      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: onboardSmoke.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
