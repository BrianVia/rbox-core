import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountLink, accountStatus, accountUnlink } from "./account-cmd.js";
import { approveDevice, listDevices, pairCreate, revokeDevice } from "./auth-cmd.js";
import { startDaemonAndRecordDesired } from "./autostart-cmd.js";
import type { CredentialLoadResult } from "./credentials.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { runExport } from "./export-cmd.js";
import { continueInitWithPrecreatedWorkspace } from "./init-cmd.js";
import { createCiKey, listKeys, revokeKey } from "./key-cmd.js";
import { stepWorkspace } from "./setup-cmd.js";
import { billingPortal, checkoutUrl, subscribe } from "./subscribe-cmd.js";
import { track } from "./track-cmd.js";
import { usageCmd } from "./usage-cmd.js";

let home: string;
let previousEnv: NodeJS.ProcessEnv;
let previousFetch: typeof fetch;

const invalidEnvironment: CredentialLoadResult = {
  state: "invalid-environment",
  variable: "RBOX_API",
  detail: "RBOX_API must be an absolute HTTP(S) URL",
};
const invalidLoad = async (): Promise<CredentialLoadResult> => invalidEnvironment;

beforeEach(async () => {
  previousEnv = { ...process.env };
  previousFetch = globalThis.fetch;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-credential-policy-"));
  process.env.HOME = home;
  process.env.RBOX_TOKEN = "env-token";
  process.env.RBOX_API = "relative";
});

afterEach(async () => {
  process.env = previousEnv;
  globalThis.fetch = previousFetch;
  await fs.rm(home, { recursive: true, force: true });
});

test("direct authenticated routes fail closed on invalid env before network access", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  const routes: Array<[string, () => Promise<unknown>]> = [
    ["account link", () => accountLink("code")],
    ["account status", () => accountStatus()],
    ["account unlink", () => accountUnlink()],
    ["usage", () => usageCmd()],
    ["checkout", () => checkoutUrl("solo")],
    ["subscribe", () => subscribe("solo")],
    ["billing portal", () => billingPortal()],
    ["export", () => runExport({ all: "true" })],
    ["device approve", () => approveDevice("CODE")],
    ["device list", () => listDevices()],
    ["device pair", () => pairCreate()],
    ["device revoke", () => revokeDevice("dev")],
    ["API-key create", () => createCiKey({ "accept-root-key": "true", expires: "90d" })],
    ["API-key list", () => listKeys()],
    ["API-key revoke", () => revokeKey("key")],
  ];
  for (const [name, route] of routes) {
    await expect(route(), name).rejects.toThrow(/invalid-environment.*RBOX_API/);
  }
  expect(fetches).toBe(0);
});

test("injected strict routes stop before local or remote mutation", async () => {
  let mutations = 0;
  await expect(startDaemonAndRecordDesired(home, {
    loadCredentials: invalidLoad,
    startDaemon: async () => { mutations++; return "started"; },
  })).rejects.toThrow(/invalid-environment/);

  const continuationRoot = path.join(home, "continued");
  let releases = 0;
  await expect(continueInitWithPrecreatedWorkspace(
    { new: "true", root: continuationRoot, project: "root", "no-interactive": "true" },
    { cwd: home, defaultRemote: "https://api.test" },
    { workspaceId: "ws", syncMutex: { root: continuationRoot } },
    {
      loadCredentials: invalidLoad,
      releaseMutex: async () => { releases++; },
      executePlan: (async () => { mutations++; }) as never,
    },
  )).rejects.toThrow(/invalid-environment/);
  expect(releases).toBe(1);

  await expect(track(home, { "no-interactive": "true" }, "https://api.test", {
    loadCredentials: invalidLoad,
    createRemoteWorkspace: async () => { mutations++; return "ws"; },
  })).rejects.toThrow(/invalid-environment/);

  await expect(stepWorkspace(
    { cwd: home, defaultRemote: "https://api.test" },
    { header: "Workspace" },
    {
      loadCredentials: invalidLoad,
      promptSelect: (async () => { mutations++; return "new"; }) as never,
      mkdir: async () => { mutations++; },
      createWorkspace: async () => { mutations++; return "ws"; },
    },
  )).rejects.toThrow(/invalid-environment/);

  const root = path.join(home, "workspace");
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws",
    projectId: "root",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    deviceId: "dev",
  }));
  await expect(buildAuthedRemote(root, Date.now, undefined, invalidEnvironment)).rejects.toThrow(/invalid-environment/);
  expect(mutations).toBe(0);
});
