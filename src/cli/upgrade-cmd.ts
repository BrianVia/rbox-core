import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jsonObject, jsonText, type JsonValue } from "../json.js";
import { RBOX_VERSION } from "./version.js";
import { parseSemver, semverGt } from "./semver.js";
import { isStandaloneBinary } from "./runtime.js";
import { currentWorkspaceId, isDaemonProcess, parseDaemonPid, startDaemon, stopDaemon } from "./daemon-control.js";
import { readAmbientDaemonStatusRecord } from "./daemon/ambient-status.js";
import { readDesiredDaemonRows, resumeDesiredDaemon, type DesiredStateRow } from "./autostart-cmd.js";
import { requireFolderAdmission } from "./autostart/folder-admission-gate.js";
import { workspaceKey } from "./rbox-paths.js";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { verifyAndParseManifest } from "./release-verify.js";
import { fetchWithDeadline } from "./remote/resilient.js";
import { parseUpgradeChannel, readUpgradeChannel, upgradeManifestBase, writeUpgradeChannel } from "./upgrade-channel.js";
import { withUpgradeLock } from "./upgrade-lock.js";
import { downloadToTemp } from "./release-download.js";
import { syncMenuBarApp } from "./menubar-app.js";

/**
 * `rbox upgrade` (design 14) — self-update the installed binary, SAFELY:
 *  - runs only from a compiled standalone binary (never overwrites `bun` in dev);
 *  - verifies an Ed25519 signature over the EXACT served manifest bytes against an
 *    embedded release key (a compromised channel can't forge an update);
 *  - forward-only by semver vs the binary's own + the highest previously verified
 *    version (a signed-but-old manifest can't roll you back);
 *  - downloads the immutable versioned artifact, checks its sha256, then replaces
 *    the running binary by an atomic rename (no torn/partial binary).
 */

function artifactName(): string {
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!osName || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  // Intel Macs are not a release target — rbox ships for Apple Silicon + Linux only.
  // Fail with a clear message instead of requesting a nonexistent rbox-darwin-x64 artifact.
  if (osName === "darwin" && arch === "x64") {
    throw new Error("rbox requires an Apple Silicon Mac (arm64); Intel Macs are not supported. Linux (x64/arm64) is also supported.");
  }
  return `rbox-${osName}-${arch}`;
}

const rboxDir = () => path.join(process.env.RBOX_HOME || os.homedir(), ".rbox");
const legacyReleaseStatePath = () => path.join(rboxDir(), "release.json");
const daemonsDir = () => path.join(rboxDir(), "daemons");
const RELEASE_STATE_MAX_BYTES = 4096;

interface UpgradeContext {
  elevated: boolean;
  dir: string;
  releaseStatePath: string;
  lockPath: string;
}

interface ReleaseState {
  schema: 1;
  version: string;
  phase: "pending" | "committed";
}

interface EffectiveFloor {
  version: string;
  state?: ReleaseState;
}

const processIsElevated = (): boolean => process.geteuid?.() === 0;

function floorMessage(floor: EffectiveFloor): string {
  return floor.state?.phase === "pending"
    ? `an upgrade to ${floor.version} is incomplete — run \`rbox upgrade\` again to finish it`
    : `verified upgrade floor is ${floor.version}; this process is ${RBOX_VERSION} — run \`rbox upgrade\` again from a fresh shell`;
}

export interface UpgradeDaemonDeps {
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  isDaemonProcess?: typeof isDaemonProcess;
  currentWorkspaceId?: typeof currentWorkspaceId;
  stopDaemon?: typeof stopDaemon;
  startDaemon?: typeof startDaemon;
  log?: (line: string) => void;
}

export interface UpgradeCommandDeps {
  isStandaloneBinary?: typeof isStandaloneBinary;
  verifyAndParseManifest?: typeof verifyAndParseManifest;
  isElevated?: () => boolean;
  afterPendingState?: () => void | Promise<void>;
  afterExecutableRename?: () => void | Promise<void>;
  syncMenuBarApp?: typeof syncMenuBarApp;
}

class UpgradeDaemonRestartError extends Error {
  constructor(readonly attempted: number) {
    super("upgrade installed, but one or more live daemons could not be restarted");
  }
}

export async function restartDaemonsAfterUpgrade(
  deps: UpgradeDaemonDeps = {},
  opts: { staleOnly?: boolean } = {},
): Promise<number> {
  const desiredRows = await (deps.readDesiredDaemonRows ?? readDesiredDaemonRows)();
  const desiredByKey = new Map<string, DesiredStateRow>(desiredRows.map((row) => [row.key, row]));
  const owned = deps.isDaemonProcess ?? isDaemonProcess;
  const currentId = deps.currentWorkspaceId ?? currentWorkspaceId;
  const stop = deps.stopDaemon ?? stopDaemon;
  const start = deps.startDaemon ?? startDaemon;
  const log = deps.log ?? console.log;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fsp.readdir(daemonsDir(), { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let failed = false;
  let attempted = 0;
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = entry.name;
    let pid: number | undefined;
    try {
      const parsed = parseDaemonPid(await fsp.readFile(path.join(daemonsDir(), key, "daemon.pid"), "utf8"));
      pid = parsed.pid;
      if (!pid) throw new Error("invalid daemon record");
    } catch {
      failed = true;
      log(`daemon ${key}: not restarted (runtime record unreadable)`);
      continue;
    }
    if (!pid || !owned(pid)) continue;
    const row = desiredByKey.get(key);
    const root = row ? path.resolve(row.desired.rootPath) : undefined;
    const valid = row !== undefined
      && root !== undefined
      && workspaceKey(root) === key
      && row.desired.workspaceId === currentId(root);
    if (!valid || !root || !row) {
      failed = true;
      log(`daemon ${key}: not restarted (live runtime has no valid desired workspace binding)`);
      continue;
    }
    if (opts.staleOnly) {
      const ambient = readAmbientDaemonStatusRecord(root);
      if (ambient.kind === "ok" && ambient.status.daemonVersion === RBOX_VERSION) continue;
    }
    attempted++;
    if (!await cycleOneDaemon({ root, key, row, stop, start, log })) failed = true;
  }
  if (failed) throw new UpgradeDaemonRestartError(attempted);
  return attempted;
}

interface DaemonCycle {
  readonly root: string;
  readonly key: string;
  readonly row: DesiredStateRow;
  readonly stop: typeof stopDaemon;
  readonly start: typeof startDaemon;
  readonly log: (line: string) => void;
}

/** One workspace's admission → stop → desired-state check → restart. State
 * conversion is explicit-command-only; upgrade preserves daemon lifecycle and
 * mode.
 *
 * Admission runs BEFORE the stop and only for a workspace we intend to restart:
 * a folder configuration this binary would refuse must never cost the user a
 * working daemon (design 276 F1.2). The admitted token is then handed to the
 * restart, so the check and the start share one catalog generation. A refusal is
 * this workspace's alone — every other workspace still upgrades.
 *
 * Every failure names its real reason, never a remedy that re-fails: `rbox stop
 * && rbox start` runs the same admission this cycle just failed (276 F1.1). */
async function cycleOneDaemon({ root, key, row, stop, start, log }: DaemonCycle): Promise<boolean> {
  // A workspace whose desired state is stopped is never restarted, so stopping
  // it needs no admission and holds no admitted token.
  const restarting = row.desired.state !== "stopped";
  let admission: Awaited<ReturnType<typeof requireFolderAdmission>> | undefined;
  if (restarting) {
    try {
      admission = await requireFolderAdmission(root);
    } catch (error) {
      log(`daemon ${key}: left running, not restarted on ${RBOX_VERSION} — ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  try {
    await stop(root);
  } catch (error) {
    log(`daemon ${key}: restart failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!admission) {
    log(`daemon ${key}: stopped (desired state is stopped)`);
    return true;
  }
  try {
    const resumeMode = row.desired.pendingModeIntent ?? (row.desired.pullOnly === true ? "pull-only" : "read-write");
    if (!await resumeDesiredDaemon(row.desired, { startDaemon: start, trustedFolderAdmission: admission })) {
      log(`daemon ${key}: not restarted (desired state changed)`);
      return true;
    }
    log(`daemon ${key}: restarted${resumeMode === "pull-only" ? " (pull-only)" : ""}`);
    return true;
  } catch (error) {
    log(`daemon ${key}: restart failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function restartStaleDaemonsIfAny(deps: UpgradeDaemonDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const buffered: string[] = [];
  let attempted = 0;
  try {
    attempted = await restartDaemonsAfterUpgrade({ ...deps, log: (line) => buffered.push(line) }, { staleOnly: true });
  } catch (error) {
    if (error instanceof UpgradeDaemonRestartError) attempted = error.attempted;
    if (attempted > 0) {
      log(`binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`);
    }
    for (const line of buffered) log(line);
    throw error;
  }
  if (attempted > 0) {
    log(`binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`);
  } else {
    log(`already up to date (${RBOX_VERSION})`);
  }
  for (const line of buffered) log(line);
}

function sameFileStat(
  a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  b: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function readJsonNoFollow(filePath: string, label: string): Promise<JsonValue | undefined> {
  let before: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    before = await fsp.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(RELEASE_STATE_MAX_BYTES)) {
    throw new Error(`${label} is not a safe regular file`);
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileStat(before, opened)) throw new Error(`${label} changed while opening`);
    const bytes = Buffer.alloc(RELEASE_STATE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fsp.lstat(filePath, { bigint: true });
    if (bytesRead > RELEASE_STATE_MAX_BYTES || BigInt(bytesRead) !== opened.size
      || !sameFileStat(opened, afterHandle) || !sameFileStat(afterHandle, afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    try {
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      throw new Error(`${label} is malformed`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function parseCanonicalReleaseState(value: JsonValue): ReleaseState {
  if (!jsonObject(value)) throw new Error("upgrade release state is malformed");
  const { schema, phase } = value;
  if (Object.keys(value).sort().join(",") !== "phase,schema,version"
    || schema !== 1
    || (phase !== "pending" && phase !== "committed")
    || !jsonText(value.version)) {
    throw new Error("upgrade release state is malformed");
  }
  const version = value.version;
  parseSemver(version);
  return { schema, version, phase };
}

async function readCanonicalReleaseState(ctx: UpgradeContext): Promise<ReleaseState | undefined> {
  const value = await readJsonNoFollow(ctx.releaseStatePath, "upgrade release state");
  return value === undefined ? undefined : parseCanonicalReleaseState(value);
}

async function readLegacyFloor(): Promise<string | undefined> {
  try {
    const value = await readJsonNoFollow(legacyReleaseStatePath(), "legacy upgrade release state");
    if (value === undefined) return undefined;
    if (!jsonObject(value) || Object.keys(value).join(",") !== "version" || !jsonText(value.version)) return undefined;
    const version = value.version;
    parseSemver(version);
    return version;
  } catch {
    // Compatibility-only input: older sudo updaters may have left this
    // user-home record root-owned. Canonical install-scoped state fails closed;
    // an unreadable/malformed legacy hint retains the old best-effort behavior.
    return undefined;
  }
}

async function effectiveFloor(ctx: UpgradeContext): Promise<EffectiveFloor> {
  const state = await readCanonicalReleaseState(ctx);
  if (state) return { version: semverGt(state.version, RBOX_VERSION) ? state.version : RBOX_VERSION, state };
  const legacy = ctx.elevated ? undefined : await readLegacyFloor();
  return { version: legacy && semverGt(legacy, RBOX_VERSION) ? legacy : RBOX_VERSION };
}

async function writeReleaseState(ctx: UpgradeContext, version: string, phase: ReleaseState["phase"]): Promise<void> {
  await writeFileAtomic(ctx.releaseStatePath, `${JSON.stringify({ schema: 1, version, phase })}\n`, {
    mode: 0o644,
    exactMode: true,
  });
  await fsyncDirectory(ctx.dir);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetchWithDeadline(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function upgradeCmd(remoteUrl: string, opts: { check?: boolean; channel?: string; daemonDeps?: UpgradeDaemonDeps; commandDeps?: UpgradeCommandDeps } = {}): Promise<void> {
  if (!(opts.commandDeps?.isStandaloneBinary ?? isStandaloneBinary)()) {
    throw new Error("`rbox upgrade` only works on an installed binary — you're running from source. Use git, or install via the one-liner.");
  }
  if (!/^https:\/\//.test(remoteUrl) && !/^http:\/\/localhost(:|\/|$)/.test(remoteUrl)) {
    throw new Error("refusing to upgrade over a non-HTTPS channel");
  }
  const exe = fs.realpathSync(process.execPath);
  const dir = path.dirname(exe);
  const ctx: UpgradeContext = Object.freeze({
    elevated: (opts.commandDeps?.isElevated ?? processIsElevated)(),
    dir,
    releaseStatePath: `${exe}.release.json`,
    lockPath: `${exe}.upgrade.lock`,
  });
  const name = artifactName();
  const requestedChannel = parseUpgradeChannel(opts.channel);
  // An explicit selection is authoritative and repairs an unreadable persisted
  // setting. Silent reads retain the fail-closed behavior.
  const priorChannel = requestedChannel === undefined ? await readUpgradeChannel(exe) : undefined;
  const channel = requestedChannel ?? priorChannel!;
  const manifestBase = upgradeManifestBase(remoteUrl, channel);
  console.log(`checking the ${channel} channel…`);
  const [manifestBytes, sigBytes] = await Promise.all([fetchBytes(`${manifestBase}/version`), fetchBytes(`${manifestBase}/version.sig`)]);
  const manifest = (opts.commandDeps?.verifyAndParseManifest ?? verifyAndParseManifest)(manifestBytes, sigBytes);

  const noUpgrade = async (floor: EffectiveFloor): Promise<void> => {
    if (semverGt(floor.version, RBOX_VERSION)) {
      console.log(floorMessage(floor));
    } else if (ctx.elevated) {
      console.log(`already up to date (${RBOX_VERSION})`);
    } else {
      try {
        await restartStaleDaemonsIfAny(opts.daemonDeps);
      } finally {
        await (opts.commandDeps?.syncMenuBarApp ?? syncMenuBarApp)(manifest, remoteUrl);
      }
    }
  };
  const isPendingRetry = (floor: EffectiveFloor): boolean =>
    floor.state?.phase === "pending"
    && floor.state.version === manifest.version
    && semverGt(floor.state.version, RBOX_VERSION);
  const artifact = () => {
    const art = manifest.artifacts[name];
    if (!art || !/^[0-9a-f]{64}$/.test(art.sha256) || art.path !== String(art.path)) {
      throw new Error(`release has no valid artifact for ${name}`);
    }
    if (art.path !== `v${manifest.version}/${name}`) {
      throw new Error(`release artifact path ${art.path} doesn't match v${manifest.version}/${name} — refusing`);
    }
    return art;
  };
  const applyChannelSelection = async (lockedFloor: EffectiveFloor): Promise<void> => {
    if (requestedChannel === undefined) {
      const currentChannel = await readUpgradeChannel(exe);
      if (currentChannel !== priorChannel) throw new Error("upgrade channel changed while this upgrade was running — retry");
      return;
    }
    if (requestedChannel === "latest" && semverGt(lockedFloor.version, manifest.version)) {
      throw new Error(`cannot switch to the latest channel: installed rbox ${lockedFloor.version} is newer than latest ${manifest.version}; install a newer latest release before switching back`);
    }
    await writeUpgradeChannel(exe, requestedChannel);
  };

  // 2. Forward-only: never install below the executable-scoped durable floor.
  // An exact pending target may be retried by an older still-running process.
  const floor = await effectiveFloor(ctx);
  if (requestedChannel !== undefined) artifact();
  const pendingRetry = isPendingRetry(floor);
  if (!semverGt(manifest.version, floor.version) && !pendingRetry) {
    if (requestedChannel !== undefined) {
      await withUpgradeLock(ctx, async () => applyChannelSelection(await effectiveFloor(ctx)));
    }
    if (opts.check) {
      if (semverGt(floor.version, RBOX_VERSION)) {
        console.log(floorMessage(floor));
      } else {
        console.log(`already up to date (${RBOX_VERSION})`);
      }
    } else {
      await noUpgrade(floor);
    }
    return;
  }
  const art = artifact();
  // Bind the artifact path to the manifest's own version + this platform: the
  // whole manifest is signed, so a correct release always names `v<ver>/<name>`.
  // Rejecting anything else stops a mis-signed/buggy manifest from claiming a new
  // version while serving another version's (or platform's) bytes (defense-in-depth).
  if (opts.check) {
    if (requestedChannel !== undefined) {
      await withUpgradeLock(ctx, async () => applyChannelSelection(await effectiveFloor(ctx)));
    }
    console.log(`${pendingRetry ? "update repair pending" : "update available"}: ${manifest.version} (you have ${RBOX_VERSION}) — run \`rbox upgrade\``);
    return;
  }

  // 3. Download the immutable versioned artifact + verify its sha256.
  if (!fs.existsSync(dir)) throw new Error(`cannot locate install dir ${dir}`);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`install dir ${dir} isn't writable — re-run with sudo, or re-run the installer`);
  }

  // Serialize the mutating section: take the exclusive upgrade lock, then RE-READ
  // the floor under it (a concurrent upgrade may have finished and bumped it) so
  // two racing runs can't rename in reverse order and leave an older binary.
  await withUpgradeLock(ctx, async () => {
    const lockedFloor = await effectiveFloor(ctx);
    await applyChannelSelection(lockedFloor);
    if (!semverGt(manifest.version, lockedFloor.version) && !isPendingRetry(lockedFloor)) {
      await noUpgrade(lockedFloor);
      return;
    }
    const { tmp, sha256 } = await downloadToTemp(`${remoteUrl}/bin/${art.path}`, dir);
    try {
      if (sha256 !== art.sha256) throw new Error("downloaded binary sha256 did not match the signed manifest — refusing");
      // Make the verified target a durable rollback floor BEFORE replacement.
      await writeReleaseState(ctx, manifest.version, "pending");
      await opts.commandDeps?.afterPendingState?.();

      // 4. Atomic replace: chmod, fsync (mode durable), rename over the live binary,
      //    fsync the dir. The running process keeps its inode; next exec uses the new file.
      fs.chmodSync(tmp, 0o755);
      const f = fs.openSync(tmp, "r");
      fs.fsyncSync(f);
      fs.closeSync(f);
      fs.renameSync(tmp, exe);
      const d = fs.openSync(dir, "r");
      fs.fsyncSync(d);
      fs.closeSync(d);
      await opts.commandDeps?.afterExecutableRename?.();
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }

    // 5. Mark the pre-published rollback floor committed after durable replace.
    await writeReleaseState(ctx, manifest.version, "committed");
    console.log(`upgraded ${RBOX_VERSION} → ${manifest.version}`);
    if (ctx.elevated) {
      console.log("run `rbox upgrade` once without sudo to restart user daemons on the new version");
    } else {
      try {
        await restartDaemonsAfterUpgrade(opts.daemonDeps);
      } finally {
        await (opts.commandDeps?.syncMenuBarApp ?? syncMenuBarApp)(manifest, remoteUrl);
      }
    }
  });
}
