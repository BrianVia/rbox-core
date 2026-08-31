/**
 * Test-only readback for the SQLite encrypt-address cache.
 *
 * End-to-end push tests assert on cached addresses and the context they were cached
 * under. They used to read `encrypt-cache.json` directly; this projects the live
 * database back into that shape so those assertions keep describing addresses rather
 * than a storage layout, and so there is one reader to fix rather than one per suite.
 */
import { constants, Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { ENCRYPT_ADDRESS_CACHE_DB_REL } from "../../engine/encrypt-address-cache.js";
import { selectRow, selectRows } from "./store/statements.js";

export interface EncryptCacheEntryReadback {
  encSha: string;
  cipherSize: number;
  paths: string[];
}

export interface EncryptCacheReadback {
  accountId?: string;
  workspaceId?: string;
  accountEpoch?: number;
  keyEpoch?: number;
  entries: Record<string, EncryptCacheEntryReadback>;
}

/** Reads the cache database at `root`, or reports an empty cache when none exists.
 *  Never a `readonly:true` connection, and it clears persist-WAL before closing, so
 *  the read leaves no `-wal`/`-shm` behind for a residue gate to trip over. */
export async function readEncryptCacheDb(root: string): Promise<EncryptCacheReadback> {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_DB_REL);
  const entries: Record<string, EncryptCacheEntryReadback> = {};
  if (!(await fs.stat(file).catch(() => undefined))) return { entries };

  const db = new Database(file, { create: false, readwrite: true });
  try {
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    for (const row of selectRows<{ path: string; plaintext_sha: string; enc_sha: string; cipher_size: number }>(
      db, "SELECT path,plaintext_sha,enc_sha,cipher_size FROM addresses ORDER BY path")) {
      const entry = entries[row.plaintext_sha] ?? { encSha: row.enc_sha, cipherSize: row.cipher_size, paths: [] };
      entry.paths.push(row.path);
      entries[row.plaintext_sha] = entry;
    }
    const meta = selectRow<{ account_id: string; workspace_id: string; account_epoch: number; key_epoch: number }>(
      db, "SELECT account_id,workspace_id,account_epoch,key_epoch FROM meta WHERE singleton=1");
    if (!meta) return { entries };
    return {
      accountId: meta.account_id,
      workspaceId: meta.workspace_id,
      accountEpoch: meta.account_epoch,
      keyEpoch: meta.key_epoch,
      entries,
    };
  } finally {
    db.close();
  }
}
