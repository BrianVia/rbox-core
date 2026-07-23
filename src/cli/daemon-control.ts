import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { systemLockIdentity } from "../engine/git/lockfile.js";
import { isStandaloneBinary } from "./runtime.js";
import { daemonBoundPath, daemonCrashLogPath, daemonPidPath, daemonRuntimeDir, daemonStatusPath, workspaceKey } from "./rbox-paths.js";
import { parseDaemonDatedLogBasename } from "./daemon/logger.js";
import { AMBIENT_STATUS_STALE_MS, readAmbientDaemonStatusRecord, type DaemonMode } from "./daemon/ambient-status.js";
import { RBOX_VERSION } from "./version.js";
export { daemonBoundPath, daemonCrashLogPath, daemonPidPath, daemonRuntimeDir, daemonStatusPath, workspaceKey } from "./rbox-paths.js";

const RBOX_DIR = ".rbox";
const PID_FILE = "daemon.pid";
const LOG_FILE = "daemon.log";
const BOUND_FILE = "workspace.bound";
const DAEMON_MARKER = "__daemon-run";
export const DAEMON_BOOT_ID_ENV = "RBOX_DAEMON_BOOT_ID";
export const DAEMON_HEARTBEAT_FUTURE_SKEW_MS = 2 * 60_000;

const pidPath = daemonPidPath;
const logPath = daemonCrashLogPath;
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

/** The daemon-binding verdict for user-facing liveness: only a LIVE daemon with a
 *  known mismatching startup binding is stale. Unknown binding (pre-binding daemon)
 *  remains "can't tell", matching the existing status rule. Diagnostics sidecar
 *  exclusion separately reads `workspace.bound` independent of liveness. */
export function daemonBindingStatus(root: string, workspaceId: string): {
  alive: { running: boolean; pid?: number; bootId?: string };
  bound?: string;
  stale: boolean;
} {
  const alive = isDaemonRunning(root);
  const bound = alive.running ? readDaemonBinding(root) : undefined;
  return { alive, bound, stale: alive.running && bound !== undefined && bound !== workspaceId };
}

/** Pre-global location of the pid/log (inside the workspace). Kept only as a
 *  READ fallback so a daemon started before this change stays visible to `rbox
 *  logs`; nothing new is ever written here. Pre-launch back-compat, not migration. */
const legacyLogPath = (root: string) => path.join(root, RBOX_DIR, LOG_FILE);

/** Resolve the dated operational stream plus independent crash and legacy
 * channels. The latter two never suppress each other or the dated stream. */
export interface DaemonLogSources {
  crash?: string;
  dated?: string;
  legacy?: string;
}

/** Resolve independent daemon channels by filename calendar date, never mtime. */
export async function resolveDaemonLogSources(root: string, now: Date = new Date()): Promise<DaemonLogSources> {
  const runtime = daemonRuntimeDir(root);
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  let dated: string | undefined;
  try {
    const eligible: string[] = [];
    for (const name of await fsp.readdir(runtime)) {
      const parsed = parseDaemonDatedLogBasename(name);
      if (!parsed || parsed.day > today) continue;
      try {
        const stat = await fsp.lstat(path.join(runtime, name));
        if (stat.isFile() && !stat.isSymbolicLink()) eligible.push(name);
      } catch { /* raced with rotation/removal */ }
    }
    eligible.sort();
    if (eligible.length) dated = path.join(runtime, eligible[eligible.length - 1]!);
  } catch { /* runtime absent/unreadable */ }
  const present = async (file: string): Promise<string | undefined> => {
    try { return (await fsp.lstat(file)).isFile() ? file : undefined; } catch { return undefined; }
  };
  const crash = await present(logPath(root));
  const legacy = await present(legacyLogPath(root));
  return {
    ...(crash ? { crash } : {}),
    ...(dated ? { dated } : {}),
    ...(legacy ? { legacy } : {}),
  };
}

/** Remove the global pid/log dir for `root` — called by `untrack` so tearing down
 *  a workspace leaves no orphaned runtime files behind under `~/.rbox`. */
export async function removeDaemonRuntime(root: string): Promise<void> {
  await fsp.rm(daemonRuntimeDir(root), { recursive: true, force: true });
}

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

function readDaemonCommand(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

/** Confirm the pid is an rbox daemon, optionally for one exact workspace root.
 * The command line is read once so the ownership hot path does not spawn two ps
 * subprocesses. The reader seam keeps the single-read contract testable. */
export function daemonProcessMatches(pid: number, root?: string, readCommand: (pid: number) => string = readDaemonCommand): boolean {
  if (!isAlive(pid)) return false;
  try {
    const cmd = readCommand(pid);
    return cmd.includes(DAEMON_MARKER) && (root === undefined || cmd.includes(root));
  } catch {
    return false; // ps failed / process gone
  }
}

/** Standalone daemon ownership check used by upgrade discovery. */
export function isDaemonProcess(pid: number): boolean {
  return daemonProcessMatches(pid);
}

function isOurDaemon(pid: number, root: string): boolean {
  return daemonProcessMatches(pid, root);
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

function readPid(root: string): number | undefined {
  return readDaemonPidRecord(root).pid;
}

/** Is OUR background-sync daemon currently running for `root`? Used by `status`
 *  (the folded-in `daemon status`) and `untrack` (decide whether to stop first). */
export function isDaemonRunning(root: string): { running: boolean; pid?: number; bootId?: string } {
  const rec = readDaemonPidRecord(root);
  const pid = rec.pid;
  if (pid !== undefined && isOurDaemon(pid, root)) return { running: true, pid, bootId: rec.bootId };
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

export interface StopDaemonDeps {
  isDaemonRunning?: typeof isDaemonRunning;
  waitForExit?: typeof waitForExit;
  forceKill?: typeof forceKill;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  drainPollMs?: number;
  readStatus?: typeof readAmbientDaemonStatusRecord;
  now?: () => number;
  processStartToken?: (pid: number) => Promise<string | undefined>;
}

export type StartDaemonResult = "started" | "already-running" | "already-running-unknown-mode" | "retry-later";
export type DaemonModeIntent = "preserve" | "explicit" | "pending";
export interface DaemonLiveObservation {
  pid: number;
  bootId?: string;
}
export interface StartDaemonOptions {
  pullOnly?: boolean;
  /** Whether the operator supplied --pull-only/--read-write. Unknown legacy live mode is safe only for preserve. */
  modeIntent?: DaemonModeIntent;
  /** Awaited after a current-workspace live daemon is confirmed, before mode admission. */
  onLive?: (observation: DaemonLiveObservation) => void | Promise<void>;
  /** Awaited after the fresh v2 pidfile is published, before witness polling. */
  onSpawned?: (observation: Required<DaemonLiveObservation>) => void | Promise<void>;
  /** Awaited only for a boot-bound witness that matches the requested mode. */
  onModeWitness?: (witness: Extract<DaemonModeWitness, { kind: "known" }>) => void | Promise<void>;
  /** Test seam; production waits for the newly spawned daemon's boot-bound mode witness. */
  modeWitnessTimeoutMs?: number;
  modeWitnessPollMs?: number;
}

export const DAEMON_MODE_WITNESS_TIMEOUT_MS = 15_000;

export type DaemonModeWitness = { kind: "known"; mode: DaemonMode; bootId: string } | { kind: "unknown" };

/** Read the daemon-owned mode witness only when it belongs to the same incarnation
 * as the v2 pidfile. A missing field, legacy pidfile, corrupt status, or a status
 * left by an earlier boot is UNKNOWN rather than an inferred mode. */
export function readDaemonModeWitness(root: string, expectedBootId?: string): DaemonModeWitness {
  const pidfile = readDaemonPidRecord(root);
  if (pidfile.version !== "v2" || pidfile.bootId === undefined) return { kind: "unknown" };
  if (expectedBootId !== undefined && pidfile.bootId !== expectedBootId) return { kind: "unknown" };
  const record = readAmbientDaemonStatusRecord(root);
  if (record.kind !== "ok" || record.status.bootId !== pidfile.bootId || record.status.mode === undefined) return { kind: "unknown" };
  return { kind: "known", mode: record.status.mode, bootId: pidfile.bootId };
}

function modeFlag(mode: DaemonMode): "--pull-only" | "--read-write" {
  return mode === "pull-only" ? "--pull-only" : "--read-write";
}

function modeRestartRequired(requested: DaemonMode, actual?: DaemonMode): Error {
  const detail = actual === undefined ? "the live daemon's mode is unknown" : `the live daemon is ${actual}`;
  return new Error(`${detail}; restart required: rbox stop && rbox start ${modeFlag(requested)}`);
}

export function admitLiveDaemonMode(
  requested: DaemonMode,
  intent: DaemonModeIntent,
  witness: DaemonModeWitness,
): "matched" | "preserve-unknown" | "pending-unknown" {
  if (witness.kind === "known") {
    if (witness.mode !== requested) throw modeRestartRequired(requested, witness.mode);
    return "matched";
  }
  if (intent === "pending") return "pending-unknown";
  if (intent === "explicit") throw modeRestartRequired(requested);
  return "preserve-unknown";
}

export async function waitForDaemonModeWitness(
  root: string,
  bootId: string,
  timeoutMs: number,
  pollMs: number,
  deps: { daemonOwned?: (pid: number, root: string) => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DaemonModeWitness> {
  const deadline = Date.now() + timeoutMs;
  const daemonOwned = deps.daemonOwned ?? isOurDaemon;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const witness = readDaemonModeWitness(root, bootId);
    if (witness.kind === "known") return witness;
    const pidfile = readDaemonPidRecord(root);
    if (pidfile.version !== "v2" || pidfile.bootId !== bootId || pidfile.pid === undefined || !daemonOwned(pidfile.pid, root)) return { kind: "unknown" };
    if (Date.now() >= deadline) return { kind: "unknown" };
    await sleep(pollMs);
  }
}

const CRASH_LOG_MAX_BYTES = 5_000_000;

/** Startup-only single-generation cap for inherited stdout/stderr. All operations
 * are advisory: logging must never be allowed to prevent a daemon boot. */
export function guardDaemonCrashLog(root: string): void {
  const current = logPath(root);
  const old = `${current}.old`;
  try {
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.size <= CRASH_LOG_MAX_BYTES) return;
    try {
      fs.renameSync(current, old);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { process.stderr.write(`rbox: crash-log guard failed: ${String(error)}\n`); } catch { /* best effort */ }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try { process.stderr.write(`rbox: crash-log guard failed: ${String(error)}\n`); } catch { /* best effort */ }
    }
  }
}

export async function startDaemon(root: string, opts: StartDaemonOptions = {}): Promise<StartDaemonResult> {
  const requestedMode: DaemonMode = opts.pullOnly === true ? "pull-only" : "read-write";
  const existing = readPid(root);
  if (existing && isOurDaemon(existing, root)) {
    // A live daemon is only "already running" if it's bound to the CURRENT workspace.
    // Re-initializing the root (a repeat `rbox setup`/`rbox init`) rebinds it to a new
    // workspace id, but the old daemon keeps its startup binding and 404s on every op
    // forever — while looking perfectly alive. Detect the rebind and restart instead.
    // An unknown binding (pre-binding daemon) is treated as current — can't tell ≠ stale.
    const bound = readDaemonBinding(root);
    const current = currentWorkspaceId(root);
    if (bound && current && bound !== current) {
      console.log(`background sync (process ${existing}) was serving workspace ${bound}, but this folder is now ${current} — restarting`);
      try {
        // Re-verify ownership at the moment of signalling (PID-reuse window), and
        // swallow ESRCH — "already exited" is success here, not an error.
        if (isOurDaemon(existing, root)) process.kill(existing, "SIGTERM");
      } catch {
        /* gone between check and signal */
      }
      if (!(await waitForExit(existing, 5000))) {
        // Never escalate to SIGKILL: a forced kill can land mid git-sync `.git`
        // mutation, whose rollback is JS-level and dies with the process. SIGTERM
        // shutdown is graceful (awaits the pump) — just try again shortly.
        console.log(`the previous background sync (process ${existing}) hasn't exited yet — re-run \`rbox start\` in a moment`);
        return "retry-later";
      }
      await fsp.rm(pidPath(root), { force: true });
    } else {
      const pidfile = readDaemonPidRecord(root);
      await opts.onLive?.({ pid: existing, ...(pidfile.bootId === undefined ? {} : { bootId: pidfile.bootId }) });
      const witness = readDaemonModeWitness(root);
      const admission = admitLiveDaemonMode(requestedMode, opts.modeIntent ?? "preserve", witness);
      if (admission === "pending-unknown") {
        console.log(`background sync (process ${existing}) is running, but its mode is not witnessed yet — re-run \`rbox start\` in a moment`);
        return "retry-later";
      }
      if (admission === "matched" && witness.kind === "known") await opts.onModeWitness?.(witness);
      console.log(`background sync already running (process ${existing})`);
      return admission === "matched" ? "already-running" : "already-running-unknown-mode";
    }
  } else if (existing) {
    // Stale pidfile (process died, or pid reused by something else) — clean it.
    await fsp.rm(pidPath(root), { force: true });
  }

  await fsp.mkdir(daemonRuntimeDir(root), { recursive: true });
  // Clear the PREVIOUS daemon's binding record before spawning: until the child
  // writes its own, a concurrent `rbox start` must read "unknown" (= already
  // running), not the old id — which would misclassify the fresh daemon as stale
  // and SIGTERM it mid-startup.
  await fsp.rm(boundPath(root), { force: true });
  await fsp.rm(daemonStatusPath(root), { force: true });
  guardDaemonCrashLog(root);
  let out: number | undefined;
  try { out = fs.openSync(logPath(root), "a"); }
  catch (error) {
    try { process.stderr.write(`rbox: crash sink unavailable; daemon will continue without inherited diagnostics: ${String(error)}\n`); } catch { /* best effort */ }
  }
  const args = daemonSpawnArgs(process.argv[1]!, root, isStandaloneBinary());
  const bootId = crypto.randomBytes(16).toString("hex");
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", out ?? "ignore", out ?? "ignore"],
      env: { ...process.env, [DAEMON_BOOT_ID_ENV]: bootId, RBOX_DAEMON_PULL_ONLY: opts.pullOnly ? "1" : "0" },
    });
  } finally {
    if (out !== undefined) fs.closeSync(out);
  }
  child.unref();

  if (child.pid) fs.writeFileSync(pidPath(root), `v2 ${child.pid} ${bootId}\n`);
  if (!child.pid) {
    console.log("background sync did not report a process id — re-run `rbox start` in a moment");
    return "retry-later";
  }
  try {
    await opts.onSpawned?.({ pid: child.pid, bootId });
  } catch (error) {
    try {
      if (isOurDaemon(child.pid, root)) process.kill(child.pid, "SIGTERM");
    } catch {
      /* the child already exited or was stopped while desired persistence waited */
    }
    throw error;
  }
  const witness = await waitForDaemonModeWitness(
    root,
    bootId,
    opts.modeWitnessTimeoutMs ?? DAEMON_MODE_WITNESS_TIMEOUT_MS,
    opts.modeWitnessPollMs ?? 50,
  );
  if (witness.kind === "unknown") {
    console.log(`background sync (process ${child.pid}) started, but its mode is not witnessed yet — re-run \`rbox start\` in a moment`);
    return "retry-later";
  }
  if (witness.mode !== requestedMode) throw modeRestartRequired(requestedMode, witness.mode);
  await opts.onModeWitness?.(witness);
  console.log(`background sync started (process ${child.pid}). view logs with: rbox logs`);
  return "started";
}

export async function stopDaemon(root: string, deps: StopDaemonDeps = {}): Promise<void> {
  const running = deps.isDaemonRunning ?? isDaemonRunning;
  const wait = deps.waitForExit ?? waitForExit;
  const kill = deps.forceKill ?? forceKill;
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const output = deps.log ?? console.log;
  const processStartToken = deps.processStartToken ?? (async (candidatePid: number) => {
    const probe = await systemLockIdentity.probe(candidatePid);
    return probe.status === "alive" ? probe.startTime : undefined;
  });
  const original = readDaemonPidRecord(root);
  const sameRecord = (record: DaemonPidRecord): boolean =>
    record.present === original.present
    && record.pid === original.pid
    && record.bootId === original.bootId
    && record.version === original.version;
  const removeOwnedPidfile = async (): Promise<void> => {
    if (sameRecord(readDaemonPidRecord(root))) await fsp.rm(daemonPidPath(root), { force: true });
  };
  const pid = original.pid;
  if (!pid) {
    output("background sync is not running");
    return;
  }
  const first = running(root);
  if (!first.running || first.pid !== pid) {
    output(`found a leftover record of an old background sync (process ${pid} is gone or not ours) — cleaned up`);
    await removeOwnedPidfile();
    return;
  }
  const originalStartToken = await processStartToken(pid).catch(() => undefined);

  // Ownership is deliberately re-read immediately before every signal. A PID
  // record is never removed while the daemon it names may still be running.
  const beforeTerm = running(root);
  if (!beforeTerm.running || beforeTerm.pid !== pid) {
    await removeOwnedPidfile();
    return;
  }
  try { signal(pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  output(`stopping background sync (sent SIGTERM to process ${pid})`);
  let timeout = deps.termTimeoutMs ?? 60_000;
  for (;;) {
    if (await wait(pid, timeout)) {
      await removeOwnedPidfile();
      return;
    }
    if (!sameRecord(readDaemonPidRecord(root))) {
      timeout = deps.drainPollMs ?? Math.min(deps.termTimeoutMs ?? 60_000, 5_000);
      continue;
    }
    const stillOwned = running(root);
    if (!stillOwned.running || stillOwned.pid !== pid) {
      await removeOwnedPidfile();
      return;
    }
    const status = (deps.readStatus ?? readAmbientDaemonStatusRecord)(root);
    const sameBoot = status.kind === "ok" && original.version === "v2"
      && original.bootId !== undefined && status.status.bootId === original.bootId;
    const shutdown = sameBoot ? status.status.shutdown : undefined;
    const heartbeatAt = sameBoot ? Date.parse(status.status.heartbeatAt) : Number.NaN;
    const now = (deps.now ?? Date.now)();
    const liveCurrentCritical = sameBoot
      && status.status.daemonVersion === RBOX_VERSION
      && Number.isFinite(heartbeatAt)
      && heartbeatAt <= now + DAEMON_HEARTBEAT_FUTURE_SKEW_MS
      && now - heartbeatAt <= AMBIENT_STATUS_STALE_MS
      && shutdown?.gateClosed === true
      && shutdown.phase !== undefined;
    if (!liveCurrentCritical) {
      const currentStartToken = await processStartToken(pid).catch(() => undefined);
      if (!sameRecord(readDaemonPidRecord(root)) || originalStartToken === undefined || currentStartToken !== originalStartToken) {
        timeout = deps.drainPollMs ?? Math.min(deps.termTimeoutMs ?? 60_000, 5_000);
        continue;
      }
      output(`background sync did not stop within 60 seconds and has no live same-version critical-section witness — sending SIGKILL to process ${pid}`);
      kill(pid);
      if (!(await wait(pid, deps.killTimeoutMs ?? 60_000))) {
        throw new Error("background sync could not be confirmed stopped; daemon record retained");
      }
      await removeOwnedPidfile();
      return;
    }
    const phase = shutdown.phase;
    output(`background sync is draining critical phase ${phase}${shutdown.repository ? ` (${shutdown.repository})` : ""}; continuing to wait`);
    timeout = deps.drainPollMs ?? Math.min(deps.termTimeoutMs ?? 60_000, 5_000);
  }
}

export const DEFAULT_LOG_LINES = 50;
const AUXILIARY_TAIL_BYTES = 64 * 1024;

async function readHandleRange(fd: fsp.FileHandle, start: number, end: number): Promise<Buffer> {
  const out = Buffer.alloc(Math.max(0, end - start));
  let offset = 0;
  while (offset < out.length) {
    const { bytesRead } = await fd.read(out, offset, out.length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === out.length ? out : out.subarray(0, offset);
}

async function truncatedLinePrefix(fd: fsp.FileHandle, start: number): Promise<string> {
  let position = start;
  let lineStart = 0;
  while (position > 0) {
    const length = Math.min(AUXILIARY_TAIL_BYTES, position);
    position -= length;
    const part = await readHandleRange(fd, position, position + length);
    const newline = part.lastIndexOf(0x0a);
    if (newline >= 0) { lineStart = position + newline + 1; break; }
  }
  return (await readHandleRange(fd, lineStart, Math.min(start, lineStart + 512))).toString("utf8");
}

async function tailHandle(fd: fsp.FileHandle, maxLines: number | undefined, maxBytes: number): Promise<{ text: string; size: number; truncatedPrefix?: string }> {
  const { size } = await fd.stat();
  if (maxLines !== undefined) {
    if (size === 0 || maxLines <= 0) return { text: "", size };
    let position = size;
    let newlines = 0;
    const parts: Buffer[] = [];
    while (position > 0 && newlines <= maxLines) {
      const length = Math.min(AUXILIARY_TAIL_BYTES, position);
      position -= length;
      const part = await readHandleRange(fd, position, position + length);
      parts.unshift(part);
      for (const byte of part) if (byte === 0x0a) newlines++;
    }
    const lines = Buffer.concat(parts).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const text = lines.slice(-maxLines).join("\n");
    return { text: text ? `${text}\n` : "", size };
  }
  const start = Math.max(0, size - maxBytes);
  const bytes = await readHandleRange(fd, start, size);
  let text = bytes.toString("utf8");
  let truncatedPrefix: string | undefined;
  if (start > 0) {
    truncatedPrefix = await truncatedLinePrefix(fd, start);
    const firstNewline = text.indexOf("\n");
    const afterPartial = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    // Prefer complete records, but a single oversized final record is still the
    // bounded tail and must not collapse to an empty diagnostic section.
    if (afterPartial) text = afterPartial;
  }
  return { text, size, ...(truncatedPrefix !== undefined ? { truncatedPrefix } : {}) };
}

export interface LogsOptions {
  follow: boolean;
  lines: number;
}

type SourceKind = "crash" | "dated" | "legacy";
const SOURCE_ORDER: Record<SourceKind, number> = { crash: 0, dated: 1, legacy: 2 };
interface OpenSource {
  kind: SourceKind;
  file: string;
  fd: fsp.FileHandle;
  dev: number | bigint;
  ino: number | bigint;
  generation: number;
  offset: number;
  stableEofPolls: number;
}

function sourceEntries(sources: DaemonLogSources): Array<[SourceKind, string]> {
  return (["crash", "dated", "legacy"] as const).flatMap((kind) => sources[kind] ? [[kind, sources[kind]!] as [SourceKind, string]] : []);
}

async function openSource(kind: SourceKind, file: string, generation: number): Promise<OpenSource | undefined> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const stat = await fd.stat();
      return { kind, file, fd, dev: stat.dev, ino: stat.ino, generation, offset: 0, stableEofPolls: 0 };
    } catch (error) {
      await fd.close().catch(() => {});
      throw error;
    }
  } catch { return undefined; }
}

function marked(kind: SourceKind, file: string, bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const label = kind === "dated" ? path.basename(file) : kind;
  return `--- ${label} ---\n${bytes.toString("utf8")}${bytes.at(-1) === 0x0a ? "" : "\n"}`;
}

function mergeInitial(channels: Array<{ kind: SourceKind; text: string }>, markSources = false): string {
  const ordered: Array<{ timestamp: number; kind: SourceKind; offset: number; line: string }> = [];
  const trailing: Array<{ kind: SourceKind; lines: string[] }> = [];
  for (const channel of channels) {
    const nonIso: string[] = [];
    let offset = 0;
    for (const line of channel.text.split("\n")) {
      if (!line) { offset++; continue; }
      const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(line);
      const timestamp = match ? Date.parse(match[1]!) : Number.NaN;
      if (Number.isFinite(timestamp)) ordered.push({ timestamp, kind: channel.kind, offset, line });
      else nonIso.push(line);
      offset += Buffer.byteLength(line) + 1;
    }
    if (nonIso.length) trailing.push({ kind: channel.kind, lines: nonIso });
  }
  ordered.sort((a, b) => a.timestamp - b.timestamp || SOURCE_ORDER[a.kind] - SOURCE_ORDER[b.kind] || a.offset - b.offset);
  let result = ordered.map((record) => markSources ? `[${record.kind}] ${record.line}` : record.line).join("\n");
  if (result) result += "\n";
  for (const block of trailing) result += `--- ${block.kind} (un-timestamped) ---\n${block.lines.join("\n")}\n`;
  return result;
}

export async function readMergedDaemonLogTail(root: string, maxBytes = AUXILIARY_TAIL_BYTES): Promise<string> {
  const channels: Array<{ kind: SourceKind; text: string }> = [];
  for (const [kind, file] of sourceEntries(await resolveDaemonLogSources(root))) {
    const source = await openSource(kind, file, 0);
    if (!source) continue;
    try {
      const tail = await tailHandle(source.fd, undefined, maxBytes);
      const prefixMessage = /^\d{4}-\d\d-\d\dT\S+\s+(.*)$/.exec(tail.truncatedPrefix ?? "")?.[1] ?? tail.truncatedPrefix;
      const unsafeTruncatedGit = prefixMessage?.startsWith("git-sync ") || prefixMessage?.startsWith("git-sync:") || prefixMessage?.startsWith("git deferred");
      channels.push({
        kind,
        text: unsafeTruncatedGit
          ? `1970-01-01T00:00:00.000Z git-sync UNKNOWN truncated byte tail\n${tail.text}`
          : tail.text,
      });
    } finally {
      await source.fd.close().catch(() => {});
    }
  }
  return mergeInitial(channels);
}

interface FollowLifecycleSnapshot {
  workspaceId?: string;
  bindingWorkspaceId?: string;
  boot?: string;
  valid: boolean;
}

function lifecycleBoot(pid: DaemonPidRecord, binding: DaemonBindingRecord, workspaceId: string | undefined): string | undefined {
  if (!pid.pid || !binding.workspaceId || binding.workspaceId !== workspaceId) return undefined;
  if (pid.bootId && binding.bootId && pid.bootId !== binding.bootId) return undefined;
  return pid.bootId ?? binding.bootId ?? `legacy:${pid.pid}`;
}

function captureFollowLifecycle(root: string): FollowLifecycleSnapshot {
  const workspaceId = currentWorkspaceId(root);
  const pid = readDaemonPidRecord(root);
  const binding = readDaemonBindingRecord(root);
  const boot = lifecycleBoot(pid, binding, workspaceId);
  const absent = !pid.present && !binding.present;
  return { workspaceId, bindingWorkspaceId: binding.workspaceId, boot, valid: absent || boot !== undefined };
}

function lifecycleMatches(root: string, snapshot: FollowLifecycleSnapshot): boolean {
  if (!snapshot.valid || currentWorkspaceId(root) !== snapshot.workspaceId) return false;
  const pid = readDaemonPidRecord(root);
  const binding = readDaemonBindingRecord(root);
  if (!snapshot.boot) return !pid.present && !binding.present;
  return binding.workspaceId === snapshot.bindingWorkspaceId
    && lifecycleBoot(pid, binding, snapshot.workspaceId) === snapshot.boot;
}

export interface LogsDeps {
  resolveSources?: typeof resolveDaemonLogSources;
  waitForPoll?: () => Promise<void>;
}

/** `rbox logs` merges the operational stream with bounded crash and legacy tails.
 * Follow keeps every opened identity alive, so rollover and late old-date appends
 * remain visible without stat/open races. */
export async function logsDaemon(root: string, opts: LogsOptions, deps: LogsDeps = {}): Promise<void> {
  // Follow is pinned before the first await: resolving or opening sources must not
  // create a window in which a replacement daemon generation can be adopted.
  const lifecycleAtEntry = captureFollowLifecycle(root);
  if (opts.follow && !lifecycleAtEntry.valid) return;
  const resolveSources = deps.resolveSources ?? resolveDaemonLogSources;
  const waitForPoll = deps.waitForPoll ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
  const open: OpenSource[] = [];
  let stopped = false;
  const stop = () => { stopped = true; };
  let listening = false;
  try {
    const initial: Array<{ kind: SourceKind; text: string }> = [];
    let generation = 0;
    const sources = await resolveSources(root);
    for (const [kind, file] of sourceEntries(sources)) {
      const source = await openSource(kind, file, generation++);
      if (!source) continue;
      open.push(source);
      const tail = await tailHandle(source.fd, kind === "dated" ? opts.lines : undefined, kind === "dated" ? Number.MAX_SAFE_INTEGER : AUXILIARY_TAIL_BYTES);
      source.offset = tail.size;
      initial.push({ kind, text: tail.text });
    }
    if (opts.follow && !lifecycleMatches(root, lifecycleAtEntry)) return;
    if (initial.length) process.stdout.write(mergeInitial(initial, opts.follow));
    else if (!opts.follow) {
      console.log("(no daemon log yet — start background sync with `rbox start`)");
      return;
    }
    if (!opts.follow) return;

    let activeDated = open.find((source) => source.kind === "dated");
    let pendingDated: OpenSource | undefined;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    listening = true;
    while (!stopped) {
      if (!lifecycleMatches(root, lifecycleAtEntry)) break;
      const resolved = await resolveSources(root);
      if (!lifecycleMatches(root, lifecycleAtEntry)) break;
      for (const [kind, file] of sourceEntries(resolved)) {
        const candidate = await openSource(kind, file, generation++);
        if (!candidate) continue;
        const duplicate = open.some((source) => source.kind === kind && source.dev === candidate.dev && source.ino === candidate.ino);
        if (duplicate) await candidate.fd.close().catch(() => {});
        else {
          open.push(candidate);
          if (kind === "dated" && candidate !== activeDated) pendingDated = candidate;
        }
      }
      for (const source of open) {
        if (source === pendingDated) continue;
        const stat = await source.fd.stat();
        if (stat.size < source.offset) source.offset = 0;
        if (stat.size === source.offset) { source.stableEofPolls++; continue; }
        const bytes = await readHandleRange(source.fd, source.offset, stat.size);
        if (bytes.length > 0) {
          process.stdout.write(marked(source.kind, source.file, bytes));
          source.offset += bytes.length;
          source.stableEofPolls = 0;
        }
      }
      if (pendingDated && (!activeDated || activeDated.stableEofPolls >= 2)) {
        activeDated = pendingDated;
        pendingDated = undefined;
      }
      await waitForPoll();
    }
  } finally {
    if (listening) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    await Promise.all(open.map((source) => source.fd.close().catch(() => {})));
  }
}
