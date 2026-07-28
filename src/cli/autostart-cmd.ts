import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RBOX_DIR } from "./config.js";
import { acquireLock, type OwnedLock } from "../engine/git/lockfile.js";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { currentWorkspaceId, daemonRuntimeDir, readDaemonModeWitness, readDaemonPidRecord, startDaemon, stopDaemon, type DaemonLiveObservation, type DaemonModeIntent } from "./daemon-control.js";
import { credentialFailureMessage, credentialsForStrictFlow, loadCredentials } from "./credentials.js";
import { homeDir } from "./rbox-paths.js";
import { assertBindingUsable, resolveBindingScope } from "./scope/binding-scope.js";
import { fail, style } from "./style.js";
import type { DaemonMode } from "./daemon/ambient-status.js";

export const BOOT_RESUME_MARKER = "__boot-resume";
const AUTOSTART_LABEL = "to.rbox.daemon";
const LAUNCH_AGENT_REL = path.join("Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
const SYSTEMD_UNIT_NAME = "rbox.service";
const DESIRED_FILE = "desired.json";
const RBOX_BIN_REL = `${RBOX_DIR}/bin/rbox`;

export type DesiredDaemonStateValue = "running" | "stopped";

export interface DesiredDaemonState {
  rootPath: string;
  state: DesiredDaemonStateValue;
  accountId: string;
  workspaceId: string;
  at: string;
  pullOnly?: boolean;
  pendingModeIntent?: DaemonMode;
}

export interface DesiredStateRow {
  key: string;
  path: string;
  desired: DesiredDaemonState;
}

export type AutostartWorkspaceStatus = DesiredDaemonState & {
  status: DesiredDaemonStateValue | "stale" | "mismatch";
  key: string;
  desiredPath: string;
  reason?: string;
};

type ExecCommand = (cmd: string, args: string[]) => Promise<string | void>;

interface CommonDeps {
  loadCredentials?: typeof loadCredentials;
}

interface DesiredDeps extends CommonDeps {
  now?: () => Date;
  /** Explicit start intent. Omission preserves desired.json's valid prior mode. */
  mode?: DaemonMode;
  /** Compatibility for setup/older callers; true is an explicit pull-only intent. */
  pullOnly?: boolean;
}

interface StartStopDeps extends DesiredDeps {
  startDaemon?: typeof startDaemon;
  stopDaemon?: typeof stopDaemon;
  modeWitnessTimeoutMs?: number;
  modeWitnessPollMs?: number;
  /** Resume-only generation guard; never supplied by an interactive start. */
  resumeExpected?: DesiredDaemonState;
  /** Already account/workspace-validated desired identity for boot/upgrade resume. */
  trustedDesiredIdentity?: DesiredDaemonState;
}

interface BootResumeDeps extends CommonDeps {
  startDaemon?: typeof startDaemon;
  log?: (line: string) => void;
}

interface AutostartDeps {
  platform?: NodeJS.Platform;
  home?: string;
  binaryPath?: string;
  exec?: ExecCommand;
  loadCredentials?: typeof loadCredentials;
}

const rboxHome = () => path.join(process.env.RBOX_HOME || os.homedir(), RBOX_DIR);
const daemonsDir = () => path.join(rboxHome(), "daemons");
const workspaceConfigPath = (root: string) => path.join(root, RBOX_DIR, "workspace.json");

export const desiredStatePath = (root: string): string => path.join(daemonRuntimeDir(root), DESIRED_FILE);
const defaultRboxBinaryPath = (home = homeDir()): string => path.join(home, ...RBOX_BIN_REL.split("/"));
const launchAgentPath = (home = homeDir()): string => path.join(home, LAUNCH_AGENT_REL);
const systemdUnitPath = (home = homeDir()): string => path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);

const bootResumeArgs = (binaryPath: string): [string, string] => [binaryPath, BOOT_RESUME_MARKER];

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildLaunchAgentPlist(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${bootResumeArgs(binaryPath)
  .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
  .join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function buildSystemdUnit(binaryPath: string): string {
  return `[Unit]
Description=rbox background sync resume

[Service]
Type=oneshot
RemainAfterExit=yes
# load-bearing: lets detached daemon children outlive this one-shot resumer.
KillMode=process
ExecStart=${bootResumeArgs(binaryPath).join(" ")}

[Install]
WantedBy=default.target
`;
}

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseDesired(raw: string): DesiredDaemonState | undefined {
  try {
    const v = JSON.parse(raw) as Partial<DesiredDaemonState>;
    if (v.state !== "running" && v.state !== "stopped") return undefined;
    if (typeof v.rootPath !== "string" || !v.rootPath) return undefined;
    if (typeof v.accountId !== "string" || !v.accountId) return undefined;
    if (typeof v.workspaceId !== "string" || !v.workspaceId) return undefined;
    if (typeof v.at !== "string" || !v.at) return undefined;
    if (v.pullOnly !== undefined && typeof v.pullOnly !== "boolean") return undefined;
    if (v.pendingModeIntent !== undefined && v.pendingModeIntent !== "pull-only" && v.pendingModeIntent !== "read-write") return undefined;
    return {
      rootPath: v.rootPath,
      state: v.state,
      accountId: v.accountId,
      workspaceId: v.workspaceId,
      at: v.at,
      ...(v.pullOnly === true ? { pullOnly: true } : {}),
      ...(v.pendingModeIntent === undefined ? {} : { pendingModeIntent: v.pendingModeIntent }),
    };
  } catch {
    return undefined;
  }
}

async function desiredContext(root: string, state: DesiredDaemonStateValue, deps: DesiredDeps = {}): Promise<DesiredDaemonState> {
  const abs = path.resolve(root);
  const creds = credentialsForStrictFlow(await (deps.loadCredentials ?? loadCredentials)());
  const accountId = creds?.accountId;
  const workspaceId = currentWorkspaceId(abs);
  if (!accountId) throw new Error("not logged in — run `rbox login` before changing background sync state");
  if (!workspaceId) throw new Error(`No rbox workspace at ${abs}. Run: rbox track ${abs}`);
  return {
    rootPath: abs,
    state,
    accountId,
    workspaceId,
    at: (deps.now ?? (() => new Date()))().toISOString(),
    ...(deps.pullOnly === true ? { pullOnly: true } : {}),
  };
}

async function writeDesiredRecord(record: DesiredDaemonState): Promise<void> {
  const p = desiredStatePath(record.rootPath);
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await writeFileAtomic(p, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, exactMode: true });
  await fsyncDirectory(path.dirname(p));
}

async function readDesiredRecord(filePath: string): Promise<DesiredDaemonState | undefined> {
  try {
    return parseDesired(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function desiredMode(record: DesiredDaemonState | undefined): DaemonMode {
  // Legacy/absent desired records predate pull-only durability and therefore mean
  // the historical default, read-write.
  return record?.pullOnly === true ? "pull-only" : "read-write";
}

function desiredWithModes(
  record: DesiredDaemonState,
  accepted: DaemonMode,
  pendingModeIntent?: DaemonMode,
): DesiredDaemonState {
  const { pullOnly: _pullOnly, pendingModeIntent: _pending, ...base } = record;
  return {
    ...base,
    ...(accepted === "pull-only" ? { pullOnly: true } : {}),
    ...(pendingModeIntent === undefined ? {} : { pendingModeIntent }),
  };
}

function explicitMode(deps: DesiredDeps): DaemonMode | undefined {
  if (deps.mode !== undefined) return deps.mode;
  return deps.pullOnly === true ? "pull-only" : undefined;
}

function resolveStartMode(
  previous: DesiredDaemonState | undefined,
  deps: DesiredDeps,
): { mode: DaemonMode; intent: DaemonModeIntent; explicit: boolean } {
  const explicit = explicitMode(deps);
  if (explicit !== undefined) {
    return { mode: explicit, intent: previous?.pendingModeIntent === explicit ? "pending" : "explicit", explicit: true };
  }
  if (previous?.pendingModeIntent !== undefined) {
    return { mode: previous.pendingModeIntent, intent: "pending", explicit: false };
  }
  return { mode: desiredMode(previous), intent: "preserve", explicit: false };
}

const DESIRED_LOCK_WAIT_MS = 30_000;
const DESIRED_LOCK_POLL_MS = 25;

async function desiredRecordLock(root: string): Promise<OwnedLock> {
  const lockPath = `${desiredStatePath(root)}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + DESIRED_LOCK_WAIT_MS;
  for (;;) {
    const acquired = await acquireLock(lockPath);
    if (acquired.status === "acquired") return acquired.lock;
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock desired daemon state: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new Error("desired daemon state is busy — re-run the command in a moment");
    await new Promise<void>((resolve) => setTimeout(resolve, DESIRED_LOCK_POLL_MS));
  }
}

async function mutateDesiredRecord(
  root: string,
  mutation: (current: DesiredDaemonState | undefined) => Promise<DesiredDaemonState | undefined> | DesiredDaemonState | undefined,
): Promise<DesiredDaemonState | undefined> {
  const lock = await desiredRecordLock(root);
  try {
    const current = await readDesiredRecord(desiredStatePath(root));
    const next = await mutation(current);
    if (next !== undefined) await writeDesiredRecord(next);
    return next;
  } finally {
    await lock.release();
  }
}

function sameDesiredGeneration(current: DesiredDaemonState | undefined, expected: DesiredDaemonState): boolean {
  return current !== undefined
    && current.rootPath === expected.rootPath
    && current.state === expected.state
    && current.accountId === expected.accountId
    && current.workspaceId === expected.workspaceId
    && current.at === expected.at
    && current.pullOnly === expected.pullOnly
    && current.pendingModeIntent === expected.pendingModeIntent;
}

class StaleDesiredResumeError extends Error {}

async function readDesiredForStart(root: string, expected?: DesiredDaemonState): Promise<DesiredDaemonState | undefined | false> {
  const lock = await desiredRecordLock(root);
  try {
    const current = await readDesiredRecord(desiredStatePath(root));
    return expected !== undefined && !sameDesiredGeneration(current, expected) ? false : current;
  } finally {
    await lock.release();
  }
}

async function startDaemonAndRecordDesiredImpl(root: string, deps: StartStopDeps): Promise<boolean> {
  const abs = path.resolve(root);
  const read = await readDesiredForStart(abs, deps.resumeExpected);
  if (read === false) return false;
  const previous = read;
  // Design 212 §3.1b layer 3: scope is the authority for the mode. A halted binding
  // never starts at all; a scoped one starts pull-only no matter what the desired
  // record says, what flags were passed, or how the record was corrupted.
  const seal = await resolveBindingScope(abs);
  assertBindingUsable(seal);
  const requested = seal.kind === "scoped"
    ? { mode: "pull-only" as const, intent: "explicit" as const, explicit: true }
    : resolveStartMode(previous, deps);
  const identity = deps.trustedDesiredIdentity === undefined
    ? await desiredContext(abs, "running", deps)
    : {
        rootPath: abs,
        state: "running" as const,
        accountId: deps.trustedDesiredIdentity.accountId,
        workspaceId: deps.trustedDesiredIdentity.workspaceId,
        at: deps.trustedDesiredIdentity.at,
        ...(deps.trustedDesiredIdentity.pullOnly === true ? { pullOnly: true } : {}),
        ...(deps.trustedDesiredIdentity.pendingModeIntent === undefined
          ? {}
          : { pendingModeIntent: deps.trustedDesiredIdentity.pendingModeIntent }),
      };
  const fresh = (state: DesiredDaemonStateValue): DesiredDaemonState => ({
    ...identity,
    state,
    at: (deps.now ?? (() => new Date()))().toISOString(),
  });
  let spawnParked = false;
  let liveRecorded = false;
  let resumeClaimed = false;
  let witnessHandled = false;
  let recordedPending = previous?.pendingModeIntent;
  let explicitParkedGeneration: DesiredDaemonState | undefined;
  let claimedGeneration: DesiredDaemonState | undefined;
  const requireResumeGeneration = (current: DesiredDaemonState | undefined): void => {
    if (deps.resumeExpected !== undefined && !resumeClaimed && !sameDesiredGeneration(current, deps.resumeExpected)) {
      throw new StaleDesiredResumeError("desired daemon state changed before resume");
    }
  };
  if (requested.explicit) {
    explicitParkedGeneration = await mutateDesiredRecord(abs, (current) => {
      requireResumeGeneration(current);
      // The flag itself is the durable user action. Record it before daemon
      // admission so retry-later, UNKNOWN, and MISMATCH cannot lose a changed
      // mind. Preserve liveness until a daemon callback proves it changed.
      const next = desiredWithModes(fresh(current?.state ?? "stopped"), desiredMode(current), requested.mode);
      recordedPending = requested.mode;
      return next;
    });
    resumeClaimed = true;
  }
  const requireExplicitGeneration = (current: DesiredDaemonState | undefined): void => {
    if (explicitParkedGeneration !== undefined && !sameDesiredGeneration(current, explicitParkedGeneration)) {
      throw new StaleDesiredResumeError("desired daemon mode intent changed before start admission");
    }
  };
  const recordLive = async (observation?: DaemonLiveObservation): Promise<void> => {
    const recorded = await mutateDesiredRecord(abs, (current) => {
      requireResumeGeneration(current);
      requireExplicitGeneration(current);
      if (observation !== undefined) {
        const live = readDaemonPidRecord(abs);
        if (live.pid !== observation.pid || (observation.bootId !== undefined && live.bootId !== observation.bootId)) {
          throw new Error("background sync exited or changed before its desired running state was recorded");
        }
      }
      recordedPending = requested.explicit ? requested.mode : current?.pendingModeIntent;
      return desiredWithModes(fresh("running"), desiredMode(current), recordedPending);
    });
    if (recorded === undefined) throw new Error("background sync desired state changed before live admission");
    claimedGeneration = recorded;
    explicitParkedGeneration = undefined;
    liveRecorded = true;
    resumeClaimed = true;
  };
  let result;
  try {
    result = await (deps.startDaemon ?? startDaemon)(identity.rootPath, {
      pullOnly: requested.mode === "pull-only",
      modeIntent: requested.intent,
      ...(deps.modeWitnessTimeoutMs === undefined ? {} : { modeWitnessTimeoutMs: deps.modeWitnessTimeoutMs }),
      ...(deps.modeWitnessPollMs === undefined ? {} : { modeWitnessPollMs: deps.modeWitnessPollMs }),
      onLive: recordLive,
      onSpawned: async ({ pid, bootId }) => {
        const recorded = await mutateDesiredRecord(abs, (current) => {
          requireResumeGeneration(current);
          requireExplicitGeneration(current);
          const live = readDaemonPidRecord(abs);
          if (live.version !== "v2" || live.pid !== pid || live.bootId !== bootId) {
            throw new Error("spawned background sync exited or changed before its desired mode intent was recorded");
          }
          // A bare start resumes existing intent but never authors one. Explicit
          // flags are the only operation allowed to create or replace pending.
          recordedPending = requested.explicit ? requested.mode : current?.pendingModeIntent;
          return desiredWithModes(fresh("running"), desiredMode(current), recordedPending);
        });
        if (recorded === undefined) throw new Error("spawned background sync desired state changed before mode admission");
        claimedGeneration = recorded;
        explicitParkedGeneration = undefined;
        spawnParked = true;
        resumeClaimed = true;
      },
      onModeWitness: async (witness) => {
        witnessHandled = true;
        const expectedPending = spawnParked || liveRecorded ? recordedPending : previous?.pendingModeIntent;
        await mutateDesiredRecord(abs, (current) => {
          const pidfile = readDaemonPidRecord(abs);
          const currentWitness = readDaemonModeWitness(abs, witness.bootId);
          if (pidfile.version !== "v2" || pidfile.bootId !== witness.bootId
            || currentWitness.kind !== "known" || currentWitness.mode !== requested.mode) return undefined;
          if (current?.state === "stopped" || current?.pendingModeIntent !== expectedPending) return undefined;
          if (expectedPending !== undefined && expectedPending !== requested.mode) return undefined;
          if (claimedGeneration !== undefined && !sameDesiredGeneration(current, claimedGeneration)) return undefined;
          return desiredWithModes(fresh("running"), requested.mode);
        });
      },
    });
  } catch (error) {
    if (error instanceof StaleDesiredResumeError) return false;
    throw error;
  }
  if (result === "already-running-unknown-mode") {
    if (!liveRecorded) {
      try {
        await recordLive();
      } catch (error) {
        if (error instanceof StaleDesiredResumeError) return false;
        throw error;
      }
    }
    return true;
  }
  if (result !== "started" && result !== "already-running") return spawnParked || liveRecorded;
  if (witnessHandled) return true;
  // Compatibility for injected starters: returning a witnessed-success result
  // without driving onModeWitness retains the historical test/dependency seam.
  const expectedPending = spawnParked || liveRecorded || requested.explicit
    ? recordedPending
    : previous?.pendingModeIntent;
  const promoted = await mutateDesiredRecord(abs, (current) => {
    if (deps.resumeExpected !== undefined && !resumeClaimed && !sameDesiredGeneration(current, deps.resumeExpected)) return undefined;
    if (current?.state === "stopped" && (spawnParked || liveRecorded)) return undefined;
    const expectedGeneration = claimedGeneration ?? explicitParkedGeneration;
    if (expectedGeneration !== undefined && !sameDesiredGeneration(current, expectedGeneration)) return undefined;
    if (current !== undefined && current.pendingModeIntent !== expectedPending) return undefined;
    if (expectedPending !== undefined && expectedPending !== requested.mode) return undefined;
    return desiredWithModes(fresh("running"), requested.mode);
  });
  return promoted !== undefined;
}

export async function startDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  await startDaemonAndRecordDesiredImpl(root, deps);
}

export async function resumeDesiredDaemon(
  expected: DesiredDaemonState,
  deps: Pick<StartStopDeps, "startDaemon" | "modeWitnessTimeoutMs" | "modeWitnessPollMs"> = {},
): Promise<boolean> {
  return startDaemonAndRecordDesiredImpl(expected.rootPath, {
    ...deps,
    resumeExpected: expected,
    trustedDesiredIdentity: expected,
  });
}

export async function stopDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  const abs = path.resolve(root);
  const identity = await desiredContext(abs, "stopped", deps);
  await mutateDesiredRecord(abs, async (current) => {
    let accepted = desiredMode(current);
    let pending = current?.pendingModeIntent;
    if (pending !== undefined) {
      const witness = readDaemonModeWitness(abs);
      if (witness.kind === "known" && witness.mode === pending) {
        accepted = pending;
        pending = undefined;
      }
    }
    await (deps.stopDaemon ?? stopDaemon)(abs);
    return desiredWithModes({
      ...identity,
      state: "stopped",
      at: (deps.now ?? (() => new Date()))().toISOString(),
    }, accepted, pending);
  });
}

/** Opportunistically accept durable user intent when the current pidfile and
 * ambient status provide a matching, boot-bound daemon witness. Intent remains
 * durable if this helper is never called or cannot prove a match. */
export async function promotePendingModeIntent(root: string, deps: Pick<DesiredDeps, "now"> = {}): Promise<boolean> {
  const abs = path.resolve(root);
  const observed = await readDesiredRecord(desiredStatePath(abs));
  if (observed?.pendingModeIntent === undefined) return false;
  let promoted = false;
  await mutateDesiredRecord(abs, (current) => {
    const pending = current?.pendingModeIntent;
    if (current === undefined || current.state !== "running" || pending === undefined) return undefined;
    if (current.workspaceId !== currentWorkspaceId(abs)) return undefined;
    const witness = readDaemonModeWitness(abs);
    if (witness.kind !== "known" || witness.mode !== pending) return undefined;
    promoted = true;
    return desiredWithModes({
      ...current,
      at: (deps.now ?? (() => new Date()))().toISOString(),
    }, pending);
  });
  return promoted;
}

async function readDesiredRows(): Promise<DesiredStateRow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(daemonsDir());
  } catch {
    return [];
  }

  const rows: DesiredStateRow[] = [];
  for (const key of entries.sort()) {
    const p = path.join(daemonsDir(), key, DESIRED_FILE);
    const desired = await readDesiredRecord(p);
    if (desired) rows.push({ key, path: p, desired });
  }
  return rows.sort((a, b) => a.desired.rootPath.localeCompare(b.desired.rootPath));
}

export async function readDesiredDaemonRows(): Promise<DesiredStateRow[]> {
  return readDesiredRows();
}

async function staleReason(root: string): Promise<string | undefined> {
  if (!(await exists(root))) return "root missing";
  if (!(await exists(workspaceConfigPath(root)))) return "workspace binding missing";
  return undefined;
}

async function desiredRunningRows(accountId: string): Promise<AutostartWorkspaceStatus[]> {
  return (await autostartWorkspaceStatuses(accountId)).filter((row) => row.status === "running");
}

async function statusForDesiredRow(row: DesiredStateRow, currentAccountId?: string): Promise<AutostartWorkspaceStatus> {
  const desired = row.desired;
  const stale = await staleReason(desired.rootPath);
  if (stale) return { ...desired, status: "stale", key: row.key, desiredPath: row.path, reason: stale };
  const currentWorkspace = currentWorkspaceId(desired.rootPath);
  if (desired.workspaceId !== currentWorkspace) {
    return {
      ...desired,
      status: "mismatch",
      key: row.key,
      desiredPath: row.path,
      reason: `desired workspace ${desired.workspaceId}, current ${currentWorkspace ?? "unknown"}`,
    };
  }
  if (currentAccountId && desired.accountId !== currentAccountId) {
    return {
      ...desired,
      status: "mismatch",
      key: row.key,
      desiredPath: row.path,
      reason: `desired ${desired.accountId}, current ${currentAccountId}`,
    };
  }
  return { ...desired, status: desired.state, key: row.key, desiredPath: row.path };
}

export async function autostartWorkspaceStatuses(currentAccountId?: string): Promise<AutostartWorkspaceStatus[]> {
  const statuses: AutostartWorkspaceStatus[] = [];
  for (const row of await readDesiredRows()) {
    statuses.push(await statusForDesiredRow(row, currentAccountId));
  }
  return statuses;
}

export async function bootResume(deps: BootResumeDeps = {}): Promise<void> {
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const log = deps.log ?? ((line: string) => console.log(line));
  if (loaded.state === "absent") {
    log("autostart: not logged in");
    return;
  }
  if (loaded.state !== "valid") {
    log(`autostart: credential-degraded: ${credentialFailureMessage(loaded)}`);
    return;
  }
  const creds = loaded.credentials;
  if (!creds.accountId) {
    log("autostart: credential has no account id");
    return;
  }
  const starter = deps.startDaemon ?? startDaemon;
  for (const row of await desiredRunningRows(creds.accountId)) {
    await resumeDesiredDaemon(row, {
      startDaemon: starter,
    });
  }
}

function supportedPlatform(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error("rbox autostart is only supported on macOS and Linux");
}

async function realBinaryPath(binaryPath: string): Promise<string> {
  try {
    const resolved = await fs.realpath(binaryPath);
    if (!(await fs.stat(resolved)).isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw new Error(`rbox binary not found at ${binaryPath}; install rbox before enabling autostart`);
  }
}

async function resolveAutostartBinary(home: string, override?: string): Promise<string> {
  if (override !== undefined) return realBinaryPath(override);
  // Follow the binary the user actually runs — a `~/.local/bin` (or any
  // non-canonical) install then autostarts correctly, matching how `rbox
  // upgrade` (upgrade-cmd.ts swaps realpath(execPath) in place) and the daemon
  // respawn already behave. Under `bun run` (dev) execPath is the Bun runtime,
  // not rbox (same signal runtime.ts keys on), so fall back to the canonical
  // install path there.
  if (path.basename(process.execPath) !== "bun") {
    try {
      return await realBinaryPath(process.execPath);
    } catch {
      // fall through to the canonical path
    }
  }
  return realBinaryPath(defaultRboxBinaryPath(home));
}

async function tryExec(exec: ExecCommand, cmd: string, args: string[]): Promise<string | void> {
  try {
    return await exec(cmd, args);
  } catch {
    // Best-effort cleanup before the state-setting operation.
    return undefined;
  }
}

export async function enableAutostart(deps: AutostartDeps = {}): Promise<void> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const home = deps.home ?? homeDir();
  const exec = deps.exec ?? execFilePromise;
  const resolved = await resolveAutostartBinary(home, deps.binaryPath);

  if (platform === "darwin") {
    const plist = launchAgentPath(home);
    await fs.mkdir(path.dirname(plist), { recursive: true });
    if (await exists(plist)) await tryExec(exec, "launchctl", ["unload", "-w", plist]);
    await fs.writeFile(plist, buildLaunchAgentPlist(resolved));
    await exec("launchctl", ["load", "-w", plist]);
    return;
  }

  const unit = systemdUnitPath(home);
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, buildSystemdUnit(resolved));
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME]);
}

export async function disableAutostart(deps: AutostartDeps = {}): Promise<void> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const home = deps.home ?? homeDir();
  const exec = deps.exec ?? execFilePromise;

  if (platform === "darwin") {
    const plist = launchAgentPath(home);
    if (await exists(plist)) await tryExec(exec, "launchctl", ["unload", "-w", plist]);
    await fs.rm(plist, { force: true });
    return;
  }

  const unit = systemdUnitPath(home);
  await tryExec(exec, "systemctl", ["--user", "disable", SYSTEMD_UNIT_NAME]);
  await fs.rm(unit, { force: true });
  await tryExec(exec, "systemctl", ["--user", "daemon-reload"]);
}

export async function isAutostartEnabled(deps: Pick<AutostartDeps, "platform" | "home"> = {}): Promise<boolean> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const home = deps.home ?? homeDir();
  return exists(platform === "darwin" ? launchAgentPath(home) : systemdUnitPath(home));
}

async function printAutostartStatus(deps: AutostartDeps = {}): Promise<void> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const enabled = await isAutostartEnabled(deps);
  console.log(`autostart: ${enabled ? style.green("enabled") : style.yellow("disabled")}`);

  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const creds = loaded.state === "valid" ? loaded.credentials : undefined;
  if (loaded.state !== "valid" && loaded.state !== "absent") {
    console.log(style.yellow(`credential-degraded: ${credentialFailureMessage(loaded)}`));
  }
  const rows = await autostartWorkspaceStatuses(creds?.accountId);
  if (!rows.length) {
    console.log("workspaces: none");
  } else {
    console.log("workspaces:");
    for (const row of rows) {
      const meta = `${row.workspaceId} · ${row.accountId}${row.reason ? ` · ${row.reason}` : ""}`;
      console.log(`  ${row.status.padEnd(8)} ${row.rootPath} ${style.dim(`(${meta})`)}`);
    }
  }

  if (platform === "linux") {
    const exec = deps.exec ?? execFilePromise;
    const user = process.env.USER ?? os.userInfo().username;
    const output = await tryExec(exec, "loginctl", ["show-user", user, "--property=Linger"]);
    if (typeof output === "string" && output.includes("Linger=no")) {
      console.log(style.dim("note: systemd user units need a login session; headless servers may need `loginctl enable-linger $USER`."));
    }
  }
}

export async function autostartCmd(subcommand: string | undefined, deps: AutostartDeps = {}): Promise<void> {
  if (subcommand === "enable") {
    await enableAutostart(deps);
    console.log(`${style.sym.ok} autostart enabled`);
  } else if (subcommand === "disable") {
    await disableAutostart(deps);
    console.log(`${style.sym.ok} autostart disabled; desired state kept`);
  } else if (subcommand === "status") {
    await printAutostartStatus(deps);
  } else {
    fail("usage: rbox autostart <enable | disable | status>");
  }
}
