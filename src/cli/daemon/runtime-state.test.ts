import { afterEach, beforeEach, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonBoundPath, daemonPidPath, daemonStatusPath } from "../rbox-paths.js";
import {
  clearDaemonStartupState,
  ensureDaemonRuntime,
  publishDaemonPidRecord,
  readDaemonPidRecord,
  removeDaemonPidRecordIfMatches,
} from "./runtime-state.js";

let home: string;
let root: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-runtime-state-"));
  process.env.RBOX_HOME = home;
  root = path.join(home, "workspace");
  await fsp.mkdir(root);
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  await fsp.rm(home, { recursive: true, force: true });
});

test("startup state mutation preserves synchronous PID publication and clears only stale witnesses", async () => {
  await ensureDaemonRuntime(root);
  await fsp.writeFile(daemonBoundPath(root), "v2 ws-old boot-old\n");
  await fsp.writeFile(daemonStatusPath(root), "{}");

  publishDaemonPidRecord(root, 4242, "boot-new");
  expect(await fsp.readFile(daemonPidPath(root), "utf8")).toBe("v2 4242 boot-new\n");

  await clearDaemonStartupState(root);
  expect(await fsp.readFile(daemonPidPath(root), "utf8")).toBe("v2 4242 boot-new\n");
  expect(await fsp.stat(daemonBoundPath(root)).catch(() => undefined)).toBeUndefined();
  expect(await fsp.stat(daemonStatusPath(root)).catch(() => undefined)).toBeUndefined();
});

test("compare-and-remove retains an ABA-replaced PID record", async () => {
  await ensureDaemonRuntime(root);
  publishDaemonPidRecord(root, 4242, "boot-original");
  const original = readDaemonPidRecord(root);
  publishDaemonPidRecord(root, 4242, "boot-replacement");

  await removeDaemonPidRecordIfMatches(root, original);

  expect(await fsp.readFile(daemonPidPath(root), "utf8")).toBe("v2 4242 boot-replacement\n");
});
