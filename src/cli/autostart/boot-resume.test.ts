import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import {
  autostartCmd,
  bootResume,
  desiredStatePath,
  readDesiredDaemonRows,
  resumeDesiredDaemon,
  stopDaemonAndRecordDesired,
} from "../autostart-cmd.js";
import { daemonPidPath, daemonStatusPath } from "../rbox-paths.js";
import {
  absent,
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  home,
  recordDesired,
  workspace,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("__boot-resume starts matching running roots through an injected daemon seam", async () => {
  const running = await workspace("ws_boot_running");
  const stopped = await workspace("ws_boot_stopped");
  const mismatch = await workspace("ws_boot_mismatch");
  await recordDesired(running, "running", "acct_boot");
  await recordDesired(stopped, "stopped", "acct_boot");
  await recordDesired(mismatch, "running", "acct_other");

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });

  expect(started).toEqual([running]);
});

test("__boot-resume gives durable pending mode precedence and promotes it on a witnessed match", async () => {
  const root = await workspace("ws_boot_pending");
  await recordDesired(root, "running", "acct_boot");
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  desired.pendingModeIntent = "pull-only";
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify(desired, null, 2)}\n`);

  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (_root, opts) => {
      expect(opts).toMatchObject({ pullOnly: true, modeIntent: "pending" });
      await fs.writeFile(daemonPidPath(root), "v2 2222 boot-pending\n");
      await opts.onLive?.({ pid: 2222, bootId: "boot-pending" });
      await fs.writeFile(daemonStatusPath(root), JSON.stringify({
        schemaVersion: 1,
        daemonVersion: "1.7.19",
        mode: "pull-only",
        bootId: "boot-pending",
        state: "synced",
        heartbeatAt: "2026-07-03T18:06:00.000Z",
        sequence: 1,
        lastSyncedAt: null,
      }));
      await opts.onModeWitness?.({ kind: "known", mode: "pull-only", bootId: "boot-pending" });
      return "already-running";
    },
  });

  const promoted = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(promoted).toMatchObject({ state: "running", pullOnly: true });
  expect(promoted.pendingModeIntent).toBeUndefined();
});

test("a stale boot-resume generation cannot undo a completed stop", async () => {
  const root = await workspace("ws_boot_stop_wins");
  await recordDesired(root, "running", "acct_boot");
  const expected = (await readDesiredDaemonRows()).find((row) => row.desired.rootPath === root)!.desired;
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_boot"), stopDaemon: async () => {} });
  let starts = 0;
  expect(await resumeDesiredDaemon(expected, {
    startDaemon: async () => { starts++; return "started"; },
  })).toBe(false);
  expect(starts).toBe(0);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "stopped" });
});

test("__boot-resume without credentials logs once and starts nothing", async () => {
  const running = await workspace("ws_no_creds");
  await recordDesired(running, "running", "acct_boot");

  const started: string[] = [];
  const logs: string[] = [];
  await bootResume({
    loadCredentials: absent,
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
    log: (line) => void logs.push(line),
  });

  expect(started).toEqual([]);
  expect(logs).toEqual(["autostart: not logged in"]);
});

test("credential degradation is actionable in status and starts zero boot-resume daemons", async () => {
  const degraded = async () => ({ state: "corrupt" as const, path: "/test/credentials.json", detail: "bad schema" });
  const started: string[] = [];
  const logs: string[] = [];
  await bootResume({
    loadCredentials: degraded,
    startDaemon: async (root) => { started.push(root); return "started"; },
    log: (line) => logs.push(line),
  });
  expect(started).toEqual([]);
  expect(logs.join("\n")).toContain("credential-degraded");
  expect(logs.join("\n")).toContain("corrupt");

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line?: unknown) => void lines.push(String(line ?? ""));
  try {
    await autostartCmd("status", { platform: "linux", home, loadCredentials: degraded, exec: async () => "Linger=yes\n" });
  } finally {
    console.log = oldLog;
  }
  expect(lines.join("\n")).toContain("credential-degraded");
});

