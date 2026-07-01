import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isStandaloneBinary } from "./runtime.js";

const RBOX_DIR = ".rbox";
const PID_FILE = "daemon.pid";
const LOG_FILE = "daemon.log";
const DAEMON_MARKER = "__daemon-run";

const pidPath = (root: string) => path.join(root, RBOX_DIR, PID_FILE);
const logPath = (root: string) => path.join(root, RBOX_DIR, LOG_FILE);

/** argv for re-spawning THIS CLI as the detached daemon (with `process.execPath`).
 *
 *  A compiled binary IS its own entry — `process.execPath` is the rbox binary and Bun
 *  re-injects the `$bunfs` entry as argv[1] itself — so re-passing our own argv[1] would
 *  shift the marker out of the child's command slot, the dispatcher would read a bogus
 *  command and print help, and the daemon would exit without syncing. Under `bun run`
 *  (dev) `process.execPath` is Bun, so the script path (`entry`) IS required. Either
 *  way `DAEMON_MARKER` leads so `isOurDaemon` can match it in `ps` for PID ownership. */
export function daemonSpawnArgs(entry: string, root: string, standalone: boolean): string[] {
  return standalone ? [DAEMON_MARKER, root] : [entry, DAEMON_MARKER, root];
}

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
  const args = daemonSpawnArgs(process.argv[1]!, root, isStandaloneBinary());
  const child = spawn(process.execPath, args, {
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

/** How many trailing lines `rbox logs` shows by default (override with --lines). */
export const DEFAULT_LOG_LINES = 50;

/** Read the last `maxLines` lines of `filePath` without slurping the whole file:
 *  seek from the end in chunks until we've collected enough newlines. Returns the
 *  text plus the byte size we read up to — `follow` resumes streaming from there. */
async function tailFile(filePath: string, maxLines: number): Promise<{ text: string; size: number }> {
  const fd = await fsp.open(filePath, "r");
  try {
    const { size } = await fd.stat();
    if (size === 0 || maxLines <= 0) return { text: "", size };
    const CHUNK = 64 * 1024;
    let pos = size;
    let newlines = 0;
    const parts: Buffer[] = [];
    // Walk backwards a chunk at a time, counting line breaks, until we have one
    // more than requested (the extra bounds the first kept line) or hit the start.
    while (pos > 0 && newlines <= maxLines) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, pos);
      parts.unshift(buf);
      for (let i = 0; i < len; i++) if (buf[i] === 0x0a) newlines++;
    }
    const all = Buffer.concat(parts).toString("utf8");
    const lines = all.split("\n");
    // A trailing newline yields a final empty element — drop it so it isn't counted.
    if (lines[lines.length - 1] === "") lines.pop();
    const text = lines.slice(-maxLines).join("\n");
    return { text: text ? text + "\n" : "", size };
  } finally {
    await fd.close();
  }
}

export interface LogsOptions {
  follow: boolean;
  lines: number;
}

/** `rbox logs` — tail the daemon's log. Prints the last `lines` lines, then (with
 *  `follow`) streams appended output until Ctrl-C. Implemented natively (no `tail`
 *  dependency) so it behaves the same everywhere the CLI runs. */
export async function logsDaemon(root: string, opts: LogsOptions): Promise<void> {
  const lp = logPath(root);
  if (!fs.existsSync(lp)) {
    console.log("(no daemon log yet — start background sync with `rbox start`)");
    return;
  }

  const { text, size } = await tailFile(lp, opts.lines);
  process.stdout.write(text);

  if (!opts.follow) return;

  // A heads-up (to stderr, so it never pollutes piped log output) when there's no
  // daemon producing new lines — otherwise `--follow` looks like a silent hang.
  if (!isDaemonRunning(root).running) {
    process.stderr.write("(daemon not running — waiting for new log lines; Ctrl-C to exit)\n");
  }

  // Poll for appended bytes and stream them. Polling (vs fs.watch) is portable and
  // robust to log rotation: if the file shrinks we treat it as truncation and reset.
  await new Promise<void>((resolve) => {
    let offset = size;
    let reading = false;
    const tick = async () => {
      if (reading) return;
      reading = true;
      try {
        const st = await fsp.stat(lp).catch(() => undefined);
        if (!st) return; // file vanished (untrack/rotation) — keep waiting for it back
        if (st.size < offset) offset = 0; // truncated/rotated → re-read from the top
        if (st.size > offset) {
          const fd = await fsp.open(lp, "r");
          try {
            const buf = Buffer.alloc(st.size - offset);
            await fd.read(buf, 0, buf.length, offset);
            process.stdout.write(buf);
            offset = st.size;
          } finally {
            await fd.close();
          }
        }
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(tick, 250);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
