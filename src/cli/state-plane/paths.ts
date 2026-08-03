/**
 * The single home for state-plane filesystem path policy (thermo sweep #4, T1.1
 * step 1). The legacy JSON authority/lock/incarnation paths, the SQLite
 * reset/artifact table, and design 163's migration and genesis artifact paths
 * live here so the compatibility boundary and its adapters name one authority
 * for where the state plane sits on disk.
 */
import path from "node:path";
import { RBOX_DIR } from "../workspace-config.js";

const STATE_FILE = "state.json";
export const stateRootPath = (root: string) => path.join(root, RBOX_DIR, "state");
export const statePath = (root: string) => path.join(root, RBOX_DIR, STATE_FILE);
export const stateLockPath = (root: string) => `${statePath(root)}.lock`;
export const stateIncarnationPath = (root: string) => path.join(stateRootPath(root), "state-incarnation.json");

export const sqliteResetPaths = {
  stateRoot: stateRootPath,
  authorityMarker: statePath,
  marker: stateIncarnationPath,
  active: (root: string): string => path.join(stateRootPath(root), "state.db"),
  journal: (root: string): string => path.join(stateRootPath(root), "reset-v1.json"),
  candidate: (root: string, id: string): string =>
    path.join(stateRootPath(root), "reset-candidates", `${id}.db`),
  archive: (root: string, nonce: string, hash: string): string =>
    path.join(stateRootPath(root), "lineages", nonce, `${hash}.db`),
};

/** Design 163's migration artifacts. Every path is scoped by the migration id
 * except the fixed control, backup, and generic reserve names. */
export const migrationPaths = {
  control: (root: string): string => path.join(stateRootPath(root), "migration-v1.json"),
  /** The canonical publisher's revision-scoped sibling: the ordinary publication
   * temp and the prepared future controls of the M6 runway are the same
   * namespace (163's "migration-id-bound canonical-publisher siblings"). */
  controlRevision: (root: string, migrationId: string, revision: number): string =>
    path.join(stateRootPath(root), `migration-v1.json.${migrationId}.${revision}.tmp`),
  staging: (root: string, migrationId: string): string =>
    path.join(stateRootPath(root), `state.db.migrate.${migrationId}`),
  qSibling: (root: string, migrationId: string): string =>
    path.join(root, RBOX_DIR, `${STATE_FILE}.migrate.${migrationId}.q`),
  reserve: (root: string): string => path.join(stateRootPath(root), "reserve-1mib.bin"),
  emergency: (root: string, migrationId: string): string =>
    path.join(stateRootPath(root), `migration-emergency.${migrationId}.bin`),
  /** 163's v6 relocation, verbatim: `.rbox/state/legacy-json/`, deliberately
   * out of the `.rbox/state.json` naming neighbourhood and beside the immutable
   * history it belongs with, so the path a person restores by reflex is not one
   * that silently re-elects a stale JSON baseline. */
  fixedBackup: (root: string): string =>
    path.join(stateRootPath(root), "legacy-json", "pre-163-latest.json.bak"),
  /** Content-addressed by the SOURCE document's whole-file digest. `.rbox/state.json`
   * carries no preamble, so its body and physical hashes coincide and every
   * producer and consumer passes the whole-file value; the old `bodySha256` name
   * implied the preamble-stripped digest the backup files themselves declare. */
  backupHistory: (root: string, sourceSha256: string): string =>
    path.join(stateRootPath(root), "legacy-json", `${sourceSha256}.json`),
  /** M2's own render temp, id-scoped so it is never a foreign path to anyone
   * else and never collides with the content-addressed history beside it. */
  backupTemp: (root: string, migrationId: string): string =>
    path.join(stateRootPath(root), "legacy-json", `pre-163.${migrationId}.tmp`),
  quarantine: (root: string): string => path.join(stateRootPath(root), "quarantine"),
};

/** Design 222 §2.3.1: genesis stores no path. Both paths an attempt may own are
 * derived from its authority id, so a tampered intent can never name a victim. */
export const genesisPaths = {
  intent: (root: string): string => path.join(stateRootPath(root), "genesis-v1.json"),
  staged: (root: string, authorityId: string): string =>
    path.join(stateRootPath(root), `state.db.genesis.${authorityId}`),
  qSibling: (root: string, authorityId: string): string =>
    path.join(root, RBOX_DIR, `${STATE_FILE}.genesis.${authorityId}.q`),
};
