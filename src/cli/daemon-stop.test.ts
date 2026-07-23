import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DAEMON_HEARTBEAT_FUTURE_SKEW_MS, daemonPidPath, daemonRuntimeDir, stopDaemon } from "./daemon-control.js";
import { AMBIENT_STATUS_STALE_MS } from "./daemon/ambient-status.js";
import { createDaemonShutdownHandler, type DaemonShutdownClock } from "./daemon/daemon.js";
import { RBOX_VERSION } from "./version.js";

let home: string;
let root: string;
const stableStartToken = async () => "process-start";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-stop-daemon-"));
  process.env.RBOX_HOME = home;
  root = path.join(home, "workspace");
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonPidPath(root), "v2 4242 boot\n");
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

test("stopDaemon waits for confirmed exit before removing the pidfile", async () => {
  const signals: string[] = [];
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    waitForExit: async () => {
      expect(await fs.readFile(daemonPidPath(root), "utf8")).toContain("4242");
      return true;
    },
    log: () => {},
  });
  expect(signals).toEqual(["SIGTERM"]);
  await expect(fs.readFile(daemonPidPath(root), "utf8")).rejects.toThrow();
});

test("stopDaemon escalates only after a same-boot closed-gate non-critical witness", async () => {
  const signals: string[] = [];
  let waits = 0;
  const logs: string[] = [];
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, bootId: "boot", state: "syncing", heartbeatAt: new Date().toISOString(),
      sequence: 1, lastSyncedAt: null, shutdown: { gateClosed: true },
    } }),
    log: (line) => void logs.push(line),
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(logs.join("\n")).toContain("sending SIGKILL");
  await expect(fs.readFile(daemonPidPath(root), "utf8")).rejects.toThrow();
});

test("stopDaemon passes the exact 60-second default to graceful wait", async () => {
  const waits: number[] = [];
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    waitForExit: async (_pid, timeout) => { waits.push(timeout); return true; },
    log: () => {},
  });
  expect(waits).toEqual([60_000]);
});

test("stopDaemon retains an ABA-replaced versioned pid record", async () => {
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    waitForExit: async () => {
      await fs.writeFile(daemonPidPath(root), "v2 4242 replacement-boot\n");
      return true;
    },
    log: () => {},
  });
  expect(await fs.readFile(daemonPidPath(root), "utf8")).toBe("v2 4242 replacement-boot\n");
});

test("stopDaemon retains the pidfile when killed process cannot be confirmed dead", async () => {
  await expect(stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    forceKill: () => {},
    processStartToken: stableStartToken,
    waitForExit: async () => false,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, bootId: "boot", state: "syncing", heartbeatAt: new Date().toISOString(),
      sequence: 1, lastSyncedAt: null, shutdown: { gateClosed: true },
    } }),
    log: () => {},
  })).rejects.toThrow("could not be confirmed stopped");
  expect(await fs.readFile(daemonPidPath(root), "utf8")).toContain("4242");
});

test("stopDaemon reports a critical phase and keeps waiting without SIGKILL", async () => {
  let waits = 0;
  let killed = false;
  const logs: string[] = [];
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    forceKill: () => { killed = true; },
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    drainPollMs: 1,
    now: () => 1_000_000,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, daemonVersion: RBOX_VERSION, bootId: "boot", state: "syncing", heartbeatAt: new Date(1_000_000).toISOString(),
      sequence: 1, lastSyncedAt: null,
      shutdown: { gateClosed: true, phase: "state-cas", repository: "repo", committed: true },
    } }),
    log: (line) => logs.push(line),
  });
  expect(killed).toBe(false);
  expect(logs.join("\n")).toContain("draining critical phase state-cas (repo)");
});

test("stopDaemon bounds the standard upgrade stop of a pre-t3 daemon", async () => {
  const signals: string[] = [];
  let waits = 0;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, daemonVersion: "1.7.19", bootId: "boot", state: "syncing",
      heartbeatAt: new Date(1_000_000).toISOString(), sequence: 1, lastSyncedAt: null,
    } }),
    now: () => 1_000_000,
    log: () => {},
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(waits).toBe(2);
});

test("stopDaemon escalates when no shutdown witness can appear", async () => {
  const signals: string[] = [];
  let waits = 0;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "absent" }),
    log: () => {},
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(waits).toBe(2);
});

test("stopDaemon does not extend a stale same-version critical witness", async () => {
  const signals: string[] = [];
  let waits = 0;
  const now = 1_000_000;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, daemonVersion: RBOX_VERSION, bootId: "boot", state: "syncing",
      heartbeatAt: new Date(now - AMBIENT_STATUS_STALE_MS - 1).toISOString(), sequence: 1, lastSyncedAt: null,
      shutdown: { gateClosed: true, phase: "git-commit", committed: true },
    } }),
    now: () => now,
    log: () => {},
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(waits).toBe(2);
});

test("stopDaemon treats a heartbeat beyond the bounded future skew as stale", async () => {
  const signals: string[] = [];
  let waits = 0;
  const now = 1_000_000;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    processStartToken: stableStartToken,
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    readStatus: () => ({ kind: "ok", status: {
      schemaVersion: 1, daemonVersion: RBOX_VERSION, bootId: "boot", state: "syncing",
      heartbeatAt: new Date(now + DAEMON_HEARTBEAT_FUTURE_SKEW_MS + 1).toISOString(), sequence: 1, lastSyncedAt: null,
      shutdown: { gateClosed: true, phase: "state-cas", committed: true },
    } }),
    now: () => now,
    log: () => {},
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(waits).toBe(2);
});

test("stopDaemon re-enters the wait when the exact pid record is replaced before escalation", async () => {
  let waits = 0;
  let killed = false;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    forceKill: () => { killed = true; },
    processStartToken: stableStartToken,
    waitForExit: async () => {
      waits++;
      if (waits === 1) {
        await fs.writeFile(daemonPidPath(root), "v2 4242 replacement-boot\n");
        return false;
      }
      return true;
    },
    termTimeoutMs: 1,
    drainPollMs: 1,
    readStatus: () => ({ kind: "absent" }),
    log: () => {},
  });
  expect(killed).toBe(false);
  expect(waits).toBe(2);
  expect(await fs.readFile(daemonPidPath(root), "utf8")).toBe("v2 4242 replacement-boot\n");
});

test("stopDaemon does not SIGKILL a same-pid same-boot process-start ABA", async () => {
  let waits = 0;
  let tokenReads = 0;
  let killed = false;
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: () => {},
    forceKill: () => { killed = true; },
    processStartToken: async () => ++tokenReads === 1 ? "original-start" : "replacement-start",
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    drainPollMs: 1,
    readStatus: () => ({ kind: "absent" }),
    log: () => {},
  });
  expect(killed).toBe(false);
  expect(waits).toBe(2);
});

function shutdownClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const clock: DaemonShutdownClock = {
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function pending(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("daemon first signal lets a 90-second committed section drain before escalation starts", async () => {
  const timer = shutdownClock();
  const drain = pending();
  const stopped = pending();
  let committed = true;
  let kills = 0;
  let finishes = 0;
  const signal = createDaemonShutdownHandler({
    stop: () => stopped.promise,
    hasCommittedMutation: () => committed,
    waitForCommittedMutationDrain: () => drain.promise,
    finish: () => { finishes++; },
    kill: () => { kills++; },
    clock: timer.clock,
  });

  signal();
  timer.advance(90_000);
  expect(kills).toBe(0);
  committed = false;
  drain.resolve();
  await Promise.resolve();
  timer.advance(59_999);
  expect(kills).toBe(0);
  timer.advance(1);
  expect(kills).toBe(1);
  stopped.resolve();
  await stopped.promise;
  await Promise.resolve();
  expect(finishes).toBe(1);
});

test("daemon second signal escalates immediately during a committed drain", () => {
  const timer = shutdownClock();
  const drain = pending();
  const stopped = pending();
  let kills = 0;
  const signal = createDaemonShutdownHandler({
    stop: () => stopped.promise,
    hasCommittedMutation: () => true,
    waitForCommittedMutationDrain: () => drain.promise,
    finish: () => {},
    kill: () => { kills++; },
    clock: timer.clock,
  });
  signal();
  timer.advance(90_000);
  expect(kills).toBe(0);
  signal();
  expect(kills).toBe(1);
});

test("stopDaemon never signals after ownership revalidation fails", async () => {
  let checks = 0;
  let signalled = false;
  await stopDaemon(root, {
    isDaemonRunning: () => ++checks === 1 ? { running: true, pid: 4242 } : { running: false },
    signal: () => { signalled = true; },
    log: () => {},
  });
  expect(signalled).toBe(false);
  await expect(fs.readFile(daemonPidPath(root), "utf8")).rejects.toThrow();
});
