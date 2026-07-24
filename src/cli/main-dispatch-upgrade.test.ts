import { afterEach, expect, spyOn, test } from "bun:test";
import { main, type MainDispatchDeps } from "./main-dispatch.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

function harness(elevated: boolean, command = "upgrade") {
  let refreshes = 0;
  const calls: Array<{ remote: string; check: boolean; elevated: boolean }> = [];
  const deps: MainDispatchDeps = {
    isElevated: () => elevated,
    refreshSystemLockIdentityLedger: async () => {
      refreshes++;
      return {
        hostId: "host",
        bootId: "boot",
        pid: process.pid,
        startTime: "1",
      };
    },
    upgradeCommandImport: async () => ({
      upgradeCmd: async (remote, opts) => {
        calls.push({
          remote,
          check: opts?.check === true,
          elevated: opts?.commandDeps?.isElevated?.() === true,
        });
      },
    }),
  };
  process.argv = [process.execPath, "rbox", command, "--check", "--remote", "https://releases.test"];
  return { deps, state: () => ({ refreshes, calls }) };
}

test("elevated upgrade skips the optional home-scoped identity refresh", async () => {
  const h = harness(true);
  await main(h.deps);
  expect(h.state()).toEqual({
    refreshes: 0,
    calls: [{ remote: "https://releases.test", check: true, elevated: true }],
  });
});

test("non-elevated upgrade retains the identity refresh", async () => {
  const h = harness(false);
  await main(h.deps);
  expect(h.state()).toEqual({
    refreshes: 1,
    calls: [{ remote: "https://releases.test", check: true, elevated: false }],
  });
});

test("elevation does not suppress identity refresh for unrelated commands", async () => {
  const h = harness(true, "--version");
  const consoleLog = spyOn(console, "log").mockImplementation(() => {});
  try {
    await main(h.deps);
  } finally {
    consoleLog.mockRestore();
  }
  expect(h.state().refreshes).toBe(1);
  expect(h.state().calls).toEqual([]);
});
