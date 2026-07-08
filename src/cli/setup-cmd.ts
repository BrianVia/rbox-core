/**
 * `rbox setup` (design 29) — the single, guided front door, and what bare `rbox`
 * runs in a TTY. A thin presentation layer over already-verified primitives
 * (`runInit`, `login`/`redeemPair`, `startDaemon`), arranged into the founder's
 * three-step arc: Account → Workspace → Start syncing. It replaces `menu-cmd.ts`'s
 * `runMenu`; the menu's "just authorize this machine" option is dropped (served
 * directly by `rbox login`).
 *
 * Every interactive widget is an `@inquirer/prompts` `select`/`input`/`confirm`/
 * `password` routed through `./prompt.js` — so menus are arrow-key choices (no
 * invalid-input loops), Ctrl-C exits cleanly (130), and EVERYTHING renders on
 * STDERR (so `rbox setup > log` never pollutes stdout). The lone pure mapper that
 * remains, `workspaceFlags`, carries the Step-2 transition and is unit-tested.
 *
 * Enrollment gap: a device-code login authorizes but does NOT enroll this machine
 * for encryption (auth-cmd.ts:78), and `runInit` aborts pre-sync when unenrolled
 * (init-cmd.ts). So when a device is authorized-but-unenrolled — either freshly after
 * a device-code login inside Step 1, or on a later re-run of `rbox setup` — the flow
 * offers inline enrollment resolution (paste a pairing token, or recover with the
 * 24-word phrase), or lets the user defer and re-run later. It never restarts the
 * new/existing account picker for a machine that's already signed in, and never
 * promises Steps 2–3 it can't deliver.
 */
import os from "node:os";
import { runInit } from "./init-cmd.js";
import { collapseHome, interpretWorkspaceNameAnswer } from "./init-plan.js";
import { EXISTING_ACCOUNT_ENROLLMENT_MESSAGE, login, redeemPair, runGenesisEnrollment } from "./auth-cmd.js";
import { enrollViaRecovery } from "./e2ee-client.js";
import { enableAutostart, startDaemonAndRecordDesired } from "./autostart-cmd.js";
import { loadCredentials } from "./credentials.js";
import { loadConfig } from "./config.js";
import { hasDevice } from "./e2ee-keystore.js";
import { RboxApi } from "./remote.js";
import { promptWorkspacePick } from "./workspace-picker.js";
import { promptSelect, promptInput, promptConfirm, promptPassword } from "./prompt.js";
import { stderrStyle as e } from "./style.js";
import { checkoutUrl, type BillingCadence, type SubscribePlan } from "./subscribe-cmd.js";
import { openAndShow } from "./browser-open.js";
import { hasKeyInput, runKeyedSetup } from "./setup-keyed.js";

/** Map a workspace decision to the exact `runInit` flags (the populate-sync runs
 *  inside runInit: push for a new workspace, pull+push for a join). */
export function workspaceFlags(plan: { kind: "new" | "join"; root: string; workspace?: string; name?: string; respectGitignore?: boolean }): Record<string, string> {
  const flags: Record<string, string> = { root: plan.root, project: "root", "no-interactive": "true" };
  if (plan.kind === "new") flags.new = "true";
  else flags.workspace = plan.workspace ?? "";
  // On a CREATE the name is sent to the server (createRemoteWorkspace); on a JOIN it's
  // a purely-LOCAL display label from the picker — never re-sent (the row already
  // exists, first-writer-wins). Manual-id entry has no name, so the flag is simply
  // absent and status falls back to the id.
  if (plan.name) flags.name = plan.name;
  if (plan.kind === "new" && plan.respectGitignore === true) flags["respect-gitignore"] = "true";
  return flags;
}

/** Step 3 · Start syncing. One `select` replaced the old keep→resume double-confirm
 *  (the founder mistook a Y/N for a text field once); "both" is the recommended first
 *  option so a bare ENTER reproduces the old default:true+ENTER outcome. */
export type StartSyncChoice = "both" | "start" | "none";

/** The Step-3 choices, exported so the test pins the ORDERED labels+values against
 *  `startSyncActions` — a re-shuffle or value swap in the live select can't silently
 *  invert which option starts the daemon / enables autostart. */
export const START_SYNC_CHOICES = [
  { name: "Start now and resume after reboot (recommended)", value: "both" },
  { name: "Start now only", value: "start" },
  { name: "Not now", value: "none" },
] as const satisfies ReadonlyArray<{ name: string; value: StartSyncChoice }>;

/** Map the Step-3 choice to its two side effects. Pure so the three-way branching is
 *  pinned by a unit test without driving the inquirer widget (mirrors `workspaceFlags`
 *  and `authorizePath`). "both" starts the daemon AND enables autostart; "start" starts
 *  the daemon only; "none" does neither. */
export function startSyncActions(choice: StartSyncChoice): { startDaemon: boolean; enableAutostart: boolean } {
  return { startDaemon: choice !== "none", enableAutostart: choice === "both" };
}

const HR = "─".repeat(72);

// ── the guided flow ───────────────────────────────────────────────────────────

export async function runSetup(opts: { cwd: string; defaultRemote: string; flags?: Record<string, string> }): Promise<void> {
  const flags = opts.flags ?? {};
  if (flags.key && flags.key !== "true" && flags.key !== "-") {
    throw new Error("refusing --key=<value>: argv leaks secrets via shell history and process listings. Use RBOX_KEY, --key-file <path>, or --key -.");
  }
  if (flags.workspace) {
    if (!hasKeyInput(flags)) throw new Error("--workspace requires a key: set RBOX_KEY or pass --key-file/--key -");
    await runKeyedSetup(opts.cwd, opts.defaultRemote, flags);
    return;
  }
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      "rbox setup is interactive. For scripts/CI use `rbox init` " +
        "(e.g. `rbox init --new --root <path> --bootstrap <secret>`). Run `rbox help init` for details.\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`\n${e.cyan("◆")}  ${e.bold("Welcome to rbox")} — end-to-end encrypted sync for your dev workspaces.\n`);

  // Step 1 · Account — unless this machine is already enrolled. When credentials
  // already exist but enrollment doesn't (authorized-but-unenrolled from a prior
  // device-code login), resolve enrollment inline instead of restarting the full
  // new/existing picker as if the user had never signed in.
  let syncDisabledUntilSubscribe = false;
  if (await alreadyEnrolled()) {
    process.stderr.write(`${e.dim("This machine is already signed in and enrolled. Continuing to your workspace.")}\n`);
  } else {
    const hasCreds = Boolean((await loadCredentials())?.accountId);
    const result = hasCreds ? { ok: await resolveEnrollment(opts.defaultRemote), created: false } : await stepAccount(opts.defaultRemote);
    if (!result.ok) return;
    if (result.created) {
      syncDisabledUntilSubscribe = !(await startTrialAfterAccountCreation());
    }
  }

  // Step 2 · Workspace — bind a directory + run the initial populate-sync.
  const outcome = await stepWorkspace(opts, { noSync: syncDisabledUntilSubscribe });
  if (!outcome) return;

  if (syncDisabledUntilSubscribe) {
    process.stderr.write(`${e.yellow("!")}  Sync is disabled until you run \`rbox subscribe\` and choose a plan.\n`);
    printSummary(outcome.workspaceId, outcome.deviceId);
    return;
  }

  // Step 3 · Start syncing in the background.
  process.stderr.write(`\n── ${e.bold("Step 3 of 3 · Start syncing")} ${HR.slice(0, 38)}\n`);
  const startChoice = await promptSelect<StartSyncChoice>({
    message: "Keep this workspace syncing in the background?",
    choices: START_SYNC_CHOICES,
  });
  const actions = startSyncActions(startChoice);
  if (actions.startDaemon) {
    await startDaemonAndRecordDesired(outcome.root);
    process.stderr.write(`${e.green("✓")} Background sync started. Stop anytime with \`rbox stop\`.\n`);
    if (actions.enableAutostart) {
      await enableAutostart();
      process.stderr.write(`${e.green("✓")} autostart enabled\n`);
    } else {
      process.stderr.write(`${e.dim("Enable resume-after-reboot later with `rbox autostart enable`.")}\n`);
    }
  } else {
    process.stderr.write(`${e.dim("Run `rbox start` whenever you're ready.")}\n`);
  }

  // Opt-in dependency-change notifications (drift surface 1) — commented out
  // (design 51): the shell hook this installs runs `rbox deps drift --quiet`,
  // and the whole `deps` CLI group is currently disabled (index.ts). Prompting
  // for and silently installing a hook that always fails is worse than not
  // asking. Re-enable together with `deps` itself.
  //
  // const notify = await promptConfirm({ message: "Be notified when dependencies change?", default: true });
  // if (notify) {
  //   const { installNotify } = await import("./deps-notify.js");
  //   try {
  //     await installNotify();
  //   } catch (err) {
  //     process.stderr.write(`${e.yellow("!")} ${err instanceof Error ? err.message : String(err)}\n`);
  //   }
  // }

  printSummary(outcome.workspaceId, outcome.deviceId);
}

/** True when this machine already holds the account's key material (skip Step 1). */
async function alreadyEnrolled(): Promise<boolean> {
  const creds = await loadCredentials();
  return Boolean(creds?.accountId && (await hasDevice(creds.accountId)));
}

/** Step 1 · Account. Returns true if this machine is now enrolled (flow continues),
 *  false if it hard-stopped on the device-code (authorize-only) path. */
interface StepAccountResult {
  ok: boolean;
  created: boolean;
}

async function stepAccount(remote: string): Promise<StepAccountResult> {
  process.stderr.write(`\n── ${e.bold("Step 1 of 3 · Account")} ${HR.slice(0, 46)}\n`);
  const choice = await promptSelect<"create" | "existing">({
    message: "Are you new here, or do you already have an rbox account?",
    choices: [
      { name: "Create a new account", value: "create" },
      { name: "Log into an existing account", value: "existing" },
    ],
  });

  if (choice === "create") {
    const secret = await promptPassword({ message: "Account bootstrap secret (enter to approve from another machine instead)" });
    // A secret bootstraps the genesis device (shows the recovery phrase); blank falls
    // back to device-code, which authorizes but can't enroll → resolve inline.
    await login(remote, secret || undefined);
    return { ok: await resolveEnrollment(remote), created: Boolean(secret) };
  }

  // Existing account.
  const method = await promptSelect<"pair" | "browser" | "approve">({
    message: "How do you want to authorize this machine?",
    choices: [
      { name: "Paste a pairing token", value: "pair", description: "from `rbox pair` — fewest steps, also enrolls encryption" },
      { name: "Sign in via browser", value: "browser", description: "opens app.rbox.to to approve — no second terminal needed" },
      { name: "Approve a code", value: "approve", description: "this machine shows a code you approve elsewhere" },
    ],
  });

  if (authorizePath(method) === "pair-token") {
    const token = await promptPassword({ message: "Paste pairing token" });
    if (!token) {
      process.stderr.write(e.yellow("no token entered — run `rbox pair` on a signed-in machine, then re-run `rbox setup`.\n"));
      return { ok: false, created: false };
    }
    await redeemPair(remote, token); // enrolls inline → resolveEnrollment short-circuits true
    return { ok: await resolveEnrollment(remote), created: false };
  }

  // "browser" and "approve" are the SAME device-code grant (authorize-only) — the
  // browser option is just a friendlier front door onto login()'s own printed UX
  // (design 47). Both authorize but do NOT enroll for encryption → resolve inline.
  await login(remote, undefined);
  return { ok: await resolveEnrollment(remote), created: false };
}

async function startTrialAfterAccountCreation(): Promise<boolean> {
  process.stderr.write(`\n── ${e.bold("Start your 14-day free trial")} ${HR.slice(0, 36)}\n`);
  const choice = await promptSelect<`${SubscribePlan}:${BillingCadence}`>({
    message: "Choose a plan for this new account:",
    choices: [
      { name: "Solo annual — $80/year (recommended)", value: "solo:annual" },
      { name: "Pro annual — $200/year", value: "pro:annual" },
      { name: "Solo monthly — $8/month", value: "solo:monthly" },
      { name: "Pro monthly — $20/month", value: "pro:monthly" },
    ],
  });
  const [plan, cadence] = choice.split(":") as [SubscribePlan, BillingCadence];
  process.stderr.write(`${e.dim("Card required; cancel anytime before the trial ends.")}\n`);
  const url = await checkoutUrl(plan, cadence);
  if (url === "already_subscribed") return true;
  openAndShow(url, "Opening your browser to complete checkout...", "Open this URL in your browser to complete checkout:");
  process.stderr.write(`${e.dim("Waiting for checkout to complete...")}\n`);
  return pollUntilPlanActive();
}

async function pollUntilPlanActive(): Promise<boolean> {
  const creds = await loadCredentials();
  if (!creds?.token || !creds.remoteUrl) return false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${creds.remoteUrl}/v1/account/usage`, { headers: { authorization: `Bearer ${creds.token}` } });
      if (res.ok) {
        const body = (await res.json()) as { plan?: string };
        if (body.plan && body.plan !== "none") return true;
      }
    } catch {
      // Keep polling until the deadline; browser checkout and webhook delivery race.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Which authorize path an existing-account method takes. "pair" redeems a pairing
 *  token (enrolls encryption inline); "browser" and "approve" are both the
 *  device-code grant (authorize-only) — same `login(remote, undefined)` call, just a
 *  different front door. Pure so the three-way routing is pinned by a unit test
 *  without driving the inquirer widget (mirrors `workspaceFlags`). */
export function authorizePath(method: "pair" | "browser" | "approve"): "pair-token" | "device-code" {
  return method === "pair" ? "pair-token" : "device-code";
}

/** Resolve enrollment for an authorized-but-unenrolled machine (device-code login
 *  authorizes but can't carry the key). Returns true once enrolled (flow continues),
 *  false if the user defers or provides no input. Offered both freshly after a
 *  device-code login inside Step 1 and on a later re-run of `rbox setup`. */
type ExistingEnrollmentMethod = "pair" | "recover" | "later";
type EnrollmentMethod = "genesis" | ExistingEnrollmentMethod;

const EXISTING_ENROLLMENT_CHOICES = [
  { name: "Paste a pairing token", value: "pair", description: "from `rbox pair` on an already-enrolled machine" },
  { name: "Recover with my 24-word phrase", value: "recover" },
  { name: "I'll do this later", value: "later", description: "re-run `rbox setup` once you've paired or recovered" },
] as const;

interface ResolveEnrollmentDeps {
  alreadyEnrolled?: () => Promise<boolean>;
  loadCredentials?: typeof loadCredentials;
  makeApi?: (remoteUrl: string, token: string) => Pick<RboxApi, "getAccountKeys" | "bootstrapKeys">;
  promptSelect?: typeof promptSelect;
  runGenesisEnrollment?: typeof runGenesisEnrollment;
  writeStderr?: (text: string) => void;
}

export async function resolveEnrollment(remote: string, deps: ResolveEnrollmentDeps = {}): Promise<boolean> {
  const checkEnrolled = deps.alreadyEnrolled ?? alreadyEnrolled;
  if (await checkEnrolled()) return true;

  // There must be credentials here — this is only reached once we know we're authorized.
  const creds = await (deps.loadCredentials ?? loadCredentials)();
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const select = deps.promptSelect ?? promptSelect;
  const api = creds?.token ? (deps.makeApi ?? ((remoteUrl, token) => new RboxApi(remoteUrl, token, "", "")))(creds.remoteUrl ?? remote, creds.token) : undefined;
  const accountKeys = api ? await api.getAccountKeys() : null;

  let method: EnrollmentMethod;
  if (accountKeys === null) {
    writeStderr(`\n${e.yellow("⚠")}  This machine is authorized (${e.cyan(creds?.accountId ?? "?")}) and this account has not set up encryption yet.\n`);
    method = await select<EnrollmentMethod>({
      message: "How do you want to enroll this machine for encryption?",
      choices: [
        { name: "This is my first machine — set up encryption now", value: "genesis", description: "create the recovery phrase and make this device the genesis device" },
        ...EXISTING_ENROLLMENT_CHOICES,
      ],
    });
  } else {
    writeStderr(
      `\n${e.yellow("⚠")}  This machine is authorized (${e.cyan(creds?.accountId ?? "?")}) but NOT yet enrolled for encryption. Enroll it now:\n`
    );
    method = await select<ExistingEnrollmentMethod>({
      message: "How do you want to enroll this machine for encryption?",
      choices: EXISTING_ENROLLMENT_CHOICES,
    });
  }

  if (method === "genesis") {
    if (!api || !creds?.accountId || !creds.deviceId) throw new Error("missing device credentials — run `rbox login` again");
    const result = await (deps.runGenesisEnrollment ?? runGenesisEnrollment)(api, { accountId: creds.accountId, deviceId: creds.deviceId });
    if (result === "enrolled") return checkEnrolled();
    writeStderr(`${e.yellow("!")}  ${EXISTING_ACCOUNT_ENROLLMENT_MESSAGE}\n`);
    return false;
  }

  if (method === "later") {
    writeStderr(
      `${e.dim("run `rbox pair`/`rbox connect` on a signed-in machine, or `rbox recover` with your phrase — then re-run `rbox setup`.")}\n`
    );
    return false;
  }

  if (method === "pair") {
    const token = await promptPassword({ message: "Paste pairing token" });
    if (!token) {
      writeStderr(e.yellow("no token entered — run `rbox pair` on a signed-in machine, then re-run `rbox setup`.\n"));
      return false;
    }
    await redeemPair(remote, token);
  } else {
    // Recover — same no-echo phrase prompt as `rbox recover` (auth-cmd.ts).
    const phrase = (await promptPassword({ message: "Enter your 24-word recovery phrase" })).trim();
    if (!phrase) {
      writeStderr(e.yellow("no phrase entered — re-run `rbox setup` when you're ready.\n"));
      return false;
    }
    await enrollViaRecovery(phrase, Date.now());
  }

  // A bad token/phrase throws (propagates to the top-level handler); recheck the
  // robust signal init also uses.
  return checkEnrolled();
}

/** Step 2 · Workspace. Returns the init outcome, or undefined if the user backed out. */
async function stepWorkspace(
  opts: { cwd: string; defaultRemote: string },
  setupOpts: { noSync?: boolean } = {}
): Promise<{ workspaceId: string; deviceId: string; root: string } | undefined> {
  process.stderr.write(`\n── ${e.bold("Step 2 of 3 · Workspace")} ${HR.slice(0, 44)}\n`);
  const choice = await promptSelect<"new" | "existing">({
    message: "What do you want to track here?",
    choices: [
      { name: "Create a new workspace from a directory", value: "new" },
      { name: "Sync an existing workspace", value: "existing", description: "pick one you've already synced" },
    ],
  });

  let workspace: string | undefined;
  let name: string | undefined;
  if (choice === "existing") {
    // Pick-by-name from the account's synced workspaces (degrades to a manual id
    // prompt when offline / no creds / empty account). The picked name is cached
    // locally so `rbox status` shows it with no round-trip.
    const creds = await loadCredentials();
    const picked = await promptWorkspacePick({ baseUrl: creds?.remoteUrl ?? opts.defaultRemote, token: creds?.token });
    if (!picked) {
      process.stderr.write(e.yellow("no workspace selected — re-run `rbox setup` when you're ready.\n"));
      return undefined;
    }
    workspace = picked.workspaceId;
    name = picked.name;
  }
  const dir = await promptInput({ message: "Which directory should rbox sync?", default: opts.cwd });

  // REBIND GUARD (design 44): creating a NEW workspace over a directory that already
  // syncs to one is almost never what the user wants (the 2026-07-01 incident: a
  // re-run of setup to name a workspace created a second, empty one). Make the
  // consequence explicit and default to NO.
  if (choice === "new") {
    const bound = await loadConfig(dir).catch(() => undefined);
    if (bound) {
      const label = bound.name ? `${bound.name} (${bound.remoteWorkspaceId})` : bound.remoteWorkspaceId;
      process.stderr.write(`${e.yellow("⚠")}  This directory already syncs to workspace ${e.cyan(label)}.\n`);
      const rebind = await promptConfirm({
        message: "Create a brand-new workspace for it anyway? (files on disk are untouched; sync history starts fresh)",
        default: false,
      });
      if (!rebind) {
        process.stderr.write(
          `${e.dim(`keeping the existing workspace. To sync it in the background run \`rbox start\`; to sync this directory to a different existing workspace, re-run setup and choose "Sync an existing workspace".`)}\n`
        );
        return undefined;
      }
    }
  }

  // Opt-in, server-visible workspace name — offered ONLY when creating (the row is
  // INSERTed once, first-writer-wins). `rbox setup` drives runInit via FLAGS, which
  // skips runInit's own interactive name prompt, so we must prompt here (mirrors
  // init-cmd.ts). Declining keeps it private — the label is server-side / NOT E2EE.
  // A join reuses the picker's already-known name.
  if (choice === "new") {
    process.stderr.write(`${e.dim("a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT end-to-end encrypted).")}\n`);
    // Single optional input: the suggestion is the default, so a bare ENTER names the
    // workspace by its directory (what the old confirm→input two-step did on default+
    // ENTER); "-" is the documented skip (the old confirm's "n" path — keeps it private).
    const ans = interpretWorkspaceNameAnswer(
      await promptInput({ message: `Workspace name (Enter accepts, "-" for none)`, default: collapseHome(dir, os.homedir()) })
    );
    if (ans) name = ans;
  }

  const respectGitignore =
    choice === "new" &&
    (await promptSelect<"false" | "true">({
      message: "How should rbox handle gitignored files?",
      choices: [
        { name: "Sync everything (current behavior)", value: "false" },
        {
          name: "Skip gitignored untracked files",
          value: "true",
          description: "build output and caches stay local; re-include notes/state in .rboxignore",
        },
      ],
    })) === "true";

  const flags = workspaceFlags(
    choice === "new" ? { kind: "new", root: dir, name, respectGitignore } : { kind: "join", root: dir, workspace, name }
  );
  if (setupOpts.noSync) flags["no-sync"] = "true";
  return runInit(flags, { cwd: opts.cwd, defaultRemote: opts.defaultRemote, summary: false });
}

function printSummary(workspaceId: string, deviceId: string): void {
  process.stderr.write(`\n${HR}\n`);
  process.stderr.write(`${e.green("✓")}  ${e.bold("rbox is set up.")}\n`);
  process.stderr.write(`     workspace: ${e.cyan(workspaceId)}     device: ${deviceId}\n`);
  process.stderr.write(`     ${e.dim("This workspace is end-to-end encrypted — the server never sees your files.")}\n`);
  process.stderr.write(`\n   ${e.bold("Bring another machine online:")}\n`);
  process.stderr.write(`     rbox pair      ${e.dim("(here — prints a token)")}\n`);
  process.stderr.write(`     rbox setup     ${e.dim('(there — choose "Log into an existing account" → paste the token)')}\n`);
}
