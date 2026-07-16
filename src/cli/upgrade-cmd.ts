import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RBOX_VERSION } from "./version.js";
import { parseSemver, semverGt } from "./semver.js";
import { isStandaloneBinary } from "./runtime.js";
import { currentWorkspaceId, isDaemonProcess, parseDaemonPid, startDaemon, stopDaemon } from "./daemon-control.js";
import { readDesiredDaemonRows, type DesiredStateRow } from "./autostart-cmd.js";
import { workspaceKey } from "./rbox-paths.js";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { verifyAndParseManifest } from "./release-verify.js";

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
const releaseStatePath = () => path.join(rboxDir(), "release.json");
const lockPath = () => path.join(rboxDir(), "upgrade.lock");
const daemonsDir = () => path.join(rboxDir(), "daemons");

export interface UpgradeDaemonDeps {
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  isDaemonProcess?: typeof isDaemonProcess;
  currentWorkspaceId?: typeof currentWorkspaceId;
  stopDaemon?: typeof stopDaemon;
  startDaemon?: typeof startDaemon;
  log?: (line: string) => void;
}

export async function restartDaemonsAfterUpgrade(deps: UpgradeDaemonDeps = {}): Promise<void> {
  const desiredRows = await (deps.readDesiredDaemonRows ?? readDesiredDaemonRows)();
  const desiredByKey = new Map<string, DesiredStateRow>(desiredRows.map((row) => [row.key, row]));
  const owned = deps.isDaemonProcess ?? isDaemonProcess;
  const currentId = deps.currentWorkspaceId ?? currentWorkspaceId;
  const stop = deps.stopDaemon ?? stopDaemon;
  const start = deps.startDaemon ?? startDaemon;
  const log = deps.log ?? console.log;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fsp.readdir(daemonsDir(), { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let failed = false;
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
    try {
      await stop(root);
      if (row.desired.state === "stopped") {
        log(`daemon ${key}: stopped (desired state is stopped)`);
        continue;
      }
      const result = await start(root, { pullOnly: row.desired.pullOnly === true });
      if (result === "retry-later") throw new Error("start deferred");
      log(`daemon ${key}: restarted${row.desired.pullOnly === true ? " (pull-only)" : ""}`);
    } catch {
      failed = true;
      log(`daemon ${key}: restart failed; run rbox stop && rbox start in that workspace`);
    }
  }
  if (failed) throw new Error("upgrade installed, but one or more live daemons could not be restarted");
}

async function recordVerifiedRelease(version: string): Promise<void> {
  await fsp.mkdir(rboxDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomic(releaseStatePath(), JSON.stringify({ version }), { flag: "wx", mode: 0o600 });
  await fsyncDirectory(rboxDir());
}

/** Acquire an exclusive cross-process upgrade lock so two concurrent `rbox
 *  upgrade` runs can't both pass the floor check and rename in reverse order
 *  (which could leave an OLDER signed binary installed). Held from before the
 *  floor read through the rename + state write. Recovers a lock left by a dead
 *  process (stored pid no longer alive) rather than wedging forever. */
function acquireUpgradeLock(): () => void {
  fs.mkdirSync(rboxDir(), { recursive: true, mode: 0o700 });
  const lock = lockPath();
  const take = () => {
    const fd = fs.openSync(lock, "wx"); // O_CREAT|O_EXCL — fails if held
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = Number(fs.readFileSync(lock, "utf8").trim());
    const alive = Number.isInteger(holder) && (() => { try { process.kill(holder, 0); return true; } catch (k) { return (k as NodeJS.ErrnoException).code === "EPERM"; } })();
    if (alive) throw new Error(`another rbox upgrade is already running (pid ${holder}) — refusing to run concurrently`);
    fs.rmSync(lock, { force: true }); // stale lock from a dead process
    take();
  }
  return () => fs.rmSync(lock, { force: true });
}

async function highestVerified(): Promise<string> {
  try {
    const { version } = JSON.parse(await fsp.readFile(releaseStatePath(), "utf8")) as { version: string };
    parseSemver(version); // validate
    return semverGt(version, RBOX_VERSION) ? version : RBOX_VERSION;
  } catch {
    return RBOX_VERSION;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Stream `url` to an O_EXCL temp file in `dir`, hashing as it lands. Returns the
 *  temp path + hex sha256. Caller verifies the sha then renames or unlinks. */
async function downloadToTemp(url: string, dir: string): Promise<{ tmp: string; sha256: string }> {
  const tmp = path.join(dir, `.rbox.upgrade.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o755); // O_CREAT|O_EXCL|O_WRONLY
  const hash = createHash("sha256");
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download ${url} → ${res.status}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        fs.writeSync(fd, value);
      }
    }
    return { tmp, sha256: hash.digest("hex") };
  } catch (e) {
    fs.closeSync(fd);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed on the error path */
    }
  }
}

export async function upgradeCmd(remoteUrl: string, opts: { check?: boolean; daemonDeps?: UpgradeDaemonDeps } = {}): Promise<void> {
  if (!isStandaloneBinary()) {
    throw new Error("`rbox upgrade` only works on an installed binary — you're running from source. Use git, or install via the one-liner.");
  }
  if (!/^https:\/\//.test(remoteUrl) && !/^http:\/\/localhost(:|\/|$)/.test(remoteUrl)) {
    throw new Error("refusing to upgrade over a non-HTTPS channel");
  }
  const exe = fs.realpathSync(process.execPath);
  const dir = path.dirname(exe);
  const name = artifactName();

  // 1. Fetch manifest + detached signature (RAW bytes) and verify BEFORE trusting.
  const [manifestBytes, sigBytes] = await Promise.all([fetchBytes(`${remoteUrl}/version`), fetchBytes(`${remoteUrl}/version.sig`)]);
  const manifest = verifyAndParseManifest(manifestBytes, sigBytes);

  // 2. Forward-only: never "upgrade" to an older/equal version (anti-rollback).
  const floor = await highestVerified();
  if (!semverGt(manifest.version, floor)) {
    console.log(`already up to date (${RBOX_VERSION})`);
    return;
  }
  const art = manifest.artifacts[name];
  if (!art || !/^[0-9a-f]{64}$/.test(art.sha256) || typeof art.path !== "string") {
    throw new Error(`release has no valid artifact for ${name}`);
  }
  // Bind the artifact path to the manifest's own version + this platform: the
  // whole manifest is signed, so a correct release always names `v<ver>/<name>`.
  // Rejecting anything else stops a mis-signed/buggy manifest from claiming a new
  // version while serving another version's (or platform's) bytes (defense-in-depth).
  if (art.path !== `v${manifest.version}/${name}`) {
    throw new Error(`release artifact path ${art.path} doesn't match v${manifest.version}/${name} — refusing`);
  }
  if (opts.check) {
    console.log(`update available: ${manifest.version} (you have ${RBOX_VERSION}) — run \`rbox upgrade\``);
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
  const releaseLock = acquireUpgradeLock();
  try {
    if (!semverGt(manifest.version, await highestVerified())) {
      console.log(`already up to date (${RBOX_VERSION})`);
      return;
    }
    const { tmp, sha256 } = await downloadToTemp(`${remoteUrl}/bin/${art.path}`, dir);
    try {
      if (sha256 !== art.sha256) throw new Error("downloaded binary sha256 did not match the signed manifest — refusing");
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
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }

    // 5. Record the highest verified version ONLY after a successful replace.
    await recordVerifiedRelease(manifest.version);
    console.log(`upgraded ${RBOX_VERSION} → ${manifest.version}`);
    await restartDaemonsAfterUpgrade(opts.daemonDeps);
  } finally {
    releaseLock();
  }
}
