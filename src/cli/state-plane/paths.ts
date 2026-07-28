/**
 * The single home for state-plane filesystem path policy (thermo sweep #4, T1.1
 * step 1). The legacy JSON authority/lock/incarnation paths and the SQLite
 * reset/artifact path table live here so the compatibility boundary and its
 * adapters name one authority for where the state plane sits on disk.
 */
import path from "node:path";
import { RBOX_DIR } from "../workspace-config.js";

const STATE_FILE = "state.json";
export const statePath = (root: string) => path.join(root, RBOX_DIR, STATE_FILE);
export const stateLockPath = (root: string) => `${statePath(root)}.lock`;
export const stateIncarnationPath = (root: string) => path.join(root, RBOX_DIR, "state", "state-incarnation.json");

export const sqliteResetPaths = {
  stateRoot: (root: string): string => path.join(root, ".rbox", "state"),
  authorityMarker: (root: string): string => path.join(root, ".rbox", "state.json"),
  active: (root: string): string => path.join(root, ".rbox", "state", "state.db"),
  journal: (root: string): string => path.join(root, ".rbox", "state", "reset-v1.json"),
  marker: (root: string): string => path.join(root, ".rbox", "state", "state-incarnation.json"),
  candidate: (root: string, id: string): string =>
    path.join(root, ".rbox", "state", "reset-candidates", `${id}.db`),
  archive: (root: string, nonce: string, hash: string): string =>
    path.join(root, ".rbox", "state", "lineages", nonce, `${hash}.db`),
};
