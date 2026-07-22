import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { disableAutostart, readDesiredDaemonRows } from "./autostart-cmd.js";
import { parseDaemonPid, stopDaemon } from "./daemon-control.js";
import { homeDir } from "./rbox-paths.js";
import { loadCredentials } from "./credentials.js";
import { loadDevice } from "./e2ee-keystore.js";
import { readRecoveryKitRecordState, recoveryKitFileState, recoveryKitSafety } from "./recovery-kit.js";
import { probeKeychainKit } from "./recovery-kit-keychain.js";
import { currentGenesisSeam } from "./genesis-seam.js";
import { style } from "./style.js";

interface UninstallDeps {
  home?: string;
  rboxHome?: string;
  stopDaemon?: (root: string) => Promise<void>;
  disableAutostart?: () => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  rm?: typeof fs.rm;
  log?: (line: string) => void;
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  keystoreBackupAtRisk?: (removalRoot: string) => Promise<boolean | "unknown">;
}

export async function keystoreBackupAtRisk(removalRoot: string): Promise<boolean | "unknown"> {
  const loaded = await loadCredentials();
  if (loaded.state !== "valid") return loaded.state === "absent" ? false : "unknown";
  const creds = loaded.credentials;
  if (!creds.accountId) return false;
  const [device, kit, pending] = await Promise.all([
    loadDevice(creds.accountId),
    readRecoveryKitRecordState(creds.accountId),
    currentGenesisSeam().pendingGenesis(creds.accountId),
  ]);
  if (device === undefined && pending === "none") return false;
  if (kit.state !== "recognized") return kit.state === "unknown" ? "unknown" : true;
  const [keychain, plaintext] = await Promise.all([
    kit.record.keychain ? probeKeychainKit(kit.record.keychain) : Promise.resolve(undefined),
    Promise.all(kit.record.plaintextArtifacts.map((artifact) => recoveryKitFileState(creds.accountId!, artifact))),
  ]);
  let canonicalRoot: string;
  try { canonicalRoot = await fs.realpath(removalRoot) } catch { canonicalRoot = path.resolve(removalRoot) }
  const canonicalRecord = structuredClone(kit.record);
  let canonicalKeychain = keychain;
  const canonicalPlaintext = [...plaintext];
  if (canonicalRecord.keychain && keychain === "present") {
    try { canonicalRecord.keychain.keychainPath = await fs.realpath(canonicalRecord.keychain.keychainPath) }
    catch { canonicalKeychain = "unavailable" }
  }
  for (let index = 0; index < canonicalRecord.plaintextArtifacts.length; index++) {
    if (canonicalPlaintext[index] !== "present") continue;
    try { canonicalRecord.plaintextArtifacts[index]!.path = await fs.realpath(canonicalRecord.plaintextArtifacts[index]!.path) }
    catch { canonicalPlaintext[index] = "unavailable" }
  }
  const safety = recoveryKitSafety({ state: "recognized", record: canonicalRecord }, { ...(canonicalKeychain ? { keychain: canonicalKeychain } : {}), plaintext: canonicalPlaintext }, canonicalRoot);
  return safety === "backed-up" ? false : safety === "unknown" ? "unknown" : true;
}

async function warnIfKeystoreAtRisk(log: (line: string) => void, deps: UninstallDeps, removalRoot: string): Promise<void> {
  const atRisk = await (deps.keystoreBackupAtRisk ?? keystoreBackupAtRisk)(removalRoot).catch(() => "unknown" as const);
  if (atRisk === "unknown") {
    log(style.yellow("WARNING: credential degraded; backup risk unknown. Continuing uninstall."));
    return;
  }
  if (!atRisk) return;
  log(style.red("WARNING: this machine holds your encryption keys and no recovery kit has been saved."));
  log("Removing ~/.rbox without a recovery phrase backup makes your encrypted data UNRECOVERABLE.");
  log("Save your phrase first: rbox key backup");
}

interface StopResult {
  desiredRoots: string[];
  fallbackPids: number[];
}

const PATH_START = "# >>> rbox PATH >>>";
const PATH_END = "# <<< rbox PATH <<<";

function defaultRboxHome(home = homeDir()): string {
  return path.join(process.env.RBOX_HOME || home, ".rbox");
}

function targetRc(home: string): string {
  const shell = path.basename(process.env.SHELL || "sh");
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") {
    const bashrc = path.join(home, ".bashrc");
    return fsSync.existsSync(bashrc) ? bashrc : path.join(home, ".bash_profile");
  }
  return path.join(home, ".profile");
}

async function fallbackPidfiles(rboxHome: string, desiredKeys: Set<string>, deps: UninstallDeps): Promise<number[]> {
  const daemons = path.join(rboxHome, "daemons");
  const dirs = await fs.readdir(daemons, { withFileTypes: true }).catch(() => []);
  const killed: number[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || desiredKeys.has(dir.name)) continue;
    const pidfile = path.join(daemons, dir.name, "daemon.pid");
    const raw = await fs.readFile(pidfile, "utf8").catch(() => "");
    const pid = parseDaemonPid(raw).pid;
    if (!pid) continue;
    try {
      (deps.kill ?? process.kill)(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // best-effort: pid may already be gone.
    }
  }
  return killed;
}

async function stopTrackedDaemons(rboxHome: string, deps: UninstallDeps): Promise<StopResult> {
  const rows = await (deps.readDesiredDaemonRows ?? readDesiredDaemonRows)();
  const stopper = deps.stopDaemon ?? stopDaemon;
  for (const row of rows) {
    await stopper(row.desired.rootPath).catch(() => {});
  }
  const fallbackPids = await fallbackPidfiles(rboxHome, new Set(rows.map((r) => r.key)), deps);
  return { desiredRoots: rows.map((r) => r.desired.rootPath), fallbackPids };
}

function printDryRun(log: (line: string) => void, rboxHome: string, rc: string): void {
  log("rbox uninstall dry run. Re-run with `rbox uninstall --yes` to:");
  log("  1. Stop background daemons recorded in desired.json, plus older daemon pidfiles.");
  log("  2. Disable autostart.");
  log(`  3. Remove ${rboxHome}.`);
  log(`  4. Leave shell rc files untouched; remove the ${PATH_START} / ${PATH_END} block from ${rc} yourself if present.`);
}

export async function uninstallCmd(flags: Record<string, string>, deps: UninstallDeps = {}): Promise<void> {
  const log = deps.log ?? ((line) => console.log(line));
  const home = deps.home ?? homeDir();
  const rboxHome = deps.rboxHome ?? defaultRboxHome(home);
  const rc = targetRc(home);

  if (flags.yes !== "true") {
    await warnIfKeystoreAtRisk(log, deps, rboxHome);
    printDryRun(log, rboxHome, rc);
    return;
  }

  await warnIfKeystoreAtRisk(log, deps, rboxHome);
  const stopped = await stopTrackedDaemons(rboxHome, deps);
  await (deps.disableAutostart ?? disableAutostart)().catch(() => {});
  await (deps.rm ?? fs.rm)(rboxHome, { recursive: true, force: true });

  log(`stopped ${stopped.desiredRoots.length} daemon${stopped.desiredRoots.length === 1 ? "" : "s"} from desired.json`);
  if (stopped.fallbackPids.length) log(`sent SIGTERM to ${stopped.fallbackPids.length} legacy daemon pidfile${stopped.fallbackPids.length === 1 ? "" : "s"}`);
  log(`removed ${rboxHome}`);
  log(`Shell PATH files were not edited. If present, remove the block from ${rc}:`);
  log(`  ${PATH_START}`);
  log(`  export PATH=".../.rbox/bin:$PATH"`);
  log(`  ${PATH_END}`);
}
