import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  admitLiveDaemonMode,
  DAEMON_MODE_WITNESS_TIMEOUT_MS,
  readDaemonModeWitness,
  waitForDaemonModeWitness,
  type DaemonModeWitness,
} from "./daemon-control.js";
import { daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "./rbox-paths.js";
import type { DaemonMode } from "./daemon/ambient-status.js";

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

async function writeStatus(mode: DaemonMode | undefined, bootId: string): Promise<void> {
  await fs.writeFile(daemonStatusPath(root), JSON.stringify({
    schemaVersion: 1,
    daemonVersion: "1.7.19",
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
