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
 * Hard stop: a device-code login authorizes but does NOT enroll this machine for
 * encryption (auth-cmd.ts:78), and `runInit` aborts pre-sync when unenrolled
 * (init-cmd.ts). So the device-code branch resolves enrollment FIRST and stops with
 * pair/connect/recover next steps — it never promises Steps 2–3 it can't deliver.
 */
import { runInit } from "./init-cmd.js";
import { login, redeemPair } from "./auth-cmd.js";
import { startDaemon } from "./daemon-control.js";
import { loadCredentials } from "./credentials.js";
import { hasDevice } from "./e2ee-keystore.js";
import { promptWorkspacePick } from "./workspace-picker.js";
import { promptSelect, promptInput, promptConfirm, promptPassword } from "./prompt.js";
import { stderrStyle as e } from "./style.js";

/** Map a workspace decision to the exact `runInit` flags (the populate-sync runs
 *  inside runInit: push for a new workspace, pull+push for a join). */
export function workspaceFlags(plan: { kind: "new" | "join"; root: string; workspace?: string; name?: string }): Record<string, string> {
  const flags: Record<string, string> = { root: plan.root, project: "root", "no-interactive": "true" };
  if (plan.kind === "new") flags.new = "true";
  else {
    flags.workspace = plan.workspace ?? "";
    // A known name (from the picker) is cached LOCALLY by init — never re-sent to the
    // server on a join (only createRemoteWorkspace carries a name). Manual-id entry
    // has no name, so the flag is simply absent and status falls back to the id.
    if (plan.name) flags.name = plan.name;
  }
  return flags;
}

const HR = "─".repeat(72);

// ── the guided flow ───────────────────────────────────────────────────────────

export async function runSetup(opts: { cwd: string; defaultRemote: string }): Promise<void> {
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      "rbox setup is interactive. For scripts/CI use `rbox init` " +
        "(e.g. `rbox init --new --root <path> --bootstrap <secret>`). Run `rbox help init` for details.\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`\n${e.cyan("◆")}  ${e.bold("Welcome to rbox")} — end-to-end encrypted sync for your dev workspaces.\n`);

  // Step 1 · Account — unless this machine is already enrolled.
  if (!(await alreadyEnrolled())) {
    const enrolled = await stepAccount(opts.defaultRemote);
    if (!enrolled) return; // device-code hard stop already printed
  } else {
    process.stderr.write(`${e.dim("This machine is already signed in and enrolled. Continuing to your workspace.")}\n`);
  }

  // Step 2 · Workspace — bind a directory + run the initial populate-sync.
  const outcome = await stepWorkspace(opts);
  if (!outcome) return;

  // Step 3 · Start syncing in the background.
  process.stderr.write(`\n── ${e.bold("Step 3 of 3 · Start syncing")} ${HR.slice(0, 38)}\n`);
  const keep = await promptConfirm({ message: "Keep this workspace syncing in the background?", default: true });
  if (keep) {
    await startDaemon(outcome.root);
    process.stderr.write(`${e.green("✓")} Background sync started. Stop anytime with \`rbox stop\`.\n`);
  } else {
    process.stderr.write(`${e.dim("Run `rbox start` whenever you're ready.")}\n`);
  }

  // Opt-in dependency-change notifications (drift surface 1).
  const notify = await promptConfirm({ message: "Be notified when dependencies change?", default: true });
  if (notify) {
    const { installNotify } = await import("./deps-notify.js");
    try {
      await installNotify();
    } catch (err) {
      process.stderr.write(`${e.yellow("!")} ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  printSummary(outcome.workspaceId, outcome.deviceId);
}

/** True when this machine already holds the account's key material (skip Step 1). */
async function alreadyEnrolled(): Promise<boolean> {
  const creds = await loadCredentials();
  return Boolean(creds?.accountId && (await hasDevice(creds.accountId)));
}

/** Step 1 · Account. Returns true if this machine is now enrolled (flow continues),
 *  false if it hard-stopped on the device-code (authorize-only) path. */
async function stepAccount(remote: string): Promise<boolean> {
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
    // back to device-code, which authorizes but can't enroll → enrollmentOk hard-stops.
    await login(remote, secret || undefined);
    return enrollmentOk();
  }

  // Existing account.
  const method = await promptSelect<"pair" | "approve">({
    message: "How do you want to authorize this machine?",
    choices: [
      { name: "Paste a pairing token", value: "pair", description: "from `rbox pair` — fewest steps, also enrolls encryption" },
      { name: "Approve a code", value: "approve", description: "this machine shows a code you approve elsewhere" },
    ],
  });

  if (method === "pair") {
    const token = await promptPassword({ message: "Paste pairing token" });
    if (!token) {
      process.stderr.write(e.yellow("no token entered — run `rbox pair` on a signed-in machine, then re-run `rbox setup`.\n"));
      return false;
    }
    await redeemPair(remote, token); // enrolls inline → flows straight on
    return enrollmentOk();
  }

  await login(remote, undefined); // device-code: authorizes but does not enroll
  return enrollmentOk();
}

/** Re-check enrollment (the robust signal init also uses). On the device-code path
 *  this is false → print the hard-stop next steps and end Step 1 here. */
async function enrollmentOk(): Promise<boolean> {
  if (await alreadyEnrolled()) return true;
  process.stderr.write(
    `\n${e.yellow("⚠")}  This machine is authorized — but NOT yet enrolled for encryption.\n` +
      `   Device-code login can't carry your key, so setup stops here. Next:\n` +
      `     on a signed-in machine:  rbox pair        ${e.dim("# prints a token")}\n` +
      `     here:                    rbox connect     ${e.dim("# paste it  (or: rbox recover)")}\n` +
      `     then:                    rbox setup       ${e.dim("# re-run — Step 2 continues")}\n`
  );
  return false;
}

/** Step 2 · Workspace. Returns the init outcome, or undefined if the user backed out. */
async function stepWorkspace(
  opts: { cwd: string; defaultRemote: string }
): Promise<{ workspaceId: string; deviceId: string; root: string } | undefined> {
  process.stderr.write(`\n── ${e.bold("Step 2 of 3 · Workspace")} ${HR.slice(0, 44)}\n`);
  const choice = await promptSelect<"new" | "existing">({
    message: "What do you want to track here?",
    choices: [
      { name: "Create a new workspace from a directory", value: "new" },
      { name: "Track an existing workspace", value: "existing", description: "pick one you've already synced" },
    ],
  });

  let workspace: string | undefined;
  if (choice === "existing") {
    // Pick-by-name from the account's synced workspaces (degrades to a manual id
    // prompt when offline / no creds / empty account).
    const creds = await loadCredentials();
    workspace = await promptWorkspacePick({ baseUrl: creds?.remoteUrl ?? opts.defaultRemote, token: creds?.token });
    if (!workspace) {
      process.stderr.write(e.yellow("no workspace selected — re-run `rbox setup` when you're ready.\n"));
      return undefined;
    }
  }
  const dir = await promptInput({ message: "Which directory should rbox sync?", default: opts.cwd });

  const flags = workspaceFlags(choice === "new" ? { kind: "new", root: dir } : { kind: "join", root: dir, workspace });
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
