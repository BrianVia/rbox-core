import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main, type FrontDoorImport } from "./main-dispatch.js";

let frontDoorCalls = 0;
const frontDoorImport: FrontDoorImport = async () => ({
  resolveBareRboxTarget: async () => ({ kind: "front-door" as const, root: "/guided" }),
  runFrontDoor: async (root: string) => {
    expect(root).toBe("/guided");
    frontDoorCalls++;
  },
  runUntrackedMenu: async () => undefined,
});

const oldArgv = process.argv;
const oldCwd = process.cwd();
const oldRboxHome = process.env.RBOX_HOME;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let temp: string;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-start-dispatch-"));
  process.env.RBOX_HOME = temp;
  process.chdir(temp);
  process.argv = [process.execPath, "rbox", "start"];
  frontDoorCalls = 0;
});

afterEach(async () => {
  process.argv = oldArgv;
  process.chdir(oldCwd);
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  await fs.rm(temp, { recursive: true, force: true });
});

test("start outside a workspace is a clear error for non-TTY stdin", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  await expect(main({ frontDoorImport })).rejects.toThrow("Not inside a synced folder. Run `rbox` to get started, or pass the folder: rbox start <path>");
  expect(frontDoorCalls).toBe(0);
});

test("non-interactive bare rbox never runs the interactive front door", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  process.argv = [process.execPath, "rbox"];
  await main({ frontDoorImport });
  expect(frontDoorCalls).toBe(0);
});

test("start outside a workspace on a TTY errors instead of opening the front door", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  await expect(main({ frontDoorImport })).rejects.toThrow("Not inside a synced folder. Run `rbox` to get started, or pass the folder: rbox start <path>");
  expect(frontDoorCalls).toBe(0);
});

test("start with a path outside any workspace errors instead of opening the front door", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  process.argv = [process.execPath, "rbox", "start", temp];
  await expect(main({ frontDoorImport })).rejects.toThrow("Not inside a synced folder");
  expect(frontDoorCalls).toBe(0);
});

test("start rejects mutually exclusive explicit mode flags", async () => {
  process.argv = [process.execPath, "rbox", "start", "--pull-only", "--read-write"];
  await expect(main({ frontDoorImport })).rejects.toThrow("choose only one background sync mode: --pull-only or --read-write");
  expect(frontDoorCalls).toBe(0);
});
