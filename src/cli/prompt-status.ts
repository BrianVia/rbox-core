import path from "node:path";
import { formatPromptStatus, promptStatusJson, readPromptStatus } from "./daemon/ambient-status.js";

// Programmatic ambient status surface for Starship/p10k/tooling. The default zsh
// integration stays on the pure-zsh shell.line reader so precmd spawns no subprocess.
export function runPromptStatus(argv: string[]): void {
  let json = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: rbox prompt-status [path] [--json]\nprogrammatic ambient status for Starship/p10k/tooling\n");
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    process.stderr.write("usage: rbox prompt-status [path] [--json]\n");
    process.exitCode = 1;
    return;
  }
  const start = positional[0] ? path.resolve(positional[0]) : process.cwd();
  const verdict = readPromptStatus(start);
  const out = json ? promptStatusJson(verdict) : formatPromptStatus(verdict);
  if (out) process.stdout.write(`${out}\n`);
}
