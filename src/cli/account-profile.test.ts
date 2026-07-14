import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  accountProfilePath,
  clearAccountProfile,
  flushAccountProfileWrites,
  getIdentity,
  identityText,
  readAccountProfile,
  scheduleAccountProfileWrite,
} from "./account-profile.js";

let home: string;
const oldRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-account-profile-"));
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  await flushAccountProfileWrites();
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  await fs.rm(home, { recursive: true, force: true });
});

test("profile write is private and keyed reads ignore another account", async () => {
  scheduleAccountProfileWrite({ accountId: "acct_one", email: "owner@example.com", signInMethod: "github" });
  await flushAccountProfileWrites();
  expect(await readAccountProfile("acct_one")).toEqual({
    accountId: "acct_one",
    email: "owner@example.com",
    signInMethod: "github",
  });
  expect(await readAccountProfile("acct_two")).toBeUndefined();
  expect((await fs.stat(accountProfilePath())).mode & 0o777).toBe(0o600);
});

test("corrupt, malformed, and terminal-unsafe profiles are ignored", async () => {
  await fs.mkdir(path.dirname(accountProfilePath()), { recursive: true });
  for (const raw of [
    "{",
    JSON.stringify({ accountId: "acct_one", email: "owner@example.com\nspoof", signInMethod: "github" }),
    JSON.stringify({ accountId: "acct_one", email: "owner@example.com", signInMethod: 42 }),
  ]) {
    await fs.writeFile(accountProfilePath(), raw);
    expect(await readAccountProfile("acct_one")).toBeUndefined();
  }
});

test("getIdentity requires email and returns unstyled cached identity data", async () => {
  scheduleAccountProfileWrite({ accountId: "acct_one", email: "owner@example.com", signInMethod: "github" });
  await flushAccountProfileWrites();
  expect(await getIdentity("acct_one")).toEqual({ email: "owner@example.com", signInMethod: "github" });

  scheduleAccountProfileWrite({ accountId: "acct_one", email: "owner@example.com", signInMethod: null });
  await flushAccountProfileWrites();
  expect(await getIdentity("acct_one")).toEqual({ email: "owner@example.com", signInMethod: null });

  scheduleAccountProfileWrite({ accountId: "acct_one", email: null, signInMethod: "github" });
  await flushAccountProfileWrites();
  expect(await getIdentity("acct_one")).toBeUndefined();
  expect(await getIdentity("acct_other")).toBeUndefined();
});

test("identityText applies the shared email then method fallback precedence", () => {
  expect(identityText("owner@example.com", "github")).toBe("owner@example.com (github)");
  expect(identityText("owner@example.com", null)).toBe("owner@example.com");
  expect(identityText(null, "github")).toBe("github");
  expect(identityText(null, null)).toBeUndefined();
});

test("clear waits behind queued writes and tolerates an already-missing file", async () => {
  scheduleAccountProfileWrite({ accountId: "acct_one", email: "owner@example.com", signInMethod: null });
  await clearAccountProfile();
  expect(await fs.exists(accountProfilePath())).toBe(false);
  await expect(clearAccountProfile()).resolves.toBeUndefined();
});
