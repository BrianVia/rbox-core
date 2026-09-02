import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { packUploadConfig } from "./remote/blob-batch/config.js";
import { fillVersion } from "./remote/blob-batch/config.js";
import { pipelineEnabled, preflightDeltaEnabled } from "./sync-recovery.js";
import { mdeWritePolicy } from "./e2ee-remote.js";
import { fuseEnabled } from "./publish-pipeline/shared.js";
import { noopElisionEnabled } from "./sync-state-elision.js";
import { saveDeltaEnabled } from "./sync-state-delta.js";
import { configuredWorkers, resetConfiguredWorkersCacheForTests } from "../engine/crypto-pool/config.js";
import { gitHeldSkipComposerEnabled } from "./sync-git/held-blockers.js";
import { gitShadowEnabled } from "./sync-git/git-shadow.js";

/**
 * The defaults ledger: every performance/behavior flag's SHIPPED default,
 * pinned in one table. History (2026-07-27): four separate mechanisms were
 * found fully built but "shipped dark" behind opt-in env flags nobody
 * flipped (preflight delta, manifest deltas, blob packing, fused crypto) —
 * in one case hiding a 40x win for months. A new flag lands here as a
 * visible reviewed line, so a dark default is a decision someone typed,
 * not archaeology someone performs later.
 */
const FLAGS = [
  "RBOX_PREFLIGHT_DELTA", "RBOX_MDE_DELTA", "RBOX_MDE_SNAPSHOT", "RBOX_MDE_FAST_PULL",
  "RBOX_BLOB_PACK", "RBOX_PACK_STREAMS", "RBOX_BATCH_FILL", "RBOX_CRYPTO_FUSE",
  "RBOX_CRYPTO_WORKERS", "RBOX_GIT_PLAN_LAZY", "RBOX_GIT_APPLY_LAZY",
  "RBOX_SAVE_NOOP_ELIDE", "RBOX_SAVE_DELTA", "RBOX_GIT_HELD_SKIP_COMPOSER",
  "RBOX_PUBLISH_PIPELINE", "RBOX_GIT_SHADOW",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of FLAGS) { saved.set(key, process.env[key]); delete process.env[key]; }
});
afterEach(() => {
  for (const key of FLAGS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("defaults ledger — the shipped default of every perf/behavior flag", () => {
  test("publish lanes are ON by default", () => {
    expect(preflightDeltaEnabled()).toBe(true);
    expect(mdeWritePolicy()).toEqual({ delta: true, snapshot: true });
    expect(fillVersion()).toBe("v2");
  });
  test("the no-op state-save elision is ON by default", () => {
    expect(noopElisionEnabled()).toBe(true);
  });
  test("delta-staged content saves are ON by default", () => {
    expect(saveDeltaEnabled()).toBe(true);
  });
  test("the composer held-skip disjunct and its artifact digest are ON by default", () => {
    expect(gitHeldSkipComposerEnabled()).toBe(true);
  });
  test("blob packing is ON at 16 streams by default", () => {
    const pack = packUploadConfig();
    expect(pack.enabled).toBe(true);
    expect(pack.streams).toBe(16);
  });
  test("crypto: fused path ON, workers capped at 4 by default", () => {
    expect(fuseEnabled()).toBe(true);
    resetConfiguredWorkersCacheForTests();
    const workers = configuredWorkers(() => {}).count;
    expect(workers).toBeLessThanOrEqual(4);
    expect(workers).toBeGreaterThanOrEqual(1);
    resetConfiguredWorkersCacheForTests();
  });
  /**
   * RBOX_PUBLISH_PIPELINE — VERDICT: **OFF**, deliberately, not by neglect (#508).
   *
   * The design-98 overlapped encrypt/upload pipeline (`publish-pipeline/pipeline.ts`)
   * is fully built. It exists to hide the encrypt wall behind the upload wall. That
   * wall is not there to hide: measured 2026-09-01 on flat-meadow (the gigabit bench
   * host, `~/code` testbed, cold add of 5000 files / 143 MB, RBOX_LANE_TIMING=1),
   * the shipped serialized arm spends **encrypt 0.7s vs upload 34.7s** — encryption
   * is 2% of the push, so perfect overlap could win at most 2%. Design 115's
   * activation trigger (encrypt wall > upload wall on a >200 Mbps pipe) is NOT met
   * by a factor of ~48. The same-session pipeline arm did overlap the lanes
   * (enc 24.3s / up 24.1s, ~8.8s overlapped) but re-encrypted 497 blobs on resume,
   * and the earlier field pair on the real corpus measured it 71% SLOWER
   * (2026-07-13, 315s → 540s). Off is the reviewed answer, not archaeology.
   *
   * DELETION CONDITION: when a measured push shows the encrypt wall exceeding the
   * upload wall on a >200 Mbps pipe AND the pipeline arm beats the serialized arm
   * on the same corpus, flip this default. If instead the uploader ceiling rises
   * without the encrypt wall following, delete the flag and `pipeline.ts` with it —
   * a second upload implementation that can never win is cost with no owner.
   */
  test("the overlapped publish pipeline is OFF by default", () => {
    expect(pipelineEnabled()).toBe(false);
    process.env.RBOX_PUBLISH_PIPELINE = "1";
    expect(pipelineEnabled()).toBe(true);
  });
  /**
   * RBOX_GIT_SHADOW — VERDICT: **ON**, because the lane cannot change anything.
   *
   * #832 shadow mode (`docs/design/notes/2026-09-01-832-git-plane-evaluation.md`
   * §10) computes the boring `merge-base --is-ancestor` verdict beside the proof
   * plane's, records the cross-tab in `.rbox/state/git-shadow.json`, and logs
   * only disagreements. It mutates no ref, no index, no working tree — the one
   * write is the counter file — so the usual reason to ship a new lane dark does
   * not apply, and shipping it dark would produce the one thing the founder
   * ruling asked for less of: no data.
   *
   * The kill switch exists for cost, not for safety: the lane spends one
   * `merge-base` per moved branch plus, when the checked-out branch actually
   * fast-forwards, one `diff-index`. `shadowMs` (chain-timings.ts) is the leaf
   * that will say so, and §10's bound is <5% of pull wall.
   *
   * DELETION CONDITION: delete the flag, `git-shadow.ts`, its `shadowMs` leaf
   * and the doctor line after the one-week comparison table is produced and the
   * #832 decision is recorded — whichever way it goes. §10 names both endings
   * (promote ff-only to the ref plane's executor, or close #832 with this data
   * as the recorded negative result); neither ending keeps this lane. A shadow
   * that outlives its question is a second plane nobody owns.
   */
  test("git shadow mode is ON by default", () => {
    expect(gitShadowEnabled({})).toBe(true);
    expect(gitShadowEnabled({ RBOX_GIT_SHADOW: "0" })).toBe(false);
  });
  test("kill switches select the legacy arms", () => {
    process.env.RBOX_GIT_SHADOW = "0";
    expect(gitShadowEnabled()).toBe(false);
    process.env.RBOX_PREFLIGHT_DELTA = "0";
    process.env.RBOX_MDE_DELTA = "0";
    process.env.RBOX_BLOB_PACK = "0";
    process.env.RBOX_CRYPTO_FUSE = "0";
    process.env.RBOX_SAVE_NOOP_ELIDE = "0";
    process.env.RBOX_SAVE_DELTA = "0";
    process.env.RBOX_GIT_HELD_SKIP_COMPOSER = "0";
    expect(saveDeltaEnabled()).toBe(false);
    expect(gitHeldSkipComposerEnabled()).toBe(false);
    expect(preflightDeltaEnabled()).toBe(false);
    expect(mdeWritePolicy().delta).toBe(false);
    expect(packUploadConfig().enabled).toBe(false);
    expect(fuseEnabled()).toBe(false);
    expect(noopElisionEnabled()).toBe(false);
  });
});
