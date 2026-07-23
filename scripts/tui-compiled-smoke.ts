#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRigBinaryOverride } from "./rig/lib/binary.js";
import { shellQuote } from "./ux/lib.js";

const binary = resolveRigBinaryOverride({ binary: process.argv[2] });
const scenario = process.argv[3] ?? "--full";
const scenarios = new Set(["--full", "--cancel", "--secret-retry", "--secret-abort", "--secret-render-error", "--secret-cancel"]);
if (!binary || process.argv.length > 4 || !scenarios.has(scenario)) {
  throw new Error("usage: bun scripts/tui-compiled-smoke.ts /absolute/path/rbox [--cancel|--secret-retry|--secret-abort|--secret-render-error|--secret-cancel]");
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-tui-smoke-"));
const isolatedBinary = path.join(home, "bin", "rbox");
const secret = `rbox-secret-${process.pid}-${Date.now()}-SENTINEL`;
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
      if (status !== expected) {
        // GH-hosted Linux runners intermittently report a Ctrl-C death as
        // status 0 even with a proven-live input pipeline (REVIEW-185 round 6
        // addendum) — darwin, local Linux, and real kill -INT all give the
        // contracted code. With the advisory env set, the pane must still DIE
        // (that part never flakes) and every echo/sentinel assertion still
        // gates; only the numeric status comparison is demoted to a warning.
        if (process.env.RBOX_TUI_SMOKE_STATUS_ADVISORY === "1") {
          process.stdout.write(`::warning::pane died with status ${status}, expected ${expected} (advisory on this runner)\n`);
          return;
        }
        throw new Error(`expected exit ${expected}, received ${status}\n${screen()}`);
      }
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
  const mode = scenario.startsWith("--secret-") ? scenario.slice(2) : "full";
  const command = `tmux set-option -p -t "$TMUX_PANE" remain-on-exit on && exec ${shellQuote(isolatedBinary)} __tui-selftest ${shellQuote(mode)}`;
  tmux([
    "new-session", "-d", "-E", "-s", session, "-x", "100", "-y", "30", "-c", home,
    "-e", `HOME=${home}`, "-e", `RBOX_HOME=${home}`, "--", command,
  ]);
  if (scenario === "--cancel") {
    await waitFor("choose beta");
    // Prove the input pipeline is LIVE before asserting the Ctrl-C contract: a
    // Ctrl-C racing Ink's raw-mode attach is delivered as a signal, whose death
    // status some tmux/CI environments report as 0. The pre-attach window is
    // covered separately by the runtime's SIGINT handler (kill -INT → 130).
    keys("Down");
    await waitFor("❯ Beta");
    keys("C-c");
    await waitForExit(130);
    process.stdout.write("tui-compiled-smoke cancel ok\n");
  } else if (scenario === "--secret-retry") {
    await waitFor("retry secret");
    keys(secret, "Enter");
    await waitFor("try the same secret again");
    keys("Enter");
    await waitFor("secret-retry ok");
    await waitForExit(0);
    process.stdout.write("tui-compiled-smoke secret-retry ok\n");
  } else if (scenario === "--secret-abort") {
    await waitFor("abort secret");
    keys(secret);
    await waitFor("secret-abort ok");
    await waitForExit(0);
    process.stdout.write("tui-compiled-smoke secret-abort ok\n");
  } else if (scenario === "--secret-render-error") {
    await waitFor("secret render failure");
    keys(secret, "Enter");
    await waitFor("secret-render-error ok");
    await waitForExit(0);
    process.stdout.write("tui-compiled-smoke secret-render-error ok\n");
  } else if (scenario === "--secret-cancel") {
    await waitFor("cancel secret");
    keys(secret, "C-c");
    await waitForExit(130);
    process.stdout.write("tui-compiled-smoke secret-cancel ok\n");
  } else {
    await waitFor("choose beta");
    keys("Down", "Enter");
    await waitFor("select both");
    keys("Space", "Down", "Space", "Enter");
    await waitFor("type ink");
    keys("ink", "Enter");
    await waitFor("enter secret");
    keys("hush", "Enter");
    await waitFor("finish?");
    keys("y", "Enter");
    await waitFor("tui-selftest ok");
    await waitForExit(0);
    process.stdout.write("tui-compiled-smoke success ok\n");
  }
  const transcript = screen();
  const savedArtifact = path.join(home, "captured-artifact.txt");
  fs.writeFileSync(savedArtifact, transcript, { mode: 0o600 });
  const captured = fs.readFileSync(savedArtifact, "utf8");
  if (captured.includes(secret) || captured.includes("hush")) throw new Error(`secret leaked into captured artifact\n${captured}`);
  if (/stack|PromptCancelledError/i.test(captured)) throw new Error(`terminal cleanup leaked an error\n${captured}`);
} finally {
  tmux(["kill-session", "-t", session], true);
  fs.rmSync(home, { recursive: true, force: true });
}
