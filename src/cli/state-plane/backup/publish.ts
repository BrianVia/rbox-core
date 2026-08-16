import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackupFileHash } from "../ports.js";
import { validateOpen } from "../schema/validate-open.js";
import type { StateStoreHandle } from "../store/open.js";
import { selectRow, selectRows } from "../store/statements.js";
import { vacuumInto } from "./vacuum-into.js";

export interface StateBackupOptions {
  source: StateStoreHandle;
  destination: string;
  backupId: string;
  integrity?: "schema" | "full";
}

export interface StateBackupResult {
  physicalSha256: BackupFileHash;
  bytes: number;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

interface BackupFileProof {
  readonly sha256: BackupFileHash;
  readonly bytes: number;
}

function backupFileHash(file: string): BackupFileProof {
  const hash = createHash("sha256");
  let bytes = 0;
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest("hex") as BackupFileHash, bytes };
}

export interface StateBackupPublicationSeam {
  boundary(point: string): void;
}

const PRODUCTION_BACKUP_PUBLICATION: StateBackupPublicationSeam = {
  boundary() {},
};

export function createStateBackupPublisher(
  publication: StateBackupPublicationSeam,
): (options: StateBackupOptions) => StateBackupResult {
  return (options) => publishStateBackupWithPublication(options, publication);
}

function publishStateBackupWithPublication(
  options: StateBackupOptions,
  publication: StateBackupPublicationSeam,
): StateBackupResult {
  if (!/^[0-9a-f]{32}$/.test(options.backupId)) throw new TypeError("backupId must be lowercase hex32");
  if (fs.existsSync(options.destination)) throw new Error(`backup destination already exists: ${options.destination}`);
  const stagingDirectory = `${options.destination}.backup-${options.backupId}`;
  const staging = path.join(stagingDirectory, "state.db");
  let stagingOwned = false;
  try {
    fs.mkdirSync(path.dirname(options.destination), { recursive: true });
    // The exclusive directory is the ownership claim. Any VACUUM partial or
    // racing child inside it is ours to clean; a pre-existing path is not.
    fs.mkdirSync(stagingDirectory, { mode: 0o700 });
    stagingOwned = true;
    vacuumInto(options.source, staging);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(`${staging}${suffix}`)) throw new Error(`backup output has ${suffix} sidecar`);
    }
    const verifier = new Database(staging, { create: false, readonly: true });
    try {
      // Apple's system SQLite defaults PERSIST_WAL on: without this even a
      // readonly open would leave sidecars beside the staged backup on close.
      verifier.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      validateOpen(verifier, staging);
      if ((options.integrity ?? "full") === "full") {
        const result = selectRows<{ integrity_check: string }>(verifier, "PRAGMA integrity_check");
        if (result.length !== 1 || result[0]?.integrity_check !== "ok") throw new Error("backup integrity check failed");
        if (selectRow(verifier, "PRAGMA foreign_key_check")) throw new Error("backup foreign key check failed");
      }
    } finally {
      verifier.close();
    }
    const fd = fs.openSync(staging, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    publication.boundary("after-backup-staging-fsync");
    const physical = backupFileHash(staging);
    // Same-filesystem link+unlink gives atomic no-clobber publication; rename(2)
    // would silently replace an operator-owned destination.
    fs.linkSync(staging, options.destination);
    publication.boundary("after-backup-link");
    fs.unlinkSync(staging);
    publication.boundary("after-backup-source-unlink");
    fs.rmdirSync(stagingDirectory);
    stagingOwned = false;
    fsyncDirectory(path.dirname(options.destination));
    publication.boundary("after-backup-publication");
    return { physicalSha256: physical.sha256, bytes: physical.bytes };
  } catch (error) {
    if (stagingOwned) fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export const publishStateBackup = createStateBackupPublisher(PRODUCTION_BACKUP_PUBLICATION);
