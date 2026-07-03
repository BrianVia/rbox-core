/**
 * `chaos-restart` (design 56 §9) — a device that CRASHES mid-push must recover
 * cleanly: no data loss, no guard trips, no corrupted local state, eventual
 * convergence. This is the partial-state / resume regression net.
 *
 *   provision (git-sync OFF; seed a corpus wide enough that a throttled push runs
 *     >5s), push:false so we control the push timing ourselves
 *   → A: start `rbox push` DETACHED (nohup, RBOX_UPLOAD_CONCURRENCY=4 to widen the
 *     window) → poll /work/push.log until the UPLOAD phase is clearly underway
 *   → HARD-KILL the guest mid-push (`container kill --signal KILL rig-dev-a`) — a
 *     crash, not a polite stop
 *   → `container start rig-dev-a` again (config + writable layer survive) → wait for
 *     exec-ability → probe RBOX_API came back from the container config
 *   → A: re-run `rbox push` FOREGROUND (allowFail:false) — design 23 upload receipts
 *     + idempotent commit make the resume clean; assert it completes with NO guard
 *     refusal text
 *   → assert A's `.rbox/state.json` parses (the crash didn't corrupt local state)
 *   → B: pull → assert SYNCED-SET convergence via lib/manifest-check.ts (exactly as
 *     conductor-initial-sync does: A manifest == B manifest, B disk materializes B's
 *     manifest, B has no unsynced extras) → teardown 2xx.
 *
 * KILL VARIANT SHIPPED: VM-kill (`container kill`). The spec's fallback (in-guest
 * `pkill -9 -f 'index.ts push'`) is only used if the runtime wedges on kill+start;
 * whichever ran is recorded in the report's step names + the run.log.
 *
 * Convergence is defined over each device's DECRYPTED last-synced manifest, NOT
 * raw-tree byte identity (see lib/manifest-check.ts) — git-sync is disabled so the
 * whole corpus is plain-file sync.
 */
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
import { createRecorder, errMsg } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** Guest path for the detached push's redirected stdout+stderr. Under /work (the
 *  container-writable overlay), NOT the RO src/scripts mounts. */
const PUSH_LOG = "/work/push.log";

/** Wide-push seeding: enough ~256KiB random files that a throttled (concurrency-4)
 *  push against the real dev worker runs well past 5s, giving a broad window to crash
 *  inside. Random content = genuinely-missing blobs (a true cold push, no convergent
 *  dedup shortcut). Sized to stay well under the free-plan 2GiB cap. */
const WIDE_FILES = 400;
const WIDE_FILE_BYTES = 256 * 1024;

/** Throttle the push HARD so the upload window is wide (design 34 rail is 16; we go
 *  lower on purpose here — a slow push is easier to crash mid-flight). */
const CHAOS_UPLOAD_CONCURRENCY = "4";

/** How long to wait for the upload phase to show up in push.log before giving up on
 *  catching the crash mid-flight. The throttled push makes this reliable. */
const UNDERWAY_TIMEOUT_MS = 60_000;
/** How long to wait for the restarted guest to accept `exec` again. */
const EXEC_READY_TIMEOUT_MS = 60_000;

/**
 * Is an `rbox push` clearly UNDERWAY in its UPLOAD phase, per its redirected log? The
 * non-TTY spinner (spinner.ts) prints `pushing…` then throttled `  <label>` lines;
 * the upload label is `uploading <pct>% (<done>/<total>)` (status-view.progressLabel).
 * We key off `done >= 1` (not the percent — the first upload tick renders `0% (1/N)`),
 * so this is true only once at least one blob PUT is in flight — the meaningful crash
 * point (partial blobs uploaded → the resume must skip them via design-23 receipts).
 * PURE (unit-tested).
 */
export function pushUnderway(log: string): boolean {
  for (const line of log.split("\n")) {
    const m = /uploading\s+\d+%\s+\((\d[\d,]*)\//.exec(line);
    if (m && Number(m[1]!.replace(/,/g, "")) >= 1) return true;
  }
  return false;
}

/** True if push/pull output carries any mass-delete/mass-reconcile guard refusal — a
 *  clean resume must never trip a guard. PURE. */
export function hasGuardRefusal(text: string): boolean {
  return /--allow-mass-delete|mass-delete guard|--allow-mass-reconcile/i.test(text);
}

/** Seed `count` files of `bytes` random bytes each under `dir/chaos/` in the guest, via
 *  a single `dd`-per-file shell loop (ubuntu:24.04 coreutils). Non-deterministic content
 *  is fine + desirable here (no cross-run blob dedup). */
async function seedWideCorpus(ctx: RigCtx, dir: string, count: number, bytes: number): Promise<number> {
  const bs = 1024;
  const cnt = Math.round(bytes / bs);
  const script =
    `mkdir -p '${dir}/chaos' && i=0; while [ $i -lt ${count} ]; do ` +
    `dd if=/dev/urandom of='${dir}/chaos/f'$i'.bin' bs=${bs} count=${cnt} status=none; i=$((i+1)); done && ` +
    `find '${dir}/chaos' -type f | wc -l`;
  const r = await ctx.a.exec(["sh", "-c", script]);
  return Number(r.stdout.trim()) || 0;
}

export const chaosRestart: Scenario = {
  name: "chaos-restart",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);

    try {
      // Onboard an EMPTY workspace (git-sync OFF → plain-file sync, clean manifest
      // convergence). We seed AFTER onboarding: `rbox init --new` does a first-sync push
      // (init-cmd.ts), so seeding before it would upload the whole corpus during init and
      // leave the detached push with nothing to crash inside. Seeding after → the detached
      // push is the FIRST to upload these blobs, giving a real mid-upload crash window.
      await provisionPair(ctx, rec, { push: false, pull: false, initFlags: ["--git", "false"] });

      // Seed the wide corpus onto A's (already-onboarded) workspace.
      await rec.step("[A] seed wide corpus (post-onboard)", async () => {
        const n = await seedWideCorpus(ctx, GUEST.workDir, WIDE_FILES, WIDE_FILE_BYTES);
        ctx.log(`  seeded ${n} × ${WIDE_FILE_BYTES}B random files (~${Math.round((n * WIDE_FILE_BYTES) / 1024 / 1024)}MiB)`);
        rec.assert("wide corpus seeded", n === WIDE_FILES, `${n} files`);
      });

      // 1. Start the push DETACHED, redirected to push.log, throttled wide.
      await rec.step("[A] start push (detached, throttled)", async () => {
        await ctx.a.exec(["sh", "-c", `rm -f '${PUSH_LOG}'`], { allowFail: true });
        await ctx.a.pushDetached(GUEST.workDir, PUSH_LOG, { RBOX_UPLOAD_CONCURRENCY: CHAOS_UPLOAD_CONCURRENCY });
      });

      // 2. Poll push.log until the UPLOAD phase is clearly underway.
      const caughtUnderway = await rec.step("[A] poll push.log until upload underway", async () => {
        const out = await ctx.waitForPath(ctx.a, PUSH_LOG, (c) => c !== undefined && pushUnderway(c), UNDERWAY_TIMEOUT_MS);
        ctx.log(`  push underway=${out.ok} after ${out.attempts} polls (${out.elapsedMs}ms)`);
        return out.ok;
      });
      rec.assert("push caught mid-upload before kill", caughtUnderway, caughtUnderway ? "upload in flight" : `no upload progress within ${UNDERWAY_TIMEOUT_MS}ms — widen the corpus`);

      // 3. HARD-KILL the guest mid-push (SIGKILL, no grace — a crash).
      await rec.step("[A] HARD-KILL guest mid-push (container kill)", async () => {
        const killed = await ctx.a.hardKill();
        rec.assert("guest killed (SIGKILL)", killed, killed ? "container kill --signal KILL" : "kill returned nonzero (already stopped?)");
        if (!killed) throw new Error("container kill did not succeed — cannot simulate the crash");
      });

      // 4. Restart the SAME guest (config + writable layer survive) + wait exec-ready.
      await rec.step("[A] restart guest + wait exec-ready", async () => {
        await ctx.a.restart();
        const ready = await ctx.a.waitExecReady(EXEC_READY_TIMEOUT_MS);
        if (!ready) throw new Error(`guest did not accept exec within ${EXEC_READY_TIMEOUT_MS}ms after restart`);
      });

      // 4b. Probe the container config came back (RBOX_API present + non-prod). This is
      //     the env the CLI reads; it must survive the kill via the container config.
      await rec.step("[A] probe RBOX_API survived restart", async () => {
        const env = (await ctx.a.exec(["printenv", "RBOX_API"], { allowFail: true })).stdout.trim();
        rec.assert("RBOX_API restored from container config", env === ctx.apiUrl, env ? `RBOX_API=${env}` : "RBOX_API unset after restart");
        if (env !== ctx.apiUrl) throw new Error(`RBOX_API did not survive restart (got ${JSON.stringify(env)})`);
      });

      // 4c. Local state not corrupted by the crash: if state.json exists it must be
      //     valid JSON (a half-written file is the corruption we're guarding against).
      await rec.step("[A] state.json intact after crash", async () => {
        const raw = await ctx.a.readFileIfExists(`${GUEST.workDir}/.rbox/state.json`);
        if (raw === undefined) {
          rec.assert("A state.json not corrupted (absent — no commit before crash)", true, "no state.json yet");
          return;
        }
        let parseOk = true;
        try {
          JSON.parse(raw);
        } catch {
          parseOk = false;
        }
        rec.assert("A state.json parses (not corrupted by crash)", parseOk, parseOk ? `${raw.length}B valid JSON` : "state.json is not valid JSON — CRASH CORRUPTION");
        if (!parseOk) throw new Error("state.json corrupted by the crash");
      });

      // 5. Resume: re-run push FOREGROUND. The design-23 receipts + idempotent commit
      //    make this a clean resume — it must complete, with NO guard refusal.
      await rec.step("[A] resume push (foreground)", async () => {
        const res = await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
        const refusal = hasGuardRefusal(res.stderr + res.stdout);
        rec.assert("resume push exit 0", res.exitCode === 0, `exit ${res.exitCode}`);
        rec.assert("resume push tripped no guard", !refusal, refusal ? "guard refusal text present" : "no --allow-mass-delete / guard text");
      });

      // 6. B: pull.
      await rec.step("[B] pull", async () => {
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
      });

      // 7. SYNCED-SET convergence (same three checks as conductor-initial-sync): the
      //    source of truth is each device's DECRYPTED last-synced manifest, NOT raw-tree
      //    byte identity.
      await rec.step("synced-set convergence A vs B (manifest ∩ disk)", async () => {
        const statePath = `${GUEST.workDir}/.rbox/state.json`;
        const [stateA, stateB, fpB] = await Promise.all([
          ctx.a.readFile(statePath),
          ctx.b.readFile(statePath),
          fingerprintTree(ctx.b, GUEST.workDir),
        ]);
        const manA = canonicalManifest(parseManifestState(stateA));
        const manB = canonicalManifest(parseManifestState(stateB));

        const diff = compareManifests(manA, manB);
        rec.assert("synced set converged (A manifest == B manifest)", diff.identical, diff.identical ? `${manB.length} entries synced` : manifestDiffDetail(diff));

        const disk = verifyManifestOnDisk(manB, fpB);
        rec.assert("B disk materializes B manifest", disk.ok, disk.ok ? `${manB.length - disk.exemptCount} on-disk, ${disk.exemptCount} pruned-exempt` : diskCheckDetail(disk));

        const extras = findUnsyncedExtras(fpB, manB);
        rec.assert("B has no unsynced extras", extras.length === 0, extras.length === 0 ? `${fpB.fileCount} fingerprinted, all in manifest` : `${extras.length} extras (${extras.slice(0, 5).join(", ")})`);
      });

      await teardownAccount(ctx, rec);
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    }

    return finalizeReport({ scenario: chaosRestart.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
