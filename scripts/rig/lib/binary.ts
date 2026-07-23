import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Mount } from "./container.js";
import { GUEST } from "./config.js";

export interface BinaryFs {
  lstatSync(file: string): { isFile(): boolean; isSymbolicLink(): boolean };
  accessSync(file: string, mode: number): void;
  realpathSync(file: string): string;
}

/** Validate the host artifact before any guest/container is created. */
export function resolveRigBinaryOverride(
  flags: Record<string, string>,
  fileSystem: BinaryFs = fs,
): string | undefined {
  const raw = flags.binary;
  if (raw === undefined || raw === "") return undefined;
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new Error("--binary must be an exact absolute path");
  }
  let stat: ReturnType<BinaryFs["lstatSync"]>;
  try {
    stat = fileSystem.lstatSync(raw);
  } catch {
    throw new Error(`--binary does not exist: ${raw}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`--binary must be a regular non-symlink file: ${raw}`);
  }
  if (fileSystem.realpathSync(raw) !== raw) {
    throw new Error(`--binary must be canonical: ${raw}`);
  }
  try {
    fileSystem.accessSync(raw, fs.constants.X_OK);
  } catch {
    throw new Error(`--binary must be executable: ${raw}`);
  }
  return raw;
}

/**
 * Apple container bind mounts are directory-only. Copy the already-validated
 * artifact into a content-addressed, single-file directory so both Apple
 * container and Docker execute identical bytes through the same guest path.
 */
export function stageRigBinaryOverride(binary: string): string {
  const bytes = fs.readFileSync(binary);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(os.tmpdir(), "rbox-rig", "compiled", digest);
  const staged = path.join(directory, "rbox");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(staged)) fs.writeFileSync(staged, bytes, { mode: 0o755, flag: "wx" });
  fs.chmodSync(staged, 0o755);
  return directory;
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
