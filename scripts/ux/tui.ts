#!/usr/bin/env bun
import { assertMachineHome } from "./fresh-machine.js";
import { assertGuestMachineHome, configureUxRuntime, containerRboxEnv, execUx, uxContainerName } from "./container.js";
import { assertNoAncestorWorkspace, DEV_API, executionMode, safeId, SCRUBBED_ENV, shellQuote } from "./lib.js";

export { shellQuote } from "./lib.js";

const NAMED_KEYS = new Set(["Enter", "Up", "Down", "Left", "Right", "Tab", "Escape", "Space", "BSpace", "C-c", "C-d", "C-z"]);
interface Target { host: boolean; runId?: string }
export type TuiArgs =
  | ({ command: "start"; session: string; home: string; cols: number; rows: number; child: string[] } & Target)
  | ({ command: "keys"; session: string; keys: string[]; slow: boolean } & Target)
  | ({ command: "screen"; session: string; strip: boolean } & Target)
  | ({ command: "wait-idle"; session: string; timeout: number } & Target)
  | ({ command: "stop"; session: string } & Target);

function usage(message: string): never {
  throw new Error(`${message}\nusage: tui.ts <command> --run-id <id> ... (container default) | <command> --host ...`);
}

function sessionName(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) return usage("invalid or missing --session");
  return value;
}

function positive(value: string | undefined, flag: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) return usage(`${flag} needs a positive integer`);
  return number;
}

function parsedOptions(tokens: string[], values: Set<string>, booleans = new Set<string>()): { map: Map<string, string>; positional: string[] } {
  const map = new Map<string, string>(); const positional: string[] = []; let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (literal) { positional.push(token); continue; }
    if (token === "--") { literal = true; continue; }
    if (values.has(token) || booleans.has(token)) {
      if (map.has(token)) usage(`duplicate option: ${token}`);
      if (booleans.has(token)) map.set(token, "true");
      else { const value = tokens[++i]; if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`); map.set(token, value); }
    } else if (token.startsWith("--")) usage(`unknown option: ${token}`); else positional.push(token);
  }
  return { map, positional };
}

function target(map: Map<string, string>): Target {
  const host = map.has("--host"); const raw = map.get("--run-id");
  if (host && raw) usage("--run-id cannot be combined with --host");
  if (!host && !raw) usage("container mode requires --run-id");
  return { host, ...(raw ? { runId: safeId("run id", raw) } : {}) };
}

const commonValues = ["--session", "--run-id"];
export function parseTuiArgs(argv: string[]): TuiArgs {
  const [command, ...rest] = argv;
  if (command === "start") {
    const split = rest.indexOf("--"); if (split < 0) usage("start requires -- before the rbox command");
    const before = parsedOptions(rest.slice(0, split), new Set([...commonValues, "--home", "--cols", "--rows"]), new Set(["--host"]));
    if (before.positional.length) usage(`unexpected argument: ${before.positional[0]}`);
    const child = rest.slice(split + 1); assertDirectDevRbox(child);
    const home = before.map.get("--home"); if (!home) usage("start requires --home");
    return { command, session: sessionName(before.map.get("--session")), home, cols: positive(before.map.get("--cols"), "--cols", 100), rows: positive(before.map.get("--rows"), "--rows", 30), child, ...target(before.map) };
  }
  if (command === "keys") {
    const p = parsedOptions(rest, new Set(commonValues), new Set(["--slow", "--host"]));
    if (!p.positional.length) usage("keys requires at least one key or text token");
    return { command, session: sessionName(p.map.get("--session")), keys: p.positional, slow: p.map.has("--slow"), ...target(p.map) };
  }
  if (command === "screen") {
    const p = parsedOptions(rest, new Set(commonValues), new Set(["--strip", "--host"]));
    if (p.positional.length) usage(`unexpected argument: ${p.positional[0]}`);
    return { command, session: sessionName(p.map.get("--session")), strip: p.map.has("--strip"), ...target(p.map) };
  }
  if (command === "wait-idle") {
    const p = parsedOptions(rest, new Set([...commonValues, "--timeout"]), new Set(["--host"]));
    if (p.positional.length) usage(`unexpected argument: ${p.positional[0]}`);
    return { command, session: sessionName(p.map.get("--session")), timeout: positive(p.map.get("--timeout"), "--timeout", 10), ...target(p.map) };
  }
  if (command === "stop") {
    const p = parsedOptions(rest, new Set(commonValues), new Set(["--host"]));
    if (p.positional.length) usage(`unexpected argument: ${p.positional[0]}`);
    return { command, session: sessionName(p.map.get("--session")), ...target(p.map) };
  }
  return usage(command ? `unknown command: ${command}` : "missing command");
}

export function assertDirectDevRbox(command: string[]): void {
  if (command[0] !== "rbox") throw new Error("tui start only accepts the direct `rbox` executable");
  for (let i = 1; i < command.length; i++) {
    const token = command[i]!;
    if (token === "--remote") { const remote = command[++i]; if (remote !== DEV_API) throw new Error(`refusing non-DEV --remote: ${remote ?? "missing"}`); }
    else if (token.startsWith("--remote=") && token.slice("--remote=".length) !== DEV_API) throw new Error(`refusing non-DEV remote override: ${token}`);
    else if (/RBOX_API\s*=/.test(token) || [...token.matchAll(/https?:\/\/[^\s'\"]+/g)].some(([url]) => url !== DEV_API)) throw new Error(`refusing possible non-DEV remote override: ${token}`);
  }
}

export function renderCommand(argv: string[]): string { return `exec ${argv.map(shellQuote).join(" ")}`; }

export function renderRetainedCommand(argv: string[]): string {
  return `tmux set-option -p -t "$TMUX_PANE" remain-on-exit on && ${renderCommand(argv)}`;
}

export function tmuxStartArgs(session: string, home: string, cols: number, rows: number, child: string[]): string[] {
  const env: Record<string, string> = { HOME: home, RBOX_HOME: home, RBOX_API: DEV_API, RBOX_API_QUIET: "1", RBOX_APP: "" };
  for (const key of SCRUBBED_ENV) if (!(key in env)) env[key] = "";
  const injected = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return ["new-session", "-d", "-E", "-s", session, "-x", String(cols), "-y", String(rows), "-c", home, ...injected, "--", renderRetainedCommand(child)];
}

async function tmuxHost(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).arrayBuffer()]);
  const exit = await child.exited; if (exit !== 0) throw new Error(`tmux ${args[0] ?? "command"} failed (exit ${exit}); child output suppressed`);
  return capture ? stdout : "";
}

export function containerTmuxPlan(runId: string, args: string[], home?: string): { name: string; cmd: string[]; home?: string; env?: Record<string, string> } {
  const id = safeId("run id", runId);
  if (home) assertGuestMachineHome(home, id);
  return { name: uxContainerName(id), cmd: ["tmux", ...args], ...(home ? { home, env: containerRboxEnv(home) } : {}) };
}

async function tmuxContainer(runId: string, args: string[], capture = false, home?: string): Promise<string> {
  const plan = containerTmuxPlan(runId, args, home);
  const result = await execUx(runId, plan.cmd, { home: plan.home, env: plan.env, allowFail: true });
  if (result.exitCode !== 0) throw new Error(`tmux ${args[0] ?? "command"} failed (exit ${result.exitCode}); child output suppressed`);
  return capture ? result.stdout : "";
}

export function stripTrailingBlankLines(screen: string): string { return screen.replace(/(?:\r?\n[ \t]*)+$/, ""); }
export interface WaitDeps { capture: () => Promise<string>; sleep: (ms: number) => Promise<void>; now: () => number }
export async function waitForStable(timeoutSeconds: number, deps: WaitDeps): Promise<{ screen: string; stable: boolean }> {
  const deadline = deps.now() + timeoutSeconds * 1000; let screen = await deps.capture(); let matches = 0;
  while (deps.now() < deadline) { await deps.sleep(500); const next = await deps.capture(); matches = next === screen ? matches + 1 : 0; screen = next; if (matches >= 1) return { screen, stable: true }; }
  return { screen, stable: false };
}

export function keyTmuxArgs(session: string, key: string): string[] {
  return NAMED_KEYS.has(key) ? ["send-keys", "-t", session, "--", key] : ["send-keys", "-t", session, "-l", "--", key];
}

async function sendKeys(args: Extract<TuiArgs, { command: "keys" }>, invoke: (argv: string[]) => Promise<string>): Promise<void> {
  for (const key of args.keys) {
    if (NAMED_KEYS.has(key)) await invoke(keyTmuxArgs(args.session, key));
    else if (args.slow) for (const char of key) { await invoke(keyTmuxArgs(args.session, char)); await Bun.sleep(50); }
    else await invoke(keyTmuxArgs(args.session, key));
  }
}

function printScreen(screen: string): void { process.stdout.write(screen.endsWith("\n") ? screen : `${screen}\n`); }

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseTuiArgs(argv); const mode = executionMode(args.host); if (mode === "container") configureUxRuntime();
  const invoke = (tmuxArgs: string[], capture = false, home?: string) => mode === "host" ? tmuxHost(tmuxArgs, capture) : tmuxContainer(args.runId!, tmuxArgs, capture, home);
  if (args.command === "start") {
    const home = mode === "host" ? await assertMachineHome(args.home) : (assertGuestMachineHome(args.home, args.runId), args.home);
    if (mode === "host") await assertNoAncestorWorkspace(home);
    await invoke(tmuxStartArgs(args.session, home, args.cols, args.rows, args.child), false, mode === "container" ? home : undefined);
  } else if (args.command === "keys") await sendKeys(args, (tmuxArgs) => invoke(tmuxArgs));
  else if (args.command === "screen") printScreen(args.strip ? stripTrailingBlankLines(await invoke(["capture-pane", "-p", "-t", args.session], true)) : await invoke(["capture-pane", "-p", "-t", args.session], true));
  else if (args.command === "wait-idle") {
    const result = await waitForStable(args.timeout, { capture: () => invoke(["capture-pane", "-p", "-t", args.session], true), sleep: Bun.sleep, now: Date.now }); printScreen(result.screen);
    if (!result.stable) throw new Error(`screen did not become idle within ${args.timeout}s`);
  } else {
    // Retained dead panes normally keep the session available to kill. If another
    // teardown already removed it, stop is still successful so chains keep going.
    try { await invoke(["kill-session", "-t", args.session]); }
    catch (error) { process.stderr.write(`session already stopped: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
