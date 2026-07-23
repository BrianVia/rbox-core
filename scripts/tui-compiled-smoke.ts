#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRigBinaryOverride } from "./rig/lib/binary.js";
import { shellQuote } from "./ux/lib.js";

const binary = resolveRigBinaryOverride({ binary: process.argv[2] });
if (!binary || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--cancel")) {
  throw new Error("usage: bun scripts/tui-compiled-smoke.ts /absolute/path/rbox [--cancel]");
}

const cancel = process.argv[3] === "--cancel";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-tui-smoke-"));
const isolatedBinary = path.join(home, "bin", "rbox");
const session = `rbox-tui-${process.pid}-${Date.now()}`;

function tmux(args: string[], allowFailure = false): string {
  const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`tmux ${args[0] ?? "command"} failed (${result.exitCode})`);
  }
  return result.stdout.toString();
}

function screen(): string {
  return tmux(["capture-pane", "-p", "-S", "-", "-t", session])
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function waitFor(needle: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (screen().includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}\n${screen()}`);
}

function keys(...values: string[]): void {
  for (const value of values) {
    const named = value === "Enter" || value === "Down" || value === "Space" || value === "C-c";
    tmux(["send-keys", "-t", session, ...(named ? ["--", value] : ["-l", "--", value])]);
  }
}

async function waitForExit(expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const dead = tmux(["display-message", "-p", "-t", session, "#{pane_dead}"]).trim();
    if (dead === "1") {
      const status = Number(tmux(["display-message", "-p", "-t", session, "#{pane_dead_status}"]).trim());
      if (status !== expected) throw new Error(`expected exit ${expected}, received ${status}\n${screen()}`);
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for exit ${expected}\n${screen()}`);
}

try {
  fs.mkdirSync(path.dirname(isolatedBinary), { recursive: true });
  fs.copyFileSync(binary, isolatedBinary);
  fs.chmodSync(isolatedBinary, 0o755);
  const command = `tmux set-option -p -t "$TMUX_PANE" remain-on-exit on && exec ${shellQuote(isolatedBinary)} __tui-selftest`;
  tmux([
    "new-session", "-d", "-E", "-s", session, "-x", "100", "-y", "30", "-c", home,
    "-e", `HOME=${home}`, "-e", `RBOX_HOME=${home}`, "--", command,
  ]);
  await waitFor("choose beta");

  if (cancel) {
    keys("C-c");
    await waitForExit(130);
    const transcript = screen();
    if (/stack|PromptCancelledError/i.test(transcript)) throw new Error(`cancellation leaked an error\n${transcript}`);
    process.stdout.write("tui-compiled-smoke cancel ok\n");
  } else {
    keys("Down", "Enter");
    await waitFor("select both");
    keys("Space", "Down", "Space", "Enter");
    await waitFor("type ink");
    keys("ink", "Enter");
    await waitFor("enter secret");
    keys("hush", "Enter");
    await waitFor("finish?");
    keys("y");
    await waitFor("tui-selftest ok");
    await waitForExit(0);
    const transcript = screen();
    if (transcript.includes("hush")) throw new Error(`secret leaked into transcript\n${transcript}`);
    process.stdout.write("tui-compiled-smoke success ok\n");
  }
} finally {
  tmux(["kill-session", "-t", session], true);
  fs.rmSync(home, { recursive: true, force: true });
}
