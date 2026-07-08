import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspaceFlags, authorizePath, resolveEnrollment, startSyncActions, START_SYNC_CHOICES, runSetup } from "./setup-cmd.js";
import { resolveKeyedWorkspace, ensureKeyedTargetDir } from "./setup-keyed.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";

const ACCOUNT_KEYS: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };

// The guided flow's menus are now arrow-key `@inquirer` `select`s (thin widgets we
// don't unit-test). The one pure step-transition left is `workspaceFlags` — the
// map from a Step-2 workspace decision to the exact `runInit` flags.

test("Step 2 → runInit flags: new workspace creates + pushes; both stay non-interactive", () => {
  const f = workspaceFlags({ kind: "new", root: "/code/app" });
  expect(f).toMatchObject({ new: "true", root: "/code/app", "no-interactive": "true" });
  expect(f.workspace).toBeUndefined();
});

test("Step 2 → runInit flags: joining an existing workspace passes its id, not --new", () => {
  const f = workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc" });
  expect(f).toMatchObject({ workspace: "ws_abc", root: "/code/app", "no-interactive": "true" });
  expect(f.new).toBeUndefined();
  expect(f.name).toBeUndefined(); // no picked name → status falls back to the id
});

test("Step 2 → runInit flags: a picked name rides along as a LOCAL cache label on join", () => {
  const f = workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc", name: "savvy-core" });
  expect(f).toMatchObject({ workspace: "ws_abc", name: "savvy-core", "no-interactive": "true" });
});

test("Step 2 → runInit flags: a create carries the prompted name to the server", () => {
  // Setup drives runInit with --no-interactive, so runInit's OWN name prompt never
  // fires — the name MUST ride the flags or it's silently dropped (the v0.5.6 bug:
  // the founder typed a name and the workspace was still created unnamed).
  const f = workspaceFlags({ kind: "new", root: "/code/app", name: "Conductor Workspaces" });
  expect(f).toMatchObject({ new: "true", name: "Conductor Workspaces", "no-interactive": "true" });
});

test("Step 2 → runInit flags: respectGitignore is opt-in and only forwarded for creates", () => {
  expect(workspaceFlags({ kind: "new", root: "/code/app" })["respect-gitignore"]).toBeUndefined();
  expect(workspaceFlags({ kind: "new", root: "/code/app", respectGitignore: true })).toMatchObject({ "respect-gitignore": "true" });
  expect(workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc", respectGitignore: true })["respect-gitignore"]).toBeUndefined();
});

// Step 3 collapsed the keep→resume double-confirm into one `select` (the founder once
// typed a workspace name into a Y/N). The widget itself we don't unit-test, but the
// LIVE select renders START_SYNC_CHOICES directly, so pinning the ordered labels+values
// AND running startSyncActions over each value means a re-shuffle or a value swap in
// the real wiring fails here — not just the mapper in isolation. Recommended ("both")
// must stay FIRST so a bare ENTER reproduces the old default:true+ENTER outcome.
test("Step 3 select wiring: ordered choices → side effects (both first, then daemon-only, then neither)", () => {
  expect(START_SYNC_CHOICES.map((c) => ({ ...c, ...startSyncActions(c.value) }))).toEqual([
    { name: "Start now and resume after reboot (recommended)", value: "both", startDaemon: true, enableAutostart: true },
    { name: "Start now only", value: "start", startDaemon: true, enableAutostart: false },
    { name: "Not now", value: "none", startDaemon: false, enableAutostart: false },
  ]);
});

// The new "Sign in via browser" method (design 47) must land on the SAME device-code
// grant as "Approve a code" — a friendlier front door, not a new backend. Only a
// pairing token takes the enroll-inline path. Pinning this stops a future edit from
// silently wiring "browser" to pairing (which would demand a token it doesn't have).
test("authorize routing: browser and approve are both the device-code grant; only pair redeems a token", () => {
  expect(authorizePath("pair")).toBe("pair-token");
  expect(authorizePath("approve")).toBe("device-code");
  expect(authorizePath("browser")).toBe("device-code");
});

test("resolveEnrollment: keyless account renders the first-machine choice and runs genesis", async () => {
  let choices: Array<{ name: string; value: string; description?: string }> = [];
  let genesisCalls = 0;
  let enrolledChecks = 0;

  const ok = await resolveEnrollment("https://api.test", {
    alreadyEnrolled: async () => {
      enrolledChecks++;
      return enrolledChecks > 1;
    },
    loadCredentials: async () => ({ token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_setup" }),
    makeApi: () => ({
      getAccountKeys: async () => null,
      bootstrapKeys: async () => {},
    }),
    promptSelect: (async (cfg: { choices: typeof choices }) => {
      choices = cfg.choices;
      return "genesis";
    }) as never,
    runGenesisEnrollment: async () => {
      genesisCalls++;
      return "enrolled";
    },
    writeStderr: () => {},
  });

  expect(ok).toBe(true);
  expect(choices[0]!.name).toBe("This is my first machine — set up encryption now");
  expect(choices.map((c) => c.value)).toEqual(["genesis", "pair", "recover", "later"]);
  expect(genesisCalls).toBe(1);
});

test("resolveEnrollment: existing key world keeps the current three choices and warning copy", async () => {
  let choices: Array<{ name: string; value: string; description?: string }> = [];
  const err: string[] = [];

  const ok = await resolveEnrollment("https://api.test", {
    alreadyEnrolled: async () => false,
    loadCredentials: async () => ({ token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_setup" }),
    makeApi: () => ({
      getAccountKeys: async () => ACCOUNT_KEYS,
      bootstrapKeys: async () => {},
    }),
    promptSelect: (async (cfg: { choices: typeof choices }) => {
      choices = cfg.choices;
      return "later";
    }) as never,
    writeStderr: (s) => void err.push(s),
  });

  expect(ok).toBe(false);
  expect(choices).toEqual([
    { name: "Paste a pairing token", value: "pair", description: "from `rbox pair` on an already-enrolled machine" },
    { name: "Recover with my 24-word phrase", value: "recover" },
    { name: "I'll do this later", value: "later", description: "re-run `rbox setup` once you've paired or recovered" },
  ]);
  expect(err[0]).toBe("\n⚠  This machine is authorized (acct_setup) but NOT yet enrolled for encryption. Enroll it now:\n");
});

test("keyed setup workspace resolver accepts id, exact name, and slug; unknown lists available names", () => {
  const rows = [
    { workspaceId: "ws_alpha", projectId: "root", name: "Alpha App", createdAt: 1 },
    { workspaceId: "ws_beta", projectId: "root", name: "Beta App", createdAt: 2 },
  ];
  expect(resolveKeyedWorkspace("ws_alpha", rows).workspaceId).toBe("ws_alpha");
  expect(resolveKeyedWorkspace("Beta App", rows).workspaceId).toBe("ws_beta");
  expect(resolveKeyedWorkspace("alpha-app", rows).workspaceId).toBe("ws_alpha");
  expect(resolveKeyedWorkspace("ws_rawidnotlisted", rows)).toEqual({ workspaceId: "ws_rawidnotlisted", projectId: "root", name: null });
  expect(() => resolveKeyedWorkspace("missing", rows)).toThrow(/Available: Alpha App, Beta App/);
});

test("keyed setup workspace resolver rejects ambiguous names by demanding an id", () => {
  const rows = [
    { workspaceId: "ws_one", projectId: "root", name: "Same", createdAt: 1 },
    { workspaceId: "ws_two", projectId: "root", name: "Same", createdAt: 2 },
  ];
  expect(() => resolveKeyedWorkspace("Same", rows)).toThrow(/ambiguous/);
});

test("keyed setup target guard refuses non-empty dirs unless forced", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-keyed-"));
  await fs.writeFile(path.join(tmp, "file.txt"), "x");
  await expect(ensureKeyedTargetDir(tmp, false)).rejects.toThrow(/not empty/);
  await expect(ensureKeyedTargetDir(tmp, true)).resolves.toBeUndefined();
  await fs.rm(tmp, { recursive: true, force: true });
});

test("keyed setup rejects literal --key values before any interactive work", async () => {
  await expect(runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { workspace: "app", key: "secret" } })).rejects.toThrow(/argv leaks secrets/);
});

test("keyed setup requires key input when --workspace is present", async () => {
  const oldKey = process.env.RBOX_KEY;
  delete process.env.RBOX_KEY;
  try {
    await expect(runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { workspace: "app" } })).rejects.toThrow("--workspace requires a key: set RBOX_KEY or pass --key-file/--key -");
  } finally {
    if (oldKey === undefined) delete process.env.RBOX_KEY;
    else process.env.RBOX_KEY = oldKey;
  }
});
