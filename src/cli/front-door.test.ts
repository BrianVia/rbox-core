import { expect, test } from "bun:test";
import fs from "node:fs/promises";
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
import { bootstrapAccount } from "../engine/e2ee/index.js";
import { saveDevice } from "./e2ee-keystore.js";

function simulatedExitPromptError(): Error {
  const err = new Error("prompt aborted");
  err.name = "ExitPromptError";
  return err;
}

const noIdentityFetch = { loadCredentials: async () => ({ state: "absent" as const, path: "/missing/credentials.json" }) };

// Signed in, but skip the network identity fetch (cached plan short-circuits it).
const signedInNoFetch = {
  loadCredentials: async () => validCredentials,
  readAccountProfile: (async () => ({ email: "owner@example.com", plan: "pro", signInMethod: "github" })) as never,
};

const validCredentials = {
  state: "valid" as const,
  source: "disk" as const,
  credentials: { v: 1 as const, accountId: "acct_one", deviceId: "dev_one", token: "token", remoteUrl: "https://api.test" },
  legacy: false,
  extensions: {},
};

test("inside workspace renders status before picker and Exit runs no action", async () => {
  const calls: string[] = [];
  let statusDone = false;
  await runFrontDoor("/work/root", {
    ...signedInNoFetch,
    statusCmd: async (root) => {
      calls.push(`status:${root}`);
      await Promise.resolve();
      statusDone = true;
      return { daemonRunning: false };
    },
    promptSelect: async (cfg) => {
      calls.push("prompt");
      expect(statusDone).toBe(true);
      expect(cfg.message).toBe("What would you like to do?");
      expect(cfg.choices).toEqual(frontDoorChoices(false));
      return "exit";
    },
  });
  expect(calls).toEqual(["status:/work/root", "prompt"]);
});

test("front door verifies an old-flow pair once, then its enrollment witness makes the next restart fetch-free", async () => {
  const priorHome = process.env.RBOX_HOME;
  const priorFetch = globalThis.fetch;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-front-door-genesis-"));
  const accountId = "acct_eeeeeeeeeeeeeeee";
  const deviceId = "dev_legacy";
  process.env.RBOX_HOME = home;
  try {
    const boot = await bootstrapAccount(accountId, deviceId, 1_900_000_000_000);
    await saveDevice(boot.secrets);
    const present = { rosters: 1, keyStates: 1, devices: 1, workspaces: 0, workspaceKeys: 0, e2eePairingTokens: 0 };
    let fetches = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetches++;
      expect(String(input)).toBe("https://api.test/v1/keys/account");
      return new Response(JSON.stringify({
        genesisPresenceVersion: 1,
        recoveryWrap: JSON.stringify(boot.upload.recoveryWrap),
        recoveryWrapId: boot.upload.recoveryWrapId,
        claimCreatedAt: 1_900_000_000_000,
        genesisDeviceId: deviceId,
        rosters: [JSON.stringify(boot.upload.genesisRoster)],
        keyStates: [JSON.stringify(boot.upload.genesisKeyState)],
        devices: [{ deviceId, sigPubkey: boot.upload.device.sigPubKey, encPubkey: boot.upload.device.encPubKey, mkWrap: JSON.stringify(boot.upload.device.mkWrap) }],
        present,
        repairTombstone: null,
      }));
    }) as typeof fetch;
    let rendered = 0;
    const loaded = {
      state: "valid" as const,
      source: "disk" as const,
      credentials: { v: 1 as const, accountId, deviceId, token: "tok", remoteUrl: "https://api.test" },
      legacy: false,
      extensions: {},
    };

    await runFrontDoor("/work/root", {
      loadCredentials: async () => loaded,
      readAccountProfile: async () => ({ accountId, email: null, signInMethod: null, plan: "pro" }),
      statusCmd: async () => {
        rendered++;
        return { daemonRunning: false };
      },
      promptSelect: async () => "exit",
    });

    expect(fetches).toBe(1);
    expect(rendered).toBe(1);
    globalThis.fetch = (async () => { fetches++; throw new Error("enrollment witness must suppress observation fetch"); }) as typeof fetch;
    await runFrontDoor("/work/root", {
      loadCredentials: async () => loaded,
      readAccountProfile: async () => ({ accountId, email: null, signInMethod: null, plan: "pro" }),
      statusCmd: async () => { rendered++; return { daemonRunning: false }; },
      promptSelect: async () => "exit",
    });
    expect(fetches).toBe(1);
    expect(rendered).toBe(2);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

for (const [action, expected] of [
  ["sync", "sync:/work/root"],
  ["logs", "logs:/work/root"],
  ["stop", "stop:/work/root"],
  ["setup", "setup:/work/root"],
  ["pair", "pair"],
  ["usage", "usage"],
] as const satisfies ReadonlyArray<readonly [FrontDoorAction, string]>) {
  test(`front-door action ${action} dispatches to the injected handler`, async () => {
    const calls: string[] = [];
    await runFrontDoor("/work/root", {
      ...noIdentityFetch,
      statusCmd: async () => ({ daemonRunning: action === "stop" }),
      promptSelect: async () => action,
      syncNow: async (root) => void calls.push(`sync:${root}`),
      viewLogs: async (root) => void calls.push(`logs:${root}`),
      pauseSyncing: async (root) => void calls.push(`stop:${root}`),
      setUpWorkspace: async (root) => void calls.push(`setup:${root}`),
      pairAnotherDevice: async () => void calls.push("pair"),
      viewUsage: async () => void calls.push("usage"),
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
    ...noIdentityFetch,
    statusCmd: async () => {
      calls.push("status");
      return { daemonRunning: false };
    },
    promptSelect: async () => {
      calls.push("prompt");
      throw simulatedExitPromptError();
    },
    syncNow: async () => void calls.push("sync"),
  });
  expect(calls).toEqual(["status", "prompt"]);
});

test("front-door sync-control choice and action flip with daemon state", async () => {
  for (const [running, expectedChoice, selected, expectedCall] of [
    [true, { name: "Pause syncing", value: "stop", description: "rbox stop" }, "stop", "stop:/work/root"],
    [false, { name: "Sync now", value: "sync", description: "rbox sync" }, "sync", "sync:/work/root"],
  ] as const) {
    const calls: string[] = [];
    await runFrontDoor("/work/root", {
      ...signedInNoFetch,
      statusCmd: async () => ({ daemonRunning: running }),
      promptSelect: async (cfg) => {
        expect(cfg.choices[0]).toEqual(expectedChoice);
        expect(cfg.choices.at(-1)).toEqual({ name: "Exit", value: "exit" });
        return selected;
      },
      syncNow: async (root) => void calls.push(`sync:${root}`),
      pauseSyncing: async (root) => void calls.push(`stop:${root}`),
    });
    expect(calls).toEqual([expectedCall]);
  }
});

test("signed out: Log in leads the menu and routes to the login flow", async () => {
  // Signed-out shows Log in first; signed-in never shows it.
  expect(frontDoorChoices(false, false)[0]).toEqual({ name: "Log in", value: "login", description: "rbox login" });
  expect(frontDoorChoices(false, true).some((c) => c.value === "login")).toBe(false);

  let loggedIn = false;
  await runFrontDoor("/work/root", {
    ...noIdentityFetch, // absent credentials → signed out
    statusCmd: async () => ({ daemonRunning: false }),
    promptSelect: async (cfg) => {
      expect(cfg.choices[0]).toEqual({ name: "Log in", value: "login", description: "rbox login" });
      return "login";
    },
    logIn: async () => void (loggedIn = true),
  });
  expect(loggedIn).toBe(true);
});

test("front-door choices pin the founder order and complementary sync gate", () => {
  expect(frontDoorChoices(false)).toEqual([
    { name: "Sync now", value: "sync", description: "rbox sync" },
    { name: "Start background syncing", value: "start", description: "rbox start" },
    { name: "Set up a new workspace", value: "setup", description: "rbox setup" },
    { name: "Pair another device", value: "pair", description: "rbox pair" },
    { name: "View usage", value: "usage", description: "rbox usage" },
    { name: "View logs", value: "logs", description: "rbox logs" },
    { name: "Exit", value: "exit" },
  ]);
  expect(frontDoorChoices(true)).toEqual([
    { name: "Pause syncing", value: "stop", description: "rbox stop" },
    ...frontDoorChoices(false).slice(2),
  ]);
});

test("cold front-door identity fetches exactly once and renders the fresh response", async () => {
  const loaded = validCredentials;
  let fetches = 0;
  let renderedIdentity: { email: string | null; plan: string | null } | undefined;
  await runFrontDoor("/work/root", {
    loadCredentials: async () => loaded,
    readAccountProfile: async (accountId) => {
      expect(accountId).toBe("acct_one");
      return undefined;
    },
    fetchAccountSummary: async (timeoutMs, credentials) => {
      fetches++;
      expect(timeoutMs).toBe(2_000);
      expect(credentials).toBe(loaded);
      return { state: "ok", status: { accountId: "acct_one", linked: true, email: "founder@example.com", plan: "pro" } };
    },
    statusCmd: async (_root, identity) => {
      renderedIdentity = identity;
      return { daemonRunning: false };
    },
    promptSelect: async () => "exit",
  });
  expect(fetches).toBe(1);
  expect(renderedIdentity).toEqual({ email: "founder@example.com", plan: "pro" });
});

test("warm front-door identity cache skips the network fetch", async () => {
  let fetches = 0;
  await runFrontDoor("/work/root", {
    loadCredentials: async () => validCredentials,
    readAccountProfile: async () => ({ accountId: "acct_one", email: null, signInMethod: null, plan: "pro" }),
    fetchAccountSummary: async () => {
      fetches++;
      return { state: "unavailable" };
    },
    statusCmd: async (_root, identity) => {
      expect(identity).toBeUndefined();
      return { daemonRunning: false };
    },
    promptSelect: async () => "exit",
  });
  expect(fetches).toBe(0);
});

test("front-door identity fetch soft-fails to the existing cache-only status render", async () => {
  let fetches = 0;
  await runFrontDoor("/work/root", {
    loadCredentials: async () => validCredentials,
    readAccountProfile: async () => ({ accountId: "acct_one", email: "founder@example.com", signInMethod: "github", plan: null }),
    fetchAccountSummary: async () => {
      fetches++;
      return { state: "unavailable" };
    },
    statusCmd: async (_root, identity) => {
      expect(identity).toBeUndefined();
      return { daemonRunning: false };
    },
    promptSelect: async () => "exit",
  });
  expect(fetches).toBe(1);
});

for (const action of ["new", "existing", "nothing"] as const satisfies ReadonlyArray<UntrackedMenuAction>) {
  test(`untracked menu routes ${action} correctly`, async () => {
    const writes: string[] = [];
    const result = await runUntrackedMenu("/tmp/scratch", "acct_ab12cd34", {
      writeStderr: (text) => void writes.push(text),
      getIdentity: async () => undefined,
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

test("untracked menu renders cached email and method instead of the account id", async () => {
  const writes: string[] = [];
  await runUntrackedMenu("/tmp/scratch", "acct_hidden", {
    writeStderr: (text) => void writes.push(text),
    getIdentity: async (accountId) => {
      expect(accountId).toBe("acct_hidden");
      return { email: "owner@example.com", signInMethod: "github" };
    },
    promptSelect: async () => "nothing",
  });
  expect(writes.join("")).toContain("Signed in as owner@example.com (github). This directory isn't tracked yet.");
  expect(writes.join("")).not.toContain("acct_hidden");
});

test("untracked menu exits cleanly on prompt abort", async () => {
  const result = await runUntrackedMenu("/tmp/scratch", "acct_ab12cd34", {
    writeStderr: () => {},
    getIdentity: async () => undefined,
    promptSelect: async () => {
      throw simulatedExitPromptError();
    },
  });
  expect(result).toBeUndefined();
});

test("untracked menu abbreviates the home directory in the track description", () => {
  expect(UNTRACKED_MENU_CHOICES(path.join(os.homedir(), "code", "scratch"))[0]!.description).toBe("create a new workspace from ~/code/scratch");
});
