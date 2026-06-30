/**
 * `rbox setup` (design 29) — the single, guided front door, and what bare `rbox`
 * runs in a TTY. A thin presentation layer over already-verified primitives
 * (`runInit`, `login`/`redeemPair`, `startDaemon`), arranged into the founder's
 * three-step arc: Account → Workspace → Start syncing. It replaces `menu-cmd.ts`'s
 * `runMenu`; the menu's "just authorize this machine" option is dropped (served
 * directly by `rbox login`).
 *
 * All prompts render on STDERR (so `rbox setup > log` never pollutes stdout). The
 * pure input→intent mappers (`accountChoiceFor`, `authMethodFor`, `isYes`,
 * `workspaceFlags`) carry the step transitions and are unit-tested without a TTY.
 *
 * Hard stop: a device-code login authorizes but does NOT enroll this machine for
 * encryption (auth-cmd.ts:78), and `runInit` aborts pre-sync when unenrolled
 * (init-cmd.ts). So the device-code branch resolves enrollment FIRST and stops with
 * pair/connect/recover next steps — it never promises Steps 2–3 it can't deliver.
 */
import readline from "node:readline/promises";
import { runInit } from "./init-cmd.js";
import { login, redeemPair } from "./auth-cmd.js";
import { startDaemon } from "./daemon-control.js";
import { loadCredentials } from "./credentials.js";
import { hasDevice } from "./e2ee-keystore.js";
import { stderrStyle as e } from "./style.js";

// ── pure input → intent mappers (the step transitions) ───────────────────────

export type AccountChoice = "create" | "existing" | null;
export function accountChoiceFor(input: string): AccountChoice {
  const s = input.trim().toLowerCase();
  if (s === "1" || s === "create" || s === "new" || s === "n") return "create";
  if (s === "2" || s === "existing" || s === "login" || s === "log in" || s === "l") return "existing";
  return null;
}

export type AuthMethod = "pair" | "approve" | null;
export function authMethodFor(input: string): AuthMethod {
  const s = input.trim().toLowerCase();
  if (s === "p" || s === "pair" || s === "paste") return "pair";
  if (s === "a" || s === "approve" || s === "code") return "approve";
  return null;
}

export type WorkspaceChoice = "new" | "existing" | null;
export function workspaceChoiceFor(input: string): WorkspaceChoice {
  const s = input.trim().toLowerCase();
  if (s === "1" || s === "new" || s === "create") return "new";
  if (s === "2" || s === "existing" || s === "track" || s === "join") return "existing";
  return null;
}

/** Map a workspace decision to the exact `runInit` flags (the populate-sync runs
 *  inside runInit: push for a new workspace, pull+push for a join). */
export function workspaceFlags(plan: { kind: "new" | "join"; root: string; workspace?: string }): Record<string, string> {
  const flags: Record<string, string> = { root: plan.root, project: "root", "no-interactive": "true" };
  if (plan.kind === "new") flags.new = "true";
  else flags.workspace = plan.workspace ?? "";
  return flags;
}

/** Parse a [Y/n] / [y/N] answer. Blank → the default. */
export function isYes(input: string, defaultYes: boolean): boolean {
  const s = input.trim().toLowerCase();
  if (s === "") return defaultYes;
  return s === "y" || s === "yes";
}

// ── interactive I/O helpers ───────────────────────────────────────────────────

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

/** No-echo secret prompt (the bootstrap secret / pairing token are bearer secrets;
 *  plain readline echoes them — design M5). Renders the prompt on stderr. */
async function readSecret(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (val: string) => {
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      resolve(val);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 0x0a || code === 0x0d || code === 0x04) return done(buf); // LF/CR/EOT
        if (code === 0x03) {
          process.stderr.write("\n");
          process.exit(130); // Ctrl-C
        }
        if (code === 0x7f || code === 0x08) buf = buf.slice(0, -1); // DEL/BS
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!(await alreadyEnrolled())) {
      const enrolled = await stepAccount(rl, opts.defaultRemote);
      if (!enrolled) return; // device-code hard stop already printed
    } else {
      process.stderr.write(`${e.dim("This machine is already signed in and enrolled. Continuing to your workspace.")}\n`);
    }

    // Step 2 · Workspace — bind a directory + run the initial populate-sync.
    const outcome = await stepWorkspace(rl, opts);
    if (!outcome) return;

    // Step 3 · Start syncing in the background.
    process.stderr.write(`\n── ${e.bold("Step 3 of 3 · Start syncing")} ${HR.slice(0, 38)}\n`);
    const keep = isYes(await ask(rl, `${e.cyan("?")} Keep this workspace syncing in the background? ${e.dim("[Y/n]")} `), true);
    if (keep) {
      await startDaemon(outcome.root);
      process.stderr.write(`${e.green("✓")} Background sync started. Stop anytime with \`rbox stop\`.\n`);
    } else {
      process.stderr.write(`${e.dim("Run `rbox start` whenever you're ready.")}\n`);
    }

    // Opt-in dependency-change notifications (drift surface 1).
    const notify = isYes(await ask(rl, `${e.cyan("?")} Be notified when dependencies change? ${e.dim("[Y/n]")} `), true);
    if (notify) {
      const { installNotify } = await import("./deps-notify.js");
      try {
        await installNotify();
      } catch (err) {
        process.stderr.write(`${e.yellow("!")} ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    printSummary(outcome.workspaceId, outcome.deviceId);
  } finally {
    rl.close();
  }
}

/** True when this machine already holds the account's key material (skip Step 1). */
async function alreadyEnrolled(): Promise<boolean> {
  const creds = await loadCredentials();
  return Boolean(creds?.accountId && (await hasDevice(creds.accountId)));
}

/** Step 1 · Account. Returns true if this machine is now enrolled (flow continues),
 *  false if it hard-stopped on the device-code (authorize-only) path. */
async function stepAccount(rl: readline.Interface, remote: string): Promise<boolean> {
  process.stderr.write(`\n── ${e.bold("Step 1 of 3 · Account")} ${HR.slice(0, 46)}\n`);
  let choice: AccountChoice = null;
  while (choice === null) {
    process.stderr.write(`${e.cyan("?")} Are you new here, or do you already have an rbox account?\n`);
    process.stderr.write(`   ${e.cyan("1")}  Create a new account\n`);
    process.stderr.write(`   ${e.cyan("2")}  Log into an existing account\n`);
    choice = accountChoiceFor(await ask(rl, `${e.cyan("›")} `));
    if (choice === null) process.stderr.write(e.yellow("   enter 1 or 2\n"));
  }

  if (choice === "create") {
    const secret = await readSecret(`${e.dim("Account bootstrap secret (enter to approve from another machine instead):")} `);
    // A secret bootstraps the genesis device (shows the recovery phrase); blank falls
    // back to device-code, which authorizes but can't enroll → enrollmentOk hard-stops.
    await login(remote, secret || undefined);
    return enrollmentOk();
  }

  // Existing account.
  let method: AuthMethod = null;
  while (method === null) {
    process.stderr.write(`${e.cyan("?")} How do you want to authorize this machine?\n`);
    process.stderr.write(`   ${e.cyan("p")}  Paste a pairing token   ${e.dim("· from `rbox pair` — fewest steps, also enrolls encryption")}\n`);
    process.stderr.write(`   ${e.cyan("a")}  Approve a code          ${e.dim("· this machine shows a code you approve elsewhere")}\n`);
    method = authMethodFor(await ask(rl, `${e.cyan("›")} `));
    if (method === null) process.stderr.write(e.yellow("   enter p or a\n"));
  }

  if (method === "pair") {
    const token = await readSecret(`${e.dim("Paste pairing token:")} `);
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
  rl: readline.Interface,
  opts: { cwd: string; defaultRemote: string }
): Promise<{ workspaceId: string; deviceId: string; root: string } | undefined> {
  process.stderr.write(`\n── ${e.bold("Step 2 of 3 · Workspace")} ${HR.slice(0, 44)}\n`);
  let choice: WorkspaceChoice = null;
  while (choice === null) {
    process.stderr.write(`${e.cyan("?")} What do you want to track here?\n`);
    process.stderr.write(`   ${e.cyan("1")}  Create a new workspace from a directory\n`);
    process.stderr.write(`   ${e.cyan("2")}  Track an existing workspace   ${e.dim("· paste its id from another machine")}\n`);
    choice = workspaceChoiceFor(await ask(rl, `${e.cyan("›")} `));
    if (choice === null) process.stderr.write(e.yellow("   enter 1 or 2\n"));
  }

  let workspace: string | undefined;
  if (choice === "existing") {
    workspace = await ask(rl, `${e.dim("Workspace id to track:")} `);
    if (!workspace) {
      process.stderr.write(e.yellow("no workspace id — re-run `rbox setup` when you have it.\n"));
      return undefined;
    }
  }
  const dir = (await ask(rl, `${e.cyan("?")} Which directory should rbox sync? ${e.dim(`[${opts.cwd}]`)} `)) || opts.cwd;

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
