import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  admitLiveDaemonMode,
  DAEMON_MODE_WITNESS_TIMEOUT_MS,
  daemonVersionSkewLine,
  formatDaemonProcessLabel,
  readDaemonModeWitness,
  startDaemon,
  waitForDaemonModeWitness,
  type DaemonModeWitness,
} from "./daemon-control.js";
import { daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "./rbox-paths.js";
import type { DaemonMode } from "./daemon/ambient-status.js";
import { RBOX_VERSION } from "./version.js";

let temp: string;
let root: string;
let oldHome: string | undefined;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-mode-"));
  root = path.join(temp, "workspace");
  await fs.mkdir(root);
  oldHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = path.join(temp, "home");
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldHome;
  await fs.rm(temp, { recursive: true, force: true });
});

const known = (mode: DaemonMode): DaemonModeWitness => ({ kind: "known", mode, bootId: "boot-live" });

for (const requested of ["pull-only", "read-write"] as const) {
  const other = requested === "pull-only" ? "read-write" : "pull-only";
  for (const intent of ["preserve", "explicit", "pending"] as const) {
    test(`${intent} ${requested} accepts a matching live witness`, () => {
      expect(admitLiveDaemonMode(requested, intent, known(requested))).toBe("matched");
    });

    test(`${intent} ${requested} refuses a different live witness without transitioning it`, () => {
      expect(() => admitLiveDaemonMode(requested, intent, known(other)))
        .toThrow(`restart required: rbox stop && rbox start --${requested}`);
    });
  }

  test(`bare ${requested} preserves desired state when the live witness is unknown`, () => {
    expect(admitLiveDaemonMode(requested, "preserve", { kind: "unknown" })).toBe("preserve-unknown");
  });

  test(`explicit ${requested} refuses an unknown live witness`, () => {
    expect(() => admitLiveDaemonMode(requested, "explicit", { kind: "unknown" }))
      .toThrow(`restart required: rbox stop && rbox start --${requested}`);
  });

  test(`pending ${requested} keeps waiting for an unknown live witness`, () => {
    expect(admitLiveDaemonMode(requested, "pending", { kind: "unknown" })).toBe("pending-unknown");
  });
}

test("production mode witness wait is fifteen seconds", () => {
  expect(DAEMON_MODE_WITNESS_TIMEOUT_MS).toBe(15_000);
});

async function writeStatus(mode: DaemonMode | undefined, bootId: string, daemonVersion = "1.7.19"): Promise<void> {
  await fs.writeFile(daemonStatusPath(root), JSON.stringify({
    schemaVersion: 1,
    daemonVersion,
    ...(mode === undefined ? {} : { mode }),
    bootId,
    state: "synced",
    heartbeatAt: "2026-07-21T12:00:00.000Z",
    sequence: 1,
    lastSyncedAt: null,
  }));
}

test("mode witness is bound to the live v2 pidfile boot id", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus("pull-only", "boot-stale");
  expect(readDaemonModeWitness(root)).toEqual({ kind: "unknown" });

  await writeStatus(undefined, "boot-live");
  expect(readDaemonModeWitness(root)).toEqual({ kind: "unknown" });

  await writeStatus("pull-only", "boot-live");
  expect(readDaemonModeWitness(root)).toEqual({ kind: "known", mode: "pull-only", bootId: "boot-live" });

  await fs.writeFile(daemonPidPath(root), "123\n");
  expect(readDaemonModeWitness(root)).toEqual({ kind: "unknown" });
});

test("dev build metadata preserves a boot-bound mode witness", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus("read-write", "boot-live", "1.9.1-dev+514d689");
  expect(readDaemonModeWitness(root)).toEqual({
    kind: "known",
    mode: "read-write",
    bootId: "boot-live",
  });
});

test("newly spawned boot cannot match stale status and waits for its own witness", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-new\n");
  await writeStatus("read-write", "boot-old");
  let sleeps = 0;
  const witness = await waitForDaemonModeWitness(root, "boot-new", 1_000, 1, {
    daemonOwned: () => true,
    sleep: async () => {
      sleeps++;
      expect(readDaemonModeWitness(root, "boot-new")).toEqual({ kind: "unknown" });
      await writeStatus("pull-only", "boot-new");
    },
  });
  expect(sleeps).toBe(1);
  expect(witness).toEqual({ kind: "known", mode: "pull-only", bootId: "boot-new" });
});

test("witness delayed past timeout stays unknown, then a retry admits the same live boot", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-slow\n");
  await writeStatus("read-write", "boot-old");
  const timedOut = await waitForDaemonModeWitness(root, "boot-slow", 0, 1, {
    daemonOwned: () => true,
    sleep: async () => { throw new Error("zero timeout must not poll"); },
  });
  expect(timedOut).toEqual({ kind: "unknown" });

  await writeStatus("pull-only", "boot-slow");
  const retryWitness = readDaemonModeWitness(root, "boot-slow");
  expect(retryWitness).toEqual({ kind: "known", mode: "pull-only", bootId: "boot-slow" });
  expect(admitLiveDaemonMode("pull-only", "pending", retryWitness)).toBe("matched");
});

test("daemon identity copy includes only known parts and reports version skew", () => {
  expect(formatDaemonProcessLabel(4711, "1.9.1-dev+514d689", "read-write"))
    .toBe("process 4711, v1.9.1-dev+514d689, read-write");
  expect(formatDaemonProcessLabel(4711, "1.9.1")).toBe("process 4711, v1.9.1");
  expect(formatDaemonProcessLabel(4711)).toBe("process 4711");
  expect(daemonVersionSkewLine("1.9.1-dev+514d689", "1.9.1")).toBe(
    "this rbox is v1.9.1 but the running background sync is v1.9.1-dev+514d689 — restart it to catch up: rbox stop && rbox start",
  );
  expect(daemonVersionSkewLine("1.9.1", "1.9.1")).toBeUndefined();
});

test("an owned witnessed dev daemon is identified without spawning or asking for a re-run", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus("read-write", "boot-live", "1.9.1-dev+514d689");
  const logs: string[] = [];
  let spawned = 0;

  const result = await startDaemon(root, {
    daemonOwned: () => true,
    log: (line) => logs.push(line),
    onSpawned: () => { spawned++; },
  });

  expect(result).toBe("already-running");
  expect(spawned).toBe(0);
  expect(logs).toEqual([
    "background sync is already running (process 123, v1.9.1-dev+514d689, read-write)",
    daemonVersionSkewLine("1.9.1-dev+514d689", RBOX_VERSION),
  ]);
  expect(logs.every((line) => !line.includes("re-run"))).toBe(true);
});

test("an equal-version daemon has no version-skew line", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus("read-write", "boot-live", RBOX_VERSION);
  const logs: string[] = [];

  expect(await startDaemon(root, {
    daemonOwned: () => true,
    log: (line) => logs.push(line),
  })).toBe("already-running");
  expect(logs).toEqual([
    `background sync is already running (process 123, v${RBOX_VERSION}, read-write)`,
  ]);
});

test("pending intent polls its live daemon and admits a witness that appears", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus(undefined, "boot-live", RBOX_VERSION);
  const logs: string[] = [];
  let witnessed = 0;
  const statusWrite = setTimeout(() => {
    void writeStatus("read-write", "boot-live", RBOX_VERSION);
  }, 1);

  try {
    expect(await startDaemon(root, {
      modeIntent: "pending",
      daemonOwned: () => true,
      modeWitnessTimeoutMs: 100,
      modeWitnessPollMs: 1,
      log: (line) => logs.push(line),
      onModeWitness: () => { witnessed++; },
    })).toBe("already-running");
  } finally {
    clearTimeout(statusWrite);
  }

  expect(witnessed).toBe(1);
  expect(logs).toEqual([
    `background sync is already running (process 123, v${RBOX_VERSION}, read-write)`,
  ]);
  expect(logs.some((line) => line.includes("could not confirm"))).toBe(false);
});

test("pending intent reports a terminal outcome when its live witness never appears", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus(undefined, "boot-live", RBOX_VERSION);
  const logs: string[] = [];

  expect(await startDaemon(root, {
    modeIntent: "pending",
    daemonOwned: () => true,
    modeWitnessTimeoutMs: 0,
    log: (line) => logs.push(line),
  })).toBe("retry-later");
  expect(logs).toEqual([
    `background sync is running (process 123, v${RBOX_VERSION}) but rbox could not confirm its mode within 15s — check it with: rbox status`,
  ]);
});

test("explicit intent identifies an unknown live daemon before preserving the restart-required error", async () => {
  await fs.writeFile(daemonPidPath(root), "v2 123 boot-live\n");
  await writeStatus(undefined, "boot-live", RBOX_VERSION);
  const logs: string[] = [];

  await expect(startDaemon(root, {
    modeIntent: "explicit",
    pullOnly: true,
    daemonOwned: () => true,
    log: (line) => logs.push(line),
  })).rejects.toThrow("the live daemon's mode is unknown; restart required: rbox stop && rbox start --pull-only");
  expect(logs).toEqual([
    `background sync is already running (process 123, v${RBOX_VERSION})`,
  ]);
});

test("start copy never asks the operator to re-run rbox start", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "daemon/process-control.ts"), "utf8");
  expect(source).not.toContain("re-run `rbox start`");
});
