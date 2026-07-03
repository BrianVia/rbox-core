/**
 * `conductor-initial-sync` (design 56 §9) — the real-workload scale net. EXPLICIT-ONLY
 * (never part of `rig run all`): big first-push on A + join/pull on B against the dev
 * worker, over the ~33k-file conductor backup. SKIPPED (not FAIL) when the tarball
 * isn't staged.
 *
 * rig.ts stages the tarball into a content-addressed HOST cache dir, bind-mounted RO at
 * {@link GUEST.workloadMount} on device A (see prepareConductorWorkload). This scenario
 * copies that tree into A's fresh workspace, pushes (throttled to the design-34 WAF
 * rail), pulls on B, and asserts SYNCED-SET convergence, ZERO WAF 403s, and records
 * wall/phase timings. A manifest/upload cap that 413s is surfaced verbatim (the design
 * 56 §9 P3 bootstrap-plan-param trigger), not swallowed.
 *
 * Convergence is defined over each device's DECRYPTED last-synced manifest, NOT raw-tree
 * byte identity: rbox honors builtin ignores AND nested `.gitignore` files
 * (src/engine/ignore.ts), so both devices legitimately keep on-disk files that were never
 * synced (`.DS_Store`, `.env`, gitignored paths). We assert (1) A and B synced the same
 * set, (2) B's disk materializes B's manifest, (3) B carries no unsynced extras — see
 * lib/manifest-check.ts. (`.git`/`node_modules`/`.rbox` are still fingerprint-pruned;
 * git-sync is disabled so everything is plain-file sync.)
 */
import fs from "node:fs";
import path from "node:path";
import { GUEST } from "../lib/config.js";
import { fingerprintTree } from "../lib/convergence.js";
import {
  canonicalManifest,
  compareManifests,
  diskCheckDetail,
  findUnsyncedExtras,
  manifestDiffDetail,
  parseManifestState,
  verifyManifestOnDisk,
} from "../lib/manifest-check.js";
import { summarizeTail } from "../lib/capture.js";
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import { resolveWorkloadTar } from "../lib/workload.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport, skipReport } from "./types.js";

/** Recognise the free-plan caps the spec wants surfaced (manifest 16MiB / upload 2GiB). */
function capSignal(text: string): string | undefined {
  if (/\b413\b|payload too large|manifest .*cap|too large/i.test(text)) {
    return (text.match(/[^\n]*(413|too large|cap)[^\n]*/i)?.[0] ?? "cap hit").trim().slice(0, 200);
  }
  return undefined;
}

export const conductorInitialSync: Scenario = {
  name: "conductor-initial-sync",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    // Staged? rig.ts mounts the volume at workloadMount only when the tarball exists.
    const mounted = (await ctx.a.exec(["sh", "-c", `test -d '${GUEST.workloadMount}/workspaces' && echo yes || echo no`], { allowFail: true })).stdout.trim() === "yes";
    if (!mounted) {
      const tar = resolveWorkloadTar(ctx.flags);
      return skipReport(conductorInitialSync.name, `workload not staged (looked for tarball at ${tar}). Pass --workload-tar <path> or place the backup there.`);
    }

    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      // Onboard WITHOUT push/pull (we push the workload ourselves), git-sync OFF so the
      // whole tree is plain-file sync and thus byte-identically convergable.
      await provisionPair(ctx, rec, { push: false, pull: false, initFlags: ["--git", "false"] });

      // Copy the staged workspaces tree into A's fresh workspace (preserve attrs;
      // A's own `.rbox` from init is kept — the stale one was stripped at stage time).
      const fileCount = await rec.step("[A] copy workload → workspace", async () => {
        await ctx.a.exec(["sh", "-c", `cp -a '${GUEST.workloadMount}/workspaces/.' '${GUEST.workDir}/'`]);
        const n = (await ctx.a.exec(["sh", "-c", `find '${GUEST.workDir}' \\( -name .rbox -o -name .git -o -name node_modules \\) -prune -o -type f -print | wc -l`])).stdout.trim();
        ctx.log(`  workload copied — ${n} synced files (excl .git/node_modules/.rbox)`);
        return Number(n) || 0;
      });
      rec.assert("workload staged with files", fileCount > 0, `${fileCount} files`);

      // Big push (throttled). Surface a cap-413 verbatim rather than swallowing it.
      await rec.step("[A] push (initial sync)", async () => {
        const res = await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
        const cap = capSignal(res.stderr + res.stdout);
        if (cap) ctx.log(`  ⚠ push hit a plan cap (P3 trigger): ${cap}`);
        rec.assert("push succeeded (no cap 413)", res.exitCode === 0, res.exitCode === 0 ? "ok" : cap ?? (res.stderr || res.stdout).trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? `exit ${res.exitCode}`);
        if (res.exitCode !== 0) throw new Error("push failed — see assertion detail");
      });

      // Join-side pull on B (throttled).
      await rec.step("[B] pull (initial sync)", async () => {
        const res = await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY }, allowFail: true });
        const cap = capSignal(res.stderr + res.stdout);
        if (cap) ctx.log(`  ⚠ pull hit a plan cap: ${cap}`);
        rec.assert("pull succeeded", res.exitCode === 0, res.exitCode === 0 ? "ok" : cap ?? (res.stderr || res.stdout).trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? `exit ${res.exitCode}`);
        if (res.exitCode !== 0) throw new Error("pull failed — see assertion detail");
      });

      // Synced-set convergence (design 56 §9): the source of truth is each device's
      // DECRYPTED last-synced manifest at .rbox/state.json — NOT raw-tree byte identity
      // (rbox honors builtin + nested-.gitignore ignores, so on-disk trees legitimately
      // differ by ignored files). Three assertions: manifests match, B's disk
      // materializes B's manifest, B has no unsynced extras. The state files are a few MB.
      await rec.step("synced-set convergence A vs B (manifest ∩ disk)", async () => {
        const statePath = `${GUEST.workDir}/.rbox/state.json`;
        const [stateA, stateB, fpB] = await Promise.all([
          ctx.a.readFile(statePath),
          ctx.b.readFile(statePath),
          fingerprintTree(ctx.b, GUEST.workDir), // streaming — copes with ~33k files
        ]);
        const manA = canonicalManifest(parseManifestState(stateA));
        const manB = canonicalManifest(parseManifestState(stateB));

        // 1. A and B synced the SAME set (path + sha256 + size; mtime ignored).
        const diff = compareManifests(manA, manB);
        rec.assert("synced set converged (manifest ∩ disk)", diff.identical, diff.identical ? `${manB.length} entries synced` : manifestDiffDetail(diff));

        // 2. B's disk materializes B's manifest (pruned-path entries exempt + counted).
        const disk = verifyManifestOnDisk(manB, fpB);
        rec.assert("B disk materializes B manifest", disk.ok, disk.ok ? `${manB.length - disk.exemptCount} on-disk, ${disk.exemptCount} pruned-exempt` : diskCheckDetail(disk));

        // 3. No unsynced extras on B (started empty; anything off-manifest is suspicious).
        const extras = findUnsyncedExtras(fpB, manB);
        rec.assert("B has no unsynced extras", extras.length === 0, extras.length === 0 ? `${fpB.fileCount} fingerprinted, all in manifest` : `${extras.length} extras (${extras.slice(0, 5).join(", ")})`);
      });

      // Zero WAF 403s over the run window (design 34) — read the live server tail.
      const tailFile = path.join(ctx.runDir, "server-tail.jsonl");
      if (fs.existsSync(tailFile)) {
        const t = summarizeTail(fs.readFileSync(tailFile, "utf8"));
        rec.assert("zero WAF 403s", t.waf403s === 0, `${t.waf403s} × 403 · ${t.total} events · ${t.errors} errors`);
      } else {
        rec.assert("zero WAF 403s", true, "server-tail.jsonl absent (tail channel skipped) — not asserted");
      }

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: conductorInitialSync.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
