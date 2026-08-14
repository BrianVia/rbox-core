import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  desiredStatePath,
  startDaemonAndRecordDesired,
  stopDaemonAndRecordDesired,
} from "../autostart-cmd.js";
import { daemonPidPath } from "../rbox-paths.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  recordDesired,
  workspace,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("start and stop record desired state with account and workspace guards", async () => {
  const root = await workspace("ws_record");
  const started: string[] = [];
  const stopped: string[] = [];

  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_record"),
    startDaemon: async (r) => {
      started.push(r);
      return "started";
    },
    now: () => new Date("2026-07-03T18:00:00.000Z"),
  });
  expect(started).toEqual([root]);

  const running = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(running).toMatchObject({
    rootPath: root,
    state: "running",
    accountId: "acct_record",
    workspaceId: "ws_record",
    at: "2026-07-03T18:00:00.000Z",
  });
  expect((await fs.stat(desiredStatePath(root))).mode & 0o777).toBe(0o600);

  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_record"),
    stopDaemon: async (r) => void stopped.push(r),
    now: () => new Date("2026-07-03T18:05:00.000Z"),
  });
  expect(stopped).toEqual([root]);
  const stoppedState = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(stoppedState).toMatchObject({
    rootPath: root,
    state: "stopped",
    accountId: "acct_record",
    workspaceId: "ws_record",
    at: "2026-07-03T18:05:00.000Z",
  });
});

test("interactive trace selection reaches only spawn options, not desired state", async () => {
  const root = await workspace("ws_trace");
  let traceStreams: readonly string[] | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_trace"),
    traceStreams: ["held"],
    startDaemon: async (_candidate, options) => {
      traceStreams = options.traceStreams;
      return "started";
    },
  });

  expect(traceStreams).toEqual(["held"]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).not.toHaveProperty("traceStreams");
});

test("retry-later start does not create or replace desired running state", async () => {
  const absent = await workspace("ws_retry_absent");
  await startDaemonAndRecordDesired(absent, {
    loadCredentials: creds("acct_retry"),
    startDaemon: async () => "retry-later",
    now: () => new Date("2026-07-03T18:10:00.000Z"),
  });
  await expect(fs.access(desiredStatePath(absent))).rejects.toThrow();

  const stopped = await workspace("ws_retry_stopped");
  await recordDesired(stopped, "stopped", "acct_retry");
  const before = await fs.readFile(desiredStatePath(stopped), "utf8");
  await startDaemonAndRecordDesired(stopped, {
    loadCredentials: creds("acct_retry"),
    startDaemon: async () => "retry-later",
    now: () => new Date("2026-07-03T18:10:00.000Z"),
  });
  expect(await fs.readFile(desiredStatePath(stopped), "utf8")).toBe(before);
});

test("bare stopped-daemon resume preserves pull-only mode and stop carries it forward", async () => {
  const root = await workspace("ws_resume_pull_only");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    pullOnly: true,
    startDaemon: async () => "started",
  });
  await stopDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    stopDaemon: async () => {},
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "stopped", pullOnly: true });

  let options: { pullOnly?: boolean; modeIntent?: "preserve" | "explicit" } | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    startDaemon: async (_root, opts) => { options = opts; return "started"; },
  });
  expect(options).toMatchObject({ pullOnly: true, modeIntent: "preserve" });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toMatchObject({ state: "running", pullOnly: true });
});

test("stopped legacy desired state preserves the read-write default", async () => {
  const root = await workspace("ws_resume_legacy");
  await fs.mkdir(path.dirname(desiredStatePath(root)), { recursive: true });
  await fs.writeFile(desiredStatePath(root), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_resume",
    workspaceId: "ws_resume_legacy",
    at: "2026-07-03T18:00:00.000Z",
  }));
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_resume"), stopDaemon: async () => {} });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).pullOnly).toBeUndefined();

  let pullOnly: boolean | undefined;
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_resume"),
    startDaemon: async (_root, opts) => { pullOnly = opts.pullOnly; return "started"; },
  });
  expect(pullOnly).toBe(false);
});

test("unknown live mode on bare start records running without changing accepted mode", async () => {
  const root = await workspace("ws_live_unknown");
  await recordDesired(root, "stopped", "acct_unknown", "2026-07-03T18:00:00.000Z");
  await startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_unknown"),
    now: () => new Date("2026-07-03T19:00:00.000Z"),
    startDaemon: async () => "already-running-unknown-mode",
  });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"))).toEqual({
    rootPath: root,
    state: "running",
    accountId: "acct_unknown",
    workspaceId: "ws_live_unknown",
    at: "2026-07-03T19:00:00.000Z",
  });
});

test("a live mode mismatch still records running without accepting the requested mode", async () => {
  const root = await workspace("ws_live_mismatch");
  await recordDesired(root, "stopped", "acct_mismatch", "2026-07-03T18:00:00.000Z");
  await expect(startDaemonAndRecordDesired(root, {
    loadCredentials: creds("acct_mismatch"),
    mode: "pull-only",
    now: () => new Date("2026-07-03T19:00:00.000Z"),
    startDaemon: async (_root, opts) => {
      await fs.writeFile(daemonPidPath(root), "v2 3333 boot-mismatch\n");
      await opts.onLive?.({ pid: 3333, bootId: "boot-mismatch" });
      throw new Error("the live daemon is read-write; restart required: rbox stop && rbox start --pull-only");
    },
  })).rejects.toThrow("the live daemon is read-write");
  const desired = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(desired).toMatchObject({ state: "running", at: "2026-07-03T19:00:00.000Z" });
  expect(desired.pullOnly).toBeUndefined();
  expect(desired.pendingModeIntent).toBe("pull-only");
});
