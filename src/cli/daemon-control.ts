import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const RBOX_DIR = ".rbox";
const PID_FILE = "daemon.pid";
const LOG_FILE = "daemon.log";
const DAEMON_MARKER = "__daemon-run";

const pidPath = (root: string) => path.join(root, RBOX_DIR, PID_FILE);
const logPath = (root: string) => path.join(root, RBOX_DIR, LOG_FILE);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours to signal
  }
}

/** Confirm the pid is actually OUR daemon for THIS root — defends against PID reuse. */
function isOurDaemon(pid: number, root: string): boolean {
  if (!isAlive(pid)) return false;
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes(DAEMON_MARKER) && cmd.includes(root);
  } catch {
    return false; // ps failed / process gone
  }
}

function readPid(root: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(pidPath(root), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Is OUR background-sync daemon currently running for `root`? Used by `status`
 *  (the folded-in `daemon status`) and `untrack` (decide whether to stop first). */
export function isDaemonRunning(root: string): { running: boolean; pid?: number } {
  const pid = readPid(root);
  if (pid !== undefined && isOurDaemon(pid, root)) return { running: true, pid };
  return { running: false };
}

/** Poll until `pid` is gone or `timeoutMs` elapses. Returns true if it exited.
 *  `untrack` uses this to avoid racing a daemon mid-write before removing `.rbox/`. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/** Last-resort SIGKILL for a daemon that ignored SIGTERM (`untrack --force`). */
export function forceKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export async function startDaemon(root: string): Promise<void> {
  const existing = readPid(root);
  if (existing && isOurDaemon(existing, root)) {
    console.log(`rbox daemon already running (pid ${existing})`);
    return;
  }
  if (existing && !isOurDaemon(existing, root)) {
    // Stale pidfile (process died, or pid reused by something else) — clean it.
    await fsp.rm(pidPath(root), { force: true });
  }

  await fsp.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  const out = fs.openSync(logPath(root), "a");
  const entry = process.argv[1]!; // this CLI script (dev: src/cli/index.ts)
  const child = spawn(process.execPath, [entry, DAEMON_MARKER, root], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.closeSync(out);

  if (child.pid) fs.writeFileSync(pidPath(root), String(child.pid));
  console.log(`rbox daemon started (pid ${child.pid}). logs: ${logPath(root)}`);
}

export async function stopDaemon(root: string): Promise<void> {
  const pid = readPid(root);
  if (!pid) {
    console.log("rbox daemon not running (no pidfile)");
    return;
  }
  if (isOurDaemon(pid, root)) {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to rbox daemon (pid ${pid})`);
  } else {
    console.log(`stale pidfile (pid ${pid} is not our daemon); cleaning up`);
  }
  await fsp.rm(pidPath(root), { force: true });
}

export async function logsDaemon(root: string, follow: boolean): Promise<void> {
  const lp = logPath(root);
  if (!fs.existsSync(lp)) {
    console.log("(no daemon log yet)");
    return;
  }
  if (follow) {
    // Hand off to `tail -f` for a live view; Ctrl-C to exit.
    spawn("tail", ["-f", lp], { stdio: "inherit" });
    await new Promise(() => {}); // tail owns the terminal until interrupted
  } else {
    process.stdout.write(fs.readFileSync(lp, "utf8"));
  }
}
