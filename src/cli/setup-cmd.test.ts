import { test, expect } from "bun:test";
import { workspaceFlags, authorizePath, resolveEnrollment, startSyncActions, START_SYNC_CHOICES } from "./setup-cmd.js";
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
