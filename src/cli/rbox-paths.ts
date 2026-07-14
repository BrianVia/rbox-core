/**
 * The rbox per-user config directory (design 29 §"Dependency-drift notifications").
 *
 * Drift state and the shell-hook script live here — a GLOBAL store (not inside any
 * workspace) so the `cd` hook works in any directory and nothing drift-related is
 * ever synced or sent to the server. Honors `RBOX_CONFIG_DIR` (tests/overrides),
 * then XDG_CONFIG_HOME, then `~/.config/rbox` as the design specifies.
 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** The user's home directory. Prefers `process.env.HOME` (live) over `os.homedir()`:
 *  under Bun `os.homedir()` is resolved once at startup and IGNORES a later `HOME`
 *  mutation, so tests/overrides that set `process.env.HOME` would otherwise leak writes
 *  (e.g. the dep-notify shell hook) into the real `~/.zshrc`. In a real login session
 *  `HOME === os.homedir()`, so production behavior is unchanged. */
export const homeDir = (): string => process.env.HOME || os.homedir();

export function configDir(): string {
  if (process.env.RBOX_CONFIG_DIR) return process.env.RBOX_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(base, "rbox");
}

export const depsStatePath = (): string => path.join(configDir(), "deps-state.json");

const RBOX_DIR = ".rbox";

/** A stable, human-scannable, collision-safe key for a workspace, derived purely
 *  from its absolute resolved root: `<basename>-<hash8>`. */
export function workspaceKey(root: string): string {
  const abs = path.resolve(root);
  const hash = crypto.createHash("sha256").update(abs).digest("hex").slice(0, 8);
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  return `${base}-${hash}`;
}

export const rboxDir = (): string => path.join(process.env.RBOX_HOME || homeDir(), RBOX_DIR);

const daemonHome = () => rboxDir();

export const daemonRuntimeDir = (root: string): string => path.join(daemonHome(), "daemons", workspaceKey(root));
export const daemonStatusPath = (root: string): string => path.join(daemonRuntimeDir(root), "daemon.status.json");
export const daemonPidPath = (root: string): string => path.join(daemonRuntimeDir(root), "daemon.pid");
export const daemonLogPath = (root: string): string => path.join(daemonRuntimeDir(root), "daemon.log");
export const daemonBoundPath = (root: string): string => path.join(daemonRuntimeDir(root), "workspace.bound");
