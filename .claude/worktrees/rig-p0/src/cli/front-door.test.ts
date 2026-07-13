import { expect, test } from "bun:test";
import { FRONT_DOOR_CHOICES, resolveBareRboxTarget, runFrontDoor, type FrontDoorAction } from "./front-door.js";

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
    },
    promptSelect: async (cfg) => {
      calls.push("prompt");
      expect(statusDone).toBe(true);
      expect(cfg.message).toBe("Anything else?");
      expect(cfg.choices).toEqual(FRONT_DOOR_CHOICES);
      return "nothing";
    },
    syncNow: async () => void calls.push("sync"),
    viewLogs: async () => void calls.push("logs"),
    pauseSyncing: async () => void calls.push("stop"),
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
      statusCmd: async () => {},
      promptSelect: async () => action,
      syncNow: async (root) => void calls.push(`sync:${root}`),
      viewLogs: async (root) => void calls.push(`logs:${root}`),
      pauseSyncing: async (root) => void calls.push(`stop:${root}`),
    });

    expect(calls).toEqual([expected]);
  });
}

test("bare rbox dispatch chooses setup when cwd is not in a workspace", async () => {
  const target = await resolveBareRboxTarget("/tmp/not-tracked", {
    findRoot: async (cwd) => {
      expect(cwd).toBe("/tmp/not-tracked");
      return undefined;
    },
  });

  expect(target).toEqual({ kind: "setup" });
});

test("prompt abort returns cleanly without running an action", async () => {
  const calls: string[] = [];

  await runFrontDoor("/work/root", {
    statusCmd: async () => void calls.push("status"),
    promptSelect: async () => {
      calls.push("prompt");
      throw simulatedExitPromptError();
    },
    syncNow: async () => void calls.push("sync"),
    viewLogs: async () => void calls.push("logs"),
    pauseSyncing: async () => void calls.push("stop"),
  });

  expect(calls).toEqual(["status", "prompt"]);
});
