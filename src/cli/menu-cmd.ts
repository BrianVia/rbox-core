/**
 * `rbox` with no subcommand (interactive) — the onboarding front door.
 *
 * A thin, friendly router over the already-verified `init`/`login` flows: it
 * turns the three real intents (start fresh here / join an existing workspace /
 * just authorize this machine) into one guided pick, so a new user never has to
 * know about bootstrap-vs-device-code or `init --workspace`. All real work still
 * runs through `runInit` + `login` (design 07c: a presentation layer over the
 * flag-driven core). Numbered select keeps it zero-dep; arrow-key/clack-style
 * polish is the deferred OpenTUI layer.
 */
import readline from "node:readline/promises";
import { runInit } from "./init-cmd.js";
import { login } from "./auth-cmd.js";
import { loadCredentials } from "./credentials.js";
import { stderrStyle } from "./style.js";

export type MenuAction = "setup" | "connect" | "login" | "quit";

/** Pure: map a raw menu answer to an action (null = invalid → reprompt). */
export function menuActionFor(input: string): MenuAction | null {
  const s = input.trim().toLowerCase();
  if (s === "1" || s === "setup" || s === "s") return "setup";
  if (s === "2" || s === "connect" || s === "c") return "connect";
  if (s === "3" || s === "login" || s === "l") return "login";
  if (s === "q" || s === "quit") return "quit";
  if (s === "") return "quit"; // bare enter = cancel
  return null;
}

const e = stderrStyle;

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

export async function runMenu(opts: { cwd: string; defaultRemote: string }): Promise<void> {
  const creds = await loadCredentials();

  process.stderr.write(`\n${e.cyan("◆")}  ${e.bold("Welcome to rbox")}\n`);
  if (creds) process.stderr.write(`${e.dim(`   signed in as device ${creds.deviceId}`)}\n`);
  process.stderr.write(`\n${e.bold("What do you want to do?")}\n`);
  process.stderr.write(`   ${e.cyan("1")}  Set up a new workspace   ${e.dim("· this is my first machine / a new project")}\n`);
  process.stderr.write(`   ${e.cyan("2")}  Connect this machine     ${e.dim("· join a workspace that already exists")}\n`);
  process.stderr.write(`   ${e.cyan("3")}  Just log in              ${e.dim("· authorize this machine, nothing else")}\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    let action: MenuAction | null = null;
    while (action === null) {
      action = menuActionFor(await ask(rl, `${e.cyan("›")} `));
      if (action === null) process.stderr.write(e.yellow("   enter 1, 2, or 3 (or q to cancel)\n"));
    }
    if (action === "quit") return;

    if (action === "setup") {
      // First machine on a brand-new account needs the bootstrap secret; an
      // additional machine on an existing account can device-code instead.
      const flags: Record<string, string> = { new: "true" };
      if (!creds) {
        const secret = await ask(rl, `${e.dim("Account bootstrap secret (enter to approve from another machine instead):")} `);
        if (secret) flags.bootstrap = secret;
      }
      rl.close();
      await runInit(flags, opts);
      return;
    }

    if (action === "connect") {
      // Authorize first (device-code unless already signed in), then join.
      if (!creds) {
        rl.close();
        await login(opts.defaultRemote, undefined); // guided device-code flow
        const ws = await promptWorkspace(opts);
        await runInit(ws ? { workspace: ws } : {}, opts);
        return;
      }
      const ws = await ask(rl, `${e.dim("Workspace id to join (from your other machine's setup):")} `);
      rl.close();
      await runInit(ws ? { workspace: ws } : {}, opts);
      return;
    }

    // login only
    const secret = await ask(rl, `${e.dim("Bootstrap secret if you have one (enter to approve from another machine):")} `);
    rl.close();
    await login(opts.defaultRemote, secret || undefined);
  } finally {
    // rl may already be closed above; closing twice is a no-op.
    rl.close();
  }
}

/** Prompt for a workspace id on a fresh readline (used after a login that printed). */
async function promptWorkspace(_opts: { cwd: string; defaultRemote: string }): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await ask(rl, `${e.dim("Workspace id to join (from your other machine's setup):")} `);
  } finally {
    rl.close();
  }
}
