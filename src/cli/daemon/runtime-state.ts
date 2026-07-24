import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { daemonBoundPath, daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "../rbox-paths.js";

const RBOX_DIR = ".rbox";
export const DAEMON_BOOT_ID_ENV = "RBOX_DAEMON_BOOT_ID";
const pidPath = daemonPidPath;
const boundPath = daemonBoundPath;

export interface ParsedDaemonBinding {
  workspaceId?: string;
  bootId?: string;
  version: "legacy" | "v2" | "invalid";
}

export interface ParsedDaemonPid {
  pid?: number;
  bootId?: string;
  version: "legacy" | "v2" | "invalid";
}

type ParsedDaemonLine<T> =
  | { version: "legacy"; value: T }
  | { version: "v2"; value: T; bootId: string }
  | { version: "invalid" };

function parseDualFormatLine<T>(raw: string, parseValue: (s: string | undefined) => T | undefined): ParsedDaemonLine<T> {
  const line = raw.trim();
  if (!line) return { version: "invalid" };
  const parts = line.split(/\s+/);
  if (parts[0] === "v2") {
    const value = parseValue(parts[1]);
    const bootId = parts[2];
    return parts.length === 3 && value !== undefined && bootId ? { version: "v2", value, bootId } : { version: "invalid" };
  }
  const value = parts.length === 1 ? parseValue(line) : undefined;
  return value !== undefined ? { version: "legacy", value } : { version: "invalid" };
}

export function parseDaemonBinding(raw: string): ParsedDaemonBinding {
  const parsed = parseDualFormatLine(raw, (s) => (s ? s : undefined));
  if (parsed.version === "invalid") return { version: "invalid" };
  return {
    version: parsed.version,
    workspaceId: parsed.value,
    ...(parsed.version === "v2" ? { bootId: parsed.bootId } : {}),
  };
}

export function parseDaemonPid(raw: string): ParsedDaemonPid {
  const parsePid = (s: string | undefined): number | undefined => {
    const n = Number(s);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const parsed = parseDualFormatLine(raw, parsePid);
  if (parsed.version === "invalid") return { version: "invalid" };
  return {
    version: parsed.version,
    pid: parsed.value,
    ...(parsed.version === "v2" ? { bootId: parsed.bootId } : {}),
  };
}

/** Called by the daemon at startup: record which workspace id THIS daemon bound.
 *  `startDaemon` compares it against the root's current binding to detect a daemon
 *  left over from a previous init of the same root (which would 404 on every op
 *  forever — the observed "setup says started, nothing ever syncs" failure). */
export async function recordDaemonBinding(root: string, workspaceId: string, bootId?: string): Promise<void> {
  await fsp.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fsp.writeFile(boundPath(root), bootId ? `v2 ${workspaceId} ${bootId}\n` : `${workspaceId}\n`);
}

/** The workspace id recorded by a daemon at startup (undefined: absent, unreadable,
 *  empty, pre-binding daemon, or never started — callers must treat unknown as
 *  "can't tell", not stale). */
export function readDaemonBinding(root: string): string | undefined {
  return readDaemonBindingRecord(root).workspaceId;
}

export interface DaemonBindingRecord {
  present: boolean;
  workspaceId?: string;
  bootId?: string;
  version?: "legacy" | "v2" | "invalid";
  unreadable?: boolean;
}

/** Read the daemon binding file without consulting daemon liveness. Diagnostics uses this
 *  to avoid leaking stale daemon-owned sidecars left behind by a crashed/stopped daemon. */
export function readDaemonBindingRecord(root: string): DaemonBindingRecord {
  try {
    const parsed = parseDaemonBinding(fs.readFileSync(boundPath(root), "utf8"));
    return parsed.workspaceId
      ? { present: true, workspaceId: parsed.workspaceId, bootId: parsed.bootId, version: parsed.version }
      : { present: true, unreadable: true, version: parsed.version };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true, unreadable: true };
  }
}

/** The workspace id `root` is CURRENTLY bound to — a plain read of
 *  `<root>/.rbox/workspace.json` (no decryption; the id is not a secret). */
export function currentWorkspaceId(root: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, RBOX_DIR, "workspace.json"), "utf8")) as {
      remoteWorkspaceId?: unknown;
    };
    return typeof raw.remoteWorkspaceId === "string" && raw.remoteWorkspaceId ? raw.remoteWorkspaceId : undefined;
  } catch {
    return undefined;
  }
}


export interface DaemonPidRecord {
  present: boolean;
  pid?: number;
  bootId?: string;
  version?: "legacy" | "v2" | "invalid";
  unreadable?: boolean;
}

export function readDaemonPidRecord(root: string): DaemonPidRecord {
  try {
    const parsed = parseDaemonPid(fs.readFileSync(pidPath(root), "utf8"));
    return parsed.pid
      ? { present: true, pid: parsed.pid, bootId: parsed.bootId, version: parsed.version }
      : { present: true, unreadable: true, version: parsed.version };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true, unreadable: true };
  }
}

export function publishDaemonPidRecord(root: string, pid: number, bootId: string): void {
  fs.writeFileSync(pidPath(root), `v2 ${pid} ${bootId}\n`);
}

export async function removeDaemonPidRecord(root: string): Promise<void> {
  await fsp.rm(pidPath(root), { force: true });
}

export async function ensureDaemonRuntime(root: string): Promise<void> {
  await fsp.mkdir(daemonRuntimeDir(root), { recursive: true });
}

export async function clearDaemonStartupState(root: string): Promise<void> {
  await fsp.rm(boundPath(root), { force: true });
  await fsp.rm(daemonStatusPath(root), { force: true });
}

export function daemonPidRecordMatches(record: DaemonPidRecord, expected: DaemonPidRecord): boolean {
  return record.present === expected.present
    && record.pid === expected.pid
    && record.bootId === expected.bootId
    && record.version === expected.version;
}

export async function removeDaemonPidRecordIfMatches(root: string, expected: DaemonPidRecord): Promise<void> {
  if (daemonPidRecordMatches(readDaemonPidRecord(root), expected)) await removeDaemonPidRecord(root);
}

/** Remove the global pid/log dir for `root` — called by `untrack` so tearing down
 *  a workspace leaves no orphaned runtime files behind under `~/.rbox`. */
export async function removeDaemonRuntime(root: string): Promise<void> {
  await fsp.rm(daemonRuntimeDir(root), { recursive: true, force: true });
}
