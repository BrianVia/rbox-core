import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  accountGenesisLockPath,
  acquireAccountGenesisLock,
  acquireGenesisLockPair,
  acquireGlobalGenesisLock,
  genesisLockRoot,
} from "./genesis-locks.js";

const ACCOUNT = "acct_0123456789abcdef";
let home: string;
let savedRboxHome: string | undefined;

beforeEach(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-genesis-locks-"));
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(home, { recursive: true, force: true });
});

test("account locks use a dedicated non-materializing namespace", async () => {
  const lock = await acquireAccountGenesisLock(ACCOUNT);
  expect(accountGenesisLockPath(ACCOUNT).startsWith(genesisLockRoot() + path.sep)).toBe(true);
  await expect(fs.access(path.join(home, ".rbox", "e2ee", ACCOUNT))).rejects.toThrow();
  await lock.release();
});

test("global then account pair holds both and validates grammar before naming", async () => {
  const pair = await acquireGenesisLockPair(ACCOUNT);
  expect(await fs.readdir(genesisLockRoot())).toContain(`${ACCOUNT}.lock`);
  await pair.account.release();
  await pair.global.release();
  expect(() => accountGenesisLockPath("acct_../escape")).toThrow(/malformed/);
});

test("pair acquisition failure releases the global lock for the next machine operation", async () => {
  await expect(acquireGenesisLockPair("acct_../escape", 0)).rejects.toThrow(/malformed/);
  const global = await acquireGlobalGenesisLock(0);
  await global.release();
});

test("account handoff can occur while the caller deliberately retains the global pairing fence", async () => {
  const pair = await acquireGenesisLockPair(ACCOUNT, 0);
  await pair.account.release();

  const handedOff = await acquireAccountGenesisLock(ACCOUNT, 0);
  await expect(acquireGlobalGenesisLock(0)).rejects.toThrow(/another rbox process/);

  await handedOff.release();
  await pair.global.release();
  const nextGlobal = await acquireGlobalGenesisLock(0);
  await nextGlobal.release();
});
