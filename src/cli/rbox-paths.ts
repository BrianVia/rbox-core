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

export function configDir(): string {
  if (process.env.RBOX_CONFIG_DIR) return process.env.RBOX_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "rbox");
}

export const depsStatePath = (): string => path.join(configDir(), "deps-state.json");
