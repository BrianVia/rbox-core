import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  autostartWorkspaceStatuses,
  bootResume,
  desiredStatePath,
  readDesiredDaemonRows,
} from "../autostart-cmd.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  recordDesired,
  workspace,
  writeWorkspaceBinding,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("desired-state enumeration returns only running roots for the current account", async () => {
  const running = await workspace("ws_running");
  const stopped = await workspace("ws_stopped");
  const stale = await workspace("ws_stale");
  const mismatch = await workspace("ws_mismatch");

  await recordDesired(running, "running", "acct_current");
  await recordDesired(stopped, "stopped", "acct_current");
  await recordDesired(stale, "running", "acct_current");
  await recordDesired(mismatch, "running", "acct_other");
  await fs.rm(stale, { recursive: true, force: true });

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_current"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });
  expect(started).toEqual([running]);

  const statuses = await autostartWorkspaceStatuses("acct_current");
  const byRoot = new Map(statuses.map((s) => [s.rootPath, s]));
  expect(byRoot.get(running)?.status).toBe("running");
  expect(byRoot.get(stopped)?.status).toBe("stopped");
  expect(byRoot.get(stale)?.status).toBe("stale");
  expect(byRoot.get(mismatch)?.status).toBe("mismatch");
});

test("stopped desired records retain a valid pending mode intent", async () => {
  const root = await workspace("ws_stopped_pending_invalid");
  await fs.mkdir(path.dirname(desiredStatePath(root)), { recursive: true });
  await fs.writeFile(desiredStatePath(root), `${JSON.stringify({
    rootPath: root,
    state: "stopped",
    accountId: "acct_stopped",
    workspaceId: "ws_stopped_pending_invalid",
    at: "2026-07-03T18:00:00.000Z",
    pendingModeIntent: "pull-only",
  })}\n`);
  const row = (await readDesiredDaemonRows()).find((candidate) => candidate.desired.rootPath === root);
  expect(row?.desired.state).toBe("stopped");
  expect(row?.desired.pendingModeIntent).toBe("pull-only");
});

test("desired-state enumeration excludes rows rebound to a different workspace", async () => {
  const rebound = await workspace("ws_old");
  await recordDesired(rebound, "running", "acct_boot");
  await writeWorkspaceBinding(rebound, "ws_new");

  const statuses = await autostartWorkspaceStatuses("acct_boot");
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({
    rootPath: rebound,
    status: "mismatch",
    workspaceId: "ws_old",
    reason: "desired workspace ws_old, current ws_new",
  });

  const started: string[] = [];
  await bootResume({
    loadCredentials: creds("acct_boot"),
    startDaemon: async (root) => {
      started.push(root);
      return "started";
    },
  });
  expect(started).toEqual([]);
});

