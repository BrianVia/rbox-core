import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonPidPath, daemonRuntimeDir, stopDaemon } from "./daemon-control.js";

let home: string;
let root: string;

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

test("stopDaemon escalates after the 60-second contract and confirms SIGKILL", async () => {
  const signals: string[] = [];
  let waits = 0;
  const logs: string[] = [];
  await stopDaemon(root, {
    isDaemonRunning: () => ({ running: true, pid: 4242 }),
    signal: (_pid, signal) => void signals.push(signal),
    forceKill: () => void signals.push("SIGKILL"),
    waitForExit: async () => ++waits === 2,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
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
    waitForExit: async () => false,
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    log: () => {},
  })).rejects.toThrow("could not be confirmed stopped");
  expect(await fs.readFile(daemonPidPath(root), "utf8")).toContain("4242");
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
