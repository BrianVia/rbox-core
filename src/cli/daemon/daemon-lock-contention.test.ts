import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMetrics } from "../metrics.js";
import type { DaemonMutexResult } from "../sync-mutex.js";
import { lockStarvationPath, readLockStarvationEpisode } from "./daemon-operation-scheduler.js";
import { RboxDaemon } from "./daemon.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
let root: string;
let now = 0;
let lines: string[];
let originalLog: typeof console.log;

const cfg = {
  schema: "e2ee/v1" as const,
  remoteWorkspaceId: "ws_lock",
  projectId: "root",
  rootPath: "",
  remoteUrl: "https://example.invalid",
  token: "",
  deviceId: "dev_lock",
};

function daemon(): any {
  return new RboxDaemon(root, { ...cfg, rootPath: root }, { remote: {} as never, backoff: async () => {} }, {
    bootId: "boot-lock",
    now: () => now,
  }) as any;
}

const contention = (holderKey: string, warningReason: "foreign" | "identity-drift" | "stale-owned" | "fence" = "foreign"): DaemonMutexResult => ({
  status: "contended",
  holderKey,
  blockerKind: warningReason === "fence" ? "fence" : "foreign",
  warningReason,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lock-starvation-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  now = 0;
  lines = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
});

afterEach(async () => {
  console.log = originalLog;
  await fs.rm(root, { recursive: true, force: true });
});

test("starvation episode warns eventually once and counts at most once", async () => {
  const d = daemon();
  await d.scheduler.observeLockContention(contention(KEY_A));
  expect(await readLockStarvationEpisode(root)).toEqual({ holderKey: KEY_A, firstSeenAt: 0 });

  now = 15 * 60_000 - 1;
  await d.scheduler.observeLockContention(contention(KEY_A));
  expect(lines).toHaveLength(0);
  expect((await loadMetrics(root)).lockStarved).toBe(0);

  now++;
  await d.scheduler.observeLockContention(contention(KEY_A));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith("lock starved: reason=foreign age=15m");
  expect((await loadMetrics(root)).lockStarved).toBe(1);
  expect(await readLockStarvationEpisode(root)).toMatchObject({ holderKey: KEY_A, warnedAt: now, countedAt: now });

  now += 24 * 60 * 60_000;
  await d.scheduler.observeLockContention(contention(KEY_A));
  expect(lines).toHaveLength(1);
  expect((await loadMetrics(root)).lockStarved).toBe(1);
});

test("restart fences an already-counted episode and holder replacement starts a new one", async () => {
  const first = daemon();
  await first.scheduler.observeLockContention(contention(KEY_A, "identity-drift"));
  now = 15 * 60_000;
  await first.scheduler.observeLockContention(contention(KEY_A, "identity-drift"));

  const restarted = daemon();
  restarted.metrics = await loadMetrics(root);
  restarted.scheduler.lockStarvationEpisode = await readLockStarvationEpisode(root);
  await restarted.scheduler.observeLockContention(contention(KEY_A, "identity-drift"));
  expect(restarted.metrics.lockStarved).toBe(1);

  now += 1;
  await restarted.scheduler.observeLockContention(contention(KEY_B, "fence"));
  expect(await readLockStarvationEpisode(root)).toEqual({ holderKey: KEY_B, firstSeenAt: now });
  expect(restarted.metrics.lockStarved).toBe(1);
});

test("a persisted countedAt fence accepts a lost metric but never duplicates it", async () => {
  await fs.writeFile(lockStarvationPath(root), JSON.stringify({
    holderKey: KEY_A, firstSeenAt: 0, warnedAt: 15 * 60_000, countedAt: 15 * 60_000,
  }));
  now = 16 * 60_000;
  const restarted = daemon();
  restarted.metrics = await loadMetrics(root);
  restarted.scheduler.lockStarvationEpisode = await readLockStarvationEpisode(root);
  await restarted.scheduler.observeLockContention(contention(KEY_A));
  expect(restarted.metrics.lockStarved).toBe(0);
  expect((await loadMetrics(root)).lockStarved).toBe(0);
});

test("ordinary live contention and acquisition clear the private episode", async () => {
  const d = daemon();
  await d.scheduler.observeLockContention(contention(KEY_A));
  expect(await fs.stat(lockStarvationPath(root)).then(() => true)).toBe(true);
  await d.scheduler.observeLockContention({ status: "contended", holderKey: KEY_A, blockerKind: "live" });
  expect(await fs.stat(lockStarvationPath(root)).then(() => true, () => false)).toBe(false);

  await d.scheduler.observeLockContention(contention(KEY_B));
  await d.scheduler.clearLockStarvationEpisode();
  expect(await readLockStarvationEpisode(root)).toBeUndefined();
});

test("holder-aware tiers cap at 30s and reset on replacement", () => {
  const d = daemon();
  const delays = Array.from({ length: 10 }, () => d.scheduler.mutexDelay(KEY_A).delayMs);
  expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  expect(d.scheduler.mutexDelay(KEY_B)).toEqual({ delayMs: 250, shouldLog: true });
  d.scheduler.resetMutexBackoff();
  expect(d.scheduler.mutexDelay(KEY_A)).toEqual({ delayMs: 250, shouldLog: true });
});

test("capped wait is abortable and queued wakeups are rate limited", async () => {
  const d = daemon();
  const parked = d.scheduler.waitForMutexBackoff(30_000);
  d.requestPush();
  await parked;

  const rateLimited = d.scheduler.waitForMutexBackoff(30_000);
  d.requestPush();
  let resolved = false;
  void rateLimited.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);

  now = 2_000;
  d.requestPush();
  await rateLimited;
  expect(resolved).toBe(true);

  const shutdown = d.scheduler.waitForMutexBackoff(30_000);
  d.scheduler.abortMutexBackoff();
  await shutdown;
});

test("an older waiter cannot clear a newer backoff controller", async () => {
  const d = daemon();
  const older = d.scheduler.waitForMutexBackoff(30_000);
  const olderController = d.scheduler.mutexBackoffController as AbortController;
  const newer = d.scheduler.waitForMutexBackoff(30_000);
  const newerController = d.scheduler.mutexBackoffController as AbortController;

  olderController.abort();
  await older;
  expect(d.scheduler.mutexBackoffController).toBe(newerController);

  d.scheduler.abortMutexBackoff();
  await newer;
  expect(d.scheduler.mutexBackoffController).toBeUndefined();
});
