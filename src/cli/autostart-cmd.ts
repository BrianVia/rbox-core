import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RBOX_DIR } from "./config.js";
import { currentWorkspaceId, daemonRuntimeDir, startDaemon, stopDaemon } from "./daemon-control.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { homeDir } from "./rbox-paths.js";
import { fail, style } from "./style.js";

export const BOOT_RESUME_MARKER = "__boot-resume";
const AUTOSTART_LABEL = "to.rbox.daemon";
const LAUNCH_AGENT_REL = path.join("Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
const SYSTEMD_UNIT_NAME = "rbox.service";
const DESIRED_FILE = "desired.json";
const RBOX_BIN_REL = `${RBOX_DIR}/bin/rbox`;
const SYSTEMD_BINARY_PATH = `%h/${RBOX_BIN_REL}`;

export type DesiredDaemonStateValue = "running" | "stopped";

export interface DesiredDaemonState {
  rootPath: string;
  state: DesiredDaemonStateValue;
  accountId: string;
  workspaceId: string;
  at: string;
  pullOnly?: boolean;
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
  pullOnly?: boolean;
}

interface StartStopDeps extends DesiredDeps {
  startDaemon?: typeof startDaemon;
  stopDaemon?: typeof stopDaemon;
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

function buildSystemdUnit(binaryPath = SYSTEMD_BINARY_PATH): string {
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
    return {
      rootPath: v.rootPath,
      state: v.state,
      accountId: v.accountId,
      workspaceId: v.workspaceId,
      at: v.at,
      ...(v.pullOnly === true ? { pullOnly: true } : {}),
    };
  } catch {
    return undefined;
  }
}

async function desiredContext(root: string, state: DesiredDaemonStateValue, deps: DesiredDeps = {}): Promise<DesiredDaemonState> {
  const abs = path.resolve(root);
  const creds = await (deps.loadCredentials ?? loadCredentials)();
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
  await fs.writeFile(p, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(p, 0o600).catch(() => {});
}

async function readDesiredRecord(filePath: string): Promise<DesiredDaemonState | undefined> {
  try {
    return parseDesired(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function startDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  const record = await desiredContext(root, "running", deps);
  const result = await (deps.startDaemon ?? startDaemon)(record.rootPath, { pullOnly: deps.pullOnly === true });
  if (result === "started" || result === "already-running") await writeDesiredRecord(record);
}

export async function stopDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  const abs = path.resolve(root);
  const record = await desiredContext(abs, "stopped", deps);
  await (deps.stopDaemon ?? stopDaemon)(abs);
  await writeDesiredRecord(record);
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
  const creds = await (deps.loadCredentials ?? loadCredentials)();
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!creds?.accountId) {
    log("autostart: not logged in");
    return;
  }
  const starter = deps.startDaemon ?? startDaemon;
  for (const row of await desiredRunningRows(creds.accountId)) {
    await starter(row.rootPath, { pullOnly: row.pullOnly === true });
  }
}

function supportedPlatform(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error("rbox autostart is only supported on macOS and Linux");
}

async function realBinaryPath(binaryPath: string): Promise<string> {
  try {
    return await fs.realpath(binaryPath);
  } catch {
    throw new Error(`rbox binary not found at ${binaryPath}; install rbox before enabling autostart`);
  }
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
  const binaryPath = deps.binaryPath ?? defaultRboxBinaryPath(home);
  const resolved = await realBinaryPath(binaryPath);

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
  await fs.writeFile(unit, buildSystemdUnit());
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

  const creds = await (deps.loadCredentials ?? loadCredentials)().catch((): Credentials | undefined => undefined);
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
