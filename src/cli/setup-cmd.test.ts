import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  workspaceFlags,
  defaultSyncFolder,
  authorizePath,
  stepHeader,
  resolveEnrollment,
  WORKSPACE_KIND_CHOICES,
  startSyncActions,
  START_SYNC_CHOICES,
  setupCompletionActions,
  SETUP_COMPLETION_CHOICES,
  finishSetup,
  SETUP_GITIGNORE_CHOICES,
  PAIRING_TOKEN_SOURCE_DESCRIPTION,
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
  enrolledAccountId,
} from "./setup-cmd.js";
import { resolveKeyedWorkspace, ensureKeyedTargetDir, persistKeyedCredentials } from "./setup-keyed.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";
import { promptPath } from "./prompt.js";
import { LEGACY_GENESIS_SERVICE_MESSAGE, LegacyGenesisServiceError, NetworkError, WORKSPACE_MINT_RERUN_HINT } from "./remote/errors.js";
import { loadRawState, loadState, resetSyncState, saveConfig, stateLockPath, StreamMismatchError } from "./config.js";
import { inspectResetConsent, type ResetConsentWitness } from "./reset-consent.js";
import { beginResetJournal, recoverResetJournal, resetArchivePath, resetJournalPath } from "./reset-journal.js";
import { resetJournalDoctorCmd } from "./reset-journal-doctor.js";
import { createHash } from "node:crypto";
import { bootstrapAccount } from "../engine/e2ee/index.js";
import { saveDevice } from "./e2ee-keystore.js";
import { genesisPaths, publishGenesisEnrollmentWitness } from "./genesis-durable.js";
import { pendingGenesisState } from "./genesis-enrollment.js";
import { loadCredentials, saveCredentials } from "./credentials.js";
import { acquireLock } from "../engine/lockfile.js";
import { authorityMarkerBytes } from "./state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "./state-plane/paths.js";
import { createStateStore } from "./state-plane/store/open.js";

const ACCOUNT_KEYS: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };

const validSetupCredentials = async () => ({
  state: "valid" as const,
  source: "disk" as const,
  credentials: { v: 1 as const, token: "tok", deviceId: "dev_setup", remoteUrl: "https://api.test", accountId: "acct_100000000000000b" },
  legacy: false,
  extensions: {},
});

async function withLegacyGenesisPair<T>(accountId: string, deviceId: string, run: (loaded: Awaited<ReturnType<typeof validSetupCredentials>>) => Promise<T>): Promise<T> {
  const prior = process.env.RBOX_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-legacy-entry-"));
  process.env.RBOX_HOME = home;
  try {
    await saveDevice((await bootstrapAccount(accountId, deviceId, 1_900_000_000_000)).secrets);
    return await run({ state: "valid", source: "disk", credentials: { v: 1, token: "tok", deviceId, remoteUrl: "https://api.test", accountId }, legacy: false, extensions: {} });
  } finally {
    if (prior === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("setup enrolledAccountId sends the exact legacy device+MK shape through the classifier", async () => {
  const priorFetch = globalThis.fetch;
  try {
    await withLegacyGenesisPair("acct_1818181818181818", "dev_legacy_setup", async (loaded) => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://api.test/v1/keys/account");
        throw new Error("setup classifier reached");
      }) as typeof fetch;
      await expect(enrolledAccountId(loaded)).rejects.toThrow("setup classifier reached");
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("resolveEnrollment sends the exact legacy device+MK shape through runGenesisEnrollment", async () => {
  await withLegacyGenesisPair("acct_1919191919191919", "dev_legacy_resolve", async (loaded) => {
    let calls = 0;
    const result = await resolveEnrollment("https://api.test", {
      loadCredentials: async () => loaded,
      makeApi: () => ({ getAccountKeys: async () => { throw new Error("must resume first"); }, getGenesisObservation: async () => { throw new Error("unused"); }, bootstrapKeys: async () => {} }),
      runGenesisEnrollment: async () => { calls++; return "already-setup"; },
      promptSelect: async () => "later",
    });
    expect(calls).toBe(1);
    expect(result).toBe(true);
  });
});

test("setup with a local enrollment witness performs zero observation fetches",async()=>{
  const priorFetch=globalThis.fetch;
  try{await withLegacyGenesisPair("acct_2020202020202020","dev_witness_setup",async loaded=>{await publishGenesisEnrollmentWitness(loaded.credentials.accountId!);let fetches=0;globalThis.fetch=(async()=>{fetches++;throw new Error("witness must keep setup offline");}) as typeof fetch;expect(await enrolledAccountId(loaded)).toBe(loaded.credentials.accountId);expect(fetches).toBe(0);});}
  finally{globalThis.fetch=priorFetch;}
});

test("fresh setup against a legacy server surfaces the exact terminal error and remains retryable after upgrade",async()=>{
  const priorRboxHome=process.env.RBOX_HOME,priorHome=process.env.HOME,priorFetch=globalThis.fetch,home=await fs.mkdtemp(path.join(os.tmpdir(),"rbox-legacy-server-setup-")),accountId="acct_2121212121212122",deviceId="dev_fresh";process.env.RBOX_HOME=home;process.env.HOME=home;let fetches=0;
  const loaded={state:"valid" as const,source:"disk" as const,credentials:{v:1 as const,token:"tok",deviceId,remoteUrl:"https://api.test",accountId},legacy:false,extensions:{}};
  try{
    await saveCredentials(loaded.credentials);
    globalThis.fetch=(async()=>{fetches++;return new Response(JSON.stringify({error:"not_found"}),{status:404});}) as typeof fetch;
    const error=await resolveEnrollment("https://api.test",{promptSelect:async()=>"genesis"}).catch(value=>value);expect(error).toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe(LEGACY_GENESIS_SERVICE_MESSAGE);
    expect(fetches).toBe(2);expect((await loadCredentials()).state).toBe("valid");expect(await pendingGenesisState(accountId)).toBe(false);for(const file of [genesisPaths(accountId).device,genesisPaths(accountId).mk,genesisPaths(accountId).marker,genesisPaths(accountId).journal,genesisPaths(accountId).stagedRk])await expect(fs.access(file)).rejects.toThrow();
    let upgradedObservations=0;const upgraded={getAccountKeys:async()=>null,getGenesisObservation:async()=>{upgradedObservations++;return{genesisPresenceVersion:1 as const,claim:null,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}};},bootstrapKeys:async()=>{}};
    const resumed=await resolveEnrollment("https://api.test",{makeApi:()=>upgraded,promptSelect:async()=>"genesis",runGenesisEnrollment:async api=>{await api.getGenesisObservation();await saveDevice((await bootstrapAccount(accountId,deviceId,1_900_000_000_000)).secrets);return"enrolled";}});expect(resumed).toBe(true);expect(upgradedObservations).toBe(1);
  }finally{globalThis.fetch=priorFetch;if(priorRboxHome===undefined)delete process.env.RBOX_HOME;else process.env.RBOX_HOME=priorRboxHome;if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;await fs.rm(home,{recursive:true,force:true});}
});

test("setup step header numbers fresh and enrolled flows", () => {
  expect([stepHeader(1, 3, "Account"), stepHeader(2, 3, "Folder"), stepHeader(3, 3, "Start syncing")]).toEqual([
    "Step 1 of 3 · Account",
    "Step 2 of 3 · Folder",
    "Step 3 of 3 · Start syncing",
  ]);
  expect([stepHeader(1, 2, "Folder"), stepHeader(2, 2, "Start syncing")]).toEqual([
    "Step 1 of 2 · Folder",
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

// The guided flow's menus are arrow-key selects (thin widgets we
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

test("Step 2 → runInit flags: a create answer is explicit for both values and joins omit it", () => {
  expect(workspaceFlags({ kind: "new", root: "/code/app" })["respect-gitignore"]).toBeUndefined();
  expect(workspaceFlags({ kind: "new", root: "/code/app", respectGitignore: false })["respect-gitignore"]).toBe("false");
  expect(workspaceFlags({ kind: "new", root: "/code/app", respectGitignore: true })).toMatchObject({ "respect-gitignore": "true" });
  expect(workspaceFlags({ kind: "join", root: "/code/app", workspace: "ws_abc", respectGitignore: true })["respect-gitignore"]).toBeUndefined();
});

test("Step 2 choices lead with the recommended folder and keep both escape hatches", () => {
  expect(WORKSPACE_KIND_CHOICES).toEqual([
    {
      name: "Sync ~/rbox (recommended)",
      value: "default",
      description: "create it if needed, then sync everything inside",
    },
    { name: "Sync another folder on this machine", value: "new" },
    {
      name: "Sync a folder from another machine",
      value: "existing",
      description: "choose one you've synced before",
    },
  ]);
});

test("Step 2 gitignore prompt defaults to skipping, with both escape hatches and an honest sync-all opt-in", () => {
  expect(SETUP_GITIGNORE_CHOICES).toEqual([
    {
      name: "Skip gitignored untracked files (recommended)",
      value: "true",
      description: "sync a secrets file anyway (encrypted, never committed) with ! lines in .rboxignore — e.g. !.env or !.dev.vars; switch later with `rbox ignore --respect-gitignore off`",
    },
    {
      name: "Sync gitignored files too (end-to-end encrypted)",
      value: "false",
      description: "relaxes nested .gitignore rules only — your root .gitignore and built-ins (node_modules, .env, …) still apply; re-include secrets with ! lines in .rboxignore (e.g. !.env)",
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
    { name: "Start background sync now and on machine boot (recommended)", value: "both", startDaemon: true, enableAutostart: true },
    { name: "Start background sync now only", value: "start", startDaemon: true, enableAutostart: false },
    { name: "Not now", value: "none", startDaemon: false, enableAutostart: false },
  ]);
});

test("post-setup select wiring: ordered choices map to pair once or exit", () => {
  expect(SETUP_COMPLETION_CHOICES.map((choice) => ({ ...choice, ...setupCompletionActions(choice.value) }))).toEqual([
    { name: "Set up another machine now", value: "pair", createPairingToken: true },
    { name: "Exit", value: "exit", createPairingToken: false },
  ]);
});

test("non-interactive setup completion shows the real local folder and keeps the static handoff", async () => {
  const writes: string[] = [];
  let prompts = 0;
  let pairs = 0;
  await finishSetup(path.join(os.homedir(), "rbox"), {
    interactive: () => false,
    select: (async () => { prompts++; return "pair"; }) as never,
    createPairingToken: async () => { pairs++; },
    writeStderr: (text) => void writes.push(text),
  });
  const output = writes.join("");
  expect(output).toContain("✓  rbox is set up.");
  expect(output).toContain("folder: ~/rbox");
  expect(output).toContain("This folder is end-to-end encrypted");
  expect(output).toContain("Bring another machine online:");
  expect(output).toContain("rbox pair      (here — prints the command; press c to copy)");
  expect(output).toContain("rbox connect … (there — paste the displayed command)");
  expect(output).not.toContain("To pair more devices later");
  expect({ prompts, pairs }).toEqual({ prompts: 0, pairs: 0 });
});

test("interactive setup completion catches pair failures and always prints the fallback note", async () => {
  const writes: string[] = [];
  let pairs = 0;
  await finishSetup("/work/folder-a", {
    interactive: () => true,
    select: (async () => "pair") as never,
    createPairingToken: async () => { pairs++; throw new Error("too many active pairing tokens"); },
    writeStderr: (text) => void writes.push(text),
  });
  expect(pairs).toBe(1);
  expect(writes.join("")).toContain("too many active pairing tokens");
  expect(writes.at(-1)).toBe("To pair more devices later, run `rbox pair` on an already-paired machine.\n");
});

// Browser sign-in uses the device-code grant; only a pairing token enrolls inline.
test("authorize routing: browser uses device-code; pair redeems a token", () => {
  expect(authorizePath("pair")).toBe("pair-token");
  expect(authorizePath("browser")).toBe("device-code");
});

test("authorization choices put browser first and omit the duplicate approve entry", () => {
  expect(PAIRING_TOKEN_SOURCE_DESCRIPTION).toBe(
    "run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard because it carries your encryption key"
  );
  expect(AUTHORIZATION_CHOICES).toEqual([
    { name: "Sign in via browser", value: "browser", description: "opens app.rbox.to to approve — no second terminal needed" },
    { name: "Paste a pairing token", value: "pair", description: PAIRING_TOKEN_SOURCE_DESCRIPTION },
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
    loadCredentials: validSetupCredentials,
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
    loadCredentials: validSetupCredentials,
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
  expect(err[0]).toBe("\n⚠  This machine is authorized (acct_100000000000000b) but NOT yet enrolled for encryption. Enroll it now:\n");
});

test("resolveEnrollment pairing and recovery exhaust their own local budget back to enrollment menu", async () => {
  for (const method of ["pair", "recover"] as const) {
    const selections = [method, "later"];
    let menuPrompts = 0;
    let inputPrompts = 0;
    let remoteAttempts = 0;
    const ok = await resolveEnrollment("https://api.test", {
      alreadyEnrolled: async () => false,
      loadCredentials: validSetupCredentials,
      makeApi: () => ({ getAccountKeys: async () => ACCOUNT_KEYS, bootstrapKeys: async () => {} }),
      promptSelect: (async () => { menuPrompts++; return selections.shift()!; }) as never,
      promptPassword: (async () => { inputPrompts++; return "bad-token"; }) as never,
      promptInput: (async () => { inputPrompts++; return "bad phrase"; }) as never,
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
    loadCredentials: validSetupCredentials,
    makeApi: () => ({ getAccountKeys: async () => ACCOUNT_KEYS, bootstrapKeys: async () => {} }),
    promptSelect: (async () => selections.shift()!) as never,
    promptInput: (async () => "checksum-valid phrase") as never,
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
      loadCredentials: validSetupCredentials,
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
      { token: "rbox_pat_keyed", deviceId: "agent_dev", accountId: "acct_100000000000000c" },
      "https://api.test"
    );
    const file = path.join(home, ".rbox", "credentials.json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      v: 1,
      token: "rbox_pat_keyed",
      deviceId: "agent_dev",
      remoteUrl: "https://api.test",
      accountId: "acct_100000000000000c",
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

type StepWorkspaceTestDeps = NonNullable<Parameters<typeof stepWorkspace>[2]>;

function baseCreateDeps(root: string, overrides: Partial<StepWorkspaceTestDeps> = {}): StepWorkspaceTestDeps {
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
    loadCredentials: validSetupCredentials,
    createWorkspace: async () => "ws_created",
    continueInit: async () => ({ workspaceId: "ws_created", deviceId: "dev", root }),
    writeStderr: () => undefined,
    ensureFolderAuthority: async () => ({
      kind: "authoritative",
      revision: "test-revision",
      snapshot: {
        catalog: { schemaVersion: 1, globalOptions: {}, folders: [] },
        generation: "test-generation",
        folders: [],
      },
    }) as never,
    ...overrides,
  };
}

test("recommended setup uses ~/rbox directly when it already exists", async () => {
  const root = defaultSyncFolder("/virtual/home");
  let pathPrompts = 0;
  let selects = 0;
  const result = await stepWorkspace(
    { cwd: "/cwd", defaultRemote: "https://api.test" },
    { header: "Folder" },
    baseCreateDeps(root, {
      defaultFolder: () => root,
      promptPath: async () => { pathPrompts++; return "/unexpected"; },
      promptSelect: async () => selects++ === 0 ? "default" : "false",
    })
  );
  expect(result).toEqual({ kind: "completed", outcome: { workspaceId: "ws_created", deviceId: "dev", root } });
  expect(pathPrompts).toBe(0);
});

test("recommended setup creates a missing ~/rbox without a redundant confirmation", async () => {
  const root = "/virtual/home/rbox";
  let confirms = 0;
  const made: string[] = [];
  let selects = 0;
  const result = await stepWorkspace(
    { cwd: "/cwd", defaultRemote: "https://api.test" },
    { header: "Folder" },
    baseCreateDeps(root, {
      defaultFolder: () => root,
      promptSelect: async () => selects++ === 0 ? "default" : "false",
      stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      mkdir: async (candidate) => { made.push(String(candidate)); return undefined; },
      promptConfirm: async () => { confirms++; return true; },
    })
  );
  expect(result.kind).toBe("completed");
  expect(made).toEqual([root]);
  expect(confirms).toBe(0);
});

test("an unusable recommended root falls back to the editable custom-folder prompt", async () => {
  for (const failure of ["file", "mkdir"] as const) {
    const recommended = `/virtual/${failure}/rbox`;
    const custom = `/custom/${failure}`;
    let pathPrompts = 0;
    let selects = 0;
    const writes: string[] = [];
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { header: "Folder" },
      baseCreateDeps(custom, {
        defaultFolder: () => recommended,
        promptSelect: async () => selects++ === 0 ? "default" : "false",
        promptPath: async () => { pathPrompts++; return custom; },
        stat: async (candidate) => {
          if (candidate === custom) return directoryStat;
          if (failure === "file") return { isDirectory: () => false } as never;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        mkdir: async () => { throw new Error("cannot create recommended root"); },
        writeStderr: (text) => void writes.push(text),
      })
    );
    expect(result.kind).toBe("completed");
    expect(pathPrompts).toBe(1);
    expect(writes.join("")).toContain(failure === "file" ? "exists but is not a directory" : "cannot create recommended root");
  }
});

test("add-another exclusion rejects the current root before any remote effect", async () => {
  const current = "/already/syncing";
  const other = "/another/folder";
  const answers = [current, other];
  const createdFrom: string[] = [];
  const writes: string[] = [];
  const result = await stepWorkspace(
    { cwd: current, defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Folder", excludedRoot: current, newFolderDefault: null },
    baseCreateDeps(other, {
      promptPath: async () => answers.shift()!,
      realpath: (async (value: string) => value) as typeof fs.realpath,
      createWorkspace: async () => { createdFrom.push(answers.length === 0 ? other : current); return "ws_created"; },
      writeStderr: (text) => void writes.push(text),
    })
  );
  expect(result.kind).toBe("completed");
  expect(createdFrom).toEqual([other]);
  expect(writes.join("")).toContain("That folder is already syncing. Choose another folder.");
});

test("add-another exclusion rejects a symlink alias of the current physical folder", async () => {
  const current = "/physical/current";
  const alias = "/alias/current";
  const other = "/another/folder";
  const answers = [alias, other];
  const created: string[] = [];
  let candidate = "";
  const result = await stepWorkspace(
    { cwd: current, defaultRemote: "https://api.test" },
    { preselectedKind: "new", header: "Folder", excludedRoot: current, newFolderDefault: null },
    baseCreateDeps(other, {
      promptPath: async () => { candidate = answers.shift()!; return candidate; },
      realpath: (async (value: string) => value === alias ? current : value) as typeof fs.realpath,
      createWorkspace: async () => { created.push(candidate); return "ws_created"; },
    })
  );
  expect(result.kind).toBe("completed");
  expect(created).toEqual([other]);
});

async function writeBoundSetupRoot(root: string): Promise<void> {
  await saveConfig(root, {
    schema: "e2ee/v1",
    remoteUrl: "https://api.test",
    remoteWorkspaceId: "ws_old",
    projectId: "root",
    rootPath: root,
    deviceId: "dev_old",
    token: "",
  });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
    stream: "https://api.test::ws_old::root",
    stateNonce: "0123456789abcdef0123456789abcdef",
    stateRevision: 4,
    lastSyncedSequence: 3,
    lastSyncedManifest: { generatedAt: "old", files: [] },
  }));
}

test("create rebind mints Stage A at confirm, narrows Stage B under the held mutex, and hands it off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-consent-"));
  const events: string[] = [];
  const writes: string[] = [];
  try {
    await writeBoundSetupRoot(root);
    const bound = {
      remoteUrl: "https://api.test",
      remoteWorkspaceId: "ws_old",
      projectId: "root",
      rootPath: root,
      deviceId: "dev_old",
      token: "",
    };
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        loadConfigIfPresent: async () => bound,
        loadRawState: async () => {
          events.push("read-lineage");
          return {
            stream: "https://api.test::ws_old::root",
            stateNonce: "0123456789abcdef0123456789abcdef",
            stateRevision: 4,
            lastSyncedSequence: 3,
            lastSyncedManifest: { generatedAt: "old", files: [] },
          };
        },
        promptConfirm: async () => { events.push("confirm"); return true; },
        acquireMutex: async () => { events.push("acquire"); return fakeMutex(root); },
        createWorkspace: async () => { events.push("create"); return "ws_new"; },
        continueInit: async (_flags, _opts, continuation) => {
          events.push("continue");
          expect(inspectResetConsent(continuation.resetConsent!)).toMatchObject({
            nextStream: "https://api.test::ws_new::root",
            consentKind: "setup-create",
          });
          return { workspaceId: "ws_new", deviceId: "dev", root };
        },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    expect(result.kind, writes.join("")).toBe("completed");
    expect(events).toEqual(["read-lineage", "confirm", "acquire", "create", "continue"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("marker-only lineage reaches create confirmation and receives an authorized witness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-marker-consent-"));
  let confirms = 0;
  let creates = 0;
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "state", "state-incarnation.json"), JSON.stringify({
      stream: "https://api.test::ws_old::root",
      stateNonce: "0123456789abcdef0123456789abcdef",
      stateRevision: 4,
    }));
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        promptConfirm: async () => { confirms++; return true; },
        createWorkspace: async () => { creates++; return "ws_new"; },
        continueInit: async (_flags, _opts, continuation) => {
          expect(inspectResetConsent(continuation.resetConsent!)).toMatchObject({
            nextStream: "https://api.test::ws_new::root",
            consentKind: "setup-create",
          });
          return { workspaceId: "ws_new", deviceId: "dev", root };
        },
      })
    );
    expect(result.kind).toBe("completed");
    expect(confirms).toBe(1);
    expect(creates).toBe(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create rebind lineage change after confirm refuses before the remote POST", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-consent-race-"));
  let creates = 0;
  let releases = 0;
  const previousExit = process.exitCode;
  try {
    await writeBoundSetupRoot(root);
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps(root, {
        loadConfigIfPresent: async () => ({ remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old", projectId: "root" }),
        acquireMutex: async () => {
          await fs.writeFile(path.join(root, ".rbox", "state.json"), JSON.stringify({
            stream: "https://api.test::ws_old::root",
            stateNonce: "fedcba9876543210fedcba9876543210",
            stateRevision: 5,
            lastSyncedSequence: 4,
            lastSyncedManifest: { generatedAt: "raced", files: [] },
          }));
          return fakeMutex(root);
        },
        createWorkspace: async () => { creates++; return "ws_never"; },
        releaseMutex: async () => { releases++; },
      })
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(creates).toBe(0);
    expect(releases).toBe(1);
  } finally {
    process.exitCode = previousExit;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existing-workspace rebind confirmation supplies a narrowed witness to runInit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-existing-consent-"));
  try {
    await writeBoundSetupRoot(root);
    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: validSetupCredentials,
        promptWorkspacePick: (async () => ({ kind: "picked", pick: { workspaceId: "ws_new" } })) as never,
        promptPath: async (prompt) => {
          expect(prompt.message).toBe("Which folder should rbox sync?");
          return root;
        },
        loadConfigIfPresent: async () => ({ remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old", projectId: "root" }),
        promptConfirm: async () => true,
        runInit: async (_flags, initOpts) => {
          expect(inspectResetConsent(initOpts.resetConsent!)).toMatchObject({
            nextStream: "https://api.test::ws_new::root",
            consentKind: "setup-rebind",
          });
          return { workspaceId: "ws_new", deviceId: "dev", root };
        },
        writeStderr: () => undefined,
      } as never
    );
    expect(result.kind).toBe("completed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-empty existing-workspace wizard accept/decline passes typed adoption consent only on acceptance", async () => {
  for (const accepted of [true, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-setup-adopt-${accepted}-`));
    await fs.writeFile(path.join(root, "preexisting.txt"), "local\n");
    let confirms = 0;
    try {
      const result = await stepWorkspace(
        { cwd: root, defaultRemote: "https://api.test" },
        { preselectedKind: "existing", header: "Workspace" },
        {
          loadCredentials: validSetupCredentials,
          promptWorkspacePick: (async () => ({ kind: "picked", pick: { workspaceId: "ws_adopt" } })) as never,
          promptPath: async () => root,
          loadConfigIfPresent: async () => undefined,
          loadRawState: async () => undefined,
          promptConfirm: async () => { confirms++; return accepted; },
          runInit: async (flags, initOpts) => {
            expect(flags["no-interactive"]).toBe("true");
            expect(initOpts.adoptConsent !== undefined).toBe(accepted);
            return { workspaceId: "ws_adopt", deviceId: "dev", root };
          },
          writeStderr: () => undefined,
        } as never
      );
      expect(result.kind).toBe("completed");
      expect(confirms).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("v2 transaction quarantine composes end to end with the next setup rebind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-quarantine-rebind-"));
  const oldStream = "https://api.test::ws_old::root";
  const nextStream = "https://api.test::ws_new::root";
  try {
    await writeBoundSetupRoot(root);
    const oldState = await loadRawState(root);
    expect(oldState).toBeDefined();
    const oldBytes = await fs.readFile(path.join(root, ".rbox", "state.json"));
    const oldHash = createHash("sha256").update(oldBytes).digest("hex");
    const archive = resetArchivePath(root, oldState!.stateNonce!, oldHash);
    const stateLock = await acquireLock(stateLockPath(root));
    if (stateLock.status !== "acquired") throw new Error(`test state lock unavailable: ${stateLock.status}`);
    await beginResetJournal(root, "quarantined-next", oldBytes, oldState!, [], {
      version: 2, authorizedNextStream: "quarantined-next", consentKind: "setup-rebind", mintedAtRevision: 4,
    }, stateLock.lock, {
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x33),
    });
    await stateLock.lock.release();
    await expect(recoverResetJournal(root, oldStream, { crashAt: (point) => {
      if (point === "after-ready") throw new Error(point);
    } })).rejects.toThrow("after-ready");
    await resetJournalDoctorCmd(root, { quarantine: true });
    expect(await fs.lstat(resetJournalPath(root)).catch(() => undefined)).toBeUndefined();
    expect(await fs.readFile(archive)).toEqual(oldBytes);

    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: validSetupCredentials,
        promptWorkspacePick: async () => ({ kind: "picked", pick: { workspaceId: "ws_new" } }),
        promptPath: async () => root,
        loadConfigIfPresent: async () => ({ remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old", projectId: "root" }),
        promptConfirm: async () => true,
        runInit: async (_flags, initOpts) => {
          await resetSyncState(root, nextStream, undefined, initOpts.resetConsent);
          return { workspaceId: "ws_new", deviceId: "dev_new", root };
        },
        writeStderr: () => undefined,
      } as never,
    );
    expect(result.kind).toBe("completed");
    expect(await loadState(root, nextStream)).toMatchObject({ stream: nextStream, stateRevision: 5 });
    expect(await fs.lstat(resetJournalPath(root)).catch(() => undefined)).toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("setup rebind resets a real selected SQLite authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-setup-sqlite-rebind-"));
  const oldStream = "https://api.test::ws_old::root";
  const nextStream = "https://api.test::ws_new::root";
  const authorityId = "a".repeat(32);
  try {
    await saveConfig(root, {
      schema: "e2ee/v1", remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old",
      projectId: "root", rootPath: root, deviceId: "dev_old", token: "",
    });
    await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
    createStateStore(sqliteResetPaths.active(root), {
      authorityId, lineageId: "b".repeat(32), stream: oldStream, createdBy: "test",
      stateNonce: "c".repeat(32), stateRevision: 4,
    }).close();
    await fs.writeFile(statePath(root), authorityMarkerBytes(authorityId));

    const result = await stepWorkspace(
      { cwd: root, defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: validSetupCredentials,
        promptWorkspacePick: async () => ({ kind: "picked", pick: { workspaceId: "ws_new" } }),
        promptPath: async () => root,
        loadConfigIfPresent: async () => ({ remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old", projectId: "root" }),
        promptConfirm: async () => true,
        runInit: async (_flags, initOpts) => {
          await resetSyncState(root, nextStream, undefined, initOpts.resetConsent);
          return { workspaceId: "ws_new", deviceId: "dev_new", root };
        },
        writeStderr: () => undefined,
      },
    );

    expect(result.kind).toBe("completed");
    expect(await loadState(root, nextStream)).toMatchObject({ stream: nextStream, stateRevision: 5 });
    expect(await fs.readFile(statePath(root))).toEqual(authorityMarkerBytes(authorityId));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("declined existing-workspace rebind returns to the Step-2 menu without calling init", async () => {
  let initCalls = 0;
  const result = await stepWorkspace(
    { cwd: "/join", defaultRemote: "https://api.test" },
    { preselectedKind: "existing", header: "Workspace" },
    {
      loadCredentials: validSetupCredentials,
      promptWorkspacePick: (async () => ({ kind: "picked", pick: { workspaceId: "ws_new" } })) as never,
      promptPath: async () => "/join",
      loadConfigIfPresent: async () => ({ remoteUrl: "https://api.test", remoteWorkspaceId: "ws_old", projectId: "root" }),
      loadRawState: async () => ({ stream: "https://api.test::ws_old::root" }),
      promptConfirm: async () => false,
      runInit: async () => { initCalls++; return undefined; },
      writeStderr: () => undefined,
    } as never
  );
  expect(result).toEqual({ kind: "menu" });
  expect(initCalls).toBe(0);
});

test("post-runInit StreamMismatchError is rendered and remains terminal", async () => {
  const writes: string[] = [];
  const previousExit = process.exitCode;
  try {
    const result = await stepWorkspace(
      { cwd: "/join", defaultRemote: "https://api.test" },
      { preselectedKind: "existing", header: "Workspace" },
      {
        loadCredentials: validSetupCredentials,
        promptWorkspacePick: (async () => ({ kind: "picked", pick: { workspaceId: "ws_new" } })) as never,
        promptPath: async () => "/join",
        loadConfigIfPresent: async () => undefined,
        loadRawState: async () => undefined,
        runInit: async () => { throw new StreamMismatchError("/join", "new", "old", "state"); },
        writeStderr: (text: string) => void writes.push(text),
      } as never
    );
    expect(result).toEqual({ kind: "terminal" });
    expect(process.exitCode).toBe(1);
    expect(writes.join("")).toContain("refusing to reset local sync history without setup confirmation");
  } finally {
    process.exitCode = previousExit;
  }
});

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

test("ordinary mutex failure re-prompts before mint; degraded handle warns but proceeds", async () => {
  const paths = ["/busy", "/degraded"];
  let acquires = 0;
  let creates = 0;
  const writes: string[] = [];
  const previousExit = process.exitCode;
  process.exitCode = undefined; // isolate from any leaked failure state
  try {
    const result = await stepWorkspace(
      { cwd: "/cwd", defaultRemote: "https://api.test" },
      { preselectedKind: "new", header: "Workspace" },
      baseCreateDeps("/degraded", {
        promptPath: async () => paths.shift()!,
        acquireMutex: async (root: string) => {
          acquires++;
          if (acquires === 1) throw new Error("busy");
          return { root, degraded: { reason: "identity-unavailable", detail: "compatible lock identity unavailable" } };
        },
        isDegraded: (handle: { degraded?: unknown }) => Boolean(handle.degraded),
        createWorkspace: async () => { creates++; return "ws_created"; },
        writeStderr: (text: string) => void writes.push(text),
      })
    );
    // Degraded locking no longer aborts setup: it warns (with the real reason)
    // and continues in legacy-unlocked mode, so the workspace still gets created.
    // Proceeded (completed + workspace created) rather than fail-closing.
    expect(result).toEqual({ kind: "completed", outcome: { workspaceId: "ws_created", deviceId: "dev", root: "/degraded" } });
    expect(creates).toBe(1);
    const out = writes.join("");
    expect(out).toContain("workspace locking is unavailable");
    expect(out).toContain("compatible lock identity unavailable");
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
      continueInit: async (_flags, _opts, input) => {
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
    expect(writes.join("")).toContain("Sync a folder from another machine");
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
    async (_opts, setup) => {
      seen.push(setup.preselectedKind);
      return seen.length === 1
        ? { kind: "menu" }
        : { kind: "completed", outcome: { workspaceId: "ws", deviceId: "dev", root: "/cwd" } };
    }
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
        loadCredentials: validSetupCredentials,
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
        loadCredentials: validSetupCredentials,
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
    promptInput: (async () => "phrase") as never,
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
    promptInput: (async () => "bad") as never,
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
    promptInput: (async () => { prompts++; return validWrongPhrase; }) as never,
    enroll: async (rk) => { enrolls++; expect(rk).toHaveLength(32); throw new Error("wrong key"); },
    writeStderr: () => undefined,
  });
  expect(result).toBe("parent");
  expect(prompts).toBe(1);
  expect(enrolls).toBe(1);
});

test("wizard recovery offers the canonical in-hand phrase before dropping it", async () => {
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const events: string[] = [];
  const result = await recoverInWizard({
    promptInput: (async () => phrase) as never,
    enroll: async () => { events.push("enrolled"); return { accountId: "acct_0123456789abcdef", deviceId: "dev" }; },
    offerRecoveryKit: async (received, creds) => {
      events.push("offered");
      expect(received).toBe(phrase);
      expect(creds.accountId).toBe("acct_0123456789abcdef");
    },
  });
  expect(result).toBe("enrolled");
  expect(events).toEqual(["enrolled", "offered"]);
});

test("wizard recovery keeps enrollment successful when the optional kit offer fails", async () => {
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const warnings: string[] = [];
  const result = await recoverInWizard({
    promptInput: (async () => phrase) as never,
    enroll: async () => ({ accountId: "acct_0123456789abcdef", deviceId: "dev" }),
    offerRecoveryKit: async () => { throw new Error("Keychain unavailable") },
    writeStderr: (line) => warnings.push(line),
  });
  expect(result).toBe("enrolled");
  expect(warnings.join(" ")).toContain("recovery succeeded");
  expect(warnings.join(" ")).toContain("Keychain unavailable");
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
    await runSetup({ cwd: process.cwd(), defaultRemote: "https://api.test", flags: { daemon: "true" }, interactive: () => false });
    expect(writes.join("")).toContain("note: --dir/--daemon/--pull-only/--force only apply to keyed setup");
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = 0;
  }
});
