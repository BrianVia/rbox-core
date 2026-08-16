import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Mount } from "./container.js";
import { GUEST } from "./config.js";

export interface BinaryFs {
  lstatSync(file: string): { isFile(): boolean; isSymbolicLink(): boolean };
  accessSync(file: string, mode: number): void;
  realpathSync(file: string): string;
}

export interface RigBinaryPaths {
  a?: string;
  b?: string;
}

/** Git identity of the checkout a source-mode artifact was hashed from. */
export interface RigSourceCommit {
  commit: string;
  dirty: boolean;
}

export interface RigBinaryArtifact {
  mode: "source" | "compiled";
  sha256: string;
  hostPath?: string;
  stagedDirectory?: string;
  source?: RigSourceCommit;
}

export interface RigBinarySelection {
  a: RigBinaryArtifact;
  b: RigBinaryArtifact;
}

export interface RigBinaryIdentity {
  device: "A" | "B";
  mode: "source" | "compiled";
  version: string;
  versionExitCode: number;
  hostPath?: string;
  sha256?: string;
  source?: RigSourceCommit;
}

/** Validate one host artifact before any guest/container is created. */
function resolveBinaryPath(
  flag: string,
  raw: string | undefined,
  fileSystem: BinaryFs = fs,
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new Error(`--${flag} must be an exact absolute path`);
  }
  let stat: ReturnType<BinaryFs["lstatSync"]>;
  try {
    stat = fileSystem.lstatSync(raw);
  } catch {
    throw new Error(`--${flag} does not exist: ${raw}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`--${flag} must be a regular non-symlink file: ${raw}`);
  }
  if (fileSystem.realpathSync(raw) !== raw) {
    throw new Error(`--${flag} must be canonical: ${raw}`);
  }
  try {
    fileSystem.accessSync(raw, fs.constants.X_OK);
  } catch {
    throw new Error(`--${flag} must be executable: ${raw}`);
  }
  return raw;
}

/**
 * `--binary` is the both-device shorthand; a per-device flag wins for that
 * device. Validate every supplied path, including a fully shadowed shorthand,
 * so a typo never passes silently.
 */
export function resolveRigBinaryPaths(
  flags: Record<string, string>,
  fileSystem: BinaryFs = fs,
): RigBinaryPaths {
  const both = resolveBinaryPath("binary", flags.binary, fileSystem);
  const a = resolveBinaryPath("binary-a", flags["binary-a"], fileSystem) ?? both;
  const b = resolveBinaryPath("binary-b", flags["binary-b"], fileSystem) ?? both;
  return { a, b };
}

export function isMismatchedBinarySelection(selection: RigBinarySelection): boolean {
  return selection.a.mode !== selection.b.mode || selection.a.sha256 !== selection.b.sha256;
}

export function assertDualBinaryAllowed(
  selection: RigBinarySelection,
  scenarioName: string,
  supportsDualBinary: boolean,
): void {
  if (isMismatchedBinarySelection(selection) && !supportsDualBinary) {
    throw new Error(
      `scenario ${scenarioName} does not declare dual-binary support; use identical binary selections`,
    );
  }
}

export function makeRigBinaryIdentity(
  device: "A" | "B",
  binary: RigBinaryArtifact,
  version: string,
  versionExitCode: number,
): RigBinaryIdentity {
  const identity: RigBinaryIdentity = {
    device,
    mode: binary.mode,
    sha256: binary.sha256,
    version,
    versionExitCode,
  };
  if (binary.hostPath) identity.hostPath = binary.hostPath;
  if (binary.source) identity.source = binary.source;
  return identity;
}

export function assertDistinctBinaryVersions(
  selection: RigBinarySelection,
  identities: readonly [RigBinaryIdentity, RigBinaryIdentity],
): void {
  if (!isMismatchedBinarySelection(selection)) return;
  const [a, b] = identities;
  if (a.versionExitCode !== 0 || b.versionExitCode !== 0) {
    throw new Error(`dual-binary version probe failed: A exit ${a.versionExitCode}, B exit ${b.versionExitCode}`);
  }
  if (a.version === b.version) {
    throw new Error(`dual-binary run requires distinct rbox --version strings; both reported ${JSON.stringify(a.version)}`);
  }
}

/**
 * Apple container bind mounts are directory-only. Copy the already-validated
 * artifact into a content-addressed, single-file directory so both Apple
 * container and Docker execute identical bytes through the same guest path.
 */
export function stageRigBinaryOverride(binary: string): RigBinaryArtifact {
  const bytes = fs.readFileSync(binary);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(os.tmpdir(), "rbox-rig", "compiled", digest);
  const staged = path.join(directory, "rbox");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(staged)) {
    if (!fs.readFileSync(staged).equals(bytes)) {
      throw new Error(`staged binary cache is corrupt for sha256 ${digest}`);
    }
  } else {
    fs.writeFileSync(staged, bytes, { mode: 0o755, flag: "wx" });
  }
  fs.chmodSync(staged, 0o755);
  return { mode: "compiled", hostPath: binary, sha256: digest, stagedDirectory: directory };
}

function hashSourceEntry(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    hash.update(`L\0${relative}\0${fs.readlinkSync(absolute)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`D\0${relative}\0`);
    for (const name of fs.readdirSync(absolute).sort()) {
      hashSourceEntry(hash, root, path.join(relative, name));
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`F\0${relative}\0${stat.mode & 0o777}\0`);
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
}

export type GitRunner = (args: readonly string[], repoRoot: string) => string;

const runGit: GitRunner = (args, repoRoot) =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Commit + dirty state of the checkout, or undefined when it is not a git tree. */
export function rigSourceCommit(repoRoot: string, git: GitRunner = runGit): RigSourceCommit | undefined {
  try {
    const commit = git(["rev-parse", "HEAD"], repoRoot).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return undefined;
    return { commit, dirty: git(["status", "--porcelain"], repoRoot).trim().length > 0 };
  } catch {
    return undefined;
  }
}

/** Exact identity of the source-mode executable plus its baked dependency inputs. */
export function sourceRigBinaryArtifact(repoRoot: string, git: GitRunner = runGit): RigBinaryArtifact {
  const hash = createHash("sha256");
  for (const relative of ["src", "package.json", "bun.lock", "patches", "scripts/rig/Dockerfile"]) {
    hashSourceEntry(hash, repoRoot, relative);
  }
  const artifact: RigBinaryArtifact = { mode: "source", sha256: hash.digest("hex") };
  const source = rigSourceCommit(repoRoot, git);
  if (source) artifact.source = source;
  return artifact;
}

/** Read/stage each unique compiled path once, preserving the exact staged digest. */
export function prepareRigBinarySelection(paths: RigBinaryPaths, repoRoot: string): RigBinarySelection {
  const source = sourceRigBinaryArtifact(repoRoot);
  const staged = new Map<string, RigBinaryArtifact>();
  const prepare = (binary: string | undefined): RigBinaryArtifact => {
    if (!binary) return source;
    const prior = staged.get(binary);
    if (prior) return prior;
    const artifact = stageRigBinaryOverride(binary);
    staged.set(binary, artifact);
    return artifact;
  };
  return { a: prepare(paths.a), b: prepare(paths.b) };
}

/** Standard checkout mounts plus the optional exact compiled candidate. */
export function rigGuestMounts(
  repoRoot: string,
  stagedBinaryDirectory?: string,
  extra: readonly Mount[] = [],
): Mount[] {
  return [
    { source: path.join(repoRoot, "src"), target: GUEST.srcMount, readonly: true },
    { source: path.join(repoRoot, "scripts"), target: GUEST.scriptsMount, readonly: true },
    ...(stagedBinaryDirectory
      ? [{ source: stagedBinaryDirectory, target: path.posix.dirname(GUEST.cliExecutable), readonly: true }]
      : []),
    ...extra,
  ];
}
