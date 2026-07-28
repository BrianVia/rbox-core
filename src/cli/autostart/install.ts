import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { RBOX_DIR } from "../config.js";
import { homeDir } from "../rbox-paths.js";
import { loadCredentials } from "../credentials.js";

export const BOOT_RESUME_MARKER = "__boot-resume";
const AUTOSTART_LABEL = "to.rbox.daemon";
const LAUNCH_AGENT_REL = path.join("Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
const SYSTEMD_UNIT_NAME = "rbox.service";
const RBOX_BIN_REL = `${RBOX_DIR}/bin/rbox`;

type ExecCommand = (cmd: string, args: string[]) => Promise<string | void>;

export interface AutostartDeps {
  platform?: NodeJS.Platform;
  home?: string;
  binaryPath?: string;
  exec?: ExecCommand;
  loadCredentials?: typeof loadCredentials;
}

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

export function execFilePromise(cmd: string, args: string[]): Promise<string> {
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

export function supportedPlatform(platform: NodeJS.Platform): "darwin" | "linux" {
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

export async function tryExec(exec: ExecCommand, cmd: string, args: string[]): Promise<string | void> {
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
