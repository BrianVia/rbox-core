import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { packUploadConfig } from "./remote/blob-batch/config.js";
import { fillVersion } from "./remote/blob-batch/config.js";
import { preflightDeltaEnabled } from "./sync-recovery.js";
import { mdeWritePolicy } from "./e2ee-remote.js";
import { fuseEnabled } from "./publish-pipeline/shared.js";
import { noopElisionEnabled } from "./sync-state-elision.js";
import { saveDeltaEnabled } from "./sync-state-delta.js";
import { configuredWorkers, resetConfiguredWorkersCacheForTests } from "../engine/crypto-pool/config.js";

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
  "RBOX_SAVE_NOOP_ELIDE", "RBOX_SAVE_DELTA",
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
  test("kill switches select the legacy arms", () => {
    process.env.RBOX_PREFLIGHT_DELTA = "0";
    process.env.RBOX_MDE_DELTA = "0";
    process.env.RBOX_BLOB_PACK = "0";
    process.env.RBOX_CRYPTO_FUSE = "0";
    process.env.RBOX_SAVE_NOOP_ELIDE = "0";
    process.env.RBOX_SAVE_DELTA = "0";
    expect(saveDeltaEnabled()).toBe(false);
    expect(preflightDeltaEnabled()).toBe(false);
    expect(mdeWritePolicy().delta).toBe(false);
    expect(packUploadConfig().enabled).toBe(false);
    expect(fuseEnabled()).toBe(false);
    expect(noopElisionEnabled()).toBe(false);
  });
});
