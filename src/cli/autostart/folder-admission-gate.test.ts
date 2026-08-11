import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { desiredStatePath, startDaemonForUser } from "../autostart-cmd.js";
import { forgetFolder } from "../folder-config.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  workspace,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("rbox start refuses a detached folder before desired-state mutation or spawn", async () => {
  const root = await workspace("ws_start_detached");
  await forgetFolder(root);
  let starts = 0;

  await expect(startDaemonForUser(root, {
    loadCredentials: creds("acct_start"),
    startDaemon: async () => { starts++; return "started"; },
  })).rejects.toThrow(/rbox config add/);

  expect(starts).toBe(0);
  expect(await fs.readFile(desiredStatePath(root), "utf8").catch(() => undefined)).toBeUndefined();
});

test("rbox start admits a configured bound folder", async () => {
  const root = await workspace("ws_start_admitted");
  const started: string[] = [];

  await startDaemonForUser(root, {
    loadCredentials: creds("acct_start"),
    startDaemon: async (candidate) => { started.push(candidate); return "started"; },
  });

  expect(started).toEqual([root]);
});
