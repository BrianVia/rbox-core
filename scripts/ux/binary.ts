import fs from "node:fs";
import path from "node:path";

/** The image's source-mode shim lives here; an override bind-mount replaces it. */
export const UX_GUEST_RBOX = "/usr/local/bin/rbox";

export interface BinaryFs {
  lstatSync(file: string): { isFile(): boolean; isSymbolicLink(): boolean };
  accessSync(file: string, mode: number): void;
  realpathSync(file: string): string;
}

/**
 * Resolve the opt-in compiled candidate. Requiring an exact canonical absolute
 * regular executable keeps the bind source unambiguous and prevents a symlink
 * from changing underneath a running harness.
 */
export function resolveUxBinaryOverride(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem: BinaryFs = fs,
): string | undefined {
  const raw = env.RBOX_UX_BINARY;
  if (raw === undefined || raw === "") return undefined;
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new Error("RBOX_UX_BINARY must be an exact absolute path");
  }
  let stat: ReturnType<BinaryFs["lstatSync"]>;
  try {
    stat = fileSystem.lstatSync(raw);
  } catch {
    throw new Error(`RBOX_UX_BINARY does not exist: ${raw}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`RBOX_UX_BINARY must be a regular non-symlink file: ${raw}`);
  }
  if (fileSystem.realpathSync(raw) !== raw) {
    throw new Error(`RBOX_UX_BINARY must be canonical: ${raw}`);
  }
  try {
    fileSystem.accessSync(raw, fs.constants.X_OK);
  } catch {
    throw new Error(`RBOX_UX_BINARY must be executable: ${raw}`);
  }
  return raw;
}
