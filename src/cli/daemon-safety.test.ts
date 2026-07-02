import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSafetyDelay, RboxDaemon } from "./daemon.js";

// Design 49: the safety scan heals DROPPED watcher events, and drops happen under
// churn — so quiet intervals back the scan off (60s → 5m cap) instead of
// stat-sweeping every tracked file each minute on an idle machine, forever.

const FLOOR = 60_000;
const CAP = 5 * 60_000;
const quiet = { watcherLive: true, churned: false };

test("nextSafetyDelay doubles quiet intervals and caps at 5m", () => {
  expect(nextSafetyDelay(FLOOR, quiet)).toBe(120_000);
  expect(nextSafetyDelay(120_000, quiet)).toBe(240_000);
  expect(nextSafetyDelay(240_000, quiet)).toBe(CAP); // 480s would overshoot — capped
  expect(nextSafetyDelay(CAP, quiet)).toBe(CAP);
});

test("churn snaps the delay back to the 60s floor from any level", () => {
  expect(nextSafetyDelay(CAP, { watcherLive: true, churned: true })).toBe(FLOOR);
  expect(nextSafetyDelay(120_000, { watcherLive: true, churned: true })).toBe(FLOOR);
});

test("no live watcher never backs off — the periodic scan IS the sync mechanism there", () => {
  expect(nextSafetyDelay(FLOOR, { watcherLive: false, churned: false })).toBe(FLOOR);
  expect(nextSafetyDelay(CAP, { watcherLive: false, churned: false })).toBe(FLOOR);
});

interface SafetyInternals {
  startWatcherFn: (
    root: string,
    matcher: unknown,
    cb: (events: unknown[]) => void,
    opts?: { onError?: (err: Error) => void }
  ) => Promise<{ close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  churnSinceSafety: boolean;
  watcherHealthy: boolean;
  safetyDelay: number;
  pumping: boolean;
  want: { push: boolean };
  watcher?: { close(): Promise<void> };
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
}

function makeDaemon(root: string): SafetyInternals {
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  return new RboxDaemon(root, cfg as never, {} as never) as unknown as SafetyInternals;
}

test("watcher events mark churn AND pull a backed-off timer forward (codex R1)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let deliver: ((events: unknown[]) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, cb) => {
    deliver = cb;
    return Promise.resolve({ close: async () => {} });
  };
  // Block the pump so delivering an event exercises ONLY the callback's
  // bookkeeping (churn flag + queued want) — this minimal daemon has no deps.
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.churnSinceSafety).toBe(false); // boots quiet
    // Simulate a fully backed-off idle daemon, then a churn storm at T+1s.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    deliver!([{ type: "update", path: path.join(root, "a.txt") }]);
    expect(daemon.churnSinceSafety).toBe(true); // churn recorded for the next tick
    expect(daemon.want.push).toBe(true); // hot path still queued the push
    // The codex R1 repro: the flag alone would let a drop from THIS storm wait out
    // the armed 5m timer. The timer must be re-armed at the floor immediately.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a post-init watcher error revokes trust: backoff treats the watcher as dead (codex R1)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    onError = opts?.onError;
    return Promise.resolve({ close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.watcherHealthy).toBe(true);
    // Simulate a fully backed-off idle daemon at the moment the stream dies.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    onError!(new Error("FSEvents stream died"));
    expect(daemon.watcherHealthy).toBe(false); // …and stays false: trust is not restored
    // codex R2: the error must also pull the ARMED backed-off timer forward — the
    // flag alone would wait out the remaining (up to 5m) timeout.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
    // With trust revoked, quiet intervals must NOT back off — the scan is now the
    // only healer for anything the (possibly dead) watcher misses.
    expect(nextSafetyDelay(CAP, { watcherLive: daemon.watcher !== undefined && daemon.watcherHealthy, churned: false })).toBe(FLOOR);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
