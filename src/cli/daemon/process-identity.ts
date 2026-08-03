import { execFileSync } from "node:child_process";
import path from "node:path";

export const DAEMON_PROCESS_MARKER = "__daemon-run";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readDaemonCommand(pid: number): string {
  return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

const normalizedRoot = (value: string): string => path.resolve(value.trim());

/**
 * Does this command line name `root` as the daemon's own workspace?
 *
 * The root is the complete tail after `__daemon-run`, including spaces. Trying
 * every whole-token marker avoids both prefix-root matches and marker text in
 * an entry path.
 */
function commandNamesRoot(command: string, root: string): boolean {
  const target = normalizedRoot(root);
  const line = command.replace(/\s+$/u, "");
  for (let at = line.indexOf(DAEMON_PROCESS_MARKER); at !== -1; at = line.indexOf(DAEMON_PROCESS_MARKER, at + 1)) {
    const startsToken = at === 0 || /\s/u.test(line[at - 1]!);
    const after = line[at + DAEMON_PROCESS_MARKER.length];
    if (!startsToken || after === undefined || !/\s/u.test(after)) continue;
    const tail = line.slice(at + DAEMON_PROCESS_MARKER.length).trimStart();
    if (tail.length > 0 && normalizedRoot(tail) === target) return true;
  }
  return false;
}

/** Confirm a PID is an rbox daemon, optionally for one exact workspace root. */
export function daemonProcessMatches(
  pid: number,
  root?: string,
  readCommand: (pid: number) => string = readDaemonCommand,
): boolean {
  if (!isAlive(pid)) return false;
  try {
    const command = readCommand(pid);
    if (!command.includes(DAEMON_PROCESS_MARKER)) return false;
    return root === undefined || commandNamesRoot(command, root);
  } catch {
    return false;
  }
}

/** Standalone daemon ownership check used by upgrade discovery. */
export function isDaemonProcess(pid: number): boolean {
  return daemonProcessMatches(pid);
}
