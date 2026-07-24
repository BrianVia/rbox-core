import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { systemLockIdentity } from "../../engine/git/lockfile.js";
import { isStandaloneBinary } from "../runtime.js";
import { daemonCrashLogPath } from "../rbox-paths.js";
import { AMBIENT_STATUS_STALE_MS, readAmbientDaemonStatusRecord, type DaemonMode } from "./ambient-status.js";
import { RBOX_VERSION } from "../version.js";
import {
  DAEMON_BOOT_ID_ENV,
  clearDaemonStartupState,
  currentWorkspaceId,
  daemonPidRecordMatches,
  ensureDaemonRuntime,
  publishDaemonPidRecord,
  readDaemonBinding,
  readDaemonPidRecord,
  removeDaemonPidRecord,
  removeDaemonPidRecordIfMatches,
  type DaemonPidRecord,
} from "./runtime-state.js";

const DAEMON_MARKER = "__daemon-run";
const logPath = daemonCrashLogPath;
export const DAEMON_HEARTBEAT_FUTURE_SKEW_MS = 2 * 60_000;

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
      await removeDaemonPidRecord(root);
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
    await removeDaemonPidRecord(root);
  }

  await ensureDaemonRuntime(root);
  // Clear the PREVIOUS daemon's binding record before spawning: until the child
  // writes its own, a concurrent `rbox start` must read "unknown" (= already
  // running), not the old id — which would misclassify the fresh daemon as stale
  // and SIGTERM it mid-startup.
  await clearDaemonStartupState(root);
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

  if (child.pid) publishDaemonPidRecord(root, child.pid, bootId);
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
  const sameRecord = (record: DaemonPidRecord): boolean => daemonPidRecordMatches(record, original);
  const removeOwnedPidfile = (): Promise<void> => removeDaemonPidRecordIfMatches(root, original);
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
