import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  frontDoorChoices,
  resolveBareRboxTarget,
  runFrontDoor,
  runUntrackedMenu,
  UNTRACKED_MENU_CHOICES,
  type FrontDoorAction,
  type UntrackedMenuAction,
} from "./front-door.js";

function simulatedExitPromptError(): Error {
  const err = new Error("prompt aborted");
  err.name = "ExitPromptError";
  return err;
}

test("inside workspace renders status before picker and default nothing runs no action", async () => {
  const calls: string[] = [];
  let statusDone = false;
  await runFrontDoor("/work/root", {
    statusCmd: async (root) => {
      calls.push(`status:${root}`);
      await Promise.resolve();
      statusDone = true;
      return { daemonRunning: false };
    },
    promptSelect: async (cfg) => {
      calls.push("prompt");
      expect(statusDone).toBe(true);
      expect(cfg.message).toBe("Anything else?");
      expect(cfg.choices).toEqual(frontDoorChoices(false));
      return "nothing";
    },
  });
  expect(calls).toEqual(["status:/work/root", "prompt"]);
});

for (const [action, expected] of [
  ["sync", "sync:/work/root"],
  ["logs", "logs:/work/root"],
  ["stop", "stop:/work/root"],
] as const satisfies ReadonlyArray<readonly [FrontDoorAction, string]>) {
  test(`front-door action ${action} dispatches to the injected handler`, async () => {
    const calls: string[] = [];
    await runFrontDoor("/work/root", {
      statusCmd: async () => ({ daemonRunning: action === "stop" }),
      promptSelect: async () => action,
      syncNow: async (root) => void calls.push(`sync:${root}`),
      viewLogs: async (root) => void calls.push(`logs:${root}`),
      pauseSyncing: async (root) => void calls.push(`stop:${root}`),
    });
    expect(calls).toEqual([expected]);
  });
}

test("bare rbox target resolves root before checking enrollment", async () => {
  let enrollmentChecks = 0;
  const target = await resolveBareRboxTarget("/work/child", {
    findRoot: async () => "/work/root",
    enrolledAccountId: async () => {
      enrollmentChecks++;
      return "acct_test";
    },
  });
  expect(target).toEqual({ kind: "front-door", root: "/work/root" });
  expect(enrollmentChecks).toBe(0);
});

test("bare rbox target resolves enrolled untracked directories to the new menu", async () => {
  expect(await resolveBareRboxTarget("/tmp/not-tracked", { findRoot: async () => undefined, enrolledAccountId: async () => "acct_test" })).toEqual({
    kind: "untracked-menu",
    accountId: "acct_test",
  });
});

test("bare rbox target resolves unenrolled untracked directories to setup", async () => {
  expect(await resolveBareRboxTarget("/tmp/not-tracked", { findRoot: async () => undefined, enrolledAccountId: async () => undefined })).toEqual({ kind: "setup" });
});

test("prompt abort returns cleanly without running an action", async () => {
  const calls: string[] = [];
  await runFrontDoor("/work/root", {
    statusCmd: async () => {
      calls.push("status");
      return { daemonRunning: false };
    },
    promptSelect: async () => {
      calls.push("prompt");
      throw simulatedExitPromptError();
    },
    startSyncing: async () => void calls.push("start"),
  });
  expect(calls).toEqual(["status", "prompt"]);
});

test("front-door sync-control choice and action flip with daemon state", async () => {
  for (const [running, expectedChoice, selected, expectedCall] of [
    [true, { name: "Pause syncing", value: "stop", description: "rbox stop" }, "stop", "stop:/work/root"],
    [false, { name: "Start syncing", value: "start", description: "rbox start" }, "start", "start:/work/root"],
  ] as const) {
    const calls: string[] = [];
    await runFrontDoor("/work/root", {
      statusCmd: async () => ({ daemonRunning: running }),
      promptSelect: async (cfg) => {
        expect(cfg.choices.at(-1)).toEqual(expectedChoice);
        return selected;
      },
      startSyncing: async (root) => void calls.push(`start:${root}`),
      pauseSyncing: async (root) => void calls.push(`stop:${root}`),
    });
    expect(calls).toEqual([expectedCall]);
  }
});

for (const action of ["new", "existing", "nothing"] as const satisfies ReadonlyArray<UntrackedMenuAction>) {
  test(`untracked menu routes ${action} correctly`, async () => {
    const writes: string[] = [];
    const result = await runUntrackedMenu("/tmp/scratch", "acct_ab12cd34", {
      writeStderr: (text) => void writes.push(text),
      promptSelect: async (cfg) => {
        expect(cfg.message).toBe("What would you like to do?");
        expect(cfg.choices).toEqual(UNTRACKED_MENU_CHOICES("/tmp/scratch"));
        return action;
      },
    });
    expect(writes.join("")).toContain("Signed in and enrolled (acct_ab12cd34). This directory isn't tracked yet.");
    expect(writes.join("").endsWith("\n\n")).toBe(true);
    expect(result).toBe(action === "nothing" ? undefined : action);
  });
}

test("untracked menu exits cleanly on prompt abort", async () => {
  const result = await runUntrackedMenu("/tmp/scratch", "acct_ab12cd34", {
    writeStderr: () => {},
    promptSelect: async () => {
      throw simulatedExitPromptError();
    },
  });
  expect(result).toBeUndefined();
});

test("untracked menu abbreviates the home directory in the track description", () => {
  expect(UNTRACKED_MENU_CHOICES(path.join(os.homedir(), "code", "scratch"))[0]!.description).toBe("create a new workspace from ~/code/scratch");
});
