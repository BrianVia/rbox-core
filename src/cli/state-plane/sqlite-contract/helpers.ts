import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * SQLite opens its FILE-backed temp database with delete-on-close, so a
 * directory listing is normally empty. Observe the live descriptor instead.
 */
export function openFilesWithin(directory: string): string[] | undefined {
  if (process.platform === "linux") {
    const found: string[] = [];
    for (const fd of fs.readdirSync("/proc/self/fd")) {
      try {
        const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (target.startsWith(`${directory}/`)) found.push(target);
      } catch {
        // Descriptors may close between readdir and readlink.
      }
    }
    return found;
  }
  if (process.platform === "darwin") {
    const output = execFileSync("/usr/sbin/lsof", ["-Fn", "-p", String(process.pid)], { encoding: "utf8" });
    return output
      .split("\n")
      .filter((line) => line.startsWith(`n${directory}/`))
      .map((line) => line.slice(1));
  }
  return undefined;
}
