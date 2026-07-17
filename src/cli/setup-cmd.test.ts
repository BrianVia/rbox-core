import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  workspaceFlags,
  authorizePath,
  stepHeader,
  resolveEnrollment,
  startSyncActions,
  START_SYNC_CHOICES,
  SETUP_GITIGNORE_CHOICES,
  PAIRING_TOKEN_SOURCE_DESCRIPTION,
  APPROVE_CODE_DESCRIPTION,
  AUTHORIZATION_CHOICES,
  EXISTING_ENROLLMENT_CHOICES,
  runSetup,
  writeEnrolledSkipNotice,
  stepWorkspace,
  runWorkspaceStepLoop,
  redeemPairInWizard,
  recoverInWizard,
  GENESIS_BROWSER_PROMPT,
  GENESIS_BOOTSTRAP_HINT,
  AUTHORIZATION_RECOVERY_FOOTER,
  authorizeExistingAccount,
} from "./setup-cmd.js";
import { resolveKeyedWorkspace, ensureKeyedTargetDir, persistKeyedCredentials } from "./setup-keyed.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";
import { promptPath } from "./prompt.js";
import { NetworkError, WORKSPACE_MINT_RERUN_HINT } from "./remote/errors.js";

const ACCOUNT_KEYS: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };

test("setup step header numbers fresh and enrolled flows", () => {
  expect([stepHeader(1, 3, "Account"), stepHeader(2, 3, "Workspace"), stepHeader(3, 3, "Start syncing")]).toEqual([
    "Step 1 of 3 · Account",
    "Step 2 of 3 · Workspace",
    "Step 3 of 3 · Start syncing",
  ]);
  expect([stepHeader(1, 2, "Workspace"), stepHeader(2, 2, "Start syncing")]).toEqual([
    "Step 1 of 2 · Workspace",
    "Step 2 of 2 · Start syncing",
  ]);
});

test("enrolled setup skip notice renders cached identity or the exact account-id fallback", async () => {
  const writes: string[] = [];
  await writeEnrolledSkipNotice("acct_hidden", {
    getIdentity: async () => ({ email: "owner@example.com", signInMethod: "github" }),
    writeStderr: (text) => void writes.push(text),
  });
  expect(writes.pop()).toBe("Signed in as owner@example.com (github) — skipping account setup.\n");

  await writeEnrolledSkipNotice("acct_fallback", {
    getIdentity: async () => undefined,
    writeStderr: (text) => void writes.push(text),
  });
  expect(writes.pop()).toBe("Signed in and enrolled (acct_fallback) — skipping account setup.\n");
});

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

test("Step 2 → runInit flags: respectGitignore is forwarded only when true and only for creates", () => {
  expect(workspaceFlags({ kind: "new", root: "/code/app" })["respect-gitignore"]).toBeUndefined();
  expect(workspaceFlags({ kind: "new", root: "/code/app", respectGitignore: false })["respect-gitignore"]).toBeUndefined();
  expect(workspaceFlags({ kind: "new", root: "/code/app", respectGitignore: true })).toMatchObject({ "respect-gitignore": "true" });
  expect(workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc", respectGitignore: true })["respect-gitignore"]).toBeUndefined();
});

test("Step 2 gitignore prompt defaults to skipping, with both escape hatches and an honest sync-all opt-in", () => {
  expect(SETUP_GITIGNORE_CHOICES).toEqual([
    {
      name: "Skip gitignored untracked files (recommended)",
      value: "true",
      description: "re-include specific files with ! lines in .rboxignore (e.g. !.env), or switch later with `rbox ignore --respect-gitignore off`",
    },
    {
      name: "Sync gitignored files too (end-to-end encrypted)",
      value: "false",
      description: "rbox can never read them; great for notes/local state (and .env via !.env), but large builds/datasets sync too",
    },
  ]);
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

test("authorization choices distinguish pairing tokens from confirmation codes", () => {
  expect(PAIRING_TOKEN_SOURCE_DESCRIPTION).toBe(
    "run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard because it carries your encryption key"
  );
  expect(APPROVE_CODE_DESCRIPTION).toBe(
    "this machine shows a confirmation code you approve elsewhere — different from a pairing token: it authorizes but does not carry encryption"
  );
  expect(AUTHORIZATION_CHOICES).toEqual([
    { name: "Paste a pairing token", value: "pair", description: PAIRING_TOKEN_SOURCE_DESCRIPTION },
    { name: "Sign in via browser", value: "browser", description: "opens app.rbox.to to approve — no second terminal needed" },
    { name: "Approve a code", value: "approve", description: APPROVE_CODE_DESCRIPTION },
  ]);
  expect(EXISTING_ENROLLMENT_CHOICES[0]).toEqual({
    name: "Paste a pairing token",
    value: "pair",
    description: PAIRING_TOKEN_SOURCE_DESCRIPTION,
  });
});

test("genesis prompt and authorization recovery footer use the split guided copy", () => {
  expect(GENESIS_BROWSER_PROMPT).toBe("Press Enter to sign up in your browser.");
  expect(GENESIS_BOOTSTRAP_HINT).toBe("(have a bootstrap secret? type it now — input hidden)");
  expect(AUTHORIZATION_RECOVERY_FOOTER).toBe(
    "lost access to your other machines? Sign in via browser, then choose 'Recover with my 24-word phrase'"
  );
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
    { name: "Paste a pairing token", value: "pair", description: PAIRING_TOKEN_SOURCE_DESCRIPTION },
    { name: "Recover with my 24-word phrase", value: "recover" },
    { name: "I'll do this later", value: "later", description: "re-run `rbox setup` once you've paired or recovered" },
  ]);
  expect(err[0]).toBe("\n⚠  This machine is authorized (acct_setup) but NOT yet enrolled for encryption. Enroll it now:\n");
});

test("resolveEnrollment pairing and recovery exhaust their own local budget back to enrollment menu", async () => {
  for (const method of ["pair", "recover"] as const) {
    const selections = [method, "later"];
    let menuPrompts = 0;
    let inputPrompts = 0;
    let remoteAttempts = 0;
    const ok = await resolveEnrollment("https://api.test", {
      alreadyEnrolled: async () => false,
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_setup" }),
      makeApi: () => ({ getAccountKeys: async () => ACCOUNT_KEYS, bootstrapKeys: async () => {} }),
      promptSelect: (async () => { menuPrompts++; return selections.shift()!; }) as never,
      promptPassword: (async () => { inputPrompts++; return method === "pair" ? "bad-token" : "bad phrase"; }) as never,
      redeemPair: async () => { remoteAttempts++; },
      parsePhrase: async () => { throw new Error("checksum"); },
      enrollRecovery: async () => { remoteAttempts++; return { accountId: "acct", deviceId: "dev" }; },
      writeStderr: () => undefined,
    });
    expect(ok).toBe(false);
    expect(menuPrompts).toBe(2);
    expect(inputPrompts).toBe(3);
    expect(remoteAttempts).toBe(0);
  }
});

test("resolveEnrollment post-validation recovery failure is one-shot back to enrollment menu", async () => {
  const selections = ["recover", "later"];
  let enrolls = 0;
  const key = new Uint8Array([7]);
  const ok = await resolveEnrollment("https://api.test", {
    alreadyEnrolled: async () => false,
    loadCredentials: async () => ({ token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_setup" }),
    makeApi: () => ({ getAccountKeys: async () => ACCOUNT_KEYS, bootstrapKeys: async () => {} }),
    promptSelect: (async () => selections.shift()!) as never,
    promptPassword: (async () => "checksum-valid phrase") as never,
    parsePhrase: async () => key,
    enrollRecovery: async (received) => { enrolls++; expect(received).toBe(key); throw new Error("remote failed"); },
    writeStderr: () => undefined,
  });
  expect(ok).toBe(false);
  expect(enrolls).toBe(1);
});

test("resolveEnrollment post-send pairing failures return to parent without enrolled-state heuristic", async () => {
  const valid = `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(32).toString("base64url")}`;
  for (const failure of ["transport lost", "pairing failed 401"]) {
    const selections = ["pair", "later"];
    let enrolledChecks = 0;
    let redeems = 0;
    let menus = 0;
    const ok = await resolveEnrollment("https://api.test", {
      alreadyEnrolled: async () => { enrolledChecks++; return false; },
      loadCredentials: async () => ({ token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_setup" }),
      makeApi: () => ({ getAccountKeys: async () => ACCOUNT_KEYS, bootstrapKeys: async () => {} }),
      promptSelect: (async () => { menus++; return selections.shift()!; }) as never,
      promptPassword: (async () => valid) as never,
      redeemPair: async () => { redeems++; throw new Error(failure); },
      writeStderr: () => undefined,
    });
    expect(ok).toBe(false);
    expect(redeems).toBe(1);
    expect(menus).toBe(2);
    expect(enrolledChecks).toBe(1);
  }
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

test("keyed setup persists credentials with private file mode", async () => {
  const oldHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-home-"));
  process.env.HOME = home;
  try {
    await persistKeyedCredentials(
      { token: "rbox_pat_keyed", deviceId: "agent_dev", accountId: "acct_keyed" },
      "https://api.test"
    );
    const file = path.join(home, ".rbox", "credentials.json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      token: "rbox_pat_keyed",
      deviceId: "agent_dev",
      remoteUrl: "https://api.test",
      accountId: "acct_keyed",
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("keyed setup rejects literal --key values before any interactive work", async () => {
  await expect(runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { workspace: "app", key: "secret" } })).rejects.toThrow(/argv leaks secrets/);
});

const fakeMutex = (root: string) => ({ root, lock: undefined });
const directoryStat = { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;

function baseCreateDeps(root: string, overrides: Record<string, unknown> = {}) {
  return {
    promptPath: async () => root,
    promptInput: async () => "-",
    promptSelect: async () => "false",
    promptConfirm: async () => true,
    stat: async () => directoryStat,
    mkdir: async () => undefined,
    loadConfigIfPresent: async () => undefined,
    acquireMutex: async () => fakeMutex(root),
    releaseMutex: async () => undefined,
    isDegraded: () => false,
    loadCredentials: async () => ({ token: "tok", deviceId: "dev", accountId: "acct", remoteUrl: "https://api.test" }),
    createWorkspace: async () => "ws_created",
    continueInit: async () => ({ workspaceId: "ws_created", deviceId: "dev", root }),
    writeStderr: () => undefined,
    ...overrides,
  } as never;
}

test("setup path site uses retrying promptPath and injected cwd resolution", async () => {
  const answers = ["~somebody/project", "relative/project"];
  const errors: string[] = [];
  const stepWrites: string[] = [];
  let statRoot = "";
  const root = "/injected/cwd/relative/project";
  const result = await stepWorkspace(
    { cwd: "/injected/cwd", defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Workspace" },
    baseCreateDeps(root, {
      promptPath: (opts: Parameters<typeof promptPath>[0]) => promptPath({
        ...opts,
        input: (async () => answers.shift()!) as never,
        writeStderr: (text) => void errors.push(text),
      }),
      stat: async (candidate: string) => { statRoot = candidate; return directoryStat; },
      writeStderr: (text: string) => void stepWrites.push(text),
    })
  );
  expect(result.kind).toBe("completed");
  expect(errors).toEqual(["~user paths aren't supported — use an absolute path\n"]);
  expect(statRoot).toBe(root);
  expect(stepWrites.join("")).toContain(`will sync: ${root}`);
});

test("create-new decline-mkdir and file-at-path both re-prompt with zero remote calls", async () => {
  const roots = ["/missing", "/file", "/done"];
  let currentRoot = "";
  const createRoots: string[] = [];
  const promptedRoots: string[] = [];
  let confirms = 0;
  let creates = 0;
  const result = await stepWorkspace(
    { cwd: "/cwd", defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Workspace" },
    baseCreateDeps("/done", {
      promptPath: async () => {
        currentRoot = roots.shift()!;
        promptedRoots.push(currentRoot);
        return currentRoot;
      },
      stat: async (root: string) => {
        if (root === "/missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return root === "/file" ? ({ isDirectory: () => false } as never) : directoryStat;
      },
      promptConfirm: async () => { confirms++; return false; },
      createWorkspace: async () => { creates++; createRoots.push(currentRoot); return "ws_created"; },
    })
  );
  expect(result.kind).toBe("completed");
  expect(confirms).toBe(1);
  expect(creates).toBe(1);
  expect(promptedRoots).toEqual(["/missing", "/file", "/done"]);
  expect(createRoots).toEqual(["/done"]);
});

test("typed rebind probe EACCES/ENOTDIR surfaces and re-prompts before mint", async () => {
  for (const code of ["EACCES", "ENOTDIR"]) {
    const paths = [`/${code.toLowerCase()}`, `/ok-${code.toLowerCase()}`];
    let currentRoot = "";
    const promptedRoots: string[] = [];
    const createRoots: string[] = [];
    const writes: string[] = [];
    let probes = 0;
    let creates = 0;
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(paths[1]!, {
        promptPath: async () => {
          currentRoot = paths.shift()!;
          promptedRoots.push(currentRoot);
          return currentRoot;
        },
        loadConfigIfPresent: async () => {
          probes++;
          if (probes === 1) throw Object.assign(new Error(`probe ${code}`), { code });
          return undefined;
        },
        createWorkspace: async () => { creates++; createRoots.push(currentRoot); return "ws_created"; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result.kind).toBe("completed");
    expect(creates).toBe(1);
    expect(promptedRoots).toEqual([`/${code.toLowerCase()}`, `/ok-${code.toLowerCase()}`]);
    expect(createRoots).toEqual([`/ok-${code.toLowerCase()}`]);
    expect(writes.join("")).toContain(`probe ${code}`);
  }
});

test("ordinary mutex failure re-prompts before mint; degraded handle fails closed", async () => {
  const paths = ["/busy", "/degraded"];
  let acquires = 0;
  let creates = 0;
  let releases = 0;
  const writes: string[] = [];
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps("/degraded", {
        promptPath: async () => paths.shift()!,
        acquireMutex: async (root: string) => {
          acquires++;
          if (acquires === 1) throw new Error("busy");
          return { root, degraded: { reason: "identity-unavailable" } };
        },
        isDegraded: (handle: { degraded?: unknown }) => Boolean(handle.degraded),
        releaseMutex: async () => { releases++; },
        createWorkspace: async () => { creates++; return "ws_never"; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(creates).toBe(0);
    expect(releases).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("filesystem does not support the required lock identity");
  } finally {
    process.exitCode = previousExit;
  }
});

test("mutex is acquired before one mint and held through continuation", async () => {
  const events: string[] = [];
  const root = "/ordered";
  const result = await stepWorkspace(
    { cwd: root, defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Workspace" },
    baseCreateDeps(root, {
      acquireMutex: async () => { events.push("acquire"); return fakeMutex(root); },
      createWorkspace: async () => { events.push("mint"); return "ws_one"; },
      continueInit: async (_flags: unknown, _opts: unknown, input: { workspaceId: string }) => {
        events.push(`continue:${input.workspaceId}`);
        events.push("release");
        return { workspaceId: "ws_one", deviceId: "dev", root };
      },
    })
  );
  expect(result.kind).toBe("completed");
  expect(events).toEqual(["acquire", "mint", "continue:ws_one", "release"]);
});

test("known-id post-mint failure is terminal, names resume id, creates once, and releases once", async () => {
  const writes: string[] = [];
  let creates = 0;
  let releases = 0;
  const root = "/known";
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        createWorkspace: async () => { creates++; return "ws_X"; },
        continueInit: async () => { releases++; throw new Error("disk full"); },
        releaseMutex: async () => { releases++; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(creates).toBe(1);
    expect(releases).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("workspace ws_X was created but local setup didn't finish: disk full");
    expect(writes.join("")).toContain("Sync an existing workspace");
  } finally {
    process.exitCode = previousExit;
  }
});

test("lost create response preserves unknown-outcome copy, claims no id, and does not retry", async () => {
  const writes: string[] = [];
  let creates = 0;
  let releases = 0;
  const root = "/unknown";
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        createWorkspace: async () => { creates++; throw new NetworkError("creating the workspace", new Error("lost"), WORKSPACE_MINT_RERUN_HINT); },
        releaseMutex: async () => { releases++; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(creates).toBe(1);
    expect(releases).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("may or may not have completed");
    expect(writes.join("")).not.toContain("workspace ws_");
  } finally {
    process.exitCode = previousExit;
  }
});

test("malformed successful create response keeps ownership, claims no id, and releases once", async () => {
  const root = "/malformed-id";
  let releases = 0;
  const writes: string[] = [];
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        createWorkspace: (async () => undefined) as never,
        releaseMutex: async () => { releases++; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(releases).toBe(1);
    expect(writes.join("")).toContain("may or may not have completed");
    expect(writes.join("")).not.toContain("workspace ws_");
  } finally {
    process.exitCode = previousExit;
  }
});

test("arbitrary pre-handoff failure releases the acquired mutex exactly once", async () => {
  const root = "/pre-handoff";
  let releases = 0;
  let creates = 0;
  await expect(stepWorkspace(
    { cwd: root, defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Workspace" },
    baseCreateDeps(root, {
      promptInput: async () => { throw new Error("prompt failed"); },
      createWorkspace: async () => { creates++; return "ws_never"; },
      releaseMutex: async () => { releases++; },
    })
  )).rejects.toThrow("prompt failed");
  expect(creates).toBe(0);
  expect(releases).toBe(1);
});

test("Step-2 menu alone loops and consumes a preselected kind; terminal never loops", async () => {
  const seen: Array<string | undefined> = [];
  const outcome = await runWorkspaceStepLoop(
    { cwd: "/cwd", defaultRemote: "https://api.test" },
    { header: "Workspace", preselectedKind: "new" },
    (async (_opts: unknown, setup: { preselectedKind?: string }) => {
      seen.push(setup.preselectedKind);
      return seen.length === 1
        ? { kind: "menu" }
        : { kind: "completed", outcome: { workspaceId: "ws", deviceId: "dev", root: "/cwd" } };
    }) as never
  );
  expect(outcome?.workspaceId).toBe("ws");
  expect(seen).toEqual(["new", undefined]);

  let calls = 0;
  await runWorkspaceStepLoop(
    { cwd: "/cwd", defaultRemote: "https://api.test" },
    { header: "Workspace" },
    (async () => { calls++; return { kind: "terminal" }; }) as never
  );
  expect(calls).toBe(1);
});

test("declined rebind returns menu for ordinary and preselected create paths without minting", async () => {
  for (const preselectedKind of [undefined, "new"] as const) {
    let creates = 0;
    let selects = 0;
    const result = await stepWorkspace(
      { cwd: "/bound", defaultRemote: "https://api.test" },
      { ...(preselectedKind ? { preselectedKind } : {}), header: "Workspace" },
      baseCreateDeps("/bound", {
        promptSelect: async () => { selects++; return "new"; },
        loadConfigIfPresent: async () => ({ remoteWorkspaceId: "ws_old", projectId: "root" }),
        promptConfirm: async () => false,
        createWorkspace: async () => { creates++; return "ws_never"; },
      })
    );
    expect(result).toEqual({ kind: "menu" });
    expect(creates).toBe(0);
    expect(selects).toBe(preselectedKind ? 0 : 1);
  }
});

test("setup picker back/empty navigation returns menu before any path or create call", async () => {
  for (const pickerResult of [{ kind: "back" }, { kind: "empty-account" }] as const) {
    let paths = 0;
    let creates = 0;
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: async () => ({ token: "tok", remoteUrl: "https://api.test" }),
        promptWorkspacePick: (async () => pickerResult) as never,
        promptPath: async () => { paths++; return "/never"; },
        createWorkspace: async () => { creates++; return "ws_never"; },
        writeStderr: () => undefined,
      } as never
    );
    expect(result).toEqual({ kind: "menu" });
    expect(paths).toBe(0);
    expect(creates).toBe(0);
  }
});

test("manual-id runInit terminal-undefined after mutation is terminal with no retry", async () => {
  let pathPrompts = 0;
  let initCalls = 0;
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: async () => ({ token: "tok", remoteUrl: "https://api.test" }),
        promptWorkspacePick: (async () => ({ kind: "picked", pick: { workspaceId: "ws_bad" } })) as never,
        promptPath: async () => { pathPrompts++; return "/join"; },
        runInit: async () => { initCalls++; return undefined; },
        writeStderr: () => undefined,
      } as never
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(pathPrompts).toBe(1);
    expect(initCalls).toBe(1);
  } finally {
    process.exitCode = previousExit;
  }
});

test("wizard token gate retries only local shape failures and treats post-send errors as burned", async () => {
  const valid = `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(32).toString("base64url")}`;
  let redeems = 0;
  let prompts = 0;
  const local = await redeemPairInWizard("https://api.test", {
    promptPassword: (async () => { prompts++; return "bad"; }) as never,
    redeemPair: async () => { redeems++; },
    writeStderr: () => undefined,
  });
  expect(local).toBe("parent");
  expect(prompts).toBe(3);
  expect(redeems).toBe(0);

  for (const message of ["transport lost", "pairing failed 401"]) {
    const writes: string[] = [];
    redeems = 0;
    const result = await redeemPairInWizard("https://api.test", {
      promptPassword: (async () => valid) as never,
      redeemPair: async (_remote, _token, _label, presentation) => { redeems++; expect(presentation).toBe("wizard"); throw new Error(message); },
      writeStderr: (text) => void writes.push(text),
    });
    expect(result).toBe("parent");
    expect(redeems).toBe(1);
    expect(writes.join("")).toContain("may now be used up");
  }
});

test("both setup pairing sites share the wizard-context gate", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "setup-cmd.ts"), "utf8");
  expect(source).toContain("const runPair = deps.redeemPairInWizard ?? redeemPairInWizard");
  expect(source).toContain("const result = await redeemPairInWizard(remote");
  expect(source).toContain('await redeem(remote, token, undefined, "wizard")');
});

test("Step-1 pairing exhaustion returns to its authorization parent with an independent budget", async () => {
  const methods = ["pair", "browser"];
  let pairEntries = 0;
  let logins = 0;
  let resolves = 0;
  const result = await authorizeExistingAccount("https://api.test", {
    promptSelect: (async () => methods.shift()!) as never,
    redeemPairInWizard: async () => { pairEntries++; return "parent"; },
    login: async (_remote, _secret, _plan, _kit, _label, presentation) => {
      logins++;
      expect(presentation).toBe("wizard");
    },
    resolveEnrollment: async () => { resolves++; return true; },
    writeStderr: () => undefined,
  });
  expect(result).toEqual({ ok: true, created: false });
  expect({ pairEntries, logins, resolves }).toEqual({ pairEntries: 1, logins: 1, resolves: 1 });
});

test("wizard recovery retries local phrase failures, passes parsed key once, and never retries downstream", async () => {
  let parses = 0;
  let enrolls = 0;
  const key = new Uint8Array([1, 2, 3]);
  const result = await recoverInWizard({
    promptPassword: (async () => "phrase") as never,
    parsePhrase: async () => { parses++; if (parses < 3) throw new Error("checksum"); return key; },
    enroll: async (received) => { enrolls++; expect(received).toBe(key); throw new Error("remote rejection"); },
    writeStderr: () => undefined,
  });
  expect(result).toBe("parent");
  expect(parses).toBe(3);
  expect(enrolls).toBe(1);

  parses = 0;
  enrolls = 0;
  expect(await recoverInWizard({
    promptPassword: (async () => "bad") as never,
    parsePhrase: async () => { parses++; throw new Error("word list"); },
    enroll: async () => { enrolls++; return { accountId: "acct", deviceId: "dev" }; },
    writeStderr: () => undefined,
  })).toBe("parent");
  expect(parses).toBe(3);
  expect(enrolls).toBe(0);
});

test("checksum-valid but wrong recovery phrase reaches exactly one prevalidated attempt", async () => {
  const validWrongPhrase =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  let prompts = 0;
  let enrolls = 0;
  const result = await recoverInWizard({
    promptPassword: (async () => { prompts++; return validWrongPhrase; }) as never,
    enroll: async (rk) => { enrolls++; expect(rk).toHaveLength(32); throw new Error("wrong key"); },
    writeStderr: () => undefined,
  });
  expect(result).toBe("parent");
  expect(prompts).toBe(1);
  expect(enrolls).toBe(1);
});

test("keyed setup requires key input when --workspace is present", async () => {
  const oldKey = process.env.RBOX_KEY;
  delete process.env.RBOX_KEY;
  try {
    await expect(runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { workspace: "app" } })).rejects.toThrow(/--workspace requires a key/);
  } finally {
    if (oldKey === undefined) delete process.env.RBOX_KEY;
    else process.env.RBOX_KEY = oldKey;
  }
});

test("guided setup warns about keyed-only flags before the non-TTY exit", async () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { daemon: "true" } });
    expect(writes.join("")).toContain("note: --dir/--daemon/--pull-only/--force only apply to keyed setup");
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = 0;
  }
});
